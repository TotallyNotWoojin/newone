import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import AdminScreen from '@/app/admin';

jest.setTimeout(20_000);

const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockClipboard = jest.fn<(_value: string) => Promise<void>>(async () => undefined);
let mockWidth = 1280;
let mockWorkspace: Record<string, any>;
let mockAuth: Record<string, any>;

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('expo-clipboard', () => ({
  setStringAsync: (value: string) => mockClipboard(value),
}));
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
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('@/state/auth', () => ({ useAuth: () => mockAuth }));

function mockSection(name: string) {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  const MockAdminSection = () => <ReactNative.Text>{name}</ReactNative.Text>;
  MockAdminSection.displayName = `MockAdminSection(${name})`;
  return MockAdminSection;
}

jest.mock('@/features/admin/managed-conversation-section', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ManagedConversationSection: ({ onOpen }: { onOpen: (id: string) => void }) => (
      <ReactNative.Pressable accessibilityLabel="controlled-managed-open" onPress={() => onOpen('conversation-group')}>
        <ReactNative.Text>managed-conversation-section</ReactNative.Text>
      </ReactNative.Pressable>
    ),
  };
});
jest.mock('@/features/admin/organization-policy-section', () => ({ OrganizationPolicySection: mockSection('organization-policy-section') }));
jest.mock('@/features/admin/dynamic-group-section', () => ({ DynamicGroupSection: mockSection('dynamic-group-section') }));
jest.mock('@/features/admin/account-recovery-section', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AccountRecoverySection: ({
      onOpenSettings,
      onVerifyNow,
    }: {
      onOpenSettings: () => void;
      onVerifyNow: () => void;
    }) => (
      <ReactNative.View>
        <ReactNative.Text>account-recovery-section</ReactNative.Text>
        <ReactNative.Pressable accessibilityLabel="controlled-recovery-settings" onPress={onOpenSettings} />
        <ReactNative.Pressable accessibilityLabel="controlled-recovery-verify" onPress={onVerifyNow} />
      </ReactNative.View>
    ),
  };
});
jest.mock('@/features/admin/moderation-case-section', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    ModerationCaseSection: ({ onVerifyNow }: { onVerifyNow: () => void }) => (
      <ReactNative.View>
        <ReactNative.Text>moderation-case-section</ReactNative.Text>
        <ReactNative.Pressable accessibilityLabel="controlled-moderation-verify" onPress={onVerifyNow} />
      </ReactNative.View>
    ),
  };
});
jest.mock('@/features/admin/message-preservation-section', () => ({ MessagePreservationSection: mockSection('message-preservation-section') }));
jest.mock('@/features/admin/ai-quality-review-section', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AiQualityReviewSection: ({ onVerifyNow }: { onVerifyNow: () => void }) => (
      <ReactNative.View>
        <ReactNative.Text>ai-quality-review-section</ReactNative.Text>
        <ReactNative.Pressable accessibilityLabel="controlled-quality-verify" onPress={onVerifyNow} />
      </ReactNative.View>
    ),
  };
});
jest.mock('@/features/admin/audit-access-section', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AuditAccessSection: ({ onVerifyNow }: { onVerifyNow: () => void }) => (
      <ReactNative.View>
        <ReactNative.Text>audit-access-section</ReactNative.Text>
        <ReactNative.Pressable accessibilityLabel="controlled-audit-verify" onPress={onVerifyNow} />
      </ReactNative.View>
    ),
  };
});
jest.mock('@/features/admin/ai-policy-section', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AiPolicySection: ({ onSignInAgain }: { onSignInAgain: () => void }) => (
      <ReactNative.Pressable accessibilityLabel="controlled-ai-sign-in" onPress={onSignInAgain}>
        <ReactNative.Text>ai-policy-section</ReactNative.Text>
      </ReactNative.Pressable>
    ),
  };
});

const currentUser = {
  id: 'user-owner', displayName: 'Owner Person', initials: 'OP', avatarColor: '#123456',
  roleLabel: 'Owner', role: 'owner', site: 'Denver', department: 'Operations',
  preferredLanguage: 'en', presence: 'online', connectionState: 'self',
};

function person(overrides: Record<string, unknown>) {
  return {
    id: 'user-person', displayName: 'Member Person', initials: 'MP', avatarColor: '#654321',
    roleLabel: 'Operator', role: 'employee', site: 'Denver', department: 'Operations',
    preferredLanguage: 'en', presence: 'offline', connectionState: 'available', suspended: false,
    ...overrides,
  };
}

