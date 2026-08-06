import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import UpdatesScreen from '@/app/updates';
import { RepositoryError } from '@/data/repositories/contracts';
import { updateCopy } from '@/features/updates/update-copy';

const copy = updateCopy('en');
const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockWidth = 1280;
let mockAuth: Record<string, unknown>;
let mockWorkspace: Record<string, unknown>;
type AsyncMock = jest.Mock<(...args: never[]) => Promise<unknown>>;
type MockCommands = Record<string, AsyncMock>;
let mockCommands: MockCommands;
let mockClientSequence = 0;
let mockRepositoryContext: { getSession: () => Promise<unknown> } | null = null;
let mockSupabaseClient: {
  auth: { getSession: () => Promise<{ data: { session: unknown } }> };
} | null = null;

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});

jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 900 }),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/auth', () => ({ useAuth: () => mockAuth }));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('@/data/repositories/bff-command-repository', () => ({
  BffCommandRepository: jest.fn().mockImplementation((...args: unknown[]) => {
    mockRepositoryContext = args[0] as typeof mockRepositoryContext;
    return mockCommands;
  }),
}));
jest.mock('@/lib/client-id', () => ({
  createClientId: () => `controlled-client-${++mockClientSequence}`,
}));
jest.mock('@/lib/supabase', () => ({ getSupabaseClient: () => mockSupabaseClient }));

const self = {
  id: 'user-self', displayName: 'Jordan Lee', initials: 'JL', avatarColor: '#123456',
  roleLabel: 'Supervisor', role: 'manager', site: 'Denver', department: 'Operations',
  preferredLanguage: 'en', presence: 'online', connectionState: 'self',
};

function companyUpdate(overrides: Record<string, unknown> = {}) {
  return {
    id: 'update-critical',
    versionId: 'version-critical',
    versionNumber: 3,
    title: 'Critical safety instruction',
    body: 'Stop line two and verify the north gate before restart.',
    translatedBody: 'Detenga la línea dos y verifique la puerta norte.',
    author: 'Safety Office',
    audience: 'Denver operations',
    publishedAt: '2026-08-04 09:00',
    severity: 'critical',
    acknowledgementRequired: true,
    acknowledged: false,
    acknowledgedCount: 4,
    recipientCount: 8,
    recipientCountKnown: true,
    deadline: '2026-08-04 12:00',
    status: 'published',
    notificationClass: 'critical',
    acknowledgementSchema: {
      schemaVersion: 1,
      attestationRequired: true,
      attestationPrompt: 'I verified the line is stopped.',
      requiredKeys: ['confirmed'],
      carryForwardOnCorrection: false,
    },
    reminderPolicy: {
      enabled: true, deadlineAt: '2026-08-04T18:00:00.000Z', intervalSeconds: 900,
      maximumReminders: 3, escalateAfterSeconds: 3600, smsFallback: false,
    },
    ...overrides,
  };
}

