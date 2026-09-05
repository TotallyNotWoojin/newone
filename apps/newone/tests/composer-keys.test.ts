import { describe, expect, test } from '@jest/globals';

import { shouldSendOnEnter } from '@/features/chat/composer-keys';

describe('composer Enter handling', () => {
  test('on web, Enter sends and Shift+Enter inserts a newline', () => {
    expect(shouldSendOnEnter({ key: 'Enter' }, { enterSends: true, platform: 'web' })).toBe(true);
    expect(shouldSendOnEnter({ key: 'Enter', shiftKey: true }, { enterSends: true, platform: 'web' })).toBe(false);
    expect(shouldSendOnEnter({ key: 'a' }, { enterSends: true, platform: 'web' })).toBe(false);
  });

  test('respects the device preference and never fires on native or mid-composition', () => {
    expect(shouldSendOnEnter({ key: 'Enter' }, { enterSends: false, platform: 'web' })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter' }, { enterSends: true, platform: 'ios' })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter' }, { enterSends: true, platform: 'android' })).toBe(false);
    // Korean/Japanese IME: Enter commits the composition; keyCode 229 is the legacy marker.
    expect(shouldSendOnEnter({ key: 'Enter', isComposing: true }, { enterSends: true, platform: 'web' })).toBe(false);
    expect(shouldSendOnEnter({ key: 'Enter', keyCode: 229 }, { enterSends: true, platform: 'web' })).toBe(false);
  });

  test('defaults to the running platform (native under Jest)', () => {
    expect(shouldSendOnEnter({ key: 'Enter' }, { enterSends: true })).toBe(false);
  });
});
