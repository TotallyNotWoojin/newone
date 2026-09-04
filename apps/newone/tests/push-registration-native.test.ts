import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockSetNotificationChannelAsync: any = jest.fn();
const mockGetPermissionsAsync: any = jest.fn();
const mockRequestPermissionsAsync: any = jest.fn();
const mockGetExpoPushTokenAsync: any = jest.fn();
const mockAddPushTokenListener: any = jest.fn();
const mockGetInstallationId: any = jest.fn();
const mockCreateClientId: any = jest.fn();

let capturedHandler: any;
let tokenRefreshListener: (() => void) | null = null;
let mockPlatform = 'ios';
let mockIsDevice = true;
let mockRuntimeConfig: any = {
  easProjectId: '10000000-0000-4000-8000-000000000001',
  pushEnvironment: 'development',
};
let mockConstants: any = {
  easConfig: { projectId: '20000000-0000-4000-8000-000000000002' },
  expoConfig: { version: '1.0.0' },
};

async function flushRegistrationWork() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() { return mockConstants; },
}));

jest.mock('expo-device', () => ({
  get isDevice() { return mockIsDevice; },
}));

jest.mock('react-native', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  const platform = new Proxy(ReactNative.Platform, {
    get(target, property, receiver) {
      if (property === 'OS') return mockPlatform;
      return Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(ReactNative, {
    get(target, property, receiver) {
      if (property === 'Platform') return platform;
      return Reflect.get(target, property, receiver);
    },
  });
});

jest.mock('@/config/runtime', () => ({
  get publicRuntimeConfig() { return mockRuntimeConfig; },
}));

jest.mock('@/lib/client-id', () => ({
  createClientId: (...args: unknown[]) => mockCreateClientId(...args),
}));

jest.mock('@/lib/installation-id', () => ({
  getInstallationId: (...args: unknown[]) => mockGetInstallationId(...args),
}));

jest.mock('expo-notifications', () => ({
  setNotificationHandler: (...args: unknown[]) => {
    capturedHandler = args[0];
  },
  setNotificationChannelAsync: (...args: unknown[]) => mockSetNotificationChannelAsync(...args),
  getPermissionsAsync: (...args: unknown[]) => mockGetPermissionsAsync(...args),
  requestPermissionsAsync: (...args: unknown[]) => mockRequestPermissionsAsync(...args),
  getExpoPushTokenAsync: (...args: unknown[]) => mockGetExpoPushTokenAsync(...args),
  addPushTokenListener: (listener: () => void) => {
    tokenRefreshListener = listener;
    return mockAddPushTokenListener(listener);
  },
  AndroidImportance: { HIGH: 5, LOW: 2 },
  AndroidNotificationVisibility: { PRIVATE: -1 },
}));

import {
  addPushTokenRefreshListener,
  configureNotificationChannels,
  getCurrentInstallationId,
  getExistingDeviceRegistration,
  requestDeviceRegistration,
} from '@/device/push-registration.native';

beforeEach(() => {
  jest.clearAllMocks();
  tokenRefreshListener = null;
  mockPlatform = 'ios';
  mockIsDevice = true;
  mockRuntimeConfig = {
    easProjectId: '10000000-0000-4000-8000-000000000001',
    pushEnvironment: 'development',
  };
  mockConstants = {
    easConfig: { projectId: '20000000-0000-4000-8000-000000000002' },
    expoConfig: { version: '1.0.0' },
  };
  mockGetPermissionsAsync.mockResolvedValue({ granted: true });
  mockRequestPermissionsAsync.mockResolvedValue({ granted: true });
  mockGetExpoPushTokenAsync.mockResolvedValue({
    data: 'ExponentPushToken[controlled_token_123456789]',
  });
  mockGetInstallationId.mockResolvedValue('30000000-0000-4000-8000-000000000003');
  mockCreateClientId.mockReturnValue('client-controlled');
  mockSetNotificationChannelAsync.mockResolvedValue(null);
  mockAddPushTokenListener.mockReturnValue({ remove: jest.fn() });
});

describe('native notification visibility and channels', () => {
  test.each([
    [null, null, false],
    ['New message', null, true],
    [null, 'Open Newone to view it.', true],
  ])('shows a notification only when visible copy exists', async (title, body, visible) => {
    await expect(capturedHandler.handleNotification({
      request: { content: { title, body } },
    })).resolves.toEqual({
      shouldShowBanner: visible,
      shouldShowList: visible,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  test('configures private Android high- and low-importance channels', async () => {
    mockPlatform = 'android';
    await configureNotificationChannels();
    expect(mockSetNotificationChannelAsync.mock.calls).toEqual([
      ['newone-default', {
        name: 'Newone activity',
        importance: 5,
        lockscreenVisibility: -1,
        sound: 'default',
        vibrationPattern: [0, 250, 180, 250],
      }],
      ['newone-silent', {
        name: 'Newone quiet activity',
        importance: 2,
        lockscreenVisibility: -1,
        sound: null,
        enableVibrate: false,
      }],
    ]);
  });

  test('does not configure native channels outside Android', async () => {
    await configureNotificationChannels();
    expect(mockSetNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('native installation and existing push registration', () => {
  test.each([
    [false, 'ios'],
    [true, 'web'],
  ])('does not expose an installation identity for unsupported device=%s platform=%s', async (device, platform) => {
    mockIsDevice = device;
    mockPlatform = platform;
    await expect(getCurrentInstallationId()).resolves.toBeNull();
    expect(mockGetInstallationId).not.toHaveBeenCalled();
  });

  test('reads the stable protected installation identity on a real device', async () => {
    await expect(getCurrentInstallationId()).resolves.toBe('30000000-0000-4000-8000-000000000003');
  });

  test.each([
    ['simulator', () => { mockIsDevice = false; }],
    ['unsupported platform', () => { mockPlatform = 'web'; }],
    ['permission not granted', () => { mockGetPermissionsAsync.mockResolvedValue({ granted: false }); }],
    ['missing project', () => {
      mockRuntimeConfig.easProjectId = null;
      mockConstants.easConfig = null;
    }],
    ['invalid project', () => { mockRuntimeConfig.easProjectId = 'not-a-uuid'; }],
    ['missing environment', () => { mockRuntimeConfig.pushEnvironment = null; }],
    ['non-string token', () => { mockGetExpoPushTokenAsync.mockResolvedValue({ data: 42 }); }],
    ['malformed token', () => { mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'token-too-short' }); }],
  ])('fails closed for %s', async (_label, arrange) => {
    arrange();
    await expect(getExistingDeviceRegistration('organization-controlled')).resolves.toBeNull();
  });

  test('returns a complete Android binding from validated public build configuration', async () => {
    mockPlatform = 'android';
    await expect(getExistingDeviceRegistration('organization-controlled')).resolves.toEqual({
      organizationId: 'organization-controlled',
      installationId: '30000000-0000-4000-8000-000000000003',
      platform: 'android',
      pushToken: 'ExponentPushToken[controlled_token_123456789]',
      pushTokenType: 'expo',
      pushProjectId: '10000000-0000-4000-8000-000000000001',
      pushEnvironment: 'development',
      appVersion: '1.0.0',
      locale: expect.any(String),
      idempotencyKey: 'client-controlled',
    });
    expect(mockGetExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: '10000000-0000-4000-8000-000000000001',
    });
    expect(mockSetNotificationChannelAsync).toHaveBeenCalledTimes(2);
  });

  test('falls back to the native EAS project binding and permits the modern Expo token prefix', async () => {
    mockRuntimeConfig.easProjectId = null;
    mockRuntimeConfig.pushEnvironment = 'production';
    mockConstants.expoConfig = null;
    mockGetExpoPushTokenAsync.mockResolvedValue({ data: 'ExpoPushToken[controlled_token_123456789]' });
    const registration = await getExistingDeviceRegistration('organization-controlled');
    expect(registration).toMatchObject({
      pushProjectId: '20000000-0000-4000-8000-000000000002',
      pushEnvironment: 'production',
      pushToken: 'ExpoPushToken[controlled_token_123456789]',
      appVersion: undefined,
    });
  });
});

describe('permission request and refresh lifecycle', () => {
  test('reuses a granted permission without prompting', async () => {
    await expect(requestDeviceRegistration('organization-controlled')).resolves.toMatchObject({
      organizationId: 'organization-controlled',
    });
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
  });

  test('requests permission once when undecided and then registers', async () => {
    mockGetPermissionsAsync
      .mockResolvedValueOnce({ granted: false })
      .mockResolvedValueOnce({ granted: true });
    await expect(requestDeviceRegistration('organization-controlled')).resolves.toMatchObject({
      organizationId: 'organization-controlled',
    });
    expect(mockRequestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  test('a denied permission is a distinct code; an unsupported platform is null', async () => {
    mockGetPermissionsAsync.mockResolvedValue({ granted: false });
    mockRequestPermissionsAsync.mockResolvedValue({ granted: false });
    await expect(requestDeviceRegistration('organization-controlled')).rejects.toMatchObject({
      code: 'notification_permission_denied',
    });
    mockPlatform = 'web';
    await expect(requestDeviceRegistration('organization-controlled')).resolves.toBeNull();
  });

  test('rejects a simulator with a distinguishable push_needs_device code before any permission prompt', async () => {
    mockIsDevice = false;
    await expect(requestDeviceRegistration('organization-controlled')).rejects.toMatchObject({
      name: 'RepositoryError',
      code: 'push_needs_device',
      retryable: false,
    });
    expect(mockGetPermissionsAsync).not.toHaveBeenCalled();
    expect(mockRequestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockGetExpoPushTokenAsync).not.toHaveBeenCalled();
    // Passive reads stay silent on a simulator; only the deliberate enable
    // action explains itself.
    await expect(getExistingDeviceRegistration('organization-controlled')).resolves.toBeNull();
    await expect(getCurrentInstallationId()).resolves.toBeNull();
  });

  test('forwards a valid refreshed token registration and ignores unavailable registration', async () => {
    const onRegistration = jest.fn<(registration: any) => void>();
    const subscription = addPushTokenRefreshListener('organization-controlled', onRegistration);
    expect(subscription).toEqual(expect.objectContaining({ remove: expect.any(Function) }));
    tokenRefreshListener?.();
    await flushRegistrationWork();
    expect(onRegistration).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'organization-controlled',
    }));

    mockGetPermissionsAsync.mockResolvedValue({ granted: false });
    tokenRefreshListener?.();
    await flushRegistrationWork();
    expect(mockGetPermissionsAsync).toHaveBeenCalledTimes(2);
    expect(onRegistration).toHaveBeenCalledTimes(1);
  });
});
