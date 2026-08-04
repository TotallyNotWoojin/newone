import { matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const siteId = '30000000-0000-4000-8000-000000000003';

Deno.test('update audience parser normalizes every bounded dimension without conflating roles', () => {
  const route = matchRoute('POST', '/v2/updates/audience/preview');
  assert(route);
  const command = parseCommand(route, {
    organizationId,
    conversationId,
    audienceSpec: {
      company: false,
      conversationMembers: false,
      siteIds: [siteId],
      departmentIds: [],
      teamIds: [],
      unitIds: [],
      operationalRoles: ['Safety Coordinator'],
      membershipRoles: ['manager'],
      languages: ['KO'],
      currentShiftOnly: true,
    },
    limit: 40,
  });
  assertEquals(command.values.audienceSpec, {
    company: false,
    conversation_members: false,
    site_ids: [siteId],
    department_ids: [],
    team_ids: [],
    unit_ids: [],
    roles: ['safety coordinator'],
    membership_roles: ['manager'],
    languages: ['ko'],
    current_shift_only: true,
  });
});

Deno.test('update audience parser keeps omitted legacy clients on explicit conversation scope', () => {
  const route = matchRoute('POST', '/v2/updates/audience/preview');
  assert(route);
  const command = parseCommand(route, { organizationId, conversationId });
  assertEquals(command.values.audienceSpec, {
    company: false,
    conversation_members: true,
    site_ids: [],
    department_ids: [],
    team_ids: [],
    unit_ids: [],
    roles: [],
    membership_roles: [],
    languages: [],
    current_shift_only: false,
  });
});

Deno.test('update audience parser rejects duplicate and unknown selector input', async () => {
  const route = matchRoute('POST', '/v2/updates/audience/preview');
  assert(route);
  await assertRejects(() => parseCommand(route, {
    organizationId,
    conversationId,
    audienceSpec: {
      company: true,
      operationalRoles: ['operator', 'operator'],
    },
  }));
  await assertRejects(() => parseCommand(route, {
    organizationId,
    conversationId,
    audienceSpec: { company: true, arbitrarySql: 'true' },
  }));
});
