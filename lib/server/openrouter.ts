import type {
  GeneratedSummary,
  MessageRecord,
  SupportedLanguage,
  TranslationResult,
} from "../types";
import { runtimeValue } from "./runtime";

const DEFAULT_TRANSLATION_MODEL = "qwen/qwen3-235b-a22b-2507";
const DEFAULT_SUMMARY_MODEL = "qwen/qwen3-235b-a22b-2507";
const DEFAULT_PROVIDER = "google-vertex/us-south1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export class AiUnavailableError extends Error {
  status = 503;
}

class NonRetryableAiError extends Error {}

export function aiConfiguration() {
  const approved = ["1", "true", "yes", "on"].includes(
    (runtimeValue("NEWONE_AI_DATA_EGRESS_APPROVED") ?? "").toLowerCase(),
  );
  return {
    configured: Boolean(runtimeValue("OPENROUTER_API_KEY")) && approved,
    translationModel:
      runtimeValue("OPENROUTER_TRANSLATION_MODEL") ?? DEFAULT_TRANSLATION_MODEL,
    summaryModel: runtimeValue("OPENROUTER_SUMMARY_MODEL") ?? DEFAULT_SUMMARY_MODEL,
    provider: runtimeValue("OPENROUTER_PROVIDER") ?? DEFAULT_PROVIDER,
    privacyMode: "zdr" as const,
  };
}

export async function translateMessage(input: {
  text: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  glossary?: Array<{ source: string; target: string }>;
}): Promise<TranslationResult> {
  const config = aiConfiguration();
  const content = await callOpenRouter({
    model: config.translationModel,
    maxTokens: 700,
    schemaName: "bilingual_translation",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["translation", "detected_language", "warning"],
      properties: {
        translation: { type: "string" },
        detected_language: { type: "string", enum: ["ko", "es"] },
        warning: { type: ["string", "null"] },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "You are a careful workplace translator for a hot-dip galvanizing plant. Translate faithfully between Korean and Mexican/US workplace Spanish. Preserve names, equipment IDs, numbers, units, dates, times, negation, urgency, and formatting exactly. Never add instructions or soften safety language. Return only the requested JSON. If wording is genuinely ambiguous, translate the most literal reading and add a brief bilingual warning.",
      },
      {
        role: "user",
        content: JSON.stringify({
          source_language: input.sourceLanguage,
          target_language: input.targetLanguage,
          glossary: input.glossary ?? [],
          text: input.text,
        }),
      },
    ],
  });

  const parsed = JSON.parse(content) as {
    translation: string;
    detected_language: SupportedLanguage;
    warning: string | null;
  };
  if (
    typeof parsed.translation !== "string" ||
    !parsed.translation.trim() ||
    !["ko", "es"].includes(parsed.detected_language) ||
    (parsed.warning !== null && typeof parsed.warning !== "string")
  ) {
    throw new Error("Translation response did not match the required schema");
  }

  return {
    translatedText: parsed.translation.trim(),
    detectedLanguage: parsed.detected_language,
    warning: parsed.warning,
    provider: config.provider,
    model: config.translationModel,
  };
}

