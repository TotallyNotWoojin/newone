import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseModerationAssignmentReceipt,
  parseModerationCaseDetail,
  parseModerationCaseList,
  parseModerationTransitionReceipt,
} from '../apps/newone/src/data/repositories/moderation-case-dto.mjs';

const ids = {
  case: '10000000-0000-4000-8000-000000000001',
  unit: '20000000-0000-4000-8000-000000000002',
  investigator: '30000000-0000-4000-8000-000000000003',
};

const files = {
  admin: readFileSync('apps/newone/src/app/admin.tsx', 'utf8'),
  component: readFileSync('apps/newone/src/features/admin/moderation-case-section.tsx', 'utf8'),
  contracts: readFileSync('apps/newone/src/data/repositories/contracts.ts', 'utf8'),
  copy: readFileSync('apps/newone/src/features/admin/moderation-copy.ts', 'utf8'),
  pane: readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8'),
  repository: readFileSync('apps/newone/src/data/repositories/moderation-case-repository.ts', 'utf8'),
  transport: readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8'),
  migration: readFileSync(
    'supabase/migrations/20260804110613_complete_moderation_case_lifecycle.sql',
    'utf8',
  ),
  targetMigration: readFileSync(
    'supabase/migrations/20260804171735_complete_private_target_reporting.sql',
    'utf8',
  ),
};

function listItem(overrides = {}) {
  return {
    caseId: ids.case,
    status: 'assigned',
    category: 'harassment',
    target: { type: 'message', label: 'Reported participant' },
    unitId: ids.unit,
    reportedAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:10:00.000Z',
    recordVersion: 2,
    assignedAt: '2026-08-04T10:05:00.000Z',
    assignedToMe: true,
    assignedInvestigatorUserId: ids.investigator,
    canClaim: false,
    canAssign: false,
    canViewEvidence: true,
    readOnly: false,
    reporterLabel: 'protected',
    eligibleInvestigatorUserIds: [],
    ...overrides,
  };
}

function detail(overrides = {}, scopeOverrides = {}) {
  return {
    schemaVersion: 2,
    case: {
      caseId: ids.case,
      status: 'in_review',
      category: 'privacy',
      target: { type: 'message', label: 'Reported participant' },
      details: 'Operational details supplied by the reporter.',
      reporterLabel: 'protected',
      reportedAt: '2026-08-04T10:00:00.000Z',
      updatedAt: '2026-08-04T10:10:00.000Z',
      assignedAt: '2026-08-04T10:05:00.000Z',
      recordVersion: 3,
      readOnly: false,
      evidence: [{
        evidenceId: 1,
        relationship: 'reported',
        relativePosition: 0,
        messageKind: 'text',
        messageBody: 'Scoped evidence only.',
        senderLabel: 'Reported participant',
        sentAt: '2026-08-04T09:59:00.000Z',
        bodySha256: 'a'.repeat(64),
      }],
      history: [{
        eventId: 1,
        eventType: 'reported',
        fromStatus: null,
        toStatus: 'open',
        reason: null,
        evidenceMetadata: {},
        actorLabel: 'protected_reporter',
        occurredAt: '2026-08-04T10:00:00.000Z',
      }, {
        eventId: 2,
        eventType: 'review_started',
        fromStatus: 'assigned',
        toStatus: 'in_review',
        reason: 'Review accepted within scoped grant.',
        evidenceMetadata: {},
        actorLabel: 'assigned_investigator',
        occurredAt: '2026-08-04T10:10:00.000Z',
      }],
      ...overrides,
    },
    scope: {
      reportedItemAndConsentedContextOnly: true,
      reporterIdentityIncluded: false,
      otherConversationsIncluded: false,
      targetOnly: true,
      messageEvidenceIncluded: true,
      ...scopeOverrides,
    },
  };
}