function successfulAction(value: unknown = true) {
  return jest.fn(async (..._mockArgs: unknown[]) => value);
}

function workspace(overrides: Record<string, unknown> = {}) {
  const capabilities = [
    'audit.read', 'invites.manage', 'roles.read', 'roles.manage', 'members.security',
    'ai.policy.manage', 'unit.manage', 'recovery.manage', 'reports.investigate',
    'reports.assign', 'message.preservation.manage', 'language.review',
  ];
  return {
    actionBusy: null,
    actionError: null,
    capabilities,
    connectivity: 'online',
    conversations: [
      { id: 'conversation-group', kind: 'group', managementOnly: false, unreadCount: 0 },
      { id: 'conversation-direct', kind: 'direct', managementOnly: false, unreadCount: 0 },
    ],
    currentMembershipRole: 'owner',
    currentUser,
    failedOutboxCount: 0,
    offlineQueueAvailable: true,
    organizationId: 'organization-a',
    organizationName: 'Newone Operations',
    outboxCount: 0,
    people: [
      currentUser,
      person({ id: 'user-active', displayName: 'Active Member' }),
      person({ id: 'user-suspended', displayName: 'Suspended Member', suspended: true }),
    ],
    realtimeState: 'subscribed',
    roleAssignmentsPersonId: 'user-active',
    roleAssignments: [{
      assignmentId: 'assignment-active', userId: 'user-active', roleName: 'site_admin',
      scopeType: 'unit', unitId: 'unit-existing', grantedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: '2030-08-01T00:00:00.000Z', revokedAt: null, active: true,
    }, {
      assignmentId: 'assignment-revoked', userId: 'user-active', roleName: 'employee',
      scopeType: 'organization', unitId: null, grantedAt: '2026-08-01T00:00:00.000Z',
      expiresAt: null, revokedAt: '2026-08-02T00:00:00.000Z', active: false,
    }],
    status: 'ready',
    updates: [{ acknowledgementRequired: true, acknowledged: false }],
    clearActionError: jest.fn(),
    hasCapability: jest.fn((capability: string) => capabilities.includes(capability)),
    selectConversation: jest.fn(),
    loadRoleAssignments: successfulAction(),
    assignRole: successfulAction(),
    revokeRole: successfulAction(),
    suspendMember: successfulAction(),
    queryGroupCreationCandidates: jest.fn(async () => [
      {
        userId: 'sponsor-manager', displayName: 'Sponsor Manager', avatarPath: null,
        jobTitle: 'Manager', membershipRole: 'manager', membershipType: 'employee', accessExpiresAt: null,
      },
      {
        userId: 'guest-excluded', displayName: 'Guest Excluded', avatarPath: null,
        jobTitle: null, membershipRole: 'member', membershipType: 'guest',
        accessExpiresAt: '2030-01-01T00:00:00.000Z',
      },
    ]),
    issueInvitation: successfulAction({
      inviteId: 'invite-a', destinationType: 'phone', destinationMasked: '+1•••0100',
      role: 'member', activationMode: 'manual', expiresAt: '2030-08-10T10:00:00.000Z',
      activationToken: 'one-time-activation-token', employeeCode: 'EMP-42', membershipType: 'guest',
      membershipAccessExpiresAt: '2030-09-01T00:00:00.000Z', guestSponsorUserId: 'sponsor-manager',
    }),
    ...overrides,
  };
}

beforeEach(() => {
  mockWidth = 1280;
  mockWorkspace = workspace();
  mockAuth = {
    assuranceLevel: 'aal2', session: { access_token: 'controlled-access-token' }, signOut: successfulAction(),
  };
});