function managedUpdate(overrides: Record<string, unknown> = {}) {
  return {
    announcementId: 'managed-published',
    conversationId: 'announcement-channel',
    conversationTitle: 'Official Announcements',
    versionId: 'managed-version-2',
    versionNumber: 2,
    versionCount: 2,
    title: 'Published managed update',
    body: 'Authoritative published content.',
    languageCode: 'en',
    priority: 'important',
    notificationClass: 'urgent',
    criticalCategory: 'operations',
    quietHoursOverrideReason: 'Shift change requires immediate delivery.',
    requiresAcknowledgement: true,
    acknowledgementSchema: {
      schemaVersion: 1, attestationRequired: false, attestationPrompt: null,
      requiredKeys: [], carryForwardOnCorrection: false,
    },
    reminderPolicy: {
      enabled: true, deadlineAt: '2026-08-05T18:00:00.000Z', intervalSeconds: 1800,
      maximumReminders: 4, escalateAfterSeconds: 7200, smsFallback: false,
    },
    status: 'published',
    scheduledAt: null,
    publishedAt: '2026-08-04T16:00:00.000Z',
    expiresAt: null,
    cancelledAt: null,
    cancellationReason: null,
    correctionOfVersionId: 'managed-version-1',
    correctionReason: 'Clarified the restart sequence.',
    audienceSnapshotted: true,
    recipientCount: 20,
    deliveredCount: 18,
    readCount: 16,
    acknowledgedCount: 12,
    nonAcknowledgedCount: 8,
    overdueCount: 2,
    unreachableCount: 1,
    versions: [
      {
        versionId: 'managed-version-1', versionNumber: 1, title: 'Original managed update',
        body: 'Original body.', publishedAt: '2026-08-04T15:00:00.000Z',
        correctionOfVersionId: null, correctionReason: null, createdByUserId: 'publisher-a',
        createdByDisplayName: 'Publisher One',
      },
      {
        versionId: 'managed-version-2', versionNumber: 2, title: 'Published managed update',
        body: 'Authoritative published content.', publishedAt: '2026-08-04T16:00:00.000Z',
        correctionOfVersionId: 'managed-version-1', correctionReason: 'Clarified the restart sequence.',
        createdByUserId: 'publisher-a', createdByDisplayName: 'Publisher One',
      },
    ],
    ...overrides,
  };
}

function nonResponder(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'non-responder-one', displayName: 'Non Responder One', preferredLanguage: 'en',
    membershipStatus: 'active', deliveredAt: '2026-08-04T16:01:00.000Z', readAt: null,
    reminderCount: 2, lastRemindedAt: '2026-08-04T17:00:00.000Z', escalatedAt: null,
    reachability: 'delivered', overdue: true,
    ...overrides,
  };
}

function buildCommands(managed: Record<string, unknown>[]) {
  return {
    listManagedUpdates: jest.fn(async () => ({ updates: managed })),
    previewUpdateAudience: jest.fn(async (input: {
      audienceSpec: Record<string, unknown> & { currentShiftOnly: boolean };
    }) => ({
      audienceCount: 7,
      excludedCount: 3,
      sampleUserIds: ['member-one'],
      sample: [{
        userId: 'member-one', displayName: 'Sample Recipient', preferredLanguage: 'en',
        membershipRole: 'member', unitIds: ['unit-site'], currentShift: true,
      }],
      notificationLanguages: ['en', 'es'],
      exclusionCounts: { inactiveMembers: 1, selectorMismatch: 2 },
      normalizedSpec: input.audienceSpec,
      snapshotBasis: input.audienceSpec.currentShiftOnly
        ? 'active_members_and_current_shift_at_publish'
        : 'active_members_at_publish',
      generatedAt: '2026-08-04T18:00:00.000Z',
    })),
    publishUpdate: jest.fn(async () => ({
      announcementId: 'published-local', versionId: 'published-local-version', status: 'scheduled',
      scheduledAt: '2030-08-10T10:00:00.000Z', audienceCount: null,
    })),
    markUpdateRead: jest.fn(async () => undefined),
    acknowledgeUpdate: jest.fn(async () => undefined),
    cancelScheduledUpdate: jest.fn(async () => undefined),
    correctUpdate: jest.fn(async () => undefined),
    listUpdateNonAcknowledgers: jest.fn<(...args: never[]) => Promise<unknown>>()
      .mockResolvedValueOnce({
        people: [
          nonResponder(),
          nonResponder({
            userId: 'non-responder-two', displayName: 'Pending Recipient', preferredLanguage: 'es',
            reachability: 'pending', deliveredAt: null, overdue: false,
          }),
        ],
        nextAfterUserId: 'non-responder-two', hasMore: true,
      })
      .mockResolvedValueOnce({
        people: [nonResponder({
          userId: 'non-responder-three', displayName: 'Unreachable Recipient', preferredLanguage: 'ko',
          reachability: 'unreachable', deliveredAt: null, readAt: null, overdue: true,
          escalatedAt: '2026-08-04T18:30:00.000Z',
        })],
        nextAfterUserId: null, hasMore: false,
      }),
  } as unknown as MockCommands;
}

