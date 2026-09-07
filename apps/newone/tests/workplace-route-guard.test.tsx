import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import type { ReactNode } from 'react';

import HandoffsScreen from '@/app/handoffs';
import UpdatesScreen from '@/app/updates';
import { WorkplaceOnlyRoute } from '@/components/navigation/workplace-only-route';
import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';

const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockWorkspace: Record<string, unknown>;

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
  useHydrationSafeWindowDimensions: () => ({ width: 1280, height: 900 }),
}));
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/auth', () => ({ useAuth: () => ({ authenticated: true, session: null }) }));
jest.mock('@/state/workspace', () => ({ useWorkspace: () => mockWorkspace }));
jest.mock('@/data/repositories/bff-command-repository', () => ({
  BffCommandRepository: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('@/lib/supabase', () => ({ getSupabaseClient: () => null }));
jest.mock('@/lib/client-id', () => ({ createClientId: () => 'controlled-client' }));

function workspace(organizationId: string | null) {
  return {
    actionBusy: null,
    actionError: null,
    capabilities: [],
    connectivity: 'online',
    conversations: [],
    currentUser: null,
    handoffs: [],
    messages: {},
    organizationId,
    organizationName: 'Newone',
    people: [],
    status: 'ready',
    units: [],
    updates: [],
    clearActionError: jest.fn(),
    hasCapability: () => false,
  };
}

const GuardedScreen = () => <Text>workplace-screen-mounted</Text>;

beforeEach(() => {
  mockRouter.push.mockReset();
  mockRouter.replace.mockReset();
});

describe('workplace-only route guard', () => {
  test('sends a personal-realm account back to Chats without mounting the screen', async () => {
    mockWorkspace = workspace(PERSONAL_REALM_ORGANIZATION_ID);
    await render(<WorkplaceOnlyRoute screen={<GuardedScreen />} />);

    expect(screen.queryByText('workplace-screen-mounted')).toBeNull();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
  });

  test('renders the screen for a workplace account and redirects nobody', async () => {
    mockWorkspace = workspace('organization-a');
    await render(<WorkplaceOnlyRoute screen={<GuardedScreen />} />);

    expect(screen.getByText('workplace-screen-mounted')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });

  test('waits for the realm before deciding: an unknown organization still renders', async () => {
    mockWorkspace = workspace(null);
    await render(<WorkplaceOnlyRoute screen={<GuardedScreen />} />);

    expect(screen.getByText('workplace-screen-mounted')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});

describe('/updates and /handoffs refuse a consumer', () => {
  // Both are their own file in the static web export (dist/updates.html,
  // dist/handoffs.html) and were addressable with no realm check at all.
  test('/updates redirects and shows no workplace surface', async () => {
    mockWorkspace = workspace(PERSONAL_REALM_ORGANIZATION_ID);
    const view = await render(<UpdatesScreen />);

    expect(view.toJSON()).toBeNull();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
  });

  test('/handoffs redirects and shows no workplace surface', async () => {
    mockWorkspace = workspace(PERSONAL_REALM_ORGANIZATION_ID);
    const view = await render(<HandoffsScreen />);

    expect(view.toJSON()).toBeNull();
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
  });

  test('/handoffs still opens for a workplace account', async () => {
    mockWorkspace = workspace('organization-a');
    const view = await render(<HandoffsScreen />);

    expect(view.toJSON()).not.toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
  });
});
