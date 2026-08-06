import {
  signConversationMemberCandidateCursor,
  signMessageCursor,
  signSearchCursor,
  verifyConversationMemberCandidateCursor,
  verifyMessageCursor,
  verifySearchCursor,
} from '../_shared/cursors.ts';
import { hmacSha256Hex } from '../_shared/crypto.ts';
import { ApiError } from '../_shared/errors.ts';
import { ExpoPushClient, type ExpoPushMessage } from '../_shared/expo-push.ts';
import {
  accessCredential,
  buildRequestMeta,
  ensureSecureTransport,
  loadRuntimeConfig,
  parseCookies,
  parseJson,
  requestId,
  type RuntimeConfig,
} from '../_shared/http.ts';
import {
  parseOpenRouterEmployeeControlPlane,
  verifyOpenRouterEmployeeControlPlane,
} from '../_shared/openrouter-control-plane.ts';
import { assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorUserId = '20000000-0000-4000-8000-000000000002';
const conversationId = '30000000-0000-4000-8000-000000000003';
const otherId = '40000000-0000-4000-8000-000000000004';
const key = 'coverage-cursor-signing-key-that-is-long-enough';
const environment = { get: () => key };

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function signed(value: unknown): Promise<string> {
  const encoded = base64Url(JSON.stringify(value));
  return `${encoded}.${await hmacSha256Hex(key, encoded)}`;
}

async function badCursor(run: () => Promise<unknown>): Promise<void> {
  await assertRejects(
    run,
    (error) => error instanceof ApiError && error.code === 'bad_request',
  );
}

Deno.test('cursor signers reject malformed keys, boundaries, database cursors, queries, and page sizes', async () => {
  await assertRejects(
    () =>
      signMessageCursor({
        organizationId,
        conversationId,
        boundaryMessageId: '1',
        direction: 'older',
      }, { get: () => 'short' }),
    (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
  );
  await badCursor(() =>
    signMessageCursor({
      organizationId,
      conversationId,
      boundaryMessageId: '0',
      direction: 'newer',
    }, environment)
  );

  for (const signingKey of [undefined, 'short', 'x'.repeat(4097), `${'x'.repeat(32)}\n`]) {
    await assertRejects(
      () => signSearchCursor({ organizationId, actorUserId, databaseCursor: 'YWJj' }, signingKey),
      (error) => error instanceof ApiError && error.code === 'dependency_unavailable',
    );
  }
  for (const databaseCursor of ['', 'x'.repeat(1025), '*bad*']) {
    await badCursor(() => signSearchCursor({ organizationId, actorUserId, databaseCursor }, key));
  }

  const candidate = {
    organizationId,
    actorUserId,
    conversationId,
    query: 'coverage',
    pageSize: 20,
    databaseCursor: 'YWJj',
  };
  for (const query of [false, 'x'.repeat(121)] as unknown[]) {
    await badCursor(() =>
      signConversationMemberCandidateCursor({ ...candidate, query: query as string }, key)
    );
  }
  for (const pageSize of ['20', 1.5, 0, 101] as unknown[]) {
    await badCursor(() =>
      signConversationMemberCandidateCursor({ ...candidate, pageSize: pageSize as number }, key)
    );
  }
  for (const databaseCursor of ['', 'x'.repeat(1537), '*bad*']) {
    await badCursor(() =>
      signConversationMemberCandidateCursor({ ...candidate, databaseCursor }, key)
    );
  }
});

Deno.test('message cursor verifier rejects malformed envelopes and every signed payload invariant', async () => {
  const expected = { organizationId, conversationId };
  for (const value of ['x'.repeat(1025), '', 'encoded', 'a.b.c', 'encoded.bad-signature']) {
    await badCursor(() => verifyMessageCursor(value, expected, environment));
  }
  const invalidJson = base64Url('{');
  const invalidJsonSignature = await hmacSha256Hex(key, invalidJson);
  await badCursor(() =>
    verifyMessageCursor(
      `${invalidJson}.${invalidJsonSignature}`,
      expected,
      environment,
    )
  );

  const now = Math.floor(Date.now() / 1000);
  const base = {
    version: 1,
    organizationId,
    conversationId,
    boundaryMessageId: '1',
    direction: 'older',
    expiresAt: now + 60,
  };
  for (
    const payload of [
      { ...base, version: 2 },
      { ...base, direction: 'sideways' },
      { ...base, expiresAt: 'soon' },
      { ...base, expiresAt: now - 1 },
      { ...base, organizationId: actorUserId },
      { ...base, conversationId: actorUserId },
      { ...base, extra: true },
    ]
  ) {
    await badCursor(async () =>
      await verifyMessageCursor(await signed(payload), expected, environment)
    );
  }
});

Deno.test('search and candidate cursor verifiers reject malformed signed payloads and binding drift', async () => {
  const now = Math.floor(Date.now() / 1000);
  const searchBase = {
    version: 1,
    organizationId,
    actorUserId,
    databaseCursor: 'YWJj',
    expiresAt: now + 60,
  };
  const searchExpected = { organizationId, actorUserId };
  for (const value of ['x'.repeat(2049), '', 'encoded', 'a.b.c', '*.bad']) {
    await badCursor(() => verifySearchCursor(value, searchExpected, key));
  }
  for (
    const payload of [
      { ...searchBase, version: 2 },
      { ...searchBase, databaseCursor: '*bad*' },
      { ...searchBase, expiresAt: 'soon' },
      { ...searchBase, expiresAt: now - 1 },
      { ...searchBase, expiresAt: now + 1000 },
      { ...searchBase, organizationId: conversationId },
      { ...searchBase, actorUserId: conversationId },
    ]
  ) {
    await badCursor(async () =>
      await verifySearchCursor(await signed(payload), searchExpected, key)
    );
  }

  const candidateBase = {
    version: 1,
    organizationId,
    actorUserId,
    conversationId,
    normalizedQuery: 'coverage query',
    pageSize: 20,
    databaseCursor: 'YWJj',
    expiresAt: now + 60,
  };
  const candidateExpected = {
    organizationId,
    actorUserId,
    conversationId,
    query: '  COVERAGE   QUERY ',
    pageSize: 20,
  };
  const valid = await verifyConversationMemberCandidateCursor(
    await signed(candidateBase),
    candidateExpected,
    key,
  );
  assertEquals(valid.normalizedQuery, 'coverage query');
  for (const value of ['x'.repeat(4097), '', 'encoded', 'a.b.c', '*.bad']) {
    await badCursor(() => verifyConversationMemberCandidateCursor(value, candidateExpected, key));
  }
  for (
    const payload of [
      { ...candidateBase, version: 2 },
      { ...candidateBase, expiresAt: 'soon' },
      { ...candidateBase, expiresAt: now - 1 },
      { ...candidateBase, expiresAt: now + 1000 },
      { ...candidateBase, organizationId: otherId },
      { ...candidateBase, actorUserId: otherId },
      { ...candidateBase, conversationId: otherId },
      { ...candidateBase, normalizedQuery: 'other' },
      { ...candidateBase, pageSize: 21 },
    ]
  ) {
    await badCursor(async () =>
      await verifyConversationMemberCandidateCursor(await signed(payload), candidateExpected, key)
    );
  }
});

Deno.test('OpenRouter control-plane response parsing rejects malformed pages and policy drift', async () => {
  const workspaceId = '50000000-0000-4000-8000-000000000005';
  const apiKeyHash = 'a'.repeat(64);
  const controls = parseOpenRouterEmployeeControlPlane(
    'coverage-management-key-that-is-long-enough',
    apiKeyHash,
    workspaceId,
  );
  const policy = {
    model: 'qwen/qwen3-235b-a22b-2507',
    providerTag: 'google-vertex/us-south1',
    providerMetadataName: 'Google',
    priceCeilingsUsdPerMillionTokens: { prompt: 0.25, completion: 1 },
  };
  const guardrail = {
    id: otherId,
    name: `Workspace ${workspaceId} Default`,
    workspace_id: workspaceId,
    enforce_zdr_google: true,
    content_filter_builtins: null,
    content_filters: null,
    allowed_models: [policy.model],
    allowed_providers: [policy.providerTag],
    ignored_models: null,
    ignored_providers: null,
  };
  const endpoint = {
    model_id: policy.model,
    tag: policy.providerTag,
    provider_name: policy.providerMetadataName,
    status: 0,
    supports_implicit_caching: false,
    supported_parameters: ['structured_outputs', 'response_format'],
    pricing: { prompt: '0.0000002', completion: '0.0000008' },
  };
  const base = {
    key: {
      data: {
        hash: apiKeyHash,
        workspace_id: workspaceId,
        disabled: false,
        expires_at: null,
        limit_remaining: 10,
      },
    },
    byok: { data: [], total_count: 0 },
    guardrails: { data: [guardrail], total_count: 1 },
    zdr: { data: [endpoint] },
  };
  type Payloads = Record<'key' | 'byok' | 'guardrails' | 'zdr', unknown>;
  const fetcher =
    (payloads: Payloads) => async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes(`/keys/${apiKeyHash}`)) return Response.json(payloads.key);
      if (url.includes('/byok?')) return Response.json(payloads.byok);
      if (url.includes('/guardrails?')) return Response.json(payloads.guardrails);
      return Response.json(payloads.zdr);
    };
  const fails = async (payloads: Payloads, candidatePolicy = policy) => {
    await assertRejects(
      () => verifyOpenRouterEmployeeControlPlane(controls, candidatePolicy, fetcher(payloads)),
      (error) => error instanceof ApiError && error.code === 'provider_unavailable',
    );
  };

  await verifyOpenRouterEmployeeControlPlane(controls, policy, fetcher(base));
  await fails(base, { ...policy, providerTag: '' });
  for (
    const byok of [
      { data: 'invalid', total_count: 0 },
      { data: Array(101).fill({}), total_count: 101 },
      { data: [], total_count: '0' },
      { data: [], total_count: -1 },
      { data: [], total_count: 1 },
    ]
  ) await fails({ ...base, byok });

  for (
    const guardrails of [
      { data: [], total_count: 0 },
      { data: [{ ...guardrail, workspace_id: organizationId }], total_count: 1 },
      { data: [{ ...guardrail, enforce_zdr_google: false }], total_count: 1 },
      { data: [{ ...guardrail, allowed_models: 'invalid' }], total_count: 1 },
      { data: [{ ...guardrail, allowed_models: Array(201).fill('model') }], total_count: 1 },
      { data: [{ ...guardrail, allowed_models: [''] }], total_count: 1 },
      { data: [{ ...guardrail, allowed_models: ['other/model'] }], total_count: 1 },
      { data: [{ ...guardrail, allowed_providers: ['other'] }], total_count: 1 },
      { data: [{ ...guardrail, ignored_models: [policy.model] }], total_count: 1 },
      { data: [{ ...guardrail, ignored_providers: ['google-vertex'] }], total_count: 1 },
      { data: [{ ...guardrail, name: 'Not default' }], total_count: 1 },
      { data: [guardrail, guardrail], total_count: 2 },
    ]
  ) await fails({ ...base, guardrails });

  await fails({ ...base, zdr: { data: 'invalid' } });
  await fails({ ...base, zdr: { data: Array(20001).fill(endpoint) } });
  await fails({ ...base, zdr: { data: [{ ...endpoint, status: 1 }] } });

  const nonOk = async (input: string | URL | Request): Promise<Response> => {
    if (String(input).includes('/guardrails?')) return new Response('no', { status: 503 });
    return fetcher(base)(input);
  };
  await assertRejects(
    () => verifyOpenRouterEmployeeControlPlane(controls, policy, nonOk),
    (error) => error instanceof ApiError && error.code === 'provider_unavailable',
  );
});

