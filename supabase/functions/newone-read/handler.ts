import {
  authenticate,
  type AuthenticatedActor,
  type ClientEnvironment,
  createAdminClient,
  loadClientEnvironment,
} from '../_shared/clients.ts';
import { ApiError, asApiError } from '../_shared/errors.ts';
import {
  accessCredential,
  buildRequestMeta,
  ensureSecureTransport,
  errorResponse,
  jsonResponse,
  loadRuntimeConfig,
  parseJson,
  preflight,
  requestId,
  type RequestMeta,
  type RuntimeConfig,
  verifyCsrf,
} from '../_shared/http.ts';
import {
  type AuthorizationPolicy,
  authorizeRequest,
  enforceRateLimit,
} from '../_shared/security.ts';
import { asRpcClient, invokeRpc } from '../_shared/rpc.ts';
import { signSearchCursor, verifySearchCursor } from '../_shared/cursors.ts';
import {
  asObject,
  bool,
  integer,
  isoDate,
  type JsonObject,
  normalizedString,
  oneOf,
  onlyKeys,
  optionalInteger,
  optionalString,
  optionalUuid,
  requiredUuid,
  uuid,
} from '../_shared/validation.ts';

const MAX_RESPONSE_BYTES = 2_000_000;

interface ResolvedOrganization {
  organizationId: string;
  principalContext: JsonObject;
}

interface MessageQueryInput {
  organizationId: string;
  conversationId: string;
  beforeMessageId: string | null;
  limit: number;
}

interface BootstrapInput {
  selectedConversationId: string | null;
  beforeMessageId: string | null;
  conversationLimit: number;
  timelineLimit: number;
}

interface SearchInput {
  organizationId: string;
  query: string;
  types: Array<'people' | 'conversations' | 'messages' | 'announcements' | 'handoffs'>;
  cursor: string | null;
  limit: number;
  senderUserId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  matchSources: Array<'original' | 'translation' | 'sender' | 'attachment_filename'> | null;
  conversationId: string | null;
  language: 'ko' | 'es' | 'en' | 'mixed' | 'und' | null;
}

interface AuditQueryInput {
  organizationId: string;
  reasonCode: typeof AUDIT_REASON_CODES[number];
  dateFrom: string;
  dateTo: string;
  eventTypes: string[];
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  cursor: string | null;
  limit: number;
}

const SEARCH_TYPES = [
  'people',
  'conversations',
  'messages',
  'announcements',
  'handoffs',
] as const;

const SEARCH_MATCH_SOURCES = [
  'profile',
  'conversation',
  'original',
  'translation',
  'sender',
  'attachment_filename',
  'announcement',
  'handoff',
] as const;

const SEARCH_MESSAGE_MATCH_SOURCES = [
  'original',
  'translation',
  'sender',
  'attachment_filename',
] as const;

const SEARCH_LANGUAGES = ['ko', 'es', 'en', 'mixed', 'und'] as const;
const AUDIT_REASON_CODES = [
  'security_review',
  'compliance_review',
  'incident_investigation',
  'access_review',
] as const;
const AUDIT_EVENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$/;
const AUDIT_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/;

export interface ReadDependencies {
  runtimeConfig: RuntimeConfig;
  clientEnvironment: ClientEnvironment;
  authenticateActor(environment: ClientEnvironment, token: string): Promise<AuthenticatedActor>;
  resolveOrganization(
    actor: AuthenticatedActor,
    requestedOrganizationId: string | null,
  ): Promise<ResolvedOrganization>;
  authorize(
    actor: AuthenticatedActor,
    organizationId: string,
    policy: AuthorizationPolicy,
  ): Promise<unknown>;
  rateLimit(
    request: Request,
    config: RuntimeConfig,
    actor: AuthenticatedActor,
    organizationId: string,
    operation: string,
  ): Promise<void>;
  loadBootstrap(
    actor: AuthenticatedActor,
    resolved: ResolvedOrganization,
    input: BootstrapInput,
  ): Promise<unknown>;
  loadPreferences(actor: AuthenticatedActor, organizationId: string): Promise<unknown>;
  loadMessages(actor: AuthenticatedActor, input: MessageQueryInput): Promise<unknown>;
  loadSearch(actor: AuthenticatedActor, input: SearchInput): Promise<unknown>;
  loadAudit(actor: AuthenticatedActor, input: AuditQueryInput): Promise<unknown>;
  recordAuditDenial(
    actor: AuthenticatedActor,
    organizationId: string,
    operation: 'audit.query',
  ): Promise<void>;
}

