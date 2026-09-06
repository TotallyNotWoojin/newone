// Real-API proof for the server-side mute (backlog 13): two real signups, a
// message request accepted, Eli registers a device, mutes it through the route
// the Settings switch uses, Ana sends a message that would push, and the
// database shows the delivery settled as skipped (permanent_failure /
// notifications_muted, no provider ticket) while the job completed. Then Eli
// unmutes, Ana sends again, and that delivery is not skipped for mute.
// Requires the 20260907030000 migration plus the newone-api and
// newone-outbox-worker functions from the same change to be deployed.
import { randomBytes, randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID, fail, gatewayPost, gatewayRequest, loadAccessToken, managementSql, projectKeys, signupUser,
} from './smoke-lib.mjs';

const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const data = (response) => response.payload?.data ?? response.payload;

const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });

const request = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `mute-${runId}-req`,
  body: { organizationId: PERSONAL_REALM_ID, targetUserId: eli.userId, body: 'Hi Eli, testing notifications.' },
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = data(request)?.conversationId;
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${ana.userId}/respond`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `mute-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);

// Eli's device. The token is well-formed but not a real one, so the unmuted
// control delivery below may end in any provider outcome; the point is that it
// is not skipped for mute.
const pushToken = `ExponentPushToken[mute${randomBytes(6).toString('hex')}xxxx]`;
const device = await gatewayPost('newone-api', '/v2/devices', keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `mute-${runId}-dev`,
  body: {
    organizationId: PERSONAL_REALM_ID, installationId: eli.installationId, platform: 'ios',
    pushToken, pushTokenType: 'expo', pushProjectId: randomUUID(), pushEnvironment: 'production',
    appVersion: '0.0.0-mute-smoke', locale: 'en',
  },
});
if (device.status !== 200 || data(device)?.registered !== true) fail(`device registration failed (${device.status})`, device.payload);
const deviceId = data(device).deviceId;
console.log('device registered →', deviceId);

const muteRoute = `/v2/devices/${eli.installationId}/mute`;
const setMuted = async (muted, label) => {
  const r = await gatewayRequest('newone-api', 'PATCH', muteRoute, keys, {
    installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `mute-${runId}-${label}`,
    body: { organizationId: PERSONAL_REALM_ID, muted },
  });
  if (r.status !== 200) fail(`mute ${muted} failed (${r.status})`, r.payload);
  const d = data(r);
  if (d?.registered !== true || d?.notificationsMuted !== muted) fail(`mute ${muted} response mismatch`, d);
  return d;
};
const readMuted = async () => {
  const r = await gatewayPost('newone-api', `${muteRoute}/query`, keys, {
    installationId: eli.installationId, accessToken: eli.accessToken,
    body: { organizationId: PERSONAL_REALM_ID },
  });
  if (r.status !== 200) fail(`mute query failed (${r.status})`, r.payload);
  return data(r);
};
const deviceRow = async () => (await rows(`select notifications_muted, revoked_at from public.device_registrations
  where organization_id = '${PERSONAL_REALM_ID}' and user_id = '${eli.userId}' and installation_id = '${eli.installationId}'`))[0];

// Before anything: unmuted by default, and the query agrees with the row.
const initial = await readMuted();
if (initial?.registered !== true || initial?.notificationsMuted !== false) fail('fresh registration should read unmuted', initial);

// Mute through the route the Settings switch uses.
await setMuted(true, 'on');
const mutedRead = await readMuted();
const mutedRow = await deviceRow();
if (mutedRead?.notificationsMuted !== true || mutedRow?.notifications_muted !== true) fail('mute did not persist', { mutedRead, mutedRow });
console.log('muted → query', mutedRead.notificationsMuted, 'row', mutedRow.notifications_muted);

const send = async (n, body) => {
  const r = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
    installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `mute-${runId}-m${n}`,
    body: { organizationId: PERSONAL_REALM_ID, clientMessageId: randomUUID(), kind: 'text', body },
  });
  if (r.status !== 201) fail(`message ${n} failed (${r.status})`, r.payload);
  const d = data(r);
  return String(d?.messageId ?? d?.id ?? '');
};
const attemptFor = async (messageId) => (await rows(`select job.id as job_id, job.status as job_status, job.attempts,
    attempt.status, attempt.last_error_code, attempt.provider_ticket_id, attempt.attempt_count
  from private.outbox_jobs job
  left join private.push_delivery_attempts attempt on attempt.outbox_job_id = job.id and attempt.device_id = '${deviceId}'
  where job.topic = 'push' and job.organization_id = '${PERSONAL_REALM_ID}' and job.payload ->> 'message_id' = '${messageId}'
  order by job.id desc limit 1`))[0];
const waitForSettled = async (messageId, label) => {
  const started = Date.now();
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    const row = await attemptFor(messageId);
    if (row?.job_status === 'completed' && row?.status && !['pending', 'retry_wait'].includes(row.status)) {
      console.log(`${label}: settled after ${Math.round((Date.now() - started) / 1000)}s →`, JSON.stringify(row));
      return row;
    }
  }
  fail(`${label}: push delivery did not settle within 180s`, await attemptFor(messageId));
};

// 1. Muted: the delivery is skipped, nothing reaches the provider, the job completes.
const first = await send(1, `Muted test ${runId}`);
const skipped = await waitForSettled(first, 'muted delivery');
if (skipped.status !== 'permanent_failure' || skipped.last_error_code !== 'notifications_muted' || skipped.provider_ticket_id !== null) {
  fail('muted delivery was not settled as skipped', skipped);
}
if (Number(skipped.attempt_count) !== 1) fail('muted delivery was retried', skipped);

// 2. Unmuted: the next delivery is not skipped for mute (any provider outcome is fine).
await setMuted(false, 'off');
const unmutedRow = await deviceRow();
if (unmutedRow?.notifications_muted !== false) fail('unmute did not persist', unmutedRow);
const second = await send(2, `Unmuted test ${runId}`);
const delivered = await waitForSettled(second, 'unmuted delivery');
if (delivered.last_error_code === 'notifications_muted') fail('unmuted delivery was still skipped for mute', delivered);

console.log(`PASS: muted delivery skipped (${skipped.status}/${skipped.last_error_code}), unmuted delivery ${delivered.status}${delivered.last_error_code ? `/${delivered.last_error_code}` : ''}`);
