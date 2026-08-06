import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { AiPolicySection } from '@/features/admin/ai-policy-section';
import { AiQualityReviewSection } from '@/features/admin/ai-quality-review-section';
import { MessagePreservationSection } from '@/features/admin/message-preservation-section';
import { OrganizationPolicySection } from '@/features/admin/organization-policy-section';

let mockWorkspace: Record<string, any>;

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));

const organizationId = '20000000-0000-4000-8000-000000000001';
const conversationId = '30000000-0000-4000-8000-000000000001';
const holdId = '40000000-0000-4000-8000-000000000001';

const organizationPolicy = {
  messageRetentionDays: 365,
  allowMemberDirectMessages: true,
  dmPolicy: 'request_first',
  requireMfaForAdmins: true,
  shiftScheduleAuthoritative: false,
  groupCreationPolicy: 'managers',
  allowExternalGuests: false,
  externalGuestMaxAccessDays: 30,
  version: 7,
};

const disabledAiPolicy = {
  organizationId,
  enabled: false,
  policyVersion: 3,
  approvedUseCases: [],
  providerAllowlist: [],
  routePolicy: 'deny',
  tenantApproved: false,
  globalKillSwitchStillRequired: true,
};

function successfulAction(value: unknown = true) {
  return jest.fn(async (..._args: unknown[]) => value);
}

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    actionBusy: null,
    actionError: null,
    organizationPolicy,
    organizationAiPolicy: disabledAiPolicy,
    aiOutputReviewQueue: [],
    selectedAiOutputReport: null,
    currentUser: { id: 'reviewer-a', displayName: 'Reviewer A' },
    clearActionError: jest.fn(),
    updateOrganizationPolicy: successfulAction(organizationPolicy),
    loadOrganizationAiPolicy: successfulAction(disabledAiPolicy),
    updateOrganizationAiPolicy: successfulAction(disabledAiPolicy),
    placeMessagePreservationHold: successfulAction(holdId),
    releaseMessagePreservationHold: successfulAction(true),
    loadAiOutputReviewQueue: successfulAction(),
    readAiOutputErrorReport: successfulAction(),
    reviewAiOutputErrorReport: successfulAction(),
    proposeAiRegressionExample: successfulAction(),
    decideAiRegressionExample: successfulAction(),
    ...overrides,
  };
}

function report(overrides: Record<string, unknown> = {}) {
  return {
    reportId: 'report-a',
    organizationId,
    reporterUserId: 'reporter-a',
    outputKind: 'translation',
    targetMessageId: '91',
    targetConversationId: conversationId,
    targetLanguage: 'ko',
    category: 'incorrect_meaning',
    details: 'The translation reversed the safety instruction.',
    highConsequence: true,
    qualityUseConsent: true,
    targetOutputFingerprint: 'a'.repeat(64),
    targetSnapshot: { translatedBody: 'Preserved translated output' },
    status: 'open',
    outcome: null,
    resolutionNote: null,
    reviewedByUserId: null,
    reviewedAt: null,
    createdAt: '2030-01-02T03:04:05.000Z',
    updatedAt: '2030-01-02T03:04:05.000Z',
    version: 2,
    ...overrides,
  };
}

beforeEach(() => {
  mockWorkspace = baseWorkspace();
});

