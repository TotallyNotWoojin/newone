import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  maskedRecoveryCaseReference,
  parseRecoveryApprovalReceipt,
  parseRecoveryCaseCreateReceipt,
  parseRecoveryCaseList,
  parseRecoveryExecutionReceipt,
  parseRecoveryRejectionReceipt,
  parseRecoveryVerificationReceipt,
  parseVerifiedTotpFactors,
} from '../apps/newone/src/data/repositories/recovery-case-dto.mjs';

const repository = readFileSync(
  'apps/newone/src/data/repositories/recovery-case-repository.ts',
  'utf8',
);
const section = readFileSync(
  'apps/newone/src/features/admin/account-recovery-section.tsx',
  'utf8',
);
const selfRequest = readFileSync(
  'apps/newone/src/features/security/self-recovery-request.tsx',
  'utf8',
);
const copy = readFileSync('apps/newone/src/features/admin/recovery-copy.ts', 'utf8');
const admin = readFileSync('apps/newone/src/app/admin.tsx', 'utf8');
const navigation = readFileSync(
  'apps/newone/src/components/navigation/app-scaffold.tsx',
  'utf8',
);
const adminAccess = readFileSync('apps/newone/src/features/admin/admin-access.ts', 'utf8');

const ids = {
  case: '10000000-0000-4000-8000-000000000001',
  organization: '20000000-0000-4000-8000-000000000002',
  target: '30000000-0000-4000-8000-000000000003',
  factor: '40000000-0000-4000-8000-000000000004',
};

function recoveryCase(overrides = {}) {
  return {
    case_id: ids.case,
    organization_id: ids.organization,
    target_user_id: ids.target,
    target_factor_id: ids.factor,
    status: 'awaiting_external_verification',
    request_reason: 'Authenticator was lost during an approved device replacement.',
    privileged_target: false,
    required_approvals: 1,
    approvals_recorded: 0,
    human_verification_recorded: false,
    verification_method: null,
    external_verification_performed_by_newone: false,
    expires_at: '2026-08-05T10:00:00.000Z',
    created_at: '2026-08-04T10:00:00.000Z',
    updated_at: '2026-08-04T10:00:00.000Z',
    completed_at: null,
    ...overrides,
  };
}

test('strict recovery list DTO omits bound factor identifiers from UI data', () => {
  const parsed = parseRecoveryCaseList({
    schema_version: 1,
    scope: 'organization',
    cases: [recoveryCase()],
    human_verification_policy: {
      performed_by_newone: false,
      external_policy_required: true,
    },
  });

  assert.equal(parsed.scope, 'organization');
  assert.equal(parsed.cases[0].caseId, ids.case);
  assert.equal(parsed.cases[0].targetUserId, ids.target);
  assert.equal('targetFactorId' in parsed.cases[0], false);
  assert.equal('target_factor_id' in parsed.cases[0], false);
  assert.equal(parsed.humanVerification.performedByNewone, false);
});

test('recovery DTO rejects unknown sensitive fields and inconsistent state', () => {
  assert.throws(() => parseRecoveryCaseList({
    schema_version: 1,
    scope: 'organization',
    cases: [recoveryCase({ verification_reference_hash: 'not-for-the-client' })],
    human_verification_policy: {
      performed_by_newone: false,
      external_policy_required: true,
    },
  }), /invalid recovery case field/);

  assert.throws(() => parseRecoveryCaseList({
    schema_version: 1,
    scope: 'organization',
    cases: [recoveryCase({ approvals_recorded: 2 })],
    human_verification_policy: {
      performed_by_newone: false,
      external_policy_required: true,
    },
  }), /invalid recovery case consistency/);

  assert.throws(() => parseRecoveryCaseList({
    schema_version: 1,
    scope: 'organization',
    cases: [recoveryCase({ case_id: 'not-a-uuid' })],
    human_verification_policy: {
      performed_by_newone: false,
      external_policy_required: true,
    },
  }), /invalid recovery case id/);
});

