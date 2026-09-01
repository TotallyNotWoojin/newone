import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Platform } from 'react-native';

import SignInScreen from '@/app/sign-in';
import { RepositoryError } from '@/data/repositories/contracts';

jest.setTimeout(20_000);

const mockRouter = { push: jest.fn(), replace: jest.fn() };
let mockWidth = 390;
let mockAuth: Record<string, any>;
let mockWebAuthBlocked = false;
let mockLocale: 'en' | 'ko' | 'es' = 'en';
const mockSetLocale = jest.fn((nextLocale: 'en' | 'ko' | 'es') => {
  mockLocale = nextLocale;
});

jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));
jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
  };
});
jest.mock('@/hooks/use-hydration-safe-window-dimensions', () => ({
  useHydrationSafeWindowDimensions: () => ({ width: mockWidth, height: 844 }),
}));
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: mockLocale, setLocale: mockSetLocale, t: (key: string) => key }),
}));
jest.mock('@/state/auth', () => ({ useAuth: () => mockAuth }));
jest.mock('@/lib/supabase', () => ({
  get isWebAuthBlocked() { return mockWebAuthBlocked; },
}));
jest.mock('@/components/security/captcha-challenge', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    CaptchaChallenge: ({ label, onError, onToken }: {
      label: string;
      onError: () => void;
      onToken: (token: string | null) => void;
    }) => (
      <ReactNative.View>
        <ReactNative.Pressable accessibilityLabel={label} onPress={() => onToken('controlled-captcha-token-value')}>
          <ReactNative.Text>{label}</ReactNative.Text>
        </ReactNative.Pressable>
        <ReactNative.Pressable accessibilityLabel="controlled-captcha-error" onPress={onError}>
          <ReactNative.Text>captcha error</ReactNative.Text>
        </ReactNative.Pressable>
      </ReactNative.View>
    ),
  };
});

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function successfulAction(value: unknown = undefined) {
  return jest.fn(async (..._mockArgs: unknown[]) => value);
}

function authState(overrides: Record<string, unknown> = {}) {
  return {
    error: null,
    requestOtp: successfulAction({ channelConfigured: true }),
    verifyOtp: successfulAction(),
    requestSignup: successfulAction(),
    verifySignup: successfulAction(),
    requestRecoveryOtp: successfulAction({ channelConfigured: true }),
    verifyRecoveryOtp: successfulAction({ otherSessionsRevoked: true }),
    ...overrides,
  };
}

beforeEach(() => {
  mockWidth = 390;
  mockWebAuthBlocked = false;
  mockLocale = 'en';
  mockAuth = authState();
});