function camelize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      camelize(entry),
    ]),
  );
}

async function resolveOrganizationDefault(
  actor: AuthenticatedActor,
  requestedOrganizationId: string | null,
): Promise<ResolvedOrganization> {
  const context = asObject(
    await invokeRpc(asRpcClient(actor.adminClient), 'bff_resolve_principal_context', {
      p_actor_user_id: actor.user.id,
      p_session_id: actor.claims.sessionId,
      p_requested_organization_id: requestedOrganizationId,
    }),
  );
  if (context.schema_version !== 1) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const organizationId = uuid(context.selected_organization_id);
  if (requestedOrganizationId !== null && organizationId !== requestedOrganizationId) {
    throw new ApiError(403, 'forbidden');
  }
  if (!Array.isArray(context.organizations)) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  const selected = context.organizations
    .map((entry) => asObject(entry))
    .find((entry) => entry.organization_id === organizationId);
  if (!selected) throw new ApiError(403, 'forbidden');
  return { organizationId, principalContext: context };
}

async function loadMessagesDefault(
  actor: AuthenticatedActor,
  input: MessageQueryInput,
): Promise<unknown> {
  return camelize(
    await invokeRpc(asRpcClient(actor.adminClient), 'bff_read_conversation_page', {
      p_actor_user_id: actor.user.id,
      p_organization_id: input.organizationId,
      p_session_id: actor.claims.sessionId,
      p_conversation_id: input.conversationId,
      p_before_message_id: input.beforeMessageId,
      p_limit: input.limit,
    }),
  );
}

async function loadBootstrapRpcDefault(
  actor: AuthenticatedActor,
  resolved: ResolvedOrganization,
  input: BootstrapInput,
): Promise<unknown> {
  return camelize(
    await invokeRpc(asRpcClient(actor.adminClient), 'bff_bootstrap_messaging_state', {
      p_actor_user_id: actor.user.id,
      p_organization_id: resolved.organizationId,
      p_session_id: actor.claims.sessionId,
      p_selected_conversation_id: input.selectedConversationId,
      p_before_message_id: input.beforeMessageId,
      p_conversation_limit: input.conversationLimit,
      p_timeline_limit: input.timelineLimit,
    }),
  );
}

async function loadSearchDefault(
  actor: AuthenticatedActor,
  input: SearchInput,
): Promise<unknown> {
  return parseSearchResponse(
    await invokeRpc(asRpcClient(actor.adminClient), 'bff_search', {
      p_actor_user_id: actor.user.id,
      p_organization_id: input.organizationId,
      p_session_id: actor.claims.sessionId,
      p_query: input.query,
      p_types: input.types,
      p_cursor: input.cursor,
      p_limit: input.limit,
      p_sender_user_id: input.senderUserId,
      p_date_from: input.dateFrom,
      p_date_to: input.dateTo,
      p_match_sources: input.matchSources,
      p_conversation_id: input.conversationId,
      p_language: input.language,
    }),
    input.limit,
  );
}

async function loadAuditDefault(
  actor: AuthenticatedActor,
  input: AuditQueryInput,
): Promise<unknown> {
  const value = await invokeRpc(asRpcClient(actor.adminClient), 'bff_query_audit_events', {
    p_actor_user_id: actor.user.id,
    p_organization_id: input.organizationId,
    p_session_id: actor.claims.sessionId,
    p_reason_code: input.reasonCode,
    p_date_from: input.dateFrom,
    p_date_to: input.dateTo,
    p_event_types: input.eventTypes,
    p_filter_actor_user_id: input.actorUserId,
    p_target_type: input.targetType,
    p_target_id: input.targetId,
    p_cursor: input.cursor,
    p_limit: input.limit,
  });
  const root = asObject(value);
  if (root.schema_version === 1 && root.denied === true) {
    onlyKeys(root, ['schema_version', 'denied']);
    throw new ApiError(403, 'forbidden');
  }
  return value;
}

