import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

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
const mockListWebMfaFactors = jest.fn<() => Promise<ControlledWebFactor[]>>();
const mockChallengeWebMfa = jest.fn<(factorId: string) => Promise<{ challengeId: string }>>();
const mockEnrollWebMfa = jest.fn<(friendlyName: string) => Promise<ControlledEnrollment>>();
const mockVerifyWebMfa = jest.fn<(input: ControlledVerification) => Promise<void>>();
const mockGetSupabaseClient = jest.fn<() => any>();
const mockTranslate = (key: string) => key;

let mockWidth = 760;
let mockLocale: 'en' | 'ko' | 'es' = 'en';
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

jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 900 }),
}));

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

function baseWorkspace(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: '20000000-0000-4000-8000-000000000001',
    currentUser,
    capabilities: ['communications.publish'],
    conversations: [{ id: 'conversation-a', title: 'Operations' }],
    organizationPreferences,
    deviceNotificationPreferences: devicePreferences,
    accountSessions: [{
      sessionId: 'session-other',
      current: false,
      platform: 'web',
      device: { appVersion: '2.3.4' },
      signal: { clientFamily: 'desktop' },
      lastUsedAt: '2030-01-02T03:04:05.000Z',
      revoked: false,
    }, {
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
    loadAccountSettings: successfulAction(),
    saveOrganizationPreferences: successfulAction(true),
    enableNotifications: successfulAction(),
    loadDeviceNotificationPreferences: successfulAction(),
    saveDeviceNotificationPreferences: successfulAction(),
    updateProfile: successfulAction(true),
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
  mockWidth = 760;
  mockLocale = 'en';
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
    view.unmount();
  });

  test('executes account, device, session, navigation, and sign-out interactions', async () => {
    mockWidth = 390;
    const view = await renderAndHydrate();

    await fireEvent.press(screen.getByLabelText('settings.close'));
    expect(mockRouter.back).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText('settings.displayLanguage: settings.korean'));
    expect(mockSetLocale).toHaveBeenCalledWith('ko');

    await fireEvent.press(screen.getByLabelText('settings.messageLanguage: settings.spanish'));
    await fireEvent.changeText(screen.getByLabelText('settings.quietStart'), 'bad');
    await fireEvent(screen.getByLabelText('settings.shiftSuppression'), 'valueChange', true);
    await fireEvent(screen.getByLabelText('settings.sound'), 'valueChange', false);
    await fireEvent(screen.getByLabelText('settings.vibration'), 'valueChange', false);
    await fireEvent.press(screen.getByRole('button', { name: 'settings.savePreferences' }));
    expect(mockWorkspace.saveOrganizationPreferences).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('settings.quietStart'), '20:15');
    await fireEvent.changeText(screen.getByLabelText('settings.quietEnd'), '07:45');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.savePreferences' }));
    await waitFor(() => expect(mockWorkspace.saveOrganizationPreferences).toHaveBeenCalledWith(
      expect.objectContaining({
        uiLanguage: 'en',
        messageLanguage: 'es',
        quietHoursStart: '20:15',
        quietHoursEnd: '07:45',
        shiftAwareSuppression: true,
        soundEnabled: false,
        vibrationEnabled: false,
      }),
    ));

    const genericButtons = screen.getAllByText('settings.previewGeneric');
    await fireEvent.press(genericButtons[genericButtons.length - 1]!);
    const disabledButtons = screen.getAllByText('settings.disabled');
    await fireEvent.press(disabledButtons[0]!);
    const enabledButtons = screen.getAllByText('settings.enabled');
    await fireEvent.press(enabledButtons[enabledButtons.length - 1]!);
    await fireEvent.press(screen.getByRole('button', { name: 'settings.refreshDevicePreferences' }));
    await fireEvent.press(screen.getByRole('button', { name: 'settings.saveDevicePreferences' }));
    expect(mockWorkspace.loadDeviceNotificationPreferences).toHaveBeenCalled();
    expect(mockWorkspace.saveDeviceNotificationPreferences).toHaveBeenCalledWith(expect.objectContaining({
      notificationPreview: 'generic',
    }));

    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeSession' }));
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

    await fireEvent.press(screen.getByRole('button', { name: 'settings.help' }));
    expect(mockRouter.push).toHaveBeenCalledWith('./help');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.signOut' }));
    await waitFor(() => expect(mockAuth.signOut).toHaveBeenCalled());
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');
    view.unmount();
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
    view.unmount();
  });

  test('shows a native MFA factor-list failure without assuming success', async () => {
    const loadFailure = nativeMfaClient({
      listFactors: jest.fn(async () => ({ data: { all: [] }, error: new Error('denied') })),
      getAuthenticatorAssuranceLevel: jest.fn(async () => ({ data: { currentLevel: null }, error: null })),
    });
    mockGetSupabaseClient.mockReturnValue(loadFailure);
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByText('settings.mfaLoadError')).toBeTruthy());
    view.unmount();
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
    await pressEnabled('settings.mfaEnroll');
    await waitFor(() => expect(enrollFailure.auth.mfa.enroll).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('settings.mfaEnrollError')).toBeTruthy());
    view.unmount();
  });

  test('shows a native MFA verification failure without assuming success', async () => {
    const verificationFailure = nativeMfaClient({
      challengeAndVerify: jest.fn(async () => ({ data: null, error: new Error('bad code') })),
    });
    mockGetSupabaseClient.mockReturnValue(verificationFailure);
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaVerify' })).toBeTruthy());
    await pressEnabled('settings.mfaVerify');
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);
    await pressEnabled('settings.mfaVerify');
    await fireEvent.changeText(screen.getByLabelText('settings.mfaCodeLabel'), '111111');
    await pressEnabled('settings.mfaConfirm');
    await waitFor(() => expect(screen.getAllByText('settings.mfaVerifyError').length).toBeGreaterThan(0));
    view.unmount();
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
    view.unmount();
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
    view.unmount();
    platform.restore();
  });

  test('reports a web MFA factor-list dependency failure', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockListWebMfaFactors.mockRejectedValueOnce(new Error('gateway unavailable'));
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByText('settings.mfaLoadError')).toBeTruthy());
    view.unmount();
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
    view.unmount();
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
    view.unmount();
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
    view.unmount();
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
    view.unmount();
  });

  test('covers alternate preference, device, outbox, session, and pressed interaction states', async () => {
    mockLocale = 'ko';
    const savePreferences = successfulAction(false);
    const revokeSession = successfulAction(false);
    mockWorkspace = baseWorkspace({
      organizationPreferences: {
        ...organizationPreferences,
        quietHoursStart: null,
        quietHoursEnd: null,
        notificationPreview: 'hidden',
        readVisibility: 'nobody',
      },
      deviceNotificationPreferences: {
        ...devicePreferences,
        effective: {
          notificationPreview: 'hidden',
          soundEnabled: false,
          vibrationEnabled: true,
        },
      },
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
      }, {
        id: 'outbox-unknown',
        conversationId: 'conversation-missing',
        clientMessageId: 'client-unknown',
        body: 'Controlled failed body',
        createdAt: '2030-01-02T00:00:00.000Z',
        attempts: 2,
        state: 'failed',
        lastErrorCode: 'network_unavailable',
        canEdit: false,
        canRetry: true,
        deliveryAmbiguous: true,
      }],
      accountSessions: [{
        sessionId: 'session-native-other',
        current: false,
        platform: 'ios',
        device: null,
        signal: { clientFamily: 'iphone' },
        lastUsedAt: '2030-01-03T00:00:00.000Z',
        revoked: false,
      }],
      saveOrganizationPreferences: savePreferences,
      revokeSession,
    });
    mockAuth = { ...mockAuth, session: null };
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByText('한국어')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Operations')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.savePreferences' })).toBeTruthy());
    await waitFor(() => expect(screen.getByText('settings.currentDevicePreferences')).toBeTruthy());
    expect(screen.getByText('더 이상 이용할 수 없는 대화')).toBeTruthy();
    expect(screen.getByText('iphone')).toBeTruthy();

    const displayKorean = screen.getByLabelText('settings.displayLanguage: settings.korean');
    await fireEvent(displayKorean, 'pressIn');
    await fireEvent(displayKorean, 'pressOut');
    const autoLanguage = screen.getByLabelText('settings.messageLanguage: settings.messageLanguageAuto');
    await fireEvent(autoLanguage, 'pressIn');
    await fireEvent.press(autoLanguage);
    await fireEvent.press(screen.getAllByText('settings.previewGeneric')[0]!);
    await fireEvent.press(screen.getByText('settings.readContacts'));
    await fireEvent.changeText(screen.getByLabelText('settings.quietStart'), '18:00');
    await fireEvent.changeText(screen.getByLabelText('settings.quietStart'), '');
    await fireEvent.changeText(screen.getByLabelText('settings.quietEnd'), '');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.savePreferences' }));
    await waitFor(() => expect(savePreferences).toHaveBeenCalled());

    const hiddenDevice = screen.getByText('settings.previewHiddenDevice');
    await fireEvent(hiddenDevice, 'pressIn');
    await fireEvent.press(hiddenDevice);
    const enabled = screen.getAllByText('settings.enabled');
    await fireEvent(enabled[0]!, 'pressIn');
    await fireEvent.press(enabled[0]!);

    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeSession' }));
    await fireEvent.changeText(screen.getByLabelText('settings.revokeReason'), 'Keep active after review');
    await fireEvent.press(screen.getByRole('button', { name: 'settings.revokeConfirm' }));
    await waitFor(() => expect(revokeSession).toHaveBeenCalledWith(
      'session-native-other',
      'Keep active after review',
    ));
    expect(mockRouter.replace).not.toHaveBeenCalledWith('/sign-in');
    view.unmount();
  });

  test('gates account deletion behind the exact username before the destructive action enables', async () => {
    mockWidth = 390;
    mockWorkspace = baseWorkspace({
      currentUser: { ...currentUser, username: 'jordan_owner' },
    });
    const view = await renderAndHydrate();

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
    view.unmount();
  });

  test('falls back to the DELETE confirmation and completes deletion on desktop widths', async () => {
    mockWidth = 1280;
    const view = await renderAndHydrate();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.deleteAccount' }));
    expect(screen.queryByLabelText('settings.deleteConfirmUsername')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText('settings.deleteConfirmFallback'), 'DELETE');
    await pressEnabled('settings.deleteConfirm');
    await waitFor(() => expect(mockAuth.deleteAccount).toHaveBeenCalledTimes(1));
    expect(mockRouter.replace).toHaveBeenCalledWith('/sign-in');
    view.unmount();
  });

  test('keeps the account and dialog on a rejected deletion and shows the mapped error', async () => {
    mockWidth = 1280;
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
    view.unmount();
  });

  test('saves a profile edit through the workspace on compact widths and gates invalid drafts', async () => {
    mockWidth = 390;
    mockWorkspace = baseWorkspace({
      currentUser: { ...currentUser, username: 'jordan_owner', statusMessage: 'Original status' },
    });
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.displayName').props.value).toBe('Jordan Owner'));
    expect(screen.getByLabelText('settings.statusMessage').props.value).toBe('Original status');
    expect(screen.getByText('settings.usernameNote @jordan_owner')).toBeTruthy();
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
    view.unmount();
  });

  test('keeps the profile draft bound to the authoritative user on desktop widths', async () => {
    mockWidth = 1280;
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByLabelText('settings.displayName').props.value).toBe('Jordan Owner'));
    expect(screen.getByLabelText('settings.statusMessage').props.value).toBe('');
    expect(screen.queryByText(/settings\.usernameNote/)).toBeNull();
    const saveButton = () => screen.getByRole('button', { name: 'settings.saveProfile' });
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);

    // A status-only change is a real edit; trailing whitespace alone is not.
    await fireEvent.changeText(screen.getByLabelText('settings.displayName'), 'Jordan Owner  ');
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    await fireEvent.changeText(screen.getByLabelText('settings.statusMessage'), 'Back at nine');
    await pressEnabled('settings.saveProfile');
    await waitFor(() => expect(mockWorkspace.updateProfile).toHaveBeenCalledWith({
      displayName: 'Jordan Owner  ',
      statusMessage: 'Back at nine',
    }));

    // The authoritative user changes (the receipt landed): the draft follows
    // the server, never the text left in the inputs.
    mockWorkspace = baseWorkspace({
      currentUser: { ...currentUser, displayName: 'Jordan Renamed', statusMessage: 'Back at nine' },
    });
    view.rerender(<SettingsScreen />);
    await waitFor(() => expect(screen.getByLabelText('settings.displayName').props.value).toBe('Jordan Renamed'));
    expect(screen.getByLabelText('settings.statusMessage').props.value).toBe('Back at nine');
    expect(screen.getByText('Jordan Renamed')).toBeTruthy();
    expect(saveButton().props.accessibilityState?.disabled).toBe(true);
    view.unmount();
  });

  test('renders authoritative loading and unavailable preference/device/session states', async () => {
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
    expect(screen.getByText('settings.devicePreferencesUnavailable')).toBeTruthy();
    expect(screen.getByText('settings.noOtherSessions')).toBeTruthy();
    expect(screen.getByText('Español')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'settings.enableNotifications' }));
    expect(mockWorkspace.enableNotifications).toHaveBeenCalled();
    await pressEnabled('settings.mfaEnroll');
    expect(screen.queryByText('settings.mfaEnrollDialog')).toBeNull();
    view.unmount();
  });
});

