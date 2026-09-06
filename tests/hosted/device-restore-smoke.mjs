// A phone that signed out must be able to turn notifications back on.
//
// Signing out revokes the device registration; registering again upserts the
// same row and clears revoked_at. The update trigger used to forbid that, so
// notifications could never be re-enabled on that phone (owner report, Sep 6
// 2026). This proves the round trip: register, revoke, register again.
import { randomBytes, randomUUID } from 'node:crypto';
import { PERSONAL_REALM_ID, fail, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';

const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const runId = `dr${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const user = await signupUser(keys, { runId, label: 'dev', language: 'en' });

const register = async (label) => {
  const response = await gatewayPost('newone-api', '/v2/devices', keys, {
    installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: randomUUID(),
    body: {
      organizationId: PERSONAL_REALM_ID, installationId: user.installationId, platform: 'ios',
      pushToken: `ExponentPushToken[restore${randomBytes(6).toString('hex')}]`, pushTokenType: 'expo',
      pushProjectId: randomUUID(), pushEnvironment: 'production', appVersion: '0.0.0-restore-smoke',
      locale: 'en-US-u-hc-h23',
    },
  });
  if (response.status !== 200) fail(`${label} failed (${response.status})`, response.payload);
  return response.payload?.data ?? response.payload;
};

const first = await register('first registration');
console.log('1. registered:', first.deviceId);

await rows(`update public.device_registrations set revoked_at = now()
  where installation_id = '${user.installationId}' and user_id = '${user.userId}'`);
const revoked = await rows(`select revoked_at is not null as revoked from public.device_registrations
  where installation_id = '${user.installationId}'`);
if (revoked[0]?.revoked !== true) fail('the registration was not revoked', revoked);
console.log('2. revoked (as a sign-out does)');

const second = await register('registration after a revocation');
if (second.deviceId !== first.deviceId) fail('a second row was created instead of restoring', second);
const after = await rows(`select revoked_at is null as live, locale from public.device_registrations
  where installation_id = '${user.installationId}'`);
if (after[0]?.live !== true) fail('the registration is still revoked', after);
if (after[0]?.locale !== 'en-US') fail(`locale was not normalized: ${after[0]?.locale}`, after);
console.log('3. same row restored and live, locale', after[0].locale);
console.log('DEVICE RESTORE SMOKE OK');
