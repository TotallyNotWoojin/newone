import type { ActionItemRecord } from "../../../lib/types";
import { requireActor } from "../../../lib/server/auth";
import { getD1 } from "../../../lib/server/database";
import { apiError, readJson } from "../../../lib/server/http";
import { listActions } from "../../../lib/server/queries";

export async function PATCH(request: Request) {
  try {
    const actor = await requireActor(request);
    if (!["manager", "admin"].includes(actor.role)) {
      return Response.json({ error: "Manager access is required" }, { status: 403 });
    }
    const payload = await readJson<{ id?: unknown; status?: unknown }>(request);
    if (
      typeof payload.id !== "string" ||
      !payload.id.trim() ||
      payload.id.length > 128 ||
      typeof payload.status !== "string" ||
      !["needs_confirmation", "open", "done"].includes(payload.status)
    ) {
      return Response.json({ error: "Valid id and status are required" }, { status: 400 });
    }
    const itemId = payload.id.trim();
    const status = payload.status as ActionItemRecord["status"];
    const item = await getD1()
      .prepare(
        `SELECT a.thread_id, a.status FROM action_items a
         WHERE a.id = ? AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = a.thread_id AND tm.user_email = ?)
         LIMIT 1`,
      )
      .bind(itemId, actor.email)
      .first<{ thread_id: string; status: ActionItemRecord["status"] }>();
    if (!item) return Response.json({ error: "Action item not found" }, { status: 404 });
    if (item.status !== status) {
      const changed = await getD1()
        .prepare("UPDATE action_items SET status = ? WHERE id = ? AND status = ?")
        .bind(status, itemId, item.status)
        .run();
      if (changed.meta.changes === 0) {
        return Response.json(
          { error: "Action item changed; refresh and try again" },
          { status: 409 },
        );
      }
      await getD1()
        .prepare(
          `INSERT INTO action_events
           (id, action_id, thread_id, actor_email, previous_status, new_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          itemId,
          item.thread_id,
          actor.email,
          item.status,
          status,
          new Date().toISOString(),
        )
        .run();
    }
    return Response.json({ actions: await listActions(actor, item.thread_id) });
  } catch (error) {
    return apiError(error);
  }
}
