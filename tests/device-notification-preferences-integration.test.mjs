import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseDeviceNotificationPreferences,
} from '../apps/newone/src/data/repositories/device-notification-preferences-dto.mjs';

const fixture = {
  registered: true,
  deviceId: '11111111-1111-4111-8111-111111111111',
  installationId: '22222222-2222-4222-8222-222222222222',
  platform: 'android',
  preferenceVersion: 2,
  overrides: {
    notificationPreview: null,
    soundEnabled: false,
    vibrationEnabled: null,
  },
  effective: {
    notificationPreview: 'generic',
    soundEnabled: false,
    vibrationEnabled: true,
  },
  updatedAt: '2026-08-04T18:00:00.000Z',
};

const files = {
  routes: readFileSync('supabase/functions/newone-api/routes.ts', 'utf8'),
  contracts: readFileSync('apps/newone/src/data/repositories/contracts.ts', 'utf8'),
  transport: readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8'),
  workspace: readFileSync('apps/newone/src/state/workspace.tsx', 'utf8'),
  settings: readFileSync('apps/newone/src/app/settings.tsx', 'utf8'),
  catalog: readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8'),
  nativeRegistration: readFileSync('apps/newone/src/device/push-registration.native.ts', 'utf8'),
  webRegistration: readFileSync('apps/newone/src/device/push-registration.web.ts', 'utf8'),
};

test('device preference response rejects every uncontracted field at every level', () => {
  assert.deepEqual(parseDeviceNotificationPreferences(fixture), fixture);
  for (const invalid of [
    { ...fixture, userId: '33333333-3333-4333-8333-333333333333' },
    { ...fixture, overrides: { ...fixture.overrides, pushToken: 'secret' } },
    { ...fixture, effective: { ...fixture.effective, quietHoursBypassed: true } },
  ]) assert.throws(() => parseDeviceNotificationPreferences(invalid), /Invalid .*device notification/i);
});

test('client repository has bounded query and CAS update paths using the strict DTO', () => {
  assert.match(files.contracts, /getDeviceNotificationPreferences\(input:/);
  assert.match(files.contracts, /updateDeviceNotificationPreferences\(input:/);
  assert.match(files.transport, /\/v2\/devices\/\$\{encodeURIComponent\(input\.installationId\)\}\/preferences\/query/);
  assert.match(files.transport, /method: 'PATCH'/);
  assert.match(files.transport, /expectedVersion: input\.expectedVersion/);
  assert.match(files.transport, /normalizeDeviceNotificationPreferencePatch\(input\.patch\)/);
  assert.equal((files.transport.match(/parseDeviceNotificationPreferences\(dataValue\(payload\)\)/g) ?? []).length, 2);
});

test('workspace binds preferences to the physical current installation and never arbitrary session devices', () => {
  assert.match(files.workspace, /getCurrentInstallationId\(\)/);
  assert.match(files.workspace, /deviceNotificationPreferences: DeviceNotificationPreferences \| null/);
  assert.match(files.workspace, /expectedVersion: deviceNotificationPreferences\.preferenceVersion/);
  assert.match(files.workspace, /installationId: deviceNotificationPreferences\.installationId/);
  assert.match(files.workspace, /executeImmediate\('device-preferences-save'/);
  assert.match(files.workspace, /setDeviceNotificationPreferences\(result\)/);
  const saveStart = files.workspace.indexOf('const saveDeviceNotificationPreferences = useCallback');
  const saveEnd = files.workspace.indexOf('const enableNotifications = useCallback', saveStart);
  assert.notEqual(saveStart, -1);
  assert.notEqual(saveEnd, -1);
  assert.doesNotMatch(files.workspace.slice(saveStart, saveEnd), /accountSessions/);
  assert.match(files.nativeRegistration, /getCurrentInstallationId/);
  assert.match(files.nativeRegistration, /return getInstallationId\(\)/);
  assert.match(files.webRegistration, /getCurrentInstallationId[\s\S]*return null/);
});

// The per-device override form is gone. a71eb42 (2026-09-05, "Settings:
// compact rows, notifications switch, first-launch permission ask, chat
// toggles") rebuilt Settings as a WhatsApp-style list and says so directly:
// "Removed the verification badges, language chip, the per-device override
// form, the preview mode, and every explanatory paragraph." What replaced it
// is a single "Allow notifications" switch that reflects the real state, so
// there are no longer account defaults and nullable device overrides to keep
// apart, and settings.currentDevicePreferences / inheritAccount /
// saveDevicePreferences / nativeOnly are rendered by no screen.
//
// The two tests that stood here are deleted rather than re-pointed:
//   - "settings UI separates account defaults from nullable current-device
//     overrides" described a form that no longer exists.
//   - "all locales explain per-device scope and retained policy boundaries"
//     still passed, but only because the orphaned catalog strings were never
//     deleted; it guarded copy no screen renders.
// The device-preference transport below is untouched and still under test.

test('the notifications switch reflects real permission and device binding', () => {
  // What the override form was replaced by: one switch that is only on when
  // the OS granted permission and this device is actually bound.
  assert.match(files.settings, /const deviceRegistered = Boolean\(devicePreferences\)/);
  assert.match(files.settings, /workspace\.deviceNotificationPreferences/);
});

test('current-device preferences are immediate online commands, not offline cached safety state', () => {
  assert.match(files.workspace, /executeImmediate\('device-preferences-save'/);
  assert.doesNotMatch(files.workspace, /enqueueCommand[\s\S]{0,400}device-preferences/);
  assert.doesNotMatch(files.workspace, /clientStore[\s\S]{0,300}deviceNotificationPreferences/);
  assert.match(files.transport, /cache: 'no-store'/);
});