function buildWorkspace() {
  return {
    actionBusy: null,
    actionError: null,
    capabilities: ['communications.publish'],
    connectivity: 'online',
    conversations: [{
      id: 'announcement-channel', title: 'Official Announcements', kind: 'announcement',
      managementOnly: false, canPost: true, unreadCount: 0,
    }],
    currentUser: self,
    failedOutboxCount: 0,
    handoffs: [],
    offlineQueueAvailable: true,
    organizationId: 'organization-a',
    outboxCount: 0,
    people: [
      self,
      { ...self, id: 'person-es', displayName: 'Ana Torres', roleLabel: 'Operator', preferredLanguage: 'es' },
    ],
    realtimeState: 'subscribed',
    status: 'ready',
    units: [
      { unitId: 'unit-site', name: 'Denver Site', kind: 'site' },
      { unitId: 'unit-department', name: 'Operations Department', kind: 'department' },
      { unitId: 'unit-team', name: 'Safety Team', kind: 'team' },
      { unitId: 'unit-line', name: 'Line Two', kind: 'line' },
      { unitId: 'unit-shift', name: 'Night Shift', kind: 'shift' },
    ],
    updates: [
      companyUpdate(),
      companyUpdate({
        id: 'update-standard', versionId: 'version-standard', title: 'Cafeteria hours',
        translatedBody: undefined, severity: 'standard', acknowledgementRequired: false,
        acknowledgementSchema: null, reminderPolicy: null, recipientCountKnown: false,
        readAt: '2026-08-04T16:00:00.000Z', status: undefined,
      }),
      companyUpdate({
        id: 'update-scheduled', versionId: 'version-scheduled', title: 'Scheduled maintenance',
        severity: 'important', status: 'scheduled', recipientCountKnown: false,
      }),
      companyUpdate({
        id: 'update-cancelled', versionId: 'version-cancelled', title: 'Cancelled drill',
        severity: 'important', status: 'cancelled', acknowledged: true,
      }),
    ],
    clearActionError: jest.fn(),
    hasCapability: jest.fn((capability: string) => capability === 'communications.publish'),
    refresh: jest.fn(async () => true),
  };
}

beforeEach(() => {
  mockClientSequence = 0;
  mockWidth = 1280;
  mockAuth = { assuranceLevel: 'aal2' };
  mockRepositoryContext = null;
  mockSupabaseClient = null;
  const managed = [
    managedUpdate(),
    managedUpdate({
      announcementId: 'managed-scheduled', versionId: 'scheduled-version', title: 'Scheduled managed update',
      status: 'scheduled', scheduledAt: '2030-08-10T10:00:00.000Z', publishedAt: null,
      audienceSnapshotted: false, cancellationReason: null, quietHoursOverrideReason: null,
      requiresAcknowledgement: false, nonAcknowledgedCount: 0,
      reminderPolicy: { enabled: false, deadlineAt: null, intervalSeconds: null, maximumReminders: 0, escalateAfterSeconds: null, smsFallback: false },
    }),
    managedUpdate({
      announcementId: 'managed-cancelled', versionId: 'cancelled-version', title: 'Cancelled managed update',
      status: 'cancelled', cancellationReason: 'Weather cleared.', requiresAcknowledgement: false,
      notificationClass: 'routine', quietHoursOverrideReason: null,
    }),
    managedUpdate({
      announcementId: 'managed-archived', versionId: 'archived-version', title: 'Archived managed update',
      status: 'archived', notificationClass: 'critical', nonAcknowledgedCount: 1,
    }),
  ];
  mockCommands = buildCommands(managed);
  mockWorkspace = buildWorkspace();
});

