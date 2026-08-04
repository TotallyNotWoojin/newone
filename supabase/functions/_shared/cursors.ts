import { hmacSha256Hex, safeEqual } from './crypto.ts';
import { ApiError } from './errors.ts';
import { asObject, onlyKeys, uuid } from './validation.ts';

export type MessageCursorDirection = 'older' | 'newer';

export interface MessageCursorPayload {
  version: 1;
  organizationId: string;
  conversationId: string;
  boundaryMessageId: string;
  direction: MessageCursorDirection;
  expiresAt: number;
}

export interface SearchCursorPayload {
  version: 1;
  organizationId: string;
  actorUserId: string;
  databaseCursor: string;
  expiresAt: number;
}

export interface ConversationMemberCandidateCursorPayload {
  version: 1;
  organizationId: string;
  actorUserId: string;
  conversationId: string;
  normalizedQuery: string;
  pageSize: number;
  databaseCursor: string;
  expiresAt: number;
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    throw new ApiError(400, 'bad_request');
  }
}

function cursorKey(env: Pick<typeof Deno.env, 'get'>): string {
  const key = env.get('NEWONE_CURSOR_SIGNING_KEY') ?? '';
  if (key.length < 32) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  return key;
}

function messageId(value: unknown): string {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ApiError(400, 'bad_request');
  return text;
}

function configuredSigningKey(value: string | undefined): string {
  const key = value ?? '';
  if (key.length < 32 || key.length > 4096 || /[\r\n\0]/.test(key)) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return key;
}

function databaseSearchCursor(value: unknown): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) throw new ApiError(400, 'bad_request');
  return value;
}

function databaseConversationMemberCandidateCursor(value: unknown): string {
  if (
    typeof value !== 'string' || value.length < 1 || value.length > 1536 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) throw new ApiError(400, 'bad_request');
  return value;
}

function conversationMemberCandidateQuery(value: unknown): string {
  if (typeof value !== 'string' || value.length > 120) {
    throw new ApiError(400, 'bad_request');
  }
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function conversationMemberCandidatePageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new ApiError(400, 'bad_request');
  }
  return value;
}

export async function signMessageCursor(
  input: {
    organizationId: string;
    conversationId: string;
    boundaryMessageId: string;
    direction: MessageCursorDirection;
  },
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): Promise<string> {
  const payload: MessageCursorPayload = {
    version: 1,
    organizationId: uuid(input.organizationId),
    conversationId: uuid(input.conversationId),
    boundaryMessageId: messageId(input.boundaryMessageId),
    direction: input.direction,
    expiresAt: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${await hmacSha256Hex(cursorKey(env), encoded)}`;
}

export async function verifyMessageCursor(
  value: string,
  expected: { organizationId: string; conversationId: string },
  env: Pick<typeof Deno.env, 'get'> = Deno.env,
): Promise<MessageCursorPayload> {
  if (value.length > 1024) throw new ApiError(400, 'bad_request');
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra || !/^[0-9a-f]{64}$/.test(signature)) {
    throw new ApiError(400, 'bad_request');
  }
  const expectedSignature = await hmacSha256Hex(cursorKey(env), encoded);
  if (!safeEqual(signature, expectedSignature)) throw new ApiError(400, 'bad_request');
  let row: Record<string, unknown>;
  try {
    row = asObject(JSON.parse(decodeBase64Url(encoded)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'bad_request');
  }
  onlyKeys(row, [
    'version',
    'organizationId',
    'conversationId',
    'boundaryMessageId',
    'direction',
    'expiresAt',
  ]);
  const payload: MessageCursorPayload = {
    version: row.version === 1 ? 1 : (() => {
      throw new ApiError(400, 'bad_request');
    })(),
    organizationId: uuid(row.organizationId),
    conversationId: uuid(row.conversationId),
    boundaryMessageId: messageId(row.boundaryMessageId),
    direction: row.direction === 'older' || row.direction === 'newer' ? row.direction : (() => {
      throw new ApiError(400, 'bad_request');
    })(),
    expiresAt: typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt)
      ? row.expiresAt
      : 0,
  };
  if (
    payload.organizationId !== uuid(expected.organizationId) ||
    payload.conversationId !== uuid(expected.conversationId) ||
    payload.expiresAt <= Math.floor(Date.now() / 1000)
  ) throw new ApiError(400, 'bad_request');
  return payload;
}

export async function signSearchCursor(
  input: {
    organizationId: string;
    actorUserId: string;
    databaseCursor: string;
  },
  signingKey: string | undefined,
): Promise<string> {
  const payload: SearchCursorPayload = {
    version: 1,
    organizationId: uuid(input.organizationId),
    actorUserId: uuid(input.actorUserId),
    databaseCursor: databaseSearchCursor(input.databaseCursor),
    expiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${await hmacSha256Hex(configuredSigningKey(signingKey), encoded)}`;
}

export async function verifySearchCursor(
  value: string,
  expected: { organizationId: string; actorUserId: string },
  signingKey: string | undefined,
): Promise<SearchCursorPayload> {
  if (value.length > 2048) throw new ApiError(400, 'bad_request');
  const [encoded, signature, extra] = value.split('.');
  if (
    !encoded || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) throw new ApiError(400, 'bad_request');
  const expectedSignature = await hmacSha256Hex(configuredSigningKey(signingKey), encoded);
  if (!safeEqual(signature, expectedSignature)) throw new ApiError(400, 'bad_request');
  let row: Record<string, unknown>;
  try {
    row = asObject(JSON.parse(decodeBase64Url(encoded)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'bad_request');
  }
  onlyKeys(row, [
    'version',
    'organizationId',
    'actorUserId',
    'databaseCursor',
    'expiresAt',
  ]);
  const payload: SearchCursorPayload = {
    version: row.version === 1 ? 1 : (() => {
      throw new ApiError(400, 'bad_request');
    })(),
    organizationId: uuid(row.organizationId),
    actorUserId: uuid(row.actorUserId),
    databaseCursor: databaseSearchCursor(row.databaseCursor),
    expiresAt: typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt)
      ? row.expiresAt
      : 0,
  };
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.organizationId !== uuid(expected.organizationId) ||
    payload.actorUserId !== uuid(expected.actorUserId) ||
    payload.expiresAt <= now || payload.expiresAt > now + 15 * 60 + 5
  ) throw new ApiError(400, 'bad_request');
  return payload;
}

