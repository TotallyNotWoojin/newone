import { detectLanguage, targetLanguage } from "../../../lib/language";
import type {
  MessageKind,
  MessagePriority,
  SupportedLanguage,
} from "../../../lib/types";
import { requireActor } from "../../../lib/server/auth";
import { ApiRequestError, apiError, readJson } from "../../../lib/server/http";
import { insertMessage, listMessages } from "../../../lib/server/queries";

const KINDS = new Set<MessageKind>([
  "message",
  "safety",
  "production",
  "maintenance",
  "quality",
  "handoff",
  "instruction",
]);
const PRIORITIES = new Set<MessagePriority>(["normal", "important", "safety"]);

export async function GET(request: Request) {
  try {
    const actor = await requireActor(request);
    const url = new URL(request.url);
    const threadId = url.searchParams.get("threadId")?.trim();
    if (!threadId) return Response.json({ error: "threadId is required" }, { status: 400 });
    const messages = await listMessages(actor, threadId, url.searchParams.get("after"));
    return Response.json({ messages });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const payload = await readJson<{
      threadId?: string;
      clientMessageId?: string;
      text?: string;
      sourceLanguage?: SupportedLanguage;
      kind?: MessageKind;
      priority?: MessagePriority;
    }>(request);
    if (typeof payload.text !== "string") throw new ApiRequestError("text must be a string");
    if (typeof payload.threadId !== "string") throw new ApiRequestError("threadId is required");
    if (typeof payload.clientMessageId !== "string") throw new ApiRequestError("clientMessageId is required");
    if (payload.sourceLanguage !== undefined && !["ko", "es"].includes(payload.sourceLanguage)) {
      throw new ApiRequestError("sourceLanguage must be ko or es");
    }
    if (payload.kind !== undefined && !KINDS.has(payload.kind)) {
      throw new ApiRequestError("Unknown message kind");
    }
    if (payload.priority !== undefined && !PRIORITIES.has(payload.priority)) {
      throw new ApiRequestError("Unknown message priority");
    }

    const text = payload.text.trim();
    const threadId = payload.threadId.trim();
    const clientMessageId = payload.clientMessageId.trim();
    if (!threadId || threadId.length > 120) throw new ApiRequestError("threadId must be 1–120 characters");
    if (!clientMessageId || clientMessageId.length > 128) throw new ApiRequestError("clientMessageId must be 1–128 characters");
    if (!text || text.length > 2000) return Response.json({ error: "Message must be 1–2,000 characters" }, { status: 400 });

    const detected = detectLanguage(text);
    const sourceLanguage = detected === "mixed"
      ? payload.sourceLanguage ?? actor.preferredLanguage
      : detected;
    const kind = payload.kind ?? "message";
    const priority = payload.priority ?? (kind === "safety" ? "safety" : "normal");
    const { message, replayed } = await insertMessage({
      actor,
      threadId,
      clientMessageId,
      text,
      sourceLanguage,
      targetLanguage: targetLanguage(sourceLanguage),
      kind,
      priority,
    });
    return Response.json(
      { message, detectedLanguage: detected, replayed },
      { status: replayed ? 200 : 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}