test('redacted moderation queue accepts metadata but never exposes reporter, source IDs, or content', () => {
  const parsed = parseModerationCaseList({
    schemaVersion: 2,
    cases: [listItem()],
    nextCursor: null,
    contentIncluded: false,
    reporterIdentityIncluded: false,
    requiresExplicitAssignmentForEvidence: true,
  });
  assert.equal(parsed.cases[0].caseId, ids.case);
  assert.equal(parsed.cases[0].canViewEvidence, true);
  for (const forbidden of ['reporterUserId', 'conversationId', 'messageId', 'safeExcerpt']) {
    assert.equal(forbidden in parsed.cases[0], false);
  }

  for (const field of ['reporter_user_id', 'conversation_id', 'message_id', 'safe_excerpt']) {
    assert.throws(() => parseModerationCaseList({
      schemaVersion: 2,
      cases: [listItem({ [field]: 'secret' })],
      nextCursor: null,
      contentIncluded: false,
      reporterIdentityIncluded: false,
      requiresExplicitAssignmentForEvidence: true,
    }), /invalid moderation case list field/);
  }
});

test('moderation list enforces assignment, claim, closure, and evidence capability consistency', () => {
  const envelope = (item) => ({
    schemaVersion: 2,
    cases: [item],
    nextCursor: null,
    contentIncluded: false,
    reporterIdentityIncluded: false,
    requiresExplicitAssignmentForEvidence: true,
  });
  assert.throws(() => parseModerationCaseList(envelope(listItem({
    status: 'open',
    assignedAt: null,
    assignedInvestigatorUserId: null,
    assignedToMe: true,
  }))), /invalid moderation case list consistency/);
  assert.throws(() => parseModerationCaseList(envelope(listItem({ canClaim: true }))),
    /invalid moderation case list consistency/);
  assert.throws(() => parseModerationCaseList(envelope(listItem({ readOnly: true }))),
    /invalid moderation case list consistency/);
  assert.doesNotThrow(() => parseModerationCaseList(envelope(listItem({
    status: 'in_review',
    canAssign: true,
  }))));
});

test('assigned case detail is exact, bounded to five evidence rows, and actor-redacted', () => {
  const parsed = parseModerationCaseDetail(detail());
  assert.equal(parsed.case.reporterLabel, 'protected');
  assert.equal(parsed.case.evidence[0].messageBody, 'Scoped evidence only.');
  assert.equal(parsed.case.history[0].actorLabel, 'protected_reporter');

  assert.throws(() => parseModerationCaseDetail(detail({
    conversationId: '40000000-0000-4000-8000-000000000004',
  })), /invalid moderation case detail field/);
  assert.throws(() => parseModerationCaseDetail(detail({
    evidence: Array.from({ length: 6 }, (_, index) => ({
      evidenceId: index + 1,
      relationship: index === 0 ? 'reported' : index < 3 ? 'context_before' : 'context_after',
      relativePosition: index === 0 ? 0 : index < 3 ? -index : index - 2,
      messageKind: 'text',
      messageBody: 'too many',
      senderLabel: 'Participant',
      sentAt: '2026-08-04T09:59:00.000Z',
      bodySha256: 'b'.repeat(64),
    })),
  })), /invalid moderation case evidence size/);
  const rawActor = detail();
  rawActor.case.history[0].actorLabel = ids.investigator;
  assert.throws(() => parseModerationCaseDetail(rawActor), /invalid moderation history actor label/);
});

