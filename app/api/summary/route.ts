import { requireActor } from "../../../lib/server/auth";
import { getD1 } from "../../../lib/server/database";
import { ApiRequestError, apiError, readJson } from "../../../lib/server/http";
import { generateSummary } from "../../../lib/server/openrouter";
import { latestSummary, listActions, listMessages } from "../../../lib/server/queries";

export async function POST(request: Request) {
  let runId: string | null = null;
  try {
    const actor = await requireActor(request);
    if (!["manager", "admin"].includes(actor.role)) {
      return Response.json({ error: "Manager access is required" }, { status: 403 });
    }

    const payload = await readJson<{ threadId?: unknown }>(request);
    if (typeof payload.threadId !== "string") {
      throw new ApiRequestError("threadId is required");
    }
    const threadId = payload.threadId.trim();
    if (!threadId || threadId.length > 120) {
      throw new ApiRequestError("threadId must be 1–120 characters");
    }

    const messages = await listMessages(actor, threadId);
    if (messages.length === 0) {
      return Response.json({ error: "No messages to summarize" }, { status: 400 });
    }

    const sourceFingerprint = await fingerprintMessages(messages);
    const db = getD1();
    runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const claim = await db
      .prepare(
        `INSERT OR IGNORE INTO summary_runs
         (id, thread_id, source_fingerprint, status, started_at)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .bind(runId, threadId, sourceFingerprint, startedAt)
      .run();

    if (claim.meta.changes === 0) {
      const existing = await db
        .prepare(
          `SELECT id, status, started_at FROM summary_runs
           WHERE thread_id = ? AND source_fingerprint = ? LIMIT 1`,
        )
        .bind(threadId, sourceFingerprint)
        .first<{ id: string; status: string; started_at: string }>();

      if (existing?.status === "complete") {
        return Response.json({
          summary: await latestSummary(actor, threadId),
          actions: await listActions(actor, threadId),
          replayed: true,
        });
      }

      if (!existing) throw new Error("Summary generation claim was lost");
      runId = existing.id;
      const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
      const reclaim = await db
        .prepare(
          `UPDATE summary_runs
           SET status = 'running', started_at = ?, completed_at = NULL
           WHERE id = ? AND (status = 'failed' OR started_at < ?)`,
        )
        .bind(startedAt, runId, staleBefore)
        .run();
      if (reclaim.meta.changes === 0) {
        return Response.json(
          { error: "A summary is already being generated" },
          { status: 409 },
        );
      }
    }

    const generated = await generateSummary(messages);
    const summaryId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const statements = [
      db
        .prepare(
          `INSERT INTO summaries (id, thread_id, headline_ko, headline_es, summary_ko, summary_es, source_message_ids, generated_by, model, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'openrouter', ?, ?)`,
        )
        .bind(
          summaryId,
          threadId,
          generated.headlineKo,
          generated.headlineEs,
          generated.summaryKo,
          generated.summaryEs,
          JSON.stringify(generated.sourceMessageIds),
          generated.model,
          createdAt,
        ),
      ...generated.actions.map((action) =>
        db
          .prepare(
            `INSERT INTO action_items (id, thread_id, title_ko, title_es, owner, due_label, status, source_message_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'needs_confirmation', ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            threadId,
            action.titleKo,
            action.titleEs,
            action.owner,
            action.dueLabel,
            action.sourceMessageId,
            createdAt,
          ),
      ),
      db
        .prepare(
          `UPDATE summary_runs
           SET status = 'complete', summary_id = ?, completed_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .bind(summaryId, createdAt, runId),
    ];
    await db.batch(statements);
    return Response.json({
      summary: await latestSummary(actor, threadId),
      actions: await listActions(actor, threadId),
      replayed: false,
    });
  } catch (error) {
    if (runId) {
      await getD1()
        .prepare(
          `UPDATE summary_runs SET status = 'failed', completed_at = ?
           WHERE id = ? AND status = 'running'`,
        )
        .bind(new Date().toISOString(), runId)
        .run()
        .catch(() => undefined);
    }
    return apiError(error);
  }
}

async function fingerprintMessages(
  messages: Awaited<ReturnType<typeof listMessages>>,
): Promise<string> {
  const input = JSON.stringify(
    messages.map((message) => [
      message.id,
      message.sourceText,
      message.translatedText,
      message.translationStatus,
    ]),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