afterEach(() => {
  if (originalWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

async function solveCaptcha() {
  await fireEvent.press(screen.getByLabelText('auth.challengeLabel'));
}

describe('sign-in and account recovery screen', () => {
  test('validates returning identity, honors channel availability, and verifies the exact OTP', async () => {
    mockAuth = authState({
      requestOtp: jest.fn<(..._args: unknown[]) => Promise<{ channelConfigured: boolean }>>()
        .mockResolvedValueOnce({ channelConfigured: false })
        .mockResolvedValueOnce({ channelConfigured: true }),
    });
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.emailChannel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.firstUse' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    const emailInput = screen.getByLabelText('auth.emailLabel');
    await fireEvent(emailInput, 'focus');
    await fireEvent(emailInput, 'blur');
    await fireEvent.changeText(emailInput, 'not-an-email');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.emailInvalid')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), ' PERSON@Example.COM ');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.challengeRequired')).toBeTruthy();
    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.channelUnavailable')).toBeTruthy());
    expect(mockAuth.requestOtp).toHaveBeenNthCalledWith(1, {
      destinationType: 'email',
      destination: 'person@example.com',
      captchaToken: 'controlled-captcha-token-value',
    });

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByLabelText('auth.codeA11y')).toBeTruthy());
    expect(screen.getByText('auth.otpSent')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '123');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignIn' }));
    expect(screen.getByText('auth.codeInvalid')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '123 456');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignIn' }));
    await waitFor(() => expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      destinationType: 'email', destination: 'person@example.com', code: '123456',
    }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await view.unmount();
  });

  test('normalizes phone enrollment credentials and safely returns to another identity', async () => {
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.firstUse' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.phoneChannel' }));
    await fireEvent.changeText(screen.getByLabelText('auth.invitationTokenLabel'), 'bad-token');
    await fireEvent.changeText(screen.getByLabelText('auth.employeeCodeLabel'), ' EMP-42 ');
    await fireEvent.changeText(screen.getByLabelText('auth.phoneLabel'), '+1 (555) 555-0100');
    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.invitationTokenInvalid')).toBeTruthy();

    const invitation = 'A'.repeat(64);
    await fireEvent.changeText(screen.getByLabelText('auth.invitationTokenLabel'), invitation);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(mockAuth.requestOtp).toHaveBeenCalledWith({
      destinationType: 'phone',
      destination: '+15555550100',
      captchaToken: 'controlled-captcha-token-value',
      invitationToken: invitation.toLowerCase(),
      employeeCode: 'EMP-42',
    }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.differentIdentity' }));
    expect(screen.getByLabelText('auth.phoneLabel')).toBeTruthy();

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '654321');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignIn' }));
    await waitFor(() => expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      destinationType: 'phone',
      destination: '+15555550100',
      invitationToken: invitation.toLowerCase(),
      employeeCode: 'EMP-42',
      code: '654321',
    }));
    await view.unmount();
  });

  test('executes recovery only through the recovery methods and localizes transport failures', async () => {
    mockAuth = authState({
      requestRecoveryOtp: jest.fn<(..._args: unknown[]) => Promise<{ channelConfigured: boolean }>>()
        .mockRejectedValueOnce(new RepositoryError('upstream secret', 'network_unavailable', true))
        .mockResolvedValueOnce({ channelConfigured: true }),
      verifyRecoveryOtp: jest.fn<(..._args: unknown[]) => Promise<{ otherSessionsRevoked: boolean }>>()
        .mockRejectedValueOnce(new RepositoryError('wrong code detail', 'invalid_query', false))
        .mockResolvedValueOnce({ otherSessionsRevoked: true }),
    });
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.recovery' }));
    expect(screen.getByText('auth.recoveryWarning')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), 'recover@example.com');
    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('errors.network')).toBeTruthy());
    expect(screen.queryByText('upstream secret')).toBeNull();
    expect(mockAuth.requestOtp).not.toHaveBeenCalled();

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.recoveryOtpSent')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '111111');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifyRecovery' }));
    await waitFor(() => expect(screen.getByText('errors.invalidRequest')).toBeTruthy());
    expect(screen.queryByText('wrong code detail')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifyRecovery' }));
    await waitFor(() => expect(mockAuth.verifyRecoveryOtp).toHaveBeenCalledTimes(2));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');

    await fireEvent.press(screen.getByRole('link', { name: 'auth.help' }));
    expect(mockRouter.push).toHaveBeenCalledWith('./help');
    await view.unmount();
  });

  test('reports challenge failure and disables an intentionally blocked web gateway', async () => {
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByLabelText('controlled-captcha-error'));
    expect(screen.getByText('auth.challengeUnavailable')).toBeTruthy();
    await view.unmount();

    mockWebAuthBlocked = true;
    const blocked = await render(<SignInScreen />);
    expect(screen.getByText('auth.webLocked')).toBeTruthy();
    expect(screen.queryByLabelText('auth.challengeLabel')).toBeNull();
    expect(screen.getByRole('button', { name: 'auth.webNotConfigured' })).toBeTruthy();
    await fireEvent(screen.getByLabelText('auth.signupEmailLabel'), 'submitEditing');
    await blocked.unmount();
  });

  test.each([390, 1280])('creates a consumer account through signup request and verification at width %d', async (width) => {
    mockWidth = width;
    const platform = width >= 920 ? jest.replaceProperty(Platform, 'OS', 'web') : null;
    if (platform) {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
          location: { href: 'https://newone.example/sign-in' },
          history: { state: null, replaceState: jest.fn() },
        },
      });
    }
    const view = await render(<SignInScreen />);
    expect(screen.getByText('auth.titleSignup')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'auth.emailChannel' })).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('auth.signupEmailLabel'), ' New.Person@Example.COM ');
    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'River_Runner_7');
    expect(screen.getByLabelText('auth.usernameLabel').props.value).toBe('river_runner_7');
    expect(screen.getByText('auth.usernameHelp')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('auth.displayNameLabel'), ' River Runner ');
    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.signupOtpSent')).toBeTruthy());
    expect(mockAuth.requestSignup).toHaveBeenCalledWith({
      destination: 'new.person@example.com',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'en',
      captchaToken: 'controlled-captcha-token-value',
    });

    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '246 810');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignup' }));
    await waitFor(() => expect(mockAuth.verifySignup).toHaveBeenCalledWith({
      destination: 'new.person@example.com',
      code: '246810',
    }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await view.unmount();
    platform?.restore();
  });

  test('validates every signup field locally before any request leaves the device', async () => {
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.phoneChannel' }));
    await fireEvent.changeText(screen.getByLabelText('auth.phoneLabel'), '+15555550100');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.modeSignup' }));
    const emailAfterPhone = screen.getByLabelText('auth.signupEmailLabel');
    expect(emailAfterPhone.props.value).toBe('');

    await fireEvent.changeText(emailAfterPhone, 'not-an-email');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.signupEmailInvalid')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('auth.signupEmailLabel'), 'new.person@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.challengeRequired')).toBeTruthy();

    await solveCaptcha();
    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), '_Under_First_');
    expect(screen.getByLabelText('auth.usernameLabel').props.value).toBe('_under_first_');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.usernameInvalid')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'ab');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.usernameInvalid')).toBeTruthy();

    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'river_runner_7');
    await fireEvent.changeText(screen.getByLabelText('auth.displayNameLabel'), '   ');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    expect(screen.getByText('auth.displayNameInvalid')).toBeTruthy();

    expect(mockAuth.requestSignup).not.toHaveBeenCalled();
    expect(mockAuth.requestOtp).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('maps signup rejections to local catalog copy and restores an expired signup form intact', async () => {
    mockAuth = authState({
      requestSignup: jest.fn<(..._args: unknown[]) => Promise<void>>()
        .mockRejectedValueOnce(new RepositoryError('upstream taken detail', 'username_taken', false))
        .mockRejectedValueOnce(new RepositoryError('upstream reserved detail', 'username_reserved', false))
        .mockRejectedValueOnce(new RepositoryError('upstream throttle detail', 'rate_limited', true))
        .mockResolvedValue(undefined),
      verifySignup: jest.fn<(..._args: unknown[]) => Promise<void>>()
        .mockRejectedValueOnce(new RepositoryError('upstream expiry detail', 'signup_expired', false)),
    });
    const view = await render(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('auth.signupEmailLabel'), 'new.person@example.com');
    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'river_runner_7');
    await fireEvent.changeText(screen.getByLabelText('auth.displayNameLabel'), 'River Runner');

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.usernameTaken')).toBeTruthy());
    expect(screen.queryByText('upstream taken detail')).toBeNull();

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.usernameReserved')).toBeTruthy());

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('errors.rateLimit')).toBeTruthy());

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.signupOtpSent')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '135790');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignup' }));
    await waitFor(() => expect(screen.getByText('auth.signupExpired')).toBeTruthy());
    expect(screen.queryByText('upstream expiry detail')).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();
    expect(screen.getByLabelText('auth.signupEmailLabel').props.value).toBe('new.person@example.com');
    expect(screen.getByLabelText('auth.usernameLabel').props.value).toBe('river_runner_7');
    expect(screen.getByLabelText('auth.displayNameLabel').props.value).toBe('River Runner');
    await view.unmount();
  });

  test('switches the interface language before authentication and submits signup in the chosen language', async () => {
    const view = await render(<SignInScreen />);
    expect(screen.getByText('auth.languageLabel')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.languageSpanish' }));
    expect(mockSetLocale).toHaveBeenCalledWith('es');

    await fireEvent.changeText(screen.getByLabelText('auth.signupEmailLabel'), 'nueva.persona@example.com');
    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'nueva_persona');
    await fireEvent.changeText(screen.getByLabelText('auth.displayNameLabel'), 'Nueva Persona');
    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(mockAuth.requestSignup).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'es' }),
    ));

    await fireEvent.press(screen.getByRole('button', { name: 'auth.differentIdentity' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.recovery' }));
    expect(screen.getByRole('button', { name: 'auth.languageKorean' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.languageKorean' }));
    expect(mockSetLocale).toHaveBeenCalledWith('ko');
    expect(screen.getByRole('button', { name: 'auth.languageEnglish' })).toBeTruthy();
    await view.unmount();
  });

  test('accepts an initial web invitation only from the fragment and scrubs the bearer capability', async () => {
    const platform = jest.replaceProperty(Platform, 'OS', 'web');
    mockWidth = 1280;
    const replaceState = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { href: `https://newone.example/sign-in?keep=1#invite=${'b'.repeat(64)}&view=compact` },
        history: { state: { navigation: 1 }, replaceState },
      },
    });
    const view = await render(<SignInScreen />);
    expect(screen.getByText('auth.titleEnroll')).toBeTruthy();
    expect(screen.getByLabelText('auth.invitationTokenLabel').props.value).toBe('b'.repeat(64));
    expect(replaceState).toHaveBeenCalledWith(
      { navigation: 1 }, '', '/sign-in?keep=1#view=compact',
    );
    await view.unmount();
    platform.restore();
  });
});
