import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { AppState, Platform } from 'react-native';

import SettingsScreen from '@/app/settings';
import { PERSONAL_REALM_ORGANIZATION_ID } from '@/constants/personal-realm';

const mockRouter = {
  back: jest.fn(),
  push: jest.fn(),
  replace: jest.fn(),
};
const mockSetLocale = jest.fn();
type ControlledWebFactor = {
  id: string;
  friendlyName: string;
  status: 'verified' | 'unverified';
};
type ControlledEnrollment = { factorId: string; qrCode: string; secret: string };
type ControlledVerification = { factorId: string; challengeId: string; code: string };
type PermissionState = 'granted' | 'denied' | 'undetermined' | 'unavailable';
const mockListWebMfaFactors = jest.fn<() => Promise<ControlledWebFactor[]>>();
const mockChallengeWebMfa = jest.fn<(factorId: string) => Promise<{ challengeId: string }>>();
const mockEnrollWebMfa = jest.fn<(friendlyName: string) => Promise<ControlledEnrollment>>();
const mockVerifyWebMfa = jest.fn<(input: ControlledVerification) => Promise<void>>();
const mockGetSupabaseClient = jest.fn<() => any>();
const mockOpenNotificationSettings = jest.fn(async () => undefined);
const mockSetLocalPreference = jest.fn();
const mockTranslate = (key: string) => key;

let mockLocale: 'en' | 'ko' | 'es' = 'en';
let mockPermission: PermissionState = 'granted';
let mockLocalPreferences = { translatedOnly: false, enterSends: true, notificationsPromptedAt: null as string | null };
let mockWorkspace: Record<string, any>;
let mockAuth: Record<string, any>;

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
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

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({
    locale: mockLocale,
    setLocale: mockSetLocale,
    t: mockTranslate,
  }),
}));

jest.mock('@/state/workspace', () => ({
  useWorkspace: () => mockWorkspace,
}));

jest.mock('@/state/auth', () => ({
  useAuth: () => mockAuth,
}));

jest.mock('@/state/device-preferences', () => ({
  useDevicePreferences: () => ({
    preferences: mockLocalPreferences,
    ready: true,
    setPreference: (...args: unknown[]) => mockSetLocalPreference(...args),
  }),
}));

jest.mock('@/device/push-registration', () => ({
  getNotificationPermissionState: async () => mockPermission,
  openNotificationSettings: () => mockOpenNotificationSettings(),
}));

jest.mock('@/lib/supabase', () => ({
  getSupabaseClient: () => mockGetSupabaseClient(),
}));

jest.mock('@/lib/web-auth', () => ({
  challengeWebMfa: (factorId: string) => mockChallengeWebMfa(factorId),
  enrollWebMfa: (friendlyName: string) => mockEnrollWebMfa(friendlyName),
  listWebMfaFactors: () => mockListWebMfaFactors(),
  verifyWebMfa: (input: ControlledVerification) => mockVerifyWebMfa(input),
}));

function successfulAction(value: unknown = true) {
  return jest.fn(async (..._args: unknown[]) => value);
}

const currentUser = {
  id: 'user-owner',
  membershipId: 'membership-owner',
  displayName: 'Jordan Owner',
  initials: 'JO',
  avatarColor: '#234567',
  roleLabel: 'Operations owner',
  role: 'owner',
  site: 'Denver',
  department: 'Operations',
  preferredLanguage: 'en',
  presence: 'online',
  connectionState: 'self',
};

const organizationPreferences = {
  uiLanguage: 'en',
  messageLanguage: null,
  timeZone: 'America/Denver',
  quietHoursStart: '21:00:00',
  quietHoursEnd: '06:30:00',
  quietDays: [0, 6],
  notificationPreview: 'generic',
  soundEnabled: true,
  vibrationEnabled: true,
  shiftAwareSuppression: false,
  readVisibility: 'everyone',
};

const devicePreferences = {
  registered: true,
  deviceId: '10000000-0000-4000-8000-000000000001',
  installationId: '10000000-0000-4000-8000-000000000002',
  platform: 'ios',
  preferenceVersion: 2,
  overrides: {
    notificationPreview: null,
    soundEnabled: null,
    vibrationEnabled: null,
  },
  effective: {
    notificationPreview: 'generic',
    soundEnabled: true,
    vibrationEnabled: false,
  },
  updatedAt: '2030-02-03T04:05:06.000Z',
};

