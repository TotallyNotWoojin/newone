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

/**
 * The ranges a reader can pick, in the order the sheet shows them. "Unread"
 * left on Sep 14 2026 (owner: the app marks a chat read as it opens, so the
 * span meant little) and the longer spans arrived the same day; the server
 * still accepts 'unread' from older builds.
 */
export const SUMMARY_SCOPE_KINDS: readonly SummaryScopeKind[] = [
  'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'everything',
];

/** How far back a range reaches from the day it was requested; null means everything. */
export function summaryCoverageDates(
  scopeKind: SummaryScopeKind | null,
  requestedAt: string | Date,
): { from: Date; until: Date } | null {
  const until = new Date(requestedAt);
  if (Number.isNaN(until.getTime())) return null;
  const daysBack: Partial<Record<SummaryScopeKind, number>> = {
    today: 0, yesterday: 1, last_7_days: 6, last_30_days: 29, last_90_days: 89,
  };
  if (!scopeKind || scopeKind === 'everything' || scopeKind === 'unread') return null;
  const from = new Date(until);
  from.setDate(from.getDate() - (daysBack[scopeKind] ?? 0));
  return scopeKind === 'yesterday' ? { from, until: from } : { from, until };
}

/**
 * The newest summary version of a conversation. With a reader id, only that
 * reader's own versions count: a summary answers the question its requester
 * typed, and another member's request is theirs alone (owner, Sep 14 2026:
 * "why can I see what my dad asked to be summarized?").
 */
export function latestSummary(
  summaries: ConversationSummary[],
  conversationId: string,
  userId: string | null = null,
): ConversationSummary | undefined {
  const inConversation = summaries.filter((summary) => summary.conversationId === conversationId);
  const mine = userId ? inConversation.filter((summary) => summary.requestedByUserId === userId) : inConversation;
  return mine.sort((left, right) => right.versionNumber - left.versionNumber)[0];
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

/**
 * "Diego: Book the cabin · Friday": the to-do line people read, the person
 * first (the owner's father read "… · you" at the end as a stray word, Sep 14
 * 2026), then what, then when.
 */
export function summaryTodoText(item: SummaryActionItem): string {
  const clean = (part: string | null | undefined) => stripSummarySourceTokens((part ?? '').trim());
  const owner = clean(item.owner);
  const title = clean(item.title);
  const due = clean(item.dueAt);
  const head = owner && title ? `${owner}: ${title}` : owner || title;
  return [head, due].filter(Boolean).join(' · ');
}

/** The text that is copied or written to the shared file. */
export interface SummaryExportInput {
  title: string;
  body: string;
  conversationTitle: string;
  scope: string | null;
  /** "Sep 8 – Sep 14, 2026", already in the reader's language. */
  covers?: string | null;
  /** "Participants: Kyle, Marisol", already labelled. */
  participants?: string | null;
  decisions?: string[];
  todos?: string[];
  headings?: { decisions: string; todo: string };
}

export function summaryExportText(input: SummaryExportInput): string {
  const heading = stripSummarySourceTokens(input.title);
  const meta = [input.conversationTitle.trim(), input.scope?.trim()].filter(Boolean).join(' · ');
  const header = [heading, meta, input.covers?.trim(), input.participants?.trim()].filter(Boolean) as string[];
  const lines = [...header, '', stripSummarySourceTokens(input.body)].filter((line, index) => line || index === header.length);
  const list = (title: string | undefined, items: string[] | undefined) => {
    const clean = (items ?? []).map(stripSummarySourceTokens).filter(Boolean);
    if (!clean.length) return;
    lines.push('', title ?? '', ...clean.map((item) => `• ${item}`));
  };
  list(input.headings?.decisions, input.decisions);
  list(input.headings?.todo, input.todos);
  return lines.join('\n') + '\n';
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string
  ));
}

/**
 * The same summary as a small self-contained HTML document, which is what the
 * PDF (printed by the OS) and the Word file (an HTML-in-.doc, which Word opens
 * natively) are made from. Fonts fall through to whatever the system has for
 * Korean, Spanish and English; nothing is embedded.
 */
export function summaryExportHtml(input: SummaryExportInput): string {
  const heading = stripSummarySourceTokens(input.title);
  const meta = [input.conversationTitle.trim(), input.scope?.trim()].filter(Boolean).join(' · ');
  const bodyLines = stripSummarySourceTokens(input.body).split('\n').map((line) => line.trim()).filter(Boolean);
  const list = (title: string | undefined, items: string[] | undefined) => {
    const clean = (items ?? []).map(stripSummarySourceTokens).filter(Boolean);
    if (!clean.length) return '';
    return `<h2>${escapeHtml(title ?? '')}</h2><ul>${clean.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  };
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + escapeHtml(heading) + '</title>'
    + '<style>body{font-family:-apple-system,"Segoe UI",Roboto,"Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;color:#111;margin:32px;line-height:1.5}'
    + 'h1{font-size:20px;margin:0 0 6px}h2{font-size:13px;margin:18px 0 4px;color:#555;text-transform:uppercase;letter-spacing:.04em}'
    + '.meta{color:#555;font-size:12px;margin:0 0 2px}p{margin:0 0 6px;font-size:14px}ul{margin:0;padding-left:18px}li{font-size:14px;margin:2px 0}</style></head><body>'
    + `<h1>${escapeHtml(heading)}</h1>`
    + (meta ? `<p class="meta">${escapeHtml(meta)}</p>` : '')
    + (input.covers?.trim() ? `<p class="meta">${escapeHtml(input.covers.trim())}</p>` : '')
    + (input.participants?.trim() ? `<p class="meta">${escapeHtml(input.participants.trim())}</p>` : '')
    + '<div style="height:12px"></div>'
    + bodyLines.map((line) => `<p>${escapeHtml(line)}</p>`).join('')
    + list(input.headings?.decisions, input.decisions)
    + list(input.headings?.todo, input.todos)
    + '</body></html>';
}

function localDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "Gist summary – Weekend plans – 2026-09-05.txt", safe for every file system. */
export function summaryFileName(conversationTitle: string, date = new Date(), extension = 'txt'): string {
  const safeTitle = conversationTitle
    .replace(/[\\/:*?"<>| -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim() || 'Conversation';
  return `Gist summary – ${safeTitle} – ${localDate(date)}.${extension}`;
}