export async function generateSummary(
  messages: MessageRecord[],
): Promise<GeneratedSummary> {
  const config = aiConfiguration();
  const compactMessages = messages.map((message) => ({
    id: message.id,
    at: message.createdAt,
    sender: message.senderName,
    original_language: message.sourceLanguage,
    original: message.sourceText,
    translation: message.translatedText,
    kind: message.messageKind,
    priority: message.priority,
  }));

  const content = await callOpenRouter({
    model: config.summaryModel,
    maxTokens: 1800,
    schemaName: "bilingual_shift_brief",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "headline_ko",
        "headline_es",
        "summary_ko",
        "summary_es",
        "source_message_ids",
        "actions",
      ],
      properties: {
        headline_ko: { type: "string" },
        headline_es: { type: "string" },
        summary_ko: { type: "string" },
        summary_es: { type: "string" },
        source_message_ids: { type: "array", items: { type: "string" } },
        actions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title_ko", "title_es", "owner", "due_label", "source_message_id"],
            properties: {
              title_ko: { type: "string" },
              title_es: { type: "string" },
              owner: { type: ["string", "null"] },
              due_label: { type: ["string", "null"] },
              source_message_id: { type: "string" },
            },
          },
        },
      },
    },
    messages: [
      {
        role: "system",
        content:
          "Create a source-grounded bilingual shift brief from the supplied messages. Prioritize unacknowledged safety issues, quality events, production blockers, decisions, maintenance updates, action items, and open questions. Do not invent an owner, deadline, decision, or fact. Every claim and action must be traceable to one of the supplied message IDs. Keep Korean and Spanish semantically equivalent. Return only the requested JSON.",
      },
      { role: "user", content: JSON.stringify({ messages: compactMessages }) },
    ],
  });

  const parsed = JSON.parse(content) as {
    headline_ko: string;
    headline_es: string;
    summary_ko: string;
    summary_es: string;
    source_message_ids: string[];
    actions: Array<{
      title_ko: string;
      title_es: string;
      owner: string | null;
      due_label: string | null;
      source_message_id: string;
    }>;
  };

  const validIds = new Set(messages.map((message) => message.id));
  if (
    typeof parsed.headline_ko !== "string" ||
    typeof parsed.headline_es !== "string" ||
    typeof parsed.summary_ko !== "string" ||
    typeof parsed.summary_es !== "string" ||
    !Array.isArray(parsed.source_message_ids) ||
    parsed.source_message_ids.length === 0 ||
    !parsed.source_message_ids.every(
      (id) => typeof id === "string" && validIds.has(id),
    ) ||
    !Array.isArray(parsed.actions) ||
    !parsed.actions.every(
      (action) =>
        action &&
        typeof action.title_ko === "string" &&
        typeof action.title_es === "string" &&
        (action.owner === null || typeof action.owner === "string") &&
        (action.due_label === null || typeof action.due_label === "string") &&
        typeof action.source_message_id === "string" &&
        validIds.has(action.source_message_id),
    )
  ) {
    throw new Error("Summary response was not fully source-grounded");
  }
  return {
    headlineKo: parsed.headline_ko,
    headlineEs: parsed.headline_es,
    summaryKo: parsed.summary_ko,
    summaryEs: parsed.summary_es,
    sourceMessageIds: [...new Set(parsed.source_message_ids)],
    actions: parsed.actions.map((action) => ({
      titleKo: action.title_ko,
      titleEs: action.title_es,
      owner: action.owner,
      dueLabel: action.due_label,
      sourceMessageId: action.source_message_id,
    })),
    model: config.summaryModel,
  };
}

async function callOpenRouter(input: {
  model: string;
  maxTokens: number;
  schemaName: string;
  schema: Record<string, unknown>;
  messages: Array<{ role: "system" | "user"; content: string }>;
}): Promise<string> {
  const apiKey = runtimeValue("OPENROUTER_API_KEY");
  if (!apiKey || !aiConfiguration().configured) {
    throw new AiUnavailableError(
      apiKey
        ? "AI data egress is waiting for Company approval"
        : "OpenRouter is not configured",
    );
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer":
            runtimeValue("NEWONE_APP_URL") ?? "https://newone-relay.invalid",
          "X-Title": "Newone Relay",
          "X-OpenRouter-Cache": "false",
        },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          temperature: 0,
          max_tokens: input.maxTokens,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: input.schemaName,
              strict: true,
              schema: input.schema,
            },
          },
          provider: {
            only: [aiConfiguration().provider],
            zdr: true,
            data_collection: "deny",
            require_parameters: true,
            allow_fallbacks: false,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (!retryable || attempt === 2) {
          throw new NonRetryableAiError(
            `OpenRouter request failed with status ${response.status}`,
          );
        }
        await delay(backoff(attempt, response.headers.get("retry-after")));
        continue;
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error("OpenRouter returned no content");
      return content;
    } catch (error) {
      lastError = error;
      if (
        attempt === 2 ||
        error instanceof AiUnavailableError ||
        error instanceof NonRetryableAiError
      ) {
        break;
      }
      await delay(backoff(attempt, null));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("OpenRouter request failed");
}

function backoff(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter ? Number.parseFloat(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 5000);
  const ceiling = Math.min(500 * 2 ** attempt, 3000);
  return Math.floor(Math.random() * ceiling);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