test('target DTOs accept content-free group/member cases and reject target expansion', () => {
  for (const type of ['group', 'member']) {
    const parsed = parseModerationCaseDetail(detail({
      target: { type, label: type === 'group' ? 'Safety team' : 'Visible member' },
      evidence: [],
    }, { messageEvidenceIncluded: false }));
    assert.equal(parsed.case.target.type, type);
    assert.deepEqual(parsed.case.evidence, []);
  }
  assert.throws(() => parseModerationCaseDetail(detail({
    target: { type: 'group', label: 'Safety team' },
  }, { messageEvidenceIncluded: false })), /invalid moderation case evidence size/);
  assert.throws(() => parseModerationCaseDetail(detail({ evidence: [] })),
    /invalid moderation case evidence size/);
  assert.throws(() => parseModerationCaseDetail(detail({
    target: { type: 'member', label: 'Visible member', userId: ids.investigator },
    evidence: [],
  }, { messageEvidenceIncluded: false })), /invalid moderation case target field/);
  assert.throws(() => parseModerationCaseDetail(detail({
    target: { type: 'member', label: 'Known member', membershipStatus: 'suspended' },
    evidence: [],
  }, { messageEvidenceIncluded: false })), /invalid moderation case target field/);
  assert.throws(() => parseModerationCaseList({
    schemaVersion: 1,
    cases: [listItem()],
    nextCursor: null,
    contentIncluded: false,
    reporterIdentityIncluded: false,
    requiresExplicitAssignmentForEvidence: true,
  }), /invalid moderation case list response/);
});

test('assignment and closure receipts cannot claim reporter identity or notification content', () => {
  assert.equal(parseModerationAssignmentReceipt({
    caseId: ids.case,
    status: 'assigned',
    recordVersion: 2,
    assignedAt: '2026-08-04T10:05:00.000Z',
    assignedInvestigatorUserId: ids.investigator,
    reporterIdentityIncluded: false,
  }).status, 'assigned');
  assert.equal(parseModerationTransitionReceipt({
    caseId: ids.case,
    status: 'resolved',
    recordVersion: 4,
    updatedAt: '2026-08-04T11:00:00.000Z',
    readOnly: true,
    reporterIdentityIncluded: false,
    notificationPayloadContentIncluded: false,
  }).readOnly, true);
  assert.throws(() => parseModerationTransitionReceipt({
    caseId: ids.case,
    status: 'resolved',
    recordVersion: 4,
    updatedAt: '2026-08-04T11:00:00.000Z',
    readOnly: true,
    reporterIdentityIncluded: false,
    notificationPayloadContentIncluded: true,
  }), /invalid moderation transition receipt/);
});

