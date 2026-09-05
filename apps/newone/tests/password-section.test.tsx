import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { PasswordSection } from '@/features/settings/password-section';
import { RepositoryError } from '@/data/repositories/contracts';

let mockAuth: Record<string, any>;

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
  };
});
jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));
jest.mock('@/state/auth', () => ({ useAuth: () => mockAuth }));

beforeEach(() => {
  mockAuth = {
    hasPassword: false,
    setPassword: jest.fn(async (..._args: unknown[]) => undefined),
  };
});

describe('settings password row', () => {
  test('sets a first password behind the only rule and reports the update in place', async () => {
    const view = await render(<PasswordSection />);
    expect(screen.getByText('settings.passwordNoneNote')).toBeTruthy();
    expect(screen.queryByLabelText('auth.newPasswordLabel')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.passwordSetAction' }));
    expect(screen.getByText('auth.passwordRule')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'auth.savePassword' }));
    expect(screen.getByText('auth.passwordTooShort')).toBeTruthy();
    expect(mockAuth.setPassword).not.toHaveBeenCalled();

    const field = screen.getByLabelText('auth.newPasswordLabel');
    expect(field.props.secureTextEntry).toBe(true);
    await fireEvent.press(screen.getByLabelText('auth.showPassword'));
    expect(screen.getByLabelText('auth.newPasswordLabel').props.secureTextEntry).toBe(false);

    await fireEvent.changeText(screen.getByLabelText('auth.newPasswordLabel'), 'correct horse battery');
    await fireEvent(screen.getByLabelText('auth.newPasswordLabel'), 'submitEditing');
    await waitFor(() => expect(mockAuth.setPassword).toHaveBeenCalledWith('correct horse battery'));
    await waitFor(() => expect(screen.getByText('settings.passwordUpdated')).toBeTruthy());
    expect(screen.queryByLabelText('auth.newPasswordLabel')).toBeNull();
    await view.unmount();
  });

  test('changes an existing password and keeps the dialog open on a rejected save', async () => {
    mockAuth = {
      hasPassword: true,
      setPassword: jest.fn<(..._args: unknown[]) => Promise<void>>()
        .mockRejectedValueOnce(new RepositoryError('upstream detail', 'weak_password', false))
        .mockRejectedValueOnce(new RepositoryError('upstream detail', 'http_503', true)),
    };
    const view = await render(<PasswordSection />);
    expect(screen.getByText('settings.passwordSetNote')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'settings.passwordChangeAction' }));
    await fireEvent.changeText(screen.getByLabelText('auth.newPasswordLabel'), 'correct horse battery');
    await fireEvent.press(screen.getByRole('button', { name: 'auth.savePassword' }));
    await waitFor(() => expect(screen.getByText('auth.passwordTooShort')).toBeTruthy());
    expect(screen.queryByText('upstream detail')).toBeNull();

    await fireEvent.press(screen.getByRole('button', { name: 'auth.savePassword' }));
    await waitFor(() => expect(screen.getByText('errors.unavailable')).toBeTruthy());
    expect(screen.getByLabelText('auth.newPasswordLabel')).toBeTruthy();
    expect(screen.queryByText('settings.passwordUpdated')).toBeNull();

    // The modal exposes the backdrop and the close button under the same label.
    await fireEvent.press(screen.getAllByLabelText('common.closeDialog')[0]!);
    await waitFor(() => expect(screen.queryByLabelText('auth.newPasswordLabel')).toBeNull());
    await view.unmount();
  });
});
