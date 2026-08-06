import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { RecoveryCaseRepositoryError } from '@/data/repositories/recovery-case-repository';
import { SelfRecoveryRequest } from '@/features/security/self-recovery-request';

const mockListVerifiedTotpFactors = jest.fn();
const mockCreateCase = jest.fn();
const mockCreateClientId = jest.fn();
const mockTranslate = (mockKey: string) => mockKey;

jest.mock('@/data/repositories/recovery-case-repository', () => {
  class ControlledRecoveryCaseRepositoryError extends Error {
    readonly code: string;
    readonly retryable: boolean;
    readonly correlationId?: string;
    readonly status?: number;

    constructor(
      mockCode: string,
      mockRetryable: boolean,
      mockCorrelationId?: string,
      mockStatus?: number,
    ) {
      super('Controlled recovery repository failure.');
      this.code = mockCode;
      this.retryable = mockRetryable;
      this.correlationId = mockCorrelationId;
      this.status = mockStatus;
      this.name = 'RecoveryCaseRepositoryError';
    }
  }
  return {
    RecoveryCaseRepository: class ControlledRecoveryCaseRepository {
      listVerifiedTotpFactors() {
        return mockListVerifiedTotpFactors();
      }

      createCase(mockInput: unknown) {
        return mockCreateCase(mockInput);
      }
    },
    RecoveryCaseRepositoryError: ControlledRecoveryCaseRepositoryError,
  };
});

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: mockTranslate }),
}));

jest.mock('@/lib/client-id', () => ({
  createClientId: () => mockCreateClientId(),
}));

const organizationId = '10000000-0000-4000-8000-000000000001';
const factorOne = '20000000-0000-4000-8000-000000000002';
const factorTwo = '30000000-0000-4000-8000-000000000003';
const expiresAt = '2026-08-06T18:30:00.000Z';

