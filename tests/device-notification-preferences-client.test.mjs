import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeDeviceNotificationPreferencePatch,
  parseDeviceNotificationPreferences,
} from '../apps/newone/src/data/repositories/device-notification-preferences-dto.mjs';

const fixture = {
  registered: true,
  deviceId: '11111111-1111-4111-8111-111111111111',
  installationId: '22222222-2222-4222-8222-222222222222',
  platform: 'ios',
  preferenceVersion: 4,
  overrides: {
    notificationPreview: 'hidden',
    soundEnabled: false,
    vibrationEnabled: null,
  },
  effective: {
    notificationPreview: 'hidden',
    soundEnabled: false,
    vibrationEnabled: true,
  },
  updatedAt: '2026-08-04T18:00:00.000Z',
};

test('device notification DTO preserves nullable inheritance separately from effective values', () => {
  assert.deepEqual(parseDeviceNotificationPreferences(fixture), fixture);
  assert.deepEqual(normalizeDeviceNotificationPreferencePatch({
    notificationPreview: null,
    soundEnabled: true,
    vibrationEnabled: null,
  }), {
    notificationPreview: null,
    soundEnabled: true,
    vibrationEnabled: null,
  });
});

test('device notification DTO rejects override/effective contradictions and malformed identities', () => {
  assert.throws(() => parseDeviceNotificationPreferences({
    ...fixture,
    effective: { ...fixture.effective, soundEnabled: true },
  }), /effective device notification preferences/i);
  assert.throws(() => parseDeviceNotificationPreferences({
    ...fixture,
    installationId: 'not-an-installation',
  }), /installation/i);
  assert.throws(() => parseDeviceNotificationPreferences({
    ...fixture,
    overrides: { ...fixture.overrides, notificationPreview: 'full_content' },
  }), /preview override/i);
});

test('device notification patch is non-empty, exact-keyed, and nullable only for inheritance', () => {
  assert.throws(() => normalizeDeviceNotificationPreferencePatch({}), /patch/i);
  assert.throws(() => normalizeDeviceNotificationPreferencePatch({ soundEnabled: 'yes' }), /sound/i);
  assert.throws(() => normalizeDeviceNotificationPreferencePatch({ unknown: true }), /patch/i);
});