const otherSession = {
  sessionId: 'session-other',
  current: false,
  platform: 'web',
  device: { appVersion: '2.3.4' },
  signal: { clientFamily: 'desktop' },
  lastUsedAt: '2030-01-02T03:04:05.000Z',
  revoked: false,
};

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: '20000000-0000-4000-8000-000000000001',
    currentUser,
    capabilities: ['communications.publish'],
    conversations: [{ id: 'conversation-a', title: 'Operations' }],
    organizationPreferences,
    deviceNotificationPreferences: devicePreferences,
    deviceNotificationsMuted: false,
    accountSessions: [otherSession, {
      sessionId: 'session-revoked',
      current: false,
      platform: 'ios',
      device: null,
      signal: { clientFamily: 'iphone' },
      lastUsedAt: '2030-01-01T00:00:00.000Z',
      revoked: true,
    }],
    actionBusy: null,
    actionError: null,
    messageOutbox: [],
    outboxDegradedReason: null,
    loadAccountSettings: successfulAction(),
    saveOrganizationPreferences: successfulAction(true),
    enableNotifications: successfulAction(),
    setDeviceNotificationsMuted: successfulAction(true),
    loadDeviceNotificationPreferences: successfulAction(),
    saveDeviceNotificationPreferences: successfulAction(),
    updateProfile: successfulAction(true),
    uploadProfileAvatar: successfulAction(true),
    removeProfileAvatar: successfulAction(true),
    revokeSession: successfulAction(true),
    cancelOutboxMessage: successfulAction(),
    editOutboxMessage: successfulAction(),
    retryOutboxMessage: successfulAction(),
    clearActionError: jest.fn(),
    ...overrides,
  };
}

