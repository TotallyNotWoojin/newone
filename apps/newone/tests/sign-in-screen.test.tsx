import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
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
let mockTurnstileSiteKey: string | null = 'controlled-turnstile-site-key';
jest.mock('@/config/runtime', () => ({
  publicRuntimeConfig: {
    get turnstileSiteKey() { return mockTurnstileSiteKey; },
  },
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
    verifyOtp: successfulAction({ hasPassword: true }),
    requestSignup: successfulAction(),
    verifySignup: successfulAction({ hasPassword: true }),
    requestRecoveryOtp: successfulAction({ channelConfigured: true }),
    verifyRecoveryOtp: successfulAction({ otherSessionsRevoked: 1, hasPassword: true }),
    signInWithPassword: successfulAction(),
    setPassword: successfulAction(),
    dismissPasswordPrompt: jest.fn(),
    hasPassword: false,
    passwordPromptPending: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockWidth = 390;
  mockWebAuthBlocked = false;
  mockLocale = 'en';
  mockTurnstileSiteKey = 'controlled-turnstile-site-key';
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
    expect(screen.getByRole('button', { name: 'auth.languageKorean' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.languageKorean' }));
    expect(mockSetLocale).toHaveBeenCalledWith('ko');
    expect(screen.getByRole('button', { name: 'auth.languageEnglish' })).toBeTruthy();
    await view.unmount();
  });

  test('signs in a returning member without any challenge when Turnstile is not configured', async () => {
    mockTurnstileSiteKey = null;
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    expect(screen.queryByLabelText('auth.challengeLabel')).toBeNull();
    expect(screen.queryByLabelText('controlled-captcha-error')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), ' Person@Example.COM ');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.otpSent')).toBeTruthy());
    expect(screen.queryByText('auth.challengeRequired')).toBeNull();
    expect(mockAuth.requestOtp).toHaveBeenCalledWith({
      destinationType: 'email',
      destination: 'person@example.com',
    });
    expect(mockAuth.requestOtp.mock.calls[0][0]).not.toHaveProperty('captchaToken');

    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '123456');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignIn' }));
    await waitFor(() => expect(mockAuth.verifyOtp).toHaveBeenCalledWith({
      destinationType: 'email', destination: 'person@example.com', code: '123456',
    }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await view.unmount();
  });

  test('creates a consumer account without any challenge when Turnstile is not configured', async () => {
    mockTurnstileSiteKey = null;
    const view = await render(<SignInScreen />);
    expect(screen.queryByLabelText('auth.challengeLabel')).toBeNull();

    await fireEvent.changeText(screen.getByLabelText('auth.signupEmailLabel'), 'new.person@example.com');
    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'river_runner_7');
    await fireEvent.changeText(screen.getByLabelText('auth.displayNameLabel'), 'River Runner');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.signupOtpSent')).toBeTruthy());
    expect(mockAuth.requestSignup).toHaveBeenCalledWith({
      destination: 'new.person@example.com',
      username: 'river_runner_7',
      displayName: 'River Runner',
      language: 'en',
    });
    expect(mockAuth.requestSignup.mock.calls[0][0]).not.toHaveProperty('captchaToken');

    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '246810');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignup' }));
    await waitFor(() => expect(mockAuth.verifySignup).toHaveBeenCalledWith({
      destination: 'new.person@example.com',
      code: '246810',
    }));
    await view.unmount();
  });

  test('gates code resend behind the cooldown and reuses the returning request without a stale captcha', async () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    try {
      const view = await render(<SignInScreen />);
      await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
      await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), 'person@example.com');
      await solveCaptcha();
      await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
      await waitFor(() => expect(screen.getByText('auth.otpSent')).toBeTruthy());

      expect(screen.getByText('(60s)')).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'auth.resendCode' }));
      expect(mockAuth.requestOtp).toHaveBeenCalledTimes(1);

      await act(async () => { jest.advanceTimersByTime(59_000); });
      expect(screen.getByText('(1s)')).toBeTruthy();
      await fireEvent.press(screen.getByRole('button', { name: 'auth.resendCode' }));
      expect(mockAuth.requestOtp).toHaveBeenCalledTimes(1);

      await act(async () => { jest.advanceTimersByTime(1_000); });
      expect(screen.queryByText('(0s)')).toBeNull();
      await fireEvent.press(screen.getByRole('button', { name: 'auth.resendCode' }));
      await waitFor(() => expect(screen.getByText('auth.codeResent')).toBeTruthy());
      expect(mockAuth.requestOtp).toHaveBeenCalledTimes(2);
      expect(mockAuth.requestOtp).toHaveBeenLastCalledWith({
        destinationType: 'email',
        destination: 'person@example.com',
      });
      expect(mockAuth.requestOtp.mock.calls[1][0]).not.toHaveProperty('captchaToken');
      expect(screen.getByText('(60s)')).toBeTruthy();

      await fireEvent.press(screen.getByRole('button', { name: 'auth.differentIdentity' }));
      expect(screen.queryByRole('button', { name: 'auth.resendCode' })).toBeNull();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalledWith(setIntervalSpy.mock.results[0]?.value);
      await view.unmount();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('resends the signup code with the entered profile, maps resend failures, and cleans up on unmount', async () => {
    jest.useFakeTimers();
    mockAuth = authState({
      requestSignup: jest.fn<(..._args: unknown[]) => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new RepositoryError('upstream throttle detail', 'rate_limited', true))
        .mockResolvedValueOnce(undefined),
    });
    const setIntervalSpy = jest.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = jest.spyOn(globalThis, 'clearInterval');
    try {
      const view = await render(<SignInScreen />);
      await fireEvent.changeText(screen.getByLabelText('auth.signupEmailLabel'), 'new.person@example.com');
      await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'river_runner_7');
      await fireEvent.changeText(screen.getByLabelText('auth.displayNameLabel'), ' River Runner ');
      await solveCaptcha();
      await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
      await waitFor(() => expect(screen.getByText('auth.signupOtpSent')).toBeTruthy());

      await act(async () => { jest.advanceTimersByTime(60_000); });
      await fireEvent.press(screen.getByRole('button', { name: 'auth.resendCode' }));
      await waitFor(() => expect(screen.getByText('errors.rateLimit')).toBeTruthy());
      expect(screen.queryByText('upstream throttle detail')).toBeNull();
      expect(mockAuth.requestSignup).toHaveBeenLastCalledWith({
        destination: 'new.person@example.com',
        username: 'river_runner_7',
        displayName: 'River Runner',
        language: 'en',
      });
      expect(screen.getByText('(60s)')).toBeTruthy();

      await act(async () => { jest.advanceTimersByTime(60_000); });
      await fireEvent.press(screen.getByRole('button', { name: 'auth.resendCode' }));
      await waitFor(() => expect(screen.getByText('auth.codeResent')).toBeTruthy());
      expect(mockAuth.requestSignup).toHaveBeenCalledTimes(3);

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      const ticker = setIntervalSpy.mock.results[0]?.value;
      expect(clearIntervalSpy).not.toHaveBeenCalledWith(ticker);
      await view.unmount();
      expect(clearIntervalSpy).toHaveBeenCalledWith(ticker);
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  test('appends the error code and short correlation id only to generic fallback failures', async () => {
    const correlationId = '1a2b3c4d-9999-4000-8000-000000000000';
    mockAuth = authState({
      requestOtp: jest.fn<(..._args: unknown[]) => Promise<{ channelConfigured: boolean }>>()
        .mockRejectedValueOnce(new RepositoryError('upstream detail', 'quota_exhausted', false, correlationId))
        .mockRejectedValueOnce(new RepositoryError('upstream detail', 'quota_exhausted', false))
        .mockRejectedValueOnce(new Error('unclassified failure'))
        .mockRejectedValueOnce('not-an-error')
        .mockRejectedValueOnce(new RepositoryError('upstream detail', 'username_taken', false, correlationId)),
    });
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), 'person@example.com');

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('errors.action (quota_exhausted · 1a2b3c4d)')).toBeTruthy());
    expect(screen.queryByText('upstream detail')).toBeNull();

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('errors.action (quota_exhausted)')).toBeTruthy());

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('errors.action')).toBeTruthy());

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.signInUnavailable')).toBeTruthy());

    await solveCaptcha();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.usernameTaken')).toBeTruthy());
    expect(screen.queryByText(/1a2b3c4d/)).toBeNull();
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

