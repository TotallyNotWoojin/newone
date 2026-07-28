import type {
  ActionItemRecord,
  Actor,
  MessageKind,
  MessagePriority,
  MessageRecord,
  SummaryRecord,
  SupportedLanguage,
  ThreadRecord,
  TranslationStatus,
} from "../types";
import { getD1 } from "./database";
import { ApiRequestError } from "./http";

type MessageRow = {
  id: string;
  thread_id: string;
  client_message_id: string;
  sender_email: string;
  sender_name: string;
  source_text: string;
  source_language: SupportedLanguage;
  target_language: SupportedLanguage;
  translated_text: string | null;
  detected_language: SupportedLanguage | null;
  translation_warning: string | null;
  translation_status: TranslationStatus;
  message_kind: MessageKind;
  priority: MessagePriority;
  delivery_status: MessageRecord["deliveryStatus"];
  human_reviewed: number;
  provider: string | null;
  model: string | null;
  created_at: string;
  translated_at: string | null;
};

export async function listThreads(actor: Actor): Promise<ThreadRecord[]> {
  const result = await getD1()
    .prepare(
      `SELECT t.id, t.title, t.subtitle, t.kind, t.location, t.shift_key, t.updated_at,
        COALESCE((SELECT COALESCE(m.translated_text, m.source_text) FROM messages m WHERE m.thread_id = t.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1), '') AS last_message
       FROM threads t
       WHERE EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = t.id AND tm.user_email = ?)
       ORDER BY t.updated_at DESC`,
    )
    .bind(actor.email)
    .all<{
      id: string;
      title: string;
      subtitle: string;
      kind: string;
      location: string;
      shift_key: string | null;
      updated_at: string;
      last_message: string;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    kind: row.kind,
    location: row.location,
    shiftKey: row.shift_key,
    updatedAt: row.updated_at,
    lastMessage: row.last_message,
    unreadCount: 0,
  }));
}

export async function listMessages(
  actor: Actor,
  threadId: string,
  after?: string | null,
): Promise<MessageRecord[]> {
  const sql = after
    ? `SELECT recent.* FROM (
         SELECT m.* FROM messages m
         WHERE m.thread_id = ? AND m.created_at > ?
           AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = m.thread_id AND tm.user_email = ?)
         ORDER BY m.created_at DESC, m.id DESC LIMIT 300
       ) recent ORDER BY recent.created_at ASC, recent.id ASC`
    : `SELECT recent.* FROM (
         SELECT m.* FROM messages m
         WHERE m.thread_id = ?
           AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = m.thread_id AND tm.user_email = ?)
         ORDER BY m.created_at DESC, m.id DESC LIMIT 300
       ) recent ORDER BY recent.created_at ASC, recent.id ASC`;
  const statement = getD1().prepare(sql);
  const result = after
    ? await statement.bind(threadId, after, actor.email).all<MessageRow>()
    : await statement.bind(threadId, actor.email).all<MessageRow>();
  return result.results.map(mapMessage);
}

export async function getMessage(
  actor: Actor,
  messageId: string,
): Promise<MessageRecord | null> {
  const row = await getD1()
    .prepare(
      `SELECT m.* FROM messages m
       WHERE m.id = ?
         AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = m.thread_id AND tm.user_email = ?)
       LIMIT 1`,
    )
    .bind(messageId, actor.email)
    .first<MessageRow>();
  return row ? mapMessage(row) : null;
}