describe('organization policy controls', () => {
  test('renders a genuine loading boundary until the server policy exists', async () => {
    mockWorkspace = baseWorkspace({ organizationPolicy: null });
    await render(<OrganizationPolicySection privilegedReady />);
    expect(screen.getByText('status.loading')).toBeTruthy();
  });

  test('validates and submits the complete versioned organization policy', async () => {
    await render(<OrganizationPolicySection privilegedReady />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await fireEvent.press(screen.getByRole('button', { name: 'admin.organizationPolicyCreators.admins' }));
    await fireEvent(screen.getByLabelText('admin.organizationPolicyExternalGuests'), 'valueChange', true);
    await fireEvent.changeText(screen.getByLabelText('admin.organizationPolicyGuestDays'), '45');
    await fireEvent(screen.getByLabelText('admin.organizationPolicyShiftAuthority'), 'valueChange', true);
    await fireEvent(screen.getByLabelText('admin.organizationPolicyMemberDms'), 'valueChange', false);
    await fireEvent.press(screen.getByRole('button', { name: 'admin.organizationPolicyDm.scoped_unit' }));
    await fireEvent(screen.getByLabelText('admin.organizationPolicyAdminMfa'), 'valueChange', false);
    await fireEvent.changeText(screen.getByLabelText('admin.organizationPolicyRetentionDays'), '730');
    await fireEvent.changeText(screen.getByLabelText('admin.organizationPolicyReason'), 'Annual security policy review.');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.organizationPolicySave' }));

    await waitFor(() => expect(mockWorkspace.updateOrganizationPolicy).toHaveBeenCalledWith({
      messageRetentionDays: 730,
      allowMemberDirectMessages: false,
      dmPolicy: 'scoped_unit',
      requireMfaForAdmins: false,
      shiftScheduleAuthoritative: true,
      groupCreationPolicy: 'admins',
      allowExternalGuests: true,
      externalGuestMaxAccessDays: 45,
      version: 7,
      reason: 'Annual security policy review.',
    }));
    expect(mockWorkspace.clearActionError).toHaveBeenCalled();
    expect(screen.getByLabelText('admin.organizationPolicyReason').props.value).toBe('');
  });

  test('keeps save disabled for an unverified, unchanged, or invalid request and resyncs revisions', async () => {
    const view = await render(<OrganizationPolicySection privilegedReady={false} />);
    expect(screen.getByRole('button', { name: 'admin.organizationPolicySave' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('admin.organizationPolicyRetentionDays'), '0');
    await fireEvent.changeText(screen.getByLabelText('admin.organizationPolicyReason'), 'ok');
    expect(screen.getByRole('button', { name: 'admin.organizationPolicySave' }).props.accessibilityState.disabled).toBe(true);

    mockWorkspace = baseWorkspace({
      organizationPolicy: { ...organizationPolicy, messageRetentionDays: 90, version: 8 },
    });
    await view.rerender(<OrganizationPolicySection privilegedReady />);
    await waitFor(() => expect(screen.getByLabelText('admin.organizationPolicyRetentionDays').props.value).toBe('90'));
  });
});

describe('AI egress policy controls', () => {
  test('loads the authoritative policy and offers explicit reauthentication', async () => {
    const onSignInAgain = jest.fn();
    const loaded = { ...disabledAiPolicy, policyVersion: 4 };
    mockWorkspace = baseWorkspace({
      organizationAiPolicy: null,
      loadOrganizationAiPolicy: successfulAction(loaded),
    });
    await render(<AiPolicySection privilegedReady onSignInAgain={onSignInAgain} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Load current policy' }));
    await waitFor(() => expect(mockWorkspace.loadOrganizationAiPolicy).toHaveBeenCalled());
    await fireEvent.press(screen.getByRole('button', { name: 'Sign in again before enabling' }));
    expect(onSignInAgain).toHaveBeenCalled();
  });

  test('approves only canonical routes and selected use cases', async () => {
    const enabledPolicy = {
      ...disabledAiPolicy,
      enabled: true,
      policyVersion: 4,
      approvedUseCases: ['summary', 'translation'],
      providerAllowlist: ['openai/gpt-5-mini', 'qwen/qwen3.5-plus'],
      routePolicy: 'approved_zero_retention',
      tenantApproved: true,
    };
    mockWorkspace = baseWorkspace({ updateOrganizationAiPolicy: successfulAction(enabledPolicy) });
    await render(<AiPolicySection privilegedReady onSignInAgain={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Approve AI egress' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Translation' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Conversation summaries' }));
    await fireEvent.changeText(
      screen.getByLabelText('Exact provider routes'),
      'qwen/qwen3.5-plus, openai/gpt-5-mini',
    );
    await fireEvent.changeText(screen.getByLabelText('Audit reason'), 'Approved for multilingual operations.');
    await fireEvent.press(screen.getByRole('button', { name: 'Save exact policy' }));

    await waitFor(() => expect(mockWorkspace.updateOrganizationAiPolicy).toHaveBeenCalledWith({
      enabled: true,
      approvedUseCases: ['summary', 'translation'],
      providerAllowlist: ['openai/gpt-5-mini', 'qwen/qwen3.5-plus'],
      routePolicy: 'approved_zero_retention',
      reason: 'Approved for multilingual operations.',
    }));
    expect(screen.getByText('The versioned AI policy was saved and audited.')).toBeTruthy();
  });

  test('rejects malformed or duplicate routes and submits an explicit deny policy', async () => {
    const enabledPolicy = {
      ...disabledAiPolicy,
      enabled: true,
      policyVersion: 8,
      approvedUseCases: ['translation'],
      providerAllowlist: ['qwen/qwen3.5-plus'],
      routePolicy: 'approved_zero_retention',
      tenantApproved: true,
    };
    const denied = { ...disabledAiPolicy, policyVersion: 9 };
    mockWorkspace = baseWorkspace({
      organizationAiPolicy: enabledPolicy,
      updateOrganizationAiPolicy: successfulAction(denied),
    });
    await render(<AiPolicySection privilegedReady onSignInAgain={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('Exact provider routes'), 'Bad Route, Bad Route');
    await fireEvent.changeText(screen.getByLabelText('Audit reason'), 'Testing invalid route validation.');
    expect(screen.getByText('Select at least one task and provider route when approving egress, and enter an audit reason.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save exact policy' }).props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByRole('button', { name: 'Deny AI egress' }));
    await fireEvent.changeText(screen.getByLabelText('Audit reason'), 'Vendor access revoked immediately.');
    await fireEvent.press(screen.getByRole('button', { name: 'Save exact policy' }));
    await waitFor(() => expect(mockWorkspace.updateOrganizationAiPolicy).toHaveBeenCalledWith({
      enabled: false,
      approvedUseCases: [],
      providerAllowlist: [],
      routePolicy: 'deny',
      reason: 'Vendor access revoked immediately.',
    }));
  });
});

describe('message preservation controls', () => {
  test('places and releases a validated preservation hold', async () => {
    await render(<MessagePreservationSection privilegedReady />);
    await fireEvent.changeText(screen.getByLabelText('admin.preservationConversationId'), ` ${conversationId} `);
    await fireEvent.changeText(screen.getByLabelText('admin.preservationMessageId'), ' 987654321 ');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.preservationIncident' }));
    await fireEvent.changeText(screen.getByLabelText('admin.preservationReasonCode'), ' INCIDENT-42 ');
    await fireEvent.changeText(screen.getByLabelText('admin.preservationReferenceHash'), ` ${'B'.repeat(64)} `);
    await fireEvent.press(screen.getByRole('button', { name: 'admin.preservationPlace' }));
    await waitFor(() => expect(mockWorkspace.placeMessagePreservationHold).toHaveBeenCalledWith({
      conversationId,
      messageId: '987654321',
      holdType: 'incident_preservation',
      reasonCode: 'INCIDENT-42',
      policyReferenceSha256: 'B'.repeat(64),
    }));
    expect(screen.getByLabelText('admin.preservationHoldId').props.value).toBe(holdId);

    await fireEvent.changeText(screen.getByLabelText('admin.preservationReleaseReason'), ' CASE-CLOSED ');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.preservationRelease' }));
    await waitFor(() => expect(mockWorkspace.releaseMessagePreservationHold).toHaveBeenCalledWith(
      holdId,
      ' CASE-CLOSED ',
    ));
    expect(screen.getByLabelText('admin.preservationHoldId').props.value).toBe('');
  });

  test('blocks malformed identifiers, hashes, and unverified actions', async () => {
    await render(<MessagePreservationSection privilegedReady={false} />);
    await fireEvent.changeText(screen.getByLabelText('admin.preservationConversationId'), 'not-a-uuid');
    await fireEvent.changeText(screen.getByLabelText('admin.preservationMessageId'), '0');
    await fireEvent.changeText(screen.getByLabelText('admin.preservationReasonCode'), 'no');
    await fireEvent.changeText(screen.getByLabelText('admin.preservationReferenceHash'), 'abc');
    expect(screen.getByRole('button', { name: 'admin.preservationPlace' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'admin.preservationRelease' }).props.accessibilityState.disabled).toBe(true);
  });
});

describe('AI quality review controls', () => {
  test('gates the queue behind AAL2 and loads it once verified', async () => {
    const onVerifyNow = jest.fn();
    const view = await render(<AiQualityReviewSection privilegedReady={false} onVerifyNow={onVerifyNow} />);
    await fireEvent.press(screen.getByRole('button', { name: 'admin.verifyNow' }));
    expect(onVerifyNow).toHaveBeenCalled();
    expect(mockWorkspace.loadAiOutputReviewQueue).not.toHaveBeenCalled();
    await view.rerender(<AiQualityReviewSection privilegedReady onVerifyNow={onVerifyNow} />);
    await waitFor(() => expect(mockWorkspace.loadAiOutputReviewQueue).toHaveBeenCalled());
    expect(screen.getByText('quality.empty')).toBeTruthy();
  });

  test('opens and resolves a real report review while preserving the recorded output', async () => {
    const queueReport = report();
    const detail = { report: queueReport, regressionExample: null };
    const read = jest.fn(async () => {
      mockWorkspace.selectedAiOutputReport = detail;
      return detail;
    });
    mockWorkspace = baseWorkspace({
      aiOutputReviewQueue: [queueReport],
      selectedAiOutputReport: detail,
      readAiOutputErrorReport: read,
    });
    await render(<AiQualityReviewSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: /quality\.outputTranslation/ }));
    await waitFor(() => expect(read).toHaveBeenCalledWith('report-a'));
    expect(screen.getByText('Preserved translated output')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'quality.needsContext' }));
    await fireEvent.changeText(screen.getByLabelText('quality.reviewNote'), 'Need original source context.');
    await fireEvent.press(screen.getByRole('button', { name: 'quality.submitReview' }));
    expect(mockWorkspace.reviewAiOutputErrorReport).toHaveBeenCalledWith(
      'report-a', 2, 'needs_context', 'Need original source context.',
    );
  });

  test('proposes a deidentified regression example only after attestation', async () => {
    const confirmed = report({ status: 'resolved', outcome: 'confirmed_error' });
    mockWorkspace = baseWorkspace({
      aiOutputReviewQueue: [confirmed],
      selectedAiOutputReport: { report: confirmed, regressionExample: null },
    });
    await render(<AiQualityReviewSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('quality.sourceLanguage'), 'es');
    await fireEvent.changeText(screen.getByLabelText('quality.deidentifiedSource'), 'Controlled source without identifiers.');
    await fireEvent.changeText(screen.getByLabelText('quality.observedOutput'), 'Incorrect controlled output.');
    await fireEvent.changeText(screen.getByLabelText('quality.expectedOutput'), 'Correct controlled output.');
    await fireEvent.press(screen.getByRole('checkbox'));
    await fireEvent.press(screen.getByRole('button', { name: 'quality.proposeExample' }));
    expect(mockWorkspace.proposeAiRegressionExample).toHaveBeenCalledWith({
      reportId: 'report-a',
      expectedReportVersion: 2,
      sourceLanguage: 'es',
      deidentifiedSourceText: 'Controlled source without identifiers.',
      deidentifiedObservedOutput: 'Incorrect controlled output.',
      deidentifiedExpectedOutput: 'Correct controlled output.',
    });
  });

  test('enforces consent and independent second review before approving examples', async () => {
    const noConsent = report({ outcome: 'confirmed_error', qualityUseConsent: false });
    mockWorkspace = baseWorkspace({
      aiOutputReviewQueue: [noConsent],
      selectedAiOutputReport: { report: noConsent, regressionExample: null },
    });
    const view = await render(<AiQualityReviewSection privilegedReady onVerifyNow={jest.fn()} />);
    expect(screen.getByText('quality.consentMissing')).toBeTruthy();

    const pending = {
      exampleId: 'example-a',
      reportId: 'report-a',
      deidentifiedExpectedOutput: 'Expected safe wording.',
      status: 'pending',
      proposedByUserId: 'reviewer-a',
      version: 4,
    };
    mockWorkspace = baseWorkspace({
      aiOutputReviewQueue: [noConsent],
      selectedAiOutputReport: {
        report: { ...noConsent, qualityUseConsent: true },
        regressionExample: pending,
      },
    });
    await view.rerender(<AiQualityReviewSection privilegedReady onVerifyNow={jest.fn()} />);
    expect(screen.getByText('quality.secondReviewerRequired')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('quality.decisionNote'), 'Independent review completed.');
    expect(screen.getByRole('button', { name: 'quality.approveExample' }).props.accessibilityState.disabled).toBe(true);

    mockWorkspace = baseWorkspace({
      currentUser: { id: 'reviewer-b', displayName: 'Reviewer B' },
      aiOutputReviewQueue: [noConsent],
      selectedAiOutputReport: {
        report: { ...noConsent, qualityUseConsent: true },
        regressionExample: pending,
      },
    });
    await view.rerender(<AiQualityReviewSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.changeText(screen.getByLabelText('quality.decisionNote'), 'Independent review completed.');
    await fireEvent.press(screen.getByRole('button', { name: 'quality.approveExample' }));
    expect(mockWorkspace.decideAiRegressionExample).toHaveBeenCalledWith(
      'example-a', 4, 'approved', 'Independent review completed.',
    );
    await fireEvent.press(screen.getByRole('button', { name: 'quality.rejectExample' }));
    expect(mockWorkspace.decideAiRegressionExample).toHaveBeenCalledWith(
      'example-a', 4, 'rejected', 'Independent review completed.',
    );
  });

  test('renders non-string snapshots and completed example export status', async () => {
    const confirmed = report({
      outputKind: 'summary',
      outcome: 'confirmed_error',
      targetSnapshot: { structured: ['one', 'two'] },
      category: 'other',
      highConsequence: false,
      status: 'dismissed',
    });
    mockWorkspace = baseWorkspace({
      aiOutputReviewQueue: [confirmed],
      selectedAiOutputReport: {
        report: confirmed,
        regressionExample: {
          exampleId: 'example-exported', reportId: 'report-a',
          deidentifiedExpectedOutput: 'Approved output.', status: 'exported',
          proposedByUserId: 'reviewer-a', version: 9,
        },
      },
    });
    await render(<AiQualityReviewSection privilegedReady onVerifyNow={jest.fn()} />);
    expect(screen.getByText(/"structured"/)).toBeTruthy();
    expect(screen.getByText('quality.statusExported')).toBeTruthy();
    expect(screen.getByText('quality.serviceExport')).toBeTruthy();
  });
});