describe('password sign-in', () => {
  test('signs a returning member in with email and password, maps a rejected credential, and keeps codes one tap away', async () => {
    mockAuth = authState({
      signInWithPassword: jest.fn<(..._args: unknown[]) => Promise<void>>()
        .mockRejectedValueOnce(new RepositoryError('upstream detail', 'unauthorized', false))
        .mockRejectedValueOnce(new RepositoryError('upstream throttle detail', 'rate_limited', true))
        .mockResolvedValueOnce(undefined),
    });
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.phoneChannel' }));
    await fireEvent.press(screen.getByRole('button', { name: 'auth.methodPassword' }));

    // A password pairs with the account email: the phone channel and the
    // challenge (a code-delivery guard) both step aside.
    expect(screen.queryByRole('button', { name: 'auth.phoneChannel' })).toBeNull();
    expect(screen.queryByLabelText('auth.challengeLabel')).toBeNull();
    expect(screen.getByRole('button', { name: 'auth.signIn' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'auth.signIn' }));
    expect(screen.getByText('auth.emailInvalid')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), ' Person@Example.COM ');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.signIn' }));
    expect(screen.getByText('auth.passwordTooShort')).toBeTruthy();
    expect(mockAuth.signInWithPassword).not.toHaveBeenCalled();

    const passwordInput = screen.getByLabelText('auth.passwordLabel');
    expect(passwordInput.props.secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByLabelText('auth.showPassword'));
    expect(screen.getByLabelText('auth.passwordLabel').props.secureTextEntry).toBe(false);
    await fireEvent.press(screen.getByLabelText('auth.hidePassword'));
    expect(screen.getByLabelText('auth.passwordLabel').props.secureTextEntry).toBe(true);

    await fireEvent.changeText(screen.getByLabelText('auth.passwordLabel'), 'wrong password');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.signIn' }));
    await waitFor(() => expect(screen.getByText('auth.passwordIncorrect')).toBeTruthy());
    expect(screen.queryByText('upstream detail')).toBeNull();
    expect(mockRouter.replace).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'auth.signIn' }));
    await waitFor(() => expect(screen.getByText('errors.rateLimit')).toBeTruthy());

    await fireEvent.changeText(screen.getByLabelText('auth.passwordLabel'), 'correct horse battery');
    await fireEvent(screen.getByLabelText('auth.passwordLabel'), 'submitEditing');
    await waitFor(() => expect(mockAuth.signInWithPassword).toHaveBeenLastCalledWith({
      destinationType: 'email',
      destination: 'person@example.com',
      password: 'correct horse battery',
    }));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    expect(mockAuth.requestOtp).not.toHaveBeenCalled();

    // Forgot password: codes remain the recovery route.
    await fireEvent.press(screen.getByRole('button', { name: 'auth.forgotPassword' }));
    expect(screen.queryByLabelText('auth.passwordLabel')).toBeNull();
    expect(screen.getByRole('button', { name: 'auth.emailChannel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'auth.continue' })).toBeTruthy();
    expect(screen.getByLabelText('auth.emailLabel').props.value).toBe(' Person@Example.COM ');
    await view.unmount();
  });

  test('offers a password once after a code sign-in for an account without one, and saves it', async () => {
    mockTurnstileSiteKey = null;
    mockAuth = authState({
      verifyOtp: jest.fn(async (..._args: unknown[]) => {
        mockAuth.passwordPromptPending = true;
        return { hasPassword: false };
      }),
      setPassword: jest.fn<(..._args: unknown[]) => Promise<void>>()
        .mockRejectedValueOnce(new RepositoryError('upstream detail', 'weak_password', false))
        .mockImplementationOnce(async () => {
          mockAuth.passwordPromptPending = false;
        }),
    });
    const view = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), 'person@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.otpSent')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '123456');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignIn' }));

    await waitFor(() => expect(screen.getByText('auth.passwordPromptTitle')).toBeTruthy());
    expect(mockRouter.replace).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.savePassword' }));
    expect(screen.getByText('auth.passwordTooShort')).toBeTruthy();
    expect(mockAuth.setPassword).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByLabelText('auth.newPasswordLabel'), 'correct horse battery');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.savePassword' }));
    await waitFor(() => expect(screen.getByText('auth.passwordTooShort')).toBeTruthy());
    expect(mockAuth.setPassword).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'auth.savePassword' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(mockAuth.setPassword).toHaveBeenLastCalledWith('correct horse battery');
    await view.unmount();
  });

  test('the password offer can be skipped and a returning member with a password never sees it', async () => {
    mockTurnstileSiteKey = null;
    mockAuth = authState({
      verifySignup: jest.fn(async (..._args: unknown[]) => {
        mockAuth.passwordPromptPending = true;
        return { hasPassword: false };
      }),
      dismissPasswordPrompt: jest.fn(() => {
        mockAuth.passwordPromptPending = false;
      }),
    });
    const view = await render(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('auth.signupEmailLabel'), 'new.person@example.com');
    await fireEvent.changeText(screen.getByLabelText('auth.usernameLabel'), 'river_runner_7');
    await fireEvent.changeText(screen.getByLabelText('auth.displayNameLabel'), 'River Runner');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.signupOtpSent')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '246810');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignup' }));
    await waitFor(() => expect(screen.getByText('auth.passwordPromptTitle')).toBeTruthy());

    await fireEvent.press(screen.getByRole('button', { name: 'auth.skipPassword' }));
    expect(mockAuth.dismissPasswordPrompt).toHaveBeenCalledTimes(1);
    expect(mockAuth.setPassword).not.toHaveBeenCalled();
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    await view.unmount();

    mockAuth = authState();
    const returning = await render(<SignInScreen />);
    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    await fireEvent.changeText(screen.getByLabelText('auth.emailLabel'), 'person@example.com');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.continue' }));
    await waitFor(() => expect(screen.getByText('auth.otpSent')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText('auth.codeA11y'), '123456');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.verifySignIn' }));
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith('/'));
    expect(screen.queryByText('auth.passwordPromptTitle')).toBeNull();
    await returning.unmount();
  });
});

describe('consumer-neutral sign-in copy', () => {
  test.each([390, 1280])('uses a neutral email placeholder in every access mode at width %i', async (width) => {
    mockWidth = width;
    const view = await render(<SignInScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'auth.returning' }));
    expect(screen.getByText('auth.subtitleReturn')).toBeTruthy();
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
    expect(screen.queryByPlaceholderText('you@company.com')).toBeNull();

    // The phone placeholder is unchanged and comes back to the neutral email one.
    await fireEvent.press(screen.getByRole('button', { name: 'auth.phoneChannel' }));
    expect(screen.getByPlaceholderText('+52 81 5555 0192')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.emailChannel' }));
    expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();

    // Consumer sign-in offers only "Create account" and "Returning member"
    // (owner backlog, Sep 4 2026): no enrollment or recovery modes.
    expect(screen.queryByRole('button', { name: 'auth.firstUse' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'auth.recovery' })).toBeNull();
    for (const mode of ['auth.modeSignup']) {
      await fireEvent.press(screen.getByRole('button', { name: mode }));
      expect(screen.getByPlaceholderText('you@example.com')).toBeTruthy();
      expect(screen.queryByPlaceholderText('you@company.com')).toBeNull();
    }

    await view.unmount();
  });
});
