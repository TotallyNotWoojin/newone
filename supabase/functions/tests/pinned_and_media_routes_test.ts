import type { AuthenticatedActor } from '../_shared/clients.ts';
import type { RuntimeConfig } from '../_shared/http.ts';
import {
  createReadHandler,
  defaultReadDependencies,
  type ReadDependencies,
} from '../newone-read/handler.ts';
import { assertEquals } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const conversationId = '00000000-0000-4000-8000-000000000002';
const attachmentId = '00000000-0000-4000-8000-000000000003';

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

interface StorageEntry {
  path: string | null;
  signedUrl: string | null;
  error: string | null;
}

function actorWithStorage(
  signed: (bucket: string, paths: string[]) => StorageEntry[],
  record?: (bucket: string, paths: string[], expiresIn: number) => void,
) {
  return {
    user: { id: '00000000-0000-4000-8000-000000000010' },
    claims: {
      sub: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      aal: 'aal1',
      issuedAt: 1,
      expiresAt: 9999999999,
    },
    token: 'access-token',
    userClient: {},
    adminClient: {
      storage: {
        from: (bucket: string) => ({
          createSignedUrls: (paths: string[], expiresIn: number) => {
            record?.(bucket, paths, expiresIn);
            return Promise.resolve({ data: signed(bucket, paths), error: null });
          },
        }),
      },
    },
  } as unknown as AuthenticatedActor;
}

function dependencies(
  overrides: Partial<ReadDependencies> = {},
  actor: AuthenticatedActor = actorWithStorage(() => []),
): ReadDependencies {
  return {
    runtimeConfig,
    clientEnvironment: {
      url: 'https://project.supabase.co',
      publishableKey: 'publishable',
      secretKey: 'secret',
    },
    authenticateActor: async () => actor,
    resolveOrganization: async () => ({ organizationId, principalContext: {} }),
    authorize: async () => {},
    rateLimit: async () => {},
    loadBootstrap: async () => ({ selectedOrganizationId: organizationId }),
    loadPreferences: async () => ({ organizationId }),
    loadMessages: async () => ({ messages: [], page: {} }),
    loadPins: async () => ({ schemaVersion: 1, pins: [] }),
    loadMedia: async () => ({ schemaVersion: 1, items: [], hasMore: false }),
    loadSearch: async () => ({ results: [], nextCursor: null, hasMore: false }),
    loadUserSearch: async () => ({ users: [] }),
    loadAudit: async () => ({
      schema_version: 1,
      items: [],
      next_cursor: null,
      has_more: false,
      snapshot_at: new Date().toISOString(),
      filter_sha256: 'a'.repeat(64),
      receipt_id: '00000000-0000-4000-8000-000000000071',
    }),
    recordAuditDenial: async () => {},
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

Deno.test('pin query authorizes, rate limits, and passes an optional chat and bound', async () => {
  const calls: string[] = [];
  let input: unknown;
  const handler = createReadHandler(() =>
    dependencies({
      authorize: async (_actor, _organizationId, policy) => {
        calls.push(`authorize:${policy.operation}`);
      },
      rateLimit: async (_request, _config, _actor, _organizationId, operation) => {
        calls.push(`rate:${operation}`);
      },
      loadPins: async (_actor, value) => {
        input = value;
        return { schemaVersion: 1, pins: [] };
      },
    })
  );
  const everyChat = await handler(request('/v2/pins/query', { organizationId }));
  assertEquals(everyChat.status, 200);
  assertEquals(calls, ['authorize:read.pins', 'rate:read.pins']);
  assertEquals(input, { organizationId, conversationId: null, limit: 50 });

  const oneChat = await handler(
    request('/v2/pins/query', { organizationId, conversationId, limit: 10 }),
  );
  assertEquals(oneChat.status, 200);
  assertEquals(input, { organizationId, conversationId, limit: 10 });
});

Deno.test('pin query rejects unknown keys and out-of-range bounds', async () => {
  const handler = createReadHandler(() => dependencies());
  const extra = await handler(
    request('/v2/pins/query', { organizationId, unexpected: true }),
  );
  assertEquals(extra.status, 400);
  const tooMany = await handler(request('/v2/pins/query', { organizationId, limit: 101 }));
  assertEquals(tooMany.status, 400);
  const noOrganization = await handler(request('/v2/pins/query', {}));
  assertEquals(noOrganization.status, 400);
});

Deno.test('media query carries a whole keyset or none of it', async () => {
  let input: unknown;
  const handler = createReadHandler(() =>
    dependencies({
      loadMedia: async (_actor, value) => {
        input = value;
        return { schemaVersion: 1, items: [], hasMore: false };
      },
    })
  );
  const first = await handler(
    request(`/v2/conversations/${conversationId}/media/query`, { organizationId }),
  );
  assertEquals(first.status, 200);
  assertEquals(input, {
    organizationId,
    conversationId,
    beforeCreatedAt: null,
    beforeAttachmentId: null,
    limit: 30,
  });

  const next = await handler(
    request(`/v2/conversations/${conversationId}/media/query`, {
      organizationId,
      beforeCreatedAt: '2026-09-07T10:00:00.000Z',
      beforeAttachmentId: attachmentId,
      limit: 12,
    }),
  );
  assertEquals(next.status, 200);
  assertEquals(input, {
    organizationId,
    conversationId,
    beforeCreatedAt: '2026-09-07T10:00:00.000Z',
    beforeAttachmentId: attachmentId,
    limit: 12,
  });

  const halfCursor = await handler(
    request(`/v2/conversations/${conversationId}/media/query`, {
      organizationId,
      beforeCreatedAt: '2026-09-07T10:00:00.000Z',
    }),
  );
  assertEquals(halfCursor.status, 400);
  const badConversation = await handler(
    request('/v2/conversations/not-a-uuid/media/query', { organizationId }),
  );
  assertEquals(badConversation.status, 400);
});

async function withReadEnvironment(run: () => Promise<void>): Promise<void> {
  const environment: Record<string, string> = {
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-pinned-media',
    SUPABASE_SECRET_KEY: 'secret-key-for-pinned-media',
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

function rpcActor(
  page: unknown,
  signRequests: { bucket: string; paths: string[]; expiresIn: number }[],
  calls: { name: string; args: Record<string, unknown> }[],
): AuthenticatedActor {
  return {
    user: { id: '00000000-0000-4000-8000-000000000010' },
    claims: {
      sub: '00000000-0000-4000-8000-000000000010',
      sessionId: '00000000-0000-4000-8000-000000000020',
      aal: 'aal1',
      issuedAt: 1,
      expiresAt: 9999999999,
    },
    token: 'access-token',
    userClient: {},
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: page, error: null });
      },
      storage: {
        from: (bucket: string) => ({
          createSignedUrls: (paths: string[], expiresIn: number) => {
            signRequests.push({ bucket, paths, expiresIn });
            return Promise.resolve({
              data: paths.map((path) =>
                path.endsWith('missing')
                  ? { path, signedUrl: null, error: 'not_found' }
                  : { path, signedUrl: `https://cdn.test/${bucket}/${path}`, error: null }
              ),
              error: null,
            });
          },
        }),
      },
    },
  } as unknown as AuthenticatedActor;
}

