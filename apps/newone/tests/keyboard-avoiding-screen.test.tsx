import { describe, expect, jest, test } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import { KEYBOARD_AVOIDING_BEHAVIOR, KeyboardAvoidingScreen } from '@/components/ui/keyboard-avoiding-screen';

describe('KeyboardAvoidingScreen', () => {
  test('pads for the keyboard on every platform, not only iOS', () => {
    // Android 15 is edge-to-edge and ignores adjustResize, so the composer
    // must be padded above the keyboard there too.
    expect(KEYBOARD_AVOIDING_BEHAVIOR).toBe('padding');
  });

  test.each(['ios', 'android'] as const)('renders its children on %s', async (os) => {
    const platform = jest.replaceProperty(Platform, 'OS', os);
    await render(
      <KeyboardAvoidingScreen extraOffset={24}>
        <Text>composer</Text>
      </KeyboardAvoidingScreen>,
    );
    expect(screen.getByText('composer')).toBeTruthy();
    expect(screen.getByTestId('keyboard-avoiding-screen')).toBeTruthy();
    platform.restore();
  });
});
