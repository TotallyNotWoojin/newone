import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Platform } from 'react-native';

import { BffSearchRepository } from '@/data/repositories/bff-search-repository';
import {
  ModerationCaseRepository,
  ModerationCaseRepositoryError,
} from '@/data/repositories/moderation-case-repository';
import {
  RecoveryCaseRepository,
  RecoveryCaseRepositoryError,
} from '@/data/repositories/recovery-case-repository';
import { RepositoryError } from '@/data/repositories/contracts';

const mockFetch = jest.fn<typeof fetch>();
const mockListFactors = jest.fn<() => Promise<unknown>>();
let mockApiBase: string | null = 'https://api.newone.test';
let mockUrlEnabled = true;
let mockHeadersEnabled = true;
let mockCsrfToken: string | null = 'controlled-csrf-token';
let mockSupabaseClient: unknown;

jest.mock('@/config/runtime', () => ({
  apiUrlFor: (path: string) => mockApiBase && mockUrlEnabled
    ? `${mockApiBase}${path}`
    : null,
  nativeEdgeRequestHeaders: (token?: string | null) => {
    if (!mockHeadersEnabled) return null;
    return token
      ? { Authorization: `Bearer ${token}`, apikey: 'controlled-publishable-key' }
      : {};
  },
  publicRuntimeConfig: {
    get apiUrl() {
      return mockApiBase;
    },
    supabase: {
      url: 'https://project.supabase.co',
      publishableKey: 'controlled-publishable-key',
    },
  },
}));

jest.mock('@/lib/web-auth', () => ({
  getWebCsrfToken: () => mockCsrfToken,
}));

jest.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => mockSupabaseClient,
}));

const originalPlatform = Platform.OS;

function setPlatform(value: 'ios' | 'web') {
  Object.defineProperty(Platform, 'OS', { configurable: true, value });
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function rawResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

const ids = {
  recoveryCase: '10000000-0000-4000-8000-000000000001',
  organization: '20000000-0000-4000-8000-000000000002',
  target: '30000000-0000-4000-8000-000000000003',
  factor: '40000000-0000-4000-8000-000000000004',
  alternateCase: '50000000-0000-4000-8000-000000000005',
  moderationCase: '60000000-0000-4000-8000-000000000006',
  unit: '70000000-0000-4000-8000-000000000007',
  investigator: '80000000-0000-4000-8000-000000000008',
  conversation: '90000000-0000-4000-8000-000000000009',
  sender: 'a0000000-0000-4000-8000-00000000000a',
  idempotency: 'b0000000-0000-4000-8000-00000000000b',
};

const at = {
  created: '2026-08-04T10:00:00.000Z',
  assigned: '2026-08-04T10:05:00.000Z',
  updated: '2026-08-04T10:10:00.000Z',
  completed: '2026-08-04T11:00:00.000Z',
  expires: '2026-08-05T10:00:00.000Z',
};

function recoveryCase(overrides: Record<string, unknown> = {}) {
  return {
    case_id: ids.recoveryCase,
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
    expires_at: at.expires,
    created_at: at.created,
    updated_at: at.created,
    completed_at: null,
    ...overrides,
  };
}

function recoveryList(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    scope: 'organization',
    cases: [recoveryCase()],
    human_verification_policy: {
      performed_by_newone: false,
      external_policy_required: true,
    },
    ...overrides,
  };
}

function recoveryCreateReceipt(overrides: Record<string, unknown> = {}) {
  return {
    case_id: ids.recoveryCase,
    status: 'awaiting_external_verification',
    privileged_target: false,
    required_approvals: 1,
    approvals_recorded: 0,
    human_verification: {
      performed_by_newone: false,
      external_policy_required: true,
      evidence_reference_stored_as_hash: true,
    },
    expires_at: at.expires,
    ...overrides,
  };
}

function recoveryVerificationReceipt(overrides: Record<string, unknown> = {}) {
  return {
    case_id: ids.recoveryCase,
    status: 'awaiting_approval',
    human_verification_recorded: true,
    required_approvals: 1,
    approvals_recorded: 0,
    ...overrides,
  };
}

function recoveryApprovalReceipt(overrides: Record<string, unknown> = {}) {
  return {
    case_id: ids.recoveryCase,
    status: 'approved',
    approval_recorded: true,
    approvals_recorded: 1,
    required_approvals: 1,
    privileged_target: false,
    ...overrides,
  };
}

function recoveryExecutionReceipt(overrides: Record<string, unknown> = {}) {
  return {
    case_id: ids.recoveryCase,
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
    ...overrides,
  };
}

function moderationListItem(overrides: Record<string, unknown> = {}) {
  return {
    caseId: ids.moderationCase,
    status: 'assigned',
    category: 'harassment',
    target: { type: 'message', label: 'Reported participant' },
    unitId: ids.unit,
    reportedAt: at.created,
    updatedAt: at.updated,
    recordVersion: 2,
    assignedAt: at.assigned,
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

function moderationList(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    cases: [moderationListItem()],
    nextCursor: null,
    contentIncluded: false,
    reporterIdentityIncluded: false,
    requiresExplicitAssignmentForEvidence: true,
    ...overrides,
  };
}

function moderationDetail(caseOverrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    case: {
      caseId: ids.moderationCase,
      status: 'in_review',
      category: 'privacy',
      target: { type: 'message', label: 'Reported participant' },
      details: 'Operational details supplied by the reporter.',
      reporterLabel: 'protected',
      reportedAt: at.created,
      updatedAt: at.updated,
      assignedAt: at.assigned,
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
        occurredAt: at.created,
      }, {
        eventId: 2,
        eventType: 'review_started',
        fromStatus: 'assigned',
        toStatus: 'in_review',
        reason: 'Review accepted within scoped grant.',
        evidenceMetadata: {},
        actorLabel: 'assigned_investigator',
        occurredAt: at.updated,
      }],
      ...caseOverrides,
    },
    scope: {
      reportedItemAndConsentedContextOnly: true,
      reporterIdentityIncluded: false,
      otherConversationsIncluded: false,
      targetOnly: true,
      messageEvidenceIncluded: true,
    },
  };
}