Deno.test('the default pin loader binds the session identity to the service RPC', async () => {
  await withReadEnvironment(async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const actor = rpcActor({
      schema_version: 1,
      conversation_id: null,
      pins: [{ conversation_id: conversationId, message_id: '42', attachment_kind: 'image' }],
    }, [], calls);
    const result = await defaultReadDependencies().loadPins(actor, {
      organizationId,
      conversationId: null,
      limit: 50,
    }) as Record<string, unknown>;
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.name, 'bff_read_pinned_messages');
    assertEquals(calls[0]?.args, {
      p_actor_user_id: '00000000-0000-4000-8000-000000000010',
      p_organization_id: organizationId,
      p_session_id: '00000000-0000-4000-8000-000000000020',
      p_conversation_id: null,
      p_limit: 50,
    });
    // The gateway camelizes so the device parses one shape everywhere.
    assertEquals(result.schemaVersion, 1);
    assertEquals(
      (result.pins as Record<string, unknown>[])[0]?.attachmentKind,
      'image',
    );
  });
});

Deno.test('the default media loader signs once per bucket and drops storage paths', async () => {
  await withReadEnvironment(async () => {
    const signRequests: { bucket: string; paths: string[]; expiresIn: number }[] = [];
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const actor = rpcActor({
      schema_version: 1,
      conversation_id: conversationId,
      items: [
        {
          attachment_id: attachmentId,
          message_id: '9',
          file_name: 'beach.jpg',
          mime_type: 'image/jpeg',
          kind: 'image',
          bucket_id: 'attachments',
          storage_path: 'org/chat/beach.jpg',
        },
        {
          attachment_id: '00000000-0000-4000-8000-000000000004',
          message_id: '8',
          file_name: 'gone.jpg',
          mime_type: 'image/jpeg',
          kind: 'image',
          bucket_id: 'attachments',
          storage_path: 'org/chat/missing',
        },
        {
          attachment_id: '00000000-0000-4000-8000-000000000005',
          message_id: '7',
          file_name: 'notes.pdf',
          mime_type: 'application/pdf',
          kind: 'file',
          bucket_id: 'attachments',
          storage_path: 'org/chat/notes.pdf',
        },
      ],
      has_more: true,
      next_before_created_at: '2026-09-07T09:00:00.000Z',
      next_before_attachment_id: '00000000-0000-4000-8000-000000000005',
    }, signRequests, calls);
    const result = await defaultReadDependencies().loadMedia(actor, {
      organizationId,
      conversationId,
      beforeCreatedAt: null,
      beforeAttachmentId: null,
      limit: 30,
    }) as Record<string, unknown>;
    assertEquals(calls[0]?.name, 'bff_read_conversation_media');
    // One storage round trip for the whole page, and only for viewable rows.
    assertEquals(signRequests.length, 1);
    assertEquals(signRequests[0]?.paths, ['org/chat/beach.jpg', 'org/chat/missing']);
    assertEquals(signRequests[0]?.expiresIn, 300);
    const items = result.items as Record<string, unknown>[];
    assertEquals(items.length, 3);
    assertEquals(items[0]?.previewUrl, 'https://cdn.test/attachments/org/chat/beach.jpg');
    // A path the store cannot sign is a missing thumbnail, not a failed page.
    assertEquals(items[1]?.previewUrl, null);
    assertEquals(items[2]?.previewUrl, null);
    for (const item of items) {
      assertEquals('bucketId' in item, false);
      assertEquals('storagePath' in item, false);
    }
    assertEquals(result.hasMore, true);
    assertEquals(result.nextBeforeAttachmentId, '00000000-0000-4000-8000-000000000005');
  });
});
