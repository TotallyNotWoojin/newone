import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AccountRecoverySection } from '@/features/admin/account-recovery-section';

let mockRecoveryRepository: Record<string, any>;

jest.mock('@/data/repositories/recovery-case-repository', () => {
  class RecoveryCaseRepositoryError extends Error {
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
      super('controlled recovery error');
      this.name = 'RecoveryCaseRepositoryError';
      this.code = mockCode;
      this.retryable = mockRetryable;
      this.correlationId = mockCorrelationId;
      this.status = mockStatus;
    }
  }
  return {
    RecoveryCaseRepository: jest.fn(() => mockRecoveryRepository),
    RecoveryCaseRepositoryError,
  };
});
jest.mock('@/features/security/self-recovery-request', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SelfRecoveryRequest: ({ onCreated, onOpenSettings }: {
      onCreated: (notice: string) => Promise<void>;
      onOpenSettings: () => void;
    }) => (
      <ReactNative.View>
        <ReactNative.Pressable accessibilityLabel="controlled-self-created" accessibilityRole="button" onPress={() => void onCreated('Controlled self-service case created.')}>
          <ReactNative.Text>controlled-self-created</ReactNative.Text>
        </ReactNative.Pressable>
        <ReactNative.Pressable accessibilityLabel="controlled-open-settings" accessibilityRole="button" onPress={onOpenSettings}>
          <ReactNative.Text>controlled-open-settings</ReactNative.Text>
        </ReactNative.Pressable>
      </ReactNative.View>
    ),
  };
});
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/lib/client-id', () => ({
  createClientId: () => '90000000-0000-4000-8000-000000000001',
}));

const organizationId = '20000000-0000-4000-8000-000000000001';
const targetUserId = '30000000-0000-4000-8000-000000000001';
const currentUserId = '30000000-0000-4000-8000-000000000002';

function recoveryError(code: string, status?: number) {
  const module = jest.requireMock('@/data/repositories/recovery-case-repository') as {
    RecoveryCaseRepositoryError: new (
      code: string, retryable: boolean, correlationId?: string, status?: number,
    ) => Error;
  };
  return new module.RecoveryCaseRepositoryError(code, false, undefined, status);
}

function recoveryCase(overrides: Record<string, unknown> = {}) {
  return {
    caseId: '40000000-0000-4000-8000-000000000001',
    organizationId,
    targetUserId,
    status: 'awaiting_external_verification',
    requestReason: 'Authenticator was lost during approved device replacement.',
    privilegedTarget: false,
    requiredApprovals: 1,
    approvalsRecorded: 0,
    humanVerificationRecorded: false,
    verificationMethod: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    createdAt: '2030-01-02T03:04:05.000Z',
    updatedAt: '2030-01-02T03:04:05.000Z',
    completedAt: null,
    ...overrides,
  };
}

function caseList(cases: Record<string, unknown>[], scope: 'self' | 'organization' = 'organization') {
  return {
    schemaVersion: 1,
    scope,
    cases,
    humanVerification: { performedByNewone: false, externalPolicyRequired: true },
  };
}

function successfulAction(value: unknown = true) {
  return jest.fn(async (..._args: unknown[]) => value);
}

function repository(overrides: Record<string, unknown> = {}) {
  return {
    listCases: successfulAction(caseList([])),
    recordVerification: successfulAction({}),
    approveCase: successfulAction({ approvalsRecorded: 1, requiredApprovals: 2 }),
    rejectCase: successfulAction({}),
    executeCase: successfulAction({ alreadyCompleted: false, sessionsRevoked: 3, devicesRevoked: 2 }),
    ...overrides,
  };
}

function section(overrides: Record<string, unknown> = {}) {
  return <AccountRecoverySection
    accessToken="controlled-access-token"
    assuranceLevel="aal2"
    currentUserId={currentUserId}
    onOpenSettings={jest.fn()}
    onVerifyNow={jest.fn()}
    organizationId={organizationId}
    people={[
      { id: currentUserId, displayName: 'Current Manager' },
      { id: targetUserId, displayName: 'Target Person' },
    ]}
    {...overrides}
  />;
}

beforeEach(() => {
  mockRecoveryRepository = repository();
});

