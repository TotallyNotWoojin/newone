// Muting a person and blocking a person are different acts with different
// consequences, so they are different commands on different paths.
import type { AuthenticatedActor } from '../_shared/clients.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000002';
const sessionId = '30000000-0000-4000-8000-000000000003';
const targetId = '40000000-0000-4000-8000-000000000004';

const actor = {
  user: { id: actorId },
  claims: { sub: actorId, sessionId, aal: 'aal1', issuedAt: 1, expiresAt: 9999999999 },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

function recordingActor(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return {
    ...actor,
    adminClient: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return Promise.resolve({
          data: { target_user_id: targetId, muted: args.p_muted ?? null },
          error: null,
        });
      },
    },
  } as unknown as AuthenticatedActor;
}

Deno.test('mute and unmute are their own routes on the person, next to block', () => {
  const mute = matchRoute('PUT', `/v2/people/${targetId}/mute`);
  const unmute = matchRoute('DELETE', `/v2/people/${targetId}/mute`);
  const block = matchRoute('PUT', `/v2/people/${targetId}/block`);
  assert(mute && unmute && block);
  assertEquals(mute.kind, 'person.mute');
  assertEquals(unmute.kind, 'person.unmute');
  assertEquals(block.kind, 'member.block');
  assertEquals(mute.status, 200);
  assertEquals(unmute.status, 200);
});

Deno.test('the mute command carries the person and nothing else', async () => {
  const route = matchRoute('PUT', `/v2/people/${targetId}/mute`);
  assert(route);
  assertEquals(parseCommand(route, { organizationId }).values, { targetUserId: targetId });
  for (
    const body of [
      { organizationId, muted: true },
      { organizationId, membershipId: targetId },
      {},
    ]
  ) await assertRejects(() => parseCommand(route, body));
});

Deno.test('muting and unmuting map to the one mute command with the flag flipped', async () => {
  for (const [method, muted] of [['PUT', true], ['DELETE', false]] as const) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const route = matchRoute(method, `/v2/people/${targetId}/mute`);
    assert(route);
    const result = await executeCommand(
      route,
      parseCommand(route, { organizationId }),
      recordingActor(calls),
      `person-mute-command-000${muted ? 1 : 2}`,
      'c'.repeat(64),
    );
    assertEquals(result.status, 200);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]?.name, 'bff_set_person_mute');
    assertEquals(calls[0]?.args.p_target_user_id, targetId);
    assertEquals(calls[0]?.args.p_muted, muted);
    assertEquals(calls[0]?.args.p_organization_id, organizationId);
  }
});

Deno.test('blocking still runs the block command: muting never hides anyone', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const route = matchRoute('PUT', `/v2/people/${targetId}/block`);
  assert(route);
  await executeCommand(
    route,
    parseCommand(route, { organizationId }),
    recordingActor(calls),
    'person-block-command-0001',
    'd'.repeat(64),
  );
  assertEquals(calls[0]?.name, 'bff_set_member_block');
  assertEquals(calls[0]?.args.p_blocked, true);
  assertEquals(calls[0]?.args.p_muted, undefined);
});
