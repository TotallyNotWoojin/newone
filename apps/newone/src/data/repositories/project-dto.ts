import type {
  ConversationProject,
  ConversationProjects,
  KeywordFindResult,
  ProjectCommandResult,
  ProjectItem,
  ProjectItemKind,
  SummaryRangeReadiness,
  SummaryReadiness,
  SummaryView,
} from '@/data/repositories/contracts';
import { RepositoryError } from '@/data/repositories/contracts';
import type { SummaryScopeKind } from '@/domain/types';

type JsonRecord = Record<string, unknown>;

function invalid(label: string): never {
  throw new RepositoryError(`The service returned an invalid ${label}.`, 'invalid_response', true);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value as JsonRecord;
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) invalid(label);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return invalid(label);
}

function optionalText(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function date(value: unknown, label: string): string {
  const stamp = text(value, label);
  if (Number.isNaN(Date.parse(stamp))) invalid(label);
  return stamp;
}

function count(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid(label);
  return parsed;
}

const ITEM_KINDS: readonly ProjectItemKind[] = ['summary', 'upload', 'link'];
const MEDIA_KINDS = ['image', 'video', 'voice', 'file'] as const;

function itemKind(value: unknown): ProjectItemKind {
  const kind = ITEM_KINDS.find((entry) => entry === value);
  return kind ?? invalid('project item kind');
}

function projectFromDto(value: unknown): ConversationProject {
  const row = record(value, 'project');
  return {
    id: text(row.projectId, 'project'),
    name: text(row.name, 'project name'),
    createdByUserId: text(row.createdByUserId, 'project creator'),
    createdAt: date(row.createdAt, 'project time'),
  };
}

/** Only a signed https link is ever shown, so a rogue payload cannot point anywhere else. */
function httpsOnly(value: unknown): string | null {
  const url = optionalText(value);
  return url?.startsWith('https://') ? url : null;
}

function itemFromDto(value: unknown): ProjectItem | null {
  const row = record(value, 'project item');
  const kind = itemKind(row.kind);
  const base = {
    id: text(row.itemId, 'project item'),
    projectId: text(row.projectId, 'project item project'),
    kind,
    title: optionalText(row.title),
    addedByUserId: text(row.addedByUserId, 'project item author'),
    createdAt: date(row.createdAt, 'project item time'),
    senderId: optionalText(row.senderUserId),
    senderName: optionalText(row.senderDisplayName) ?? '',
    summary: null,
    upload: null,
    link: null,
  } satisfies ProjectItem;
  if (kind === 'summary') {
    const state = row.summaryState === 'ready' || row.summaryState === 'pending' ? row.summaryState : null;
    // A recap that failed or went stale leaves the drawer; nothing to show.
    if (!state) return null;
    return {
      ...base,
      summary: {
        summaryId: text(row.summaryId, 'project summary'),
        state,
        topic: optionalText(row.summaryTopic),
        language: optionalText(row.summaryLanguage),
        createdAt: date(row.summaryCreatedAt, 'project summary time'),
      },
    };
  }
  if (kind === 'upload') {
    const mediaKind = MEDIA_KINDS.find((entry) => entry === row.mediaKind) ?? 'file';
    return {
      ...base,
      upload: {
        attachmentId: text(row.attachmentId, 'project upload'),
        messageId: text(row.messageId, 'project upload message'),
        fileName: optionalText(row.fileName) ?? '',
        mimeType: optionalText(row.mimeType) ?? 'application/octet-stream',
        byteSize: count(row.byteSize ?? 0, 'project upload size'),
        mediaKind,
        previewUrl: httpsOnly(row.previewUrl),
      },
    };
  }
  const url = httpsOnly(row.url);
  if (!url) invalid('project link');
  return {
    ...base,
    link: { url, messageId: text(row.messageId, 'project link message') },
  };
}

export function conversationProjectsFromDto(payload: unknown, conversationId: string): ConversationProjects {
  const body = record(payload, 'project list');
  if (body.schemaVersion !== 1 || body.conversationId !== conversationId) invalid('project list');
  const projects = list(body.projects, 'project list').map(projectFromDto);
  const known = new Set(projects.map((project) => project.id));
  const items = list(body.items, 'project items')
    .map(itemFromDto)
    .filter((item): item is ProjectItem => item !== null && known.has(item.projectId));
  const selected = optionalText(body.selectedProjectId);
  return {
    conversationId,
    selectedProjectId: selected && known.has(selected) ? selected : null,
    projects,
    items,
  };
}

export function projectCommandResultFromDto(payload: unknown): ProjectCommandResult {
  const body = record(payload, 'project command');
  return {
    projectId: optionalText(body.projectId),
    itemId: optionalText(body.itemId),
    selectedProjectId: optionalText(body.selectedProjectId),
  };
}

const RANGE_KINDS: readonly SummaryScopeKind[] = [
  'unread', 'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'everything',
];

const SUMMARY_VIEW_MAX_LINES = 400;

export function summaryViewFromDto(payload: unknown): SummaryView {
  const value = record(payload, 'summary');
  const strings = (entries: unknown, label: string) => {
    const items = list(entries, label);
    if (items.length > SUMMARY_VIEW_MAX_LINES) invalid(label);
    return items.map((entry) => {
      if (typeof entry !== 'string') invalid(label);
      return entry;
    });
  };
  if (value.covers !== null && value.covers !== undefined && typeof value.covers !== 'string') invalid('summary');
  return {
    title: text(value.title, 'summary title'),
    covers: typeof value.covers === 'string' && value.covers.length > 0 ? value.covers : null,
    participants: strings(value.participants, 'summary participants'),
    lines: strings(value.lines, 'summary lines'),
    createdAt: date(value.createdAt, 'summary date'),
  };
}

export function summaryReadinessFromDto(payload: unknown, conversationId: string): SummaryReadiness {
  const body = record(payload, 'summary readiness');
  if (body.schemaVersion !== 1 || body.conversationId !== conversationId) invalid('summary readiness');
  const ranges = record(body.ranges, 'summary readiness');
  const parsed = {} as Record<SummaryScopeKind, SummaryRangeReadiness>;
  for (const kind of RANGE_KINDS) {
    // The gateway camel-cases every key it passes on, and a digit stops it
    // halfway: last_7_days arrives as "last_7Days" (web suite, Sep 23 2026).
    const camel = kind.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const range = record(ranges[kind] ?? ranges[camel], 'summary readiness');
    parsed[kind] = {
      messages: count(range.messages, 'summary readiness'),
      characters: count(range.characters, 'summary readiness'),
      ready: range.ready === true,
      tooLong: range.tooLong === true,
    };
  }
  return {
    conversationId,
    minimumMessages: count(body.minimumMessages, 'summary readiness'),
    minimumCharacters: count(body.minimumCharacters, 'summary readiness'),
    ranges: parsed,
  };
}

export function keywordFindFromDto(payload: unknown, limit: number): KeywordFindResult[] {
  const body = record(payload, 'find results');
  const results = list(body.results, 'find results');
  if (body.schemaVersion !== 1 || results.length > limit) invalid('find results');
  return results.map((value) => {
    const row = record(value, 'find result');
    return {
      conversationId: text(row.conversationId, 'find result'),
      messageCount: count(row.messageCount ?? 0, 'find result count'),
      latestMessageId: optionalText(row.latestMessageId),
      latestMessageAt: optionalText(row.latestMessageAt),
      snippet: optionalText(row.snippet),
      projects: list(row.projects ?? [], 'find result projects').map((entry) => {
        const project = record(entry, 'find result project');
        return { projectId: text(project.projectId, 'find result project'), name: text(project.name, 'find result project') };
      }),
      items: list(row.items ?? [], 'find result items').map((entry) => {
        const item = record(entry, 'find result item');
        return {
          projectId: text(item.projectId, 'find result item'),
          projectName: text(item.projectName, 'find result item'),
          kind: itemKind(item.kind),
          title: text(item.title, 'find result item'),
        };
      }),
    };
  });
}