async function recordAuditDenialDefault(
  actor: AuthenticatedActor,
  organizationId: string,
  operation: 'audit.query',
): Promise<void> {
  await invokeRpc(asRpcClient(actor.adminClient), 'bff_record_audit_access_denial', {
    p_actor_user_id: actor.user.id,
    p_organization_id: organizationId,
    p_operation: operation,
  });
}

function auditEventId(value: unknown): string {
  const result = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^[1-9][0-9]{0,18}$/.test(result)) throw new Error('invalid');
  return result;
}

export function parseAuditResponse(value: unknown, limit: number): {
  items: JsonObject[];
  nextCursor: string | null;
  hasMore: boolean;
  snapshotAt: string;
  filterSha256: string;
  receiptId: string;
} {
  try {
    const root = asObject(value);
    onlyKeys(root, [
      'schema_version',
      'items',
      'next_cursor',
      'has_more',
      'snapshot_at',
      'filter_sha256',
      'receipt_id',
    ]);
    if (integer(root.schema_version, 1, 1) !== 1 || !Array.isArray(root.items)) {
      throw new Error('invalid');
    }
    if (root.items.length > limit) throw new Error('invalid');
    let previous: { occurredAt: string; id: bigint } | null = null;
    const items = root.items.map((entry) => {
      const row = asObject(entry);
      onlyKeys(row, [
        'id',
        'actor_user_id',
        'event_type',
        'target_type',
        'target_id',
        'request_id',
        'occurred_at',
        'outcome',
      ]);
      const id = auditEventId(row.id);
      const occurredAt = isoDate(row.occurred_at);
      const numericId = BigInt(id);
      if (
        previous && (
          occurredAt > previous.occurredAt ||
          (occurredAt === previous.occurredAt && numericId >= previous.id)
        )
      ) throw new Error('invalid');
      previous = { occurredAt, id: numericId };
      const eventType = normalizedString(row.event_type, { min: 3, max: 120 }) as string;
      const targetType = normalizedString(row.target_type, { min: 2, max: 80 }) as string;
      if (!AUDIT_EVENT_PATTERN.test(eventType) || !AUDIT_TARGET_PATTERN.test(targetType)) {
        throw new Error('invalid');
      }
      const targetId = normalizedString(row.target_id, { min: 1, max: 240, trim: false }) as string;
      if (/\p{Cc}/u.test(targetId)) throw new Error('invalid');
      return {
        id,
        actorUserId: row.actor_user_id === null ? null : uuid(row.actor_user_id),
        eventType,
        targetType,
        targetId,
        requestId: row.request_id === null ? null : uuid(row.request_id),
        occurredAt,
        outcome: oneOf(row.outcome, ['succeeded', 'denied', 'failed'] as const),
      };
    });
    const hasMore = bool(root.has_more);
    const nextCursor = root.next_cursor === null
      ? null
      : normalizedString(root.next_cursor, { min: 1, max: 1536, trim: false }) as string;
    if (
      hasMore !== (nextCursor !== null) ||
      (nextCursor !== null && !/^[A-Za-z0-9+/]+={0,2}$/.test(nextCursor))
    ) throw new Error('invalid');
    const filterSha256 = normalizedString(root.filter_sha256, { min: 64, max: 64 }) as string;
    if (!/^[0-9a-f]{64}$/.test(filterSha256)) throw new Error('invalid');
    return {
      items,
      nextCursor,
      hasMore,
      snapshotAt: isoDate(root.snapshot_at),
      filterSha256,
      receiptId: uuid(root.receipt_id),
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

function searchResultId(type: typeof SEARCH_TYPES[number], value: unknown): string {
  if (type !== 'messages') return uuid(value);
  return optionalMessageId(value) ?? (() => {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  })();
}

export function parseSearchResponse(value: unknown, limit: number): unknown {
  try {
    const root = asObject(value);
    onlyKeys(root, ['results', 'next_cursor', 'has_more']);
    if (!Array.isArray(root.results) || root.results.length > limit) throw new Error('invalid');
    const seen = new Set<string>();
    let previousSortKey: { occurredAt: string; type: string; id: string } | null = null;
    const results = root.results.map((entry) => {
      const row = asObject(entry);
      onlyKeys(row, [
        'type',
        'id',
        'title',
        'snippet',
        'conversation_id',
        'occurred_at',
        'matched_source',
        'matched_language',
      ]);
      const type = oneOf(row.type, SEARCH_TYPES);
      const matchedSource = oneOf(row.matched_source, SEARCH_MATCH_SOURCES);
      const validSource = (type === 'people' && matchedSource === 'profile') ||
        (type === 'conversations' && matchedSource === 'conversation') ||
        (type === 'messages' && [
          'original',
          'translation',
          'sender',
          'attachment_filename',
        ].includes(matchedSource)) ||
        (type === 'announcements' && matchedSource === 'announcement') ||
        (type === 'handoffs' && matchedSource === 'handoff');
      if (!validSource) throw new Error('invalid');
      const occurredAt = isoDate(row.occurred_at);
      const conversationId = row.conversation_id === null ? null : uuid(row.conversation_id);
      if ((type === 'people') !== (conversationId === null)) throw new Error('invalid');
      const matchedLanguage = row.matched_language === null
        ? null
        : normalizedString(row.matched_language, { min: 2, max: 35 }) as string;
      if (matchedSource === 'translation' && matchedLanguage === null) throw new Error('invalid');
      const id = searchResultId(type, row.id);
      const dedupeKey = `${type}:${id}`;
      if (seen.has(dedupeKey)) throw new Error('invalid');
      seen.add(dedupeKey);
      const sortKey = { occurredAt, type, id };
      if (
        previousSortKey && (
          occurredAt > previousSortKey.occurredAt ||
          (occurredAt === previousSortKey.occurredAt && type > previousSortKey.type) ||
          (occurredAt === previousSortKey.occurredAt && type === previousSortKey.type &&
            id > previousSortKey.id)
        )
      ) throw new Error('invalid');
      previousSortKey = sortKey;
      return {
        type,
        id,
        title: normalizedString(row.title, { min: 1, max: 500 }) as string,
        snippet: normalizedString(row.snippet, { max: 240, trim: false }) as string,
        conversationId,
        occurredAt,
        matchedSource,
        matchedLanguage,
      };
    });
    const hasMore = bool(root.has_more);
    const nextCursor = root.next_cursor === null
      ? null
      : normalizedString(root.next_cursor, { min: 1, max: 1024, trim: false }) as string;
    if (nextCursor !== null && !/^[A-Za-z0-9+/]+={0,2}$/.test(nextCursor)) {
      throw new Error('invalid');
    }
    if (hasMore !== (nextCursor !== null)) throw new Error('invalid');
    return { results, nextCursor, hasMore };
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) throw error;
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

async function loadPreferencesDefault(
  actor: AuthenticatedActor,
  organizationId: string,
): Promise<unknown> {
  return camelize(
    await invokeRpc(asRpcClient(actor.adminClient), 'bff_get_organization_preferences', {
      p_actor_user_id: actor.user.id,
      p_organization_id: organizationId,
      p_session_id: actor.claims.sessionId,
    }),
  );
}

export function defaultReadDependencies(): ReadDependencies {
  return {
    runtimeConfig: loadRuntimeConfig(),
    clientEnvironment: loadClientEnvironment(),
    authenticateActor: authenticate,
    resolveOrganization: resolveOrganizationDefault,
    authorize: authorizeRequest,
    rateLimit: enforceRateLimit,
    loadBootstrap: loadBootstrapRpcDefault,
    loadPreferences: loadPreferencesDefault,
    loadMessages: loadMessagesDefault,
    loadSearch: loadSearchDefault,
    loadAudit: loadAuditDefault,
    recordAuditDenial: recordAuditDenialDefault,
  };
}

function readPath(url: string): string {
  const pathname = new URL(url).pathname;
  const marker = pathname.indexOf('/v2/');
  return marker >= 0 ? pathname.slice(marker) : pathname;
}

function fallbackMeta(request: Request): RequestMeta {
  return { requestId: requestId(request), origin: null, corsHeaders: new Headers() };
}

function boundedResponse(meta: RequestMeta, body: unknown): Response {
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_RESPONSE_BYTES) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return jsonResponse(meta, 200, body);
}

function matchMessages(path: string): string | null {
  const match = /^\/v2\/conversations\/([^/]+)\/messages\/query$/.exec(path);
  if (!match?.[1]) return null;
  try {
    return uuid(decodeURIComponent(match[1]));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'bad_request');
  }
}

function optionalMessageId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' || typeof value === 'string' ? String(value) : '';
  if (!/^[1-9][0-9]{0,18}$/.test(text)) throw new ApiError(400, 'bad_request');
  return text;
}

export function createReadHandler(
  dependencyFactory: () => ReadDependencies = defaultReadDependencies,
): (request: Request) => Promise<Response> {
  let dependencies: ReadDependencies | undefined;
  return async (request: Request): Promise<Response> => {
    let meta = fallbackMeta(request);
    try {
      dependencies ??= dependencyFactory();
      const config = dependencies.runtimeConfig;
      ensureSecureTransport(request, config);
      meta = buildRequestMeta(request, config);
      if (request.method === 'OPTIONS') return preflight(meta);
      if (request.method !== 'POST') throw new ApiError(404, 'not_found');

      const path = readPath(request.url);
      const parsed = asObject((await parseJson(request, config)).value);
      const credential = accessCredential(request, config);
      verifyCsrf(request, config, credential.viaCookie);
      const authenticatedActor = await dependencies.authenticateActor(
        dependencies.clientEnvironment,
        credential.token,
      );
      const actor: AuthenticatedActor = {
        ...authenticatedActor,
        adminClient: createAdminClient(dependencies.clientEnvironment, {
          'X-Request-Id': meta.requestId,
        }),
      };

      if (path === '/v2/bootstrap') {
        onlyKeys(parsed, [
          'organizationId',
          'selectedConversationId',
          'beforeMessageId',
          'conversationLimit',
          'timelineLimit',
        ]);
        const requestedOrganizationId = optionalUuid(parsed, 'organizationId', true) ?? null;
        const selectedConversationId = optionalUuid(parsed, 'selectedConversationId', true) ??
          null;
        const beforeMessageId = optionalMessageId(parsed.beforeMessageId);
        const conversationLimit = optionalInteger(parsed, 'conversationLimit', 1, 100) ?? 100;
        const timelineLimit = optionalInteger(parsed, 'timelineLimit', 1, 100) ?? 50;
        const resolved = await dependencies.resolveOrganization(actor, requestedOrganizationId);
        await dependencies.authorize(actor, resolved.organizationId, {
          operation: 'read.bootstrap',
        });
        await dependencies.rateLimit(
          request,
          config,
          actor,
          resolved.organizationId,
          'read.bootstrap',
        );
        return boundedResponse(
          meta,
          await dependencies.loadBootstrap(actor, resolved, {
            selectedConversationId,
            beforeMessageId,
            conversationLimit,
            timelineLimit,
          }),
        );
      }

      if (path === '/v2/search') {
        onlyKeys(parsed, [
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
        ]);
        const organizationId = requiredUuid(parsed, 'organizationId');
        const query = normalizedString(parsed.query, { min: 2, max: 200 }) as string;
        const types = parsed.types === undefined
          ? [...SEARCH_TYPES]
          : Array.isArray(parsed.types)
          ? parsed.types.map((value) => oneOf(value, SEARCH_TYPES))
          : (() => {
            throw new ApiError(400, 'bad_request');
          })();
        if (
          types.length === 0 || types.length > SEARCH_TYPES.length ||
          new Set(types).size !== types.length
        ) {
          throw new ApiError(400, 'bad_request');
        }
        const externalCursor = optionalString(parsed, 'cursor', {
          min: 1,
          max: 2048,
          nullable: true,
        }) ??
          null;
        const limit = optionalInteger(parsed, 'limit', 1, 50) ?? 20;
        const senderUserId = optionalUuid(parsed, 'senderMembershipId', true) ?? null;
        const dateFrom = parsed.dateFrom === undefined || parsed.dateFrom === null
          ? null
          : isoDate(parsed.dateFrom);
        const dateTo = parsed.dateTo === undefined || parsed.dateTo === null
          ? null
          : isoDate(parsed.dateTo);
        const matchSources = parsed.matchSources === undefined
          ? null
          : Array.isArray(parsed.matchSources)
          ? parsed.matchSources.map((value) => oneOf(value, SEARCH_MESSAGE_MATCH_SOURCES))
          : (() => {
            throw new ApiError(400, 'bad_request');
          })();
        const conversationId = optionalUuid(parsed, 'conversationId', true) ?? null;
        const language = parsed.language === undefined || parsed.language === null
          ? null
          : oneOf(parsed.language, SEARCH_LANGUAGES);
        if (
          (dateFrom !== null && dateTo !== null && (
            dateFrom > dateTo ||
            new Date(dateTo).getTime() - new Date(dateFrom).getTime() >
              10 * 366 * 24 * 60 * 60 * 1000
          )) ||
          (matchSources !== null && (
            matchSources.length === 0 ||
            matchSources.length > SEARCH_MESSAGE_MATCH_SOURCES.length ||
            new Set(matchSources).size !== matchSources.length
          )) ||
          ((matchSources !== null || senderUserId !== null) && (
            types.length !== 1 || types[0] !== 'messages'
          ))
        ) {
          throw new ApiError(400, 'bad_request');
        }
        await dependencies.authorize(actor, organizationId, { operation: 'read.search' });
        await dependencies.rateLimit(
          request,
          config,
          actor,
          organizationId,
          'read.search',
        );
        const cursor = externalCursor === null ? null : (await verifySearchCursor(externalCursor, {
          organizationId,
          actorUserId: actor.user.id,
        }, config.cursorSigningKey)).databaseCursor;
        const loaded = asObject(
          await dependencies.loadSearch(actor, {
            organizationId,
            query,
            types,
            cursor,
            limit,
            senderUserId,
            dateFrom,
            dateTo,
            matchSources,
            conversationId,
            language,
          }),
        );
        onlyKeys(loaded, ['results', 'nextCursor', 'hasMore']);
        if (!Array.isArray(loaded.results) || loaded.results.length > limit) {
          throw new ApiError(503, 'dependency_unavailable', undefined, 5);
        }
        const hasMore = bool(loaded.hasMore);
        const databaseCursor = loaded.nextCursor === null
          ? null
          : normalizedString(loaded.nextCursor, { min: 1, max: 1024, trim: false }) as string;
        if (
          hasMore !== (databaseCursor !== null) ||
          (databaseCursor !== null && !/^[A-Za-z0-9+/]+={0,2}$/.test(databaseCursor))
        ) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
        return boundedResponse(
          meta,
          {
            results: loaded.results,
            nextCursor: databaseCursor === null ? null : await signSearchCursor({
              organizationId,
              actorUserId: actor.user.id,
              databaseCursor,
            }, config.cursorSigningKey),
            hasMore,
          },
        );
      }

      if (path === '/v2/admin/audit/query') {
        onlyKeys(parsed, [
          'organizationId',
          'reasonCode',
          'dateFrom',
          'dateTo',
          'eventTypes',
          'actorMembershipId',
          'targetType',
          'targetId',
          'cursor',
          'limit',
        ]);
        const organizationId = requiredUuid(parsed, 'organizationId');
        const reasonCode = oneOf(parsed.reasonCode, AUDIT_REASON_CODES);
        const dateFrom = isoDate(parsed.dateFrom);
        const dateTo = isoDate(parsed.dateTo);
        const fromMillis = Date.parse(dateFrom);
        const toMillis = Date.parse(dateTo);
        if (
          fromMillis > toMillis ||
          toMillis - fromMillis > 90 * 24 * 60 * 60 * 1000 ||
          fromMillis > Date.now() ||
          toMillis > Date.now() + 5 * 60 * 1000
        ) throw new ApiError(400, 'bad_request');
        const eventTypes = parsed.eventTypes === undefined
          ? []
          : Array.isArray(parsed.eventTypes)
          ? parsed.eventTypes.map((value) =>
            normalizedString(value, { min: 3, max: 120 }) as string
          )
          : (() => {
            throw new ApiError(400, 'bad_request');
          })();
        if (
          eventTypes.length > 10 || new Set(eventTypes).size !== eventTypes.length ||
          eventTypes.some((value) => !AUDIT_EVENT_PATTERN.test(value))
        ) throw new ApiError(400, 'bad_request');
        const actorUserId = optionalUuid(parsed, 'actorMembershipId', true) ?? null;
        const targetType = optionalString(parsed, 'targetType', {
          min: 2,
          max: 80,
          nullable: true,
        }) ?? null;
        const targetId = optionalString(parsed, 'targetId', {
          min: 1,
          max: 240,
          trim: false,
          nullable: true,
        }) ?? null;
        if (
          (targetType !== null && !AUDIT_TARGET_PATTERN.test(targetType)) ||
          (targetId !== null && /\p{Cc}/u.test(targetId))
        ) throw new ApiError(400, 'bad_request');
        const externalCursor = optionalString(parsed, 'cursor', {
          min: 1,
          max: 2048,
          trim: false,
          nullable: true,
        }) ?? null;
        const limit = optionalInteger(parsed, 'limit', 1, 100) ?? 50;
        await dependencies.resolveOrganization(actor, organizationId);
        // Consume the actor/session/network budget before the stronger audit
        // authorization check. Otherwise an AAL1 or stale-session member could
        // create an unbounded stream of append-only denial events.
        await dependencies.rateLimit(request, config, actor, organizationId, 'audit.query');
        try {
          await dependencies.authorize(actor, organizationId, {
            operation: 'audit.query',
            requireAal2: true,
            recentAuthSeconds: 900,
          });
        } catch (error) {
          try {
            await dependencies.recordAuditDenial(actor, organizationId, 'audit.query');
          } catch {
            // Never replace the original denial or leak whether the audit write succeeded.
          }
          throw error;
        }
        const cursor = externalCursor === null ? null : (await verifySearchCursor(
          externalCursor,
          { organizationId, actorUserId: actor.user.id },
          config.cursorSigningKey,
        )).databaseCursor;
        const loaded = parseAuditResponse(
          await dependencies.loadAudit(actor, {
            organizationId,
            reasonCode,
            dateFrom,
            dateTo,
            eventTypes,
            actorUserId,
            targetType,
            targetId,
            cursor,
            limit,
          }),
          limit,
        );
        return boundedResponse(meta, {
          items: loaded.items,
          nextCursor: loaded.nextCursor === null ? null : await signSearchCursor({
            organizationId,
            actorUserId: actor.user.id,
            databaseCursor: loaded.nextCursor,
          }, config.cursorSigningKey),
          hasMore: loaded.hasMore,
          snapshotAt: loaded.snapshotAt,
          filterSha256: loaded.filterSha256,
          receiptId: loaded.receiptId,
        });
      }

      if (path === '/v2/preferences/organization/query') {
        onlyKeys(parsed, ['organizationId']);
        const organizationId = requiredUuid(parsed, 'organizationId');
        await dependencies.authorize(actor, organizationId, {
          operation: 'organization.preferences.read',
        });
        await dependencies.rateLimit(
          request,
          config,
          actor,
          organizationId,
          'organization.preferences.read',
        );
        return boundedResponse(
          meta,
          await dependencies.loadPreferences(actor, organizationId),
        );
      }

      const conversationId = matchMessages(path);
      if (conversationId) {
        onlyKeys(parsed, ['organizationId', 'beforeMessageId', 'limit']);
        const organizationId = requiredUuid(parsed, 'organizationId');
        const beforeMessageId = optionalMessageId(parsed.beforeMessageId);
        const limit = optionalInteger(parsed, 'limit', 1, 100) ?? 50;
        await dependencies.authorize(actor, organizationId, {
          operation: 'read.messages',
        });
        await dependencies.rateLimit(
          request,
          config,
          actor,
          organizationId,
          'read.messages',
        );
        return boundedResponse(
          meta,
          await dependencies.loadMessages(actor, {
            organizationId,
            conversationId,
            beforeMessageId,
            limit,
          }),
        );
      }

      throw new ApiError(404, 'not_found');
    } catch (error) {
      const safe = asApiError(error);
      if (safe.status >= 500) {
        console.error(JSON.stringify({
          event: 'newone_read_failure',
          correlation_id: meta.requestId,
          code: safe.code,
        }));
      }
      return errorResponse(meta, error);
    }
  };
}