test('factor DTO accepts only bounded verified TOTP factors', () => {
  const factors = parseVerifiedTotpFactors({
    factors: [
      {
        id: ids.factor,
        type: 'totp',
        status: 'verified',
        friendlyName: 'Work phone',
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:01:00.000Z',
      },
      {
        id: '50000000-0000-4000-8000-000000000005',
        type: 'totp',
        status: 'unverified',
        friendlyName: null,
        createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-08-01T10:01:00.000Z',
      },
    ],
  });
  assert.deepEqual(factors, [{ id: ids.factor, status: 'verified', friendlyName: 'Work phone' }]);
});

test('all recovery transition receipts are validated without inventing delivery', () => {
  assert.deepEqual(parseRecoveryCaseCreateReceipt({
    case_id: ids.case,
    status: 'awaiting_external_verification',
    privileged_target: true,
    required_approvals: 2,
    approvals_recorded: 0,
    human_verification: {
      performed_by_newone: false,
      external_policy_required: true,
      evidence_reference_stored_as_hash: true,
    },
    expires_at: '2026-08-05T10:00:00.000Z',
  }).requiredApprovals, 2);
  assert.equal(parseRecoveryVerificationReceipt({
    case_id: ids.case,
    status: 'awaiting_approval',
    human_verification_recorded: true,
    required_approvals: 1,
    approvals_recorded: 0,
  }).status, 'awaiting_approval');
  assert.deepEqual(parseRecoveryApprovalReceipt({
    case_id: ids.case,
    status: 'approved',
    approval_recorded: true,
    approvals_recorded: 1,
    required_approvals: 1,
    privileged_target: false,
  }).approvalsRecorded, 1);
  assert.equal(parseRecoveryRejectionReceipt({
    case_id: ids.case,
    status: 'rejected',
  }).status, 'rejected');

  const firstExecution = parseRecoveryExecutionReceipt({
    case_id: ids.case,
    status: 'completed',
    completed: true,
    factor_deleted: true,
    all_sessions_revoked: true,
    captured_sessions: 3,
    auth_sessions_deleted_during_finalization: 2,
    session_bindings_revoked: 3,
    devices_revoked: 2,
    security_event_recorded: true,
    security_notice_id: 71,
    security_notice_state: 'pending_external_delivery',
  });
  assert.equal(firstExecution.securityNoticeState, 'pending_external_delivery');
  assert.equal(firstExecution.alreadyCompleted, false);

  const replay = parseRecoveryExecutionReceipt({
    case_id: ids.case,
    status: 'completed',
    already_completed: true,
  });
  assert.equal(replay.alreadyCompleted, true);
  assert.equal(replay.securityNoticeState, null);
  assert.throws(() => parseRecoveryExecutionReceipt({
    case_id: ids.case,
    status: 'completed',
    completed: true,
    factor_deleted: true,
    all_sessions_revoked: true,
    captured_sessions: 3,
    auth_sessions_deleted_during_finalization: 2,
    session_bindings_revoked: 3,
    devices_revoked: 2,
    security_event_recorded: true,
    security_notice_id: 71,
    security_notice_state: 'delivered',
  }), /invalid recovery execution receipt/);
});

test('case references are masked before display', () => {
  assert.equal(maskedRecoveryCaseReference(ids.case), '••••000001');
});

