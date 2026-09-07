import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import HandoffsScreen from '@/app/handoffs';
import NewGroupScreen from '@/app/new-group';
import PeopleScreen from '@/app/people';
import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';

jest.setTimeout(20_000);

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};
const mockRequestMediaPermission = jest.fn(async () => ({ granted: true }));
const mockLaunchImageLibrary = jest.fn<(_options?: unknown) => Promise<{
  canceled: boolean;
  assets: {
    uri: string;
    fileName: string;
    mimeType: string;
    fileSize: number;
    width: number;
    height: number;
  }[];
}>>(async () => ({
  canceled: false,
  assets: [{
    uri: 'file://controlled-group-avatar.jpg',
    fileName: 'controlled-group-avatar.jpg',
    mimeType: 'image/jpeg',
    fileSize: 4096,
    width: 800,
    height: 800,
  }],
}));

let mockWidth = 1280;
let mockWorkspace: Record<string, any>;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: () => mockRequestMediaPermission(),
  launchImageLibraryAsync: (options?: unknown) => mockLaunchImageLibrary(options),
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

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

const self = {
  id: 'user-self',
  membershipId: 'membership-self',
  displayName: 'Jordan Lee',
  initials: 'JL',
  avatarColor: '#123456',
  roleLabel: 'Supervisor',
  role: 'manager',
  site: 'Denver',
  department: 'Operations',
  preferredLanguage: 'en',
  presence: 'online',
  connectionState: 'self',
};

function person(overrides: Record<string, unknown>) {
  return {
    id: 'user-person',
    membershipId: 'membership-person',
    displayName: 'Taylor Person',
    initials: 'TP',
    avatarColor: '#654321',
    roleLabel: 'Technician',
    role: 'employee',
    site: 'Denver',
    department: 'Maintenance',
    preferredLanguage: 'en',
    presence: 'offline',
    connectionState: 'available',
    ...overrides,
  };
}

function successfulAction(value: unknown = true) {
  return jest.fn(async (..._mockArgs: unknown[]) => value);
}

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    actionBusy: null,
    actionError: null,
    capabilities: [],
    connectivity: 'online',
    conversations: [],
    currentUser: self,
    failedOutboxCount: 0,
    handoffs: [],
    messages: {},
    offlineQueueAvailable: true,
    outboxCount: 0,
    people: [self],
    realtimeState: 'subscribed',
    status: 'ready',
    units: [],
    updates: [],
    clearActionError: jest.fn(),
    hasCapability: jest.fn(() => false),
    refresh: successfulAction(),
    ...overrides,
  };
}

beforeEach(() => {
  mockWidth = 1280;
  mockRequestMediaPermission.mockResolvedValue({ granted: true });
  mockLaunchImageLibrary.mockResolvedValue({
    canceled: false,
    assets: [{
      uri: 'file://controlled-group-avatar.jpg',
      fileName: 'controlled-group-avatar.jpg',
      mimeType: 'image/jpeg',
      fileSize: 4096,
      width: 800,
      height: 800,
    }],
  });
});

