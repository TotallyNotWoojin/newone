import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const profiles = sqliteTable(
  "profiles",
  {
    email: text("email").primaryKey(),
    displayName: text("display_name").notNull(),
    preferredLanguage: text("preferred_language").notNull().default("es"),
    role: text("role").notNull().default("member"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("profiles_language_check", sql`${table.preferredLanguage} IN ('ko', 'es')`),
    check("profiles_role_check", sql`${table.role} IN ('member', 'manager', 'admin')`),
  ],
);

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  subtitle: text("subtitle").notNull().default(""),
  kind: text("kind").notNull().default("operations"),
  location: text("location").notNull().default(""),
  shiftKey: text("shift_key"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const threadMembers = sqliteTable(
  "thread_members",
  {
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull().references(() => profiles.email, { onDelete: "cascade" }),
    joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("thread_members_thread_user_idx").on(
      table.threadId,
      table.userEmail,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    clientMessageId: text("client_message_id").notNull(),
    senderEmail: text("sender_email").notNull().references(() => profiles.email),
    senderName: text("sender_name").notNull(),
    sourceText: text("source_text").notNull(),
    sourceLanguage: text("source_language").notNull(),
    targetLanguage: text("target_language").notNull(),
    translatedText: text("translated_text"),
    detectedLanguage: text("detected_language"),
    translationWarning: text("translation_warning"),
    translationStatus: text("translation_status").notNull().default("pending"),
    translationStartedAt: text("translation_started_at"),
    messageKind: text("message_kind").notNull().default("message"),
    priority: text("priority").notNull().default("normal"),
    deliveryStatus: text("delivery_status").notNull().default("delivered"),
    humanReviewed: integer("human_reviewed", { mode: "boolean" })
      .notNull()
      .default(false),
    provider: text("provider"),
    model: text("model"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    translatedAt: text("translated_at"),
  },
  (table) => [
    uniqueIndex("messages_sender_client_idx").on(
      table.senderEmail,
      table.clientMessageId,
    ),
    index("messages_thread_created_idx").on(table.threadId, table.createdAt, table.id),
    check("messages_source_language_check", sql`${table.sourceLanguage} IN ('ko', 'es')`),
    check("messages_target_language_check", sql`${table.targetLanguage} IN ('ko', 'es')`),
    check(
      "messages_translation_status_check",
      sql`${table.translationStatus} IN ('pending', 'translating', 'translated', 'retryable_failed', 'permanent_failed')`,
    ),
    check(
      "messages_kind_check",
      sql`${table.messageKind} IN ('message', 'safety', 'production', 'maintenance', 'quality', 'handoff', 'instruction')`,
    ),
    check("messages_priority_check", sql`${table.priority} IN ('normal', 'important', 'safety')`),
  ],
);

export const summaries = sqliteTable(
  "summaries",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    headlineKo: text("headline_ko").notNull(),
    headlineEs: text("headline_es").notNull(),
    summaryKo: text("summary_ko").notNull(),
    summaryEs: text("summary_es").notNull(),
    sourceMessageIds: text("source_message_ids").notNull().default("[]"),
    generatedBy: text("generated_by").notNull().default("demo"),
    model: text("model"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("summaries_thread_created_idx").on(table.threadId, table.createdAt)],
);

export const actionItems = sqliteTable(
  "action_items",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    titleKo: text("title_ko").notNull(),
    titleEs: text("title_es").notNull(),
    owner: text("owner"),
    dueLabel: text("due_label"),
    status: text("status").notNull().default("needs_confirmation"),
    sourceMessageId: text("source_message_id").references(() => messages.id),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("action_items_thread_status_idx").on(table.threadId, table.status),
    check(
      "action_items_status_check",
      sql`${table.status} IN ('needs_confirmation', 'open', 'done')`,
    ),
  ],
);

export const summaryRuns = sqliteTable(
  "summary_runs",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    sourceFingerprint: text("source_fingerprint").notNull(),
    status: text("status").notNull().default("running"),
    summaryId: text("summary_id"),
    startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("summary_runs_thread_fingerprint_idx").on(
      table.threadId,
      table.sourceFingerprint,
    ),
    check("summary_runs_status_check", sql`${table.status} IN ('running', 'complete', 'failed')`),
  ],
);

export const actionEvents = sqliteTable(
  "action_events",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull().references(() => actionItems.id, { onDelete: "cascade" }),
    threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
    actorEmail: text("actor_email").notNull().references(() => profiles.email),
    previousStatus: text("previous_status").notNull(),
    newStatus: text("new_status").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("action_events_action_created_idx").on(table.actionId, table.createdAt)],
);
