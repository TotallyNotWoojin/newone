import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { darkColors, lightColors } from '@/theme/palette';
import {
  buildThemedStyles,
  resolveColorScheme,
  THEME_PREFERENCES,
  ThemeProvider,
  useTheme,
  useThemedStyles,
  type ThemeColors,
  type ThemePreference,
} from '@/theme/provider';
import { isThemePreference } from '@/theme/scheme';

let mockSystemScheme: 'light' | 'dark' | null = 'light';
jest.mock('react-native/Libraries/Utilities/useColorScheme', () => ({
  __esModule: true,
  default: () => mockSystemScheme,
}));

/** An in-memory stand-in for the device's key/value cache. */
const mockStorage = new Map<string, string>();
jest.mock('@/data/persistence/client-store', () => ({
  clientStore: {
    initialize: async () => undefined,
    getCache: async (key: string) => mockStorage.get(key) ?? null,
    putCache: async (key: string, value: string) => {
      mockStorage.set(key, value);
    },
  },
}));

// Imported after the store mock so the provider picks it up.
const { DevicePreferencesProvider, useDevicePreferences } =
  jest.requireActual<typeof import('@/state/device-preferences')>('@/state/device-preferences');

const buildProbeStyles = (colors: ThemeColors) => StyleSheet.create({
  surface: { backgroundColor: colors.canvas },
  label: { color: colors.ink },
});

