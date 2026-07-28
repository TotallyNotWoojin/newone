import type { BootstrapPayload } from "../../../lib/types";
import { requireActor, isDemoActor } from "../../../lib/server/auth";
import { apiError } from "../../../lib/server/http";
import { aiConfiguration } from "../../../lib/server/openrouter";
import {
  latestSummary,
  listActions,
  listMessages,
  listThreads,
} from "../../../lib/server/queries";

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const url = new URL(request.url);
    const threads = await listThreads(actor);
    const requested = url.searchParams.get("threadId");
    if (requested && !threads.some((thread) => thread.id === requested)) {
      return Response.json({ error: "Conversation not found" }, { status: 404 });
    }
    const threadId = threads.some((thread) => thread.id === requested)
      ? requested!
      : threads[0]?.id;
    if (!threadId) {
      return Response.json(
        { error: "No conversations are assigned to this account" },
        { status: 403 },
      );
    }

    const [messages, summary, actions] = await Promise.all([
      listMessages(actor, threadId),
      latestSummary(actor, threadId),
      listActions(actor, threadId),
    ]);
    const payload: BootstrapPayload = {
      actor,
      threads,
      messages,
      summary,
      actions,
      ai: aiConfiguration(),
      demoMode: isDemoActor(actor),
      summaryRefreshDue:
        !summary ||
        messages.filter((message) => message.createdAt > summary.createdAt).length >= 8 ||
        messages.some(
          (message) =>
            message.createdAt > summary.createdAt && message.messageKind === "handoff",
        ),
    };
    return Response.json(payload);
  } catch (error) {
    return apiError(error);
  }
}