describe('device notification registration failures', () => {
  test.each([390, 1280])('keeps the device unregistered and shows the mapped failure at width %i', async (width) => {
    mockWidth = width;
    mockWorkspace = baseWorkspace({
      deviceNotificationPreferences: null,
      enableNotifications: successfulAction(false),
    });
    const view = await renderAndHydrate();
    fireEvent.press(screen.getByRole('button', { name: 'settings.enableNotifications' }));
    await waitFor(() => expect(mockWorkspace.enableNotifications).toHaveBeenCalledTimes(1));

    // The provider reports the failure; the screen must not flip to a
    // registered device and keeps offering the action.
    mockWorkspace = { ...mockWorkspace, actionError: 'errors.pushNeedsDevice' };
    await view.rerender(<SettingsScreen />);
    expect(screen.getByRole('button', { name: 'settings.enableNotifications' })).toBeTruthy();
    expect(screen.queryByText(/settings\.currentDevice ·/)).toBeNull();
    expect(screen.getAllByText('errors.pushNeedsDevice').length).toBeGreaterThan(0);
    view.unmount();
  });
});

describe('personal realm settings', () => {
  test.each([390, 1280])('hides workplace-only sections and rewords shared notes at width %i', async (width) => {
    mockWidth = width;
    mockWorkspace = baseWorkspace({ organizationId: PERSONAL_REALM_ORGANIZATION_ID });
    const view = await renderAndHydrate();
    await waitFor(() => expect(mockWorkspace.loadAccountSettings).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText('settings.sound').length).toBeGreaterThan(0));

    // Hidden: authenticator, lost-authenticator recovery, administrator note, shift switch.
    expect(screen.queryByText('settings.mfaTitle')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.mfaEnroll' })).toBeNull();
    expect(screen.queryAllByText('Request lost-authenticator recovery')).toHaveLength(0);
    expect(screen.queryByText('settings.privateDmNote')).toBeNull();
    expect(screen.queryByText('settings.shiftSuppression')).toBeNull();
    expect(screen.queryByText('settings.companyVerified')).toBeNull();
    expect(screen.queryByText('settings.preferencesDescription')).toBeNull();
    expect(screen.queryByText('settings.deviceNotificationsNote')).toBeNull();
    expect(screen.queryByText('settings.devicePreferencesBoundary')).toBeNull();
    // No authenticator hydration is attempted for a consumer account.
    expect(mockGetSupabaseClient).not.toHaveBeenCalled();

    // Consumer wording replaces the shared notes.
    expect(screen.getByText('settings.accountVerified')).toBeTruthy();
    expect(screen.getByText('settings.preferencesDescriptionConsumer')).toBeTruthy();
    expect(screen.getByText('settings.deviceNotificationsNoteConsumer')).toBeTruthy();
    expect(screen.getByText('settings.devicePreferencesBoundaryConsumer')).toBeTruthy();

    // Everything consumer-relevant stays.
    for (const title of [
      'settings.profileTitle', 'settings.languageTitle', 'settings.notificationsTitle',
      'settings.sessionsTitle', 'settings.dangerTitle',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText('settings.sessionsDescription')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.signOut' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.deleteAccount' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.saveProfile' })).toBeTruthy();
    view.unmount();
  });

  test('keeps every workplace section for a workspace organization', async () => {
    mockWidth = 390;
    const view = await renderAndHydrate();
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.mfaEnroll' })).toBeTruthy());
    await waitFor(() => expect(screen.getByText('settings.shiftSuppression')).toBeTruthy());
    expect(screen.getByText('settings.mfaTitle')).toBeTruthy();
    expect(screen.getAllByText('Request lost-authenticator recovery').length).toBeGreaterThan(0);
    expect(screen.getByText('settings.privateDmNote')).toBeTruthy();
    expect(screen.getByText('settings.companyVerified')).toBeTruthy();
    expect(screen.getByText('settings.preferencesDescription')).toBeTruthy();
    expect(screen.getByText('settings.deviceNotificationsNote')).toBeTruthy();
    expect(screen.queryByText('settings.accountVerified')).toBeNull();
    expect(screen.queryByText('settings.preferencesDescriptionConsumer')).toBeNull();
    expect(mockGetSupabaseClient).toHaveBeenCalled();
    view.unmount();
  });
});
