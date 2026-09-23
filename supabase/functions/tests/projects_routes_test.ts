import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError, fromDatabaseError } from '../_shared/errors.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import {
  createReadHandler,
  defaultReadDependencies,
  type ReadDependencies,
} from '../newone-read/handler.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const projectId = '30000000-0000-4000-8000-000000000003';
const itemId = '40000000-0000-4000-8000-000000000004';
const summaryId = '50000000-0000-4000-8000-000000000005';
const attachmentId = '60000000-0000-4000-8000-000000000006';
const commandPath = `/v2/conversations/${conversationId}/projects/commands`;

const badRequest = (error: unknown) => error instanceof ApiError && error.status === 400;

function commandRoute() {
  const route = matchRoute('POST', commandPath);
  assert(route);
  return route;
}

Deno.test('project commands take exactly the fields their action needs', () => {
  const route = commandRoute();
  assertEquals(route.kind, 'project.command');
  assertEquals(
    parseCommand(route, { organizationId, action: 'create', name: '  HDG ' }).values,
    { conversationId, action: 'create', projectId: null, itemId: null, name: 'HDG', target: null },
  );
  assertEquals(
    parseCommand(route, { organizationId, action: 'select', projectId: null }).values.projectId,
    null,
  );
  assertEquals(
    parseCommand(route, { organizationId, action: 'rename_item', itemId, name: 'Acid summary #1' }).values,
    {
      conversationId,
      action: 'rename_item',
      projectId: null,
      itemId,
      name: 'Acid summary #1',
      target: null,
    },
  );
  assertEquals(
    parseCommand(route, {
      organizationId,
      action: 'add_item',
      projectId,
      target: { kind: 'link', messageId: '42', url: 'www.newoneinc.com' },
    }).values.target,
    { kind: 'link', messageId: '42', url: 'www.newoneinc.com' },
  );
  assertEquals(
    parseCommand(route, {
      organizationId,
      action: 'add_item',
      projectId,
      target: { kind: 'upload', attachmentId },
    }).values.target,
    { kind: 'upload', attachmentId },
  );
});

Deno.test('project commands refuse fields their action does not use', async () => {
  const route = commandRoute();
  const refused: Record<string, unknown>[] = [
    { organizationId, action: 'archive' },
    { organizationId, action: 'create' },
    { organizationId, action: 'create', name: '' },
    { organizationId, action: 'create', name: 'x'.repeat(61) },
    { organizationId, action: 'create', name: 'HDG', projectId },
    { organizationId, action: 'rename', name: 'HDG' },
    { organizationId, action: 'delete', projectId, name: 'HDG' },
    { organizationId, action: 'select' },
    { organizationId, action: 'remove_item', projectId },
    { organizationId, action: 'rename_item', itemId, name: 'x'.repeat(121) },
    { organizationId, action: 'add_item', projectId },
    { organizationId, action: 'add_item', projectId, target: { kind: 'summary' } },
    { organizationId, action: 'add_item', projectId, target: { kind: 'summary', summaryId, url: 'x' } },
    { organizationId, action: 'add_item', projectId, target: { kind: 'link', messageId: 'abc' } },
    { organizationId, action: 'delete', projectId, target: { kind: 'upload', attachmentId } },
    { organizationId, action: 'create', name: 'HDG', unexpected: true },
  ];
  for (const body of refused) {
    await assertRejects(() => parseCommand(route, body), badRequest, JSON.stringify(body));
  }
});

Deno.test('project commands call the one project RPC with every argument', async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const actor = {
    user: { id: '70000000-0000-4000-8000-000000000007' },
    claims: {
      sub: '70000000-0000-4000-8000-000000000007',
      sessionId: '80000000-0000-4000-8000-000000000008',
      aal: 'aal1',
      issuedAt: 1,
      expiresAt: 9999999999,
    },
    token: 'token',
    userClient: {},
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: { conversation_id: conversationId, action: 'add_item', project_id: projectId, item_id: itemId, selected_project_id: projectId },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const route = commandRoute();
  const result = await executeCommand(
    route,
    parseCommand(route, {
      organizationId,
      action: 'add_item',
      projectId,
      target: { kind: 'summary', summaryId },
    }),
    actor,
    'project-key',
    'a'.repeat(64),
  );
  assertEquals(result.status, 200);
  assertEquals(result.body, {
    conversationId,
    action: 'add_item',
    projectId,
    itemId,
    selectedProjectId: projectId,
  });
  assertEquals(calls.map((call) => call.name), ['bff_conversation_project_command']);
  assertEquals(calls[0]?.args, {
    p_actor_user_id: '70000000-0000-4000-8000-000000000007',
    p_organization_id: organizationId,
    p_session_id: '80000000-0000-4000-8000-000000000008',
    p_idempotency_key: 'project-key',
    p_request_sha256: 'a'.repeat(64),
    p_conversation_id: conversationId,
    p_action: 'add_item',
    p_project_id: projectId,
    p_item_id: null,
    p_name: null,
    p_target: { kind: 'summary', summaryId },
  });
});

