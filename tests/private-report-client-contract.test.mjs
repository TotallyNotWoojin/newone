import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { parsePrivateReportReceipt } from '../apps/newone/src/data/repositories/private-report-dto.mjs';

const reportId = '10000000-0000-4000-8000-000000000001';

function receipt(overrides = {}) {
  return {
    reportId,
    status: 'open',
    targetType: 'message',
    created: true,
    reporterIdentityProtected: true,
    targetNotNotified: true,
    noticeVersion: 'moderation-report-v2',
    contextBefore: 1,
    contextAfter: 2,
    ...overrides,
  };
}

const files = {
  routes: readFileSync('supabase/functions/newone-api/routes.ts', 'utf8'),
  contracts: readFileSync('apps/newone/src/data/repositories/contracts.ts', 'utf8'),
  transport: readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8'),
  demo: readFileSync('apps/newone/src/data/repositories/demo-repository.ts', 'utf8'),
  demoFixtures: readFileSync('apps/newone/src/data/demo.ts', 'utf8'),
  workspace: readFileSync('apps/newone/src/state/workspace.tsx', 'utf8'),
  pane: readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8'),
  people: readFileSync('apps/newone/src/app/people.tsx', 'utf8'),
  copy: readFileSync('apps/newone/src/features/admin/moderation-copy.ts', 'utf8'),
  catalog: readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8'),
  migration: readFileSync(
    'supabase/migrations/20260804171735_complete_private_target_reporting.sql',
    'utf8',
  ),
};

test('private report receipt is exact, target-bound, and confirms both privacy guarantees', () => {
  const parsed = parsePrivateReportReceipt({ data: receipt() }, 'message');
  assert.equal(parsed.reportId, reportId);
  assert.equal(parsed.reporterIdentityProtected, true);
  assert.equal(parsed.targetNotNotified, true);
  assert.equal(parsed.contextAfter, 2);

  for (const invalid of [
    receipt({ targetType: 'group' }),
    receipt({ reporterIdentityProtected: false }),
    receipt({ targetNotNotified: false }),
    receipt({ created: true, status: 'assigned' }),
    receipt({ targetLabel: 'must not be returned' }),
    receipt({ reportId: 'not-a-uuid' }),
  ]) assert.throws(() => parsePrivateReportReceipt(invalid, 'message'), /invalid private report receipt/);
});

test('group and member receipts are content-free and require the v2 notice', () => {
  for (const targetType of ['group', 'member']) {
    const parsed = parsePrivateReportReceipt(receipt({
      targetType,
      contextBefore: 0,
      contextAfter: 0,
    }), targetType);
    assert.equal(parsed.targetType, targetType);
    assert.throws(() => parsePrivateReportReceipt(receipt({
      targetType,
      contextBefore: 1,
      contextAfter: 0,
    }), targetType), /invalid private report receipt/);
    assert.throws(() => parsePrivateReportReceipt(receipt({
      targetType,
      contextBefore: 0,
      contextAfter: 0,
      noticeVersion: 'moderation-share-v1',
    }), targetType), /invalid private report receipt/);
  }
  assert.equal(parsePrivateReportReceipt(receipt({
    created: false,
    status: 'in_review',
    noticeVersion: 'moderation-share-v1',
  }), 'message').status, 'in_review');
});

test('edge routes use the unified RPC with target-bound request digests and zero non-message context', () => {
  for (const route of [
    '/v2/messages/:messageId/report',
    '/v2/conversations/:conversationId/report',
    '/v2/people/:membershipId/report',
  ]) assert.ok(files.routes.includes(route), `missing ${route}`);
  assert.equal((files.routes.match(/'bff_report_target_v3'/g) ?? []).length, 3);
  assert.match(files.routes, /sha256Hex\([\s\S]*requestDigest[\s\S]*message/);
  assert.match(files.routes, /requestDigest\}\\ngroup/);
  assert.match(files.routes, /requestDigest\}\\nmember/);
  assert.match(files.routes, /p_target_type: 'group'[\s\S]*p_context_before: 0[\s\S]*p_context_after: 0/);
  assert.match(files.routes, /p_target_type: 'member'[\s\S]*p_conversation_id: null[\s\S]*p_subject_user_id: values\.subjectUserId/);
  assert.doesNotMatch(files.routes, /p_target_label/);
});