function assignmentReceipt(overrides: Record<string, unknown> = {}) {
  return {
    caseId: ids.moderationCase,
    status: 'assigned',
    recordVersion: 2,
    assignedAt: at.assigned,
    assignedInvestigatorUserId: ids.investigator,
    reporterIdentityIncluded: false,
    ...overrides,
  };
}

function transitionReceipt(overrides: Record<string, unknown> = {}) {
  return {
    caseId: ids.moderationCase,
    status: 'resolved',
    recordVersion: 4,
    updatedAt: at.completed,
    readOnly: true,
    reporterIdentityIncluded: false,
    notificationPayloadContentIncluded: false,
    ...overrides,
  };
}

function recoveryRepository(token: string | null = 'controlled-access-token') {
  return new RecoveryCaseRepository(async () => token);
}

function moderationRepository(token: string | null = 'controlled-access-token') {
  return new ModerationCaseRepository(async () => token);
}

function searchRepository(session: { access_token: string } | null = {
  access_token: 'controlled-access-token',
}) {
  return new BffSearchRepository({ getSession: async () => session as never });
}

beforeEach(() => {
  setPlatform('ios');
  mockApiBase = 'https://api.newone.test';
  mockUrlEnabled = true;
  mockHeadersEnabled = true;
  mockCsrfToken = 'controlled-csrf-token';
  mockSupabaseClient = { auth: { mfa: { listFactors: mockListFactors } } };
  mockListFactors.mockResolvedValue({ data: { all: [] }, error: null } as never);
  mockFetch.mockImplementation(async () => jsonResponse({ data: {} }));
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterAll(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
});

describe('RecoveryCaseRepository real contract boundary', () => {
  test('executes every recovery lifecycle route with authenticated, idempotent, no-store requests', async () => {
    const repository = recoveryRepository();
    mockFetch
      .mockImplementationOnce(async () => jsonResponse({ data: recoveryList() }))
      .mockImplementationOnce(async () => jsonResponse(recoveryCreateReceipt()))
      .mockImplementationOnce(async () => jsonResponse({ data: recoveryVerificationReceipt() }))
      .mockImplementationOnce(async () => jsonResponse(recoveryApprovalReceipt()))
      .mockImplementationOnce(async () => jsonResponse({ data: {
        case_id: ids.recoveryCase,
        status: 'rejected',
      } }))
      .mockImplementationOnce(async () => jsonResponse(recoveryExecutionReceipt()));

    await expect(repository.listCases(ids.organization)).resolves.toMatchObject({
      schemaVersion: 1,
      scope: 'organization',
      cases: [{ caseId: ids.recoveryCase, targetUserId: ids.target }],
      humanVerification: { performedByNewone: false, externalPolicyRequired: true },
    });
    await expect(repository.createCase({
      organizationId: ids.organization,
      factorId: ids.factor,
      reason: '  Approved replacement after verified device loss.  ',
      idempotencyKey: ids.idempotency,
    })).resolves.toMatchObject({
      caseId: ids.recoveryCase,
      status: 'awaiting_external_verification',
      requiredApprovals: 1,
    });
    await expect(repository.recordVerification({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      method: 'manager_callback',
      evidenceReference: '  verifier-record-2026-08-04  ',
      idempotencyKey: ids.idempotency,
    })).resolves.toEqual({
      caseId: ids.recoveryCase,
      status: 'awaiting_approval',
      requiredApprovals: 1,
    });
    await expect(repository.approveCase({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      idempotencyKey: ids.idempotency,
    })).resolves.toMatchObject({ status: 'approved', approvalsRecorded: 1 });
    await expect(repository.rejectCase({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      reason: '  Identity record mismatch.  ',
      idempotencyKey: ids.idempotency,
    })).resolves.toEqual({ caseId: ids.recoveryCase, status: 'rejected' });
    await expect(repository.executeCase({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      idempotencyKey: ids.idempotency,
    })).resolves.toMatchObject({
      caseId: ids.recoveryCase,
      status: 'completed',
      alreadyCompleted: false,
      securityNoticeState: 'pending_external_delivery',
    });

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.newone.test/v2/auth/recovery/cases/query',
      'https://api.newone.test/v2/auth/recovery/cases',
      `https://api.newone.test/v2/auth/recovery/cases/${ids.recoveryCase}/verify`,
      `https://api.newone.test/v2/auth/recovery/cases/${ids.recoveryCase}/approve`,
      `https://api.newone.test/v2/auth/recovery/cases/${ids.recoveryCase}/reject`,
      `https://api.newone.test/v2/auth/recovery/cases/${ids.recoveryCase}/execute`,
    ]);
    const [, createInit] = mockFetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(createInit).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(createInit.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer controlled-access-token',
      apikey: 'controlled-publishable-key',
      'Idempotency-Key': ids.idempotency,
    });
    expect(JSON.parse(String(createInit.body))).toEqual({
      organizationId: ids.organization,
      factorId: ids.factor,
      reason: 'Approved replacement after verified device loss.',
    });
    expect(JSON.parse(String((mockFetch.mock.calls[2]![1] as RequestInit).body)))
      .toMatchObject({ method: 'manager_callback', evidenceReference: 'verifier-record-2026-08-04' });
    expect(JSON.parse(String((mockFetch.mock.calls[4]![1] as RequestInit).body)))
      .toMatchObject({ reason: 'Identity record mismatch.' });
  });

  test('uses native Supabase only for factor discovery and contains malformed parser errors', async () => {
    mockListFactors.mockResolvedValueOnce({
      data: {
        all: [{
          id: ids.factor,
          factor_type: 'totp',
          status: 'verified',
          friendly_name: 'Work authenticator',
          created_at: at.created,
          updated_at: at.updated,
        }, {
          id: ids.alternateCase,
          factor_type: 'totp',
          status: 'unverified',
          friendly_name: undefined,
          created_at: at.created,
          updated_at: at.updated,
        }],
      },
      error: null,
    } as never);
    await expect(recoveryRepository().listVerifiedTotpFactors()).resolves.toEqual([{
      id: ids.factor,
      status: 'verified',
      friendlyName: 'Work authenticator',
    }]);
    expect(mockFetch).not.toHaveBeenCalled();

    mockListFactors.mockResolvedValueOnce({ data: { all: [] }, error: { message: 'denied' } } as never);
    await expect(recoveryRepository().listVerifiedTotpFactors()).rejects.toMatchObject({
      code: 'factor_list_failed', retryable: true,
    });

    mockSupabaseClient = null;
    await expect(recoveryRepository().listVerifiedTotpFactors()).rejects.toMatchObject({
      code: 'service_unconfigured', retryable: false,
    });

    mockSupabaseClient = { auth: { mfa: { listFactors: mockListFactors } } };
    mockListFactors.mockResolvedValueOnce({
      data: {
        all: [{
          id: 'not-a-uuid',
          factor_type: 'totp',
          status: 'verified',
          friendly_name: null,
          created_at: at.created,
          updated_at: at.updated,
        }],
      },
      error: null,
    } as never);
    await expect(recoveryRepository().listVerifiedTotpFactors()).rejects.toEqual(
      expect.objectContaining({
        name: 'RecoveryCaseRepositoryError',
        code: 'invalid_response',
        retryable: true,
      }),
    );
  });

  test('uses the cookie-bound web route for factors without requiring a bearer token', async () => {
    setPlatform('web');
    mockFetch.mockImplementationOnce(async () => jsonResponse({ data: { factors: [{
      id: ids.factor,
      type: 'totp',
      status: 'verified',
      friendlyName: null,
      createdAt: at.created,
      updatedAt: at.updated,
    }] } }));

    await expect(recoveryRepository(null).listVerifiedTotpFactors()).resolves.toEqual([{
      id: ids.factor,
      status: 'verified',
      friendlyName: null,
    }]);
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.newone.test/v2/auth/mfa/factors');
    expect(init).toMatchObject({ credentials: 'include', cache: 'no-store' });
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'controlled-csrf-token' });
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  test('rejects invalid identifiers, text, methods, and idempotency keys before transport', async () => {
    const repository = recoveryRepository();
    const create = (overrides: Record<string, unknown> = {}) => repository.createCase({
      organizationId: ids.organization,
      factorId: ids.factor,
      reason: 'A sufficiently detailed recovery reason.',
      idempotencyKey: ids.idempotency,
      ...overrides,
    } as never);

    expect(() => create({ organizationId: 'not-a-uuid' })).toThrow(
      expect.objectContaining({ code: 'invalid_organization_id', retryable: false }),
    );
    expect(() => create({ factorId: 'not-a-uuid' })).toThrow(
      expect.objectContaining({ code: 'invalid_factor_id' }),
    );
    expect(() => create({ reason: 'short' })).toThrow(expect.objectContaining({ code: 'invalid_reason' }));
    expect(() => create({ reason: 'x'.repeat(1001) })).toThrow(
      expect.objectContaining({ code: 'invalid_reason' }),
    );
    expect(() => create({ reason: 'valid reason\u0007with control' })).toThrow(
      expect.objectContaining({ code: 'invalid_reason' }),
    );
    await expect(create({ idempotencyKey: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'invalid_idempotency_key', retryable: false,
    });
    await expect(repository.recordVerification({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      method: 'sms' as never,
      evidenceReference: 'verifier-record-123',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_verification_method' });
    await expect(repository.recordVerification({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      method: 'in_person',
      evidenceReference: 'tiny',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_evidence_reference' });
    await expect(repository.rejectCase({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      reason: 'x\u0000y',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_rejection_reason' });
    await expect(repository.approveCase({
      organizationId: 'invalid',
      caseId: ids.recoveryCase,
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_organization_id' });
    await expect(repository.executeCase({
      organizationId: ids.organization,
      caseId: 'invalid',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_case_id' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('fails closed for configuration, native auth, web CSRF, routing, and header failures', async () => {
    mockApiBase = null;
    await expect(recoveryRepository().listCases(ids.organization)).rejects.toMatchObject({
      code: 'service_unconfigured', retryable: false,
    });

    mockApiBase = 'https://api.newone.test';
    await expect(recoveryRepository(null).listCases(ids.organization)).rejects.toMatchObject({
      code: 'authentication_required', retryable: false,
    });

    setPlatform('web');
    mockCsrfToken = null;
    await expect(recoveryRepository(null).listCases(ids.organization)).rejects.toMatchObject({
      code: 'csrf_required', retryable: false,
    });

    mockCsrfToken = 'controlled-csrf-token';
    mockUrlEnabled = false;
    await expect(recoveryRepository(null).listCases(ids.organization)).rejects.toMatchObject({
      code: 'service_unconfigured', retryable: false,
    });

    mockUrlEnabled = true;
    mockHeadersEnabled = false;
    await expect(recoveryRepository(null).listCases(ids.organization)).rejects.toMatchObject({
      code: 'service_unconfigured', retryable: false,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('bounds response media type, declared size, actual UTF-8 size, JSON, and network failures', async () => {
    const invoke = () => recoveryRepository().listCases(ids.organization);

    mockFetch.mockImplementationOnce(async () => rawResponse('{}'));
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_response', retryable: true, status: 200 });

    mockFetch.mockImplementationOnce(async () => rawResponse('{}', 200, { 'content-type': 'text/plain' }));
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_response', retryable: true, status: 200 });

    for (const declared of ['not-a-number', '-1', '65537']) {
      mockFetch.mockImplementationOnce(async () => rawResponse('{}', 200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': declared,
      }));
      await expect(invoke()).rejects.toMatchObject({ code: 'response_too_large', retryable: true });
    }

    mockFetch.mockImplementationOnce(async () => rawResponse(
      JSON.stringify({ padding: `é한😀${'é'.repeat(40_000)}` }),
      200,
      { 'content-type': 'application/json' },
    ));
    await expect(invoke()).rejects.toMatchObject({ code: 'response_too_large', retryable: true });

    mockFetch.mockImplementationOnce(async () => rawResponse('{broken', 200, {
      'content-type': 'application/problem+json; charset=utf-8',
    }));
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_response', retryable: true });

    mockFetch.mockRejectedValueOnce(new TypeError('controlled network loss'));
    await expect(invoke()).rejects.toMatchObject({ code: 'network_unavailable', retryable: true });
  });

  test.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [400, false],
  ])('classifies HTTP %i retryability without exposing upstream text', async (status, retryable) => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({
      error: {
        code: status === 400 ? 'invalid recovery code !' : 'rate_limited',
        correlationId: status === 400 ? 'invalid correlation !' : 'correlation-123',
        detail: 'private upstream diagnostic',
        note: 'é한😀',
      },
    }, status, { 'content-type': 'application/problem+json' }));

    const rejection = recoveryRepository().listCases(ids.organization);
    await expect(rejection).rejects.toEqual(expect.objectContaining({
      name: 'RecoveryCaseRepositoryError',
      code: status === 400 ? `http_${status}` : 'rate_limited',
      retryable,
      correlationId: status === 400 ? undefined : 'correlation-123',
      status,
      message: 'The secure account-recovery request could not be completed.',
    }));
  });

  test('accepts direct problem envelopes and a safe declared response length', async () => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({
      code: 'recovery_denied',
      correlationId: 'direct-correlation',
    }, 403, { 'content-length': '80' }));
    await expect(recoveryRepository().listCases(ids.organization)).rejects.toMatchObject({
      code: 'recovery_denied',
      correlationId: 'direct-correlation',
      retryable: false,
      status: 403,
    });

    mockFetch.mockImplementationOnce(async () => jsonResponse([], 400));
    await expect(recoveryRepository().listCases(ids.organization)).rejects.toMatchObject({
      code: 'http_400', correlationId: undefined,
    });
  });

  test('rejects malformed and cross-boundary recovery receipts', async () => {
    const repository = recoveryRepository();
    mockFetch
      .mockImplementationOnce(async () => jsonResponse({ data: {} }))
      .mockImplementationOnce(async () => jsonResponse(recoveryList({ scope: 'self' })))
      .mockImplementationOnce(async () => jsonResponse(recoveryList({
        cases: [recoveryCase({ organization_id: ids.target })],
      })))
      .mockImplementationOnce(async () => jsonResponse(recoveryVerificationReceipt({ case_id: ids.alternateCase })))
      .mockImplementationOnce(async () => jsonResponse(recoveryApprovalReceipt({ case_id: ids.alternateCase })))
      .mockImplementationOnce(async () => jsonResponse({ case_id: ids.alternateCase, status: 'rejected' }))
      .mockImplementationOnce(async () => jsonResponse(recoveryExecutionReceipt({ case_id: ids.alternateCase })));

    await expect(repository.listCases(ids.organization)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(repository.listCases(ids.organization)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(repository.listCases(ids.organization)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(repository.recordVerification({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      method: 'approved_provider',
      evidenceReference: 'provider-reference-123',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(repository.approveCase({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(repository.rejectCase({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      reason: 'Rejected after verification.',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(repository.executeCase({
      organizationId: ids.organization,
      caseId: ids.recoveryCase,
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('ModerationCaseRepository real contract boundary', () => {
  test('queries redacted cases and executes read, assignment, claim, and transition routes', async () => {
    const repository = moderationRepository();
    const cursor = { beforeUpdatedAt: at.updated, beforeCaseId: ids.moderationCase };
    mockFetch
      .mockImplementationOnce(async () => jsonResponse({ data: moderationList({
        nextCursor: cursor,
      }) }))
      .mockImplementationOnce(async () => jsonResponse(moderationDetail()))
      .mockImplementationOnce(async () => jsonResponse({ data: assignmentReceipt() }))
      .mockImplementationOnce(async () => jsonResponse(assignmentReceipt()))
      .mockImplementationOnce(async () => jsonResponse({ data: transitionReceipt({
        status: 'in_review',
        readOnly: false,
      }) }))
      .mockImplementationOnce(async () => jsonResponse(transitionReceipt()));

    const list = await repository.queryCases({
      organizationId: ids.organization,
      statuses: ['assigned', 'assigned', 'in_review'],
      cursor,
      limit: 25,
    });
    expect(list).toMatchObject({
      schemaVersion: 2,
      cases: [{
        caseId: ids.moderationCase,
        canViewEvidence: true,
      }],
      nextCursor: cursor,
    });
    expect(list.cases[0]).not.toHaveProperty('reporterLabel');
    await expect(repository.readCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
    })).resolves.toMatchObject({
      caseId: ids.moderationCase,
      status: 'in_review',
      reporterLabel: 'protected',
      evidence: [{ relationship: 'reported', messageBody: 'Scoped evidence only.' }],
    });
    await expect(repository.assignCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      investigatorUserId: ids.investigator,
      expectedVersion: 1,
      reason: '  Assigned for scoped investigation.  ',
      idempotencyKey: ids.idempotency,
    })).resolves.toMatchObject({
      caseId: ids.moderationCase,
      status: 'assigned',
      assignedInvestigatorUserId: ids.investigator,
    });
    await expect(repository.claimCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      expectedVersion: 2,
      reason: '  Investigator accepted the case.  ',
      idempotencyKey: ids.idempotency,
    })).resolves.toMatchObject({ status: 'assigned' });
    await expect(repository.transitionCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      status: 'in_review',
      expectedVersion: 2,
      reason: '  Scoped review started.  ',
      idempotencyKey: ids.idempotency,
    })).resolves.toMatchObject({ status: 'in_review', readOnly: false });
    await expect(repository.transitionCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      status: 'resolved',
      expectedVersion: 3,
      reason: '  Evidence verified against policy.  ',
      evidenceMetadata: {
        referenceIds: ['report-001', 'review-002'],
        policyCode: 'SAFETY.HARASSMENT:2',
        severity: 'high',
      },
      idempotencyKey: ids.idempotency,
    })).resolves.toMatchObject({ status: 'resolved', readOnly: true });

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://api.newone.test/v2/moderation/cases/query',
      `https://api.newone.test/v2/moderation/cases/${ids.moderationCase}/query`,
      `https://api.newone.test/v2/moderation/cases/${ids.moderationCase}/assign`,
      `https://api.newone.test/v2/moderation/cases/${ids.moderationCase}/claim`,
      `https://api.newone.test/v2/moderation/cases/${ids.moderationCase}/transition`,
      `https://api.newone.test/v2/moderation/cases/${ids.moderationCase}/transition`,
    ]);
    expect(JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      organizationId: ids.organization,
      statuses: ['assigned', 'in_review'],
      cursor,
      limit: 25,
    });
    const [, assignInit] = mockFetch.mock.calls[2] as unknown as [string, RequestInit];
    expect(assignInit).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(assignInit.headers).toMatchObject({
      Authorization: 'Bearer controlled-access-token',
      apikey: 'controlled-publishable-key',
      'Idempotency-Key': ids.idempotency,
    });
    expect(JSON.parse(String(assignInit.body))).toMatchObject({
      investigatorUserId: ids.investigator,
      expectedVersion: 1,
      reason: 'Assigned for scoped investigation.',
    });
    expect(JSON.parse(String((mockFetch.mock.calls[5]![1] as RequestInit).body))).toEqual({
      organizationId: ids.organization,
      status: 'resolved',
      expectedVersion: 3,
      reason: 'Evidence verified against policy.',
      evidenceMetadata: {
        referenceIds: ['report-001', 'review-002'],
        policyCode: 'SAFETY.HARASSMENT:2',
        severity: 'high',
      },
    });
  });

  test('omits absent pagination and evidence fields while supporting each evidence field independently', async () => {
    const repository = moderationRepository();
    mockFetch
      .mockImplementationOnce(async () => jsonResponse(moderationList()))
      .mockImplementationOnce(async () => jsonResponse(transitionReceipt({ status: 'dismissed' })))
      .mockImplementationOnce(async () => jsonResponse(transitionReceipt({ status: 'dismissed' })))
      .mockImplementationOnce(async () => jsonResponse(transitionReceipt({ status: 'dismissed' })));

    await repository.queryCases({
      organizationId: ids.organization,
      statuses: ['open'],
    });
    await repository.transitionCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      status: 'dismissed',
      expectedVersion: 2,
      reason: 'Reference evidence reviewed.',
      evidenceMetadata: { referenceIds: ['reference-a'] },
      idempotencyKey: ids.idempotency,
    });
    await repository.transitionCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      status: 'dismissed',
      expectedVersion: 2,
      reason: 'Policy evidence reviewed.',
      evidenceMetadata: { policyCode: 'POLICY-2' },
      idempotencyKey: ids.idempotency,
    });
    await repository.transitionCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      status: 'dismissed',
      expectedVersion: 2,
      reason: 'Severity evidence reviewed.',
      evidenceMetadata: { severity: 'critical' },
      idempotencyKey: ids.idempotency,
    });

    expect(JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      organizationId: ids.organization,
      statuses: ['open'],
      limit: 50,
    });
  });

  test('rejects invalid queue, identifiers, reasons, and evidence locally', async () => {
    const repository = moderationRepository();
    expect(() => repository.queryCases({ organizationId: ids.organization, statuses: [] }))
      .toThrow(expect.objectContaining({ code: 'invalid_statuses', retryable: false }));
    expect(() => repository.queryCases({
      organizationId: ids.organization,
      statuses: ['open', 'assigned', 'in_review', 'resolved', 'dismissed', 'other'] as never,
    })).toThrow(expect.objectContaining({ code: 'invalid_statuses' }));
    expect(() => repository.queryCases({ organizationId: 'invalid', statuses: ['open'] }))
      .toThrow(expect.objectContaining({ code: 'invalid_organization_id' }));
    expect(() => repository.queryCases({
      organizationId: ids.organization,
      statuses: ['open'],
      cursor: { beforeUpdatedAt: at.updated, beforeCaseId: 'invalid' },
    })).toThrow(expect.objectContaining({ code: 'invalid_cursor_case_id' }));

    const transition = (evidenceMetadata: unknown, status: 'resolved' | 'in_review' = 'resolved') => (
      repository.transitionCase({
        organizationId: ids.organization,
        caseId: ids.moderationCase,
        status,
        expectedVersion: 2,
        reason: 'Evidence review completed.',
        evidenceMetadata: evidenceMetadata as never,
        idempotencyKey: ids.idempotency,
      })
    );
    await expect(transition(undefined)).rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ referenceIds: Array.from({ length: 21 }, (_, index) => `ref-${index}`) }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ referenceIds: ['same', 'same'] }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ referenceIds: [''] }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ referenceIds: ['x'.repeat(121)] }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ referenceIds: ['bad\u0000reference'] }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ policyCode: 'not valid code' }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ policyCode: 'x' }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(transition({ severity: 'urgent' }))
      .rejects.toMatchObject({ code: 'invalid_evidence' });
    mockFetch.mockImplementationOnce(async () => jsonResponse(transitionReceipt({
      status: 'in_review',
      readOnly: false,
    })));
    await expect(transition({}, 'in_review')).resolves.toMatchObject({
      status: 'in_review', readOnly: false,
    });

    await expect(repository.assignCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      investigatorUserId: ids.investigator,
      expectedVersion: 1,
      reason: 'x\u0007y',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_reason' });
    await expect(repository.claimCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      expectedVersion: 1,
      reason: 'xy',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_reason' });
    await expect(repository.transitionCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      status: 'in_review',
      expectedVersion: 1,
      reason: 'x'.repeat(2001),
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_reason' });
    await expect(repository.readCase({
      organizationId: ids.organization,
      caseId: 'invalid',
    })).rejects.toMatchObject({ code: 'invalid_case_id' });
    await expect(repository.assignCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      investigatorUserId: 'invalid',
      expectedVersion: 1,
      reason: 'Valid assignment reason.',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_investigator_user_id' });
    await expect(repository.claimCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      expectedVersion: 1,
      reason: 'Valid claim reason.',
      idempotencyKey: 'invalid',
    })).rejects.toMatchObject({ code: 'invalid_idempotency_key' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('fails closed for configuration, authentication, CSRF, URL, and edge headers', async () => {
    mockApiBase = null;
    await expect(moderationRepository().readCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
    })).rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });

    mockApiBase = 'https://api.newone.test';
    await expect(moderationRepository(null).readCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
    })).rejects.toMatchObject({ code: 'authentication_required', retryable: false });

    setPlatform('web');
    mockCsrfToken = null;
    await expect(moderationRepository(null).readCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
    })).rejects.toMatchObject({ code: 'csrf_required', retryable: false });

    mockCsrfToken = 'controlled-csrf-token';
    mockUrlEnabled = false;
    await expect(moderationRepository(null).readCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
    })).rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });

    mockUrlEnabled = true;
    mockHeadersEnabled = false;
    await expect(moderationRepository(null).readCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
    })).rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('uses cookie-bound web transport and accepts problem+json failures safely', async () => {
    setPlatform('web');
    mockFetch.mockImplementationOnce(async () => jsonResponse(moderationList()));
    await expect(moderationRepository(null).queryCases({
      organizationId: ids.organization,
      statuses: ['assigned'],
    })).resolves.toMatchObject({ schemaVersion: 2 });

    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ credentials: 'include', cache: 'no-store' });
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'controlled-csrf-token' });
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  test('bounds media type, declared and actual size, JSON, and transport failures', async () => {
    const invoke = () => moderationRepository().queryCases({
      organizationId: ids.organization,
      statuses: ['assigned'],
    });
    mockFetch.mockImplementationOnce(async () => rawResponse('{}'));
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });

    mockFetch.mockImplementationOnce(async () => rawResponse('{}', 200, { 'content-type': 'text/html' }));
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_response', status: 200 });

    for (const declared of ['not-a-number', '-1', '524289']) {
      mockFetch.mockImplementationOnce(async () => rawResponse('{}', 200, {
        'content-type': 'application/json',
        'content-length': declared,
      }));
      await expect(invoke()).rejects.toMatchObject({ code: 'response_too_large', retryable: true });
    }

    mockFetch.mockImplementationOnce(async () => rawResponse(
      JSON.stringify({ padding: 'é'.repeat(270_000) }),
      200,
      { 'content-type': 'application/json' },
    ));
    await expect(invoke()).rejects.toMatchObject({ code: 'response_too_large', retryable: true });

    mockFetch.mockImplementationOnce(async () => rawResponse('{broken', 200, {
      'content-type': 'application/problem+json; charset=utf-8',
    }));
    await expect(invoke()).rejects.toMatchObject({ code: 'invalid_response', retryable: true });

    mockFetch.mockRejectedValueOnce(new TypeError('controlled network loss'));
    await expect(invoke()).rejects.toMatchObject({ code: 'network_unavailable', retryable: true });
  });

  test.each([
    [408, true],
    [409, true],
    [425, true],
    [429, true],
    [503, true],
    [403, false],
  ])('classifies moderation HTTP %i retryability and safe metadata', async (status, retryable) => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({
      error: {
        code: status === 403 ? 'invalid upstream code !' : 'case_conflict',
        correlationId: status === 403 ? 'invalid correlation !' : 'moderation-correlation',
        detail: 'private upstream diagnostic',
      },
    }, status, { 'content-type': 'application/problem+json' }));

    await expect(moderationRepository().queryCases({
      organizationId: ids.organization,
      statuses: ['assigned'],
    })).rejects.toEqual(expect.objectContaining({
      name: 'ModerationCaseRepositoryError',
      code: status === 403 ? `http_${status}` : 'case_conflict',
      correlationId: status === 403 ? undefined : 'moderation-correlation',
      retryable,
      status,
      message: 'The scoped moderation case request could not be completed.',
    }));
  });

  test('accepts direct moderation problem envelopes and a safe declared length', async () => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({
      code: 'moderation_denied',
      correlationId: 'direct-moderation-correlation',
    }, 403, { 'content-length': '90' }));
    await expect(moderationRepository().queryCases({
      organizationId: ids.organization,
      statuses: ['assigned'],
    })).rejects.toMatchObject({
      code: 'moderation_denied',
      correlationId: 'direct-moderation-correlation',
      retryable: false,
      status: 403,
    });

    mockFetch.mockImplementationOnce(async () => jsonResponse(null, 400));
    await expect(moderationRepository().queryCases({
      organizationId: ids.organization,
      statuses: ['assigned'],
    })).rejects.toMatchObject({ code: 'http_400', correlationId: undefined });
  });

  test('rejects malformed, over-broad, and mismatched moderation responses', async () => {
    const repository = moderationRepository();
    mockFetch
      .mockImplementationOnce(async () => jsonResponse({ data: {} }))
      .mockImplementationOnce(async () => jsonResponse(moderationDetail({ caseId: ids.alternateCase })))
      .mockImplementationOnce(async () => jsonResponse(assignmentReceipt({ caseId: ids.alternateCase })))
      .mockImplementationOnce(async () => jsonResponse(assignmentReceipt({ caseId: ids.alternateCase })))
      .mockImplementationOnce(async () => jsonResponse(transitionReceipt({ caseId: ids.alternateCase })));

    await expect(repository.queryCases({
      organizationId: ids.organization,
      statuses: ['assigned'],
    })).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    await expect(repository.readCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
    })).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    await expect(repository.assignCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      investigatorUserId: ids.investigator,
      expectedVersion: 1,
      reason: 'Assigned for investigation.',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    await expect(repository.claimCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      expectedVersion: 2,
      reason: 'Claimed for investigation.',
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
    await expect(repository.transitionCase({
      organizationId: ids.organization,
      caseId: ids.moderationCase,
      status: 'resolved',
      expectedVersion: 3,
      reason: 'Resolved with verified evidence.',
      evidenceMetadata: { policyCode: 'POLICY-2' },
      idempotencyKey: ids.idempotency,
    })).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
  });
});