function nativeMfaClient(overrides: Record<string, unknown> = {}) {
  return {
    auth: {
      mfa: {
        listFactors: jest.fn(async () => ({
          data: {
            all: [{
              id: 'factor-verified',
              factor_type: 'totp',
              friendly_name: 'Work phone',
              status: 'verified',
            }, {
              id: 'factor-phone',
              factor_type: 'phone',
              friendly_name: 'Phone',
              status: 'verified',
            }],
          },
          error: null,
        })),
        getAuthenticatorAssuranceLevel: jest.fn(async () => ({
          data: { currentLevel: 'aal2' },
          error: null,
        })),
        unenroll: jest.fn(async () => ({ data: {}, error: null })),
        enroll: jest.fn(async () => ({
          data: {
            id: 'factor-enrolled',
            totp: { qr_code: '<svg>controlled qr</svg>', secret: 'CONTROLLEDSECRET' },
          },
          error: null,
        })),
        challengeAndVerify: jest.fn(async () => ({ data: {}, error: null })),
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  mockLocale = 'en';
  mockPermission = 'granted';
  mockLocalPreferences = { translatedOnly: false, enterSends: true, notificationsPromptedAt: null };
  mockWorkspace = baseWorkspace();
  mockAuth = {
    assuranceLevel: 'aal2',
    sessionId: 'session-current',
    session: { access_token: 'controlled-access-token' },
    refreshAssurance: successfulAction(),
    signOut: successfulAction(),
    deleteAccount: successfulAction(),
  };
  mockListWebMfaFactors.mockResolvedValue([]);
  mockChallengeWebMfa.mockResolvedValue({ challengeId: 'web-challenge' });
  mockEnrollWebMfa.mockResolvedValue({
    factorId: 'web-enrollment',
    qrCode: '<svg>controlled web qr</svg>',
    secret: 'CONTROLLEDWEBSECRET',
  });
  mockVerifyWebMfa.mockResolvedValue(undefined);
  mockGetSupabaseClient.mockReturnValue(nativeMfaClient());
});

async function renderAndHydrate() {
  const view = await render(<SettingsScreen />);
  await waitFor(() => expect(screen.queryByText('settings.title')).toBeTruthy());
  // The account preference rows enable once the draft has been seeded.
  await waitFor(() => expect(screen.getByLabelText('settings.sound').props.accessibilityState?.disabled).toBe(false));
  return view;
}

async function pressEnabled(name: string) {
  let button = screen.getByRole('button', { name });
  await waitFor(() => {
    button = screen.getByRole('button', { name });
    expect(button.props.accessibilityState?.disabled).toBe(false);
  });
  await fireEvent.press(button);
}

function switchValue(label: string) {
  return screen.getByLabelText(label).props.value;
}

async function waitForNativeMfaHydration(
  client: ReturnType<typeof nativeMfaClient>,
  buttonName: 'settings.mfaEnroll' | 'settings.mfaVerify',
) {
  await waitFor(() => {
    expect(client.auth.mfa.listFactors).toHaveBeenCalledTimes(1);
    expect(client.auth.mfa.getAuthenticatorAssuranceLevel).toHaveBeenCalledTimes(1);
  });
  await waitFor(() => {
    const button = screen.getByRole('button', { name: buttonName });
    expect(button.props.accessibilityState?.disabled).toBe(false);
  });
}

describe('settings screen', () => {
  test('fails closed while the authoritative current user is unavailable', async () => {
    mockWorkspace = baseWorkspace({ currentUser: null, organizationPreferences: null });
    const view = await render(<SettingsScreen />);
    expect(screen.queryByText('settings.title')).toBeNull();
    await view.unmount();
  });

  test('shows a compact profile row, closes, and opens help', async () => {
    mockWorkspace = baseWorkspace({
      currentUser: { ...currentUser, username: 'jordan_owner', statusMessage: 'Back at nine' },
    });
    const view = await renderAndHydrate();
    expect(screen.getByText('Jordan Owner')).toBeTruthy();
    expect(screen.getByText('@jordan_owner · Back at nine')).toBeTruthy();
    expect(screen.queryByText('settings.subtitle')).toBeNull();
    expect(screen.queryByText('settings.companyVerified')).toBeNull();
    expect(screen.queryByText('settings.accountVerified')).toBeNull();
    expect(screen.queryByText('settings.privateDmNote')).toBeNull();

    await fireEvent.press(screen.getByLabelText('settings.close'));
    expect(mockRouter.back).toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.help' }));
    expect(mockRouter.push).toHaveBeenCalledWith('./help');
    await view.unmount();
  });

  test('changes the display language and account preferences from row pickers, saving automatically', async () => {
    const view = await renderAndHydrate();
    expect(screen.getByText('settings.english')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.displayLanguage' }));
    await fireEvent.press(screen.getByLabelText('settings.displayLanguage: settings.korean'));
    expect(mockSetLocale).toHaveBeenCalledWith('ko');
    await waitFor(() => expect(screen.queryByLabelText('settings.displayLanguage: settings.korean')).toBeNull());

    expect(screen.getByText('settings.messageLanguageAuto')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.messageLanguage' }));
    await fireEvent.press(screen.getByLabelText('settings.messageLanguage: settings.spanish'));
    await waitFor(() => expect(mockWorkspace.saveOrganizationPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ uiLanguage: 'en', messageLanguage: 'es' }),
    ));
    expect(screen.getByText('settings.spanish')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.readVisibility' }));
    await fireEvent.press(screen.getByLabelText('settings.readVisibility: settings.readNobody'));
    await waitFor(() => expect(mockWorkspace.saveOrganizationPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ messageLanguage: 'es', readVisibility: 'nobody' }),
    ));
    expect(screen.getByText('settings.readNobody')).toBeTruthy();

    await fireEvent(screen.getByLabelText('settings.sound'), 'valueChange', false);
    await fireEvent(screen.getByLabelText('settings.vibration'), 'valueChange', false);
    await fireEvent(screen.getByLabelText('settings.shiftSuppression'), 'valueChange', true);
    await waitFor(() => expect(mockWorkspace.saveOrganizationPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ soundEnabled: false, vibrationEnabled: false, shiftAwareSuppression: true }),
    ));
    await view.unmount();
  });

  test('edits quiet hours in a sheet and only saves a complete, valid range', async () => {
    const view = await renderAndHydrate();
    expect(screen.getByText('21:00–06:30')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.quietHours' }));
    await fireEvent.changeText(screen.getByLabelText('settings.quietStart'), 'bad');
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(mockWorkspace.saveOrganizationPreferences).not.toHaveBeenCalled();

    // Editing one end only keeps the server's HH:MM:SS on the other end.
    await fireEvent.changeText(screen.getByLabelText('settings.quietStart'), '20:15');
    await waitFor(() => expect(mockWorkspace.saveOrganizationPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ quietHoursStart: '20:15', quietHoursEnd: '06:30:00' }),
    ));
    await fireEvent.changeText(screen.getByLabelText('settings.quietEnd'), '');
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(mockWorkspace.saveOrganizationPreferences).toHaveBeenCalledTimes(1);
    await fireEvent.changeText(screen.getByLabelText('settings.quietStart'), '');
    await waitFor(() => expect(mockWorkspace.saveOrganizationPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ quietHoursStart: null, quietHoursEnd: null }),
    ));
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    await waitFor(() => expect(screen.getByText('settings.disabled')).toBeTruthy());
    await view.unmount();
  });

  test('wires the chat switches to the device preferences', async () => {
    const view = await renderAndHydrate();
    expect(screen.getByText('settings.translatedOnlyHint')).toBeTruthy();
    expect(switchValue('settings.translatedOnly')).toBe(false);
    expect(switchValue('settings.enterSends')).toBe(true);
    await fireEvent(screen.getByLabelText('settings.translatedOnly'), 'valueChange', true);
    expect(mockSetLocalPreference).toHaveBeenCalledWith('translatedOnly', true);
    await fireEvent(screen.getByLabelText('settings.enterSends'), 'valueChange', false);
    expect(mockSetLocalPreference).toHaveBeenCalledWith('enterSends', false);
    await view.unmount();
  });

  test('sends and hides the outbox section depending on queued messages', async () => {
    let view = await renderAndHydrate();
    expect(screen.queryByText('Messages waiting to send')).toBeNull();
    await view.unmount();

    mockWorkspace = baseWorkspace({
      messageOutbox: [{
        id: 'outbox-known',
        conversationId: 'conversation-a',
        clientMessageId: 'client-known',
        body: 'Controlled queued body',
        createdAt: '2030-01-01T00:00:00.000Z',
        attempts: 0,
        state: 'queued',
        lastErrorCode: null,
        canEdit: true,
        canRetry: false,
        deliveryAmbiguous: false,
      }],
    });
    view = await renderAndHydrate();
    expect(screen.getByText('Messages waiting to send')).toBeTruthy();
    expect(screen.getByText('Operations')).toBeTruthy();
    await view.unmount();
  });

  test('revokes other and current sessions with a reason on a workspace account, and signs out', async () => {
    const view = await renderAndHydrate();
    expect(screen.getByText('WEB · 2.3.4')).toBeTruthy();
    expect(screen.queryByText('settings.noOtherSessions')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeSession' }));
    expect(screen.getByText('settings.revokeDescription')).toBeTruthy();
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    expect(mockWorkspace.revokeSession).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeSession' }));
    await fireEvent.changeText(screen.getByLabelText('settings.revokeReason'), 'Lost shared kiosk');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeConfirm' }));
    await waitFor(() => expect(mockWorkspace.revokeSession).toHaveBeenCalledWith(
      'session-other',
      'Lost shared kiosk',
    ));
    expect(mockWorkspace.loadAccountSettings).toHaveBeenCalledTimes(2);

    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeCurrent' }));
    await fireEvent.changeText(screen.getByLabelText('settings.revokeReason'), 'Secure this account');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeConfirm' }));
    await waitFor(() => expect(mockWorkspace.revokeSession).toHaveBeenCalledWith(
      'session-current',
      'Secure this account',
    ));
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');

    // Sign-out revokes the current session server-side first; the workspace
    // performs the local sign-out as part of a successful current-session
    // revoke, so auth.signOut is only the fallback.
    mockWorkspace.revokeSession.mockClear();
    mockAuth.signOut.mockClear();
    mockRouter.replace.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.signOut' }));
    await waitFor(() => expect(mockWorkspace.revokeSession).toHaveBeenCalledWith(
      'session-current',
      'sign_out',
    ));
    expect(mockAuth.signOut).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');

    // When the revoke cannot be sent, the device still signs out locally.
    mockWorkspace.revokeSession.mockResolvedValueOnce(false);
    mockRouter.replace.mockClear();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.signOut' }));
    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalled());
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');
    await view.unmount();
  });

  test('keeps the sheet open when another device cannot be signed out', async () => {
    mockWorkspace = baseWorkspace({
      revokeSession: successfulAction(false),
      accountSessions: [{ ...otherSession, sessionId: 'session-native-other', platform: 'ios', device: null, signal: { clientFamily: 'iphone' } }],
    });
    const view = await renderAndHydrate();
    expect(screen.getByText('iphone')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeSession' }));
    await fireEvent.changeText(screen.getByLabelText('settings.revokeReason'), 'Keep active after review');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeConfirm' }));
    await waitFor(() => expect(mockWorkspace.revokeSession).toHaveBeenCalledWith(
      'session-native-other',
      'Keep active after review',
    ));
    expect(mockRouter.replace).not.toHaveBeenCalledWith('/sign-in');
    expect(screen.getByText('settings.revokeTitle')).toBeTruthy();
    await view.unmount();
  });

  test('enrolls and verifies a native TOTP factor and removes stale enrollments', async () => {
    const client = nativeMfaClient({
      listFactors: jest.fn(async () => ({
        data: {
          all: [{
            id: 'stale-factor',
            factor_type: 'totp',
            friendly_name: 'Incomplete enrollment',
            status: 'unverified',
          }],
        },
        error: null,
      })),
      getAuthenticatorAssuranceLevel: jest.fn(async () => ({
        data: { currentLevel: 'aal1' },
        error: null,
      })),
    });
    mockGetSupabaseClient.mockReturnValue(client);
    const view = await renderAndHydrate();
    await waitForNativeMfaHydration(client, 'settings.mfaEnroll');
    expect(screen.getByText('settings.mfaNotEnrolled')).toBeTruthy();

    await pressEnabled('settings.mfaEnroll');
    await waitFor(() => expect(screen.getByText('CONTROLLEDSECRET')).toBeTruthy());
    expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({ factorId: 'stale-factor' });
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);
    await waitFor(() => expect(client.auth.mfa.unenroll).toHaveBeenCalledWith({
      factorId: 'factor-enrolled',
    }));
    await pressEnabled('settings.mfaEnroll');
    await waitFor(() => expect(screen.getByText('CONTROLLEDSECRET')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('settings.mfaCodeLabel'), '123 456');
    await pressEnabled('settings.mfaConfirm');
    await waitFor(() => expect(client.auth.mfa.challengeAndVerify).toHaveBeenCalledWith({
      factorId: 'factor-enrolled',
      code: '123456',
    }));
    expect(mockAuth.refreshAssurance).toHaveBeenCalled();
    await view.unmount();
  });

  test('shows a native MFA factor-list failure without assuming success', async () => {
    const loadFailure = nativeMfaClient({
      listFactors: jest.fn(async () => ({ data: { all: [] }, error: new Error('denied') })),
      getAuthenticatorAssuranceLevel: jest.fn(async () => ({ data: { currentLevel: null }, error: null })),
    });
    mockGetSupabaseClient.mockReturnValue(loadFailure);
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByText('settings.mfaLoadError')).toBeTruthy());
    await view.unmount();
  });

  test('shows a native MFA enrollment failure without assuming success', async () => {
    const enrollFailure = nativeMfaClient({
      listFactors: jest.fn(async () => ({ data: { all: [] }, error: null })),
      getAuthenticatorAssuranceLevel: jest.fn(async () => ({ data: { currentLevel: 'aal1' }, error: null })),
      enroll: jest.fn(async () => ({ data: null, error: new Error('enrollment rejected') })),
    });
    mockGetSupabaseClient.mockReturnValue(enrollFailure);
    const view = await renderAndHydrate();
    await waitForNativeMfaHydration(enrollFailure, 'settings.mfaEnroll');
    // A privileged member without a factor sees the warning line.
    expect(screen.getByText('settings.mfaPrivilegedWarning')).toBeTruthy();
    await pressEnabled('settings.mfaEnroll');
    await waitFor(() => expect(enrollFailure.auth.mfa.enroll).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('settings.mfaEnrollError')).toBeTruthy());
    await view.unmount();
  });

  test('shows a native MFA verification failure without assuming success', async () => {
    const verificationFailure = nativeMfaClient({
      challengeAndVerify: jest.fn(async () => ({ data: null, error: new Error('bad code') })),
    });
    mockGetSupabaseClient.mockReturnValue(verificationFailure);
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaVerify' })).toBeTruthy());
    expect(screen.getByText('settings.mfaAal2')).toBeTruthy();
    await pressEnabled('settings.mfaVerify');
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);
    await pressEnabled('settings.mfaVerify');
    await fireEvent.changeText(screen.getByLabelText('settings.mfaCodeLabel'), '111111');
    await pressEnabled('settings.mfaConfirm');
    await waitFor(() => expect(screen.getAllByText('settings.mfaVerifyError').length).toBeGreaterThan(0));
    await view.unmount();
  });

  test('uses the web MFA boundary for a verified factor', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockAuth = { ...mockAuth, assuranceLevel: null };
    mockListWebMfaFactors.mockResolvedValue([{
      id: 'web-verified', friendlyName: 'Security key', status: 'verified',
    }]);
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaVerify' })).toBeTruthy());
    await pressEnabled('settings.mfaVerify');
    await waitFor(() => expect(mockChallengeWebMfa).toHaveBeenCalledWith('web-verified'));
    await fireEvent.changeText(screen.getByLabelText('settings.mfaCodeLabel'), '654321');
    await pressEnabled('settings.mfaConfirm');
    await waitFor(() => expect(mockVerifyWebMfa).toHaveBeenCalledWith({
      factorId: 'web-verified',
      challengeId: 'web-challenge',
      code: '654321',
    }));
    expect(mockAuth.refreshAssurance).toHaveBeenCalled();
    await view.unmount();
    platform.restore();
  });

  test('uses the web MFA boundary for a new factor and closes an incomplete dialog locally', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockAuth = { ...mockAuth, assuranceLevel: null };
    mockListWebMfaFactors.mockResolvedValue([]);
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaEnroll' })).toBeTruthy());
    await pressEnabled('settings.mfaEnroll');
    await waitFor(() => expect(screen.getByText('CONTROLLEDWEBSECRET')).toBeTruthy());
    expect(mockEnrollWebMfa).toHaveBeenCalledWith('Newone authenticator');
    expect(mockChallengeWebMfa).toHaveBeenCalledWith('web-enrollment');
    await pressEnabled('settings.mfaEnroll');
    expect(mockEnrollWebMfa).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);
    await waitFor(() => expect(screen.queryByText('CONTROLLEDWEBSECRET')).toBeNull());
    await view.unmount();
    platform.restore();
  });

  test('reports a web MFA factor-list dependency failure', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockListWebMfaFactors.mockRejectedValueOnce(new Error('gateway unavailable'));
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByText('settings.mfaLoadError')).toBeTruthy());
    await view.unmount();
    platform.restore();
  });

  test('reports a web MFA enrollment dependency failure', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockListWebMfaFactors.mockResolvedValue([]);
    mockEnrollWebMfa.mockRejectedValueOnce(new Error('enroll denied'));
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaEnroll' })).toBeTruthy());
    await pressEnabled('settings.mfaEnroll');
    await waitFor(() => expect(screen.getByText('settings.mfaEnrollError')).toBeTruthy());
    await view.unmount();
    platform.restore();
  });

  test('reports a web MFA verification dependency failure', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockListWebMfaFactors.mockResolvedValue([{
      id: 'web-verified', friendlyName: 'Verified factor', status: 'verified',
    }]);
    mockVerifyWebMfa.mockRejectedValueOnce(new Error('verify denied'));
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaVerify' })).toBeTruthy());
    await pressEnabled('settings.mfaVerify');
    await waitFor(() => expect(mockChallengeWebMfa).toHaveBeenCalled());
    await fireEvent.changeText(screen.getByLabelText('settings.mfaCodeLabel'), '112233');
    await pressEnabled('settings.mfaConfirm');
    await waitFor(() => expect(screen.getAllByText('settings.mfaVerifyError').length).toBeGreaterThan(0));
    await view.unmount();
    platform.restore();
  });

  test('reports a verified-factor web challenge failure as verification failure', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockListWebMfaFactors.mockResolvedValue([{
      id: 'web-verified', friendlyName: 'Verified factor', status: 'verified',
    }]);
    mockChallengeWebMfa.mockRejectedValueOnce(new Error('challenge denied'));
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaVerify' })).toBeTruthy());
    await pressEnabled('settings.mfaVerify');
    await waitFor(() => expect(screen.getByText('settings.mfaVerifyError')).toBeTruthy());
    await view.unmount();
    platform.restore();
  });

  test('fails closed when the native MFA client disappears before verification', async () => {
    const client = nativeMfaClient({
      getAuthenticatorAssuranceLevel: jest.fn(async () => ({
        data: { currentLevel: 'aal1' },
        error: null,
      })),
    });
    mockGetSupabaseClient.mockReturnValue(client);
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByText('settings.mfaEnrolled')).toBeTruthy());
    await pressEnabled('settings.mfaVerify');
    mockGetSupabaseClient.mockReturnValue(null);
    await fireEvent.changeText(screen.getByLabelText('settings.mfaCodeLabel'), '998877');
    await pressEnabled('settings.mfaConfirm');
    await waitFor(() => expect(screen.getAllByText('settings.mfaVerifyError').length).toBeGreaterThan(0));
    await view.unmount();
  });

  test('gates account deletion behind the exact username before the destructive action enables', async () => {
    mockWorkspace = baseWorkspace({
      currentUser: { ...currentUser, username: 'jordan_owner' },
    });
    const view = await renderAndHydrate();
    expect(screen.getByText('settings.dangerTitle')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.deleteAccount' }));
    expect(screen.getByText('settings.deleteDialogTitle')).toBeTruthy();
    expect(screen.getByText('settings.deleteDialogDescription')).toBeTruthy();

    await fireEvent.press(screen.getAllByLabelText('common.closeDialog').at(-1)!);
    expect(screen.queryByText('settings.deleteDialogTitle')).toBeNull();
    expect(mockAuth.deleteAccount).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.deleteAccount' }));
    const confirmButton = () => screen.getByRole('button', { name: 'settings.deleteConfirm' });
    expect(confirmButton().props.accessibilityState?.disabled).toBe(true);

    await fireEvent.changeText(screen.getByLabelText('settings.deleteConfirmUsername'), 'jordan');
    expect(confirmButton().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(confirmButton());
    expect(mockAuth.deleteAccount).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByLabelText('settings.deleteConfirmUsername'),
      '  jordan_owner  ',
    );
    await pressEnabled('settings.deleteConfirm');
    await waitFor(() => expect(mockAuth.deleteAccount).toHaveBeenCalledTimes(1));
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');
    await view.unmount();
  });

  test('falls back to the DELETE confirmation and completes deletion', async () => {
    const view = await renderAndHydrate();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.deleteAccount' }));
    expect(screen.queryByLabelText('settings.deleteConfirmUsername')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('settings.deleteConfirmFallback'), 'DELETE');
    await pressEnabled('settings.deleteConfirm');
    await waitFor(() => expect(mockAuth.deleteAccount).toHaveBeenCalledTimes(1));
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');
    await view.unmount();
  });

  test('keeps the account and dialog on a rejected deletion and shows the mapped error', async () => {
    mockAuth = {
      ...mockAuth,
      deleteAccount: jest.fn(async () => {
        throw Object.assign(new Error('controlled deletion rejection'), { code: 'http_503' });
      }),
    };
    const view = await renderAndHydrate();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.deleteAccount' }));
    await fireEvent.changeText(screen.getByLabelText('settings.deleteConfirmFallback'), 'DELETE');
    await pressEnabled('settings.deleteConfirm');
    await waitFor(() => expect(screen.getByText('errors.unavailable')).toBeTruthy());
    expect(mockRouter.replace).not.toHaveBeenCalledWith('/sign-in');
    expect(screen.getByText('settings.deleteDialogTitle')).toBeTruthy();
    await view.unmount();
  });

  test('edits the profile in a sheet, gates invalid drafts, and closes on success', async () => {
    mockWorkspace = baseWorkspace({
      currentUser: { ...currentUser, username: 'jordan_owner', statusMessage: 'Original status' },
    });
    const view = await renderAndHydrate();
    expect(screen.queryByLabelText('settings.displayName')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.profileTitle' }));
    await waitFor(() => expect(screen.getByLabelText('settings.displayName').props.value).toBe('Jordan Owner'));
    expect(screen.getByLabelText('settings.statusMessage').props.value).toBe('Original status');
    expect(screen.getByRole('button', { name: 'settings.choosePhoto' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.removePhoto' })).toBeNull();
    const saveButton = () => screen.getByRole('button', { name: 'settings.saveProfile' });
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);

    await fireEvent.changeText(screen.getByLabelText('settings.displayName'), '   ');
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('settings.displayName'), 'n'.repeat(121));
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('settings.displayName'), '  Jordan Renamed  ');
    await fireEvent.changeText(screen.getByLabelText('settings.statusMessage'), 's'.repeat(281));
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.press(saveButton());
    expect(mockWorkspace.updateProfile).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('settings.statusMessage'), ' On shift ');
    await pressEnabled('settings.saveProfile');
    await waitFor(() => expect(mockWorkspace.updateProfile).toHaveBeenCalledWith({
      displayName: '  Jordan Renamed  ',
      statusMessage: ' On shift ',
    }));
    expect(mockWorkspace.updateProfile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByLabelText('settings.displayName')).toBeNull());
    await view.unmount();
  });

  test('keeps the profile draft bound to the authoritative user and offers photo removal', async () => {
    mockWorkspace = baseWorkspace({
      profileAvatarUrls: { 'user-owner': 'https://cdn.example/avatar.jpg' },
      requestProfileAvatar: jest.fn(),
    });
    const view = await renderAndHydrate();
    await fireEvent.press(screen.getByRole('button', { name: 'settings.profileTitle' }));
    await waitFor(() => expect(screen.getByLabelText('settings.displayName').props.value).toBe('Jordan Owner'));
    expect(screen.getByLabelText('settings.statusMessage').props.value).toBe('');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.removePhoto' }));
    expect(mockWorkspace.removeProfileAvatar).toHaveBeenCalledTimes(1);
    const saveButton = () => screen.getByRole('button', { name: 'settings.saveProfile' });
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);

    // A status-only change is a real edit; trailing whitespace alone is not.
    await fireEvent.changeText(screen.getByLabelText('settings.displayName'), 'Jordan Owner  ');
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('settings.statusMessage'), 'Back at nine');
    expect(saveButton().props.accessibilityState?.disabled).toBe(false);

    // The authoritative user changes (the receipt landed): the draft follows
    // the server, never the text left in the inputs.
    mockWorkspace = {
      ...mockWorkspace,
      currentUser: { ...currentUser, displayName: 'Jordan Renamed', statusMessage: 'Back at nine' },
    };
    await view.rerender(<SettingsScreen />);
    await waitFor(() => expect(screen.getByLabelText('settings.displayName').props.value).toBe('Jordan Owner  '));
    expect(screen.getByText('Jordan Renamed')).toBeTruthy();
    await view.unmount();
  });

  test('renders loading and unavailable states without guessing', async () => {
    mockLocale = 'es';
    mockWorkspace = baseWorkspace({
      actionBusy: 'account-settings-load',
      actionError: 'Authoritative settings unavailable.',
      organizationPreferences: null,
      deviceNotificationPreferences: null,
      accountSessions: [],
      capabilities: [],
    });
    mockAuth = { ...mockAuth, sessionId: null, assuranceLevel: null };
    mockGetSupabaseClient.mockReturnValue(null);
    const view = await render(<SettingsScreen />);
    await waitFor(() => expect(mockGetSupabaseClient).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText('Authoritative settings unavailable.').length).toBeGreaterThan(0));
    expect(screen.getByText('settings.noOtherSessions')).toBeTruthy();
    expect(screen.getByText('settings.spanish')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.revokeCurrent' })).toBeNull();
    // Account preference rows wait for the draft.
    expect(screen.getByLabelText('settings.sound').props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'settings.quietHours' }).props.accessibilityState?.disabled).toBe(true);
    // Permission granted but no device binding: the switch is off.
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    expect(switchValue('settings.notifications')).toBe(false);
    await pressEnabled('settings.mfaEnroll');
    expect(screen.queryByText('settings.mfaEnrollDialog')).toBeNull();
    await view.unmount();
  });
});