describe('critical updates screen', () => {
  test('drives publication, attributable acknowledgement, scheduling, correction, cancellation, and scoped response review', async () => {
    const view = await render(<UpdatesScreen />);
    await waitFor(() => expect(screen.getByText('Published managed update')).toBeTruthy());

    await fireEvent.press(screen.getAllByRole('button', { name: copy.openUpdate })[0]!);
    await waitFor(() => expect(mockCommands.markUpdateRead).toHaveBeenCalledWith(expect.objectContaining({
      announcementId: 'update-critical',
    })));
    expect(screen.getAllByText('Detenga la línea dos y verifique la puerta norte.').length).toBeGreaterThanOrEqual(2);
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAcknowledgement }));
    await fireEvent(screen.getByRole('switch', { name: copy.confirmAttestation }), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAcknowledgement }));
    await waitFor(() => expect(mockCommands.acknowledgeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'organization-a', versionId: 'version-critical', attestation: { confirmed: true },
    })));
    expect(screen.getByText(copy.acknowledgementRecorded)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'updates.create' }));
    await fireEvent.changeText(screen.getByLabelText('updates.fieldTitle'), 'Emergency shutdown');
    await fireEvent.changeText(screen.getByLabelText('updates.message'), 'Stop line two immediately.');
    await fireEvent.press(screen.getByRole('button', { name: 'updates.priorityEmergency' }));
    await fireEvent.press(screen.getByRole('button', { name: copy.security }));
    await fireEvent.changeText(screen.getByLabelText(copy.overrideReason), 'Immediate security isolation required.');
    await fireEvent.press(screen.getByRole('button', { name: copy.in15Minutes }));
    await fireEvent(screen.getAllByRole('switch')[0]!, 'valueChange', true);
    await fireEvent(screen.getAllByRole('switch')[1]!, 'valueChange', true);
    await fireEvent.changeText(screen.getByLabelText(copy.attestationPrompt), 'I stopped line two.');
    await fireEvent(screen.getAllByRole('switch')[2]!, 'valueChange', true);
    await fireEvent.changeText(screen.getByLabelText(copy.deadline), new Date(Date.now() + 60 * 60_000).toISOString());
    await fireEvent.changeText(screen.getByLabelText(copy.intervalMinutes), '15');
    await fireEvent.changeText(screen.getByLabelText(copy.maximumReminders), '3');
    await fireEvent.changeText(screen.getByLabelText(copy.escalateMinutes), '60');
    await fireEvent.changeText(screen.getByLabelText('updates.expiresAt'), new Date(Date.now() + 120 * 60_000).toISOString());
    await fireEvent.press(screen.getByRole('button', { name: copy.unitAudience }));
    for (const unit of ['Denver Site', 'Operations Department', 'Safety Team', 'Line Two', 'Night Shift']) {
      await fireEvent.press(screen.getByRole('button', { name: unit }));
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Operator' }));
    await fireEvent.changeText(screen.getByLabelText(copy.configuredRoles), 'safety_coordinator, forklift_operator');
    await fireEvent.press(screen.getByRole('button', { name: copy.manager }));
    await fireEvent.press(screen.getByRole('button', { name: 'ES' }));
    await fireEvent(screen.getByRole('switch', { name: copy.currentShiftOnly }), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: copy.previewAudience }));
    await waitFor(() => expect(screen.getByText('Sample Recipient')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: copy.scheduledFor }));
    await waitFor(() => expect(mockCommands.publishUpdate).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'announcement-channel',
      title: 'Emergency shutdown',
      priority: 'emergency',
      notificationClass: 'critical',
      criticalCategory: 'security',
      quietHoursOverrideReason: 'Immediate security isolation required.',
      requiresAcknowledgement: true,
      acknowledgementSchema: expect.objectContaining({ attestationRequired: true, requiredKeys: ['confirmed'] }),
      reminderPolicy: expect.objectContaining({ enabled: true, intervalSeconds: 900, maximumReminders: 3, escalateAfterSeconds: 3600 }),
      audienceSpec: {
        company: false,
        conversationMembers: false,
        siteIds: ['unit-site'],
        departmentIds: ['unit-department'],
        teamIds: ['unit-team'],
        unitIds: ['unit-line', 'unit-shift'],
        operationalRoles: ['operator', 'safety_coordinator', 'forklift_operator'],
        membershipRoles: ['manager'],
        languages: ['es'],
        currentShiftOnly: true,
      },
    })));
    expect(screen.getByText('Emergency shutdown')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: copy.cancelScheduled }));
    await fireEvent.changeText(screen.getByLabelText(copy.cancelReason), 'Publication is no longer required.');
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmCancel }));
    await waitFor(() => expect(mockCommands.cancelScheduledUpdate).toHaveBeenCalledWith(expect.objectContaining({
      announcementId: 'managed-scheduled', reason: 'Publication is no longer required.',
    })));

    await fireEvent.press(screen.getByRole('button', { name: copy.correct }));
    await fireEvent.changeText(screen.getByLabelText(copy.correctionReason), 'Clarify the exact sequence.');
    await fireEvent.press(screen.getByRole('button', { name: copy.publishCorrection }));
    await waitFor(() => expect(mockCommands.correctUpdate).toHaveBeenCalledWith(expect.objectContaining({
      announcementId: 'managed-published', reason: 'Clarify the exact sequence.',
    })));

    await fireEvent.press(screen.getByRole('button', { name: `${copy.viewNonResponders} (8)` }));
    await waitFor(() => expect(screen.getByText('Non Responder One')).toBeTruthy());
    expect(screen.getByText('Pending Recipient')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: copy.loadMore }));
    await waitFor(() => expect(screen.getByText('Unreachable Recipient')).toBeTruthy());
    expect(mockCommands.listUpdateNonAcknowledgers).toHaveBeenLastCalledWith(expect.objectContaining({
      afterUserId: 'non-responder-two',
    }));

    await view.unmount();
  });

  test('enforces recent MFA, reports command failures truthfully, and preserves empty/loading states', async () => {
    mockAuth = { assuranceLevel: 'aal1' };
    const view = await render(<UpdatesScreen />);
    await waitFor(() => expect(screen.getByText(copy.recentMfaRequired)).toBeTruthy());
    expect(mockCommands.listManagedUpdates).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'updates.create' }));
    expect(screen.getAllByText(copy.recentMfaRequired).length).toBeGreaterThan(0);
    await view.unmount();

    mockAuth = { assuranceLevel: 'aal2' };
    mockCommands.listManagedUpdates.mockRejectedValue(new RepositoryError('offline', 'network_unavailable', true));
    const failed = await render(<UpdatesScreen />);
    await waitFor(() => expect(screen.getByText(copy.networkError)).toBeTruthy());
    await failed.unmount();

    mockWorkspace = {
      ...buildWorkspace(), status: 'loading', updates: [],
    };
    mockCommands = buildCommands([]);
    const loading = await render(<UpdatesScreen />);
    expect(screen.getByText('status.loading')).toBeTruthy();
    await loading.unmount();

    mockWorkspace = {
      ...buildWorkspace(), updates: [], capabilities: [], conversations: [],
      hasCapability: jest.fn(() => false),
    };
    const empty = await render(<UpdatesScreen />);
    expect(screen.getByText('updates.empty')).toBeTruthy();
    await empty.unmount();
  });

  test('publishes immediate routine and urgent updates with exact optional-field semantics', async () => {
    const controlledSession = { access_token: 'controlled-session-token' };
    mockSupabaseClient = {
      auth: { getSession: async () => ({ data: { session: controlledSession } }) },
    };
    const view = await render(<UpdatesScreen />);
    await waitFor(() => expect(screen.getByText('Published managed update')).toBeTruthy());

    expect(mockRepositoryContext).not.toBeNull();
    await expect(mockRepositoryContext!.getSession()).resolves.toEqual(controlledSession);
    mockSupabaseClient = null;
    await expect(mockRepositoryContext!.getSession()).resolves.toBeNull();

    mockCommands.publishUpdate.mockResolvedValueOnce({
      announcementId: 'immediate-routine',
      versionId: 'immediate-routine-version',
      status: 'published',
      scheduledAt: null,
      audienceCount: 7,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'updates.create' }));
    await fireEvent.changeText(screen.getByLabelText('updates.fieldTitle'), 'Routine immediate update');
    await fireEvent.changeText(screen.getByLabelText('updates.message'), 'Routine verified operating context.');
    await fireEvent.press(screen.getByRole('button', { name: copy.channelAudience }));
    await fireEvent.press(screen.getByRole('button', { name: copy.previewAudience }));
    await waitFor(() => expect(screen.getByText('Sample Recipient')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'updates.publish' }));
    await waitFor(() => expect(mockCommands.publishUpdate).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Routine immediate update',
      priority: 'normal',
      notificationClass: 'routine',
      criticalCategory: null,
      quietHoursOverrideReason: null,
      requiresAcknowledgement: false,
      expiresAt: null,
      scheduledAt: null,
      acknowledgementSchema: expect.objectContaining({
        attestationRequired: false, attestationPrompt: null, requiredKeys: [],
      }),
      reminderPolicy: expect.objectContaining({
        enabled: false,
        deadlineAt: null,
        intervalSeconds: null,
        maximumReminders: 0,
        escalateAfterSeconds: null,
      }),
      audienceSpec: expect.objectContaining({ company: false, conversationMembers: true }),
    })));
    expect(screen.getByText('Routine immediate update')).toBeTruthy();

    mockCommands.publishUpdate.mockResolvedValueOnce({
      announcementId: 'immediate-urgent',
      versionId: 'immediate-urgent-version',
      status: 'published',
      scheduledAt: null,
      audienceCount: 7,
    });
    await fireEvent.press(screen.getByRole('button', { name: 'updates.create' }));
    await fireEvent.changeText(screen.getByLabelText('updates.fieldTitle'), 'Urgent immediate update');
    await fireEvent.changeText(screen.getByLabelText('updates.message'), 'Urgent verified operating context.');
    await fireEvent.press(screen.getByRole('button', { name: 'updates.priorityImportant' }));
    await fireEvent.press(screen.getByRole('button', { name: copy.operations }));
    await fireEvent.changeText(screen.getByLabelText(copy.overrideReason), 'Immediate operational coordination required.');
    await fireEvent.press(screen.getByRole('button', { name: copy.previewAudience }));
    await waitFor(() => expect(screen.getByText('Sample Recipient')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'updates.publish' }));
    await waitFor(() => expect(mockCommands.publishUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      title: 'Urgent immediate update',
      priority: 'important',
      notificationClass: 'urgent',
      criticalCategory: 'operations',
      quietHoursOverrideReason: 'Immediate operational coordination required.',
    })));
    expect(screen.getByText('Urgent immediate update')).toBeTruthy();

    await view.unmount();
  });

  test('covers mobile navigation, selector removal, scheduling presets, and authorization invalidation', async () => {
    mockWidth = 390;
    const base = buildWorkspace();
    const secondChannel = {
      ...(base.conversations as Record<string, unknown>[])[0],
      id: 'announcement-second',
      title: 'Second Announcements',
    };
    mockWorkspace = {
      ...base,
      people: [],
      units: (base.units as Record<string, unknown>[]).filter((unit) => unit.kind !== 'shift'),
      conversations: [...base.conversations, secondChannel],
    };
    const view = await render(<UpdatesScreen />);
    await waitFor(() => expect(screen.getByText('Published managed update')).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'updates.notificationSettings' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');
    await fireEvent.press(screen.getByRole('button', { name: 'updates.create' }));

    await fireEvent.press(screen.getByRole('button', { name: 'updates.priorityImportant' }));
    expect(screen.getByText(copy.overrideReasonPlaceholder)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'updates.priorityNormal' }));
    await fireEvent.changeText(screen.getByLabelText(copy.scheduledFor), '2020-01-01T00:00:00.000Z');
    expect(screen.getByText(copy.scheduleInvalid)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: copy.inOneHour }));
    await fireEvent.press(screen.getByRole('button', { name: copy.tomorrow }));
    await fireEvent.press(screen.getByRole('button', { name: copy.publishNow }));

    await fireEvent(screen.getAllByRole('switch')[0]!, 'valueChange', true);
    await fireEvent(screen.getAllByRole('switch')[1]!, 'valueChange', true);
    await fireEvent(screen.getAllByRole('switch')[2]!, 'valueChange', true);
    await fireEvent(screen.getAllByRole('switch')[0]!, 'valueChange', false);

    await fireEvent.press(screen.getByRole('button', { name: copy.unitAudience }));
    expect(screen.getByText(copy.unitRequired)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Denver Site' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Denver Site' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Denver Site' }));
    await fireEvent.changeText(screen.getByLabelText(copy.configuredRoles), 'x'.repeat(161));
    expect(screen.getByText(copy.configuredRolesInvalid)).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText(copy.configuredRoles), '');
    await fireEvent.press(screen.getByRole('button', { name: copy.companyAudience }));
    await fireEvent.press(screen.getByRole('button', { name: copy.channelAudience }));
    await fireEvent.press(screen.getByRole('button', { name: 'Second Announcements' }));

    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);
    await fireEvent.press(screen.getByRole('button', { name: 'updates.create' }));
    mockWorkspace = {
      ...mockWorkspace,
      conversations: [secondChannel],
    };
    await view.rerender(<UpdatesScreen />);
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Second Announcements' }).props.accessibilityState.selected,
    ).toBe(false));

    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);
    await view.unmount();
  });

  test('dismisses each workflow modal and handles non-attested acknowledgement and refresh actions', async () => {
    const base = buildWorkspace();
    mockWorkspace = {
      ...base,
      updates: [
        ...base.updates,
        companyUpdate({
          id: 'update-simple-ack',
          versionId: 'version-simple-ack',
          title: 'Simple acknowledgement',
          translatedBody: undefined,
          severity: 'important',
          acknowledgementSchema: null,
          acknowledgementRequired: true,
          acknowledged: false,
          recipientCountKnown: false,
          deadline: undefined,
          status: 'published',
        }),
        companyUpdate({
          id: 'update-draft',
          versionId: 'version-draft',
          title: 'Draft update',
          translatedBody: undefined,
          severity: 'standard',
          acknowledgementRequired: false,
          acknowledgementSchema: null,
          reminderPolicy: null,
          recipientCountKnown: true,
          status: 'draft',
        }),
      ],
    };
    const view = await render(<UpdatesScreen />);
    await waitFor(() => expect(screen.getByText('Published managed update')).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: copy.refreshPublisher }));
    await waitFor(() => expect(mockCommands.listManagedUpdates).toHaveBeenCalledTimes(2));

    const openButtons = screen.getAllByRole('button', { name: copy.openUpdate });
    await fireEvent.press(openButtons[1]!);
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);
    await fireEvent.press(openButtons[2]!);
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);

    const understandButtons = screen.getAllByRole('button', { name: 'updates.understand' });
    await fireEvent.press(understandButtons[understandButtons.length - 1]!);
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);
    await fireEvent.press(screen.getAllByRole('button', { name: 'updates.understand' }).at(-1)!);
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAcknowledgement }));
    await waitFor(() => expect(mockCommands.acknowledgeUpdate).toHaveBeenCalledWith(expect.objectContaining({
      versionId: 'version-simple-ack', attestation: {},
    })));

    await fireEvent.press(screen.getByRole('button', { name: copy.cancelScheduled }));
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);
    await fireEvent.press(screen.getByRole('button', { name: copy.correct }));
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);
    await fireEvent.press(screen.getByRole('button', { name: `${copy.viewNonResponders} (8)` }));
    await waitFor(() => expect(screen.getByText('Non Responder One')).toBeTruthy());
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);

    await view.unmount();
  });

  test('reports every secure command failure without assuming completion', async () => {
    const view = await render(<UpdatesScreen />);
    await waitFor(() => expect(screen.getByText('Published managed update')).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'updates.create' }));
    await fireEvent.changeText(screen.getByLabelText('updates.fieldTitle'), 'Failure-bound update');
    await fireEvent.changeText(screen.getByLabelText('updates.message'), 'This content must not be assumed published.');
    mockCommands.previewUpdateAudience.mockRejectedValueOnce(new Error('controlled preview rejection'));
    await fireEvent.press(screen.getByRole('button', { name: copy.previewAudience }));
    await waitFor(() => expect(screen.getByText(copy.serverRejected)).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: copy.previewAudience }));
    await waitFor(() => expect(screen.getByText('Sample Recipient')).toBeTruthy());
    mockCommands.publishUpdate.mockRejectedValueOnce(new Error('controlled publish rejection'));
    await fireEvent.press(screen.getByRole('button', { name: 'updates.publish' }));
    await waitFor(() => expect(screen.getByText(copy.serverRejected)).toBeTruthy());
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);

    mockCommands.markUpdateRead.mockRejectedValueOnce(new Error('controlled read rejection'));
    await fireEvent.press(screen.getAllByRole('button', { name: copy.openUpdate })[0]!);
    await waitFor(() => expect(screen.getByText(copy.serverRejected)).toBeTruthy());
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);

    mockCommands.acknowledgeUpdate.mockRejectedValueOnce(new Error('controlled acknowledgement rejection'));
    await fireEvent.press(screen.getAllByRole('button', { name: 'updates.understand' })[0]!);
    await fireEvent(screen.getByRole('switch', { name: copy.confirmAttestation }), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmAcknowledgement }));
    await waitFor(() => expect(screen.getByText(copy.serverRejected)).toBeTruthy());
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);

    mockCommands.cancelScheduledUpdate.mockRejectedValueOnce(new Error('controlled cancellation rejection'));
    await fireEvent.press(screen.getByRole('button', { name: copy.cancelScheduled }));
    await fireEvent.changeText(screen.getByLabelText(copy.cancelReason), 'Controlled cancellation failure.');
    await fireEvent.press(screen.getByRole('button', { name: copy.confirmCancel }));
    await waitFor(() => expect(screen.getByText(copy.serverRejected)).toBeTruthy());
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);

    mockCommands.correctUpdate.mockRejectedValueOnce(new Error('controlled correction rejection'));
    await fireEvent.press(screen.getByRole('button', { name: copy.correct }));
    await fireEvent.changeText(screen.getByLabelText(copy.correctionReason), 'Controlled correction failure.');
    await fireEvent.press(screen.getByRole('button', { name: copy.publishCorrection }));
    await waitFor(() => expect(screen.getByText(copy.serverRejected)).toBeTruthy());
    await fireEvent.press(screen.getAllByRole('button', { name: 'common.closeDialog' })[0]!);

    mockCommands.listUpdateNonAcknowledgers.mockReset();
    let rejectNonResponderRequest: ((error: unknown) => void) | null = null;
    mockCommands.listUpdateNonAcknowledgers.mockImplementationOnce(() => new Promise((_, reject) => {
      rejectNonResponderRequest = reject;
    }));
    await fireEvent.press(screen.getByRole('button', { name: `${copy.viewNonResponders} (8)` }));
    await waitFor(() => expect(mockCommands.listUpdateNonAcknowledgers).toHaveBeenCalledTimes(1));
    expect(screen.getByText(copy.nonResponderTitle)).toBeTruthy();
    expect(screen.getByLabelText(copy.previewLoading)).toBeTruthy();
    await act(async () => {
      rejectNonResponderRequest?.(new Error('controlled response-list rejection'));
    });
    await waitFor(() => expect(screen.getByText(copy.serverRejected)).toBeTruthy());
    expect(screen.queryByLabelText(copy.previewLoading)).toBeNull();

    await view.unmount();
  });
});
