import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ModerationCaseSection } from '@/features/admin/moderation-case-section';

let mockModerationRepository: Record<string, any>;
let mockRealtimeClient: Record<string, any> | null;
let mockWidth = 1280;
let mockBroadcastHandler: ((value: unknown) => void) | null;
let mockSubscribeHandler: ((status: string) => void) | null;

jest.mock('@/data/repositories/moderation-case-repository', () => {
  class ModerationCaseRepositoryError extends Error {
    public readonly code: string;
    public readonly retryable: boolean;
    public readonly correlationId?: string;
    public readonly status?: number;

    constructor(
      mockCode: string,
      mockRetryable: boolean,
      mockCorrelationId?: string,
      mockStatus?: number,
    ) {
      super('controlled moderation error');
      this.name = 'ModerationCaseRepositoryError';
      this.code = mockCode;
      this.retryable = mockRetryable;
      this.correlationId = mockCorrelationId;
      this.status = mockStatus;
    }
  }
  return {
    ModerationCaseRepository: jest.fn(() => mockModerationRepository),
    ModerationCaseRepositoryError,
  };
});
jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 900 }),
}));
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/lib/client-id', () => ({
  createClientId: () => '90000000-0000-4000-8000-000000000001',
}));
jest.mock('@/lib/supabase', () => ({
  getRealtimeClient: () => mockRealtimeClient,
}));

const organizationId = '20000000-0000-4000-8000-000000000001';
const currentUserId = '30000000-0000-4000-8000-000000000001';
const investigatorId = '30000000-0000-4000-8000-000000000002';
const suspendedInvestigatorId = '30000000-0000-4000-8000-000000000003';

function moderationError(code: string, status?: number) {
  const module = jest.requireMock('@/data/repositories/moderation-case-repository') as {
    ModerationCaseRepositoryError: new (
      code: string, retryable: boolean, correlationId?: string, status?: number,
    ) => Error;
  };
  return new module.ModerationCaseRepositoryError(code, false, undefined, status);
}

function listItem(overrides: Record<string, unknown> = {}) {
  return {
    caseId: '40000000-0000-4000-8000-000000000001',
    status: 'open',
    category: 'harassment',
    target: { type: 'message', label: 'Reported safety message' },
    unitId: null,
    reportedAt: '2030-01-02T03:04:05.000Z',
    updatedAt: '2030-01-02T04:04:05.000Z',
    recordVersion: 3,
    assignedAt: null,
    assignedToMe: false,
    assignedInvestigatorUserId: null,
    canClaim: true,
    canAssign: true,
    canViewEvidence: false,
    readOnly: false,
    eligibleInvestigatorUserIds: [investigatorId, suspendedInvestigatorId],
    ...overrides,
  };
}