Deno.test('database refusals from projects and summaries map to client codes', () => {
  const missing = fromDatabaseError({ code: 'P0002', message: 'project not found' });
  assertEquals([missing.status, missing.code], [404, 'not_found']);
  const taken = fromDatabaseError({ code: '23505', message: 'duplicate key' });
  assertEquals([taken.status, taken.code], [409, 'conflict']);
  const thin = fromDatabaseError({ code: '42501', message: 'summary_not_enough_conversation' });
  assertEquals([thin.status, thin.code], [422, 'summary_not_enough_conversation']);
});

const runtimeConfig: RuntimeConfig = {
  allowedOrigins: new Set(['https://app.newone.example']),
  accessCookieName: '__Host-newone_access',
  refreshCookieName: '__Host-newone_refresh',
  csrfCookieName: '__Host-newone_csrf',
  maxJsonBytes: 65536,
  networkHashKey: 'n'.repeat(32),
  cursorSigningKey: 'c'.repeat(32),
  allowHttpLocal: false,
};

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function readActor(
  rpc: (name: string, args: Record<string, unknown>) => unknown,
  signed: (bucket: string, paths: string[]) => { path: string; signedUrl: string; error: null }[] = () => [],
  calls: RpcCall[] = [],
) {
  return {
    user: { id: '70000000-0000-4000-8000-000000000007' },
    claims: {
      sub: '70000000-0000-4000-8000-000000000007',
      sessionId: '80000000-0000-4000-8000-000000000008',
      aal: 'aal1',
      issuedAt: 1,
      expiresAt: 9999999999,
    },
    token: 'access-token',
    userClient: {},
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: rpc(name, args), error: null });
      },
      storage: {
        from: (bucket: string) => ({
          createSignedUrls: (paths: string[]) =>
            Promise.resolve({ data: signed(bucket, paths), error: null }),
        }),
      },
    },
  } as unknown as AuthenticatedActor;
}

async function withReadEnvironment(run: () => Promise<void>): Promise<void> {
  const environment: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-projects',
    SUPABASE_SECRET_KEY: 'secret-key-for-projects',
    NEWONE_ALLOWED_WEB_ORIGINS: 'https://app.newone.example',
    NEWONE_NETWORK_HASH_KEY: 'network-key-that-is-long-enough-for-tests',
    NEWONE_CURSOR_SIGNING_KEY: 'cursor-key-that-is-long-enough-for-tests',
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

function readDependencies(overrides: Partial<ReadDependencies> = {}): ReadDependencies {
  const unused = () => Promise.reject(new Error('not used by this test'));
  return {
    loadBootstrap: unused,
    loadPreferences: unused,
    loadMessages: unused,
    loadPins: unused,
    loadMedia: unused,
    loadProjects: unused,
    loadSummaryReadiness: unused,
    loadFind: unused,
    loadSummaryExport: unused,
    loadSearch: unused,
    loadUserSearch: unused,
    loadAudit: unused,
    recordAuditDenial: unused,
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'secret',
    },
    authenticateActor: async () => readActor(() => ({})),
    resolveOrganization: async () => ({ organizationId, principalContext: {} }),
    authorize: async () => {},
    rateLimit: async () => {},
    ...overrides,
  };
}