describe('account recovery management', () => {
  test('keeps organization cases behind AAL2 while retaining self-service routing', async () => {
    const onVerifyNow = jest.fn();
    const onOpenSettings = jest.fn();
    await render(section({ assuranceLevel: 'aal1', onVerifyNow, onOpenSettings }));
    expect(screen.getByText('Organization cases are available only after MFA verification. A person who lost their authenticator can still submit their own request below.')).toBeTruthy();
    expect(mockRecoveryRepository.listCases).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Verify with MFA' }));
    await fireEvent.press(screen.getByRole('button', { name: 'controlled-open-settings' }));
    expect(onVerifyNow).toHaveBeenCalled();
    expect(onOpenSettings).toHaveBeenCalled();
  });

  test('loads every authoritative status and enforces target, expiry, and terminal separation', async () => {
    const cases = [
      recoveryCase(),
      recoveryCase({ caseId: '40000000-0000-4000-8000-000000000002', status: 'awaiting_approval', verificationMethod: 'in_person' }),
      recoveryCase({ caseId: '40000000-0000-4000-8000-000000000003', status: 'approved', privilegedTarget: true, verificationMethod: 'manager_callback' }),
      recoveryCase({ caseId: '40000000-0000-4000-8000-000000000004', status: 'executing', verificationMethod: 'hr_record_match' }),
      recoveryCase({ caseId: '40000000-0000-4000-8000-000000000005', status: 'completed', completedAt: '2030-01-02T04:00:00.000Z', verificationMethod: 'approved_provider' }),
      recoveryCase({ caseId: '40000000-0000-4000-8000-000000000006', status: 'rejected' }),
      recoveryCase({ caseId: '40000000-0000-4000-8000-000000000007', status: 'expired' }),
      recoveryCase({
        caseId: '40000000-0000-4000-8000-000000000008',
        targetUserId: currentUserId,
        status: 'awaiting_approval',
      }),
      recoveryCase({
        caseId: '40000000-0000-4000-8000-000000000009',
        status: 'approved',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    ];
    mockRecoveryRepository = repository({ listCases: successfulAction(caseList(cases)) });
    await render(section());
    await waitFor(() => expect(screen.getByText('Awaiting external verification')).toBeTruthy());
    for (const text of ['Awaiting approval', 'Approved', 'Executing', 'Completed', 'Rejected', 'Expired']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    for (const method of ['Not yet recorded', 'In person', 'Manager callback', 'HR record match', 'Approved provider']) {
      expect(screen.getAllByText(new RegExp(method)).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/Requested for · Current Manager/)).toBeTruthy();
    expect(screen.getByText('You are the target. The server prohibits you from verifying, approving, rejecting, or executing this case.')).toBeTruthy();
    expect(screen.getByText('Expiry reached; refresh for authoritative status')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Approve' }).some((button) => button.props.accessibilityState.disabled)).toBe(true);
  });

  test('records bounded external verification with each supported method', async () => {
    const item = recoveryCase();
    mockRecoveryRepository = repository({ listCases: successfulAction(caseList([item])) });
    await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Record verification' })).toBeTruthy());
    const submitButtons = screen.getAllByRole('button', { name: 'Record verification' });
    await fireEvent.press(submitButtons[submitButtons.length - 1]!);
    await fireEvent.press(screen.getByRole('button', { name: 'Manager callback' }));
    await fireEvent.press(screen.getByRole('button', { name: 'HR record match' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Approved provider' }));
    await fireEvent.changeText(screen.getByLabelText('Approved ticket or provider reference'), `TICKET-${'x'.repeat(600)}`);
    expect(screen.getByLabelText('Approved ticket or provider reference').props.value).toHaveLength(500);
    const confirmationButtons = screen.getAllByRole('button', { name: 'Record verification' });
    await fireEvent.press(confirmationButtons[confirmationButtons.length - 1]!);
    await waitFor(() => expect(mockRecoveryRepository.recordVerification).toHaveBeenCalledWith({
      organizationId,
      caseId: item.caseId,
      method: 'approved_provider',
      evidenceReference: `TICKET-${'x'.repeat(493)}`,
      idempotencyKey: '90000000-0000-4000-8000-000000000001',
    }));
    expect(screen.getByText('External verification was recorded as a hash. The raw reference is no longer held by this screen.')).toBeTruthy();
  });

  test('approves and rejects with separate, idempotent manager actions', async () => {
    const approval = recoveryCase({ status: 'awaiting_approval' });
    mockRecoveryRepository = repository({ listCases: successfulAction(caseList([approval])) });
    const approvalView = await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Confirm independent approval' }));
    await waitFor(() => expect(mockRecoveryRepository.approveCase).toHaveBeenCalledWith({
      organizationId,
      caseId: approval.caseId,
      idempotencyKey: '90000000-0000-4000-8000-000000000001',
    }));
    expect(screen.getByText('Approval recorded: 1 of 2.')).toBeTruthy();
    await approvalView.unmount();

    const rejection = recoveryCase({ caseId: '40000000-0000-4000-8000-000000000002', status: 'awaiting_approval' });
    mockRecoveryRepository = repository({ listCases: successfulAction(caseList([rejection])) });
    await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Reject' }));
    await fireEvent.changeText(screen.getByLabelText('Rejection reason'), ' External process failed. ');
    await fireEvent.press(screen.getByRole('button', { name: 'Reject case' }));
    await waitFor(() => expect(mockRecoveryRepository.rejectCase).toHaveBeenCalledWith({
      organizationId,
      caseId: rejection.caseId,
      reason: ' External process failed. ',
      idempotencyKey: '90000000-0000-4000-8000-000000000001',
    }));
    expect(screen.getByText('The recovery case was rejected.')).toBeTruthy();
  });

  test('executes destructive reset receipts and handles already-completed retries', async () => {
    const approved = recoveryCase({ status: 'approved' });
    mockRecoveryRepository = repository({
      listCases: successfulAction(caseList([approved])),
      executeCase: successfulAction({ alreadyCompleted: false, sessionsRevoked: null, devicesRevoked: null }),
    });
    const view = await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execute reset' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Execute reset' }));
    expect(screen.getByText(/destructive and cannot be undone/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Delete factor and revoke sessions' }));
    await waitFor(() => expect(screen.getByText(/0 session bindings, 0 devices/)).toBeTruthy());
    await view.unmount();

    mockRecoveryRepository = repository({
      listCases: successfulAction(caseList([approved])),
      executeCase: successfulAction({ alreadyCompleted: true }),
    });
    await render(section());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Execute reset' })).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Execute reset' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Delete factor and revoke sessions' }));
    await waitFor(() => expect(screen.getByText(/already completed/)).toBeTruthy());
  });

  test('keeps an action retryable and classifies repository failures for the operator', async () => {
    const item = recoveryCase({ status: 'awaiting_approval' });
    const expectations: Array<[Error, string]> = [
      [recoveryError('network_unavailable'), 'Newone could not reach the recovery service. The same action can be retried safely while this dialog remains open.'],
      [recoveryError('forbidden', 403), 'Your session or recent MFA verification is no longer sufficient. Verify with MFA again.'],
      [recoveryError('conflict', 409), 'The case changed or this action conflicts with server policy. Refresh before continuing.'],
      [recoveryError('invalid_reason'), 'Check the bounded reason or reference and try again.'],
      [recoveryError('response_too_large'), 'The recovery service returned an invalid response. Nothing is treated as completed.'],
      [new Error('unexpected'), 'The server rejected this action. Refresh and verify with MFA again before retrying.'],
    ];
    for (const [error, message] of expectations) {
      mockRecoveryRepository = repository({
        listCases: successfulAction(caseList([item])),
        approveCase: jest.fn(async () => { throw error; }),
      });
      const view = await render(section());
      await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy());
      await fireEvent.press(screen.getByRole('button', { name: 'Approve' }));
      await fireEvent.press(screen.getByRole('button', { name: 'Confirm independent approval' }));
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
      await fireEvent.press(screen.getAllByRole('button', { name: 'Cancel' })[0]!);
      await view.unmount();
    }
  });

  test('reports list contract violations and refreshes after self-service creation', async () => {
    mockRecoveryRepository = repository({ listCases: successfulAction(caseList([], 'self')) });
    const view = await render(section());
    await waitFor(() => expect(screen.getByText('The server rejected this action. Refresh and verify with MFA again before retrying.')).toBeTruthy());
    await view.unmount();

    mockRecoveryRepository = repository();
    await render(section());
    await waitFor(() => expect(mockRecoveryRepository.listCases).toHaveBeenCalledTimes(1));
    await fireEvent.press(screen.getByRole('button', { name: 'controlled-self-created' }));
    await waitFor(() => expect(mockRecoveryRepository.listCases).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Controlled self-service case created.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh cases' }));
    await waitFor(() => expect(mockRecoveryRepository.listCases).toHaveBeenCalledTimes(3));
  });
});
