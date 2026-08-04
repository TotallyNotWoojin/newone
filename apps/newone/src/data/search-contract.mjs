const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MESSAGE_ID_PATTERN = /^[1-9][0-9]{0,18}$/;
const SIGNED_CURSOR_PATTERN = /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/;

export const searchResultTypes = Object.freeze([
  'people',
  'conversations',
  'messages',
  'announcements',
  'handoffs',
]);

export const searchMatchSources = Object.freeze([
  'profile',
  'conversation',
  'original',
  'translation',
  'sender',
  'attachment_filename',
  'announcement',
  'handoff',
]);

export const searchMessageMatchSources = Object.freeze([
  'original',
  'translation',
  'sender',
  'attachment_filename',
]);

export const searchLanguages = Object.freeze(['ko', 'es', 'en', 'mixed', 'und']);

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function onlyKeys(value, keys, label) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TypeError(`Invalid ${label}.`);
  }
}

function boundedString(value, { min = 0, max, trim = false }, label) {
  if (typeof value !== 'string') throw new TypeError(`Invalid ${label}.`);
  const normalized = trim ? value.trim() : value;
  if (normalized.length < min || normalized.length > max || /\0/.test(normalized)) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return normalized;
}

function uuid(value, label) {
  const text = boundedString(value, { min: 36, max: 36, trim: false }, label);
  if (!UUID_PATTERN.test(text)) throw new TypeError(`Invalid ${label}.`);
  return text.toLowerCase();
}

function isoDate(value, label) {
  const text = boundedString(value, { min: 20, max: 40, trim: false }, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`Invalid ${label}.`);
  return new Date(milliseconds).toISOString();
}

function enumList(value, allowed, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length) {
    throw new TypeError(`Invalid ${label}.`);
  }
  const items = value.map((item) => {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      throw new TypeError(`Invalid ${label}.`);
    }
    return item;
  });
  if (new Set(items).size !== items.length) throw new TypeError(`Invalid ${label}.`);
  return items;
}

function signedCursor(value, nullable, label) {
  if (nullable && (value === null || value === undefined)) return null;
  const text = boundedString(value, { min: 66, max: 2048, trim: false }, label);
  if (!SIGNED_CURSOR_PATTERN.test(text)) throw new TypeError(`Invalid ${label}.`);
  return text;
}

export function normalizeSearchRequest(value) {
  const input = record(value, 'search request');
  onlyKeys(input, [
    'organizationId',
    'query',
    'types',
    'cursor',
    'limit',
    'senderMembershipId',
    'dateFrom',
    'dateTo',
    'matchSources',
    'conversationId',
    'language',
  ], 'search request');
  const organizationId = uuid(input.organizationId, 'organization');
  const query = boundedString(input.query, { min: 2, max: 200, trim: true }, 'query');
  const types = input.types === undefined
    ? undefined
    : enumList(input.types, searchResultTypes, 'result types');
  const cursor = signedCursor(input.cursor, true, 'cursor');
  const limit = input.limit === undefined ? 20 : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Invalid search limit.');
  }
  const senderMembershipId = input.senderMembershipId === undefined ||
      input.senderMembershipId === null
    ? null
    : uuid(input.senderMembershipId, 'sender');
  const dateFrom = input.dateFrom === undefined || input.dateFrom === null
    ? null
    : isoDate(input.dateFrom, 'start date');
  const dateTo = input.dateTo === undefined || input.dateTo === null
    ? null
    : isoDate(input.dateTo, 'end date');
  const matchSources = input.matchSources === undefined || input.matchSources === null
    ? null
    : enumList(input.matchSources, searchMessageMatchSources, 'message match sources');
  const conversationId = input.conversationId === undefined || input.conversationId === null
    ? null
    : uuid(input.conversationId, 'conversation');
  const language = input.language === undefined || input.language === null
    ? null
    : (() => {
      if (typeof input.language !== 'string' || !searchLanguages.includes(input.language)) {
        throw new TypeError('Invalid search language.');
      }
      return input.language;
    })();
  if (
    dateFrom !== null && dateTo !== null && (
      dateFrom > dateTo ||
      Date.parse(dateTo) - Date.parse(dateFrom) > 10 * 366 * 24 * 60 * 60 * 1000
    )
  ) throw new TypeError('Invalid search date range.');
  if (
    (senderMembershipId !== null || matchSources !== null) &&
    (types?.length !== 1 || types[0] !== 'messages')
  ) throw new TypeError('Message filters require the message result type.');
  return {
    organizationId,
    query,
    types,
    cursor,
    limit,
    senderMembershipId,
    dateFrom,
    dateTo,
    matchSources,
    conversationId,
    language,
  };
}

