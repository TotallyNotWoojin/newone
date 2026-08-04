const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const RECOVERY_CASE_STATUSES = Object.freeze([
  'awaiting_external_verification',
  'awaiting_approval',
  'approved',
  'executing',
  'completed',
  'rejected',
  'expired',
]);

export const RECOVERY_VERIFICATION_METHODS = Object.freeze([
  'in_person',
  'manager_callback',
  'hr_record_match',
  'approved_provider',
]);

const CASE_KEYS = new Set([
  'case_id',
  'organization_id',
  'target_user_id',
  'target_factor_id',
  'status',
  'request_reason',
  'privileged_target',
  'required_approvals',
  'approvals_recorded',
  'human_verification_recorded',
  'verification_method',
  'external_verification_performed_by_newone',
  'expires_at',
  'created_at',
  'updated_at',
  'completed_at',
]);

function invalid(label) {
  throw new Error(`invalid recovery ${label}`);
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(label);
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(label);
  }
}

function dataValue(value) {
  const root = objectValue(value, 'response');
  if (Object.prototype.hasOwnProperty.call(root, 'data')) {
    exactKeys(root, new Set(['data']), 'response envelope');
    return objectValue(root.data, 'response data');
  }
  return root;
}

function uuid(value, label) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(label);
  return value.toLowerCase();
}

function boundedText(value, label, minimum, maximum) {
  if (
    typeof value !== 'string' || value.length < minimum || value.length > maximum ||
    CONTROL_PATTERN.test(value)
  ) invalid(label);
  return value;
}

function dateTime(value, label) {
  const text = boundedText(value, label, 20, 64);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) ||
    Number.isNaN(Date.parse(text))
  ) invalid(label);
  return text;
}

function nullableDateTime(value, label) {
  return value === null ? null : dateTime(value, label);
}

function integer(value, label, maximum = 1000000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid(label);
  return value;
}

function boolean(value, label) {
  if (typeof value !== 'boolean') invalid(label);
  return value;
}

function oneOf(value, values, label) {
  if (!values.includes(value)) invalid(label);
  return value;
}

function parseCase(value) {
  const row = objectValue(value, 'case');
  exactKeys(row, CASE_KEYS, 'case field');
  const caseId = uuid(row.case_id, 'case id');
  const organizationId = uuid(row.organization_id, 'organization id');
  const targetUserId = uuid(row.target_user_id, 'target user');
  // Validate the exact factor binding but deliberately omit it from the UI DTO.
  uuid(row.target_factor_id, 'target factor');
  const status = oneOf(row.status, RECOVERY_CASE_STATUSES, 'case status');
  const requestReason = boundedText(row.request_reason, 'request reason', 10, 1000);
  const privilegedTarget = boolean(row.privileged_target, 'privileged target');
  const requiredApprovals = integer(row.required_approvals, 'required approvals', 2);
  const approvalsRecorded = integer(row.approvals_recorded, 'approval count', 2);
  const humanVerificationRecorded = boolean(
    row.human_verification_recorded,
    'verification state',
  );
  const verificationMethod = row.verification_method === null
    ? null
    : oneOf(row.verification_method, RECOVERY_VERIFICATION_METHODS, 'verification method');
  const performedByNewone = boolean(
    row.external_verification_performed_by_newone,
    'verification authority',
  );
  const expiresAt = dateTime(row.expires_at, 'expiry');
  const createdAt = dateTime(row.created_at, 'creation time');
  const updatedAt = dateTime(row.updated_at, 'update time');
  const completedAt = nullableDateTime(row.completed_at, 'completion time');

  if (
    performedByNewone || requiredApprovals !== (privilegedTarget ? 2 : 1) ||
    approvalsRecorded > requiredApprovals ||
    humanVerificationRecorded !== (verificationMethod !== null) ||
    (status === 'awaiting_external_verification' && (
      humanVerificationRecorded || approvalsRecorded !== 0
    )) ||
    (status === 'awaiting_approval' && (
      !humanVerificationRecorded || approvalsRecorded >= requiredApprovals
    )) ||
    (['approved', 'executing', 'completed'].includes(status) && (
      !humanVerificationRecorded || approvalsRecorded < requiredApprovals
    )) ||
    (status === 'completed') !== (completedAt !== null) ||
    Date.parse(expiresAt) <= Date.parse(createdAt) ||
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) invalid('case consistency');

  return {
    caseId,
    organizationId,
    targetUserId,
    status,
    requestReason,
    privilegedTarget,
    requiredApprovals,
    approvalsRecorded,
    humanVerificationRecorded,
    verificationMethod,
    expiresAt,
    createdAt,
    updatedAt,
    completedAt,
  };
}

