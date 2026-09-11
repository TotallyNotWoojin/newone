import type { ConversationSummary, SummaryActionItem, SummaryScopeKind } from '@/domain/types';

// The server mints source references as "s" plus four digits (s0001…), so the
// leading zero is what separates a reference from ordinary content ("s2024").
const SOURCE_REFERENCE = /\bs0[0-9]{3}\b/g;
const SOURCE_REFERENCE_GROUP =
  /[[(（【]\s*(?:\p{L}{1,12}\s*[:：])?\s*s0[0-9]{3}(?:\s*[,;、/]\s*s0[0-9]{3})*\s*[\])）】]/gu;

/**
 * Removes source-reference tokens that older summaries carry in their text
 * ("[sources:s0002,s0004]", "(s0003)") and tidies the punctuation around them,
 * so nothing that looks like machinery reaches a screen or an exported file.
 */
export function stripSummarySourceTokens(text: string): string {
  return text
    .replace(SOURCE_REFERENCE_GROUP, '')
    .replace(SOURCE_REFERENCE, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/\(\s*\)|\[\s*\]/g, '')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/[,;]\s*(?=[,;.!?])/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const READY_STATUSES = new Set<ConversationSummary['status']>(['ready_for_review', 'approved', 'corrected']);

/** The ranges a reader can pick, in the order the sheet shows them. */
export const SUMMARY_SCOPE_KINDS: readonly SummaryScopeKind[] = [
  'unread', 'today', 'yesterday', 'last_7_days', 'everything',
];

/**
 * The newest summary version of a conversation, whatever its state. With a
 * reader id, that reader's own newest version wins when they have one: the
 * prose says "you" from the requester's side.
 */
export function latestSummary(
  summaries: ConversationSummary[],
  conversationId: string,
  userId: string | null = null,
): ConversationSummary | undefined {
  const inConversation = summaries.filter((summary) => summary.conversationId === conversationId);
  const own = userId ? inConversation.filter((summary) => summary.requestedByUserId === userId) : [];
  return (own.length ? own : inConversation)
    .sort((left, right) => right.versionNumber - left.versionNumber)[0];
}

/** True when the summary has text a person can read. */
export function summaryIsReady(summary: ConversationSummary | undefined): summary is ConversationSummary {
  return Boolean(summary && READY_STATUSES.has(summary.status) && summary.summary);
}

export interface ScopeLineCopy {
  ranges: Record<SummaryScopeKind, string>;
  /** "{range} · {count} messages" */
  lineTemplate: string;
  /** "{range} · 1 message" */
  lineOneTemplate: string;
  /** "about {subject}" */
  aboutTemplate: string;
}

/**
 * One line saying what a summary covers: "Last 7 days · 143 messages · about
 * the trip". Versions made before ranges existed carry only the count.
 */
export function summaryScopeLine(
  summary: Pick<ConversationSummary, 'scopeKind' | 'scopeSubject' | 'sourceMessageCount'>,
  copy: ScopeLineCopy,
): string {
  const template = summary.sourceMessageCount === 1 ? copy.lineOneTemplate : copy.lineTemplate;
  const range = summary.scopeKind ? copy.ranges[summary.scopeKind] : null;
  const line = (range === null ? template.replace(/\{range\}\s*·\s*/, '').replace('{range}', '') : template.replace('{range}', range))
    .replace('{count}', String(summary.sourceMessageCount))
    .trim();
  const subject = summary.scopeSubject?.trim();
  return subject ? `${line} · ${copy.aboutTemplate.replace('{subject}', subject)}` : line;
}

/** "Book the cabin · Diego · Friday": the to-do line people read. */
export function summaryTodoText(item: SummaryActionItem): string {
  return [item.title, item.owner, item.dueAt]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .map(stripSummarySourceTokens)
    .join(' · ');
}

/** The text that is copied or written to the shared file. */
export function summaryExportText(input: {
  title: string;
  body: string;
  conversationTitle: string;
  scope: string | null;
  decisions?: string[];
  todos?: string[];
  headings?: { decisions: string; todo: string };
}): string {
  const heading = stripSummarySourceTokens(input.title);
  const meta = [input.conversationTitle.trim(), input.scope?.trim()].filter(Boolean).join(' · ');
  const lines = [heading, meta, '', stripSummarySourceTokens(input.body)].filter((line, index) => line || index === 2);
  const list = (title: string | undefined, items: string[] | undefined) => {
    const clean = (items ?? []).map(stripSummarySourceTokens).filter(Boolean);
    if (!clean.length) return;
    lines.push('', title ?? '', ...clean.map((item) => `• ${item}`));
  };
  list(input.headings?.decisions, input.decisions);
  list(input.headings?.todo, input.todos);
  return lines.join('\n') + '\n';
}

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "Gist summary – Weekend plans – 2026-09-05.txt", safe for every file system. */
export function summaryFileName(conversationTitle: string, date = new Date()): string {
  const safeTitle = conversationTitle
    .replace(/[\\/:*?"<>| -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim() || 'Conversation';
  return `Gist summary – ${safeTitle} – ${localDate(date)}.txt`;
}
