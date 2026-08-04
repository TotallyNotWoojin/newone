import type { AuthenticatedActor } from '../_shared/clients.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000010';
const sessionId = '00000000-0000-4000-8000-000000000020';
const installationId = '00000000-0000-4000-8000-000000000030';
const otherInstallationId = '00000000-0000-4000-8000-000000000031';

const actor = {
  user: { id: actorId },
  claims: {
    sub: actorId,
    sessionId,
    aal: 'aal1',
    issuedAt: 1,
    expiresAt: 9999999999,
  },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

Deno.test('current-device preference routes separate a non-idempotent query from CAS updates', () => {
  const read = matchRoute(
    'POST',
    `/v2/devices/${installationId}/preferences/query`,
  );
  const update = matchRoute(
    'PATCH',
    `/v2/devices/${installationId}/preferences`,
  );
  assert(read && update);
  assertEquals(read.kind, 'device.preferences.read');
  assertEquals(read.idempotencyRequired, false);
  assertEquals(update.kind, 'device.preferences.update');
  assertEquals(update.idempotencyRequired, undefined);
  assertEquals(read.requireAal2, undefined);
  assertEquals(update.requireAal2, undefined);
});

Deno.test('device preference parser accepts only a non-empty nullable override patch', async () => {
  const read = matchRoute('POST', `/v2/devices/${installationId}/preferences/query`);
  const update = matchRoute('PATCH', `/v2/devices/${installationId}/preferences`);
  assert(read && update);
  assertEquals(parseCommand(read, { organizationId }).values, { installationId });
  assertEquals(parseCommand(update, {
    organizationId,
    expectedVersion: 4,
    patch: {
      notificationPreview: null,
      soundEnabled: false,
      vibrationEnabled: true,
    },
  }).values, {
    installationId,
    expectedVersion: 4,
    patch: {
      notification_preview: null,
      sound_enabled: false,
      vibration_enabled: true,
    },
  });
  for (const body of [
    { organizationId, expectedVersion: 4, patch: {} },
    { organizationId, expectedVersion: 0, patch: { soundEnabled: true } },
    { organizationId, expectedVersion: 4, patch: { soundEnabled: 'yes' } },
    { organizationId, expectedVersion: 4, patch: { previewBody: 'secret' } },
    { organizationId, expectedVersion: 4, patch: { soundEnabled: true }, deviceId: installationId },
  ]) await assertRejects(() => parseCommand(update, body));
});

Deno.test('device preference commands bind the path installation and map only to scoped RPCs', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = {
    registered: true,
    device_id: '00000000-0000-4000-8000-000000000040',
    installation_id: installationId,
    platform: 'ios',
    preference_version: 5,
    overrides: {
      notification_preview: null,
      sound_enabled: false,
      vibration_enabled: null,
    },
    effective: {
      notification_preview: 'generic',
      sound_enabled: false,
      vibration_enabled: true,
    },
    updated_at: '2026-08-04T18:00:00.000Z',
  };
  const rpcActor = {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({ data: response, error: null });
      },
    },
  } as unknown as AuthenticatedActor;
  const read = matchRoute('POST', `/v2/devices/${installationId}/preferences/query`);
  const firstUpdate = matchRoute('PATCH', `/v2/devices/${installationId}/preferences`);
  const secondUpdate = matchRoute('PATCH', `/v2/devices/${otherInstallationId}/preferences`);
  assert(read && firstUpdate && secondUpdate);
  await executeCommand(
    read,
    parseCommand(read, { organizationId }),
    rpcActor,
    '',
    'a'.repeat(64),
  );
  for (const [route, key] of [
    [firstUpdate, 'device-preference-key-0001'],
    [secondUpdate, 'device-preference-key-0002'],
  ] as const) {
    await executeCommand(
      route,
      parseCommand(route, {
        organizationId,
        expectedVersion: 4,
        patch: { soundEnabled: false },
      }),
      rpcActor,
      key,
      'a'.repeat(64),
    );
  }
  assertEquals(calls.map((call) => call.name), [
    'bff_get_device_notification_preferences',
    'bff_update_device_notification_preferences',
    'bff_update_device_notification_preferences',
  ]);
  assertEquals(calls[0]?.args, {
    p_actor_user_id: actorId,
    p_organization_id: organizationId,
    p_session_id: sessionId,
    p_installation_id: installationId,
  });
  assertEquals(calls[1]?.args.p_expected_version, 4);
  assertEquals(calls[1]?.args.p_patch, { sound_enabled: false });
  assertEquals(calls[1]?.args.p_installation_id, installationId);
  assertEquals(calls[2]?.args.p_installation_id, otherInstallationId);
  assert(
    calls[1]?.args.p_request_sha256 !== calls[2]?.args.p_request_sha256,
    'path installation must change the idempotency digest',
  );
  for (const call of calls) {
    assert(!('p_device_id' in call.args));
    assert(!('p_user_id' in call.args));
  }
});
