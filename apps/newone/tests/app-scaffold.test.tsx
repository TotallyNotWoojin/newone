import { describe, expect, jest, test, beforeEach } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { AppScaffold, BrandMark } from '@/components/navigation/app-scaffold';
import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';

const mockRouter = {
  push: jest.fn(),
  replace: jest.fn(),
};
let mockWidth = 390;
let mockWorkspace: Record<string, unknown>;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 12, left: 0 }),
  };
});

jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 844 }),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

beforeEach(() => {
  mockWidth = 390;
  mockWorkspace = {
    organizationId: '20000000-0000-4000-8000-000000000001',
    capabilities: [],
    conversations: [
      { id: 'conversation-a', managementOnly: false, unreadCount: 3 },
      { id: 'management-only', managementOnly: true, unreadCount: 99 },
    ],
    updates: [
      { id: 'update-a', acknowledgementRequired: true, acknowledged: false },
      { id: 'update-b', acknowledgementRequired: false, acknowledged: false },
    ],
    currentUser: null,
  };
});

describe('application navigation scaffold', () => {
  test('renders the authorized mobile navigation and routes deliberate presses', async () => {
    await render(
      <AppScaffold current="chats" mobileHeader={<Text>Workspace header</Text>}>
        <Text>Conversation body</Text>
      </AppScaffold>,
    );

    expect(screen.getByText('Workspace header')).toBeTruthy();
    expect(screen.getByText('Conversation body')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'nav.chats' }).props.accessibilityState).toEqual({
      selected: true,
    });
    // Three tabs, and no fourth: updates, handoffs and admin belonged to the
    // workplace product and went with it.
    for (const gone of ['nav.updates', 'nav.handoffs', 'nav.admin']) {
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }

    await fireEvent.press(screen.getByRole('button', { name: 'nav.contacts' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/people');
    await fireEvent.press(screen.getByRole('button', { name: 'nav.settingsTab' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');
  });

  test('can intentionally hide all mobile tabs for focused flows', async () => {
    await render(
      <AppScaffold current="chats" hideMobileTabs={true}>
        <View accessibilityLabel="focused-content" />
      </AppScaffold>,
    );

    expect(screen.getByLabelText('focused-content')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'nav.chats' })).toBeNull();
  });

  test('desktop navigation renders account access and routes settings', async () => {
    mockWidth = 1280;
    mockWorkspace.currentUser = {
      avatarColor: '#123456',
      initials: 'WA',
      presence: 'online',
    };
    await render(
      <AppScaffold current="updates">
        <Text>Publisher body</Text>
      </AppScaffold>,
    );

    expect(screen.getByText('Publisher body')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'nav.updates' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'nav.handoffs' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'nav.settings' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/settings');
  });

  test('the mobile bar is chats, contacts and settings', async () => {
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    await render(
      <AppScaffold current="chats">
        <Text>Consumer body</Text>
      </AppScaffold>,
    );

    expect(screen.getByRole('button', { name: 'nav.chats' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'nav.contacts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'nav.settingsTab' })).toBeTruthy();
    // Search has no tab of its own; the field on Chats does that job.
    expect(screen.queryByRole('button', { name: 'nav.search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'nav.updates' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'nav.handoffs' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'nav.admin' })).toBeNull();
  });

  test('the desktop rail carries nothing else either', async () => {
    mockWidth = 1280;
    mockWorkspace.organizationId = PERSONAL_REALM_ORGANIZATION_ID;
    await render(
      <AppScaffold current="chats">
        <Text>Consumer desktop body</Text>
      </AppScaffold>,
    );

    expect(screen.getByRole('button', { name: 'nav.chats' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'nav.contacts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'nav.search' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'nav.updates' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'nav.handoffs' })).toBeNull();
  });

});