export async function signConversationMemberCandidateCursor(
  input: {
    organizationId: string;
    actorUserId: string;
    conversationId: string;
    query: string;
    pageSize: number;
    databaseCursor: string;
  },
  signingKey: string | undefined,
): Promise<string> {
  const payload: ConversationMemberCandidateCursorPayload = {
    version: 1,
    organizationId: uuid(input.organizationId),
    actorUserId: uuid(input.actorUserId),
    conversationId: uuid(input.conversationId),
    normalizedQuery: conversationMemberCandidateQuery(input.query),
    pageSize: conversationMemberCandidatePageSize(input.pageSize),
    databaseCursor: databaseConversationMemberCandidateCursor(input.databaseCursor),
    expiresAt: Math.floor(Date.now() / 1000) + 15 * 60,
  };
  const encoded = base64Url(JSON.stringify(payload));
  return `${encoded}.${await hmacSha256Hex(configuredSigningKey(signingKey), encoded)}`;
}

export async function verifyConversationMemberCandidateCursor(
  value: string,
  expected: {
    organizationId: string;
    actorUserId: string;
    conversationId: string;
    query: string;
    pageSize: number;
  },
  signingKey: string | undefined,
): Promise<ConversationMemberCandidateCursorPayload> {
  if (value.length > 4096) throw new ApiError(400, 'bad_request');
  const [encoded, signature, extra] = value.split('.');
  if (
    !encoded || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    !/^[0-9a-f]{64}$/.test(signature)
  ) throw new ApiError(400, 'bad_request');
  const expectedSignature = await hmacSha256Hex(configuredSigningKey(signingKey), encoded);
  if (!safeEqual(signature, expectedSignature)) throw new ApiError(400, 'bad_request');
  let row: Record<string, unknown>;
  try {
    row = asObject(JSON.parse(decodeBase64Url(encoded)));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'bad_request');
  }
  onlyKeys(row, [
    'version',
    'organizationId',
    'actorUserId',
    'conversationId',
    'normalizedQuery',
    'pageSize',
    'databaseCursor',
    'expiresAt',
  ]);
  const payload: ConversationMemberCandidateCursorPayload = {
    version: row.version === 1 ? 1 : (() => {
      throw new ApiError(400, 'bad_request');
    })(),
    organizationId: uuid(row.organizationId),
    actorUserId: uuid(row.actorUserId),
    conversationId: uuid(row.conversationId),
    normalizedQuery: conversationMemberCandidateQuery(row.normalizedQuery),
    pageSize: conversationMemberCandidatePageSize(row.pageSize),
    databaseCursor: databaseConversationMemberCandidateCursor(row.databaseCursor),
    expiresAt: typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt)
      ? row.expiresAt
      : 0,
  };
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.organizationId !== uuid(expected.organizationId) ||
    payload.actorUserId !== uuid(expected.actorUserId) ||
    payload.conversationId !== uuid(expected.conversationId) ||
    payload.normalizedQuery !== conversationMemberCandidateQuery(expected.query) ||
    payload.pageSize !== conversationMemberCandidatePageSize(expected.pageSize) ||
    payload.expiresAt <= now || payload.expiresAt > now + 15 * 60 + 5
  ) throw new ApiError(400, 'bad_request');
  return payload;
}
