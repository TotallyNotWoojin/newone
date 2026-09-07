import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { render } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import { darkColors, lightColors, type ColorScheme } from '@/theme/palette';
import { ThemeProvider } from '@/theme/provider';
import { useSystemChrome } from '@/theme/system-chrome';

/**
 * The window outside the React tree: the root view behind the navigator on a
 * phone, and the document plus browser chrome on the web.
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

const mockSetBackgroundColorAsync = jest.fn<(color: string) => Promise<void>>();
jest.mock('expo-system-ui', () => ({
  setBackgroundColorAsync: (color: string) => mockSetBackgroundColorAsync(color),
}));

function Shell() {
  useSystemChrome();
  return <Text>shell</Text>;
}

function renderShell(scheme: ColorScheme) {
  mockSystemScheme = scheme;
  return render(<ThemeProvider><Shell /></ThemeProvider>);
}

const originalDocument = globalThis.document;
const originalPlatform = Platform.OS;

function installFakeDocument() {
  const themeColor = { content: '#unset', setAttribute(_name: string, value: string) { themeColor.content = value; } };
  const fake = {
    documentElement: { style: {} as Record<string, string> },
    body: { style: {} as Record<string, string> },
    querySelector: (selector: string) => (selector === 'meta[name="theme-color"]' ? themeColor : null),
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fake, writable: true });
  return { fake, themeColor };
}

beforeEach(() => {
  mockSetBackgroundColorAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument, writable: true });
});

describe('the window outside the React tree', () => {
  test('a phone gets its root view painted the current ground colour', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
    const light = await renderShell('light');
    expect(mockSetBackgroundColorAsync).toHaveBeenLastCalledWith(lightColors.canvas);
    await light.unmount();

    const dark = await renderShell('dark');
    expect(mockSetBackgroundColorAsync).toHaveBeenLastCalledWith(darkColors.canvas);
    await dark.unmount();
  });

  test('a platform that refuses the call is not a crash', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    mockSetBackgroundColorAsync.mockRejectedValue(new Error('no root view'));
    const view = await renderShell('dark');
    expect(mockSetBackgroundColorAsync).toHaveBeenCalled();
    await view.unmount();
  });

  test('the web gets the document, its colour scheme, and the browser theme colour', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    const { fake, themeColor } = installFakeDocument();

    const dark = await renderShell('dark');
    expect(fake.documentElement.style.backgroundColor).toBe(darkColors.canvas);
    expect(fake.documentElement.style.colorScheme).toBe('dark');
    expect(fake.body.style.backgroundColor).toBe(darkColors.canvas);
    expect(themeColor.content).toBe(darkColors.canvas);
    expect(mockSetBackgroundColorAsync).not.toHaveBeenCalled();
    await dark.unmount();

    const light = await renderShell('light');
    expect(fake.documentElement.style.backgroundColor).toBe(lightColors.canvas);
    expect(fake.documentElement.style.colorScheme).toBe('light');
    expect(themeColor.content).toBe(lightColors.canvas);
    await light.unmount();
  });

  test('a web runtime without a document is left alone', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined, writable: true });
    const view = await renderShell('dark');
    expect(mockSetBackgroundColorAsync).not.toHaveBeenCalled();
    await view.unmount();
  });
});
