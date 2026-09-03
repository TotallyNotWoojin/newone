import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Platform } from 'react-native';

import { BffCommandRepository } from '@/data/repositories/bff-command-repository';
import { RepositoryError } from '@/data/repositories/contracts';

const mockFetch = jest.fn();
let mockApiBase: string | null = 'https://api.newone.test';
let mockSession: { access_token: string } | null = { access_token: 'controlled-access-token' };
let mockCsrfToken: string | null = 'controlled-csrf-token';
let mockApiUrlAvailable = true;
let mockEdgeHeaders: Record<string, string> | null = {
  Authorization: 'Bearer controlled-access-token',
  apikey: 'controlled-publishable-key',
};
let mockDigest = 'a'.repeat(64);

jest.mock('@/config/runtime', () => ({
  apiUrlFor: (path: string) => mockApiBase && mockApiUrlAvailable ? `${mockApiBase}${path}` : null,
  nativeEdgeRequestHeaders: () => mockEdgeHeaders,
  publicRuntimeConfig: {
    get apiUrl() {
      return mockApiBase;
    },
    supabase: { url: 'https://project.supabase.co' },
  },
}));

jest.mock('@/lib/web-auth', () => ({
  getWebCsrfToken: () => mockCsrfToken,
}));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async () => mockDigest,
}));

function response(payload: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(payload), { status, headers });
}

function rawResponse(payload: string, status = 200, headers?: Record<string, string>) {
  return new Response(payload, { status, headers });
}

function repository() {
  return new BffCommandRepository({
    getSession: async () => mockSession as any,
  });
}

async function expectInvalidResponse(
  payload: unknown,
  call: () => Promise<unknown>,
) {
  mockFetch.mockImplementationOnce(async () => response({ data: payload }));
  await expect(call()).rejects.toMatchObject({ code: 'invalid_response' });
}

const organizationId = '10000000-0000-4000-8000-000000000001';
const conversationId = '20000000-0000-4000-8000-000000000002';
const membershipId = '30000000-0000-4000-8000-000000000003';
const idempotencyKey = '40000000-0000-4000-8000-000000000004';
const otherMembershipId = '50000000-0000-4000-8000-000000000005';
const reportId = '60000000-0000-4000-8000-000000000006';
const summaryId = '70000000-0000-4000-8000-000000000007';
const exampleId = '80000000-0000-4000-8000-000000000008';
const policyId = '90000000-0000-4000-8000-000000000009';
const attachmentId = 'a0000000-0000-4000-8000-00000000000a';
const deviceId = 'b0000000-0000-4000-8000-00000000000b';
const installationId = 'c0000000-0000-4000-8000-00000000000c';
const at = '2030-01-02T03:04:05.000Z';
const later = '2030-01-02T04:04:05.000Z';

function audienceSpec(overrides: Record<string, unknown> = {}) {
  return {
    company: true,
    conversationMembers: false,
    siteIds: [],
    departmentIds: [],
    teamIds: [],
    unitIds: [],
    operationalRoles: [],
    membershipRoles: [],
    languages: [],
    currentShiftOnly: false,
    ...overrides,
  };
}

function joinRequest(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'join-request-a',
    conversationId,
    requesterUserId: membershipId,
    requesterDisplayName: 'Jordan Requester',
    requesterAvatarPath: 'avatars/jordan.png',
    status: 'pending',
    version: 1,
    requestedAt: at,
    expiresAt: later,
    decidedAt: null,
    ...overrides,
  };
}

function acknowledgementSchema(enabled = false) {
  return enabled ? {
    schemaVersion: 1 as const,
    attestationRequired: true,
    attestationPrompt: 'Confirm the safety instruction.',
    requiredKeys: ['confirmed'],
    carryForwardOnCorrection: false as const,
  } : {
    schemaVersion: 1 as const,
    attestationRequired: false,
    attestationPrompt: null,
    requiredKeys: [],
    carryForwardOnCorrection: false as const,
  };
}

function reminderPolicy(enabled = false) {
  return enabled ? {
    enabled: true,
    deadlineAt: later,
    intervalSeconds: 300,
    maximumReminders: 2,
    escalateAfterSeconds: 900,
    smsFallback: false as const,
  } : {
    enabled: false,
    deadlineAt: null,
    intervalSeconds: null,
    maximumReminders: 0,
    escalateAfterSeconds: null,
    smsFallback: false as const,
  };
}

function managedVersion(overrides: Record<string, unknown> = {}) {
  return {
    announcementVersionId: 'announcement-version-a',
    versionNumber: 1,
    title: 'Controlled notice',
    body: 'Controlled authoritative notice body.',
    publishedAt: at,
    correctionOfVersionId: null,
    correctionReason: null,
    createdByUserId: membershipId,
    createdByDisplayName: 'Jordan Publisher',
    ...overrides,
  };
}

function managedUpdate(overrides: Record<string, unknown> = {}) {
  return {
    announcementId: 'announcement-a',
    conversationId,
    conversationTitle: 'Operations',
    announcementVersionId: 'announcement-version-a',
    versionNumber: 1,
    versionCount: 1,
    title: 'Controlled notice',
    body: 'Controlled authoritative notice body.',
    languageCode: 'en',
    priority: 'normal',
    notificationClass: 'routine',
    criticalCategory: null,
    quietHoursOverrideReason: null,
    requiresAcknowledgement: false,
    acknowledgementSchema: acknowledgementSchema(false),
    reminderPolicy: reminderPolicy(false),
    status: 'published',
    scheduledAt: null,
    publishedAt: at,
    expiresAt: null,
    cancelledAt: null,
    cancellationReason: null,
    correctionOfVersionId: null,
    correctionReason: null,
    audienceSnapshotted: true,
    recipientCount: 3,
    deliveredCount: 3,
    readCount: 2,
    acknowledgedCount: 0,
    nonAcknowledgedCount: 0,
    overdueCount: 0,
    unreachableCount: 0,
    versions: [managedVersion()],
    ...overrides,
  };
}

function aiReport(overrides: Record<string, unknown> = {}) {
  return {
    reportId,
    outputKind: 'translation',
    translationId: '101',
    summaryId: null,
    conversationId,
    category: 'terminology',
    details: 'The translated site term is incorrect.',
    highConsequence: false,
    qualityUseConsent: true,
    consentVersion: 'ai-quality-v1',
    targetSourceFingerprint: 'a'.repeat(64),
    targetOutputFingerprint: 'b'.repeat(64),
    targetLanguage: 'es',
    targetSnapshot: {
      schemaVersion: 1,
      translationId: '101',
      translatedBody: 'Controlled translated output.',
      messageId: '99',
    },
    status: 'open',
    outcome: null,
    version: 1,
    reviewedByUserId: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: at,
    updatedAt: at,
    deduplicated: false,
    originalsUnchanged: true,
    ...overrides,
  };
}

function summaryAiReport(overrides: Record<string, unknown> = {}) {
  return aiReport({
    outputKind: 'summary',
    translationId: null,
    summaryId,
    category: 'missing_source',
    targetLanguage: 'en-US',
    targetSnapshot: {
      schemaVersion: 1,
      summaryId,
      summaryBody: 'Controlled summary output.',
      sourceMessageIds: ['99', '100'],
    },
    ...overrides,
  });
}

function regressionExample(overrides: Record<string, unknown> = {}) {
  return {
    exampleId,
    reportId,
    outputKind: 'translation',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    deidentifiedSourceText: 'Source text without identifiers.',
    deidentifiedObservedOutput: 'Observed incorrect output.',
    deidentifiedExpectedOutput: 'Expected corrected output.',
    errorCategory: 'terminology',
    consequenceLevel: 'standard',
    attestationVersion: 'deidentification-v1',
    proposedByUserId: membershipId,
    proposedAt: at,
    status: 'pending',
    version: 1,
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    exportedAt: null,
    deduplicated: false,
    ...overrides,
  };
}

function roleAssignment(overrides: Record<string, unknown> = {}) {
  return {
    assignmentId: 'assignment-a',
    userId: membershipId,
    roleName: 'people_admin',
    scopeType: 'organization',
    unitId: null,
    grantedAt: at,
    expiresAt: null,
    revokedAt: null,
    active: true,
    ...overrides,
  };
}

function accountSession(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'session-a',
    current: true,
    platform: 'ios',
    device: {
      installationId,
      platform: 'ios',
      appVersion: '1.2.3',
    },
    createdAt: at,
    lastUsedAt: later,
    expiresAt: later,
    revoked: false,
    aal: 'aal2',
    signal: { sameNetworkAsCurrent: true, clientFamily: 'iphone' },
    ...overrides,
  };
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    inviteId: 'invite-a',
    destinationType: 'email',
    destinationMasked: 'c***@example.test',
    role: 'admin',
    activationMode: 'otp',
    expiresAt: at,
    activationToken: null,
    employeeCode: null,
    membershipType: 'employee',
    membershipAccessExpiresAt: null,
    guestSponsorUserId: null,
    ...overrides,
  };
}

function devicePreferences(overrides: Record<string, unknown> = {}) {
  return {
    registered: true,
    deviceId,
    installationId,
    platform: 'ios',
    preferenceVersion: 4,
    overrides: {
      notificationPreview: 'hidden',
      soundEnabled: false,
      vibrationEnabled: null,
    },
    effective: {
      notificationPreview: 'hidden',
      soundEnabled: false,
      vibrationEnabled: true,
    },
    updatedAt: at,
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
  mockApiBase = 'https://api.newone.test';
  mockApiUrlAvailable = true;
  mockSession = { access_token: 'controlled-access-token' };
  mockCsrfToken = 'controlled-csrf-token';
  mockEdgeHeaders = {
    Authorization: 'Bearer controlled-access-token',
    apikey: 'controlled-publishable-key',
  };
  mockDigest = 'a'.repeat(64);
  mockFetch.mockImplementation(async () => response({ data: {} }));
  global.fetch = mockFetch as unknown as typeof fetch;
});

