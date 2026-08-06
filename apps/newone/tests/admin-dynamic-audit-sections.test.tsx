import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Share } from 'react-native';

import { AuditAccessSection } from '@/features/admin/audit-access-section';
import { DynamicGroupSection } from '@/features/admin/dynamic-group-section';

let mockWorkspace: Record<string, any>;
const mockDigestStringAsync = jest.fn(async (_algorithm: unknown, value: string) =>
  value === 'controlled-export' ? 'a'.repeat(64) : 'b'.repeat(64));

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: (...args: [unknown, string]) => mockDigestStringAsync(...args),
}));
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));

const organizationId = '20000000-0000-4000-8000-000000000001';
const policyId = '30000000-0000-4000-8000-000000000001';
const conversationId = '40000000-0000-4000-8000-000000000001';
const siteId = '50000000-0000-4000-8000-000000000001';
const departmentId = '50000000-0000-4000-8000-000000000002';
const teamId = '50000000-0000-4000-8000-000000000003';
const lineId = '50000000-0000-4000-8000-000000000004';
const shiftId = '50000000-0000-4000-8000-000000000005';

function successfulAction(value: unknown = true) {
  return jest.fn(async (..._args: unknown[]) => value);
}

const policySpec = {
  siteIds: [siteId],
  departmentIds: [departmentId],
  teamIds: [],
  lineIds: [],
  unitIds: [],
  includeDescendants: true,
  operationalRoles: ['quality lead'],
  membershipRoles: ['manager', 'member'],
  shiftMode: 'current',
  scheduledShiftStartsAt: null,
  scheduledShiftEndsAt: null,
};

function dynamicPolicy(overrides: Record<string, unknown> = {}) {
  return {
    policyId,
    conversationId,
    conversationName: 'Operations response',
    conversationKind: 'group',
    conversationUnitId: null,
    status: 'active',
    version: 5,
    draftState: 'published',
    policySpec,
    maximumMembers: 250,
    selectorFingerprint: 'selector-a',
    publishedVersionId: 'version-a',
    lastPreviewFingerprint: 'preview-old',
    lastPreviewedAt: '2030-01-01T00:00:00.000Z',
    lastSyncedAt: '2030-01-01T00:00:00.000Z',
    nextEvaluationAt: null,
    sourceChangedAt: null,
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    policyId,
    policyVersion: 1,
    previewFingerprint: 'preview-fingerprint',
    selectorFingerprint: 'selector-fingerprint',
    membershipStateFingerprint: 'membership-fingerprint',
    evaluatedAt: '2030-01-01T00:00:00.000Z',
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    eligibleCount: 3,
    addedCount: 1,
    removedCount: 1,
    unchangedCount: 1,
    addedSampleUserIds: ['person-known'],
    removedSampleUserIds: ['12345678-0000-4000-8000-000000009999'],
    unchangedSampleUserIds: [],
    nextBoundaryAt: null,
    ...overrides,
  };
}

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    actionBusy: null,
    actionError: null,
    organizationId,
    currentUser: { id: 'current-person', displayName: 'Current Person' },
    people: [{ id: 'person-known', displayName: 'Known Person' }],
    capabilities: ['unit.manage'],
    hasCapability: jest.fn((capability: string) => capability === 'unit.manage'),
    conversations: [
      { id: conversationId, title: 'Operations response', kind: 'group', archived: false, canManageDynamicGroup: true },
      { id: 'team-conversation', title: 'Quality team', kind: 'team', archived: false, canManageDynamicGroup: true },
      { id: 'shift-conversation', title: 'Night shift', kind: 'shift', archived: false, canManageDynamicGroup: true },
      { id: 'direct-hidden', title: 'Direct hidden', kind: 'direct', archived: false, canManageDynamicGroup: true },
      { id: 'archived-hidden', title: 'Archived hidden', kind: 'group', archived: true, canManageDynamicGroup: true },
    ],
    units: [
      { unitId: siteId, parentUnitId: null, kind: 'site', name: 'Denver' },
      { unitId: departmentId, parentUnitId: siteId, kind: 'department', name: 'Operations' },
      { unitId: teamId, parentUnitId: departmentId, kind: 'team', name: 'Quality' },
      { unitId: lineId, parentUnitId: departmentId, kind: 'line', name: 'Line 1' },
      { unitId: shiftId, parentUnitId: lineId, kind: 'shift', name: 'Night' },
    ],
    dynamicGroupPolicies: [],
    dynamicGroupNextAfterPolicyId: null,
    clearActionError: jest.fn(),
    loadDynamicGroupPolicies: successfulAction(),
    saveDynamicGroupPolicy: successfulAction({ policyId, version: 1 }),
    previewDynamicGroupPolicy: successfulAction(preview()),
    publishDynamicGroupPolicy: successfulAction({ status: 'active' }),
    pauseDynamicGroupPolicy: successfulAction({ status: 'paused' }),
    queryAudit: successfulAction(null),
    exportAudit: successfulAction(null),
    ...overrides,
  };
}

function auditEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-a',
    eventType: 'member.suspended',
    actorUserId: 'person-known',
    targetType: 'membership',
    targetId: 'membership-a',
    outcome: 'succeeded',
    occurredAt: '2030-01-02T03:04:05.000Z',
    ...overrides,
  };
}

function auditPage(overrides: Record<string, unknown> = {}) {
  return {
    items: [
      auditEvent(),
      auditEvent({ id: 'event-b', actorUserId: null, outcome: 'denied', targetId: 'membership-b' }),
    ],
    nextCursor: 'cursor-next',
    snapshotAt: '2030-01-02T04:00:00.000Z',
    filterSha256: 'f'.repeat(64),
    receiptId: null,
    ...overrides,
  };
}

function exportReceipt(overrides: Record<string, unknown> = {}) {
  return {
    receiptId: 'receipt-a',
    fileName: 'audit-export.json',
    contentType: 'application/json',
    format: 'json',
    rowCount: 2,
    payload: 'controlled-export',
    payloadBytes: new TextEncoder().encode('controlled-export').byteLength,
    sha256: 'a'.repeat(64),
    ...overrides,
  };
}

beforeEach(() => {
  mockWorkspace = baseWorkspace();
  mockDigestStringAsync.mockClear();
  jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
});

describe('dynamic group policy lifecycle', () => {
  test('gates the surface by capability and AAL2', async () => {
    mockWorkspace = baseWorkspace({ hasCapability: jest.fn(() => false) });
    const deniedView = await render(<DynamicGroupSection privilegedReady />);
    expect(screen.getByText('You need unit management permission to view or change dynamic groups.')).toBeTruthy();
    expect(mockWorkspace.loadDynamicGroupPolicies).not.toHaveBeenCalled();
    await deniedView.unmount();

    mockWorkspace = baseWorkspace();
    await render(<DynamicGroupSection privilegedReady={false} />);
    expect(screen.getByText('MFA required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New policy' }).props.accessibilityState.disabled).toBe(true);
  });

  test('builds, previews, and publishes a canonical policy across every unit selector', async () => {
    await render(<DynamicGroupSection privilegedReady />);
    await waitFor(() => expect(mockWorkspace.loadDynamicGroupPolicies).toHaveBeenCalledWith(false));
    await fireEvent.press(screen.getByRole('button', { name: 'New policy' }));
    for (const unit of ['Site · Denver', 'Department · Operations', 'Team · Quality', 'Line · Line 1', 'Shift · Night']) {
      await fireEvent.press(screen.getByRole('button', { name: unit }));
    }
    await fireEvent(screen.getByLabelText('Include descendant units'), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Admin' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Manager' }));
    await fireEvent.changeText(screen.getByLabelText('Operational role text'), ' Supervisor; Quality Lead ');
    await fireEvent.press(screen.getByRole('button', { name: 'Scheduled window' }));
    await fireEvent.changeText(screen.getByLabelText('Scheduled start (ISO 8601)'), '2030-01-01T18:00:00-06:00');
    await fireEvent.changeText(screen.getByLabelText('Scheduled end (ISO 8601)'), '2030-01-02T06:00:00-06:00');
    await fireEvent.changeText(screen.getByLabelText('Maximum members'), '125');
    await fireEvent.press(screen.getByRole('button', { name: 'Save draft & preview' }));

    await waitFor(() => expect(mockWorkspace.saveDynamicGroupPolicy).toHaveBeenCalledWith({
      conversationId,
      policyId: null,
      expectedVersion: 0,
      policySpec: {
        siteIds: [siteId],
        departmentIds: [departmentId],
        teamIds: [teamId],
        lineIds: [lineId],
        unitIds: [shiftId],
        includeDescendants: true,
        operationalRoles: ['quality lead', 'supervisor'],
        membershipRoles: ['admin', 'manager', 'member'],
        shiftMode: 'scheduled',
        scheduledShiftStartsAt: '2030-01-02T00:00:00.000Z',
        scheduledShiftEndsAt: '2030-01-02T12:00:00.000Z',
      },
      maximumMembers: 125,
    }));
    expect(mockWorkspace.previewDynamicGroupPolicy).toHaveBeenCalledWith(policyId, 1, 50);
    expect(screen.getByText('Known Person')).toBeTruthy();
    expect(screen.getByText('12345678…9999')).toBeTruthy();
    expect(screen.getAllByText('No sampled members').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByRole('button', { name: 'Publish exact preview' }));
    await waitFor(() => expect(mockWorkspace.publishDynamicGroupPolicy).toHaveBeenCalledWith(
      policyId, 1, 'preview-fingerprint',
    ));
    expect(screen.getByText('The preview was published. Automated membership is active.')).toBeTruthy();
  });

  test('edits, pauses, paginates, and invalidates a preview when selectors change', async () => {
    const activePolicy = dynamicPolicy();
    mockWorkspace = baseWorkspace({
      dynamicGroupPolicies: [
        activePolicy,
        dynamicPolicy({ policyId: 'policy-paused', conversationName: 'Paused group', conversationKind: 'team', status: 'paused', draftState: 'previewed' }),
        dynamicPolicy({ policyId: 'policy-draft', conversationName: 'Draft group', conversationKind: 'shift', status: 'draft', draftState: 'draft' }),
      ],
      dynamicGroupNextAfterPolicyId: 'policy-draft',
      saveDynamicGroupPolicy: successfulAction({ policyId, version: 6 }),
      previewDynamicGroupPolicy: successfulAction(preview({ policyVersion: 6 })),
    });
    await render(<DynamicGroupSection privilegedReady />);
    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));
    expect(mockWorkspace.loadDynamicGroupPolicies).toHaveBeenCalledWith(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Operations response, Version 5' }));
    expect(screen.getByText('A policy stays bound to its original group. Start a new policy to choose another group.')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('Pause reason'), 'Source directory maintenance.');
    await fireEvent.press(screen.getByRole('button', { name: 'Pause policy' }));
    await waitFor(() => expect(mockWorkspace.pauseDynamicGroupPolicy).toHaveBeenCalledWith(
      policyId, 5, 'Source directory maintenance.',
    ));
    expect(screen.getByText('Automated membership was paused and the reason was audited.')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Operations response, Version 5' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save draft & preview' }));
    await waitFor(() => expect(screen.getByTestId('dynamic-group-preview')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Owner' }));
    expect(screen.queryByTestId('dynamic-group-preview')).toBeNull();
  });

  test('rejects duplicate roles and invalid or oversized scheduled windows', async () => {
    await render(<DynamicGroupSection privilegedReady />);
    await fireEvent.press(screen.getByRole('button', { name: 'New policy' }));
    await fireEvent.changeText(screen.getByLabelText('Operational role text'), 'lead, lead');
    expect(screen.getByRole('button', { name: 'Save draft & preview' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Operational role text'), 'lead');
    await fireEvent.press(screen.getByRole('button', { name: 'Scheduled window' }));
    await fireEvent.changeText(screen.getByLabelText('Scheduled start (ISO 8601)'), 'not-a-date');
    await fireEvent.changeText(screen.getByLabelText('Scheduled end (ISO 8601)'), '2030-01-02T00:00:00Z');
    expect(screen.getByRole('button', { name: 'Save draft & preview' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('Scheduled start (ISO 8601)'), '2030-01-01T00:00:00Z');
    await fireEvent.changeText(screen.getByLabelText('Scheduled end (ISO 8601)'), '2030-03-02T00:00:00Z');
    expect(screen.getByRole('button', { name: 'Save draft & preview' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Current shift' }));
    await fireEvent.changeText(screen.getByLabelText('Maximum members'), '5001');
    expect(screen.getByRole('button', { name: 'Save draft & preview' }).props.accessibilityState.disabled).toBe(true);
  });

  test('keeps failed save, preview, publish, and pause mutations fail-closed while allowing selector removal', async () => {
    const saveDynamicGroupPolicy: any = successfulAction(null);
    const previewDynamicGroupPolicy: any = successfulAction(null);
    const publishDynamicGroupPolicy: any = successfulAction(null);
    mockWorkspace = baseWorkspace({
      saveDynamicGroupPolicy,
      previewDynamicGroupPolicy,
      publishDynamicGroupPolicy,
    });
    const view = await render(<DynamicGroupSection privilegedReady />);
    await fireEvent.press(screen.getByRole('button', { name: 'New policy' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Site · Denver' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Site · Denver' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Member' }));
    expect(screen.getByRole('button', { name: 'Save draft & preview' }).props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Member' }));

    await fireEvent.press(screen.getByRole('button', { name: 'Save draft & preview' }));
    await waitFor(() => expect(saveDynamicGroupPolicy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('dynamic-group-preview')).toBeNull();

    saveDynamicGroupPolicy.mockResolvedValue({ policyId, version: 1 });
    await fireEvent.press(screen.getByRole('button', { name: 'Save draft & preview' }));
    await waitFor(() => expect(previewDynamicGroupPolicy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('dynamic-group-preview')).toBeNull();

    previewDynamicGroupPolicy.mockResolvedValue(preview());
    await fireEvent.press(screen.getByRole('button', { name: 'Save draft & preview' }));
    await waitFor(() => expect(screen.getByTestId('dynamic-group-preview')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Publish exact preview' }));
    await waitFor(() => expect(publishDynamicGroupPolicy).toHaveBeenCalled());
    expect(screen.getByTestId('dynamic-group-preview')).toBeTruthy();
    await view.unmount();

    const pauseDynamicGroupPolicy: any = successfulAction(null);
    mockWorkspace = baseWorkspace({
      dynamicGroupPolicies: [dynamicPolicy()],
      pauseDynamicGroupPolicy,
    });
    await render(<DynamicGroupSection privilegedReady />);
    await fireEvent.press(screen.getByRole('button', { name: 'Operations response, Version 5' }));
    await fireEvent.changeText(screen.getByLabelText('Pause reason'), 'Controlled maintenance');
    await fireEvent.press(screen.getByRole('button', { name: 'Pause policy' }));
    await waitFor(() => expect(pauseDynamicGroupPolicy).toHaveBeenCalled());
    expect(screen.queryByText('Automated membership was paused and the reason was audited.')).toBeNull();
  });
});

describe('purpose-bound audit access', () => {
  test('requires recent AAL2 verification', async () => {
    const onVerifyNow = jest.fn();
    await render(<AuditAccessSection privilegedReady={false} onVerifyNow={onVerifyNow} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Verify now' }));
    expect(onVerifyNow).toHaveBeenCalled();
  });

  test('validates purpose and event filters before any audit request', async () => {
    await render(<AuditAccessSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'View audit records' }));
    expect(screen.getByText('Choose an access purpose before continuing.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Security review' }));
    await fireEvent.changeText(screen.getByLabelText('Event types (optional)'), 'member.suspended,member.suspended');
    await fireEvent.press(screen.getByRole('button', { name: 'View audit records' }));
    expect(screen.getByText('Use at most 10 unique event types separated by commas.')).toBeTruthy();
    expect(mockWorkspace.queryAudit).not.toHaveBeenCalled();
  });

  test('queries, renders, and appends a deduplicated snapshot page', async () => {
    const queryAudit = jest.fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValueOnce(auditPage())
      .mockResolvedValueOnce(auditPage({
        items: [auditEvent(), auditEvent({ id: 'event-c', outcome: 'failed', targetId: 'membership-c' })],
        nextCursor: null,
        receiptId: 'receipt-query',
      }));
    mockWorkspace = baseWorkspace({ queryAudit });
    await render(<AuditAccessSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Incident investigation' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Last 24 hours' }));
    await fireEvent.changeText(screen.getByLabelText('Event types (optional)'), 'member.suspended, role.assignment.granted');
    await fireEvent.changeText(screen.getByLabelText('Target type (optional)'), ' membership ');
    await fireEvent.changeText(screen.getByLabelText('Target identifier (optional)'), ' membership-a ');
    await fireEvent.press(screen.getByRole('button', { name: 'View audit records' }));
    await waitFor(() => expect(queryAudit).toHaveBeenCalledTimes(1));
    const firstRequest = queryAudit.mock.calls[0]![0] as Record<string, any>;
    expect(firstRequest).toEqual(expect.objectContaining({
      reasonCode: 'incident_investigation',
      eventTypes: ['member.suspended', 'role.assignment.granted'],
      targetType: 'membership',
      targetId: 'membership-a',
      cursor: null,
      limit: 50,
    }));
    expect(Date.parse(firstRequest.dateTo) - Date.parse(firstRequest.dateFrom)).toBe(24 * 60 * 60 * 1000);
    expect(screen.getByText(/Filter receipt: f{12}…f{12}/)).toBeTruthy();
    expect(screen.getByText(/Known Person · membership/)).toBeTruthy();
    expect(screen.getByText(/System actor · membership/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(queryAudit).toHaveBeenCalledTimes(2));
    expect(queryAudit.mock.calls[1]![0]).toEqual(expect.objectContaining({ cursor: 'cursor-next' }));
    expect(screen.getAllByText('member.suspended')).toHaveLength(3);
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  test('reports failed queries and exports without exposing message content', async () => {
    const receipt = exportReceipt();
    mockWorkspace = baseWorkspace({ exportAudit: successfulAction(receipt) });
    await render(<AuditAccessSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Compliance review' }));
    await fireEvent.press(screen.getByRole('button', { name: 'View audit records' }));
    await waitFor(() => expect(screen.getByText('The audit request could not be completed. Check verification and try again.')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(mockWorkspace.exportAudit).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'compliance_review', format: 'json', eventTypes: [],
    })));
    expect(screen.getByText('Content-free export ready')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Save or share export' }));
    await waitFor(() => expect(Share.share).toHaveBeenCalledWith({
      message: 'controlled-export', title: 'audit-export.json',
    }));
    expect(mockDigestStringAsync).toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mockWorkspace.exportAudit).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'csv' }));
  });

  test('blocks an export whose bytes or SHA-256 receipt changed and handles save failures', async () => {
    const view = await render(<AuditAccessSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Access review' }));
    mockWorkspace = baseWorkspace({ exportAudit: successfulAction(exportReceipt({ payloadBytes: 1 })) });
    await view.rerender(<AuditAccessSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Access review' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(screen.getByText('Content-free export ready')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Save or share export' }));
    await waitFor(() => expect(screen.getByText('The export changed after verification and was blocked. Generate a new export.')).toBeTruthy());
    expect(Share.share).not.toHaveBeenCalled();

    mockWorkspace = baseWorkspace({ exportAudit: successfulAction(exportReceipt()) });
    await view.rerender(<AuditAccessSection privilegedReady onVerifyNow={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Access review' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Export JSON' }));
    await waitFor(() => expect(screen.getByText('Content-free export ready')).toBeTruthy());
    mockDigestStringAsync.mockRejectedValueOnce(new Error('digest unavailable'));
    await fireEvent.press(screen.getByRole('button', { name: 'Save or share export' }));
    await waitFor(() => expect(screen.getByText('The secure save or share action failed. The export was not copied to the clipboard.')).toBeTruthy());
  });
});
