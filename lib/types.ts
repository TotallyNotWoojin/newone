export type Language = "ko" | "es" | "mixed";
export type SupportedLanguage = Exclude<Language, "mixed">;

export type TranslationStatus =
  | "pending"
  | "translating"
  | "translated"
  | "retryable_failed"
  | "permanent_failed";

export type MessagePriority = "normal" | "important" | "safety";
export type MessageKind =
  | "message"
  | "safety"
  | "production"
  | "maintenance"
  | "quality"
  | "handoff"
  | "instruction";

export interface Actor {
  email: string;
  displayName: string;
  preferredLanguage: SupportedLanguage;
  role: "member" | "manager" | "admin";
}

export interface ThreadRecord {
  id: string;
  title: string;
  subtitle: string;
  kind: string;
  location: string;
  shiftKey: string | null;
  updatedAt: string;
  lastMessage: string;
  unreadCount: number;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  clientMessageId: string;
  senderEmail: string;
  senderName: string;
  sourceText: string;
  sourceLanguage: SupportedLanguage;
  targetLanguage: SupportedLanguage;
  translatedText: string | null;
  detectedLanguage: SupportedLanguage | null;
  translationWarning: string | null;
  translationStatus: TranslationStatus;
  messageKind: MessageKind;
  priority: MessagePriority;
  deliveryStatus: "queued" | "sending" | "delivered" | "read" | "failed";
  humanReviewed: boolean;
  provider: string | null;
  model: string | null;
  createdAt: string;
  translatedAt: string | null;
}

export interface SummaryRecord {
  id: string;
  threadId: string;
  headlineKo: string;
  headlineEs: string;
  summaryKo: string;
  summaryEs: string;
  sourceMessageIds: string[];
  generatedBy: "demo" | "extractive" | "openrouter";
  model: string | null;
  createdAt: string;
}

export interface ActionItemRecord {
  id: string;
  threadId: string;
  titleKo: string;
  titleEs: string;
  owner: string | null;
  dueLabel: string | null;
  status: "needs_confirmation" | "open" | "done";
  sourceMessageId: string | null;
  createdAt: string;
}

export interface BootstrapPayload {
  actor: Actor;
  threads: ThreadRecord[];
  messages: MessageRecord[];
  summary: SummaryRecord | null;
  actions: ActionItemRecord[];
  ai: {
    configured: boolean;
    translationModel: string;
    summaryModel: string;
    provider: string;
    privacyMode: "zdr";
  };
  demoMode: boolean;
  summaryRefreshDue: boolean;
}

export interface TranslationResult {
  translatedText: string;
  detectedLanguage: SupportedLanguage;
  warning: string | null;
  provider: string;
  model: string;
}

export interface GeneratedSummary {
  headlineKo: string;
  headlineEs: string;
  summaryKo: string;
  summaryEs: string;
  sourceMessageIds: string[];
  actions: Array<{
    titleKo: string;
    titleEs: string;
    owner: string | null;
    dueLabel: string | null;
    sourceMessageId: string | null;
  }>;
  model: string;
}