describe('BFF command transport security and parsing', () => {
  test('uses cookie and CSRF transport on web while failing closed on incomplete routing state', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    mockSession = null;
    mockEdgeHeaders = {};
    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId,
    } }));

    await expect(repository().createDirectConversation({
      organizationId,
      targetMembershipId: membershipId,
      idempotencyKey,
    })).resolves.toEqual({ conversationId });
    const [, webInit] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(webInit.credentials).toBe('include');
    expect(webInit.headers).toMatchObject({ 'X-CSRF-Token': 'controlled-csrf-token' });
    expect(webInit.headers).not.toHaveProperty('Authorization');

    mockCsrfToken = null;
    await expect(repository().createDirectConversation({
      organizationId, targetMembershipId: membershipId, idempotencyKey,
    })).rejects.toMatchObject({ code: 'csrf_required', retryable: false });

    mockCsrfToken = 'controlled-csrf-token';
    mockApiUrlAvailable = false;
    await expect(repository().createDirectConversation({
      organizationId, targetMembershipId: membershipId, idempotencyKey,
    })).rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });

    mockApiUrlAvailable = true;
    mockEdgeHeaders = null;
    await expect(repository().createDirectConversation({
      organizationId, targetMembershipId: membershipId, idempotencyKey,
    })).rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });
  });

  test('bounds decoded responses and classifies malformed and direct HTTP failures without reflection', async () => {
    const call = () => repository().createDirectConversation({
      organizationId, targetMembershipId: membershipId, idempotencyKey,
    });

    mockFetch.mockImplementationOnce(async () => rawResponse('{not-json', 200, {
      'content-length': 'not-declared',
    }));
    await expect(call()).rejects.toMatchObject({ code: 'invalid_response', retryable: true });

    mockFetch.mockImplementationOnce(async () => rawResponse(`"${'x'.repeat(2_000_001)}"`));
    await expect(call()).rejects.toMatchObject({ code: 'response_too_large', retryable: false });

    mockFetch.mockImplementationOnce(async () => rawResponse('{not-json', 408));
    await expect(call()).rejects.toMatchObject({ code: 'http_408', retryable: true, status: 408 });

    mockFetch.mockImplementationOnce(async () => response({
      code: 'conflict',
      correlationId: 'correlation-direct',
    }, 409));
    await expect(call()).rejects.toMatchObject({
      code: 'conflict', retryable: false, correlationId: 'correlation-direct', status: 409,
    });

    mockFetch.mockImplementationOnce(async () => response({ error: {} }, 503));
    await expect(call()).rejects.toMatchObject({ code: 'http_503', retryable: true, status: 503 });

    mockFetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new Error('controlled body read failure');
      },
    } as unknown as Response));
    await expect(call()).rejects.toMatchObject({ code: 'invalid_response', retryable: true });
  });

  test('sends an authenticated, idempotent, no-store command envelope', async () => {
    mockFetch.mockImplementationOnce(async () => response({
      data: { conversation: { conversation_id: conversationId } },
    }));

    await expect(repository().createDirectConversation({
      organizationId,
      targetMembershipId: membershipId,
      idempotencyKey,
    })).resolves.toEqual({ conversationId });

    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.newone.test/v2/conversations/direct');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', cache: 'no-store' });
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: 'Bearer controlled-access-token',
      apikey: 'controlled-publishable-key',
      'Idempotency-Key': idempotencyKey,
    });
    expect(JSON.parse(String(init.body))).toEqual({
      organizationId,
      targetMembershipId: membershipId,
    });
  });

  test('sends a person-level message request and parses its receipt defensively', async () => {
    mockFetch.mockImplementationOnce(async () => response({
      data: { conversationId, messageId: '412', connectionStatus: 'pending' },
    }, 201));
    await expect(repository().sendMessageRequest({
      organizationId,
      targetUserId: membershipId,
      body: 'Hello — introducing myself.',
      idempotencyKey,
    })).resolves.toEqual({
      conversationId,
      messageId: '412',
      connectionStatus: 'pending',
    });
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.newone.test/v2/contacts/message-requests');
    expect(init).toMatchObject({ method: 'POST', cache: 'no-store' });
    expect(init.headers).toMatchObject({ 'Idempotency-Key': idempotencyKey });
    expect(JSON.parse(String(init.body))).toEqual({
      organizationId,
      targetUserId: membershipId,
      body: 'Hello — introducing myself.',
    });

    mockFetch.mockImplementationOnce(async () => response({
      data: {
        conversation_id: conversationId.toUpperCase(),
        message_id: 413,
        connection: { status: 'accepted' },
      },
    }, 201));
    await expect(repository().sendMessageRequest({
      organizationId,
      targetUserId: membershipId,
      body: 'Second body',
      idempotencyKey,
    })).resolves.toEqual({
      conversationId,
      messageId: '413',
      connectionStatus: 'accepted',
    });
  });

  test('fails closed on malformed message request receipts', async () => {
    const malformed: unknown[] = [
      { messageId: '412', connectionStatus: 'pending' },
      { conversationId: 'not-a-uuid', messageId: '412', connectionStatus: 'pending' },
      { conversationId, messageId: '', connectionStatus: 'pending' },
      { conversationId, messageId: 'bad message id', connectionStatus: 'pending' },
      { conversationId, messageId: '412', connectionStatus: 'declined' },
      { conversationId, messageId: '412' },
      { conversationId, messageId: '412', connection: [] },
    ];
    for (const payload of malformed) {
      await expectInvalidResponse(payload, () => repository().sendMessageRequest({
        organizationId,
        targetUserId: membershipId,
        body: 'Hello',
        idempotencyKey,
      }));
    }
  });

  test('classifies missing configuration, missing auth, network, size, and HTTP failures', async () => {
    mockApiBase = null;
    await expect(repository().createDirectConversation({ organizationId, targetMembershipId: membershipId, idempotencyKey }))
      .rejects.toMatchObject({ code: 'service_unconfigured', retryable: false });

    mockApiBase = 'https://api.newone.test';
    mockSession = null;
    await expect(repository().createDirectConversation({ organizationId, targetMembershipId: membershipId, idempotencyKey }))
      .rejects.toMatchObject({ code: 'authentication_required', retryable: false });

    mockSession = { access_token: 'controlled-access-token' };
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('controlled network loss');
    });
    await expect(repository().createDirectConversation({ organizationId, targetMembershipId: membershipId, idempotencyKey }))
      .rejects.toMatchObject({ code: 'network_unavailable', retryable: true });

    mockFetch.mockImplementationOnce(async () => response({ data: {} }, 200, { 'content-length': '2000001' }));
    await expect(repository().createDirectConversation({ organizationId, targetMembershipId: membershipId, idempotencyKey }))
      .rejects.toMatchObject({ code: 'response_too_large', retryable: false });

    mockFetch.mockImplementationOnce(async () => response({
      error: { code: 'rate_limited', correlationId: 'correlation-a' },
    }, 429));
    await expect(repository().createDirectConversation({ organizationId, targetMembershipId: membershipId, idempotencyKey }))
      .rejects.toMatchObject({
        code: 'rate_limited', retryable: true, correlationId: 'correlation-a', status: 429,
      });
  });

  test('updates the profile through PATCH /v2/profile and validates the receipt', async () => {
    const repo = repository();
    mockFetch.mockImplementationOnce(async () => response({ data: {
      userId: membershipId, displayName: ' Jordan Renamed ', statusMessage: 'On shift',
    } }));
    await expect(repo.updateProfile({
      organizationId, idempotencyKey, displayName: 'Jordan Renamed', statusMessage: 'On shift',
    })).resolves.toEqual({ userId: membershipId, displayName: 'Jordan Renamed', statusMessage: 'On shift' });
    const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.newone.test/v2/profile');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({
      organizationId, displayName: 'Jordan Renamed', statusMessage: 'On shift',
    });
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe(idempotencyKey);

    mockFetch.mockImplementationOnce(async () => response({ data: {
      userId: membershipId, displayName: 'Jordan', statusMessage: null,
    } }));
    await expect(repo.updateProfile({ organizationId, idempotencyKey, displayName: 'Jordan' }))
      .resolves.toEqual({ userId: membershipId, displayName: 'Jordan', statusMessage: null });
    expect(JSON.parse(String((mockFetch.mock.calls[1]![1] as RequestInit).body))).toEqual({
      organizationId, displayName: 'Jordan', statusMessage: null,
    });

    for (const payload of [
      { userId: 'not-a-uuid', displayName: 'Jordan', statusMessage: null },
      { userId: membershipId, displayName: '', statusMessage: null },
      { userId: membershipId, displayName: 'n'.repeat(121), statusMessage: null },
      { userId: membershipId, displayName: 'Jordan', statusMessage: 's'.repeat(281) },
      { userId: membershipId, displayName: 'Jordan', statusMessage: 5 },
      { userId: membershipId, displayName: 'Jordan' },
      { userId: membershipId, displayName: 'Jordan', statusMessage: null, username: 'leaked_handle' },
    ]) {
      await expectInvalidResponse(payload, () => repo.updateProfile({
        organizationId, idempotencyKey, displayName: 'Jordan',
      }));
    }
  });

  test('executes the production routes for state-changing commands and preserves optional-field intent', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };

    await repo.updateConversation({
      ...base, conversationId, name: 'Night Shift', description: null, isArchived: false,
    });
    await repo.updateOrganizationConversationControls({
      ...base,
      defaultJoinPolicy: 'approval_required',
      defaultGroupMemberLimit: 250,
      joinRequestExpiryDays: 7,
      maxPendingJoinRequestsPerUser: 5,
      reason: 'Quarterly access policy review',
    });
    await repo.updateConversationPreferences({
      ...base, conversationId, isFavorite: true, isPinned: false, isArchived: false,
      notificationLevel: 'mentions', mutedUntil: null, translationMode: 'automatic',
    });
    await repo.removeConversationMember({ ...base, conversationId, membershipId });
    await repo.closeIncident({ ...base, conversationId, reason: 'Incident resolved and reviewed' });
    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId,
      mode: 'message_count',
      humanReviewRequired: true,
      automaticPublish: false,
    } }));
    await repo.setSummaryPolicy({
      ...base, conversationId, mode: 'message_count', messageCountThreshold: 50,
    });
    await repo.editMessage({ ...base, conversationId, messageId: '101', body: 'Corrected body' });
    await repo.deleteMessage({ ...base, conversationId, messageId: '101' });
    await repo.hideMessageForMe({ ...base, conversationId, messageId: '101' });
    await repo.setMessageReaction({ ...base, conversationId, messageId: '101', emoji: '✅', active: true });
    await repo.setMessagePin({ ...base, conversationId, messageId: '101', pinned: true });
    await repo.cancelScheduledUpdate({ ...base, announcementId: 'announcement-a', reason: 'Schedule changed' });
    await repo.signHandoff({ ...base, versionId: 'handoff-version-a' });
    await repo.acknowledgeHandoff({ ...base, versionId: 'handoff-version-a', note: 'Received' });
    await repo.confirmAction({ ...base, actionId: 'action-a', assigneeMembershipId: membershipId, dueAt: null });
    await repo.transitionAction({ ...base, actionId: 'action-a', status: 'completed', note: 'Verified' });
    await repo.requestConnection({ ...base, targetMembershipId: membershipId });
    await repo.respondConnection({ ...base, membershipId, decision: 'accepted' });
    await repo.removeConnection({ ...base, membershipId });
    await repo.removeSavedContact({ ...base, membershipId });
    await repo.setPersonBlocked({ ...base, membershipId, blocked: true });
    await repo.setPersonBlocked({ ...base, membershipId, blocked: false });
    await repo.revokeAdminRole({ ...base, assignmentId: 'assignment-a', reason: 'Rotation ended' });
    await repo.revokeSession({ ...base, sessionId: 'session-a', reason: 'User requested revoke' });
    await repo.suspendMember({ ...base, membershipId, reason: 'Security investigation' });
    await repo.registerDevice({
      ...base,
      installationId: 'installation-a',
      platform: 'ios',
      pushToken: 'ExponentPushToken[controlled]',
      pushTokenType: 'expo',
      pushProjectId: 'project-a',
      pushEnvironment: 'preview',
      appVersion: '1.0.0',
      locale: 'en-US',
    });

    expect(mockFetch).toHaveBeenCalledTimes(26);
    const requests = mockFetch.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(requests[0]).toEqual({
      organizationId,
      name: 'Night Shift',
      description: null,
      isArchived: false,
    });
    expect(requests[2]).toEqual(expect.objectContaining({
      organizationId,
      isFavorite: true,
      isPinned: false,
      isArchived: false,
      notificationLevel: 'mentions',
      mutedUntil: null,
      translationMode: 'automatic',
    }));
    expect((mockFetch.mock.calls[3]![1] as RequestInit).method).toBe('DELETE');
    // Cancelling a pending request and removing an accepted connection share
    // one DELETE route addressed by the counterpart identifier.
    expect(String(mockFetch.mock.calls[18]![0])).toMatch(
      new RegExp(`/v2/contacts/connections/${membershipId}$`),
    );
    expect((mockFetch.mock.calls[18]![1] as RequestInit).method).toBe('DELETE');
    expect((mockFetch.mock.calls[20]![1] as RequestInit).method).toBe('PUT');
    expect((mockFetch.mock.calls[21]![1] as RequestInit).method).toBe('DELETE');
  });

  test('accepts exact conversation, policy, dynamic-group, avatar, and departure receipts', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };
    const policySpec: Parameters<typeof repo.saveDynamicGroupPolicy>[0]['policySpec'] = {
      siteIds: [], departmentIds: [], teamIds: [membershipId], lineIds: [], unitIds: [],
      includeDescendants: true,
      operationalRoles: ['shift lead'],
      membershipRoles: ['manager', 'member'],
      shiftMode: 'current',
      scheduledShiftStartsAt: null,
      scheduledShiftEndsAt: null,
    };

    mockFetch.mockImplementationOnce(async () => response({ data: {
      candidates: [{
        userId: membershipId,
        displayName: 'Jordan Candidate',
        avatarPath: null,
        jobTitle: 'Shift lead',
        membershipRole: 'member',
        membershipType: 'employee',
        accessExpiresAt: null,
      }],
      limit: 1,
    } }));
    await expect(repo.listGroupCreationCandidates({
      organizationId, query: '  Jordan  ', limit: 1,
    })).resolves.toMatchObject({ limit: 1 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      candidates: [{
        userId: membershipId,
        displayName: 'Jordan Candidate',
        avatarPath: 'avatars/jordan.png',
        roleLabel: 'Shift lead',
        membershipType: 'employee',
      }],
      nextCursor: null,
    } }));
    await expect(repo.listConversationMemberCandidates({
      organizationId, conversationId, query: '  Jordan  ', limit: 2,
    })).resolves.toMatchObject({ candidates: [{ userId: membershipId }], nextCursor: null });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId,
      kind: 'team',
      name: 'Packaging handoff',
      description: 'Coordinate packaging and dispatch.',
      historyPolicy: 'since_join',
      historyDisclosure: {
        policy: 'since_join',
        visibleFrom: at,
        labelKey: 'conversation.history.since_join',
      },
      postingMode: 'admins_only',
      joinPolicy: 'approval_required',
      configuredJoinPolicy: 'approval_required',
      visibility: 'organization',
      memberCount: 3,
      memberLimit: 500,
      isReadOnly: false,
    } }));
    await expect(repo.createGroupConversation({
      ...base,
      name: 'Packaging handoff',
      description: 'Coordinate packaging and dispatch.',
      memberAssignments: [{ membershipId, role: 'member' }],
      kind: 'team',
      unitId: null,
      historyPolicy: 'since_join',
      postingMode: 'admins_only',
      joinPolicy: 'approval_required',
      incidentSeverity: null,
      incidentClassification: null,
    })).resolves.toMatchObject({ conversationId, historyPolicy: 'since_join' });

    const organizationPolicy = {
      messageRetentionDays: 180,
      allowMemberDirectMessages: false,
      dmPolicy: 'request_first' as const,
      requireMfaForAdmins: true,
      shiftScheduleAuthoritative: true,
      groupCreationPolicy: 'admins' as const,
      allowExternalGuests: false,
      externalGuestMaxAccessDays: 45,
      version: 2,
    };
    mockFetch.mockImplementationOnce(async () => response({ data: organizationPolicy }));
    await expect(repo.updateOrganizationPolicy({
      ...base, policy: { ...organizationPolicy, reason: 'Quarterly policy review.' },
    })).resolves.toEqual(organizationPolicy);

    const aiPolicy = {
      organizationId,
      enabled: true,
      policyVersion: 3,
      approvedUseCases: ['summary', 'translation'] as const,
      providerAllowlist: ['google-vertex/us-south1'],
      routePolicy: 'approved_zero_retention' as const,
      tenantApproved: true,
      globalKillSwitchStillRequired: true,
    };
    mockFetch.mockImplementationOnce(async () => response({ data: aiPolicy }));
    await expect(repo.getOrganizationAiPolicy({ organizationId })).resolves.toEqual(aiPolicy);
    mockFetch.mockImplementationOnce(async () => response({ data: aiPolicy }));
    await expect(repo.updateOrganizationAiPolicy({
      ...base,
      policy: {
        enabled: true,
        approvedUseCases: ['summary', 'translation'],
        providerAllowlist: ['google-vertex/us-south1'],
        routePolicy: 'approved_zero_retention',
        expectedVersion: 2,
        reason: 'Approved after bounded review.',
      },
    })).resolves.toEqual(aiPolicy);

    const dynamicPolicy = {
      policyId,
      conversationId,
      conversationName: 'Night shift packaging',
      conversationKind: 'shift',
      conversationUnitId: membershipId,
      status: 'active',
      version: 3,
      draftState: 'published',
      policySpec,
      maximumMembers: 250,
      selectorFingerprint: 'a'.repeat(64),
      publishedVersionId: otherMembershipId,
      lastPreviewFingerprint: 'b'.repeat(64),
      lastPreviewedAt: at,
      lastSyncedAt: at,
      nextEvaluationAt: null,
      sourceChangedAt: null,
      createdAt: at,
      updatedAt: later,
    };
    mockFetch.mockImplementationOnce(async () => response({ data: {
      policies: [dynamicPolicy], limit: 1, nextAfterPolicyId: policyId,
    } }));
    await expect(repo.listDynamicGroupPolicies({ organizationId, limit: 1 }))
      .resolves.toMatchObject({ policies: [{ policyId }], limit: 1 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      policyId, conversationId, version: 1, draftState: 'draft',
      selectorFingerprint: 'a'.repeat(64), requiresPreview: true, publishedVersionId: null,
    } }));
    await expect(repo.saveDynamicGroupPolicy({
      ...base, conversationId, policyId: null, expectedVersion: 0, policySpec, maximumMembers: 250,
    })).resolves.toMatchObject({ policyId, version: 1 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      policyId, conversationId, version: 4, draftState: 'draft',
      selectorFingerprint: 'a'.repeat(64), requiresPreview: true,
      publishedVersionId: otherMembershipId,
    } }));
    await expect(repo.saveDynamicGroupPolicy({
      ...base, conversationId, policyId, expectedVersion: 3, policySpec, maximumMembers: 250,
    })).resolves.toMatchObject({ policyId, version: 4 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      policyId,
      policyVersion: 3,
      previewFingerprint: 'b'.repeat(64),
      selectorFingerprint: 'a'.repeat(64),
      membershipStateFingerprint: 'c'.repeat(64),
      evaluatedAt: at,
      validUntil: later,
      eligibleCount: 2,
      addedCount: 1,
      removedCount: 1,
      unchangedCount: 1,
      addedSampleUserIds: [membershipId],
      removedSampleUserIds: [otherMembershipId],
      unchangedSampleUserIds: [conversationId],
      nextBoundaryAt: null,
    } }));
    await expect(repo.previewDynamicGroupPolicy({
      organizationId, policyId, expectedVersion: 3, sampleLimit: 25,
    })).resolves.toMatchObject({ policyId, policyVersion: 3 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      policyId,
      policyVersion: 3,
      publishedVersionId: otherMembershipId,
      status: 'active',
      draftState: 'published',
      eligibleCount: 2,
      addedCount: 1,
      removedCount: 1,
      unchangedCount: 1,
      selectorFingerprint: 'a'.repeat(64),
      nextEvaluationAt: null,
    } }));
    await expect(repo.publishDynamicGroupPolicy({
      ...base, policyId, expectedVersion: 3, previewFingerprint: 'b'.repeat(64),
    })).resolves.toMatchObject({ status: 'active' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      policyId, policyVersion: 3, status: 'paused', pausedAt: at,
    } }));
    await expect(repo.pauseDynamicGroupPolicy({
      ...base, policyId, expectedVersion: 3, reason: 'Controlled pause reason.',
    })).resolves.toMatchObject({ status: 'paused' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId,
      postingMode: 'admins_only',
      configuredJoinPolicy: 'inherit',
      joinPolicy: 'approval_required',
      visibility: 'organization',
    } }));
    await expect(repo.updateConversationControls({
      ...base, conversationId, postingMode: 'admins_only', joinPolicy: undefined,
      visibility: undefined, reason: 'Controlled policy update.',
    })).resolves.toMatchObject({ configuredJoinPolicy: 'inherit' });

    for (const [method, payload] of [
      ['request', joinRequest()],
      ['cancel', joinRequest({ status: 'cancelled', version: 2, decidedAt: at })],
      ['decide', joinRequest({ status: 'approved', version: 2, decidedAt: at })],
    ] as const) {
      mockFetch.mockImplementationOnce(async () => response({ data: payload }));
      if (method === 'request') await repo.requestConversationJoin({ ...base, conversationId });
      if (method === 'cancel') await repo.cancelConversationJoinRequest({
        ...base, requestId: 'join-request-a', expectedVersion: 1,
      });
      if (method === 'decide') await repo.decideConversationJoinRequest({
        ...base, requestId: 'join-request-a', expectedVersion: 1,
        decision: 'approved', reason: 'Authorized request.',
      });
    }

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversations: [{
        conversationId,
        kind: 'group',
        name: 'Discoverable operations',
        description: 'Authorized directory description.',
        avatarPath: 'avatars/group.png',
        visibility: 'organization',
        postingMode: 'all_members',
        joinPolicy: 'approval_required',
        memberCount: 12,
        historyDisclosure: {
          policy: 'all', visibleFrom: at, labelKey: 'conversation.history.all',
        },
        myJoinRequest: {
          requestId: 'join-request-a', status: 'pending', version: 1,
          requestedAt: at, expiresAt: later, decidedAt: null,
        },
      }, {
        conversationId: otherMembershipId,
        kind: 'team',
        name: 'Second directory group',
        description: null,
        avatarPath: null,
        visibility: 'unit',
        postingMode: 'admins_only',
        joinPolicy: 'approval_required',
        memberCount: 2,
        historyDisclosure: {
          policy: 'since_join', visibleFrom: null, labelKey: 'other',
        },
        myJoinRequest: null,
      }],
    } }));
    await expect(repo.listDiscoverableConversations({ organizationId, limit: 2 }))
      .resolves.toHaveLength(2);

    mockFetch.mockImplementationOnce(async () => response({ data: {
      joinRequests: [joinRequest({ requesterDisplayName: undefined, requesterAvatarPath: null })],
    } }));
    await expect(repo.listConversationJoinRequests({ organizationId, conversationId, limit: 1 }))
      .resolves.toHaveLength(1);

    mockFetch.mockImplementationOnce(async () => response({ data: {
      historyVisibleFrom: at,
      historyPolicy: 'all',
      historyDisclosure: {
        policy: 'all', visibleFrom: at, labelKey: 'conversation.history.all',
      },
    } }));
    await expect(repo.addConversationMember({
      ...base, conversationId, membershipId, role: undefined,
    })).resolves.toMatchObject({ historyPolicy: 'all' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId, userId: membershipId, previousRole: 'member', role: 'admin',
    } }));
    await expect(repo.updateConversationMemberRole({
      ...base, conversationId, membershipId, expectedRole: 'member', newRole: 'admin',
    })).resolves.toMatchObject({ role: 'admin' });

    const avatarPath = `${organizationId}/${conversationId}/${membershipId}/${attachmentId}/upload`;
    mockFetch.mockImplementationOnce(async () => response({ data: { grant: {
      action: 'upload', attachmentId, messageId: '101', bucket: 'message-attachments',
      path: avatarPath, scanStatus: 'pending', maximumByteSize: 5 * 1024 * 1024,
      signedUrl: 'https://project.supabase.co/storage/v1/object/upload/sign/message-attachments/path?token=controlled-token-123456',
      token: 'controlled-upload-token', expiresInSeconds: 7200,
    } } }));
    await expect(repo.createConversationAvatarUploadGrant({
      ...base, conversationId, fileName: 'avatar.png', mimeType: 'image/png',
      byteSize: 2048, sha256Hex: 'd'.repeat(64),
    })).resolves.toMatchObject({ attachmentId, signedUrl: expect.any(String) });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      attachmentId,
      signedUrl: 'https://project.supabase.co/storage/v1/object/sign/message-attachments/path?token=controlled-token-123456',
      expiresInSeconds: 120,
    } }));
    await expect(repo.getConversationAvatarReadGrant({
      organizationId, conversationId, attachmentId,
    })).resolves.toMatchObject({ attachmentId });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId, attachmentId, avatarPath, previousAvatarPath: null, activated: true,
    } }));
    await expect(repo.activateConversationAvatar({
      ...base, conversationId, attachmentId, expectedAvatarPath: null,
    })).resolves.toMatchObject({ avatarPath });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId, previousAvatarPath: avatarPath, avatarPath: null, removed: true,
    } }));
    await expect(repo.removeConversationAvatar({
      ...base, conversationId, expectedAvatarPath: avatarPath,
    })).resolves.toMatchObject({ removed: true });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId, left: true, roleAtDeparture: 'owner', ownershipTransferred: true,
      historyPreserved: true, futureAccessRevoked: true, leftAt: at,
    } }));
    await expect(repo.leaveConversation({
      ...base, conversationId, replacementOwnerMembershipId: otherMembershipId,
      confirmHistoryAndAccessLoss: true,
    })).resolves.toMatchObject({ left: true, ownershipTransferred: true });
  });

  test('accepts exact audit, AI quality, managed-update, audience, acknowledgement, and correction receipts', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };

    for (const [format, contentType, fileName, payload] of [
      ['json', 'application/json', 'newone-audit-20300102-030405.json', '[]'],
      ['csv', 'text/csv', 'newone-audit-20300102-030405.csv', 'id,event\n'],
    ] as const) {
      mockDigest = 'a'.repeat(64);
      mockFetch.mockImplementationOnce(async () => response({ data: {
        receiptId: `audit-${format}`,
        format,
        contentType,
        fileName,
        rowCount: format === 'json' ? 0 : 1,
        payloadBytes: new TextEncoder().encode(payload).byteLength,
        sha256: 'a'.repeat(64),
        createdAt: at,
        payload,
      } }));
      await expect(repo.exportAudit({
        organizationId,
        reasonCode: 'security_review',
        format,
        dateFrom: at,
        dateTo: later,
        eventTypes: undefined,
        actorMembershipId: undefined,
        targetType: undefined,
        targetId: undefined,
      })).resolves.toMatchObject({ format, contentType, fileName });
    }

    mockFetch.mockImplementationOnce(async () => response({ data: aiReport() }));
    await expect(repo.reportAiOutputError({
      ...base,
      outputKind: 'translation',
      translationId: '101',
      summaryId: null,
      category: 'terminology',
      details: 'The translated site term is incorrect.',
      highConsequence: false,
      qualityUseConsent: true,
      consentVersion: 'ai-quality-v1',
    })).resolves.toMatchObject({ reportId, outputKind: 'translation', originalsUnchanged: true });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      reports: [aiReport(), summaryAiReport()],
    } }));
    await expect(repo.listMyAiOutputErrorReports({ organizationId, limit: undefined }))
      .resolves.toHaveLength(2);

    mockFetch.mockImplementationOnce(async () => response({ data: { reports: [] } }));
    await expect(repo.listAiOutputErrorReportsForReview({ organizationId, limit: 5 }))
      .resolves.toEqual([]);

    mockFetch.mockImplementationOnce(async () => response({ data: {
      report: summaryAiReport(),
      regressionExample: null,
    } }));
    await expect(repo.readAiOutputErrorReport({ organizationId, reportId }))
      .resolves.toMatchObject({ report: { outputKind: 'summary' }, regressionExample: null });

    const reviewedReport = aiReport({
      status: 'resolved',
      outcome: 'confirmed_error',
      version: 2,
      reviewedByUserId: otherMembershipId,
      reviewedAt: later,
      reviewNote: 'Confirmed during bounded review.',
    });
    mockFetch.mockImplementationOnce(async () => response({ data: reviewedReport }));
    await expect(repo.reviewAiOutputErrorReport({
      ...base,
      reportId,
      expectedVersion: 1,
      outcome: 'confirmed_error',
      reviewNote: 'Confirmed during bounded review.',
    })).resolves.toMatchObject({ status: 'resolved', outcome: 'confirmed_error' });

    mockFetch.mockImplementationOnce(async () => response({ data: regressionExample() }));
    await expect(repo.proposeAiRegressionExample({
      ...base,
      reportId,
      expectedReportVersion: 2,
      sourceLanguage: 'en',
      deidentifiedSourceText: 'Source text without identifiers.',
      deidentifiedObservedOutput: 'Observed incorrect output.',
      deidentifiedExpectedOutput: 'Expected corrected output.',
      deidentificationAttested: true,
      attestationVersion: 'deidentification-v1',
    })).resolves.toMatchObject({ exampleId, status: 'pending', deduplicated: false });

    const approvedExample = regressionExample({
      status: 'approved',
      version: 2,
      decidedByUserId: otherMembershipId,
      decidedAt: later,
      decisionNote: 'Approved for the bounded regression corpus.',
    });
    mockFetch.mockImplementationOnce(async () => response({ data: approvedExample }));
    await expect(repo.decideAiRegressionExample({
      ...base, exampleId, expectedVersion: 1, decision: 'approved',
      decisionNote: 'Approved for the bounded regression corpus.',
    })).resolves.toMatchObject({ status: 'approved', version: 2 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      updates: [managedUpdate(), managedUpdate({
        announcementId: 'announcement-scheduled',
        announcementVersionId: 'announcement-version-2',
        versionNumber: 2,
        versionCount: 2,
        title: 'Scheduled safety notice',
        body: 'Scheduled safety notice body.',
        priority: 'important',
        notificationClass: 'urgent',
        criticalCategory: 'operations',
        quietHoursOverrideReason: 'Time-sensitive operational condition.',
        requiresAcknowledgement: true,
        acknowledgementSchema: acknowledgementSchema(true),
        reminderPolicy: reminderPolicy(true),
        status: 'scheduled',
        scheduledAt: later,
        publishedAt: null,
        correctionOfVersionId: 'announcement-version-1',
        correctionReason: 'Clarified the required response.',
        recipientCount: 3,
        deliveredCount: 2,
        readCount: 1,
        acknowledgedCount: 1,
        nonAcknowledgedCount: 2,
        overdueCount: 1,
        unreachableCount: 1,
        versions: [
          managedVersion({
            announcementVersionId: 'announcement-version-2',
            versionNumber: 2,
            title: 'Scheduled safety notice',
            body: 'Scheduled safety notice body.',
            publishedAt: null,
            correctionOfVersionId: 'announcement-version-1',
            correctionReason: 'Clarified the required response.',
          }),
          managedVersion({ announcementVersionId: 'announcement-version-1', versionNumber: 1 }),
        ],
      }), managedUpdate({
        announcementId: 'announcement-cancelled',
        announcementVersionId: 'announcement-version-cancelled',
        priority: 'emergency',
        notificationClass: 'critical',
        criticalCategory: 'safety',
        quietHoursOverrideReason: 'Immediate safety communication.',
        status: 'cancelled',
        scheduledAt: at,
        publishedAt: null,
        cancelledAt: later,
        cancellationReason: 'Condition resolved before publication.',
        versions: [managedVersion({ announcementVersionId: 'announcement-version-cancelled' })],
      })],
      generatedAt: later,
      smsFallbackAvailable: false,
    } }));
    await expect(repo.listManagedUpdates({ organizationId, limit: 200 }))
      .resolves.toMatchObject({ updates: [{ status: 'published' }, { status: 'scheduled' }, { status: 'cancelled' }] });

    const previewSpec = audienceSpec({
      company: false,
      conversationMembers: true,
      siteIds: [membershipId],
      membershipRoles: ['manager'],
      languages: ['en', 'es'],
      currentShiftOnly: true,
    });
    mockFetch.mockImplementationOnce(async () => response({ data: {
      preview: [{
        userId: membershipId,
        displayName: 'Jordan Recipient',
        preferredLanguage: 'en',
        membershipRole: 'owner',
        unitIds: [membershipId, 5],
        currentShift: true,
      }, {
        userId: otherMembershipId,
        displayName: 'Taylor Recipient',
        preferredLanguage: 'es',
        membershipRole: 'unsupported-role',
        unitIds: null,
        currentShift: false,
      }],
      sampleUserIds: [membershipId, 4, otherMembershipId],
      audienceCount: 2,
      excludedCount: 1,
      notificationLanguages: ['en', 4, 'es'],
      exclusionCounts: { inactiveMembers: 1, selectorMismatch: 0 },
      audienceSpec: previewSpec,
      snapshotBasis: 'active_members_and_current_shift_at_publish',
      generatedAt: later,
    } }));
    await expect(repo.previewUpdateAudience({
      ...base, conversationId, audienceSpec: previewSpec,
    })).resolves.toMatchObject({
      audienceCount: 2,
      sampleUserIds: [membershipId, otherMembershipId],
      snapshotBasis: 'active_members_and_current_shift_at_publish',
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      preview: [],
      totalCount: 0,
      reconcileAfter: later,
      audienceSpec: {},
    } }));
    await expect(repo.previewUpdateAudience({
      ...base, conversationId, audienceSpec: audienceSpec(),
    })).resolves.toMatchObject({
      audienceCount: 0,
      excludedCount: 0,
      normalizedSpec: audienceSpec(),
      snapshotBasis: 'active_members_at_publish',
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      announcementId: 'announcement-scheduled',
      announcementVersionId: 'announcement-version-scheduled',
      status: 'scheduled',
      scheduledAt: later,
    } }));
    await expect(repo.publishUpdate({
      ...base,
      conversationId,
      clientMessageId: 'scheduled-client-message',
      title: 'Scheduled update',
      body: 'Scheduled controlled update.',
      languageCode: 'en',
      priority: 'important',
      requiresAcknowledgement: true,
      notificationClass: 'urgent',
      criticalCategory: 'operations',
      quietHoursOverrideReason: 'Time-sensitive condition.',
      acknowledgementSchema: acknowledgementSchema(true),
      reminderPolicy: reminderPolicy(true),
      expiresAt: null,
      scheduledAt: later,
      audienceSpec: audienceSpec(),
    })).resolves.toMatchObject({
      announcementId: 'announcement-scheduled', status: 'scheduled', messageId: undefined,
      audienceCount: undefined,
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      announcementId: 'announcement-a',
      announcementVersionId: 'announcement-version-a',
      acknowledgedAt: later,
      sessionId: 'session-a',
      deviceId: null,
      installationId,
      platform: 'web',
      clientFamily: 'desktop',
      sessionEvidenceCaptured: true,
    } }));
    await expect(repo.acknowledgeUpdate({
      ...base,
      versionId: 'announcement-version-a',
      deviceId: null,
      attestation: { confirmed: true },
    })).resolves.toMatchObject({ deviceId: null, platform: 'web', sessionEvidenceCaptured: true });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      announcementId: 'announcement-a',
      announcementVersionId: 'announcement-version-2',
      versionNumber: 2,
      messageId: '104',
    } }));
    await expect(repo.correctUpdate({
      ...base,
      announcementId: 'announcement-a',
      clientMessageId: 'correction-client-a',
      title: 'Corrected title',
      body: 'Corrected controlled body.',
      priority: 'normal',
      requiresAcknowledgement: false,
      expiresAt: null,
      reason: 'Corrected an operational detail.',
    })).resolves.toMatchObject({ versionNumber: 2, messageId: '104' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      announcementId: 'announcement-a',
      announcementVersionId: 'announcement-version-a',
      versionNumber: 1,
      deadlineAt: later,
      people: [{
        userId: membershipId,
        displayName: 'Jordan Recipient',
        preferredLanguage: 'en',
        membershipStatus: 'active',
        deliveredAt: at,
        readAt: later,
        reminderCount: 1,
        lastRemindedAt: later,
        escalatedAt: null,
        reachability: 'delivered',
        overdue: false,
      }, {
        userId: otherMembershipId,
        displayName: 'Taylor Recipient',
        preferredLanguage: 'es',
        membershipStatus: 'suspended',
        deliveredAt: null,
        readAt: null,
        reminderCount: 0,
        lastRemindedAt: null,
        escalatedAt: null,
        reachability: 'pending',
        overdue: true,
      }],
      hasMore: true,
      nextAfterUserId: otherMembershipId,
      privacyScope: 'notice_response_state_only',
    } }));
    await expect(repo.listUpdateNonAcknowledgers({
      organizationId, announcementId: 'announcement-a', limit: 2,
    })).resolves.toMatchObject({ hasMore: true, people: [{ reachability: 'delivered' }, { reachability: 'pending' }] });
  });

  test('accepts exact attachment download, reporting, handoff correction, role, invitation, session, and device receipts', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };

    mockFetch.mockImplementationOnce(async () => response({ data: { grant: {
      action: 'download',
      attachmentId,
      signedUrl: 'https://project.supabase.co/storage/v1/object/sign/message-attachments/path?token=controlled-token-123456',
      expiresInSeconds: 120,
    } } }));
    await expect(repo.createAttachmentDownloadGrant({
      ...base, conversationId, attachmentId,
    })).resolves.toMatchObject({ action: 'download', attachmentId });

    for (const [targetType, call] of [
      ['message', () => repo.reportMessage({
        ...base, conversationId, messageId: '101', category: 'other', details: undefined,
        consentToShare: true, contextBefore: 2, contextAfter: 1,
        noticeVersion: 'moderation-report-v2',
      })],
      ['group', () => repo.reportGroup({
        ...base, conversationId, category: 'other', details: undefined,
        consentToShare: true, noticeVersion: 'moderation-report-v2',
      })],
      ['member', () => repo.reportMember({
        ...base, membershipId, category: 'other', details: undefined,
        consentToShare: true, noticeVersion: 'moderation-report-v2',
      })],
    ] as const) {
      mockFetch.mockImplementationOnce(async () => response({ data: {
        reportId,
        status: 'open',
        targetType,
        created: true,
        reporterIdentityProtected: true,
        targetNotNotified: true,
        noticeVersion: targetType === 'message' ? 'moderation-share-v1' : 'moderation-report-v2',
        contextBefore: targetType === 'message' ? 2 : 0,
        contextAfter: targetType === 'message' ? 1 : 0,
      } }));
      await expect(call()).resolves.toMatchObject({ targetType, created: true });
    }

    mockFetch.mockImplementationOnce(async () => response({ data: {
      handoffId: reportId,
      handoffVersionId: otherMembershipId,
      versionNumber: 4,
      status: 'draft',
      requiresSignature: true,
      sourceMessageIds: [99, 102],
      sourceFingerprint: 'a'.repeat(64),
      sourceState: 'current',
      acknowledgementDueAt: later,
      reminderState: 'not_due',
      escalationState: 'not_due',
      smsFallbackAvailable: false,
    } }));
    await expect(repo.correctHandoff({
      ...base,
      handoffId: reportId,
      expectedVersionId: membershipId,
      expectedVersionNumber: 3,
      title: '  Corrected pressure handoff  ',
      details: '  Gauge P-14 reads 41 PSI after calibration.  ',
      sourceLanguage: 'en',
      shiftStartedAt: '2030-01-02T01:00:00.000Z',
      shiftEndedAt: '2030-01-02T03:30:00.000Z',
      sourceMessageIds: ['102', '99'],
      acknowledgementDueAt: later,
      reason: '  Previous version transposed the pressure value.  ',
    })).resolves.toMatchObject({ handoffId: reportId, versionNumber: 4 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      assignments: [roleAssignment(), roleAssignment({
        assignmentId: 'assignment-unit',
        roleName: 'site_admin',
        scopeType: 'unit',
        unitId: membershipId,
        expiresAt: later,
        revokedAt: at,
        active: false,
      })],
    } }));
    await expect(repo.queryRoleAssignments({
      ...base, targetMembershipId: membershipId, limit: undefined,
    })).resolves.toHaveLength(2);

    mockFetch.mockImplementationOnce(async () => response({ data: roleAssignment({
      roleName: 'security_admin',
    }) }));
    await expect(repo.assignAdminRole({
      ...base,
      targetMembershipId: membershipId,
      roleName: 'security_admin',
      scopeType: 'organization',
      unitId: null,
      expiresAt: null,
      reason: 'Authorized security assignment.',
    })).resolves.toMatchObject({ roleName: 'security_admin' });

    mockFetch.mockImplementationOnce(async () => response({ data: invitation() }));
    await expect(repo.issueInvitation({
      ...base,
      destinationType: 'email', destination: 'controlled@example.test', employeeCode: undefined,
      activationMode: 'otp', role: 'admin', expiresInSeconds: 3600,
      membershipType: 'employee', membershipAccessExpiresAt: null, guestSponsorUserId: null,
    })).resolves.toMatchObject({ membershipType: 'employee', activationToken: null });

    mockFetch.mockImplementationOnce(async () => response({ data: invitation({
      inviteId: 'invite-contractor',
      destinationType: 'phone',
      destinationMasked: '***-***-0199',
      role: 'manager',
      activationMode: 'manual',
      activationToken: 'one-time-controlled-token',
      employeeCode: 'CONTRACT-7',
      membershipType: 'contractor',
      membershipAccessExpiresAt: later,
    }) }));
    await expect(repo.issueInvitation({
      ...base,
      destinationType: 'phone', destination: '+13035550199', employeeCode: 'CONTRACT-7',
      activationMode: 'manual', role: 'manager', expiresInSeconds: 3600,
      membershipType: 'contractor', membershipAccessExpiresAt: later, guestSponsorUserId: null,
    })).resolves.toMatchObject({ membershipType: 'contractor', activationToken: 'one-time-controlled-token' });

    mockFetch.mockImplementationOnce(async () => response({ data: invitation({
      inviteId: 'invite-guest',
      role: 'member',
      membershipType: 'guest',
      membershipAccessExpiresAt: later,
      guestSponsorUserId: otherMembershipId,
    }) }));
    await expect(repo.issueInvitation({
      ...base,
      destinationType: 'email', destination: 'guest@example.test', employeeCode: null,
      activationMode: 'otp', role: 'member', expiresInSeconds: 3600,
      membershipType: 'guest', membershipAccessExpiresAt: later,
      guestSponsorUserId: otherMembershipId,
    })).resolves.toMatchObject({ membershipType: 'guest', guestSponsorUserId: otherMembershipId });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      sessions: [accountSession(), accountSession({
        sessionId: 'session-web',
        current: false,
        platform: null,
        device: null,
        expiresAt: null,
        revoked: true,
        aal: 'aal1',
        signal: { sameNetworkAsCurrent: false, clientFamily: 'unknown' },
      })],
    } }));
    await expect(repo.listSessions(base)).resolves.toMatchObject([
      { platform: 'ios', device: { appVersion: '1.2.3' } },
      { platform: null, device: null, revoked: true },
    ]);

    mockFetch.mockImplementationOnce(async () => response({ data: devicePreferences() }));
    await expect(repo.getDeviceNotificationPreferences({ organizationId, installationId }))
      .resolves.toMatchObject({ deviceId, preferenceVersion: 4 });

    mockFetch.mockImplementationOnce(async () => response({ data: devicePreferences({
      preferenceVersion: 5,
      overrides: {
        notificationPreview: null,
        soundEnabled: true,
        vibrationEnabled: false,
      },
      effective: {
        notificationPreview: 'generic',
        soundEnabled: true,
        vibrationEnabled: false,
      },
    }) }));
    await expect(repo.updateDeviceNotificationPreferences({
      ...base,
      installationId,
      expectedVersion: 4,
      patch: { notificationPreview: null, soundEnabled: true, vibrationEnabled: false },
    })).resolves.toMatchObject({ preferenceVersion: 5 });
  });

  test('accepts exact successful message, moderation, attachment, update, admin, and preference receipts', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };
    const at = '2026-08-04T18:00:00.000Z';

    mockFetch.mockImplementationOnce(async () => response({ data: {
      message_id: 101,
      client_message_id: 'client-message-a',
      next_cursor: null,
      translation_targets: ['es', 'ko'],
    } }));
    await expect(repo.sendMessage({
      ...base,
      conversationId,
      clientMessageId: 'client-message-a',
      body: 'Controlled production message',
      kind: 'text',
      languageCode: 'en',
      replyToMessageId: '99',
      mentionUserIds: [membershipId],
    })).resolves.toEqual({
      messageId: '101', clientMessageId: 'client-message-a', cursor: null, translationTargets: ['es', 'ko'],
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId, messageId: '101', scope: 'self', deliveredAt: at, readAt: at,
    } }));
    await expect(repo.markMessageReceipt({
      ...base, conversationId, messageId: '101', state: 'read',
    })).resolves.toMatchObject({ scope: 'self', deliveredAt: at, readAt: at });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      translationId: 'translation-a', status: 'queued', retried: false,
    } }));
    await expect(repo.requestTranslation({
      ...base, conversationId, messageId: '101', targetLanguage: 'es',
    })).resolves.toEqual({ translationId: 'translation-a', status: 'queued', retried: false });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      correctionId: 'correction-a', status: 'pending',
    } }));
    await expect(repo.proposeTranslationCorrection({
      ...base,
      conversationId,
      messageId: '101',
      targetLanguage: 'es',
      correctedBody: 'Texto corregido',
      rationale: 'Site terminology',
    })).resolves.toEqual({ correctionId: 'correction-a', status: 'pending' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      messageId: '102', clientMessageId: 'forward-a',
    } }));
    await expect(repo.forwardMessage({
      ...base,
      sourceConversationId: conversationId,
      sourceMessageId: '101',
      targetConversationId: 'conversation-b',
      clientMessageId: 'forward-a',
    })).resolves.toEqual({ messageId: '102', clientMessageId: 'forward-a' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      holdId: 'hold-a', messageId: '101', holdType: 'legal', active: true,
    } }));
    await expect(repo.placeMessagePreservationHold({
      ...base,
      conversationId,
      messageId: '101',
      holdType: 'legal',
      reasonCode: 'legal_request',
      policyReferenceSha256: 'a'.repeat(64),
    })).resolves.toMatchObject({ holdId: 'hold-a', active: true });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      holdId: 'hold-a', messageId: '101', active: false, releasedAt: at,
    } }));
    await expect(repo.releaseMessagePreservationHold({
      ...base, holdId: 'hold-a', releaseReasonCode: 'matter_closed',
    })).resolves.toMatchObject({ holdId: 'hold-a', active: false, releasedAt: at });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      grant: {
        action: 'upload',
        attachmentId: 'attachment-a',
        bucket: 'message-attachments',
        path: `${organizationId}/${conversationId}/101/attachment-a`,
        signedUrl: 'https://project.supabase.co/storage/v1/object/upload/sign/message-attachments/path?token=controlled-token-123456',
        token: 'controlled',
        expiresInSeconds: 7200,
      },
    } }));
    await expect(repo.createAttachmentUploadGrant({
      ...base,
      conversationId,
      messageId: '101',
      fileName: 'procedure.pdf',
      mimeType: 'application/pdf',
      byteSize: 4096,
      sha256Hex: 'b'.repeat(64),
    })).resolves.toMatchObject({ action: 'upload', attachmentId: 'attachment-a' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      attachmentId: 'attachment-a', scanStatus: 'pending', scanJobId: 'scan-a',
    } }));
    await expect(repo.completeAttachmentUpload({
      ...base,
      attachmentId: 'attachment-a',
      bucket: 'message-attachments',
      path: `${organizationId}/${conversationId}/101/attachment-a`,
      byteSize: 4096,
      sha256Hex: 'b'.repeat(64),
    })).resolves.toEqual({ attachmentId: 'attachment-a', scanStatus: 'pending', scanJobId: 'scan-a' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      attachmentId: 'attachment-a', scanStatus: 'clean', reasonCode: null,
    } }));
    await expect(repo.getAttachmentState({ ...base, attachmentId: 'attachment-a' }))
      .resolves.toEqual({ attachmentId: 'attachment-a', scanStatus: 'clean', reasonCode: null });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      announcementId: 'announcement-a',
      announcementVersionId: 'version-a',
      messageId: '103',
      status: 'published',
      scheduledAt: null,
      audienceCount: 14,
    } }));
    await expect(repo.publishUpdate({
      ...base,
      conversationId,
      clientMessageId: 'update-client-a',
      title: 'Controlled update',
      body: 'A verified operational notice.',
      languageCode: 'en',
      priority: 'normal',
      requiresAcknowledgement: false,
      notificationClass: 'routine',
      audienceSpec: {
        company: true,
        conversationMembers: false,
        siteIds: [], departmentIds: [], teamIds: [], unitIds: [], operationalRoles: [],
        membershipRoles: [], languages: [], currentShiftOnly: false,
      },
    })).resolves.toMatchObject({ announcementId: 'announcement-a', status: 'published', audienceCount: 14 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      announcementId: 'announcement-a', readAt: at, deliveredAt: at,
    } }));
    await expect(repo.markUpdateRead({ ...base, announcementId: 'announcement-a' }))
      .resolves.toEqual({ announcementId: 'announcement-a', readAt: at, deliveredAt: at });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      handoffId: 'handoff-a', handoffVersionId: 'handoff-version-a',
    } }));
    await expect(repo.createHandoff({
      ...base,
      conversationId,
      title: 'Shift handoff',
      details: 'Verified source details',
      sourceLanguage: 'en',
      shiftStartedAt: at,
      shiftEndedAt: '2026-08-04T20:00:00.000Z',
      sourceMessageIds: ['101'],
      acknowledgementDueAt: null,
    })).resolves.toEqual({ handoffId: 'handoff-a', versionId: 'handoff-version-a' });

    mockFetch.mockImplementationOnce(async () => response({ data: { actionId: 'action-a' } }));
    await expect(repo.proposeAction({
      ...base,
      conversationId,
      sourceMessageId: '101',
      title: 'Inspect valve',
      details: null,
    })).resolves.toEqual({ actionId: 'action-a' });

    mockFetch.mockImplementationOnce(async () => response({ data: { alias: 'Ana T', isFavorite: true } }));
    await expect(repo.saveContact({ ...base, membershipId, alias: 'Ana T', isFavorite: true }))
      .resolves.toEqual({ alias: 'Ana T', isFavorite: true });

    const preferences = {
      uiLanguage: 'en',
      messageLanguage: 'es',
      timeZone: 'America/Denver',
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
      quietDays: [0, 6, 9],
      notificationPreview: 'generic',
      soundEnabled: true,
      vibrationEnabled: false,
      shiftAwareSuppression: true,
      readVisibility: 'contacts',
    };
    mockFetch.mockImplementationOnce(async () => response({ data: preferences }));
    await expect(repo.loadOrganizationPreferences(base)).resolves.toEqual({
      ...preferences, quietDays: [0, 6],
    });
    mockFetch.mockImplementationOnce(async () => response({ data: preferences }));
    await expect(repo.updateOrganizationPreferences({ ...base, patch: { soundEnabled: true } }))
      .resolves.toMatchObject({ timeZone: 'America/Denver', soundEnabled: true });

    expect(mockFetch).toHaveBeenCalledTimes(17);
  });

  test('rejects malformed candidate, AI report, and regression response boundaries', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };
    const candidate = {
      userId: membershipId,
      displayName: 'Jordan Candidate',
    };

    mockFetch.mockImplementationOnce(async () => response({ data: {
      candidates: [candidate],
      nextCursor: `cursor.${'a'.repeat(64)}`,
    } }));
    await expect(repo.listConversationMemberCandidates({
      organizationId, conversationId, query: '', limit: 1,
    })).resolves.toEqual({
      candidates: [candidate],
      nextCursor: `cursor.${'a'.repeat(64)}`,
    });

    for (const payload of [
      { candidates: 'not-an-array', nextCursor: null },
      { candidates: [candidate, candidate], nextCursor: null },
      { candidates: [{ ...candidate, unexpected: true }], nextCursor: null },
      { candidates: [{ ...candidate, userId: 'not-a-uuid' }], nextCursor: null },
      { candidates: [{ ...candidate, displayName: '' }], nextCursor: null },
      { candidates: [{ ...candidate, displayName: ' Jordan' }], nextCursor: null },
      { candidates: [{ ...candidate, avatarPath: null }], nextCursor: null },
      { candidates: [{ ...candidate, roleLabel: ' ' }], nextCursor: null },
      { candidates: [{ ...candidate, membershipType: 'external' }], nextCursor: null },
      { candidates: [candidate], nextCursor: '' },
      { candidates: [candidate], nextCursor: `cursor.${'a'.repeat(64)}` },
    ]) {
      await expectInvalidResponse(payload, () => repo.listConversationMemberCandidates({
        organizationId, conversationId, query: '', limit: 2,
      }));
    }

    mockFetch.mockImplementationOnce(async () => response({ data: joinRequest({ requestId: 123 }) }));
    await expect(repo.requestConversationJoin({ ...base, conversationId }))
      .resolves.toMatchObject({ requestId: '123' });
    await expectInvalidResponse(joinRequest({ version: 0 }), () =>
      repo.requestConversationJoin({ ...base, conversationId }));
    await expectInvalidResponse(joinRequest({ decidedAt: 'not-a-date' }), () =>
      repo.requestConversationJoin({ ...base, conversationId }));

    const invalidReports = [
      { ...aiReport(), unexpected: true },
      aiReport({ outputKind: 'other' }),
      aiReport({ category: 'unsupported_category' }),
      aiReport({ summaryId }),
      aiReport({ translationId: '0' }),
      aiReport({ highConsequence: 'false' }),
      aiReport({ qualityUseConsent: 'true' }),
      aiReport({ targetSourceFingerprint: 'a' }),
      aiReport({ targetOutputFingerprint: 'b' }),
      aiReport({ targetLanguage: 'invalid language' }),
      aiReport({ status: 'unknown' }),
      aiReport({ outcome: 'unknown' }),
      aiReport({ targetSnapshot: { ...aiReport().targetSnapshot, schemaVersion: 2 } }),
      aiReport({ targetSnapshot: { ...aiReport().targetSnapshot, translationId: '102' } }),
      aiReport({ targetSnapshot: { ...aiReport().targetSnapshot, translatedBody: 4 } }),
      aiReport({ targetSnapshot: { ...aiReport().targetSnapshot, messageId: '0' } }),
      summaryAiReport({ targetSnapshot: { ...summaryAiReport().targetSnapshot, summaryId: reportId } }),
      summaryAiReport({ targetSnapshot: { ...summaryAiReport().targetSnapshot, summaryBody: 4 } }),
      summaryAiReport({ targetSnapshot: { ...summaryAiReport().targetSnapshot, sourceMessageIds: '101' } }),
      aiReport({ reportId: 'not-a-uuid' }),
    ];
    for (const report of invalidReports) {
      await expectInvalidResponse({ reports: [report] }, () =>
        repo.listMyAiOutputErrorReports({ organizationId, limit: 1 }));
    }

    await expectInvalidResponse({
      report: aiReport(), regressionExample: null, unexpected: true,
    }, () => repo.readAiOutputErrorReport({ organizationId, reportId }));

    const decided = {
      status: 'approved',
      version: 2,
      decidedByUserId: otherMembershipId,
      decidedAt: later,
      decisionNote: 'Reviewed under the controlled test policy.',
    };
    const invalidExamples = [
      { ...regressionExample(), unexpected: true },
      regressionExample({ outputKind: 'other' }),
      regressionExample({ errorCategory: 'unsupported_category' }),
      regressionExample({ consequenceLevel: 'severe' }),
      regressionExample({ status: 'unknown' }),
      regressionExample({ sourceLanguage: 'invalid language' }),
      regressionExample({ targetLanguage: 'invalid language' }),
      regressionExample({ deidentifiedExpectedOutput: 'Observed incorrect output.' }),
      regressionExample({ decidedByUserId: otherMembershipId }),
      regressionExample({ ...decided, decidedAt: null }),
      regressionExample({ ...decided, status: 'exported', exportedAt: null }),
      regressionExample({ ...decided, exportedAt: later }),
    ];
    for (const example of invalidExamples) {
      await expectInvalidResponse(example, () => repo.decideAiRegressionExample({
        ...base,
        exampleId,
        expectedVersion: 1,
        decision: 'approved',
        decisionNote: 'Reviewed under the controlled test policy.',
      }));
    }

    const exportedExample = regressionExample({
      ...decided,
      status: 'exported',
      exportedAt: later,
    });
    mockFetch.mockImplementationOnce(async () => response({ data: {
      report: aiReport(), regressionExample: exportedExample,
    } }));
    await expect(repo.readAiOutputErrorReport({ organizationId, reportId }))
      .resolves.toMatchObject({ regressionExample: { status: 'exported', exportedAt: later } });
  });

  test('rejects malformed managed-update policies and inconsistent lifecycle state', async () => {
    const repo = repository();
    const call = () => repo.listManagedUpdates({ organizationId, limit: 1 });
    const payload = (update: Record<string, unknown>) => ({
      updates: [update],
      generatedAt: later,
      smsFallbackAvailable: false,
    });
    const acknowledgedUpdate = (overrides: Record<string, unknown> = {}) => managedUpdate({
      requiresAcknowledgement: true,
      acknowledgementSchema: acknowledgementSchema(true),
      reminderPolicy: reminderPolicy(true),
      acknowledgedCount: 1,
      nonAcknowledgedCount: 2,
      overdueCount: 1,
      ...overrides,
    });

    const malformedUpdateShapes = [
      { ...managedUpdate(), unexpected: true },
      managedUpdate({ priority: 'unknown' }),
      managedUpdate({ notificationClass: 'unknown' }),
      managedUpdate({ status: 'unknown' }),
      managedUpdate({ criticalCategory: 'unknown' }),
      managedUpdate({ languageCode: 'fr' }),
      managedUpdate({ versions: 'not-an-array' }),
      managedUpdate({ requiresAcknowledgement: 'true' }),
      managedUpdate({ audienceSnapshotted: 'true' }),
    ];
    for (const update of malformedUpdateShapes) {
      await expectInvalidResponse(payload(update), call);
    }

    const acknowledgementMutations = [
      { ...acknowledgementSchema(true), unexpected: true },
      { ...acknowledgementSchema(true), schemaVersion: 2 },
      { ...acknowledgementSchema(true), attestationRequired: 'true' },
      { ...acknowledgementSchema(true), attestationPrompt: 4 },
      { ...acknowledgementSchema(true), requiredKeys: 'confirmed' },
      { ...acknowledgementSchema(true), requiredKeys: Array.from({ length: 21 }, (_, index) => `key_${index}`) },
      { ...acknowledgementSchema(true), requiredKeys: ['Invalid-Key'] },
      { ...acknowledgementSchema(true), requiredKeys: ['confirmed', 'confirmed'] },
      { ...acknowledgementSchema(true), carryForwardOnCorrection: true },
      { ...acknowledgementSchema(true), attestationPrompt: null },
      { ...acknowledgementSchema(true), attestationPrompt: 'x' },
      { ...acknowledgementSchema(true), attestationPrompt: 'x'.repeat(501) },
      { ...acknowledgementSchema(true), requiredKeys: [] },
      { ...acknowledgementSchema(false), attestationPrompt: 'Unexpected prompt' },
      { ...acknowledgementSchema(false), requiredKeys: ['confirmed'] },
    ];
    for (const acknowledgement of acknowledgementMutations) {
      await expectInvalidResponse(payload(acknowledgedUpdate({
        acknowledgementSchema: acknowledgement,
      })), call);
    }

    const reminderMutations = [
      { ...reminderPolicy(true), unexpected: true },
      { ...reminderPolicy(true), enabled: 'true' },
      { ...reminderPolicy(true), deadlineAt: 4 },
      { ...reminderPolicy(true), intervalSeconds: 300.5 },
      { ...reminderPolicy(true), maximumReminders: 2.5 },
      { ...reminderPolicy(true), escalateAfterSeconds: 900.5 },
      { ...reminderPolicy(true), smsFallback: true },
      { ...reminderPolicy(true), deadlineAt: null },
      { ...reminderPolicy(true), deadlineAt: 'not-a-date' },
      { ...reminderPolicy(true), intervalSeconds: null },
      { ...reminderPolicy(true), intervalSeconds: 299 },
      { ...reminderPolicy(true), intervalSeconds: 604801 },
      { ...reminderPolicy(true), maximumReminders: 0 },
      { ...reminderPolicy(true), maximumReminders: 21 },
      { ...reminderPolicy(true), escalateAfterSeconds: 899 },
      { ...reminderPolicy(true), escalateAfterSeconds: 2592001 },
      { ...reminderPolicy(true), intervalSeconds: 1000, escalateAfterSeconds: 900 },
      { ...reminderPolicy(false), deadlineAt: later },
      { ...reminderPolicy(false), intervalSeconds: 300 },
      { ...reminderPolicy(false), maximumReminders: 1 },
      { ...reminderPolicy(false), escalateAfterSeconds: 900 },
    ];
    for (const reminder of reminderMutations) {
      await expectInvalidResponse(payload(acknowledgedUpdate({ reminderPolicy: reminder })), call);
    }

    await expectInvalidResponse(payload(managedUpdate({
      versions: [{ ...managedVersion(), unexpected: true }],
    })), call);
    await expectInvalidResponse(payload(managedUpdate({
      versions: [managedVersion({ versionNumber: 0 })],
    })), call);

    const inconsistentUpdates = [
      managedUpdate({ notificationClass: 'urgent' }),
      managedUpdate({ criticalCategory: 'operations' }),
      managedUpdate({ priority: 'important', notificationClass: 'urgent' }),
      managedUpdate({ status: 'scheduled', scheduledAt: null, publishedAt: null }),
      managedUpdate({
        status: 'cancelled', scheduledAt: at, publishedAt: null,
        cancelledAt: later, cancellationReason: null,
      }),
      managedUpdate({ deliveredCount: 4 }),
      managedUpdate({ readCount: 4 }),
      managedUpdate({ acknowledgedCount: 4 }),
      managedUpdate({ nonAcknowledgedCount: 4 }),
      managedUpdate({ overdueCount: 1 }),
      managedUpdate({ unreachableCount: 4 }),
      managedUpdate({ acknowledgedCount: 1 }),
      acknowledgedUpdate({ acknowledgedCount: 1, nonAcknowledgedCount: 1 }),
      managedUpdate({ versions: [] }),
      managedUpdate({
        versionCount: 21,
        versions: Array.from({ length: 21 }, (_, index) => managedVersion({
          announcementVersionId: `version-${index}`,
          versionNumber: 21 - index,
        })),
      }),
      managedUpdate({ versionCount: 1, versions: [managedVersion(), managedVersion()] }),
      managedUpdate({ versions: [managedVersion({ announcementVersionId: 'other-version' })] }),
      managedUpdate({ versions: [managedVersion({ versionNumber: 2 })] }),
      managedUpdate({
        versionNumber: 2,
        versionCount: 2,
        versions: [
          managedVersion({ versionNumber: 2 }),
          managedVersion({ announcementVersionId: 'older-version', versionNumber: 2 }),
        ],
      }),
      managedUpdate({ acknowledgementSchema: acknowledgementSchema(true) }),
      managedUpdate({ reminderPolicy: reminderPolicy(true) }),
    ];
    for (const update of inconsistentUpdates) {
      await expectInvalidResponse(payload(update), call);
    }

    mockFetch.mockImplementationOnce(async () => response({ data: payload(acknowledgedUpdate({
      reminderPolicy: { ...reminderPolicy(true), escalateAfterSeconds: null },
    })) }));
    await expect(call()).resolves.toMatchObject({ updates: [{ requiresAcknowledgement: true }] });
  });

  test('preserves omission semantics and exercises default query boundaries', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };

    mockFetch.mockImplementationOnce(async () => response({ data: {
      candidates: [], limit: 50,
    } }));
    await expect(repo.listGroupCreationCandidates({ organizationId }))
      .resolves.toMatchObject({ candidates: [], limit: 50 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      candidates: [], nextCursor: null,
    } }));
    await expect(repo.listConversationMemberCandidates({ organizationId, conversationId }))
      .resolves.toEqual({ candidates: [], nextCursor: null });

    await repo.updateConversation({ ...base, conversationId });
    await repo.updateOrganizationConversationControls({
      ...base,
      reason: 'Controlled omission-boundary verification.',
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      policies: [], limit: 50, nextAfterPolicyId: null,
    } }));
    await expect(repo.listDynamicGroupPolicies({ organizationId }))
      .resolves.toMatchObject({ policies: [], limit: 50 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      policyId,
      policyVersion: 3,
      previewFingerprint: 'b'.repeat(64),
      selectorFingerprint: 'a'.repeat(64),
      membershipStateFingerprint: 'c'.repeat(64),
      evaluatedAt: at,
      validUntil: later,
      eligibleCount: 0,
      addedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      addedSampleUserIds: [],
      removedSampleUserIds: [],
      unchangedSampleUserIds: [],
      nextBoundaryAt: null,
    } }));
    await expect(repo.previewDynamicGroupPolicy({
      organizationId, policyId, expectedVersion: 3,
    })).resolves.toMatchObject({ policyId, eligibleCount: 0 });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId,
      postingMode: 'all_members',
      configuredJoinPolicy: 'approval_required',
      joinPolicy: 'approval_required',
      visibility: 'unit',
    } }));
    await expect(repo.updateConversationControls({
      ...base,
      conversationId,
      joinPolicy: 'approval_required',
      visibility: 'unit',
      reason: 'Controlled omission-boundary verification.',
    })).resolves.toMatchObject({ postingMode: 'all_members', visibility: 'unit' });

    mockFetch.mockImplementationOnce(async () => response({ data: { conversations: [] } }));
    await expect(repo.listDiscoverableConversations({ organizationId })).resolves.toEqual([]);
    mockFetch.mockImplementationOnce(async () => response({ data: { joinRequests: [] } }));
    await expect(repo.listConversationJoinRequests({ organizationId, conversationId }))
      .resolves.toEqual([]);

    await repo.updateConversationPreferences({ ...base, conversationId });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      historyVisibleFrom: null,
      historyPolicy: 'since_join',
      historyDisclosure: {
        policy: 'since_join', visibleFrom: null, labelKey: 'conversation.history.since_join',
      },
    } }));
    await expect(repo.addConversationMember({
      ...base, conversationId, membershipId, role: 'member',
    })).resolves.toEqual({
      historyVisibleFrom: null,
      historyPolicy: 'since_join',
      historyDisclosure: {
        policy: 'since_join', visibleFrom: null, labelKey: 'conversation.history.since_join',
      },
    });

    const bodies = mockFetch.mock.calls.slice(-11).map(([, init]) =>
      JSON.parse(String((init as RequestInit).body)));
    expect(bodies[2]).toEqual({ organizationId });
    expect(bodies[3]).toEqual({
      organizationId,
      reason: 'Controlled omission-boundary verification.',
    });
    expect(bodies[9]).toEqual({ organizationId });
  });

  test('fails closed on policy, dynamic-group, role, and avatar receipt mismatches', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };
    const organizationPolicy = {
      messageRetentionDays: 180,
      allowMemberDirectMessages: false,
      dmPolicy: 'request_first' as const,
      requireMfaForAdmins: true,
      shiftScheduleAuthoritative: true,
      groupCreationPolicy: 'admins' as const,
      allowExternalGuests: false,
      externalGuestMaxAccessDays: 45,
      version: 2,
      reason: 'Controlled policy verification.',
    };
    const aiPolicyInput: Parameters<typeof repo.updateOrganizationAiPolicy>[0]['policy'] = {
      enabled: true,
      approvedUseCases: ['summary', 'translation'],
      providerAllowlist: ['google-vertex/us-south1'],
      routePolicy: 'approved_zero_retention' as const,
      expectedVersion: 2,
      reason: 'Controlled AI policy verification.',
    };
    const policySpec: Parameters<typeof repo.saveDynamicGroupPolicy>[0]['policySpec'] = {
      siteIds: [], departmentIds: [], teamIds: [membershipId], lineIds: [], unitIds: [],
      includeDescendants: true,
      operationalRoles: ['shift lead'],
      membershipRoles: ['manager', 'member'],
      shiftMode: 'current',
      scheduledShiftStartsAt: null,
      scheduledShiftEndsAt: null,
    };

    await expect(repo.updateOrganizationPolicy({ ...base, policy: {} as never }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expectInvalidResponse({}, () => repo.updateOrganizationPolicy({
      ...base, policy: organizationPolicy,
    }));
    await expectInvalidResponse({}, () => repo.getOrganizationAiPolicy({ organizationId }));
    await expect(repo.updateOrganizationAiPolicy({ ...base, policy: {} as never }))
      .rejects.toMatchObject({ code: 'invalid_request' });
    await expectInvalidResponse({}, () => repo.updateOrganizationAiPolicy({
      ...base, policy: aiPolicyInput,
    }));

    await expectInvalidResponse({ policies: [], limit: 2, nextAfterPolicyId: null }, () =>
      repo.listDynamicGroupPolicies({ organizationId, limit: 1 }));
    await expect(repo.saveDynamicGroupPolicy({
      ...base,
      conversationId,
      policyId: null,
      expectedVersion: 0,
      policySpec: {} as never,
      maximumMembers: 250,
    })).rejects.toMatchObject({ code: 'invalid_request' });
    await expectInvalidResponse({
      policyId,
      conversationId: otherMembershipId,
      version: 1,
      draftState: 'draft',
      selectorFingerprint: 'a'.repeat(64),
      requiresPreview: true,
      publishedVersionId: null,
    }, () => repo.saveDynamicGroupPolicy({
      ...base, conversationId, policyId: null, expectedVersion: 0, policySpec, maximumMembers: 250,
    }));
    await expectInvalidResponse({
      policyId: otherMembershipId,
      policyVersion: 3,
      previewFingerprint: 'b'.repeat(64),
      selectorFingerprint: 'a'.repeat(64),
      membershipStateFingerprint: 'c'.repeat(64),
      evaluatedAt: at,
      validUntil: later,
      eligibleCount: 0,
      addedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      addedSampleUserIds: [],
      removedSampleUserIds: [],
      unchangedSampleUserIds: [],
      nextBoundaryAt: null,
    }, () => repo.previewDynamicGroupPolicy({ organizationId, policyId, expectedVersion: 3 }));
    await expectInvalidResponse({
      policyId: otherMembershipId,
      policyVersion: 3,
      publishedVersionId: otherMembershipId,
      status: 'active',
      draftState: 'published',
      eligibleCount: 0,
      addedCount: 0,
      removedCount: 0,
      unchangedCount: 0,
      selectorFingerprint: 'a'.repeat(64),
      nextEvaluationAt: null,
    }, () => repo.publishDynamicGroupPolicy({
      ...base, policyId, expectedVersion: 3, previewFingerprint: 'b'.repeat(64),
    }));
    await expectInvalidResponse({
      policyId: otherMembershipId, policyVersion: 3, status: 'paused', pausedAt: at,
    }, () => repo.pauseDynamicGroupPolicy({
      ...base, policyId, expectedVersion: 3, reason: 'Controlled pause verification.',
    }));

    await expectInvalidResponse({
      conversationId: otherMembershipId,
      userId: membershipId,
      previousRole: 'member',
      role: 'admin',
    }, () => repo.updateConversationMemberRole({
      ...base, conversationId, membershipId, expectedRole: 'member', newRole: 'admin',
    }));

    const avatarPath = `${organizationId}/${conversationId}/${membershipId}/${attachmentId}/upload`;
    const uploadGrant = {
      action: 'upload',
      attachmentId,
      messageId: '101',
      bucket: 'message-attachments',
      path: avatarPath,
      scanStatus: 'pending',
      maximumByteSize: 5 * 1024 * 1024,
      signedUrl: 'https://project.supabase.co/storage/v1/object/upload/sign/message-attachments/path?token=controlled-token-123456',
      token: 'controlled-upload-token',
      expiresInSeconds: 7200,
    };
    const uploadCall = () => repo.createConversationAvatarUploadGrant({
      ...base,
      conversationId,
      fileName: 'avatar.png',
      mimeType: 'image/png',
      byteSize: 2048,
      sha256Hex: 'd'.repeat(64),
    });
    await expectInvalidResponse({ grant: {
      ...uploadGrant,
      path: `${otherMembershipId}/${conversationId}/${membershipId}/${attachmentId}/upload`,
    } }, uploadCall);
    await expectInvalidResponse({ grant: { ...uploadGrant, signedUrl: 'https://attacker.invalid/upload' } }, uploadCall);

    const readCall = () => repo.getConversationAvatarReadGrant({
      organizationId, conversationId, attachmentId,
    });
    await expectInvalidResponse({
      attachmentId: otherMembershipId,
      signedUrl: 'https://project.supabase.co/storage/v1/object/sign/message-attachments/path?token=controlled-token-123456',
      expiresInSeconds: 120,
    }, readCall);
    await expectInvalidResponse({
      attachmentId,
      signedUrl: 'https://attacker.invalid/download',
      expiresInSeconds: 120,
    }, readCall);

    await expectInvalidResponse({
      conversationId: otherMembershipId,
      attachmentId,
      avatarPath,
      previousAvatarPath: null,
      activated: true,
    }, () => repo.activateConversationAvatar({
      ...base, conversationId, attachmentId, expectedAvatarPath: null,
    }));
    await expectInvalidResponse({
      conversationId: otherMembershipId,
      previousAvatarPath: avatarPath,
      avatarPath: null,
      removed: true,
    }, () => repo.removeConversationAvatar({
      ...base, conversationId, expectedAvatarPath: avatarPath,
    }));
  });

  test('accepts supported message envelopes and completes review lifecycle alternatives', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };
    const messageCall = (clientMessageId: string) => repo.sendMessage({
      ...base,
      conversationId,
      clientMessageId,
      body: 'Controlled message envelope verification.',
      languageCode: 'en',
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      message: {
        id: 201,
        client_nonce: 'client-direct-message',
        next_cursor: 42,
        translation_targets: ['es'],
      },
    } }));
    await expect(messageCall('client-direct-message')).resolves.toEqual({
      messageId: '201',
      clientMessageId: 'client-direct-message',
      cursor: '42',
      translationTargets: ['es'],
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      result: {
        message: {
          messageId: '202',
          clientMessageId: 'client-result-message',
          cursor: 'cursor-202',
          translationTargets: [],
        },
      },
    } }));
    await expect(messageCall('client-result-message')).resolves.toMatchObject({
      messageId: '202', cursor: 'cursor-202', translationTargets: [],
    });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      result: {
        id: '203',
        client_message_id: 'client-result',
        next_cursor: null,
        translation_targets: ['ko'],
      },
    } }));
    await expect(messageCall('client-result')).resolves.toEqual({
      messageId: '203',
      clientMessageId: 'client-result',
      cursor: null,
      translationTargets: ['ko'],
    });

    await expectInvalidResponse({
      messageId: '204', clientMessageId: 'client-invalid', translationTargets: 'es',
    }, () => messageCall('client-invalid'));

    mockFetch.mockImplementationOnce(async () => response({ data: {
      conversationId, messageId: '201', scope: 'self', deliveredAt: at,
    } }));
    await expect(repo.markMessageReceipt({
      ...base, conversationId, messageId: '201', state: 'delivered',
    })).resolves.toMatchObject({ readAt: null });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      correctionId: 'correction-omitted-rationale', status: 'pending',
    } }));
    await expect(repo.proposeTranslationCorrection({
      ...base,
      conversationId,
      messageId: '201',
      targetLanguage: 'es',
      correctedBody: 'Controlled corrected body.',
    })).resolves.toMatchObject({ status: 'pending' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      correctionId: 'correction-review-a', decision: 'approved', reviewedAt: at,
    } }));
    await expect(repo.reviewTranslationCorrection({
      ...base, correctionId: 'correction-review-a', decision: 'approved',
    })).resolves.toEqual({
      correctionId: 'correction-review-a', decision: 'approved', reviewedAt: at,
    });
    await expectInvalidResponse({
      correctionId: 'different-correction', decision: 'approved', reviewedAt: at,
    }, () => repo.reviewTranslationCorrection({
      ...base, correctionId: 'correction-review-a', decision: 'approved',
    }));

    mockFetch.mockImplementationOnce(async () => response({ data: {
      summaryId,
      versionNumber: 1,
      status: 'queued',
      sourceFingerprint: 'a'.repeat(64),
      deduplicated: false,
    } }));
    await expect(repo.requestConversationSummary({
      ...base, conversationId, sourceMessageIds: ['201'], languageCode: 'en',
    })).resolves.toMatchObject({ summaryId, status: 'queued', deduplicated: false });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      summaryId,
      versionNumber: 1,
      status: 'draft',
      outputFingerprint: 'b'.repeat(64),
    } }));
    await expect(repo.createManualSummary({
      ...base,
      conversationId,
      sourceMessageIds: ['201'],
      languageCode: 'en',
      primaryTopic: 'Controlled topic',
      summary: 'Controlled summary.',
      keyTopics: [],
      decisions: [],
      actionItems: [],
      ambiguities: [],
    })).resolves.toMatchObject({ summaryId, status: 'draft' });

    mockFetch.mockImplementationOnce(async () => response({ data: {
      summaryId, status: 'failed', humanReviewed: true,
    } }));
    await expect(repo.reviewConversationSummary({
      ...base, summaryId, decision: 'reject',
    })).resolves.toEqual({ summaryId, status: 'failed', humanReviewed: true });
  });

  test('fails closed when parser-backed service receipts are malformed', async () => {
    const repo = repository();
    const base = { organizationId, idempotencyKey };
    const calls: [string, () => Promise<unknown>][] = [
      ['listConversationMemberCandidates', () => repo.listConversationMemberCandidates({ ...base, conversationId, query: '', limit: 5 })],
      ['createGroupConversation', () => repo.createGroupConversation({
        ...base,
        name: 'Controlled Group',
        memberAssignments: [{ membershipId, role: 'member' }],
        kind: 'group',
        historyPolicy: 'all',
        postingMode: 'all_members',
        joinPolicy: 'approval_required',
      })],
      ['updateConversationControls', () => repo.updateConversationControls({
        ...base, conversationId, postingMode: 'admins_only', reason: 'Controlled test',
      })],
      ['requestConversationJoin', () => repo.requestConversationJoin({ ...base, conversationId })],
      ['cancelConversationJoinRequest', () => repo.cancelConversationJoinRequest({ ...base, requestId: 'join-a', expectedVersion: 1 })],
      ['decideConversationJoinRequest', () => repo.decideConversationJoinRequest({
        ...base, requestId: 'join-a', expectedVersion: 1, decision: 'approved', reason: 'Approved',
      })],
      ['listDiscoverableConversations', () => repo.listDiscoverableConversations({ organizationId, limit: 10 })],
      ['listConversationJoinRequests', () => repo.listConversationJoinRequests({ organizationId, conversationId, limit: 10 })],
      ['addConversationMember', () => repo.addConversationMember({ ...base, conversationId, membershipId, role: 'member' })],
      ['updateConversationMemberRole', () => repo.updateConversationMemberRole({
        ...base, conversationId, membershipId, expectedRole: 'member', newRole: 'admin',
      })],
      ['leaveConversation', () => repo.leaveConversation({
        ...base, conversationId, confirmHistoryAndAccessLoss: true,
      })],
      ['reviewTranslationCorrection', () => repo.reviewTranslationCorrection({
        ...base, correctionId: 'correction-a', decision: 'approved', note: 'Verified',
      })],
      ['requestConversationSummary', () => repo.requestConversationSummary({
        ...base, conversationId, sourceMessageIds: ['101'], languageCode: 'en',
      })],
      ['createManualSummary', () => repo.createManualSummary({
        ...base,
        conversationId,
        sourceMessageIds: ['101'],
        languageCode: 'en',
        primaryTopic: 'Topic',
        summary: 'Summary',
        keyTopics: [], decisions: [], actionItems: [], ambiguities: [],
      })],
      ['reviewConversationSummary', () => repo.reviewConversationSummary({
        ...base, summaryId: 'summary-a', decision: 'approve', note: 'Verified',
      })],
      ['reportMessage', () => repo.reportMessage({
        ...base,
        conversationId,
        messageId: '101',
        category: 'other',
        details: 'Controlled report',
        consentToShare: true,
        contextBefore: 1,
        contextAfter: 1,
        noticeVersion: 'moderation-report-v2',
      })],
      ['reportGroup', () => repo.reportGroup({
        ...base,
        conversationId,
        category: 'other',
        details: 'Controlled report',
        consentToShare: true,
        noticeVersion: 'moderation-report-v2',
      })],
      ['reportMember', () => repo.reportMember({
        ...base,
        membershipId,
        category: 'other',
        details: 'Controlled report',
        consentToShare: true,
        noticeVersion: 'moderation-report-v2',
      })],
      ['listManagedUpdates', () => repo.listManagedUpdates({ organizationId, limit: 10 })],
      ['listUpdateNonAcknowledgers', () => repo.listUpdateNonAcknowledgers({ organizationId, announcementId: 'announcement-a', limit: 10 })],
      ['queryRoleAssignments', () => repo.queryRoleAssignments({ ...base, targetMembershipId: membershipId, limit: 10 })],
      ['assignAdminRole', () => repo.assignAdminRole({
        ...base,
        targetMembershipId: membershipId,
        roleName: 'people_admin',
        scopeType: 'organization',
        unitId: null,
        expiresAt: null,
        reason: 'Controlled assignment',
      })],
      ['issueInvitation', () => repo.issueInvitation({
        ...base,
        destinationType: 'email',
        destination: 'controlled@example.test',
        activationMode: 'otp',
        role: 'member',
        expiresInSeconds: 3600,
        membershipType: 'employee',
        membershipAccessExpiresAt: null,
        guestSponsorUserId: null,
      })],
      ['listSessions', () => repo.listSessions(base)],
      ['getDeviceNotificationPreferences', () => repo.getDeviceNotificationPreferences({ organizationId, installationId: 'installation-a' })],
    ];

    const unsafeErrors: string[] = [];
    for (const [name, call] of calls) {
      try {
        await call();
        unsafeErrors.push(`${name}:resolved`);
      } catch (error) {
        if (!(error instanceof RepositoryError)) {
          unsafeErrors.push(`${name}:${error instanceof Error ? error.constructor.name : typeof error}`);
        }
      }
    }
    expect(unsafeErrors).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(calls.length);
  });
});
