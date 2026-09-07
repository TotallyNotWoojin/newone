import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import NewGroupScreen, { groupNameFromPeople } from '@/app/new-group';
import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';

jest.setTimeout(20_000);

const mockRouter = { back: jest.fn(), push: jest.fn(), replace: jest.fn() };
let mockWorkspace: Record<string, any>;

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
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
  useHydrationSafeWindowDimensions: () => ({ width: 390, height: 844 }),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));

const self = {
  id: 'user-self', membershipId: 'membership-self', displayName: 'Jordan Lee', initials: 'JL',
  avatarColor: '#123456', roleLabel: '', role: 'employee', site: '', department: '',
  preferredLanguage: 'en', presence: 'online', connectionState: 'self',
};

function contact(overrides: Record<string, unknown>) {
  return {
    ...self,
    id: 'user-contact', membershipId: 'membership-contact', displayName: 'Ana Friend',
    username: 'ana_friend', connectionState: 'connected', presence: 'offline', ...overrides,
  };
}

function consumerWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    actionBusy: null,
    actionError: null,
    organizationId: PERSONAL_REALM_ORGANIZATION_ID,
    people: [
      self,
      contact({}),
      contact({ id: 'user-pat', displayName: 'Pat Pending', username: 'pat_pending', connectionState: 'pending' }),
    ],
    units: [],
    queryGroupCreationCandidates: jest.fn(async (..._args: unknown[]) => [] as unknown[]),
    searchUsers: jest.fn(async (..._args: unknown[]) => [] as unknown[]),
    createGroupConversation: jest.fn(async (..._args: unknown[]) => 'conversation-new'),
    uploadConversationAvatar: jest.fn(async (..._args: unknown[]) => true),
    ...overrides,
  };
}

beforeEach(() => {
  mockWorkspace = consumerWorkspace();
});

describe('group name fallback', () => {
  test('titles an unnamed group by the people in it', () => {
    expect(groupNameFromPeople(['Ana', 'Ben'], 'New group')).toBe('Ana, Ben');
    expect(groupNameFromPeople(['Ana', 'Ben', 'Cara', 'Dee'], 'New group')).toBe('Ana, Ben, Cara +1');
    expect(groupNameFromPeople(['  ', ''], 'New group')).toBe('New group');
    expect(groupNameFromPeople(['x'.repeat(200)], 'New group')).toHaveLength(158);
  });
});

describe('new group form', () => {
  test('name, description and photo are optional and the group is titled by its people', async () => {
    await render(<NewGroupScreen />);
    // Each of the three is labelled optional, and none of them blocks Create.
    expect(screen.getByLabelText('group.nameOptional')).toBeTruthy();
    expect(screen.getByLabelText('group.descriptionOptional')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'group.photoOptional' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Ana Friend' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Pat Pending' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(mockWorkspace.createGroupConversation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ana Friend, Pat Pending', description: '' }),
    ));
  });

  test('a typed name wins over the people-derived one', async () => {
    await render(<NewGroupScreen />);
    await fireEvent.changeText(screen.getByLabelText('group.nameOptional'), '  Weekend trip  ');
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Ana Friend' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Pat Pending' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(mockWorkspace.createGroupConversation).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Weekend trip' }),
    ));
  });

  test('advanced options are collapsed and summarised in one line', async () => {
    await render(<NewGroupScreen />);
    expect(screen.getByText('group.postEveryone · group.historySinceJoinSummary')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'group.postingAdminsOnly' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'group.historyAll' })).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'group.advancedOptions' }));
    expect(screen.queryByText('group.postEveryone · group.historySinceJoinSummary')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'group.postingAdminsOnly' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.historyAll' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.advancedOptions' }));
    expect(screen.getByText('group.postAdmins · group.historyAllSummary')).toBeTruthy();

    // The summary is not decoration: it is what gets sent.
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Ana Friend' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Pat Pending' }));
    await fireEvent.press(screen.getByRole('button', { name: 'group.create' }));
    await waitFor(() => expect(mockWorkspace.createGroupConversation).toHaveBeenCalledWith(
      expect.objectContaining({ postingMode: 'admins_only', historyPolicy: 'all' }),
    ));
  });

  test('contacts come first and strangers live under their own heading', async () => {
    const searchUsers = jest.fn(async (..._args: unknown[]) => [
      { userId: 'user-contact', username: 'ana_friend', displayName: 'Ana Friend', avatarPath: null, connectionState: 'accepted' },
      { userId: 'user-stranger', username: 'ana_stranger', displayName: 'Ana Stranger', avatarPath: null, connectionState: 'none' },
    ] as unknown[]);
    mockWorkspace = consumerWorkspace({ searchUsers });
    const view = await render(<NewGroupScreen />);

    const rendered = JSON.stringify(view.toJSON());
    expect(rendered.indexOf('group.contacts')).toBeGreaterThan(-1);
    expect(rendered.indexOf('group.contacts')).toBeLessThan(rendered.indexOf('group.searchEveryone'));

    await fireEvent.changeText(screen.getByLabelText('people.usernameSearch'), 'ana');
    await waitFor(() => expect(searchUsers).toHaveBeenCalledWith('ana'));
    // Ana Friend is already a contact, so she is listed once — above the fold,
    // under the contacts heading — and never repeated as a stranger.
    await waitFor(() => expect(screen.getByText('Ana Stranger')).toBeTruthy());
    expect(screen.getAllByText('Ana Friend')).toHaveLength(1);

    // A stranger can still be added.
    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Ana Stranger' }));
    expect(screen.getByRole('checkbox', { name: 'group.removePerson Ana Stranger' })).toBeTruthy();
  });

  test('a short query keeps the contacts list and offers the search hint', async () => {
    const searchUsers = jest.fn(async (..._args: unknown[]) => [] as unknown[]);
    mockWorkspace = consumerWorkspace({ searchUsers });
    await render(<NewGroupScreen />);
    await fireEvent.changeText(screen.getByLabelText('people.usernameSearch'), 'a');
    await waitFor(() => expect(screen.getByText('Ana Friend')).toBeTruthy());
    expect(searchUsers).not.toHaveBeenCalled();
    expect(screen.getAllByText('group.pickerHint').length).toBeGreaterThan(0);
  });

  test('a contact search with no match says so without emptying the screen', async () => {
    await render(<NewGroupScreen />);
    await fireEvent.changeText(screen.getByLabelText('people.usernameSearch'), 'zzz');
    await waitFor(() => expect(screen.getByText('group.contactsEmpty')).toBeTruthy());
    expect(screen.getByText('people.usernameNoResults')).toBeTruthy();
  });
});

describe('the three-person rule', () => {
  test('the form says it, and Create stays off until you and two others are in', async () => {
    await render(<NewGroupScreen />);
    expect(screen.getByText('group.minimumPeople')).toBeTruthy();
    const create = () => screen.getByRole('button', { name: 'group.create' });
    expect(create().props.accessibilityState.disabled).toBe(true);

    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Ana Friend' }));
    expect(create().props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(create());
    expect(mockWorkspace.createGroupConversation).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('checkbox', { name: 'group.addPerson Pat Pending' }));
    expect(create().props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(create());
    await waitFor(() => expect(mockWorkspace.createGroupConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        members: [
          { membershipId: 'user-contact', role: 'member' },
          { membershipId: 'user-pat', role: 'member' },
        ],
      }),
    ));
  });
});