function Probe() {
  const { scheme, preference } = useTheme();
  const styles = useThemedStyles(buildProbeStyles);
  const { setPreference } = useDevicePreferences();
  // Screen-local state that a remount would throw away.
  const [draft, setDraft] = useState('');
  return (
    <View style={styles.surface} testID="probe-surface">
      <Text style={styles.label} testID="probe-label">{`${scheme}:${preference}`}</Text>
      <Text testID="probe-draft">{draft}</Text>
      <Pressable accessibilityRole="button" onPress={() => setDraft('half-typed')} testID="type-draft">
        <Text>type</Text>
      </Pressable>
      {THEME_PREFERENCES.map((value) => (
        <Pressable
          accessibilityRole="button"
          key={value}
          onPress={() => setPreference('theme', value)}
          testID={`choose-${value}`}>
          <Text>{value}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function renderProbe() {
  return render(
    <DevicePreferencesProvider>
      <ThemeProvider>
        <Probe />
      </ThemeProvider>
    </DevicePreferencesProvider>,
  );
}

function backgroundOf(testID: string): string | undefined {
  const flattened = StyleSheet.flatten(screen.getByTestId(testID).props.style) as
    { backgroundColor?: string } | undefined;
  return flattened?.backgroundColor;
}

beforeEach(() => {
  mockSystemScheme = 'light';
  mockStorage.clear();
});

describe('the appearance resolver', () => {
  test('"system" follows the phone in both directions', () => {
    expect(resolveColorScheme('light', 'system')).toBe('light');
    expect(resolveColorScheme('dark', 'system')).toBe('dark');
  });

  test('a phone that reports nothing is treated as light', () => {
    expect(resolveColorScheme(null, 'system')).toBe('light');
    expect(resolveColorScheme(undefined, 'system')).toBe('light');
  });

  test('an explicit choice wins over the phone, and keeps winning when the phone flips', () => {
    expect(resolveColorScheme('dark', 'light')).toBe('light');
    expect(resolveColorScheme('light', 'dark')).toBe('dark');
    // The same override, before and after the phone changes appearance.
    expect(resolveColorScheme('light', 'light')).toBe('light');
    expect(resolveColorScheme('dark', 'light')).toBe('light');
    expect(resolveColorScheme('dark', 'dark')).toBe('dark');
    expect(resolveColorScheme('light', 'dark')).toBe('dark');
  });

  test('only the three choices are accepted from storage', () => {
    for (const value of THEME_PREFERENCES) expect(isThemePreference(value)).toBe(true);
    for (const value of ['', 'System', 'sepia', 3, null, undefined, {}]) {
      expect(isThemePreference(value)).toBe(false);
    }
  });
});

describe('the themed stylesheet cache', () => {
  test('one sheet per factory per palette, built from that palette', () => {
    const factory = jest.fn((colors: ThemeColors) => StyleSheet.create({
      card: { backgroundColor: colors.paper },
    }));
    const lightSheet = buildThemedStyles(factory, 'light');
    const darkSheet = buildThemedStyles(factory, 'dark');

    expect(buildThemedStyles(factory, 'light')).toBe(lightSheet);
    expect(buildThemedStyles(factory, 'dark')).toBe(darkSheet);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(StyleSheet.flatten(lightSheet.card)).toMatchObject({ backgroundColor: lightColors.paper });
    expect(StyleSheet.flatten(darkSheet.card)).toMatchObject({ backgroundColor: darkColors.paper });
  });
});

describe('the theme provider', () => {
  test('follows a light phone by default', async () => {
    const view = await renderProbe();
    expect(screen.getByTestId('probe-label').props.children).toBe('light:system');
    expect(backgroundOf('probe-surface')).toBe(lightColors.canvas);
    await view.unmount();
  });

  test('follows a dark phone by default', async () => {
    mockSystemScheme = 'dark';
    const view = await renderProbe();
    expect(screen.getByTestId('probe-label').props.children).toBe('dark:system');
    expect(backgroundOf('probe-surface')).toBe(darkColors.canvas);
    await view.unmount();
  });

  test('each override paints its own palette whatever the phone says', async () => {
    for (const [systemScheme, preference, expected] of [
      ['light', 'dark', darkColors],
      ['dark', 'light', lightColors],
      ['dark', 'dark', darkColors],
      ['light', 'light', lightColors],
    ] as [typeof mockSystemScheme, ThemePreference, typeof lightColors][]) {
      mockSystemScheme = systemScheme;
      mockStorage.set('preferences.device.v1', JSON.stringify({ theme: preference }));
      const view = await renderProbe();
      expect(backgroundOf('probe-surface')).toBe(expected.canvas);
      await view.unmount();
    }
  });

  test('a choice repaints in place, keeping what the screen was holding', async () => {
    const view = await renderProbe();
    expect(backgroundOf('probe-surface')).toBe(lightColors.canvas);
    await fireEvent.press(screen.getByTestId('type-draft'));
    expect(screen.getByTestId('probe-draft').props.children).toBe('half-typed');

    await fireEvent.press(screen.getByTestId('choose-dark'));
    expect(backgroundOf('probe-surface')).toBe(darkColors.canvas);
    expect(screen.getByTestId('probe-label').props.children).toBe('dark:dark');
    // Re-rendered, not re-created: a remount would have cleared the draft.
    expect(screen.getByTestId('probe-draft').props.children).toBe('half-typed');

    await fireEvent.press(screen.getByTestId('choose-system'));
    expect(backgroundOf('probe-surface')).toBe(lightColors.canvas);
    expect(screen.getByTestId('probe-draft').props.children).toBe('half-typed');
    await view.unmount();
  });

  test('the choice is written to the device store and comes back on the next launch', async () => {
    const first = await renderProbe();
    await fireEvent.press(screen.getByTestId('choose-dark'));
    expect(JSON.parse(mockStorage.get('preferences.device.v1') ?? '{}')).toMatchObject({ theme: 'dark' });
    await first.unmount();

    // A fresh launch on a light phone still opens dark.
    mockSystemScheme = 'light';
    const second = await renderProbe();
    expect(screen.getByTestId('probe-label').props.children).toBe('dark:dark');
    expect(backgroundOf('probe-surface')).toBe(darkColors.canvas);
    await second.unmount();
  });

  test('the phone flipping to dark moves a "system" app and leaves an override alone', async () => {
    const following = await renderProbe();
    expect(backgroundOf('probe-surface')).toBe(lightColors.canvas);
    await act(async () => {
      mockSystemScheme = 'dark';
      await fireEvent.press(screen.getByTestId('choose-system'));
    });
    expect(backgroundOf('probe-surface')).toBe(darkColors.canvas);
    await following.unmount();

    mockStorage.set('preferences.device.v1', JSON.stringify({ theme: 'light' }));
    mockSystemScheme = 'dark';
    const overridden = await renderProbe();
    expect(backgroundOf('probe-surface')).toBe(lightColors.canvas);
    await act(async () => {
      mockSystemScheme = 'light';
      await fireEvent.press(screen.getByTestId('choose-light'));
    });
    expect(backgroundOf('probe-surface')).toBe(lightColors.canvas);
    await overridden.unmount();
  });
});