describe('people workflow screen', () => {
  test('executes real directory, connection, contact, block, and private-report UI flows', async () => {
    const connected = person({
      id: 'user-connected', membershipId: 'membership-connected', displayName: 'Ana Connected',
      connectionState: 'connected', savedContact: true, favoriteContact: true,
      contactAlias: 'Line lead', preferredLanguage: 'es', presence: 'online',
    });
    const incoming = person({
      id: 'user-incoming', displayName: 'Ian Incoming', connectionState: 'pending',
      connectionRequestDirection: 'incoming', preferredLanguage: 'ko', presence: 'away', site: 'Austin',
    });
    const outgoing = person({
      id: 'user-outgoing', displayName: 'Olivia Outgoing', connectionState: 'pending',
      connectionRequestDirection: 'outgoing', site: 'Austin',
    });
    const available = person({ id: 'user-available', displayName: 'Avery Available' });
    const blocked = person({ id: 'user-blocked', displayName: 'Bailey Blocked', blockedByMe: true });
    mockWorkspace = baseWorkspace({
      people: [self, connected, incoming, outgoing, available, blocked],
      openOrCreateDirectConversation: successfulAction('conversation-direct'),
      updateConnection: successfulAction(),
      respondConnection: successfulAction(),
      removeConnection: successfulAction(),
      saveContact: successfulAction(),
      removeSavedContact: successfulAction(),
      setPersonBlocked: successfulAction(),
      reportMember: successfulAction(),
    });

    const view = await render(<PeopleScreen />);

    await fireEvent.changeText(screen.getByLabelText('people.search'), 'not present');
    expect(screen.getByText('status.emptyPeople')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('common.clearSearch'));
    await fireEvent.press(screen.getByRole('button', { name: 'people.online' }));
    expect(screen.getByText('Ana Connected')).toBeTruthy();
    expect(screen.queryByText('Avery Available')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'people.connections' }));
    await fireEvent.press(screen.getByRole('button', { name: 'people.mySite' }));
    await fireEvent.press(screen.getByRole('button', { name: 'people.pending' }));
    await fireEvent.press(screen.getByRole('button', { name: 'people.everyone' }));

    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    await waitFor(() => expect(mockWorkspace.openOrCreateDirectConversation).toHaveBeenCalledWith('user-connected'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');

    await fireEvent.press(screen.getByRole('button', { name: 'people.accept' }));
    // Decline asks first: Keep leaves the request alone, a second deliberate tap declines.
    await fireEvent.press(screen.getByRole('button', { name: 'people.decline' }));
    expect(screen.getByText('people.declineConfirmTitle')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'people.keepRequest' }));
    expect(mockWorkspace.respondConnection).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('people.declineConfirmTitle')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'people.decline' }));
    await fireEvent.press(screen.getByRole('button', { name: 'people.declineConfirm' }));
    expect(mockWorkspace.respondConnection).toHaveBeenNthCalledWith(1, 'user-incoming', 'accepted');
    expect(mockWorkspace.respondConnection).toHaveBeenNthCalledWith(2, 'user-incoming', 'declined');
    await fireEvent.press(screen.getByRole('button', { name: 'people.cancelRequest' }));
    await fireEvent.press(screen.getByRole('button', { name: 'people.connect' }));
    expect(mockWorkspace.removeConnection).toHaveBeenCalledWith('user-outgoing');
    expect(mockWorkspace.updateConnection).toHaveBeenCalledWith('user-available');

    await fireEvent.press(screen.getAllByRole('button', { name: 'people.manage' })[0]!);
    expect(screen.getByText('people.manageTitle · Ana Connected')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('people.alias'), '  New alias  ');
    await fireEvent.press(screen.getByRole('button', { name: 'people.favoriteContact' }));
    await fireEvent.press(screen.getByRole('button', { name: 'people.saveContact' }));
    expect(mockWorkspace.saveContact).toHaveBeenCalledWith('user-connected', '  New alias  ', false);
    await fireEvent.press(screen.getByRole('button', { name: 'people.removeSaved' }));
    await fireEvent.press(screen.getByRole('button', { name: 'people.block' }));
    expect(mockWorkspace.removeSavedContact).toHaveBeenCalledWith('user-connected');
    expect(mockWorkspace.setPersonBlocked).toHaveBeenCalledWith('user-connected', true);

    await fireEvent.press(screen.getByRole('button', { name: 'chat.reportThreat' }));
    await fireEvent.changeText(screen.getByLabelText('chat.reportDetails'), 'Repeated threats in the shift channel.');
    const consent = screen.getByRole('checkbox');
    expect(consent.props.accessibilityState).toEqual({ checked: false });
    await fireEvent.press(consent);
    await fireEvent.press(screen.getByRole('button', { name: 'chat.submitReport' }));
    await waitFor(() => expect(mockWorkspace.reportMember).toHaveBeenCalledWith(
      'membership-connected',
      'threat',
      'Repeated threats in the shift channel.',
      { consentToShare: true, noticeVersion: 'moderation-report-v2' },
    ));
    expect(screen.queryByText('people.manageTitle · Ana Connected')).toBeNull();

    await view.unmount();
  });

  test('uses mobile direct-message routing and exposes fail-closed workspace states', async () => {
    mockWidth = 390;
    const connected = person({ id: 'mobile-user', displayName: 'Mobile Person', connectionState: 'connected' });
    mockWorkspace = baseWorkspace({
      people: [self, connected],
      openOrCreateDirectConversation: successfulAction('mobile-conversation'),
      removeConnection: successfulAction(),
    });
    const view = await render(<PeopleScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'mobile-conversation' },
    });
    await view.unmount();

    mockWorkspace = baseWorkspace({ status: 'loading', people: [self] });
    const stateView = await render(<PeopleScreen />);
    expect(screen.getByText('status.loading')).toBeTruthy();
    mockWorkspace = baseWorkspace({ status: 'error', error: 'Authoritative directory failed.', people: [self] });
    await stateView.rerender(<PeopleScreen />);
    expect(screen.getByText('Authoritative directory failed.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'status.retry' }));
    expect(mockWorkspace.refresh).toHaveBeenCalledTimes(1);
    await stateView.unmount();
  });

  test('fails closed on missing conversations and unsuccessful contact/report actions', async () => {
    const saved = person({
      id: 'user-saved', displayName: 'Saved Person', connectionState: 'connected',
      savedContact: true, favoriteContact: false, contactAlias: undefined,
    });
    const blocked = person({
      id: 'user-blocked-managed', displayName: 'Blocked Managed', blockedByMe: true,
    });
    mockWorkspace = baseWorkspace({
      currentUser: null,
      people: [self, saved, blocked],
      openOrCreateDirectConversation: successfulAction(null),
      removeConnection: successfulAction(),
      saveContact: successfulAction(false),
      setPersonBlocked: successfulAction(),
      reportMember: successfulAction(false),
    });
    const view = await render(<PeopleScreen />);
    expect(screen.getByText('people.saved')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'people.mySite' }));
    expect(screen.getByText('status.emptyPeople')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'people.everyone' }));

    await fireEvent.press(screen.getByRole('button', { name: 'people.message' }));
    expect(mockRouter.push).not.toHaveBeenCalledWith(expect.objectContaining({
      pathname: '/conversation/[id]',
    }));

    const manageButtons = screen.getAllByRole('button', { name: 'people.manage' });
    await fireEvent.press(manageButtons[0]!);
    expect(screen.getByLabelText('people.alias').props.value).toBe('');
    await fireEvent.press(screen.getByRole('button', { name: 'people.saveContact' }));
    expect(mockWorkspace.saveContact).toHaveBeenCalledWith('user-saved', '', false);
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);

    await fireEvent.press(screen.getAllByRole('button', { name: 'people.manage' })[1]!);
    await fireEvent.press(screen.getByRole('button', { name: 'people.unblock' }));
    expect(mockWorkspace.setPersonBlocked).toHaveBeenCalledWith('user-blocked-managed', false);
    const consent = screen.getByRole('checkbox');
    await fireEvent(consent, 'pressIn');
    await fireEvent.press(consent);
    await fireEvent.press(screen.getByRole('button', { name: 'chat.submitReport' }));
    expect(mockWorkspace.reportMember).toHaveBeenCalled();
    expect(screen.getByText('people.manageTitle · Blocked Managed')).toBeTruthy();
    await view.unmount();
  });
});