test('repository uses exact routed endpoints and bounded online-only transport', () => {
  for (const endpoint of [
    '/v2/auth/mfa/factors',
    '/v2/auth/recovery/cases/query',
    '/v2/auth/recovery/cases',
    '/verify',
    '/approve',
    '/reject',
    '/execute',
  ]) assert.ok(repository.includes(endpoint), `missing ${endpoint}`);
  // The web/native transport split moved behind usesCookieSession() (which is
  // Platform.OS === 'web' && the transport is not bearer), so web can be pinned
  // to bearer without cookies leaking onto it. The property is unchanged: one
  // decision drives credentials, CSRF, and the token requirement together.
  assert.match(repository, /const cookieSession = usesCookieSession\(\)/);
  assert.match(repository, /credentials: cookieSession \? 'include' : 'omit'/);
  assert.match(repository, /const csrfToken = cookieSession \? getWebCsrfToken\(\) : null/);
  assert.match(repository, /if \(cookieSession && !csrfToken\)/);
  assert.match(repository, /if \(!cookieSession && !accessToken\)/);
  assert.match(repository, /nativeEdgeRequestHeaders\(accessToken \?\? undefined\)/);
  assert.match(repository, /'Idempotency-Key'/);
  assert.match(repository, /MAX_RESPONSE_BYTES = 65_536/);
  assert.match(repository, /REQUEST_TIMEOUT_MS = 15_000/);
  assert.match(repository, /cache: 'no-store'/);
  assert.doesNotMatch(repository, /clientStore|AsyncStorage|outbox|offline/i);
});

test('admin UI is capability gated and preserves server-authoritative separation', () => {
  assert.match(admin, /hasCapability\('recovery\.manage'\)/);
  assert.match(admin, /<AccountRecoverySection/);
  assert.match(adminAccess, /'recovery\.manage'/);
  assert.equal((navigation.match(/canAccessAdminSurface\(workspace\.capabilities\)/g) ?? []).length, 2);
  assert.match(section, /assuranceLevel === 'aal2'/);
  assert.match(section, /item\.targetUserId === currentUserId/);
  assert.match(section, /awaiting_external_verification/);
  assert.match(section, /awaiting_approval/);
  assert.match(section, /\['approved', 'executing'\]/);
  assert.match(section, /setEvidenceReference\(value\.slice\(0, 500\)\)/);
  assert.match(section, /setRejectionReason\(value\.slice\(0, 500\)\)/);
  assert.match(section, /accessibilityLiveRegion="polite"/);
  assert.match(section, /maskedRecoveryCaseReference/);
  assert.doesNotMatch(section, /targetFactorId|target_factor_id|security_notice_id/);
});

test('self-service recovery is isolated from manager privileges and transitions', () => {
  assert.match(selfRequest, /export function SelfRecoveryRequest/);
  assert.match(selfRequest, /repository\.listVerifiedTotpFactors\(\)/);
  assert.match(selfRequest, /repository\.createCase\(/);
  assert.match(selfRequest, /value\.slice\(0, 1000\)/);
  assert.match(selfRequest, /requestReason\.trim\(\)\.length < 10/);
  assert.match(selfRequest, /createClientId\(\)/);
  assert.match(selfRequest, /idempotencyKey/);
  assert.match(selfRequest, /retryPayload \?\?/);
  assert.match(selfRequest, /setRetryPayload\(payload\)/);
  assert.match(selfRequest, /accessibilityLiveRegion="polite"/);
  assert.match(selfRequest, /copy\.selfServiceAal1/);
  assert.match(selfRequest, /copy\.sensitiveWarning/);
  assert.doesNotMatch(
    selfRequest,
    /\.listCases\(|\.recordVerification\(|\.approveCase\(|\.rejectCase\(|\.executeCase\(/,
  );
  assert.doesNotMatch(selfRequest, /recovery\.manage|assuranceLevel|aal2/);
  assert.match(section, /<SelfRecoveryRequest/);
});

test('recovery-specific safety and accessibility copy exists in English, Korean, and Spanish', () => {
  assert.match(copy, /const en =/);
  assert.match(copy, /const ko: RecoveryCopy =/);
  assert.match(copy, /const es: RecoveryCopy =/);
  assert.match(copy, /five minutes old/);
  assert.match(copy, /identity documents, one-time codes, authenticator secrets/);
  assert.match(copy, /immutable event log/);
  assert.match(copy, /queued for external delivery, not confirmed delivered/);
  assert.match(copy, /신분증 문서/);
  assert.match(copy, /documentos de identidad/);
});
