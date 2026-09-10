import { fireEvent, render, screen } from '@testing-library/react-native';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Text } from 'react-native';

import {
  AppScaffold,
  DesktopPageHeader,
  MobileBrandHeader,
} from '@/components/navigation/app-scaffold';
import { WorkspaceStatePanel, WorkspaceStatusBanner } from '@/components/workspace/workspace-state';

const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockRefresh = jest.fn(async () => undefined);
let mockWidth = 390;
let mockWorkspace: any;

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: any) => <ReactNative.View {...props}>{children}</ReactNative.View>,
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  };
});
jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 800 }),
}));
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));

beforeEach(() => {
  jest.clearAllMocks();
  mockWidth = 390;
  mockWorkspace = {
    capabilities: [],
    currentUser: null,
    conversations: [{ id: 'ordinary', managementOnly: false, unreadCount: 0 }],
    updates: [],
    people: [{ id: 'self', connectionState: 'self' }, { id: 'contact', connectionState: 'accepted' }],
    handoffs: [{ id: 'handoff' }],
    connectivity: 'online',
    offlineQueueAvailable: true,
    actionError: null,
    failedOutboxCount: 0,
    realtimeState: 'connected',
    outboxCount: 0,
    status: 'ready',
    error: null,
    refresh: mockRefresh,
  };
});

describe('navigation optional and high-count states', () => {
  test('renders optional mobile and desktop header content on both sides of each branch', async () => {
    const view = await render(<>
      <MobileBrandHeader title="Mobile title" subtitle="Mobile subtitle" right={<Text>Right action</Text>} />
      <DesktopPageHeader eyebrow="Eyebrow" title="Desktop title" description="Description" actions={<Text>Actions</Text>} />
    </>);
    expect(screen.getByText('Mobile subtitle')).toBeTruthy();
    expect(screen.getByText('Actions')).toBeTruthy();
    await view.rerender(<>
      <MobileBrandHeader title="Mobile only" />
      <DesktopPageHeader title="Desktop only" />
    </>);
    expect(screen.queryByText('Mobile subtitle')).toBeNull();
    expect(screen.queryByText('Description')).toBeNull();
  });

  test('bounds the desktop unread badge and renders the missing-account fallback', async () => {
    mockWidth = 1280;
    mockWorkspace.conversations = [
      { id: 'ordinary', managementOnly: false, unreadCount: 120 },
      { id: 'managed', managementOnly: true, unreadCount: 500 },
    ];
    await render(<AppScaffold current="people"><Text>Desktop content</Text></AppScaffold>);
    expect(screen.getByText('99+')).toBeTruthy();
    await fireEvent(screen.getByRole('button', { name: 'nav.chats' }), 'pressIn');
    await fireEvent.press(screen.getByRole('button', { name: 'nav.chats' }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
  });
});

describe('workspace status and empty-state branch ordering', () => {
  test('shows guest offline, realtime, queued, and healthy states in priority order', async () => {
    mockWorkspace.connectivity = 'offline';
    mockWorkspace.offlineQueueAvailable = false;
    const view = await render(<WorkspaceStatusBanner />);
    expect(screen.getByText('status.guestOffline')).toBeTruthy();

    mockWorkspace.connectivity = 'online';
    mockWorkspace.realtimeState = 'connecting';
    await view.rerender(<WorkspaceStatusBanner />);
    expect(screen.getByText('status.reconnecting')).toBeTruthy();

    mockWorkspace.realtimeState = 'error';
    await view.rerender(<WorkspaceStatusBanner />);
    expect(screen.getByText('status.reconnecting')).toBeTruthy();

    mockWorkspace.realtimeState = 'connected';
    mockWorkspace.outboxCount = 4;
    await view.rerender(<WorkspaceStatusBanner />);
    expect(screen.getByText('4 chat.queued')).toBeTruthy();

    mockWorkspace.outboxCount = 0;
    await view.rerender(<WorkspaceStatusBanner />);
    expect(view.toJSON()).toBeNull();
  });

  test('uses fallback error copy and treats self-only people as empty', async () => {
    mockWorkspace.status = 'error';
    mockWorkspace.error = null;
    const view = await render(<WorkspaceStatePanel resource="people" />);
    expect(screen.getAllByText('status.error').length).toBeGreaterThan(0);
    await fireEvent.press(screen.getByRole('button', { name: 'status.retry' }));
    expect(mockRefresh).toHaveBeenCalled();

    mockWorkspace.status = 'ready';
    mockWorkspace.people = [{ id: 'self', connectionState: 'self' }];
    await view.rerender(<WorkspaceStatePanel resource="people" />);
    expect(screen.getByText('status.emptyPeopleConsumer')).toBeTruthy();
  });
});
