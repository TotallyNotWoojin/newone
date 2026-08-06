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

test('settings UI separates account defaults from nullable current-device overrides', () => {
  assert.match(files.settings, /settings\.currentDevicePreferences/);
  assert.match(files.settings, /notificationPreview: value/);
  assert.match(files.settings, /\[null, t\('settings\.inheritAccount'\)\]/);
  assert.match(files.settings, /\[true, t\('settings\.enabled'\)\]/);
  assert.match(files.settings, /\[false, t\('settings\.disabled'\)\]/);
  assert.match(files.settings, /devicePreferences\.effective\[field\]/);
  assert.match(files.settings, /workspace\.saveDeviceNotificationPreferences/);
  assert.match(files.settings, /Platform\.OS === 'web'/);
  assert.match(files.settings, /settings\.nativeOnly/);
});

test('all locales explain per-device scope and retained policy boundaries', () => {
  assert.equal((files.catalog.match(/'settings\.currentDevicePreferences':/g) ?? []).length, 3);
  assert.equal((files.catalog.match(/'settings\.inheritAccount':/g) ?? []).length, 3);
  assert.equal((files.catalog.match(/'settings\.saveDevicePreferences':/g) ?? []).length, 3);
  assert.match(files.catalog, /Quiet hours, conversation mutes, shift suppression, critical-notice policy, and operating-system permission still apply/);
  assert.match(files.catalog, /방해 금지 시간, 대화 음소거, 근무 외 억제, 중요 공지 정책 및 운영체제 권한은 계속 적용됩니다/);
  assert.match(files.catalog, /horas silenciosas, los silencios de conversación, la supresión fuera de turno, la política de avisos críticos y el permiso del sistema operativo/);
});

test('current-device preferences are immediate online commands, not offline cached safety state', () => {
  assert.match(files.workspace, /executeImmediate\('device-preferences-save'/);
  assert.doesNotMatch(files.workspace, /enqueueCommand[\s\S]{0,400}device-preferences/);
  assert.doesNotMatch(files.workspace, /clientStore[\s\S]{0,300}deviceNotificationPreferences/);
  assert.match(files.transport, /cache: 'no-store'/);
});
