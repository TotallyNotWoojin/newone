import { describe, expect, test } from '@jest/globals';

import { DEFAULT_DEVICE_PREFERENCES, parseDevicePreferences, currentDevicePreferences } from '@/state/device-preferences';

describe('device preferences', () => {
  test('defaults: enter sends, both languages shown, never prompted, appearance follows the phone', () => {
    expect(DEFAULT_DEVICE_PREFERENCES).toEqual({ translatedOnly: false, showOwnTranslations: false, enterSends: true, notificationsPromptedAt: null, theme: 'system' });
    expect(parseDevicePreferences(null)).toEqual(DEFAULT_DEVICE_PREFERENCES);
    expect(parseDevicePreferences('not json')).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  test('stored values win and unknown or wrongly typed fields fall back', () => {
    expect(parseDevicePreferences(JSON.stringify({ translatedOnly: true, showOwnTranslations: true, enterSends: false, notificationsPromptedAt: '2026-09-05T00:00:00Z', theme: 'dark', extra: 1 })))
      .toEqual({ translatedOnly: true, showOwnTranslations: true, enterSends: false, notificationsPromptedAt: '2026-09-05T00:00:00Z', theme: 'dark' });
    expect(parseDevicePreferences(JSON.stringify({ translatedOnly: 'yes', enterSends: 0 }))).toEqual(DEFAULT_DEVICE_PREFERENCES);
  });

  test('showing your own translations is off unless the phone stored a real yes', () => {
    // A phone that predates the setting has no such key, and a stored value of
    // the wrong shape is not a yes: both leave your own bubbles as they were.
    expect(parseDevicePreferences(JSON.stringify({ translatedOnly: true })).showOwnTranslations).toBe(false);
    expect(parseDevicePreferences(JSON.stringify({ showOwnTranslations: 'on' })).showOwnTranslations).toBe(false);
    expect(parseDevicePreferences(JSON.stringify({ showOwnTranslations: 1 })).showOwnTranslations).toBe(false);
    expect(parseDevicePreferences(JSON.stringify({ showOwnTranslations: true })).showOwnTranslations).toBe(true);
    expect(parseDevicePreferences(JSON.stringify({ showOwnTranslations: false })).showOwnTranslations).toBe(false);
  });

  test('the appearance choice round-trips and an unknown one falls back to system', () => {
    expect(parseDevicePreferences(JSON.stringify({ theme: 'light' })).theme).toBe('light');
    expect(parseDevicePreferences(JSON.stringify({ theme: 'dark' })).theme).toBe('dark');
    expect(parseDevicePreferences(JSON.stringify({ theme: 'system' })).theme).toBe('system');
    expect(parseDevicePreferences(JSON.stringify({ theme: 'sepia' })).theme).toBe('system');
    expect(parseDevicePreferences(JSON.stringify({ theme: 3 })).theme).toBe('system');
  });
});

describe('the preference mirror read outside React', () => {
  test('starts at the documented defaults', () => {
    expect(currentDevicePreferences().showOwnTranslations).toBe(false);
    expect(currentDevicePreferences().translatedOnly).toBe(false);
    expect(currentDevicePreferences().enterSends).toBe(true);
  });
});
