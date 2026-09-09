import { afterEach, describe, expect, test } from '@jest/globals';
import { Platform } from 'react-native';

import { a11yState } from '@/lib/a11y-state';

describe('accessibility state', () => {
  const original = Platform.OS;
  afterEach(() => { (Platform as { OS: string }).OS = original; });

  test('a phone gets accessibilityState and nothing else', () => {
    (Platform as { OS: string }).OS = 'ios';
    expect(a11yState({ expanded: true })).toEqual({ accessibilityState: { expanded: true } });
  });

  test('the browser gets the aria attributes it actually reads', () => {
    // React Native Web announces from aria-*, not from accessibilityState, so
    // a control that set only the latter told a screen reader nothing on the
    // web while being correct on a phone.
    (Platform as { OS: string }).OS = 'web';
    expect(a11yState({ expanded: false })).toEqual({
      accessibilityState: { expanded: false },
      'aria-expanded': false,
    });
    expect(a11yState({ checked: true, disabled: false })).toEqual({
      accessibilityState: { checked: true, disabled: false },
      'aria-checked': true,
      'aria-disabled': false,
    });
    expect(a11yState({ selected: true })).toEqual({
      accessibilityState: { selected: true },
      'aria-selected': true,
    });
  });

  test('an unset flag is not announced as false', () => {
    (Platform as { OS: string }).OS = 'web';
    expect(a11yState({ checked: true })).not.toHaveProperty('aria-expanded');
  });
});