export async function latestSummary(
  actor: Actor,
  threadId: string,
): Promise<SummaryRecord | null> {
  const row = await getD1()
    .prepare(
      `SELECT s.* FROM summaries s
       WHERE s.thread_id = ?
         AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = s.thread_id AND tm.user_email = ?)
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .bind(threadId, actor.email)
    .first<{
      id: string;
      thread_id: string;
      headline_ko: string;
      headline_es: string;
      summary_ko: string;
      summary_es: string;
      source_message_ids: string;
      generated_by: SummaryRecord["generatedBy"];
      model: string | null;
      created_at: string;
    }>();

  if (!row) return null;
  return {
    id: row.id,
    threadId: row.thread_id,
    headlineKo: row.headline_ko,
    headlineEs: row.headline_es,
    summaryKo: row.summary_ko,
    summaryEs: row.summary_es,
    sourceMessageIds: safeStringArray(row.source_message_ids),
    generatedBy: row.generated_by,
    model: row.model,
    createdAt: row.created_at,
  };
}

export async function listActions(
  actor: Actor,
  threadId: string,
): Promise<ActionItemRecord[]> {
  const result = await getD1()
    .prepare(
      `SELECT a.* FROM action_items a
       WHERE a.thread_id = ?
         AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = a.thread_id AND tm.user_email = ?)
       ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'needs_confirmation' THEN 1 ELSE 2 END, a.created_at DESC`,
    )
    .bind(threadId, actor.email)
    .all<{
      id: string;
      thread_id: string;
      title_ko: string;
      title_es: string;
      owner: string | null;
      due_label: string | null;
      status: ActionItemRecord["status"];
      source_message_id: string | null;
      created_at: string;
    }>();

  return result.results.map((row) => ({
    id: row.id,
    threadId: row.thread_id,
    titleKo: row.title_ko,
    titleEs: row.title_es,
    owner: row.owner,
    dueLabel: row.due_label,
    status: row.status,
    sourceMessageId: row.source_message_id,
    createdAt: row.created_at,
  }));
}

export async function searchMessages(
  actor: Actor,
  query: string,
): Promise<MessageRecord[]> {
  const term = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const result = await getD1()
    .prepare(
      `SELECT m.* FROM messages m
       WHERE (m.source_text LIKE ? ESCAPE '\\' OR m.translated_text LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\')
         AND EXISTS (SELECT 1 FROM thread_members tm WHERE tm.thread_id = m.thread_id AND tm.user_email = ?)
       ORDER BY m.created_at DESC LIMIT 50`,
    )
    .bind(term, term, term, actor.email)
    .all<MessageRow>();
  return result.results.map(mapMessage);
}

export async function insertMessage(input: {
  actor: Actor;
  threadId: string;
  clientMessageId: string;
  text: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  kind: MessageKind;
  priority: MessagePriority;
}): Promise<{ message: MessageRecord; replayed: boolean }> {
  const db = getD1();
  const membership = await db
    .prepare("SELECT 1 AS allowed FROM thread_members WHERE thread_id = ? AND user_email = ? LIMIT 1")
    .bind(input.threadId, input.actor.email)
    .first();
  if (!membership) throw new ApiRequestError("Thread not found or access denied", 404);

  const existing = await db
    .prepare("SELECT * FROM messages WHERE sender_email = ? AND client_message_id = ? LIMIT 1")
    .bind(input.actor.email, input.clientMessageId)
    .first<MessageRow>();
  if (existing) {
    assertMatchingReplay(existing, input);
    return { message: mapMessage(existing), replayed: true };
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const write = await db
    .prepare(
      `INSERT OR IGNORE INTO messages (id, thread_id, client_message_id, sender_email, sender_name, source_text, source_language, target_language, translation_status, message_kind, priority, delivery_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'delivered', ?)`,
    )
    .bind(
      id,
      input.threadId,
      input.clientMessageId,
      input.actor.email,
      input.actor.displayName,
      input.text,
      input.sourceLanguage,
      input.targetLanguage,
      input.kind,
      input.priority,
      createdAt,
    )
    .run();

  if (write.meta.changes > 0) {
    await db
      .prepare("UPDATE threads SET updated_at = ? WHERE id = ?")
      .bind(createdAt, input.threadId)
      .run();
  }

  const inserted = await db
    .prepare("SELECT * FROM messages WHERE sender_email = ? AND client_message_id = ? LIMIT 1")
    .bind(input.actor.email, input.clientMessageId)
    .first<MessageRow>();
  if (!inserted) throw new Error("Message could not be created");
  assertMatchingReplay(inserted, input);
  return { message: mapMessage(inserted), replayed: write.meta.changes === 0 };
}

export async function claimTranslation(messageId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const result = await getD1()
    .prepare(
      `UPDATE messages
       SET translation_status = 'translating', translation_started_at = ?
       WHERE id = ? AND (
         translation_status IN ('pending', 'retryable_failed') OR
         (translation_status = 'translating' AND translation_started_at < ?)
       )`,
    )
    .bind(new Date().toISOString(), messageId, staleBefore)
    .run();
  return result.meta.changes === 1;
}

export async function setTranslation(input: {
  messageId: string;
  translatedText?: string;
  status: TranslationStatus;
  provider?: string;
  model?: string;
  detectedLanguage?: SupportedLanguage;
  warning?: string | null;
}): Promise<void> {
  await getD1()
    .prepare(
      `UPDATE messages
       SET translated_text = COALESCE(?, translated_text),
           detected_language = COALESCE(?, detected_language),
           translation_warning = COALESCE(?, translation_warning),
           translation_status = ?,
           provider = COALESCE(?, provider),
           model = COALESCE(?, model),
           translated_at = CASE WHEN ? = 'translated' THEN ? ELSE translated_at END
       WHERE id = ? AND translation_status = 'translating'`,
    )
    .bind(
      input.translatedText ?? null,
      input.detectedLanguage ?? null,
      input.warning ?? null,
      input.status,
      input.provider ?? null,
      input.model ?? null,
      input.status,
      new Date().toISOString(),
      input.messageId,
    )
    .run();
}

export function mapMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    clientMessageId: row.client_message_id,
    senderEmail: row.sender_email,
    senderName: row.sender_name,
    sourceText: row.source_text,
    sourceLanguage: row.source_language,
    targetLanguage: row.target_language,
    translatedText: row.translated_text,
    detectedLanguage: row.detected_language ?? null,
    translationWarning: row.translation_warning ?? null,
    translationStatus: row.translation_status,
    messageKind: row.message_kind,
    priority: row.priority,
    deliveryStatus: row.delivery_status,
    humanReviewed: Boolean(row.human_reviewed),
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    translatedAt: row.translated_at,
  };
}

function assertMatchingReplay(
  row: MessageRow,
  input: {
    threadId: string;
    text: string;
    sourceLanguage: SupportedLanguage;
    targetLanguage: SupportedLanguage;
    kind: MessageKind;
    priority: MessagePriority;
  },
): void {
  if (
    row.thread_id !== input.threadId ||
    row.source_text !== input.text ||
    row.source_language !== input.sourceLanguage ||
    row.target_language !== input.targetLanguage ||
    row.message_kind !== input.kind ||
    row.priority !== input.priority
  ) {
    throw new ApiRequestError(
      "clientMessageId was already used for a different message",
      409,
    );
  }
}

function safeStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}