test('repositories and workspace expose all targets and parse authoritative receipts', () => {
  for (const method of ['reportMessage', 'reportGroup', 'reportMember']) {
    assert.match(files.contracts, new RegExp(`${method}\\(input:`));
    assert.match(files.transport, new RegExp(`async ${method}\\(`));
    assert.match(files.demo, new RegExp(`async ${method}\\(`));
    assert.match(files.workspace, new RegExp(`const ${method} = useCallback`));
  }
  assert.match(files.transport, /parsePrivateReportReceipt\(payload, 'message'\)/);
  assert.match(files.transport, /parsePrivateReportReceipt\(payload, 'group'\)/);
  assert.match(files.transport, /parsePrivateReportReceipt\(payload, 'member'\)/);
  assert.match(files.workspace, /executeImmediate\('group-report'/);
  assert.match(files.workspace, /executeImmediate\('member-report'/);
  assert.doesNotMatch(files.workspace, /putOutbox[\s\S]{0,240}group-report/);
});

test('reportable demo content is incoming and carries a production-shaped server message ID', () => {
  const fixtureStart = files.demoFixtures.indexOf("id: 'msg-p-reportable'");
  assert.notEqual(fixtureStart, -1);
  const fixtureEnd = files.demoFixtures.indexOf('\n    },', fixtureStart);
  assert.notEqual(fixtureEnd, -1);
  const fixture = files.demoFixtures.slice(fixtureStart, fixtureEnd);
  const serverId = fixture.match(/serverId: '([^']+)'/)?.[1];
  assert.match(serverId ?? '', /^[1-9][0-9]{0,18}$/);
  assert.match(fixture, /isOwn: false/);
  assert.match(fixture, /mensaje sintético para validar el reporte privado con consentimiento/);

  const handoffFixtures = files.demoFixtures.slice(
    files.demoFixtures.indexOf('export const demoHandoffs'),
  );
  assert.doesNotMatch(handoffFixtures, /msg-p-reportable/);
});

test('group and person UI require explicit consent and explain the exact disclosure in every locale', () => {
  assert.match(files.pane, /workspace\.reportGroup/);
  assert.match(files.pane, /disabled=\{!groupReportConsent\}/);
  assert.match(files.pane, /moderationTargetReportConsentNotice\(locale, 'group'\)/);
  assert.match(files.people, /workspace\.reportMember/);
  assert.match(files.people, /disabled=\{!managePerson \|\| !reportConsent\}/);
  assert.match(files.people, /moderationMemberSafetyRouteNotice\(locale\)/);
  assert.match(files.copy, /Group message history is not shared/);
  assert.match(files.copy, /계정 상태, 프로필 필드, 대화 또는 메시지는 공유되지 않습니다/);
  assert.match(files.copy, /No se comparten estado de cuenta, perfil, conversaciones ni mensajes/);
  assert.equal((files.catalog.match(/'chat\.reportGroup':/g) ?? []).length, 3);
  assert.equal((files.catalog.match(/'people\.reportPrivately':/g) ?? []).length, 3);
});

test('member safety route survives ordinary-contact loss without exposing current account status', () => {
  assert.match(files.migration, /connection\.status = 'accepted'/);
  assert.match(files.migration, /viewer_conversation\.joined_at[\s\S]*target_conversation\.left_at/);
  assert.match(files.migration, /target_conversation\.joined_at[\s\S]*viewer_conversation\.left_at/);
  assert.match(files.copy, /availability does not reveal the other person’s current account status/);
  assert.doesNotMatch(files.people, /managePerson\.(?:suspended|status)[\s\S]{0,120}reportMember/);
});
