import { describe, expect, test } from '@jest/globals';

import { DEFAULT_DEVICE_PREFERENCES, parseDevicePreferences } from '@/state/device-preferences';

describe('device preferences', () => {
  test('defaults: enter sends, both languages shown, never prompted, appearance follows the phone', () => {
    expect(DEFAULT_DEVICE_PREFERENCES).toEqual({ translatedOnly: false, enterSends: true, notificationsPromptedAt: null, theme: 'system' });
    expect(parseDevicePreferences(null)).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(parseDevicePreferences('not json')).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  test('stored values win and unknown or wrongly typed fields fall back', () => {
    expect(parseDevicePreferences(JSON.stringify({ translatedOnly: true, enterSends: false, notificationsPromptedAt: '2026-09-05T00:00:00Z', theme: 'dark', extra: 1 })))
      .toEqual({ translatedOnly: true, enterSends: false, notificationsPromptedAt: '2026-09-05T00:00:00Z', theme: 'dark' });
    expect(parseDevicePreferences(JSON.stringify({ translatedOnly: 'yes', enterSends: 0 }))).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  test('the appearance choice round-trips and an unknown one falls back to system', () => {
    expect(parseDevicePreferences(JSON.stringify({ theme: 'light' })).theme).toBe('light');
    expect(parseDevicePreferences(JSON.stringify({ theme: 'dark' })).theme).toBe('dark');
    expect(parseDevicePreferences(JSON.stringify({ theme: 'system' })).theme).toBe('system');
    expect(parseDevicePreferences(JSON.stringify({ theme: 'sepia' })).theme).toBe('system');
    expect(parseDevicePreferences(JSON.stringify({ theme: 3 })).theme).toBe('system');
  });
});