Deno.test('Expo client validates transport envelopes and classifies every ticket and receipt outcome', async () => {
  for (const accessToken of ['short', 'x'.repeat(4097), `${'x'.repeat(20)}\n`]) {
    await assertRejects(async () => new ExpoPushClient(accessToken));
  }
  const pushToken = 'ExponentPushToken[coverage-token]';
  const message: ExpoPushMessage = {
    attemptId: '1',
    to: pushToken,
    data: { event_type: 'message.changed' },
    title: 'Coverage',
    body: 'Coverage body',
    sound: 'default',
    channelId: 'newone-default',
    priority: 'high',
    contentAvailable: true,
  };
  const client = (response: Response | Error) =>
    new ExpoPushClient('coverage-expo-token-that-is-long-enough', async () => {
      if (response instanceof Error) throw response;
      return response.clone();
    });
  for (
    const response of [
      new Response('busy', { status: 429 }),
      new Response('down', { status: 503 }),
      new Response('x'.repeat(1_000_001)),
      new Response('{'),
      new Response(JSON.stringify('not-object')),
      new Error('network'),
    ]
  ) {
    await assertRejects(
      () => client(response).submit([message]),
      (error) => error instanceof ApiError && error.code === 'provider_unavailable',
    );
  }
  for (const messages of [[], Array(101).fill(message)]) {
    await assertRejects(() => client(Response.json({ data: [] })).submit(messages));
  }
  for (
    const response of [
      Response.json({ data: [], errors: [{ message: 'provider error' }] }),
      Response.json({ data: 'invalid' }),
      Response.json({ data: [] }),
    ]
  ) await assertRejects(() => client(response).submit([message]));

  const submissions = await client(Response.json({
    data: [
      { status: 'error', details: { error: 'MessageRateExceeded' } },
      { status: 'error', details: { error: 'OtherError' } },
      { status: 'error', details: { error: '*invalid*' } },
    ],
  })).submit([
    message,
    { ...message, attemptId: '2', title: undefined, body: undefined, sound: undefined },
    { ...message, attemptId: '3', channelId: undefined },
  ]);
  assertEquals(submissions.map((entry) => entry.result), [
    'transient_failure',
    'permanent_failure',
    'permanent_failure',
  ]);
  assertEquals(submissions[2]?.errorCode, 'provider_rejected');

  for (const ids of [[], Array(1001).fill('ticket')]) {
    await assertRejects(() => client(Response.json({ data: {} })).receipts(ids));
  }
  await assertRejects(() =>
    client(Response.json({ data: {}, errors: [{ message: 'provider error' }] })).receipts(['one'])
  );
  await assertRejects(() => client(Response.json({ data: 'invalid' })).receipts(['one']));
  const receipts = await client(Response.json({
    data: {
      rate: { status: 'error', details: { error: 'MessageRateExceeded' } },
      other: { status: 'error', details: { error: 'OtherError' } },
      malformed: { status: 'error' },
    },
  })).receipts(['rate', 'other', 'malformed']);
  assertEquals(receipts.map((entry) => entry.result), [
    'pending',
    'permanent_failure',
    'permanent_failure',
  ]);
  assertEquals(receipts[0]?.errorCode, null);
  assertEquals(receipts[2]?.errorCode, 'provider_rejected');
});

