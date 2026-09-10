import type { AuthenticatedActor } from '../_shared/clients.ts';
import { ApiError } from '../_shared/errors.ts';
import { executeCommand, matchRoute, parseCommand } from '../newone-api/routes.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

const organizationId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000010';
const sessionId = '00000000-0000-4000-8000-000000000020';
const conversationId = '00000000-0000-4000-8000-000000000030';
const caseId = '00000000-0000-4000-8000-000000000040';
const investigatorId = '00000000-0000-4000-8000-000000000050';

const actor = {
  user: { id: actorId },
  claims: {
    sub: actorId,
    sessionId,
    aal: 'aal2',
    issuedAt: 1,
    expiresAt: 9999999999,
  },
  token: 'token',
  userClient: {},
  adminClient: {},
} as unknown as AuthenticatedActor;

Deno.test('message report parsing fails closed without exact versioned consent and bounded context', async () => {
  const route = matchRoute('POST', '/v2/messages/41/report');
  assert(route);
  const valid = {
    organizationId,
    conversationId,
    category: 'privacy',
    details: 'Operational report details.\nSecond line is permitted.',
    consentToShare: true,
    contextBefore: 2,
    contextAfter: 1,
    noticeVersion: 'moderation-report-v2',
  };
  const parsed = parseCommand(route, valid);
  assertEquals(parsed.values, {
    conversationId,
    messageId: '41',
    category: 'privacy',
    details: valid.details,
    consentToShare: true,
    contextBefore: 2,
    contextAfter: 1,
    noticeVersion: 'moderation-report-v2',
  });
  await assertRejects(() => parseCommand(route, { ...valid, consentToShare: false }));
  await assertRejects(() => parseCommand(route, { ...valid, noticeVersion: 'legacy' }));
  await assertRejects(() => parseCommand(route, { ...valid, contextBefore: 3 }));
  await assertRejects(() =>
    parseCommand(route, {
      ...valid,
      reporterUserId: actorId,
    })
  );
  assertEquals(
    parseCommand(route, { ...valid, noticeVersion: 'moderation-share-v1' }).values.noticeVersion,
    'moderation-share-v1',
  );
});

Deno.test('group and member reports accept only target-free v2 consent bodies', async () => {
  const groupRoute = matchRoute('POST', `/v2/conversations/${conversationId}/report`);
  const memberRoute = matchRoute('POST', `/v2/people/${investigatorId}/report`);
  assert(groupRoute && memberRoute);
  const valid = {
    organizationId,
    category: 'threat',
    details: 'Bounded safety details.',
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  };
  assertEquals(parseCommand(groupRoute, valid).values, {
    conversationId,
    category: 'threat',
    details: valid.details,
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  });
  assertEquals(parseCommand(memberRoute, valid).values, {
    subjectUserId: investigatorId,
    category: 'threat',
    details: valid.details,
    consentToShare: true,
    noticeVersion: 'moderation-report-v2',
  });
  for (const route of [groupRoute, memberRoute]) {
    await assertRejects(() => parseCommand(route, { ...valid, consentToShare: false }));
    await assertRejects(() => parseCommand(route, { ...valid, noticeVersion: 'moderation-share-v1' }));
    await assertRejects(() => parseCommand(route, { ...valid, contextBefore: 1 }));
    await assertRejects(() => parseCommand(route, { ...valid, targetLabel: 'client supplied' }));
  }
});