describe('BffSearchRepository real contract boundary', () => {
  const cursor = `cursor-token.${'a'.repeat(64)}`;

  function messageResult(overrides: Record<string, unknown> = {}) {
    return {
      type: 'messages',
      id: '101',
      title: 'Controlled result',
      snippet: 'Matched translated operational text.',
      conversationId: ids.conversation,
      occurredAt: at.updated,
      matchedSource: 'translation',
      matchedLanguage: 'es',
      ...overrides,
    };
  }

  test('normalizes a fully filtered query and parses a signed, bounded result page', async () => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({ data: {
      results: [messageResult()],
      nextCursor: cursor,
      hasMore: true,
    } }));

    await expect(searchRepository().search({
      organizationId: ids.organization.toUpperCase(),
      query: '  safety procedure  ',
      types: ['messages'],
      cursor,
      limit: 10,
      senderMembershipId: ids.sender.toUpperCase(),
      dateFrom: '2026-08-01T10:00:00Z',
      dateTo: '2026-08-04T12:00:00Z',
      matchSources: ['translation', 'attachment_filename'],
      conversationId: ids.conversation.toUpperCase(),
      language: 'es',
    })).resolves.toEqual({
      results: [messageResult()],
      nextCursor: cursor,
      hasMore: true,
    });

    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.newone.test/v2/search');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer controlled-access-token',
      apikey: 'controlled-publishable-key',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      organizationId: ids.organization,
      query: 'safety procedure',
      types: ['messages'],
      cursor,
      limit: 10,
      senderMembershipId: ids.sender,
      dateFrom: '2026-08-01T10:00:00.000Z',
      dateTo: '2026-08-04T12:00:00.000Z',
      matchSources: ['translation', 'attachment_filename'],
      conversationId: ids.conversation,
      language: 'es',
    });
  });

  test('omits absent optional filters and accepts an empty terminal page', async () => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({
      results: [],
      nextCursor: null,
      hasMore: false,
    }));
    await expect(searchRepository().search({
      organizationId: ids.organization,
      query: 'Ana',
    })).resolves.toEqual({ results: [], nextCursor: null, hasMore: false });
    expect(JSON.parse(String((mockFetch.mock.calls[0]![1] as RequestInit).body))).toEqual({
      organizationId: ids.organization,
      query: 'Ana',
      cursor: null,
      limit: 20,
    });
  });

  test('rejects malformed queries before session or transport access', async () => {
    const getSession = jest.fn(async () => ({ access_token: 'controlled-access-token' }) as never);
    const repository = new BffSearchRepository({ getSession });
    const invalidInputs = [
      { organizationId: ids.organization, query: 'x' },
      { organizationId: 'invalid', query: 'valid query' },
      { organizationId: ids.organization, query: 'valid', limit: 51 },
      { organizationId: ids.organization, query: 'valid', types: ['messages'], matchSources: ['profile'] },
      { organizationId: ids.organization, query: 'valid', senderMembershipId: ids.sender },
      {
        organizationId: ids.organization,
        query: 'valid',
        dateFrom: '2026-08-04T00:00:00Z',
        dateTo: '2026-08-03T00:00:00Z',
      },
      { organizationId: ids.organization, query: 'valid', language: 'xx' },
      { organizationId: ids.organization, query: 'valid', unexpected: true },
    ];
    for (const input of invalidInputs) {
      await expect(repository.search(input as never)).rejects.toEqual(expect.objectContaining({
        name: 'RepositoryError',
        code: 'invalid_query',
        retryable: false,
        message: 'Search terms must be between 2 and 200 characters.',
      }));
    }
    expect(getSession).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('fails closed for missing configuration, native auth, web CSRF, URL, and headers', async () => {
    mockApiBase = null;
    await expect(searchRepository().search({ organizationId: ids.organization, query: 'valid' }))
      .rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });

    mockApiBase = 'https://api.newone.test';
    await expect(searchRepository(null).search({ organizationId: ids.organization, query: 'valid' }))
      .rejects.toMatchObject({ code: 'authentication_required', retryable: false });

    setPlatform('web');
    mockCsrfToken = null;
    await expect(searchRepository(null).search({ organizationId: ids.organization, query: 'valid' }))
      .rejects.toMatchObject({ code: 'csrf_required', retryable: false });

    mockCsrfToken = 'controlled-csrf-token';
    mockUrlEnabled = false;
    await expect(searchRepository(null).search({ organizationId: ids.organization, query: 'valid' }))
      .rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });

    mockUrlEnabled = true;
    mockHeadersEnabled = false;
    await expect(searchRepository(null).search({ organizationId: ids.organization, query: 'valid' }))
      .rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('uses cookie-bound web search without exposing a bearer token', async () => {
    setPlatform('web');
    mockFetch.mockImplementationOnce(async () => jsonResponse({ data: {
      results: [], nextCursor: null, hasMore: false,
    } }));
    await expect(searchRepository(null).search({
      organizationId: ids.organization,
      query: 'safety',
    })).resolves.toEqual({ results: [], nextCursor: null, hasMore: false });
    const [, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ credentials: 'include', cache: 'no-store' });
    expect(init.headers).toMatchObject({ 'X-CSRF-Token': 'controlled-csrf-token' });
    expect(init.headers).not.toHaveProperty('Authorization');
  });

  test('classifies network, malformed JSON, and invalid successful result pages', async () => {
    const invoke = () => searchRepository().search({
      organizationId: ids.organization,
      query: 'safety',
    });
    mockFetch.mockRejectedValueOnce(new TypeError('controlled network loss'));
    await expect(invoke()).rejects.toEqual(expect.objectContaining({
      code: 'network_unavailable', retryable: true,
    }));

    mockFetch.mockImplementationOnce(async () => rawResponse('{broken', 200, {
      'content-type': 'application/json',
    }));
    await expect(invoke()).rejects.toEqual(expect.objectContaining({
      code: 'invalid_response', retryable: true,
    }));

    mockFetch.mockImplementationOnce(async () => jsonResponse({ data: {
      results: [messageResult({ matchedLanguage: null })],
      nextCursor: null,
      hasMore: false,
    } }));
    await expect(invoke()).rejects.toEqual(expect.objectContaining({
      code: 'invalid_response', retryable: true,
      message: 'The search service returned an invalid result list.',
    }));
  });

  test.each([
    [408, true],
    [429, true],
    [500, true],
    [403, false],
  ])('classifies search HTTP %i responses without echoing details', async (status, retryable) => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({ error: {
      code: status === 403 ? 1003 : 'search_rate_limited',
      correlationId: status === 403 ? 992 : 'search-correlation',
      detail: 'private upstream diagnostic',
    } }, status));

    await expect(searchRepository().search({
      organizationId: ids.organization,
      query: 'safety',
    })).rejects.toEqual(expect.objectContaining({
      name: 'RepositoryError',
      code: status === 403 ? 'http_403' : 'search_rate_limited',
      retryable,
      correlationId: status === 403 ? undefined : 'search-correlation',
      status,
      message: 'Search was rejected.',
    }));
  });

  test('accepts a direct search problem envelope', async () => {
    mockFetch.mockImplementationOnce(async () => jsonResponse({
      code: 'search_denied',
      correlationId: 'direct-search-correlation',
    }, 403));
    await expect(searchRepository().search({
      organizationId: ids.organization,
      query: 'safety',
    })).rejects.toMatchObject({
      code: 'search_denied',
      correlationId: 'direct-search-correlation',
      retryable: false,
      status: 403,
    });
  });
});