Deno.test('HTTP runtime, transport, credential, cookie, and JSON boundaries cover malformed inputs', async () => {
  const base = new Map<string, string>([
    ['NEWONE_ALLOW_HTTP_LOCAL', 'false'],
    ['NEWONE_ALLOWED_WEB_ORIGINS', 'https://app.newone.example'],
    ['NEWONE_NETWORK_HASH_KEY', 'n'.repeat(32)],
  ]);
  const env = (overrides: Record<string, string | undefined>) => ({
    get(name: string): string | undefined {
      return name in overrides ? overrides[name] : base.get(name);
    },
  });
  assertEquals(loadRuntimeConfig(env({})).allowHttpLocal, false);
  for (
    const overrides of [
      { NEWONE_ALLOWED_WEB_ORIGINS: 'not a url' },
      { NEWONE_NETWORK_HASH_KEY: 'short' },
      { NEWONE_NETWORK_HASH_KEY: 'x'.repeat(4097) },
      { NEWONE_WEB_GATEWAY_SHARED_SECRET: 'short' },
      { NEWONE_WEB_GATEWAY_SHARED_SECRET: 'x'.repeat(4097) },
      { NEWONE_WEB_GATEWAY_SHARED_SECRET: `${'x'.repeat(32)}\n` },
    ]
  ) await assertRejects(async () => loadRuntimeConfig(env(overrides)));

  const supplied = 'ABCDEF12-3456-4789-ABCD-EF1234567890';
  assertEquals(
    requestId(
      new Request('https://app.newone.example', {
        headers: { 'X-Correlation-Id': supplied },
      }),
    ),
    supplied.toLowerCase(),
  );
  for (const host of ['localhost', '127.0.0.1']) {
    ensureSecureTransport(new Request(`http://${host}/v2/health`), { allowHttpLocal: true });
  }
  await assertRejects(async () =>
    ensureSecureTransport(new Request('http://[::1]/v2/health'), { allowHttpLocal: true })
  );
  await assertRejects(async () =>
    ensureSecureTransport(
      new Request('http://project.supabase.co/v2/health', {
        headers: { 'X-Forwarded-Proto': 'https' },
      }),
      { allowHttpLocal: false },
      { get: () => 'not a url' },
    )
  );

  const config: RuntimeConfig = {
    allowedOrigins: new Set(['https://app.newone.example']),
    accessCookieName: '__Host-newone_access',
    refreshCookieName: '__Host-newone_refresh',
    csrfCookieName: '__Host-newone_csrf',
    maxJsonBytes: 16,
    networkHashKey: 'n'.repeat(32),
    allowHttpLocal: false,
  };
  await assertRejects(async () =>
    buildRequestMeta(
      new Request('https://app.newone.example', {
        headers: { Origin: 'not a url' },
      }),
      config,
    )
  );
  const cookies = parseCookies(
    new Request('https://app.newone.example', {
      headers: { Cookie: 'ignored; valid=value; =also-ignored' },
    }),
  );
  assertEquals(cookies.get('valid'), 'value');
  await assertRejects(async () =>
    parseCookies(
      new Request('https://app.newone.example', {
        headers: { Cookie: 'bad=%E0%A4%A' },
      }),
    )
  );
  const credentialHeaders: HeadersInit[] = [
    {},
    { Authorization: 'Basic token' },
    {
      Authorization: 'Bearer bearer-token',
      Cookie: `${config.accessCookieName}=cookie-token`,
    },
    { Authorization: `Bearer ${'x'.repeat(8193)}` },
  ];
  for (const headers of credentialHeaders) {
    await assertRejects(async () =>
      accessCredential(new Request('https://app.newone.example', { headers }), config)
    );
  }
  assertEquals(
    accessCredential(
      new Request('https://app.newone.example', {
        headers: { Cookie: `${config.accessCookieName}=cookie-token` },
      }),
      config,
    ),
    { token: 'cookie-token', viaCookie: true },
  );

  const jsonRequest = (body: BodyInit | null, headers: HeadersInit = {}) =>
    new Request('https://app.newone.example', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
  await assertRejects(() => parseJson(jsonRequest('{}', { 'Content-Encoding': 'gzip' }), config));
  await assertRejects(() => parseJson(jsonRequest(null), config));
  await assertRejects(() => parseJson(jsonRequest('{'), config));
  await assertRejects(() =>
    parseJson(jsonRequest(JSON.stringify({ oversized: 'x'.repeat(30) })), config)
  );
});
