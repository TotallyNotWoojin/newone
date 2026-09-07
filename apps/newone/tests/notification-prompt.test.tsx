import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import { NotificationPrompt } from '@/features/notifications/notification-prompt';
import { DevicePreferencesProvider } from '@/state/device-preferences';

type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';

let mockPermission: PermissionState = 'undetermined';
let mockStore: Record<string, string> = {};
let mockWorkspace: Record<string, any>;
// Implementations are (re)installed in beforeEach: the project's Jest config
// restores every mock before each test.
const mockOpenNotificationSettings = jest.fn<() => Promise<void>>();
const mockGetPermissionState = jest.fn<() => Promise<PermissionState>>();

jest.mock('@/data/persistence/client-store', () => ({
  clientStore: {
    initialize: async () => undefined,
    getCache: async (key: string) => mockStore[key] ?? null,
    putCache: async (key: string, value: string) => {
      mockStore[key] = value;
    },
  },
}));

jest.mock('@/device/push-registration', () => ({
  getNotificationPermissionState: () => mockGetPermissionState(),
  openNotificationSettings: () => mockOpenNotificationSettings(),
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

const STORAGE_KEY = 'preferences.device.v2';

function storedPromptedAt(): string | null {
  const raw = mockStore[STORAGE_KEY];
  return raw ? JSON.parse(raw).notificationsPromptedAt : null;
}

function renderPrompt() {
  return render(
    <DevicePreferencesProvider>
      <NotificationPrompt />
    </DevicePreferencesProvider>,
  );
}

async function settle() {
  // The provider reads the store and the prompt reads the OS permission, both
  // asynchronously; give every pending microtask a chance to land.
  await waitFor(() => expect(mockGetPermissionState).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockPermission = 'undetermined';
  mockStore = {};
  mockGetPermissionState.mockImplementation(async () => mockPermission);
  mockOpenNotificationSettings.mockResolvedValue(undefined);
  mockWorkspace = {
    organizationId: '11111111-1111-4111-8111-111111111111',
    enableNotifications: jest.fn(async () => true),
  };
});

describe('first-launch notification prompt', () => {
  test('asks once, and Turn on requests registration then records the answer', async () => {
    const view = await renderPrompt();
    await waitFor(() => expect(screen.getByText('settings.notificationsPromptTitle')).toBeTruthy());
    expect(screen.getByText('settings.notificationsPromptBody')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.notificationsPromptAccept' }));
    await waitFor(() => expect(mockWorkspace.enableNotifications).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('settings.notificationsPromptTitle')).toBeNull());
    expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
    expect(storedPromptedAt()).toEqual(expect.any(String));
    await view.unmount();

    // A later launch reads the recorded answer and never asks again.
    mockGetPermissionState.mockClear();
    const relaunch = await renderPrompt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('settings.notificationsPromptTitle')).toBeNull();
    expect(mockGetPermissionState).not.toHaveBeenCalled();
    await relaunch.unmount();
  });

  test('Not now records the answer without touching the OS or the workspace', async () => {
    const view = await renderPrompt();
    await waitFor(() => expect(screen.getByText('settings.notificationsPromptTitle')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'settings.notificationsPromptDismiss' }));
    await waitFor(() => expect(screen.queryByText('settings.notificationsPromptTitle')).toBeNull());
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
    expect(storedPromptedAt()).toEqual(expect.any(String));
    await view.unmount();
  });

  test('records a granted permission silently instead of asking', async () => {
    mockPermission = 'granted';
    const view = await renderPrompt();
    await settle();
    expect(screen.queryByText('settings.notificationsPromptTitle')).toBeNull();
    await waitFor(() => expect(storedPromptedAt()).toEqual(expect.any(String)));
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('sends Turn on to the system settings when the OS already denied', async () => {
    mockPermission = 'denied';
    const view = await renderPrompt();
    await waitFor(() => expect(screen.getByText('settings.notificationsPromptTitle')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'settings.notificationsPromptAccept' }));
    await waitFor(() => expect(mockOpenNotificationSettings).toHaveBeenCalledTimes(1));
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    await waitFor(() => expect(storedPromptedAt()).toEqual(expect.any(String)));
    await view.unmount();
  });

  test('still records the answer when registration fails', async () => {
    mockWorkspace.enableNotifications = jest.fn(async () => {
      throw new Error('controlled registration failure');
    });
    const view = await renderPrompt();
    await waitFor(() => expect(screen.getByText('settings.notificationsPromptTitle')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'settings.notificationsPromptAccept' }));
    await waitFor(() => expect(screen.queryByText('settings.notificationsPromptTitle')).toBeNull());
    expect(storedPromptedAt()).toEqual(expect.any(String));
    await view.unmount();
  });

  test('waits for the workspace snapshot before asking', async () => {
    mockWorkspace = { ...mockWorkspace, organizationId: '' };
    const view = await renderPrompt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('settings.notificationsPromptTitle')).toBeNull();
    expect(mockGetPermissionState).not.toHaveBeenCalled();
    expect(storedPromptedAt()).toBeNull();

    mockWorkspace = { ...mockWorkspace, organizationId: '11111111-1111-4111-8111-111111111111' };
    await view.rerender(
      <DevicePreferencesProvider>
        <NotificationPrompt />
      </DevicePreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByText('settings.notificationsPromptTitle')).toBeTruthy());
    await view.unmount();
  });

  test('never asks on the web and leaves the flag untouched', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    const view = await renderPrompt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('settings.notificationsPromptTitle')).toBeNull();
    expect(mockGetPermissionState).not.toHaveBeenCalled();
    expect(storedPromptedAt()).toBeNull();
    await view.unmount();
    platform.restore();
  });
});
