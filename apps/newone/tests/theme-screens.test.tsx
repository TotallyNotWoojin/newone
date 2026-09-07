import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import HelpScreen from '@/app/help';
import { ReactionRow } from '@/features/chat/reaction-row';
import { darkColors, lightColors, type ColorScheme, type ThemeColors } from '@/theme/palette';
import { ThemeProvider } from '@/theme/provider';

/**
 * Proof that a whole screen, not just the provider, reads the palette at render
 * time: the same tree is mounted twice and every asserted surface comes back in
 * the other palette.
 */

let mockSystemScheme: ColorScheme = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockSystemScheme,
}));

jest.mock('@/state/device-preferences', () => ({
  useDevicePreferences: () => ({
    preferences: { translatedOnly: false, showOwnTranslations: false, enterSends: true, notificationsPromptedAt: null, theme: 'system' },
    ready: true,
    setPreference: () => undefined,
  }),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: jest.fn() }),
}));

jest.mock('@/config/runtime', () => ({
  publicRuntimeConfig: { supportContact: null },
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

function styleOf(element: { props: { style?: unknown } }): Record<string, unknown> {
  return (StyleSheet.flatten(element.props.style as never) ?? {}) as Record<string, unknown>;
}

async function inScheme(scheme: ColorScheme, tree: ReactNode) {
  mockSystemScheme = scheme;
  return render(<ThemeProvider>{tree}</ThemeProvider>);
}

beforeEach(() => {
  mockSystemScheme = 'light';
});

describe('a screen in both palettes', () => {
  test.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as [ColorScheme, ThemeColors][])('the help screen paints %s surfaces and text', async (scheme, colors) => {
    const view = await inScheme(scheme, <HelpScreen />);

    expect(styleOf(screen.getByRole('header', { name: 'help.title' })).color).toBe(colors.ink);
    expect(styleOf(screen.getByText('help.subtitle')).color).toBe(colors.inkSubtle);
    // The brand card keeps its dark green in both, with white type on it.
    expect(styleOf(screen.getByText('help.introTitle')).color).toBe(colors.white);
    expect(styleOf(screen.getByText('help.onboardingTitle')).color).toBe(colors.ink);
    expect(styleOf(screen.getByText('help.onboardingBody')).color).toBe(colors.inkMuted);

    await view.unmount();
  });

  test.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as [ColorScheme, ThemeColors][])('a chat control paints %s surfaces', async (scheme, colors) => {
    const view = await inScheme(scheme, <ReactionRow onReact={() => undefined} />);

    const row = screen.getByTestId('reaction-row');
    const button = screen.getByRole('button', { name: 'chat.react 👍' });
    expect(styleOf(button).backgroundColor).toBe(colors.paperMuted);
    expect(styleOf(button).borderColor).toBe(colors.line);
    // The "+" glyph sits on the soft accent tint, which flips with the palette.
    expect(styleOf(screen.getByText('+')).color).toBe(colors.accentInk);
    expect(row).toBeTruthy();

    await view.unmount();
  });

  test('the two palettes really did paint different pixels', async () => {
    const light = await inScheme('light', <HelpScreen />);
    const lightTitle = styleOf(screen.getByRole('header', { name: 'help.title' })).color;
    await light.unmount();

    const dark = await inScheme('dark', <HelpScreen />);
    const darkTitle = styleOf(screen.getByRole('header', { name: 'help.title' })).color;
    await dark.unmount();

    expect(lightTitle).not.toBe(darkTitle);
  });
});