function repositoryError(code: string, status?: number) {
  return new RecoveryCaseRepositoryError(code, false, undefined, status);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function openRecovery() {
  await fireEvent.press(screen.getByRole('button', { name: 'Request recovery for me' }));
}

beforeEach(() => {
  mockCreateClientId.mockReset();
  mockListVerifiedTotpFactors.mockReset();
  mockCreateCase.mockReset();
  mockCreateClientId
    .mockImplementationOnce(() => '40000000-0000-4000-8000-000000000004')
    .mockImplementationOnce(() => '50000000-0000-4000-8000-000000000005')
    .mockImplementationOnce(() => '60000000-0000-4000-8000-000000000006')
    .mockImplementation(() => '70000000-0000-4000-8000-000000000007');
  mockListVerifiedTotpFactors.mockImplementation(async () => [
    { id: factorOne, status: 'verified', friendlyName: null },
    { id: factorTwo, status: 'verified', friendlyName: 'Security key authenticator' },
  ]);
  mockCreateCase.mockImplementation(async () => ({
    caseId: '80000000-0000-4000-8000-000000000008',
    expiresAt,
    requiredApprovals: 2,
  }));
});

describe('self-service authenticator recovery', () => {
  test('creates a real recovery request from a verified factor and renders the committed receipt', async () => {
    const onCreated = jest.fn(async () => {
      throw new Error('controlled parent refresh failure');
    });
    const view = await render(
      <SelfRecoveryRequest
        accessToken="controlled-access-token"
        onCreated={onCreated}
        organizationId={organizationId}
      />,
    );
    expect(screen.getByText('Create an expiring, self-owned case for a verified authenticator you can no longer use. Help-desk managers handle later stages separately.')).toBeTruthy();
    await openRecovery();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verified authenticator 1' })).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Security key authenticator' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Verified authenticator 1' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Security key authenticator' }));
    const reasonField = screen.getByLabelText('Why the authenticator is unavailable');
    await fireEvent.changeText(reasonField, 'Authenticator was lost during a controlled device replacement.');
    await fireEvent.changeText(reasonField, 'Authenticator was lost during a controlled device replacement.');
    await fireEvent.press(screen.getByRole('button', { name: 'Create recovery case' }));

    await waitFor(() => expect(mockCreateCase).toHaveBeenCalledWith({
      organizationId,
      factorId: factorTwo,
      reason: 'Authenticator was lost during a controlled device replacement.',
      idempotencyKey: '40000000-0000-4000-8000-000000000004',
    }));
    expect(onCreated).toHaveBeenCalledWith(expect.stringContaining('Recovery case created.'));
    expect(screen.getByText(/Recovery case created\./)).toBeTruthy();
    expect(screen.queryByText('Controlled recovery repository failure.')).toBeNull();
    await view.unmount();
  });

  test('renders button presentation and routes users without a verified factor to security settings', async () => {
    mockListVerifiedTotpFactors.mockImplementationOnce(async () => []);
    const onOpenSettings = jest.fn();
    const view = await render(
      <SelfRecoveryRequest
        accessToken="controlled-access-token"
        onOpenSettings={onOpenSettings}
        organizationId={organizationId}
        presentation="button"
      />,
    );
    expect(screen.queryByText('Create an expiring, self-owned case for a verified authenticator you can no longer use. Help-desk managers handle later stages separately.')).toBeNull();
    await openRecovery();
    await waitFor(() => expect(screen.getByText('No verified TOTP authenticator is available for this account.')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Open security settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('No verified TOTP authenticator is available for this account.')).toBeNull();
    await view.unmount();

    mockListVerifiedTotpFactors.mockImplementationOnce(async () => []);
    const withoutSettings = await render(
      <SelfRecoveryRequest
        accessToken={null}
        organizationId={organizationId}
        presentation="button"
      />,
    );
    await openRecovery();
    await waitFor(() => expect(screen.getByText('No verified TOTP authenticator is available for this account.')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Open security settings' })).toBeNull();
    await withoutSettings.unmount();
  });

  test('discards a factor response after the request dialog has been closed', async () => {
    const pendingFactors = deferred<{ id: string; status: 'verified'; friendlyName: string | null }[]>();
    mockListVerifiedTotpFactors.mockImplementationOnce(() => pendingFactors.promise);
    const view = await render(
      <SelfRecoveryRequest accessToken="controlled-access-token" organizationId={organizationId} />,
    );
    await openRecovery();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    pendingFactors.resolve([{ id: factorOne, status: 'verified', friendlyName: 'Late factor' }]);
    await pendingFactors.promise;
    expect(screen.queryByText('Late factor')).toBeNull();
    await view.unmount();

    const rejectedFactors = deferred<{ id: string; status: 'verified'; friendlyName: string | null }[]>();
    mockListVerifiedTotpFactors.mockImplementationOnce(() => rejectedFactors.promise);
    const rejectedView = await render(
      <SelfRecoveryRequest accessToken="controlled-access-token" organizationId={organizationId} />,
    );
    await openRecovery();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    rejectedFactors.reject(repositoryError('network_unavailable'));
    await rejectedFactors.promise.catch(() => undefined);
    expect(screen.queryByText('Newone could not reach the recovery service. The same action can be retried safely while this dialog remains open.')).toBeNull();
    await rejectedView.unmount();
  });

  test.each([
    [new Error('controlled unknown error'), 'The server rejected this action. Refresh and verify with MFA again before retrying.'],
    [repositoryError('network_unavailable'), 'Newone could not reach the recovery service. The same action can be retried safely while this dialog remains open.'],
    [repositoryError('other_code', 401), 'Your session or recent MFA verification is no longer sufficient. Verify with MFA again.'],
    [repositoryError('other_code', 403), 'Your session or recent MFA verification is no longer sufficient. Verify with MFA again.'],
    [repositoryError('authentication_required'), 'Your session or recent MFA verification is no longer sufficient. Verify with MFA again.'],
    [repositoryError('csrf_required'), 'Your session or recent MFA verification is no longer sufficient. Verify with MFA again.'],
    [repositoryError('unauthorized'), 'Your session or recent MFA verification is no longer sufficient. Verify with MFA again.'],
    [repositoryError('forbidden'), 'Your session or recent MFA verification is no longer sufficient. Verify with MFA again.'],
    [repositoryError('other_code', 409), 'The case changed or this action conflicts with server policy. Refresh before continuing.'],
    [repositoryError('conflict'), 'The case changed or this action conflicts with server policy. Refresh before continuing.'],
    [repositoryError('invalid_reason'), 'Check the bounded reason or reference and try again.'],
    [repositoryError('invalid_response'), 'The recovery service returned an invalid response. Nothing is treated as completed.'],
    [repositoryError('response_too_large'), 'The recovery service returned an invalid response. Nothing is treated as completed.'],
    [repositoryError('service_unconfigured'), 'The server rejected this action. Refresh and verify with MFA again before retrying.'],
  ])('maps repository failures to stable localized copy', async (failure, expectedMessage) => {
    mockListVerifiedTotpFactors.mockImplementationOnce(async () => {
      throw failure;
    });
    const view = await render(
      <SelfRecoveryRequest accessToken="controlled-access-token" organizationId={organizationId} />,
    );
    await openRecovery();
    await waitFor(() => expect(screen.getByText(expectedMessage)).toBeTruthy());
    await view.unmount();
  });

  test('retries an ambiguous create with the exact payload and idempotency key', async () => {
    mockCreateCase
      .mockImplementationOnce(async () => {
        throw repositoryError('network_unavailable');
      })
      .mockImplementationOnce(async () => ({
        caseId: '80000000-0000-4000-8000-000000000008',
        expiresAt,
        requiredApprovals: 1,
      }));
    const onCreated = jest.fn(async (_notice: string): Promise<void> => undefined);
    const view = await render(
      <SelfRecoveryRequest
        accessToken="controlled-access-token"
        onCreated={onCreated}
        organizationId={organizationId}
      />,
    );
    await openRecovery();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verified authenticator 1' })).toBeTruthy());
    await fireEvent.changeText(
      screen.getByLabelText('Why the authenticator is unavailable'),
      'The verified authenticator is no longer available.',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Create recovery case' }));
    await waitFor(() => expect(screen.getByText('Newone could not reach the recovery service. The same action can be retried safely while this dialog remains open.')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Create recovery case' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(mockCreateCase).toHaveBeenCalledTimes(2);
    expect(mockCreateCase.mock.calls[1]?.[0]).toEqual(mockCreateCase.mock.calls[0]?.[0]);
    await view.unmount();
  });

  test('rotates the idempotency key when the failed request body changes', async () => {
    mockCreateCase
      .mockImplementationOnce(async () => {
        throw repositoryError('network_unavailable');
      })
      .mockImplementationOnce(async () => {
        throw repositoryError('conflict');
      })
      .mockImplementationOnce(async () => ({
        caseId: '80000000-0000-4000-8000-000000000008',
        expiresAt,
        requiredApprovals: 2,
      }));
    const view = await render(
      <SelfRecoveryRequest accessToken="controlled-access-token" organizationId={organizationId} />,
    );
    await openRecovery();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verified authenticator 1' })).toBeTruthy());
    const reason = screen.getByLabelText('Why the authenticator is unavailable');
    await fireEvent.changeText(reason, 'The original authenticator cannot be accessed.');
    await fireEvent.press(screen.getByRole('button', { name: 'Create recovery case' }));
    await waitFor(() => expect(mockCreateCase).toHaveBeenCalledTimes(1));

    const changedReason = `${'R'.repeat(1100)}`;
    await fireEvent.changeText(reason, changedReason);
    expect(screen.getByLabelText('Why the authenticator is unavailable').props.value).toHaveLength(1000);
    await fireEvent.press(screen.getByRole('button', { name: 'Create recovery case' }));
    await waitFor(() => expect(mockCreateCase).toHaveBeenCalledTimes(2));
    expect(mockCreateCase.mock.calls[1]?.[0]).toMatchObject({
      factorId: factorOne,
      idempotencyKey: '50000000-0000-4000-8000-000000000005',
      reason: 'R'.repeat(1000),
    });

    await fireEvent.press(screen.getByRole('button', { name: 'Security key authenticator' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create recovery case' }));
    await waitFor(() => expect(mockCreateCase).toHaveBeenCalledTimes(3));
    expect(mockCreateCase.mock.calls[2]?.[0]).toMatchObject({
      factorId: factorTwo,
      idempotencyKey: '60000000-0000-4000-8000-000000000006',
      reason: 'R'.repeat(1000),
    });
    await view.unmount();
  });

  test('locks mutable fields and dialog closing while a request is in flight', async () => {
    const pendingCreate = deferred<{
      caseId: string;
      expiresAt: string;
      requiredApprovals: number;
    }>();
    mockCreateCase.mockImplementationOnce(() => pendingCreate.promise);
    const view = await render(
      <SelfRecoveryRequest accessToken="controlled-access-token" organizationId={organizationId} />,
    );
    await openRecovery();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Verified authenticator 1' })).toBeTruthy());
    const reason = screen.getByLabelText('Why the authenticator is unavailable');
    await fireEvent.changeText(reason, 'The authenticator is unavailable after device loss.');
    await fireEvent.press(screen.getByRole('button', { name: 'Create recovery case' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submitting…' })).toBeTruthy());

    await fireEvent.changeText(reason, 'This mutation must not be accepted while busy.');
    await fireEvent.press(screen.getByRole('button', { name: 'Security key authenticator' }));
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]);
    expect(screen.getAllByText('Request lost-authenticator recovery')).toHaveLength(2);
    expect(screen.getByLabelText('Why the authenticator is unavailable').props.value).toBe('The authenticator is unavailable after device loss.');

    await act(async () => {
      pendingCreate.resolve({
        caseId: '80000000-0000-4000-8000-000000000008',
        expiresAt,
        requiredApprovals: 1,
      });
      await pendingCreate.promise;
    });
    await waitFor(() => expect(screen.getByText(/Recovery case created\./)).toBeTruthy());
    await view.unmount();
  });
});
