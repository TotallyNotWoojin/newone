import { describe, expect, test } from '@jest/globals';

import { DEFAULT_DEVICE_PREFERENCES, parseDevicePreferences } from '@/state/device-preferences';

describe('device preferences', () => {
  test('defaults: enter sends, both languages shown, never prompted', () => {
    expect(DEFAULT_DEVICE_PREFERENCES).toEqual({ translatedOnly: false, enterSends: true, notificationsPromptedAt: null });
    expect(parseDevicePreferences(null)).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(parseDevicePreferences('not json')).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  test('stored values win and unknown or wrongly typed fields fall back', () => {
    expect(parseDevicePreferences(JSON.stringify({ translatedOnly: true, enterSends: false, notificationsPromptedAt: '2026-09-05T00:00:00Z', extra: 1 })))
      .toEqual({ translatedOnly: true, enterSends: false, notificationsPromptedAt: '2026-09-05T00:00:00Z' });
    expect(parseDevicePreferences(JSON.stringify({ translatedOnly: 'yes', enterSends: 0 }))).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });
});