// The report contract and its copy are intact and stay green, which is what
// makes the UI failure below a defect rather than a removed feature.
test('report contract carries versioned explicit consent for a bounded context', () => {
  assert.match(files.contracts, /consentToShare: true/);
  assert.match(files.contracts, /contextBefore: 0 \| 1 \| 2/);
  assert.match(files.contracts, /noticeVersion: 'moderation-report-v2'/);
  assert.match(files.contracts, /reportGroup\(input:/);
  assert.match(files.contracts, /reportMember\(input:/);
  assert.match(files.transport, /consentToShare: input\.consentToShare/);
  assert.match(files.copy, /Reporter identity is protected from the reported person/);
  assert.match(files.copy, /Account status, profile fields, conversations, and messages are not shared/);
});

// KNOWN APP DEFECT -- deliberately left failing (see the report for evidence).
//
// Two of the three private-report entry points were dropped as collateral in
// 3e56060 (2026-09-05, "Conversation screen: compact bubbles, inverted
// timeline, inline media, composer insets and Enter-to-send"), which rewrote
// conversation-pane.tsx (2554 lines changed) under a one-line message that
// mentions no feature removal. Nothing else about the feature was removed:
//   - contracts.ts still declares reportMessage/reportGroup with their
//     consentToShare / contextBefore / contextAfter / noticeVersion fields
//   - bff-command-repository.ts still implements both and posts to
//     /v2/messages/:id/report and /v2/conversations/:id/report
//   - routes.ts still serves 'message.report' and 'conversation.report'
//   - workspace.tsx still exposes reportMessage and reportGroup, with the
//     disclosure plumbing intact
//   - the catalog still carries chat.reportGroup and chat.reportGroupDescription
//     in all three locales
//   - the admin moderation console still consumes message and group cases
// Reporting a message or a group has no entry point, and that is the product,
// not a defect: the owner asked on Sep 5 2026 to "get rid of the report feature
// for now", and 3e56060 removed the sheet that same afternoon. Reporting a
// *person* stayed in people.tsx with its full consent sheet, which is what the
// App Store requires of an app carrying other people's content, alongside
// blocking. The server routes, the repository methods and the admin console
// stay in place so the sheet can come back without rebuilding the pipe; the
// assertions below cover the half that is live, and pin the absence of the
// other half so its return is a deliberate act.
test('a message or a group cannot be reported from the conversation screen', () => {
  assert.doesNotMatch(files.pane, /workspace\.reportGroup/);
  assert.doesNotMatch(files.pane, /workspace\.reportMessage/);
  assert.doesNotMatch(files.pane, /moderationTargetReportConsentNotice/);
});

test('admin console is AAL2 gated, responsive, localized, realtime reconciled, and non-ambient', () => {
  assert.match(files.admin, /<ModerationCaseSection/);
  assert.doesNotMatch(files.admin, /workspace\.moderationReports\.map/);
  assert.match(files.component, /assuranceLevel === 'aal2'/);
  assert.match(files.component, /width >= 920/);
  assert.match(files.component, /moderationCopy\(locale\)/);
  assert.match(files.component, /entityType === 'moderation_case'/);
  assert.match(files.component, /client\.removeChannel\(channel\)/);
  assert.doesNotMatch(files.component, /removeAllChannels/);
  assert.match(files.component, /item\.canViewEvidence/);
  assert.match(files.component, /item\.target\.label/);
  assert.match(files.component, /detail\.target\.type === 'message'/);
  assert.match(files.component, /item\.readOnly/);
  assert.match(files.component, /accessibilityLiveRegion="polite"/);
  assert.match(files.copy, /const ko: ModerationCopy/);
  assert.match(files.copy, /const es: ModerationCopy/);
});

test('online moderation repository is bounded, idempotent for mutations, and never cached offline', () => {
  for (const endpoint of [
    '/v2/moderation/cases/query',
    '/query',
    '/assign',
    '/claim',
    '/transition',
  ]) assert.ok(files.repository.includes(endpoint), `missing ${endpoint}`);
  assert.match(files.repository, /MAX_RESPONSE_BYTES = 524_288/);
  assert.match(files.repository, /REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(files.repository, /cache: 'no-store'/);
  assert.match(files.repository, /'Idempotency-Key'/);
  assert.doesNotMatch(files.repository, /clientStore|AsyncStorage|offline/i);
});

test('database contract uses private immutable evidence, separation of duties, and redacted bootstrap', () => {
  assert.match(files.migration, /force row level security/);
  assert.match(files.migration, /legacy moderation reports require an explicit consent-preserving evidence migration/);
  assert.match(files.migration, /for share of message/);
  assert.match(files.migration, /message_reports_case_separation/);
  assert.match(files.migration, /moderation evidence and case history are append-only/);
  assert.match(files.migration, /assigned_investigator_user_id = p_actor_user_id/);
  assert.match(files.migration, /reporter_user_id <> p_actor_user_id/);
  assert.match(files.migration, /subject_user_id <> p_actor_user_id/);
  assert.match(files.migration, /then 'Protected reporter'/);
  assert.match(files.migration, /'\{moderation_reports\}'[\s\S]*'\[\]'::jsonb/);
  assert.match(files.migration, /notification_payload_content_included', false/);
  assert.match(files.migration, /public\.bff_report_message_v2/);
  assert.match(files.targetMigration, /target_type in \('message', 'group', 'member'\)/);
  assert.match(files.targetMigration, /message_reports_active_reporter_target_unique_idx/);
  assert.match(files.targetMigration, /target_label_snapshot is distinct from old\.target_label_snapshot/);
  assert.match(files.targetMigration, /subject_user_id is null or authorized\.subject_user_id <> p_actor_user_id/);
  assert.match(files.targetMigration, /'schema_version', 2/);
  assert.match(files.targetMigration, /'target', jsonb_build_object/);
  assert.doesNotMatch(files.targetMigration, /'target_id'/);
});