function groupCandidate(overrides: Record<string, unknown>) {
  return {
    userId: 'membership-candidate',
    displayName: 'Employee Candidate',
    avatarPath: null,
    jobTitle: 'Operator',
    membershipRole: 'member',
    membershipType: 'employee',
    accessExpiresAt: null,
    ...overrides,
  };
}

describe('group creation workflow screen', () => {
  test('creates an incident with exact roles and recovers a real avatar upload failure', async () => {
    const candidates = [
      groupCandidate({ userId: 'membership-employee', displayName: 'Employee Candidate', username: 'employee_c' }),
      groupCandidate({
        userId: 'membership-guest', displayName: 'Guest Candidate', membershipType: 'guest',
        accessExpiresAt: '2026-08-30T12:00:00.000Z',
      }),
      groupCandidate({
        userId: 'membership-contractor', displayName: 'Contractor Candidate', membershipType: 'contractor',
      }),
    ];
    const createGroupConversation = successfulAction('conversation-created');
    const uploadConversationAvatar = jest.fn<(..._args: unknown[]) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    mockWorkspace = baseWorkspace({
      units: [{ unitId: 'unit-operations', name: 'Operations' }],
      queryGroupCreationCandidates: jest.fn(async (search: string) => (
        search ? candidates.filter((candidate) => candidate.displayName.toLowerCase().includes(search.toLowerCase())) : candidates
      )),
      createGroupConversation,
      uploadConversationAvatar,
    });

    const view = await render(<NewGroupScreen />);
    await waitFor(() => expect(screen.getByText('Employee Candidate')).toBeTruthy());
    // v3.1: the picker row carries the @handle next to the job title.
    expect(screen.getByText('Operator · @employee_c')).toBeTruthy();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Employee Candidate' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.admin' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Guest Candidate' }));
    expect(screen.getByText('group.guestDisclosure')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('group.name'), 'Incident Alpha');
    await fireEvent.changeText(screen.getByLabelText('group.description'), 'Live production incident coordination.');
    await fireEvent.press(screen.getByRole('button', { name: 'group.incident' }));
    expect(screen.getByText('group.joinLockedDisclosure')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'group.incidentSeverityCritical' }));
    await fireEvent.changeText(screen.getByLabelText('group.incidentClassification'), 'SEV-1 / production');
    await fireEvent.press(screen.getByRole('button', { name: 'Operations' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.postingAdminsOnly' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.historyAll' }));

    await fireEvent.press(screen.getByRole('button', { name: 'group.chooseAvatar' }));
    expect(screen.getByLabelText('group.avatarSelected')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(createGroupConversation).toHaveBeenCalledWith({
      name: 'Incident Alpha',
      description: 'Live production incident coordination.',
      kind: 'incident',
      unitId: 'unit-operations',
      historyPolicy: 'all',
      postingMode: 'admins_only',
      joinPolicy: 'invite_only',
      incidentSeverity: 'critical',
      incidentClassification: 'SEV-1 / production',
      members: [
        { membershipId: 'membership-employee', role: 'admin' },
        { membershipId: 'membership-guest', role: 'member' },
      ],
    }));
    expect(screen.getByText('group.avatarUploadFailed')).toBeTruthy();

    const retryButtons = screen.getAllByRole('button', { name: 'group.retryAvatarUpload' });
    await fireEvent.press(retryButtons[retryButtons.length - 1]!);
    await waitFor(() => expect(uploadConversationAvatar).toHaveBeenCalledTimes(2));
    expect(createGroupConversation).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'group.continueWithoutAvatar' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await view.unmount();
  });

  test('handles denied and empty avatar picks, filtering, removal, cancellation, and mobile completion', async () => {
    mockWidth = 390;
    const candidate = groupCandidate({ userId: 'membership-one', displayName: 'One Candidate' });
    mockWorkspace = baseWorkspace({
      queryGroupCreationCandidates: jest.fn(async () => [candidate]),
      createGroupConversation: successfulAction('conversation-mobile'),
      uploadConversationAvatar: successfulAction(),
    });
    const view = await render(<NewGroupScreen />);
    await waitFor(() => expect(screen.getByText('One Candidate')).toBeTruthy());

    mockRequestMediaPermission.mockResolvedValueOnce({ granted: false });
    await fireEvent.press(screen.getByRole('button', { name: 'group.chooseAvatar' }));
    expect(mockLaunchImageLibrary).not.toHaveBeenCalled();
    mockLaunchImageLibrary.mockResolvedValueOnce({ canceled: true, assets: [] });
    await fireEvent.press(screen.getByRole('button', { name: 'group.chooseAvatar' }));
    expect(screen.queryByLabelText('group.avatarSelected')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'group.chooseAvatar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.changeAvatar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.removeAvatar' }));
    expect(screen.queryByLabelText('group.avatarSelected')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('group.search'), 'none');
    await waitFor(() => expect(mockWorkspace.queryGroupCreationCandidates).toHaveBeenCalledWith('none'));
    await fireEvent.changeText(screen.getByLabelText('group.search'), '');
    await waitFor(() => expect(screen.getByText('One Candidate')).toBeTruthy());
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson One Candidate' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.member' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.owner' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.organizationWide' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.postingAllMembers' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.joinInviteOnly' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.joinApproval' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.joinInherit' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.historySinceJoin' }));
    await fireEvent.changeText(screen.getByLabelText('group.name'), 'Mobile Group');
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-mobile' },
    }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.cancel' }));
    expect(mockRouter.replace).toHaveBeenLastCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-mobile' },
    });
    await view.unmount();

    mockWorkspace = baseWorkspace({
      queryGroupCreationCandidates: jest.fn(async () => []),
      createGroupConversation: successfulAction(null),
    });
    const cancelView = await render(<NewGroupScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'group.cancel' }));
    expect(mockRouter.back).toHaveBeenCalled();
    await cancelView.unmount();
  });

  test('handles empty candidate responses, deselection, asset fallbacks, and creation retry', async () => {
    const candidate = groupCandidate({ userId: 'membership-retry', displayName: 'Retry Candidate' });
    const queryCandidates = jest.fn<(..._args: unknown[]) => Promise<any>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue([candidate]);
    const createGroupConversation = jest.fn<(..._args: unknown[]) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('conversation-retry');
    const uploadConversationAvatar = successfulAction(true);
    mockLaunchImageLibrary.mockResolvedValueOnce({
      canceled: false,
      assets: [{
        uri: 'file://controlled-fallback-avatar',
        fileName: null,
        mimeType: null,
        fileSize: 2048,
        width: 400,
        height: 400,
      }],
    } as any);
    mockWorkspace = baseWorkspace({
      queryGroupCreationCandidates: queryCandidates,
      createGroupConversation,
      uploadConversationAvatar,
    });

    const view = await render(<NewGroupScreen />);
    await waitFor(() => expect(screen.getByText('group.noCandidates')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('group.search'), 'retry');
    await waitFor(() => expect(screen.getByText('Retry Candidate')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'group.team' }));
    const candidateToggle = () => screen.getByRole('checkbox', {
      name: /Retry Candidate/,
    });
    await fireEvent.press(candidateToggle());
    await fireEvent.press(candidateToggle());
    await fireEvent.press(candidateToggle());
    await fireEvent.changeText(screen.getByLabelText('group.name'), 'Retry Team');
    await fireEvent.press(screen.getByRole('button', { name: 'group.chooseAvatar' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(createGroupConversation).toHaveBeenCalledTimes(1));
    expect(mockRouter.replace).not.toHaveBeenCalledWith('/');
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(uploadConversationAvatar).toHaveBeenCalledWith(
      'conversation-retry',
      expect.objectContaining({ name: expect.stringMatching(/^group-\d+\.jpg$/), mimeType: 'image/jpeg' }),
    ));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await view.unmount();
  });

  test('lets a consumer add anyone: known people first, then people search, with consumer-only controls', async () => {
    const createGroupConversation = successfulAction('conversation-personal');
    const searchUsers = jest.fn(async (..._mockArgs: unknown[]) => [
      {
        userId: 'user-stranger', username: 'sam_stranger', displayName: 'Sam Stranger',
        avatarPath: null, connectionState: 'none',
      },
      {
        userId: 'user-friend', username: 'ana_friend', displayName: 'Ana Friend',
        avatarPath: null, connectionState: 'accepted',
      },
    ] as unknown[]);
    const queryGroupCreationCandidates = jest.fn(async (..._mockArgs: unknown[]) => [] as unknown[]);
    mockWorkspace = baseWorkspace({
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      people: [
        self,
        person({ id: 'user-friend', displayName: 'Ana Friend', username: 'ana_friend', connectionState: 'connected' }),
        person({
          id: 'user-pending', displayName: 'Pat Pending', username: 'pat_pending',
          connectionState: 'pending', connectionRequestDirection: 'incoming',
        }),
        person({ id: 'user-blocked', displayName: 'Bailey Blocked', blockedByMe: true }),
      ],
      queryGroupCreationCandidates,
      searchUsers,
      createGroupConversation,
    });

    await render(<NewGroupScreen />);
    // The people this account already knows fill the empty picker, whatever
    // their connection state (blocked people excepted); the workplace
    // candidate directory is never consulted.
    await waitFor(() => expect(screen.getByText('Ana Friend')).toBeTruthy());
    expect(screen.getByText('@ana_friend')).toBeTruthy();
    expect(screen.getByText('Pat Pending')).toBeTruthy();
    expect(screen.queryByText('Bailey Blocked')).toBeNull();
    expect(screen.queryByText('Jordan Lee')).toBeNull();
    expect(queryGroupCreationCandidates).not.toHaveBeenCalled();

    // Consumer-only controls: no workplace kinds, scope, or join policy, and
    // none of the explanatory boxes.
    for (const gone of [
      'group.private', 'group.organizationWide', 'group.joinInherit', 'group.joinApproval',
      'group.team', 'group.shift', 'group.incident',
    ]) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    for (const absent of [
      'group.detailsEyebrow', 'group.detailsTitle', 'group.candidatePrivacy', 'group.atomicTitle',
      'group.atomicDisclosure', 'group.historySinceJoinDisclosure', 'group.avatarRequirements',
      'group.avatarDescriptionConsumer', 'group.joinInviteOnly', 'group.employee',
    ]) {
      expect(screen.queryByText(absent)).toBeNull();
    }

    // One character narrows the known list locally without a service call.
    const input = screen.getByLabelText('people.usernameSearch');
    await fireEvent.changeText(input, 'p');
    await waitFor(() => expect(screen.queryByText('Ana Friend')).toBeNull());
    expect(screen.getByText('Pat Pending')).toBeTruthy();
    expect(searchUsers).not.toHaveBeenCalled();

    // Two characters reach the people search; a stranger is offered like anyone.
    await fireEvent.changeText(input, 'sa');
    await waitFor(() => expect(searchUsers).toHaveBeenCalledWith('sa'));
    await waitFor(() => expect(screen.getByText('Sam Stranger')).toBeTruthy());
    expect(screen.getByText('@sam_stranger')).toBeTruthy();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Sam Stranger' }));
    // No owner/admin promotion for consumer groups.
    expect(screen.queryByRole('button', { name: 'group.member' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'group.admin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'group.owner' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'group.removePerson Sam Stranger' })).toBeTruthy();

    // No results reads as the people-search empty line; clearing the query
    // restores the known list, and the earlier selection survives.
    searchUsers.mockResolvedValueOnce([]);
    await fireEvent.changeText(input, 'zz');
    await waitFor(() => expect(screen.getByText('people.usernameNoResults')).toBeTruthy());
    expect(screen.queryByText('group.noCandidates')).toBeNull();
    await fireEvent.changeText(input, '');
    await waitFor(() => expect(screen.getByText('Ana Friend')).toBeTruthy());
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Ana Friend' }));
    expect(screen.getByText('2 group.selectedSuffix')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('group.name'), 'Weekend Trip');
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(createGroupConversation).toHaveBeenCalledWith({
      name: 'Weekend Trip',
      description: '',
      kind: 'group',
      unitId: null,
      historyPolicy: 'since_join',
      postingMode: 'all_members',
      joinPolicy: 'invite_only',
      incidentSeverity: undefined,
      incidentClassification: undefined,
      members: [
        { membershipId: 'user-stranger', role: 'member' },
        { membershipId: 'user-friend', role: 'member' },
      ],
    }));
  });

  test('shows the picker hint when a consumer knows no one yet', async () => {
    mockWorkspace = baseWorkspace({
      organizationId: PERSONAL_REALM_ORGANIZATION_ID,
      people: [self],
      queryGroupCreationCandidates: jest.fn(async (..._mockArgs: unknown[]) => [] as unknown[]),
      searchUsers: jest.fn(async (..._mockArgs: unknown[]) => [] as unknown[]),
      createGroupConversation: successfulAction(null),
    });
    await render(<NewGroupScreen />);
    await waitFor(() => expect(screen.getByText('group.pickerHint')).toBeTruthy());
    expect(screen.queryByText('group.noCandidates')).toBeNull();
    expect(screen.queryByText('group.loadingCandidates')).toBeNull();
  });
});

function handoff(overrides: Record<string, unknown> = {}) {
  return {
    id: 'handoff-draft',
    conversationId: 'conversation-shift',
    versionId: 'version-draft',
    versionNumber: 1,
    sourceLanguage: 'en',
    title: 'Night shift transfer',
    site: 'Denver Plant',
    outgoingShift: 'Night',
    incomingShift: 'Morning',
    window: '22:00–06:00',
    status: 'draft',
    summary: 'Pump two requires inspection.',
    openItems: 1,
    sourceCount: 2,
    outgoingSupervisor: 'Jordan Lee',
    incomingSupervisor: 'Ana Torres',
    shiftStartedAt: '2026-08-04T22:00:00.000Z',
    shiftEndedAt: '2026-08-05T06:00:00.000Z',
    sourceMessageIds: ['message-source', 'message-unloaded'],
    sourceState: 'stale',
    acknowledgementDueAt: '2026-08-05T08:00:00.000Z',
    canSign: true,
    ...overrides,
  };
}

describe('shift handoff workflow screen', () => {
  test('creates, signs, acknowledges, corrects, and opens exact source evidence', async () => {
    const draft = handoff();
    const awaiting = handoff({
      id: 'handoff-awaiting', versionId: 'version-awaiting', versionNumber: 2,
      title: 'Awaiting transfer', status: 'awaiting_signoff', canSign: false, canAcknowledge: true,
      sourceState: 'current', correctionReason: 'Corrected pump identifier.',
    });
    const ready = handoff({
      id: 'handoff-ready', versionId: 'version-ready', title: 'Ready transfer', status: 'ready',
      canSign: false, canAcknowledge: false, acknowledgementDueAt: undefined,
    });
    const acknowledged = handoff({
      id: 'handoff-acknowledged', versionId: 'version-acknowledged', title: 'Closed transfer',
      status: 'acknowledged', canSign: false, canAcknowledge: false,
    });
    mockWorkspace = baseWorkspace({
      capabilities: ['handoff.manage'],
      conversations: [{
        id: 'conversation-shift', title: 'Shift Operations', kind: 'shift', managementOnly: false,
        unreadCount: 0, canManage: true,
      }],
      handoffs: [draft, awaiting, ready, acknowledged],
      messages: {
        'conversation-shift': [
          {
            id: 'local-source', serverId: 'message-source', senderName: 'Ana Torres', sentAt: '05:30',
            originalText: 'Pump two vibration is elevated.', deleted: false,
          },
          {
            id: 'message-extra', senderName: 'Jordan Lee', sentAt: '05:45',
            originalText: 'Inspection is assigned.', deleted: false,
          },
          {
            id: 'message-deleted', senderName: 'Jordan Lee', sentAt: '05:50',
            originalText: 'Removed evidence.', deleted: true,
          },
        ],
      },
      hasCapability: jest.fn((capability: string) => capability === 'handoff.manage'),
      createHandoff: successfulAction(),
      signHandoff: successfulAction(),
      acknowledgeHandoff: successfulAction(),
      correctHandoff: successfulAction(),
      selectConversation: jest.fn(),
    });

    const view = await render(<HandoffsScreen />);
    expect(screen.getByText('handoffs.statusDraft')).toBeTruthy();
    expect(screen.getByText('handoffs.statusWaiting')).toBeTruthy();
    expect(screen.getByText('handoffs.statusReady')).toBeTruthy();
    expect(screen.getByText('handoffs.statusAcknowledged')).toBeTruthy();

    await fireEvent.press(screen.getAllByRole('button', { name: 'Open source message: Ana Torres' })[0]!);
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-shift');
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/conversation/[id]',
      params: { id: 'conversation-shift', messageId: 'message-source' },
    });
    await fireEvent.press(screen.getByRole('button', { name: 'handoffs.sign' }));
    expect(mockWorkspace.signHandoff).toHaveBeenCalledWith('handoff-draft');

    await fireEvent.press(screen.getByRole('button', { name: 'handoffs.start' }));
    await fireEvent.changeText(screen.getByLabelText('handoffs.fieldTitle'), 'Fresh shift handoff');
    await fireEvent.changeText(screen.getByLabelText('handoffs.details'), 'Pump and gate status verified.');
    await fireEvent.press(screen.getAllByRole('checkbox')[0]!);
    await fireEvent.press(screen.getByRole('button', { name: 'handoffs.createDraft' }));
    await waitFor(() => expect(mockWorkspace.createHandoff).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conversation-shift',
      title: 'Fresh shift handoff',
      details: 'Pump and gate status verified.',
      sourceMessageIds: ['message-source'],
    })));

    await fireEvent.press(screen.getByRole('button', { name: 'handoffs.acknowledge' }));
    await fireEvent.changeText(screen.getByLabelText('Discrepancy note (optional)'), 'x'.repeat(2001));
    await fireEvent.press(screen.getByRole('button', { name: 'Acknowledge exact version' }));
    expect(mockWorkspace.acknowledgeHandoff).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('Discrepancy note (optional)'), 'Verify pump two at 07:00.');
    await fireEvent.press(screen.getByRole('button', { name: 'Acknowledge exact version' }));
    expect(mockWorkspace.acknowledgeHandoff).toHaveBeenCalledWith('handoff-awaiting', {
      expectedVersionId: 'version-awaiting',
      expectedVersionNumber: 2,
      note: 'Verify pump two at 07:00.',
    });

    await fireEvent.press(screen.getAllByRole('button', { name: 'Correct handoff' })[0]!);
    await fireEvent.changeText(screen.getByLabelText('Correction reason'), 'Correct the equipment identifier.');
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Source message message-extra' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Create corrected draft' }));
    await waitFor(() => expect(mockWorkspace.correctHandoff).toHaveBeenCalledWith('handoff-draft', expect.objectContaining({
      expectedVersionId: 'version-draft',
      expectedVersionNumber: 1,
      sourceMessageIds: ['message-source', 'message-unloaded', 'message-extra'],
      reason: 'Correct the equipment identifier.',
    })));
    await view.unmount();
  });

  test('renders assigned-empty and loading boundaries without inventing handoffs', async () => {
    mockWorkspace = baseWorkspace({ handoffs: [], conversations: [] });
    const view = await render(<HandoffsScreen />);
    expect(screen.getByText('handoffs.noneAssigned')).toBeTruthy();
    await view.unmount();

    mockWorkspace = baseWorkspace({ status: 'loading' });
    const loading = await render(<HandoffsScreen />);
    expect(screen.getByText('status.loading')).toBeTruthy();
    await loading.unmount();
  });

  test('covers mobile no-deadline, source removal, failed mutation, and non-manageable handoff paths', async () => {
    mockWidth = 390;
    const editable = handoff({
      id: 'handoff-editable',
      versionId: 'version-editable',
      canSign: false,
      acknowledgementDueAt: undefined,
      sourceMessageIds: ['message-unloaded-only'],
      sourceState: 'current',
    });
    const acknowledgement = handoff({
      id: 'handoff-ack-edge',
      versionId: 'version-ack-edge',
      status: 'awaiting_signoff',
      canSign: false,
      canAcknowledge: true,
      conversationId: 'conversation-secondary',
      sourceMessageIds: [],
      acknowledgementDueAt: undefined,
    });
    const noActions = handoff({
      id: 'handoff-no-actions',
      versionId: 'version-no-actions',
      status: 'ready',
      canSign: false,
      canAcknowledge: false,
      conversationId: 'conversation-secondary',
      sourceMessageIds: [],
      acknowledgementDueAt: undefined,
    });
    mockWorkspace = baseWorkspace({
      capabilities: ['handoff.manage'],
      conversations: [
        {
          id: 'conversation-shift', title: 'Primary Shift', kind: 'shift', managementOnly: false,
          unreadCount: 0, canManage: true,
        },
        {
          id: 'conversation-secondary', title: 'Secondary Shift', kind: 'shift', managementOnly: false,
          unreadCount: 0, canManage: false,
        },
      ],
      handoffs: [editable, acknowledgement, noActions],
      messages: {
        'conversation-shift': [{
          id: 'message-local-only', senderName: 'Jordan Lee', sentAt: '06:00',
          originalText: '', deleted: false,
        }],
      },
      hasCapability: jest.fn((capability: string) => capability === 'handoff.manage'),
      createHandoff: successfulAction(false),
      signHandoff: successfulAction(false),
      acknowledgeHandoff: successfulAction(false),
      correctHandoff: successfulAction(false),
      selectConversation: jest.fn(),
    });

    const view = await render(<HandoffsScreen />);
    expect(screen.queryByText('handoffs.humanSignoff')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Open source message: message-unloaded-only' }));
    expect(mockWorkspace.selectConversation).toHaveBeenCalledWith('conversation-shift');

    await fireEvent.press(screen.getAllByRole('button', { name: 'handoffs.create' })[0]!);
    await fireEvent.press(screen.getByRole('button', { name: 'Secondary Shift' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Primary Shift' }));
    const createSource = screen.getAllByRole('checkbox')[0]!;
    await fireEvent.press(createSource);
    await fireEvent.press(createSource);
    await fireEvent.press(createSource);
    await fireEvent.changeText(screen.getByLabelText('handoffs.fieldTitle'), 'Mobile handoff');
    await fireEvent.changeText(screen.getByLabelText('handoffs.details'), 'Controlled mobile details');
    await fireEvent.changeText(screen.getByLabelText('handoffs.acknowledgementDue'), '');
    await fireEvent.press(screen.getByRole('button', { name: 'handoffs.createDraft' }));
    await waitFor(() => expect(mockWorkspace.createHandoff).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgementDueAt: null,
      sourceMessageIds: ['message-local-only'],
    })));
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);

    await fireEvent.press(screen.getAllByRole('button', { name: 'Correct handoff' })[0]!);
    expect(screen.getByText('No acknowledgement deadline')).toBeTruthy();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Source message message-unloaded-only' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'Source message message-local-only' }));
    await fireEvent.changeText(screen.getByLabelText('Correction reason'), 'Controlled correction reason');
    await fireEvent.press(screen.getByRole('button', { name: 'Create corrected draft' }));
    await waitFor(() => expect(mockWorkspace.correctHandoff).toHaveBeenCalledWith(
      'handoff-editable',
      expect.objectContaining({
        acknowledgementDueAt: null,
        sourceMessageIds: ['message-local-only'],
      }),
    ));
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);

    await fireEvent.press(screen.getByRole('button', { name: 'handoffs.acknowledge' }));
    await fireEvent.changeText(screen.getByLabelText('Discrepancy note (optional)'), 'Controlled discrepancy');
    await fireEvent.press(screen.getByRole('button', { name: 'Acknowledge exact version' }));
    await waitFor(() => expect(mockWorkspace.acknowledgeHandoff).toHaveBeenCalledWith(
      'handoff-ack-edge',
      expect.objectContaining({ note: 'Controlled discrepancy' }),
    ));
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);
    await view.unmount();
  });
});