test('all repositories abort a hung request at the fixed fifteen-second boundary', async () => {
  jest.useFakeTimers();
  try {
    mockFetch.mockImplementation((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
        once: true,
      });
    }));
    const recoveryAssertion = expect(recoveryRepository().listCases(ids.organization))
      .rejects.toMatchObject({ code: 'network_unavailable', retryable: true });
    const moderationAssertion = expect(moderationRepository().queryCases({
      organizationId: ids.organization,
      statuses: ['assigned'],
    })).rejects.toMatchObject({ code: 'network_unavailable', retryable: true });
    const searchAssertion = expect(searchRepository().search({
      organizationId: ids.organization,
      query: 'safety',
    })).rejects.toMatchObject({ code: 'network_unavailable', retryable: true });

    await jest.advanceTimersByTimeAsync(15_000);
    await Promise.all([recoveryAssertion, moderationAssertion, searchAssertion]);
  } finally {
    jest.useRealTimers();
  }
});

test('repository error classes retain stable, non-upstream messages', () => {
  expect(new RecoveryCaseRepositoryError('controlled', false)).toMatchObject({
    name: 'RecoveryCaseRepositoryError',
    message: 'The secure account-recovery request could not be completed.',
  });
  expect(new ModerationCaseRepositoryError('controlled', false)).toMatchObject({
    name: 'ModerationCaseRepositoryError',
    message: 'The scoped moderation case request could not be completed.',
  });
  expect(new RepositoryError('Safe message.', 'controlled', false)).toMatchObject({
    name: 'RepositoryError', message: 'Safe message.',
  });
});