const sourceByType = Object.freeze({
  people: new Set(['profile']),
  conversations: new Set(['conversation']),
  messages: new Set(['original', 'translation', 'sender', 'attachment_filename']),
  announcements: new Set(['announcement']),
  handoffs: new Set(['handoff']),
});

function parseResult(value) {
  const row = record(value, 'search result');
  onlyKeys(row, [
    'type',
    'id',
    'title',
    'snippet',
    'conversationId',
    'occurredAt',
    'matchedSource',
    'matchedLanguage',
  ], 'search result');
  if (typeof row.type !== 'string' || !searchResultTypes.includes(row.type)) {
    throw new TypeError('Invalid search result type.');
  }
  if (typeof row.matchedSource !== 'string' || !sourceByType[row.type].has(row.matchedSource)) {
    throw new TypeError('Invalid search match source.');
  }
  const id = row.type === 'messages'
    ? boundedString(row.id, { min: 1, max: 19, trim: false }, 'message result id')
    : uuid(row.id, 'result id');
  if (row.type === 'messages' && !MESSAGE_ID_PATTERN.test(id)) {
    throw new TypeError('Invalid message result id.');
  }
  const conversationId = row.conversationId === null
    ? null
    : uuid(row.conversationId, 'result conversation');
  if ((row.type === 'people') !== (conversationId === null)) {
    throw new TypeError('Invalid result conversation binding.');
  }
  const matchedLanguage = row.matchedLanguage === null
    ? null
    : boundedString(row.matchedLanguage, { min: 2, max: 35, trim: true }, 'match language');
  if (row.matchedSource === 'translation' && matchedLanguage === null) {
    throw new TypeError('Translation results require a language.');
  }
  return {
    type: row.type,
    id,
    title: boundedString(row.title, { min: 1, max: 500, trim: false }, 'result title'),
    snippet: boundedString(row.snippet, { min: 0, max: 240, trim: false }, 'result snippet'),
    conversationId,
    occurredAt: isoDate(row.occurredAt, 'result time'),
    matchedSource: row.matchedSource,
    matchedLanguage,
  };
}

export function parseSearchPage(value, limit = 20) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError('Invalid search page limit.');
  }
  const page = record(value, 'search page');
  onlyKeys(page, ['results', 'nextCursor', 'hasMore'], 'search page');
  if (!Array.isArray(page.results) || page.results.length > limit) {
    throw new TypeError('Invalid search result list.');
  }
  const seen = new Set();
  let previous = null;
  const results = page.results.map((entry) => {
    const result = parseResult(entry);
    const identity = `${result.type}:${result.id}`;
    if (seen.has(identity)) throw new TypeError('Duplicate search result.');
    seen.add(identity);
    if (
      previous && (
        result.occurredAt > previous.occurredAt ||
        (result.occurredAt === previous.occurredAt && result.type > previous.type) ||
        (result.occurredAt === previous.occurredAt && result.type === previous.type &&
          result.id > previous.id)
      )
    ) throw new TypeError('Unstable search result order.');
    previous = result;
    return result;
  });
  if (typeof page.hasMore !== 'boolean') throw new TypeError('Invalid search continuation state.');
  const nextCursor = signedCursor(page.nextCursor, true, 'next cursor');
  if (page.hasMore !== (nextCursor !== null)) {
    throw new TypeError('Invalid search continuation state.');
  }
  return { results, nextCursor, hasMore: page.hasMore };
}

export function mergeSearchResults(current, incoming) {
  if (!Array.isArray(current) || !Array.isArray(incoming)) {
    throw new TypeError('Invalid search results.');
  }
  const identities = new Set(current.map((result) => `${result.type}:${result.id}`));
  return [
    ...current,
    ...incoming.filter((result) => {
      const identity = `${result.type}:${result.id}`;
      if (identities.has(identity)) return false;
      identities.add(identity);
      return true;
    }),
  ];
}

export function searchDateBoundary(value, boundary) {
  if (value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError('Invalid calendar date.');
  }
  const [year, month, day] = value.split('-').map(Number);
  const end = boundary === 'end';
  if (boundary !== 'start' && boundary !== 'end') {
    throw new TypeError('Invalid date boundary.');
  }
  const date = new Date(
    year,
    month - 1,
    day,
    end ? 23 : 0,
    end ? 59 : 0,
    end ? 59 : 0,
    end ? 999 : 0,
  );
  if (
    date.getFullYear() !== year || date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) throw new TypeError('Invalid calendar date.');
  return date.toISOString();
}
