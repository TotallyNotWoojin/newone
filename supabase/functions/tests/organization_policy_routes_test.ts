import { matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';

function validPolicy() {
  return {
    organizationId,
    messageRetentionDays: 365,
    allowMemberDirectMessages: true,
    dmPolicy: 'request_first',
    requireMfaForAdmins: true,
    shiftScheduleAuthoritative: true,
    groupCreationPolicy: 'managers',
    allowExternalGuests: true,
    externalGuestMaxAccessDays: 60,
    expectedVersion: 4,
    reason: 'Align access policy with the new contractor program',
  };
}

Deno.test('organization policy route is recent-AAL2, idempotent, and strictly parsed', async () => {
  const route = matchRoute('PATCH', '/v2/admin/organization-policy');
  assert(route);
  assertEquals(route.kind, 'organization.policy.update');
  assertEquals(route.requireAal2, true);
  assertEquals(route.recentAuthSeconds, 300);
  assertEquals(route.idempotencyRequired, undefined);
  assertEquals(parseCommand(route, validPolicy()), {
    organizationId,
    values: {
      messageRetentionDays: 365,
      allowMemberDirectMessages: true,
      dmPolicy: 'request_first',
      requireMfaForAdmins: true,
      shiftScheduleAuthoritative: true,
      groupCreationPolicy: 'managers',
      allowExternalGuests: true,
      externalGuestMaxAccessDays: 60,
      expectedVersion: 4,
      reason: 'Align access policy with the new contractor program',
    },
  });
  await assertRejects(() => parseCommand(route, { ...validPolicy(), rawPolicy: {} }));
});

Deno.test('organization policy route rejects partial and out-of-range policy documents', async () => {
  const route = matchRoute('PATCH', '/v2/admin/organization-policy');
  assert(route);
  const { allowExternalGuests: _missing, ...partial } = validPolicy();
  await assertRejects(() => parseCommand(route, partial));
  await assertRejects(() =>
    parseCommand(route, {
      ...validPolicy(),
      externalGuestMaxAccessDays: 366,
    })
  );
  await assertRejects(() =>
    parseCommand(route, {
      ...validPolicy(),
      messageRetentionDays: 0,
    })
  );
  await assertRejects(() =>
    parseCommand(route, {
      ...validPolicy(),
      groupCreationPolicy: 'everyone',
    })
  );
});
