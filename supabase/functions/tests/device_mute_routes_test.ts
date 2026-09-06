// Server-side mute (backlog 13): the current-installation mute routes mirror
// the device preference routes (a non-idempotent query, a PATCH command) and
// map only to the two scoped RPCs.
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

Deno.test('device mute routes separate a non-idempotent query from the PATCH command', () => {
  const read = matchRoute('POST', `/v2/devices/${installationId}/mute/query`);
  const update = matchRoute('PATCH', `/v2/devices/${installationId}/mute`);
  assert(read && update);
  assertEquals(read.kind, 'device.mute.read');
  assertEquals(read.idempotencyRequired, false);
  assertEquals(update.kind, 'device.mute.update');
  assertEquals(update.idempotencyRequired, undefined);
  assertEquals(read.requireAal2, undefined);
  assertEquals(update.requireAal2, undefined);
  // The preference routes are untouched by the new templates.
  assertEquals(matchRoute('POST', `/v2/devices/${installationId}/preferences/query`)?.kind, 'device.preferences.read');
  assertEquals(matchRoute('PATCH', `/v2/devices/${installationId}/preferences`)?.kind, 'device.preferences.update');
});

Deno.test('device mute parser accepts exactly a boolean muted flag', async () => {
  const read = matchRoute('POST', `/v2/devices/${installationId}/mute/query`);
  const update = matchRoute('PATCH', `/v2/devices/${installationId}/mute`);
  assert(read && update);
  assertEquals(parseCommand(read, { organizationId }).values, { installationId });
  assertEquals(parseCommand(update, { organizationId, muted: true }).values, {
    installationId,
    muted: true,
  });
  assertEquals(parseCommand(update, { organizationId, muted: false }).values.muted, false);
  for (const body of [
    { organizationId },
    { organizationId, muted: 'yes' },
    { organizationId, muted: null },
    { organizationId, muted: true, installationId },
    { organizationId, muted: true, deviceId: installationId },
  ]) await assertRejects(() => parseCommand(update, body));
  await assertRejects(() => parseCommand(read, { organizationId, muted: true }));
});

Deno.test('device mute commands bind the path installation and map only to the scoped RPCs', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const response = {
    registered: true,
    device_id: '00000000-0000-4000-8000-000000000040',
    installation_id: installationId,
    notifications_muted: true,
    updated_at: '2026-09-07T03:00:00.000Z',
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
  const read = matchRoute('POST', `/v2/devices/${installationId}/mute/query`);
  const firstUpdate = matchRoute('PATCH', `/v2/devices/${installationId}/mute`);
  const secondUpdate = matchRoute('PATCH', `/v2/devices/${otherInstallationId}/mute`);
  assert(read && firstUpdate && secondUpdate);
  const readResult = await executeCommand(
    read,
    parseCommand(read, { organizationId }),
    rpcActor,
    '',
    'a'.repeat(64),
  );
  assertEquals(readResult.status, 200);
  assertEquals(readResult.body, {
    registered: true,
    deviceId: '00000000-0000-4000-8000-000000000040',
    installationId,
    notificationsMuted: true,
    updatedAt: '2026-09-07T03:00:00.000Z',
  });
  for (const [route, key, muted] of [
    [firstUpdate, 'device-mute-key-0001', true],
    [secondUpdate, 'device-mute-key-0002', false],
  ] as const) {
    await executeCommand(
      route,
      parseCommand(route, { organizationId, muted }),
      rpcActor,
      key,
      'a'.repeat(64),
    );
  }
  assertEquals(calls.map((call) => call.name), [
    'bff_get_device_notifications_muted',
    'bff_set_device_notifications_muted',
    'bff_set_device_notifications_muted',
  ]);
  assertEquals(calls[0]?.args, {
    p_actor_user_id: actorId,
    p_organization_id: organizationId,
    p_session_id: sessionId,
    p_installation_id: installationId,
  });
  assertEquals(calls[1]?.args.p_muted, true);
  assertEquals(calls[1]?.args.p_installation_id, installationId);
  assertEquals(calls[1]?.args.p_idempotency_key, 'device-mute-key-0001');
  assertEquals(calls[2]?.args.p_muted, false);
  assertEquals(calls[2]?.args.p_installation_id, otherInstallationId);
  assert(
    calls[1]?.args.p_request_sha256 !== calls[2]?.args.p_request_sha256,
    'path installation must change the idempotency digest',
  );
  for (const call of calls) {
    assert(!('p_device_id' in call.args));
    assertEquals(call.args.p_actor_user_id, actorId);
    assertEquals(call.args.p_organization_id, organizationId);
    assertEquals(call.args.p_session_id, sessionId);
  }
});
