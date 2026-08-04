import { matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const requestId = '30000000-0000-4000-8000-000000000003';

Deno.test('conversation controls routes enforce AAL2 and strict bounded input', async () => {
  const route = matchRoute('PATCH', `/v2/conversations/${conversationId}/controls`);
  assert(route);
  assertEquals(route.requireAal2, true);
  assertEquals(route.recentAuthSeconds, 300);
  assertEquals(parseCommand(route, {
    organizationId,
    postingMode: 'admins_only',
    joinPolicy: 'approval_required',
    visibility: 'organization',
    reason: 'Limit posting during an operational briefing',
  }).values, {
    conversationId,
    postingMode: 'admins_only',
    joinPolicy: 'approval_required',
    visibility: 'organization',
    reason: 'Limit posting during an operational briefing',
  });
  await assertRejects(() => parseCommand(route, {
    organizationId,
    postingMode: 'admins_only',
    reason: 'ok',
    arbitrarySql: 'select 1',
  }));
});

Deno.test('organization controls and join decisions are protected admin routes', () => {
  const organizationRoute = matchRoute('PATCH', '/v2/admin/conversation-controls');
  const decisionRoute = matchRoute(
    'POST',
    `/v2/conversation-join-requests/${requestId}/decision`,
  );
  assert(organizationRoute);
  assert(decisionRoute);
  assertEquals(organizationRoute.requireAal2, true);
  assertEquals(organizationRoute.recentAuthSeconds, 300);
  assertEquals(decisionRoute.requireAal2, true);
  assertEquals(parseCommand(decisionRoute, {
    organizationId,
    expectedVersion: 4,
    decision: 'approved',
    reason: 'Verified team assignment',
  }).values, {
    requestId,
    expectedVersion: 4,
    decision: 'approved',
    reason: 'Verified team assignment',
  });
});

Deno.test('join request and bounded query routes do not require idempotency for reads', () => {
  const requestRoute = matchRoute('POST', `/v2/conversations/${conversationId}/join-requests`);
  const discoverRoute = matchRoute('POST', '/v2/conversations/discover/query');
  const queueRoute = matchRoute(
    'POST',
    `/v2/conversations/${conversationId}/join-requests/query`,
  );
  assert(requestRoute);
  assert(discoverRoute);
  assert(queueRoute);
  assertEquals(requestRoute.status, 201);
  assertEquals(discoverRoute.idempotencyRequired, false);
  assertEquals(queueRoute.idempotencyRequired, false);
  assertEquals(queueRoute.requireAal2, true);
  assertEquals(parseCommand(discoverRoute, { organizationId, limit: 25 }).values.limit, 25);
});
