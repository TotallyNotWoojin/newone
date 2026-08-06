import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Linking } from 'react-native';

import HelpScreen from '@/app/help';

const mockRouter = { back: jest.fn() };
const mockRuntimeConfig: {
  supportContact: { label: string; url: string | null } | null;
} = {
  supportContact: null,
};

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
}));

jest.mock('@/config/runtime', () => ({
  get publicRuntimeConfig() {
    return mockRuntimeConfig;
  },
}));

jest.mock('@/i18n/provider', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactNative = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: ({ children, ...props }: { children: ReactNode }) => (
      <ReactNative.View {...props}>{children}</ReactNative.View>
    ),
  };
});

beforeEach(() => {
  mockRuntimeConfig.supportContact = null;
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

describe('public help screen', () => {
  test('renders every operational help topic and closes back to the prior route', async () => {
    const view = await render(<HelpScreen />);

    expect(screen.getByRole('header', { name: 'help.title' })).toBeTruthy();
    for (const title of [
      'help.onboardingTitle',
      'help.recoveryTitle',
      'help.privacyTitle',
      'help.translationTitle',
      'help.safetyTitle',
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    expect(screen.getByText('help.supportUnconfigured')).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'help.close' }));
    expect(mockRouter.back).toHaveBeenCalledTimes(1);

    await view.unmount();
  });

  test('opens the validated configured support URL through the operating system', async () => {
    mockRuntimeConfig.supportContact = {
      label: 'Contact the controlled support desk',
      url: 'https://support.example.test/newone',
    };
    const view = await render(<HelpScreen />);

    await fireEvent.press(screen.getByRole('button', {
      name: 'Contact the controlled support desk',
    }));
    expect(Linking.openURL).toHaveBeenCalledWith('https://support.example.test/newone');

    await view.unmount();
  });

  test('renders non-link support guidance as information rather than a fake action', async () => {
    mockRuntimeConfig.supportContact = {
      label: 'Ask your company administrator',
      url: null,
    };
    const view = await render(<HelpScreen />);

    expect(screen.getByText('Ask your company administrator')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask your company administrator' })).toBeNull();
    expect(Linking.openURL).not.toHaveBeenCalled();

    await view.unmount();
  });
});
