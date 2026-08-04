import type { AuthenticatedActor } from '../_shared/clients.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '7a000000-0000-4000-8000-000000000001';
const conversationId = '7a000000-0000-4000-8000-000000000002';

Deno.test('conversation translation mode accepts only automatic or off and maps to a server patch', async () => {
  const route = matchRoute('PATCH', `/v2/conversations/${conversationId}/preferences`);
  assert(route);
  const command = parseCommand(route, { organizationId, translationMode: 'off' });
  assertEquals(command.values, {
    conversationId,
    patch: { translation_mode: 'off' },
  });
  await assertRejects(() => parseCommand(route, { organizationId, translationMode: 'manual' }));
  await assertRejects(() =>
    parseCommand(route, {
      organizationId,
      translationMode: 'off',
      targetLanguage: 'ko',
    })
  );

  let rpcArgs: Record<string, unknown> | null = null;
  const actor = {
    user: { id: '7a000000-0000-4000-8000-000000000003' },
    claims: {
      sub: '7a000000-0000-4000-8000-000000000003',
      sessionId: '7a000000-0000-4000-8000-000000000004',
      aal: 'aal1',
      issuedAt: 1,
      expiresAt: 9999999999,
    },
    token: 'token',
    userClient: {},
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        assertEquals(name, 'bff_update_conversation_preferences');
        rpcArgs = args;
        return Promise.resolve({
          data: {
            conversation_id: conversationId,
            is_favorite: false,
            is_pinned: false,
            is_hidden: false,
            notification_level: 'all',
            muted_until: null,
            translation_mode: 'off',
            updated_at: '2026-08-04T20:00:00.000Z',
          },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
  const result = await executeCommand(
    route,
    command,
    actor,
    'translation-mode-0001',
    'a'.repeat(64),
  );
  assertEquals(result.status, 200);
  assertEquals(result.body, {
    conversationId,
    isFavorite: false,
    isPinned: false,
    notificationLevel: 'all',
    mutedUntil: null,
    translationMode: 'off',
    updatedAt: '2026-08-04T20:00:00.000Z',
    isArchived: false,
  });
  assertEquals(rpcArgs, {
    p_actor_user_id: '7a000000-0000-4000-8000-000000000003',
    p_organization_id: organizationId,
    p_session_id: '7a000000-0000-4000-8000-000000000004',
    p_idempotency_key: 'translation-mode-0001',
    p_request_sha256: 'a'.repeat(64),
    p_conversation_id: conversationId,
    p_patch: { translation_mode: 'off' },
  });
});