export function parseRecoveryCaseList(value) {
  const data = dataValue(value);
  exactKeys(
    data,
    new Set(['schema_version', 'scope', 'cases', 'human_verification_policy']),
    'case list field',
  );
  if (data.schema_version !== 1 || !['self', 'organization'].includes(data.scope)) {
    invalid('case list metadata');
  }
  if (!Array.isArray(data.cases) || data.cases.length > 100) invalid('case list size');
  const policy = objectValue(data.human_verification_policy, 'verification policy');
  exactKeys(
    policy,
    new Set(['performed_by_newone', 'external_policy_required']),
    'verification policy field',
  );
  if (policy.performed_by_newone !== false || policy.external_policy_required !== true) {
    invalid('verification policy');
  }
  const cases = data.cases.map(parseCase);
  if (new Set(cases.map((item) => item.caseId)).size !== cases.length) {
    invalid('duplicate case');
  }
  return {
    schemaVersion: 1,
    scope: data.scope,
    cases,
    humanVerification: {
      performedByNewone: false,
      externalPolicyRequired: true,
    },
  };
}

export function parseVerifiedTotpFactors(value) {
  const data = dataValue(value);
  exactKeys(data, new Set(['factors']), 'factor list field');
  if (!Array.isArray(data.factors) || data.factors.length > 20) invalid('factor list');
  const factors = data.factors.map((entry) => {
    const factor = objectValue(entry, 'factor');
    exactKeys(
      factor,
      new Set(['id', 'type', 'status', 'friendlyName', 'createdAt', 'updatedAt']),
      'factor field',
    );
    const id = uuid(factor.id, 'factor id');
    if (factor.type !== 'totp') invalid('factor type');
    const status = oneOf(factor.status, ['unverified', 'verified'], 'factor status');
    const friendlyName = factor.friendlyName === null
      ? null
      : boundedText(factor.friendlyName, 'factor name', 1, 100);
    dateTime(factor.createdAt, 'factor creation time');
    dateTime(factor.updatedAt, 'factor update time');
    return { id, status, friendlyName };
  }).filter((factor) => factor.status === 'verified');
  if (new Set(factors.map((factor) => factor.id)).size !== factors.length) {
    invalid('duplicate factor');
  }
  return factors;
}

export function parseRecoveryCaseCreateReceipt(value) {
  const data = dataValue(value);
  exactKeys(
    data,
    new Set([
      'case_id', 'status', 'privileged_target', 'required_approvals',
      'approvals_recorded', 'human_verification', 'expires_at',
    ]),
    'case creation receipt field',
  );
  const caseId = uuid(data.case_id, 'case id');
  if (data.status !== 'awaiting_external_verification') invalid('creation status');
  const privilegedTarget = boolean(data.privileged_target, 'privileged target');
  const requiredApprovals = integer(data.required_approvals, 'required approvals', 2);
  if (
    requiredApprovals !== (privilegedTarget ? 2 : 1) ||
    integer(data.approvals_recorded, 'approval count', 2) !== 0
  ) invalid('creation approval policy');
  const policy = objectValue(data.human_verification, 'creation verification policy');
  exactKeys(
    policy,
    new Set([
      'performed_by_newone', 'external_policy_required',
      'evidence_reference_stored_as_hash',
    ]),
    'creation verification policy field',
  );
  if (
    policy.performed_by_newone !== false || policy.external_policy_required !== true ||
    policy.evidence_reference_stored_as_hash !== true
  ) invalid('creation verification policy');
  return {
    caseId,
    status: 'awaiting_external_verification',
    privilegedTarget,
    requiredApprovals,
    expiresAt: dateTime(data.expires_at, 'case expiry'),
  };
}

