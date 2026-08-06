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
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
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
    requestRecoveryOtp: successfulAction({ channelConfigured: true }),
    verifyRecoveryOtp: successfulAction({ otherSessionsRevoked: true }),
    ...overrides,
  };
}

beforeEach(() => {
  mockWidth = 390;
  mockWebAuthBlocked = false;
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
    await fireEvent(screen.getByLabelText('auth.emailLabel'), 'submitEditing');
    await blocked.unmount();
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