function request(path: string, body: unknown): Request {
  return new Request(`https://app.newone.example/api/newone${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer access-token-that-is-long-enough',
      'Content-Type': 'application/json',
      Origin: 'https://app.newone.example',
    },
    body: JSON.stringify(body),
  });
}

Deno.test('the projects, readiness and find reads authorize, rate limit and pass their bounds', async () => {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const handler = createReadHandler(() =>
    readDependencies({
      authorize: async (_actor, _organizationId, policy) => {
        calls.push(`authorize:${policy.operation}`);
      },
      rateLimit: async (_request, _config, _actor, _organizationId, operation) => {
        calls.push(`rate:${operation}`);
      },
      loadProjects: async (_actor, value) => {
        inputs.push(value);
        return { schemaVersion: 1, projects: [], items: [] };
      },
      loadSummaryReadiness: async (_actor, value) => {
        inputs.push(value);
        return { schemaVersion: 1, ranges: {} };
      },
      loadFind: async (_actor, value) => {
        inputs.push(value);
        return { schemaVersion: 1, results: [] };
      },
    })
  );
  assertEquals(
    (await handler(request(`/v2/conversations/${conversationId}/projects/query`, { organizationId }))).status,
    200,
  );
  assertEquals(
    (await handler(request(`/v2/conversations/${conversationId}/summaries/readiness`, {
      organizationId,
      utcOffsetMinutes: 540,
    }))).status,
    200,
  );
  assertEquals(
    (await handler(request('/v2/find/query', { organizationId, query: ' 회의 ' }))).status,
    200,
  );
  assertEquals(calls, [
    'authorize:read.projects',
    'rate:read.projects',
    'authorize:read.summary_readiness',
    'rate:read.summary_readiness',
    'authorize:read.find',
    'rate:read.find',
  ]);
  assertEquals(inputs, [
    { organizationId, conversationId },
    { organizationId, conversationId, fromMessageId: null, utcOffsetMinutes: 540 },
    { organizationId, query: '회의', limit: 30 },
  ]);
});

Deno.test('the new reads refuse malformed input', async () => {
  const handler = createReadHandler(() => readDependencies());
  const refused: [string, unknown][] = [
    [`/v2/conversations/${conversationId}/projects/query`, { organizationId, extra: 1 }],
    ['/v2/conversations/not-a-uuid/projects/query', { organizationId }],
    [`/v2/conversations/${conversationId}/summaries/readiness`, { organizationId, utcOffsetMinutes: 901 }],
    [`/v2/conversations/${conversationId}/summaries/readiness`, { organizationId, fromMessageId: 'x' }],
    ['/v2/find/query', { organizationId, query: '' }],
    ['/v2/find/query', { organizationId, query: 'x'.repeat(101) }],
    ['/v2/find/query', { organizationId, query: 'acid', limit: 51 }],
  ];
  for (const [path, body] of refused) {
    const response = await handler(request(path, body));
    assertEquals(response.status, 400, `${path} ${JSON.stringify(body)}`);
  }
});

Deno.test('the projects read signs photo previews and never sends bucket or path', () =>
  withReadEnvironment(async () => {
  const calls: RpcCall[] = [];
  const actor = readActor(
    () => ({
      schema_version: 1,
      conversation_id: conversationId,
      selected_project_id: projectId,
      projects: [{ project_id: projectId, name: 'HDG' }],
      items: [
        {
          item_id: itemId,
          kind: 'upload',
          media_kind: 'image',
          bucket_id: 'message-attachments',
          storage_path: 'org/conv/user/photo/upload',
        },
        {
          item_id: '40000000-0000-4000-8000-000000000009',
          kind: 'upload',
          media_kind: 'file',
          bucket_id: 'message-attachments',
          storage_path: 'org/conv/user/pdf/upload',
        },
        { item_id: '40000000-0000-4000-8000-00000000000a', kind: 'link', url: 'https://www.newoneinc.com/' },
      ],
    }),
    (_bucket, paths) =>
      paths.map((path) => ({ path, signedUrl: `https://project.supabase.co/signed/${path}`, error: null })),
    calls,
  );
  const result = await defaultReadDependencies().loadProjects(actor, { organizationId, conversationId }) as {
    selectedProjectId: string;
    items: Record<string, unknown>[];
  };
  assertEquals(calls.map((call) => call.name), ['bff_read_conversation_projects']);
  assertEquals(result.selectedProjectId, projectId);
  assertEquals(result.items.map((item) => item.previewUrl), [
    'https://project.supabase.co/signed/org/conv/user/photo/upload',
    null,
    null,
  ]);
  assert(result.items.every((item) => !('bucketId' in item) && !('storagePath' in item)));
}));

Deno.test('a summary export the database does not allow is not found', () =>
  withReadEnvironment(async () => {
  const actor = readActor(() => ({ schema_version: 1, found: false }));
  await assertRejects(
    () =>
      defaultReadDependencies().loadSummaryExport(actor, {
        organizationId,
        conversationId,
        summaryId,
        format: 'pdf',
        timeZone: 'UTC',
        locale: 'en',
      }),
    (error) => error instanceof ApiError && error.status === 404,
  );
}));