describe('admin authorization and lifecycle screen', () => {
  test('executes member security, scoped roles, guest invitation, copy scrubbing, and managed routing', async () => {
    const view = await render(<AdminScreen />);
    expect(screen.getByText('admin.aal2Detected')).toBeTruthy();
    for (const section of [
      'organization-policy-section', 'ai-policy-section', 'dynamic-group-section',
      'account-recovery-section', 'moderation-case-section', 'message-preservation-section',
      'ai-quality-review-section', 'audit-access-section',
    ]) expect(screen.getByText(section)).toBeTruthy();

    for (const label of [
      'controlled-recovery-settings',
      'controlled-recovery-verify',
      'controlled-moderation-verify',
      'controlled-quality-verify',
      'controlled-audit-verify',
    ]) await fireEvent.press(screen.getByLabelText(label));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');

    await fireEvent.press(screen.getByLabelText('controlled-managed-open'));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-group');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]', params: { id: 'conversation-group' },
    });

    await fireEvent.press(screen.getByRole('button', { name: 'admin.suspend' }));
    await fireEvent.changeText(screen.getByLabelText('admin.reason'), 'Repeated security violations.');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.suspendMember' }));
    expect(mockWorkspace.suspendMember).toHaveBeenCalledWith('user-active', 'Repeated security violations.');

    await fireEvent.press(screen.getAllByRole('button', { name: 'admin.manageRoles' })[0]!);
    expect(mockWorkspace.loadRoleAssignments).toHaveBeenCalledWith('user-active');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.roleSecurityAdmin' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.scopeUnit' }));
    await fireEvent.changeText(screen.getByLabelText('admin.unitId'), 'unit-denver');
    await fireEvent.changeText(screen.getByLabelText('admin.expiresAt'), '2035-08-04T00:00:00.000Z');
    await fireEvent.changeText(screen.getByLabelText('admin.auditReason'), 'Emergency security delegation.');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.assignRole' }));
    expect(mockWorkspace.assignRole).toHaveBeenCalledWith('user-active', {
      roleName: 'security_admin', scopeType: 'unit', unitId: 'unit-denver',
      expiresAt: '2035-08-04T00:00:00.000Z', reason: 'Emergency security delegation.',
    });

    await fireEvent.press(screen.getByRole('button', { name: 'admin.revokeRole' }));
    const auditReasons = screen.getAllByLabelText('admin.auditReason');
    await fireEvent.changeText(auditReasons[auditReasons.length - 1]!, 'Access no longer required.');
    const revokeButtons = screen.getAllByRole('button', { name: 'admin.revokeRole' });
    await fireEvent.press(revokeButtons[revokeButtons.length - 1]!);
    expect(mockWorkspace.revokeRole).toHaveBeenCalledWith('assignment-active', 'Access no longer required.');
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);

    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMember' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMembershipGuest' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sponsor Manager' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Guest Excluded' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.invitePhoneChannel' }));
    await fireEvent.changeText(screen.getByLabelText('admin.invitePhone'), '+1 (555) 555-0100');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteActivationManual' }));
    await fireEvent.changeText(screen.getByLabelText('admin.inviteEmployeeCode'), ' EMP-42 ');
    await fireEvent.press(screen.getByRole('button', { name: 'Sponsor Manager' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.createInvite' }));
    await waitFor(() => expect(mockWorkspace.issueInvitation).toHaveBeenCalledWith(expect.objectContaining({
      destinationType: 'phone', destination: '+15555550100', activationMode: 'manual',
      employeeCode: ' EMP-42 ', role: 'member', expiresInSeconds: 604800,
      membershipType: 'guest', guestSponsorUserId: 'sponsor-manager',
      membershipAccessExpiresAt: expect.any(String),
    })));
    expect(screen.getByText('one-time-activation-token')).toBeTruthy();
    expect(screen.getByText(/Sponsor Manager/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteCopy' }));
    expect(mockClipboard).toHaveBeenCalledWith('one-time-activation-token');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteDone' }));
    expect(mockClipboard).toHaveBeenLastCalledWith('');

    await fireEvent.press(screen.getByLabelText('controlled-ai-sign-in'));
    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalled());
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');
    await view.unmount();
  });

  test('fails closed without an admin capability and routes recent-MFA verification when locked', async () => {
    mockWorkspace = workspace({ capabilities: [], hasCapability: jest.fn(() => false) });
    const denied = await render(<AdminScreen />);
    expect(screen.getByText('admin.required')).toBeTruthy();
    expect(screen.queryByText('Active Member')).toBeNull();
    await denied.unmount();

    mockAuth = { ...mockAuth, assuranceLevel: 'aal1' };
    mockWorkspace = workspace();
    const locked = await render(<AdminScreen />);
    expect(screen.getByText('admin.aal2Required')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.verifyNow' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMember' }));
    expect(screen.queryByText('admin.inviteTitle')).toBeNull();
    await locked.unmount();
  });

  test('keeps privileged actions fail-closed and supports cancellation and alternate form controls', async () => {
    mockWidth = 390;
    const suspendMember = successfulAction(false);
    const assignRole = successfulAction(false);
    const revokeRole = successfulAction(false);
    const issueInvitation = successfulAction(null);
    mockWorkspace = workspace({
      suspendMember,
      assignRole,
      revokeRole,
      issueInvitation,
      queryGroupCreationCandidates: jest.fn(async () => undefined),
    });
    mockAuth = { ...mockAuth, session: null };

    const view = await render(<AdminScreen />);
    expect(screen.queryByText('admin.heading')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'admin.suspend' }));
    await fireEvent.changeText(screen.getByLabelText('admin.reason'), 'Keep account under review.');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.suspendMember' }));
    await waitFor(() => expect(suspendMember).toHaveBeenCalledWith('user-active', 'Keep account under review.'));
    expect(screen.getByRole('header', { name: 'admin.suspendTitle Active Member' })).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);

    await fireEvent.press(screen.getAllByRole('button', { name: 'admin.manageRoles' })[0]!);
    await fireEvent.press(screen.getByRole('button', { name: 'admin.scopeUnit' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.scopeOrganization' }));
    await fireEvent.changeText(screen.getByLabelText('admin.auditReason'), 'Controlled role decision.');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.assignRole' }));
    await waitFor(() => expect(assignRole).toHaveBeenCalledWith('user-active', {
      roleName: 'employee',
      scopeType: 'organization',
      unitId: null,
      expiresAt: null,
      reason: 'Controlled role decision.',
    }));

    await fireEvent.press(screen.getByRole('button', { name: 'admin.revokeRole' }));
    const revokeReasons = screen.getAllByLabelText('admin.auditReason');
    await fireEvent.changeText(revokeReasons[revokeReasons.length - 1]!, 'Controlled revocation decision.');
    const revokeActions = screen.getAllByRole('button', { name: 'admin.revokeRole' });
    await fireEvent.press(revokeActions[revokeActions.length - 1]!);
    await waitFor(() => expect(revokeRole).toHaveBeenCalledWith(
      'assignment-active',
      'Controlled revocation decision.',
    ));
    const revokeCloseButtons = screen.getAllByLabelText('common.closeDialog');
    await fireEvent.press(revokeCloseButtons[revokeCloseButtons.length - 1]!);
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);

    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMember' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMembershipContractor' }));
    expect(screen.getByText('admin.inviteContractorDisclosure')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteAccess30Days' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteExpiryMonth' }));
    expect(screen.getByText('admin.inviteAccessAfterInvite')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteAccess365Days' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteRoleManager' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteRoleAdmin' }));
    expect(screen.getByText('admin.inviteAdminOwnerOnly')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteRoleMember' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.invitePhoneChannel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteEmailChannel' }));
    await fireEvent.changeText(screen.getByLabelText('admin.inviteEmail'), ' PERSON@EXAMPLE.COM ');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteActivationManual' }));
    await fireEvent.changeText(screen.getByLabelText('admin.inviteEmployeeCode'), 'EMP-900');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteActivationOtp' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMembershipEmployee' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteExpiryHour' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.createInvite' }));
    await waitFor(() => expect(issueInvitation).toHaveBeenCalledWith({
      destinationType: 'email',
      destination: 'person@example.com',
      activationMode: 'otp',
      employeeCode: null,
      role: 'member',
      expiresInSeconds: 3600,
      membershipType: 'employee',
      membershipAccessExpiresAt: null,
      guestSponsorUserId: null,
    }));
    expect(screen.getByRole('header', { name: 'admin.inviteTitle' })).toBeTruthy();
    const inviteCloseButtons = screen.getAllByLabelText('common.closeDialog');
    await fireEvent.press(inviteCloseButtons[inviteCloseButtons.length - 1]!);
    await view.unmount();
  });

  test('uses server capability scope for mobile section visibility and assign-only report access', async () => {
    mockWidth = 390;
    const capabilities = ['reports.assign'];
    mockWorkspace = workspace({
      capabilities,
      currentMembershipRole: 'manager',
      hasCapability: jest.fn((capability: string) => capabilities.includes(capability)),
    });
    mockAuth = { ...mockAuth, session: null };

    const assignOnly = await render(<AdminScreen />);
    expect(screen.getByText('moderation-case-section')).toBeTruthy();
    for (const absent of [
      'organization-policy-section',
      'ai-policy-section',
      'dynamic-group-section',
      'account-recovery-section',
      'message-preservation-section',
      'ai-quality-review-section',
      'audit-access-section',
    ]) expect(screen.queryByText(absent)).toBeNull();
    await assignOnly.unmount();

    const auditCapabilities = ['audit.read'];
    mockWorkspace = workspace({
      capabilities: auditCapabilities,
      currentMembershipRole: 'manager',
      hasCapability: jest.fn((capability: string) => auditCapabilities.includes(capability)),
    });
    const auditOnly = await render(<AdminScreen />);
    expect(screen.getByText('audit-access-section')).toBeTruthy();
    expect(screen.queryByText('moderation-case-section')).toBeNull();
    await auditOnly.unmount();
  });

  test('renders role loading and each authoritative invitation receipt without inventing delivery state', async () => {
    let nextInvitation: any = {
      inviteId: 'invite-employee',
      destinationType: 'email',
      destinationMasked: 'p•••@example.com',
      role: 'member',
      activationMode: 'otp',
      expiresAt: '2030-08-10T10:00:00.000Z',
      activationToken: null,
      employeeCode: null,
      membershipType: 'employee',
      membershipAccessExpiresAt: null,
      guestSponsorUserId: null,
    };
    const issueInvitation = jest.fn(async () => nextInvitation);
    mockWorkspace = workspace({ issueInvitation, actionBusy: 'roles-load' });

    const view = await render(<AdminScreen />);
    await fireEvent.press(screen.getAllByRole('button', { name: 'admin.manageRoles' })[0]!);
    expect(screen.getByText('status.loading')).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);

    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMember' }));
    await fireEvent.changeText(screen.getByLabelText('admin.inviteEmail'), 'person@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.createInvite' }));
    await waitFor(() => expect(screen.getByText('admin.inviteOtpDeliveryReceipt')).toBeTruthy());
    expect(screen.getByText('admin.inviteMembershipType · admin.inviteMembershipEmployee')).toBeTruthy();
    expect(screen.queryByText(/admin\.inviteAccessExpiry ·/)).toBeNull();
    expect(screen.queryByText(/admin\.inviteSponsor ·/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteDone' }));

    nextInvitation = {
      ...nextInvitation,
      inviteId: 'invite-contractor',
      destinationMasked: 'c•••@example.com',
      activationMode: 'manual',
      membershipType: 'contractor',
      membershipAccessExpiresAt: '2031-08-10T10:00:00.000Z',
    };
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMember' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMembershipContractor' }));
    await fireEvent.changeText(screen.getByLabelText('admin.inviteEmail'), 'contractor@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteActivationManual' }));
    await fireEvent.changeText(screen.getByLabelText('admin.inviteEmployeeCode'), 'CONTRACT-42');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.createInvite' }));
    await waitFor(() => expect(screen.getByText('admin.inviteUnavailable')).toBeTruthy());
    expect(screen.getByText('admin.inviteMembershipType · admin.inviteMembershipContractor')).toBeTruthy();
    expect(screen.getByText('admin.inviteAccessExpiry · 2031-08-10T10:00:00.000Z')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteDone' }));

    nextInvitation = {
      ...nextInvitation,
      inviteId: 'invite-guest',
      destinationMasked: 'g•••@example.com',
      activationMode: 'otp',
      activationToken: 'server-issued-guest-token',
      membershipType: 'guest',
      guestSponsorUserId: 'server-authoritative-sponsor',
    };
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMember' }));
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteMembershipGuest' }));
    await fireEvent.changeText(screen.getByLabelText('admin.inviteEmail'), 'guest@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'admin.createInvite' }));
    await waitFor(() => expect(screen.getByText('server-issued-guest-token')).toBeTruthy());
    expect(screen.getByText('admin.inviteSponsor · server-authoritative-sponsor')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'admin.inviteDone' }));
    await view.unmount();
  });

  test('shows authoritative workspace state until the current user exists', async () => {
    mockWorkspace = workspace({ currentUser: null, people: [], status: 'loading' });
    const view = await render(<AdminScreen />);
    expect(screen.getByText('status.loading')).toBeTruthy();
    await view.unmount();
  });
});