function queryResult(cases: Record<string, unknown>[]) {
  return { schemaVersion: 2, cases, nextCursor: null };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    caseId: '40000000-0000-4000-8000-000000000001',
    status: 'in_review',
    category: 'harassment',
    target: { type: 'message', label: 'Reported safety message' },
    details: 'Reporter described a controlled safety concern.',
    reporterLabel: 'protected',
    reportedAt: '2030-01-02T03:04:05.000Z',
    updatedAt: '2030-01-02T04:04:05.000Z',
    assignedAt: '2030-01-02T03:30:00.000Z',
    recordVersion: 5,
    readOnly: false,
    evidence: [
      {
        evidenceId: 1,
        relationship: 'reported',
        relativePosition: 0,
        messageKind: 'text',
        messageBody: 'Exact reported evidence.',
        senderLabel: 'Scoped sender A',
        sentAt: '2030-01-02T03:00:00.000Z',
        bodySha256: 'a'.repeat(64),
      },
      {
        evidenceId: 2,
        relationship: 'context_before',
        relativePosition: -1,
        messageKind: 'attachment',
        messageBody: null,
        senderLabel: 'Scoped sender B',
        sentAt: '2030-01-02T02:59:00.000Z',
        bodySha256: 'b'.repeat(64),
      },
      {
        evidenceId: 3,
        relationship: 'context_after',
        relativePosition: 1,
        messageKind: 'text',
        messageBody: 'Exact following context.',
        senderLabel: 'Scoped sender C',
        sentAt: '2030-01-02T03:01:00.000Z',
        bodySha256: 'c'.repeat(64),
      },
    ],
    history: [
      {
        eventId: 1,
        eventType: 'reported',
        fromStatus: null,
        toStatus: 'open',
        reason: null,
        evidenceMetadata: {},
        actorLabel: 'protected_reporter',
        occurredAt: '2030-01-02T03:04:05.000Z',
      },
      {
        eventId: 2,
        eventType: 'assigned',
        fromStatus: 'open',
        toStatus: 'assigned',
        reason: 'Assigned for controlled review.',
        evidenceMetadata: { policyCode: 'AUP.4.2', severity: 'high', referenceIds: ['CASE-42'] },
        actorLabel: 'assigned_investigator',
        occurredAt: '2030-01-02T03:30:00.000Z',
      },
      {
        eventId: 3,
        eventType: 'review_started',
        fromStatus: 'assigned',
        toStatus: 'in_review',
        reason: 'Manager confirmed scope.',
        evidenceMetadata: {},
        actorLabel: 'authorized_case_manager',
        occurredAt: '2030-01-02T04:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function successfulAction(value: unknown = true) {
  return jest.fn(async (..._args: unknown[]) => value);
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    queryCases: successfulAction(queryResult([])),
    readCase: successfulAction(null),
    assignCase: successfulAction({}),
    claimCase: successfulAction({}),
    transitionCase: successfulAction({}),
    ...overrides,
  };
}

function realtimeClient() {
  const channel: Record<string, any> = {};
  channel.on = jest.fn((_type: string, _filter: unknown, handler: (value: unknown) => void) => {
    mockBroadcastHandler = handler;
    return channel;
  });
  channel.subscribe = jest.fn((handler: (status: string) => void) => {
    mockSubscribeHandler = handler;
    return channel;
  });
  return {
    realtime: { setAuth: successfulAction() },
    channel: jest.fn(() => channel),
    removeChannel: successfulAction(),
    controlledChannel: channel,
  };
}

function section(overrides: Record<string, unknown> = {}) {
  return <ModerationCaseSection
    accessToken="controlled-access-token"
    assuranceLevel="aal2"
    currentUserId={currentUserId}
    onVerifyNow={jest.fn()}
    organizationId={organizationId}
    people={[
      { id: currentUserId, displayName: 'Current Investigator', suspended: false },
      { id: investigatorId, displayName: 'Designated Investigator', suspended: false },
      { id: suspendedInvestigatorId, displayName: 'Suspended Investigator', suspended: true },
    ]}
    {...overrides}
  />;
}

beforeEach(() => {
  mockWidth = 1280;
  mockBroadcastHandler = null;
  mockSubscribeHandler = null;
  mockModerationRepository = repository();
  mockRealtimeClient = null;
});

describe('scoped moderation case management', () => {
  test('requires AAL2 before listing or mutating cases', async () => {
    const onVerifyNow = jest.fn();
    await render(section({ assuranceLevel: 'aal1', accessToken: null, onVerifyNow }));
    expect(screen.getAllByText('Verify with MFA to query or change moderation cases.')).toHaveLength(2);
    expect(mockModerationRepository.queryCases).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Verify with MFA' }));
    expect(onVerifyNow).toHaveBeenCalled();
  });

  test('renders every status, category, target, and filter without queue message content', async () => {
    mockWidth = 760;
    const cases = [
      listItem(),
      listItem({ caseId: '40000000-0000-4000-8000-000000000002', status: 'assigned', category: 'threat', target: { type: 'group', label: 'Response group' }, assignedAt: '2030-01-02T03:30:00.000Z', canClaim: false }),
      listItem({ caseId: '40000000-0000-4000-8000-000000000003', status: 'in_review', category: 'spam', target: { type: 'member', label: 'Scoped member' }, canClaim: false, canAssign: false, canViewEvidence: true, assignedToMe: true }),
      listItem({ caseId: '40000000-0000-4000-8000-000000000004', status: 'resolved', category: 'privacy', readOnly: true, canClaim: false, canAssign: false }),
      listItem({ caseId: '40000000-0000-4000-8000-000000000005', status: 'dismissed', category: 'misinformation', readOnly: true, canClaim: false, canAssign: false }),
      listItem({ caseId: '40000000-0000-4000-8000-000000000006', status: 'open', category: 'other', canClaim: false, canAssign: false }),
    ];
    mockModerationRepository = repository({ queryCases: successfulAction(queryResult(cases)) });
    await render(section());
    await waitFor(() => expect(screen.getByText('Harassment')).toBeTruthy());
    for (const text of ['Open', 'Assigned', 'In review', 'Threat', 'Spam', 'Group', 'Person']) {
      expect(screen.getAllByText(new RegExp(text)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText('Queue view contains no message content.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Unassigned' }));
    expect(screen.queryByText('Threat')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Closed' }));
    expect(screen.getByText('Resolved')).toBeTruthy();
    expect(screen.getByText('Dismissed')).toBeTruthy();
    expect(screen.getAllByText('Closed · read-only')).toHaveLength(2);
    await fireEvent.press(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Other')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Active' }));
  });

  test('assigns and claims only eligible active investigators', async () => {
    const item = listItem();
    mockModerationRepository = repository({ queryCases: successfulAction(queryResult([item])) });
    const view = await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Assign' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Assign' }));
    expect(screen.getByRole('button', { name: 'Designated Investigator' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspended Investigator' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Designated Investigator' }));
    await fireEvent.changeText(screen.getByLabelText('Operational reason'), ' Assigned for scoped investigation. ');
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockModerationRepository.assignCase).toHaveBeenCalledWith({
      organizationId,
      caseId: item.caseId,
      investigatorUserId: investigatorId,
      expectedVersion: 3,
      reason: ' Assigned for scoped investigation. ',
      idempotencyKey: '90000000-0000-4000-8000-000000000001',
    }));
    expect(screen.getByText('Case assignment recorded.')).toBeTruthy();
    await view.unmount();

    mockModerationRepository = repository({ queryCases: successfulAction(queryResult([item])) });
    await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Claim' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Claim' }));
    await fireEvent.changeText(screen.getByLabelText('Operational reason'), 'Taking assigned unit scope.');
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockModerationRepository.claimCase).toHaveBeenCalledWith({
      organizationId,
      caseId: item.caseId,
      expectedVersion: 3,
      reason: 'Taking assigned unit scope.',
      idempotencyKey: '90000000-0000-4000-8000-000000000001',
    }));
  });

  test('records review, resolution, and dismissal with immutable evidence metadata', async () => {
    const assigned = listItem({ status: 'assigned', assignedToMe: true, canClaim: false, canAssign: false });
    mockModerationRepository = repository({ queryCases: successfulAction(queryResult([assigned])) });
    const reviewView = await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start review' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Start review' }));
    await fireEvent.changeText(screen.getByLabelText('Operational reason'), 'Beginning bounded evidence review.');
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockModerationRepository.transitionCase).toHaveBeenCalledWith({
      organizationId,
      caseId: assigned.caseId,
      status: 'in_review',
      expectedVersion: 3,
      reason: 'Beginning bounded evidence review.',
      idempotencyKey: '90000000-0000-4000-8000-000000000001',
    }));
    expect(screen.getByText('Case review started.')).toBeTruthy();
    await reviewView.unmount();

    const inReview = listItem({ status: 'in_review', assignedToMe: true, canClaim: false, canAssign: false });
    mockModerationRepository = repository({ queryCases: successfulAction(queryResult([inReview])) });
    const resolveView = await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Resolve' }));
    await fireEvent.changeText(screen.getByLabelText('Operational reason'), `Resolution ${'r'.repeat(2100)}`);
    expect(screen.getByLabelText('Operational reason').props.value).toHaveLength(2000);
    await fireEvent.changeText(screen.getByLabelText('Policy code'), `AUP.${'x'.repeat(100)}`);
    expect(screen.getByLabelText('Policy code').props.value).toHaveLength(80);
    await fireEvent.changeText(screen.getByLabelText('Evidence references (optional, comma separated)'), ` CASE-42, , HR-17, ${'z'.repeat(1100)}`);
    expect(screen.getByLabelText('Evidence references (optional, comma separated)').props.value).toHaveLength(1000);
    await fireEvent.press(screen.getByRole('button', { name: 'Low' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Medium' }));
    await fireEvent.press(screen.getByRole('button', { name: 'High' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Critical' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockModerationRepository.transitionCase).toHaveBeenCalledWith(expect.objectContaining({
      organizationId,
      caseId: inReview.caseId,
      status: 'resolved',
      expectedVersion: 3,
      evidenceMetadata: {
        referenceIds: ['CASE-42', 'HR-17', 'z'.repeat(981)],
        policyCode: `AUP.${'x'.repeat(76)}`,
        severity: 'critical',
      },
    })));
    expect(screen.getByText('Case resolved and locked read-only.')).toBeTruthy();
    await resolveView.unmount();

    mockModerationRepository = repository({ queryCases: successfulAction(queryResult([inReview])) });
    await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Dismiss' }));
    await fireEvent.changeText(screen.getByLabelText('Operational reason'), 'No policy violation after review.');
    await fireEvent.press(screen.getByRole('button', { name: 'Low' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockModerationRepository.transitionCase).toHaveBeenCalledWith(expect.objectContaining({
      status: 'dismissed', evidenceMetadata: { severity: 'low' },
    })));
    expect(screen.getByText('Case dismissed and locked read-only.')).toBeTruthy();
  });

  test('opens only scoped evidence and renders redacted actors and immutable history', async () => {
    const item = listItem({ status: 'in_review', assignedToMe: true, canClaim: false, canAssign: false, canViewEvidence: true });
    mockModerationRepository = repository({
      queryCases: successfulAction(queryResult([item])),
      readCase: successfulAction(detail()),
    });
    const view = await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open case' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Open case' }));
    await waitFor(() => expect(mockModerationRepository.readCase).toHaveBeenCalledWith({
      organizationId, caseId: item.caseId,
    }));
    for (const text of [
      'Exact reported evidence.', 'Attachment message (file content is not copied into this case view)',
      'Exact following context.', 'Reported item', 'Context before', 'Context after',
      'Assigned for controlled review.', 'AUP.4.2 · high · CASE-42',
    ]) expect(screen.getByText(text)).toBeTruthy();
    for (const actor of ['Protected reporter', 'Assigned investigator', 'Authorized case manager']) {
      expect(screen.getByText(new RegExp(actor))).toBeTruthy();
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText('Exact reported evidence.')).toBeNull();
    await view.unmount();

    const memberDetail = detail({
      status: 'resolved',
      target: { type: 'member', label: 'Scoped member label' },
      details: null,
      readOnly: true,
      evidence: [],
    });
    mockModerationRepository = repository({
      queryCases: successfulAction(queryResult([{ ...item, target: memberDetail.target }])),
      readCase: successfulAction(memberDetail),
    });
    await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open case' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Open case' }));
    await waitFor(() => expect(screen.getByText('This report contains only the report-time target label and reporter-provided details. No group history, member status, profile fields, or messages were copied into the case.')).toBeTruthy());
    expect(screen.getByText('No additional details were provided.')).toBeTruthy();
  });

  test('reconciles valid private realtime invalidations and ignores malformed broadcasts', async () => {
    mockRealtimeClient = realtimeClient();
    mockModerationRepository = repository();
    const view = await render(section());
    await waitFor(() => expect(mockRealtimeClient?.realtime.setAuth).toHaveBeenCalledWith('controlled-access-token'));
    await waitFor(() => expect(mockModerationRepository.queryCases).toHaveBeenCalled());
    expect(mockRealtimeClient?.channel).toHaveBeenCalledWith(
      `org:${organizationId}:user:${currentUserId}:inbox`,
      { config: { private: true, broadcast: { ack: true, self: false } } },
    );
    const before = mockModerationRepository.queryCases.mock.calls.length;
    await act(async () => {
      mockBroadcastHandler?.(null);
      mockBroadcastHandler?.({ payload: { schemaVersion: 2, event: 'workspace.invalidated' } });
      await Promise.resolve();
    });
    expect(mockModerationRepository.queryCases).toHaveBeenCalledTimes(before);
    await act(async () => {
      mockBroadcastHandler?.({ payload: { payload: {
        schemaVersion: 1,
        event: 'workspace.invalidated',
        organizationId,
        entityType: 'moderation_case',
        entityId: '40000000-0000-4000-8000-000000000001',
      } } });
      await Promise.resolve();
    });
    await waitFor(() => expect(mockModerationRepository.queryCases.mock.calls.length).toBe(before + 1));
    await act(async () => {
      mockSubscribeHandler?.('SUBSCRIBED');
      await Promise.resolve();
    });
    await waitFor(() => expect(mockModerationRepository.queryCases.mock.calls.length).toBe(before + 2));
    await act(async () => {
      mockSubscribeHandler?.('CHANNEL_ERROR');
      await Promise.resolve();
    });
    await view.unmount();
    expect(mockRealtimeClient?.removeChannel).toHaveBeenCalledWith(mockRealtimeClient.controlledChannel);
  });

  test('keeps failed reads and actions retryable with precise operator errors', async () => {
    const item = listItem({ canViewEvidence: true });
    const expectations: Array<[Error, string]> = [
      [moderationError('network_unavailable'), 'The moderation service is unavailable. The same dialog can retry safely with its idempotency key.'],
      [moderationError('forbidden', 403), 'A valid session and recent MFA verification are required.'],
      [moderationError('version_conflict', 409), 'The case changed. Refresh before making another decision.'],
      [moderationError('invalid_reason'), 'Review the bounded reason, investigator, policy code, and evidence references.'],
      [moderationError('invalid_response'), 'The server returned an invalid moderation response. No action is treated as complete.'],
      [new Error('unexpected'), 'The server rejected the moderation action. Refresh the case and try again.'],
    ];
    for (const [error, message] of expectations) {
      mockModerationRepository = repository({
        queryCases: successfulAction(queryResult([item])),
        claimCase: jest.fn(async () => { throw error; }),
      });
      const view = await render(section());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Claim' })).toBeTruthy());
      await fireEvent.press(screen.getByRole('button', { name: 'Claim' }));
      await fireEvent.changeText(screen.getByLabelText('Operational reason'), 'Retryable controlled action.');
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm' }));
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      await view.unmount();
    }

    mockModerationRepository = repository({
      queryCases: successfulAction(queryResult([item])),
      readCase: jest.fn(async () => { throw moderationError('response_too_large'); }),
    });
    await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open case' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Open case' }));
    await waitFor(() => expect(screen.getByText('The server returned an invalid moderation response. No action is treated as complete.')).toBeTruthy());
  });

  test('keeps periodic reconciliation when realtime authorization fails', async () => {
    const rejected = realtimeClient();
    rejected.realtime.setAuth = jest.fn(async () => { throw new Error('socket unavailable'); });
    mockRealtimeClient = rejected;
    await render(section());
    await waitFor(() => expect(rejected.realtime.setAuth).toHaveBeenCalled());
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh cases' }));
    await waitFor(() => expect(mockModerationRepository.queryCases.mock.calls.length).toBeGreaterThanOrEqual(2));
  });
});