describe('notifications switch', () => {
  test('is on when the OS allows and the device is bound, and turning it off mutes this device on the server', async () => {
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    expect(switchValue('settings.notifications')).toBe(true);
    expect(screen.queryByText('settings.notificationsMuted')).toBeNull();
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', false);
    await waitFor(() => expect(mockWorkspace.setDeviceNotificationsMuted).toHaveBeenCalledWith(true));
    expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('is off with a "Muted" hint while the server mutes this device; turning it on unmutes without re-binding', async () => {
    mockWorkspace = baseWorkspace({ deviceNotificationsMuted: true });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    expect(switchValue('settings.notifications')).toBe(false);
    expect(screen.getByText('settings.notificationsMuted')).toBeTruthy();
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', true);
    await waitFor(() => expect(mockWorkspace.setDeviceNotificationsMuted).toHaveBeenCalledWith(false));
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('stays off and does not bind when the unmute fails', async () => {
    mockWorkspace = baseWorkspace({
      deviceNotificationsMuted: true,
      setDeviceNotificationsMuted: successfulAction(false),
    });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', true);
    await waitFor(() => expect(mockWorkspace.setDeviceNotificationsMuted).toHaveBeenCalledWith(false));
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    expect(switchValue('settings.notifications')).toBe(false);
    await view.unmount();
  });

  test('a denied OS permission still goes to the system settings, muted or not', async () => {
    mockPermission = 'denied';
    mockWorkspace = baseWorkspace({ deviceNotificationsMuted: true });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    expect(switchValue('settings.notifications')).toBe(false);
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', true);
    await waitFor(() => expect(mockOpenNotificationSettings).toHaveBeenCalledTimes(1));
    expect(mockWorkspace.setDeviceNotificationsMuted).not.toHaveBeenCalled();
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('unmutes first, then binds the device while the OS permission is still undetermined', async () => {
    mockPermission = 'undetermined';
    mockWorkspace = baseWorkspace({ deviceNotificationsMuted: true });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', true);
    await waitFor(() => expect(mockWorkspace.enableNotifications).toHaveBeenCalledTimes(1));
    expect(mockWorkspace.setDeviceNotificationsMuted).toHaveBeenCalledWith(false);
    expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('is busy while the mute is being saved', async () => {
    mockWorkspace = baseWorkspace({ actionBusy: 'device-mute-save' });
    const view = await renderAndHydrate();
    expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(true);
    await view.unmount();
  });

  test('asks the OS and binds the device when permission is undetermined', async () => {
    mockPermission = 'undetermined';
    mockWorkspace = baseWorkspace({ deviceNotificationPreferences: null });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    expect(switchValue('settings.notifications')).toBe(false);
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', true);
    await waitFor(() => expect(mockWorkspace.enableNotifications).toHaveBeenCalledTimes(1));
    expect(mockOpenNotificationSettings).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('sends a denied permission to the system settings instead of a prompt that cannot appear', async () => {
    mockPermission = 'denied';
    mockWorkspace = baseWorkspace({ deviceNotificationPreferences: null });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', true);
    await waitFor(() => expect(mockOpenNotificationSettings).toHaveBeenCalledTimes(1));
    expect(mockWorkspace.enableNotifications).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('binds the device by itself when the user comes back from the system settings with permission granted', async () => {
    mockPermission = 'denied';
    mockWorkspace = baseWorkspace({ deviceNotificationPreferences: null });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    // React Native's test setup already mocks AppState; read the registered
    // listener from it rather than spying (a restore would wipe the mock).
    const addListener = AppState.addEventListener as unknown as { mock: { calls: unknown[][] } };
    const listener = addListener.mock.calls.find(([event]) => event === 'change')?.[1] as
      ((state: string) => void) | undefined;
    expect(listener).toBeDefined();

    mockPermission = 'granted';
    await act(async () => {
      listener?.('active');
    });
    await waitFor(() => expect(mockWorkspace.enableNotifications).toHaveBeenCalledTimes(1));
    await view.unmount();
  });

  test('stays off and shows the mapped failure when the device cannot be bound', async () => {
    mockPermission = 'undetermined';
    mockWorkspace = baseWorkspace({
      deviceNotificationPreferences: null,
      enableNotifications: successfulAction(false),
    });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.notifications').props.accessibilityState?.disabled).toBe(false));
    await fireEvent(screen.getByLabelText('settings.notifications'), 'valueChange', true);
    await waitFor(() => expect(mockWorkspace.enableNotifications).toHaveBeenCalledTimes(1));

    mockWorkspace = { ...mockWorkspace, actionError: 'errors.pushNeedsDevice' };
    await view.rerender(<SettingsScreen />);
    expect(switchValue('settings.notifications')).toBe(false);
    expect(screen.getAllByText('errors.pushNeedsDevice').length).toBeGreaterThan(0);
    await view.unmount();
  });

  test('is absent where the platform cannot receive pushes', async () => {
    mockPermission = 'unavailable';
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.queryByLabelText('settings.notifications')).toBeNull());
    expect(screen.getByLabelText('settings.sound')).toBeTruthy();
    await view.unmount();
  });
});

describe('personal realm settings', () => {
  test('hides workplace-only sections and signs other devices out without a reason', async () => {
    mockWorkspace = baseWorkspace({ organizationId: PERSONAL_REALM_ORGANIZATION_ID });
    const view = await renderAndHydrate();
    await waitFor(() => expect(mockWorkspace.loadAccountSettings).toHaveBeenCalled());

    // Hidden: authenticator, lost-authenticator recovery, shift switch, session revocation.
    expect(screen.queryByText('settings.securityTitle')).toBeNull();
    expect(screen.queryByText('settings.mfaTitle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.mfaEnroll' })).toBeNull();
    expect(screen.queryAllByText('Request lost-authenticator recovery')).toHaveLength(0);
    expect(screen.queryByLabelText('settings.shiftSuppression')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.revokeCurrent' })).toBeNull();
    // No authenticator hydration is attempted for a consumer account.
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();

    // Everything consumer-relevant stays.
    for (const title of [
      'settings.generalTitle', 'settings.chatsTitle', 'settings.notificationsTitle',
      'settings.sessionsTitle', 'settings.dangerTitle',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'settings.profileTitle' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.help' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.signOut' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.deleteAccount' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeSession' }));
    expect(screen.getByText('settings.signOutDeviceTitle')).toBeTruthy();
    expect(screen.queryByLabelText('settings.revokeReason')).toBeNull();
    await pressEnabled('settings.signOutDeviceConfirm');
    await waitFor(() => expect(mockWorkspace.revokeSession).toHaveBeenCalledWith('session-other', 'sign_out'));
    await waitFor(() => expect(screen.queryByText('settings.signOutDeviceTitle')).toBeNull());
    await view.unmount();
  });

  test('keeps every workplace section for a workspace organization', async () => {
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaVerify' })).toBeTruthy());
    expect(screen.getByText('settings.securityTitle')).toBeTruthy();
    expect(screen.getByText('settings.mfaTitle')).toBeTruthy();
    expect(screen.getByLabelText('settings.shiftSuppression')).toBeTruthy();
    expect(screen.getAllByText('Request lost-authenticator recovery').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'settings.revokeCurrent' })).toBeTruthy();
    expect(mockGetSupabaseClient).toHaveBeenCalled();
    await view.unmount();
  });
});
