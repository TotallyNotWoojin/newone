import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AccessibilityInfo, AppState, Platform } from 'react-native';

import RootLayout from '@/app/_layout';

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};
let mockPathname = '/';
let mockAuth: { authenticated: boolean; loading: boolean };
let mockWorkspace: Record<string, any>;
let mockStackProps: Record<string, any> | null = null;
let mockStackScreens: Record<string, any>[] = [];
let mockWorkspaceProviderRenders = 0;
const mockUseNotificationNavigation = jest.fn();
const mockAppStateRemove = jest.fn();
const mockReduceMotionRemove = jest.fn();
let mockAppStateHandler: ((state: string) => void) | null = null;
let mockReduceMotionHandler: ((enabled: boolean) => void) | null = null;

jest.mock('react-native-reanimated', () => ({}));

jest.mock('react-native-gesture-handler', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    GestureHandlerRootView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
  };
});

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaProvider: ({ children }: { children: ReactNode }) => (
      <ReactNative.View testID="controlled-safe-area">{children}</ReactNative.View>
    ),
  };
});

jest.mock('expo-status-bar', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    StatusBar: ({ style }: { style: string }) => (
      <ReactNative.Text>{`controlled-status-bar:${style}`}</ReactNative.Text>
    ),
  };
});

jest.mock('expo-router/head', () => function ControlledHead({ children }: { children: ReactNode }) {
  void children;
  return null;
});

jest.mock('expo-router', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  const Stack = ({ children, ...props }: Record<string, any>) => {
    mockStackProps = props;
    return <ReactNative.View testID="controlled-stack">{children}</ReactNative.View>;
  };
  Stack.Screen = function ControlledStackScreen(props: Record<string, any>) {
    mockStackScreens.push(props);
    return <ReactNative.Text>{`controlled-screen:${props.name}`}</ReactNative.Text>;
  };
  return {
    Stack,
    usePathname: () => mockPathname,
    useRouter: () => mockRouter,
  };
});

jest.mock('@/i18n/provider', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    I18nProvider: ({ children }: { children: ReactNode }) => (
      <ReactNative.View testID="controlled-i18n-provider">{children}</ReactNative.View>
    ),
  };
});

jest.mock('@/state/auth', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    AuthProvider: ({ children }: { children: ReactNode }) => (
      <ReactNative.View testID="controlled-auth-provider">{children}</ReactNative.View>
    ),
    useAuth: () => mockAuth,
  };
});

jest.mock('@/state/workspace', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    WorkspaceProvider: ({ children }: { children: ReactNode }) => {
      mockWorkspaceProviderRenders += 1;
      return <ReactNative.View testID="controlled-workspace-provider">{children}</ReactNative.View>;
    },
    useWorkspace: () => mockWorkspace,
  };
});

jest.mock('@/device/notification-navigation', () => ({
  useNotificationNavigation: (input: Record<string, unknown>) => mockUseNotificationNavigation(input),
}));

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ready',
    organizationId: 'organization-controlled',
    conversations: [
      { id: 'conversation-ordinary', managementOnly: false, unreadCount: 3 },
      { id: 'conversation-negative', managementOnly: false, unreadCount: -5 },
      { id: 'conversation-management', managementOnly: true, unreadCount: 99 },
    ],
    updates: [
      { id: 'update-required', acknowledgementRequired: true, acknowledged: false },
      { id: 'update-acknowledged', acknowledgementRequired: true, acknowledged: true },
      { id: 'update-information', acknowledgementRequired: false, acknowledged: false },
    ],
    handoffs: [
      { id: 'handoff-required', canAcknowledge: true, acknowledgedByMe: false },
      { id: 'handoff-acknowledged', canAcknowledge: true, acknowledgedByMe: true },
      { id: 'handoff-observer', canAcknowledge: false, acknowledgedByMe: false },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  mockPathname = '/';
  mockAuth = { authenticated: false, loading: false };
  mockWorkspace = baseWorkspace();
  mockStackProps = null;
  mockStackScreens = [];
  mockWorkspaceProviderRenders = 0;
  mockAppStateHandler = null;
  mockReduceMotionHandler = null;
  mockAppStateRemove.mockClear();
  mockReduceMotionRemove.mockClear();

  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    mockAppStateHandler = listener as (state: string) => void;
    return { remove: mockAppStateRemove } as never;
  });
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_type, listener) => {
    mockReduceMotionHandler = listener as unknown as (enabled: boolean) => void;
    return { remove: mockReduceMotionRemove } as never;
  });
});