export function parseRecoveryVerificationReceipt(value) {
  const data = dataValue(value);
  exactKeys(
    data,
    new Set([
      'case_id', 'status', 'human_verification_recorded',
      'required_approvals', 'approvals_recorded',
    ]),
    'verification receipt field',
  );
  const requiredApprovals = integer(data.required_approvals, 'required approvals', 2);
  if (
    data.status !== 'awaiting_approval' || data.human_verification_recorded !== true ||
    integer(data.approvals_recorded, 'approval count', 2) !== 0 ||
    ![1, 2].includes(requiredApprovals)
  ) invalid('verification receipt');
  return {
    caseId: uuid(data.case_id, 'case id'),
    status: 'awaiting_approval',
    requiredApprovals,
  };
}

export function parseRecoveryApprovalReceipt(value) {
  const data = dataValue(value);
  exactKeys(
    data,
    new Set([
      'case_id', 'status', 'approval_recorded', 'approvals_recorded',
      'required_approvals', 'privileged_target',
    ]),
    'approval receipt field',
  );
  const status = oneOf(data.status, ['awaiting_approval', 'approved'], 'approval status');
  const privilegedTarget = boolean(data.privileged_target, 'privileged target');
  const requiredApprovals = integer(data.required_approvals, 'required approvals', 2);
  const approvalsRecorded = integer(data.approvals_recorded, 'approval count', 2);
  if (
    requiredApprovals !== (privilegedTarget ? 2 : 1) ||
    approvalsRecorded > requiredApprovals ||
    (status === 'approved') !== (approvalsRecorded >= requiredApprovals)
  ) invalid('approval receipt');
  return {
    caseId: uuid(data.case_id, 'case id'),
    status,
    approvalRecorded: boolean(data.approval_recorded, 'approval result'),
    approvalsRecorded,
    requiredApprovals,
  };
}

export function parseRecoveryRejectionReceipt(value) {
  const data = dataValue(value);
  exactKeys(data, new Set(['case_id', 'status']), 'rejection receipt field');
  if (data.status !== 'rejected') invalid('rejection status');
  return { caseId: uuid(data.case_id, 'case id'), status: 'rejected' };
}

export function parseRecoveryExecutionReceipt(value) {
  const data = dataValue(value);
  if (data.status === 'completed' && data.already_completed === true) {
    exactKeys(data, new Set(['case_id', 'status', 'already_completed']), 'retry receipt field');
    return {
      caseId: uuid(data.case_id, 'case id'),
      status: 'completed',
      alreadyCompleted: true,
      factorDeleted: null,
      allSessionsRevoked: null,
      securityNoticeState: null,
      sessionsRevoked: null,
      devicesRevoked: null,
    };
  }
  exactKeys(
    data,
    new Set([
      'case_id', 'status', 'completed', 'factor_deleted', 'all_sessions_revoked',
      'captured_sessions', 'auth_sessions_deleted_during_finalization',
      'session_bindings_revoked', 'devices_revoked', 'security_event_recorded',
      'security_notice_id', 'security_notice_state',
    ]),
    'execution receipt field',
  );
  if (
    data.status !== 'completed' || data.completed !== true || data.factor_deleted !== true ||
    data.all_sessions_revoked !== true || data.security_event_recorded !== true ||
    data.security_notice_state !== 'pending_external_delivery'
  ) invalid('execution receipt');
  integer(data.captured_sessions, 'captured session count');
  integer(data.auth_sessions_deleted_during_finalization, 'deleted session count');
  const sessionsRevoked = integer(data.session_bindings_revoked, 'revoked binding count');
  const devicesRevoked = integer(data.devices_revoked, 'revoked device count');
  if (
    !(
      (Number.isSafeInteger(data.security_notice_id) && data.security_notice_id > 0) ||
      (typeof data.security_notice_id === 'string' && /^[1-9][0-9]{0,18}$/.test(data.security_notice_id))
    )
  ) invalid('security notice id');
  return {
    caseId: uuid(data.case_id, 'case id'),
    status: 'completed',
    alreadyCompleted: false,
    factorDeleted: true,
    allSessionsRevoked: true,
    securityNoticeState: 'pending_external_delivery',
    sessionsRevoked,
    devicesRevoked,
  };
}

export function maskedRecoveryCaseReference(caseId) {
  const value = uuid(caseId, 'case id');
  return `••••${value.slice(-6).toUpperCase()}`;
}
