import { requireActor } from "../../../lib/server/auth";
import { apiError, readJson } from "../../../lib/server/http";
import { translateMessage } from "../../../lib/server/openrouter";
import {
  claimTranslation,
  getMessage,
  setTranslation,
} from "../../../lib/server/queries";

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const payload = await readJson<{ messageId?: unknown }>(request);
    if (
      typeof payload.messageId !== "string" ||
      !payload.messageId.trim() ||
      payload.messageId.length > 128
    ) {
      return Response.json({ error: "Valid messageId is required" }, { status: 400 });
    }
    const message = await getMessage(actor, payload.messageId.trim());
    if (!message) return Response.json({ error: "Message not found" }, { status: 404 });
    if (message.translationStatus === "translated") return Response.json({ message });
    const claimed = await claimTranslation(message.id);
    if (!claimed) {
      return Response.json(
        { message: await getMessage(actor, message.id) },
        { status: 202 },
      );
    }

    try {
      const result = await translateMessage({
        text: message.sourceText,
        sourceLanguage: message.sourceLanguage,
        targetLanguage: message.targetLanguage,
      });
      await setTranslation({
        messageId: message.id,
        translatedText: result.translatedText,
        status: "translated",
        provider: result.provider,
        model: result.model,
        detectedLanguage: result.detectedLanguage,
        warning:
          result.detectedLanguage !== message.sourceLanguage
            ? [
                result.warning,
                "Detected source language differs from the message route. Verify before relying on this translation.",
              ]
                .filter(Boolean)
                .join(" ")
            : result.warning,
      });
    } catch (error) {
      await setTranslation({ messageId: message.id, status: "retryable_failed" });
      throw error;
    }

    return Response.json({ message: await getMessage(actor, message.id) });
  } catch (error) {
    return apiError(error);
  }
}