describe('root application boundary', () => {
  test('shows the securing state while authentication is loading', async () => {
    mockAuth = { authenticated: false, loading: true };
    const view = await render(<RootLayout />);

    expect(screen.getByText('Securing your workspace…')).toBeTruthy();
    expect(screen.queryByTestId('controlled-stack')).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(AppState.addEventListener).not.toHaveBeenCalled();

    await view.unmount();
  });

  test('redirects unauthenticated private routes but leaves help and sign-in public', async () => {
    const privateView = await render(<RootLayout />);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in'));
    expect(screen.getByText('Redirecting securely…')).toBeTruthy();
    await privateView.unmount();

    mockRouter.replace.mockClear();
    mockPathname = '/help';
    const helpView = await render(<RootLayout />);
    expect(screen.getByTestId('controlled-stack')).toBeTruthy();
    expect(mockWorkspaceProviderRenders).toBe(0);
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await helpView.unmount();

    mockPathname = '/sign-in';
    const signInView = await render(<RootLayout />);
    expect(screen.getByTestId('controlled-stack')).toBeTruthy();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await signInView.unmount();
  });

  test('redirects an authenticated account away from the sign-in-only route', async () => {
    mockAuth = { authenticated: true, loading: false };
    mockPathname = '/sign-in';
    const view = await render(<RootLayout />);

    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(screen.getByText('Redirecting securely…')).toBeTruthy();
    expect(mockWorkspaceProviderRenders).toBe(0);

    await view.unmount();
  });

  test('mounts the authenticated workspace, computes security-safe badges, and honors reduce motion', async () => {
    mockAuth = { authenticated: true, loading: false };
    const view = await render(<RootLayout />);

    expect(screen.getByTestId('controlled-workspace-provider')).toBeTruthy();
    expect(mockStackProps?.screenOptions).toEqual({ headerShown: false, animation: 'fade' });
    expect(mockStackScreens.map(({ name }) => name)).toEqual([
      'index',
      'conversation/[id]',
      'updates',
      'search',
      'handoffs',
      'people',
      'new-group',
      'admin',
      'settings',
      'help',
      'sign-in',
    ]);
    expect(mockStackScreens.find(({ name }) => name === 'conversation/[id]')?.options)
      .toEqual({ animation: 'slide_from_right' });
    await waitFor(() => expect(mockUseNotificationNavigation).toHaveBeenLastCalledWith({
      enabled: true,
      organizationId: 'organization-controlled',
      badgeCount: 5,
    }));

    await act(async () => {
      mockReduceMotionHandler?.(true);
    });
    expect(mockStackProps?.screenOptions.animation).toBe('none');
    expect(mockStackScreens.filter(({ name }) => name === 'conversation/[id]').slice(-1)[0]?.options)
      .toEqual({ animation: 'none' });

    await act(async () => {
      mockReduceMotionHandler?.(false);
    });
    expect(mockStackProps?.screenOptions.animation).toBe('fade');

    await view.unmount();
    expect(mockReduceMotionRemove).toHaveBeenCalledTimes(1);
  });

  test('passes disabled notification navigation with a null organization until workspace readiness', async () => {
    mockAuth = { authenticated: true, loading: false };
    mockWorkspace = baseWorkspace({
      status: 'loading',
      organizationId: '',
      conversations: [],
      updates: [],
      handoffs: [],
    });
    const view = await render(<RootLayout />);

    await waitFor(() => expect(mockUseNotificationNavigation).toHaveBeenCalledWith({
      enabled: false,
      organizationId: null,
      badgeCount: 0,
    }));

    await view.unmount();
  });

  test('covers the native privacy shield lifecycle and unregisters the app-state observer', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
    mockPathname = '/help';
    const view = await render(<RootLayout />);

    expect(screen.getByLabelText('Newone content hidden')).toBeTruthy();
    expect(AppState.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    await act(async () => {
      mockAppStateHandler?.('active');
    });
    expect(screen.queryByLabelText('Newone content hidden')).toBeNull();

    await act(async () => {
      mockAppStateHandler?.('inactive');
    });
    expect(screen.getByLabelText('Newone content hidden')).toBeTruthy();

    await view.unmount();
    expect(mockAppStateRemove).toHaveBeenCalledTimes(1);
  });

  test('does not update reduce-motion state after the navigator has unmounted', async () => {
    let resolveMotion!: (enabled: boolean) => void;
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveMotion = resolve;
      }),
    );
    mockPathname = '/help';
    const view = await render(<RootLayout />);
    await view.unmount();

    resolveMotion(true);
    await Promise.resolve();
    expect(mockReduceMotionRemove).toHaveBeenCalledTimes(1);
  });
});
