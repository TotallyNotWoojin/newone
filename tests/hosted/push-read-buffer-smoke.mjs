// A notification is held back only when you read the message a while ago, not
// when you read it the same instant the push was being prepared.
//
// The rule added in v3.4 dropped a push whose message the reader had already
// read. It also dropped prompt ones: a reply lands while the chat is open, the
// app marks it read within a second, and the push resolves a moment later to
// find the cursor past it (owner's log, Sep 9 2026 — message at 09:23:44.2,
// push resolved at 09:23:44.8, dropped). Migration 20260909100000 gives the
// read half a second of grace. This proves both halves of that rule against
// the deployed resolver.
import { randomBytes, randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID, fail, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser,
} from './smoke-lib.mjs';

const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const rows = async (query) => {
  const r = await managementSql(accessToken, query);
  return Array.isArray(r) ? r : r?.result ?? [];
};
const data = (response) => response.payload?.data ?? response.payload;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });

const request = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `buf-${runId}-req`,
  body: { organizationId: PERSONAL_REALM_ID, targetUserId: eli.userId, body: 'Hello, buffer test.' },
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = data(request)?.conversationId;
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${ana.userId}/respond`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `buf-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);

// Eli's phone. The token is well-formed but not real, so the provider outcome
// is beside the point: what matters is whether the delivery was skipped for
// having been "already read".
const pushToken = `ExponentPushToken[buf${randomBytes(6).toString('hex')}xxxx]`;
const device = await gatewayPost('newone-api', '/v2/devices', keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `buf-${runId}-dev`,
  body: {
    organizationId: PERSONAL_REALM_ID, installationId: eli.installationId, platform: 'ios',
    pushToken, pushTokenType: 'expo', pushProjectId: randomUUID(), pushEnvironment: 'production',
    appVersion: '0.0.0-buffer-smoke', locale: 'en',
  },
});
if (device.status !== 200) fail(`device registration failed (${device.status})`, device.payload);

const readCursorTo = async (messageId, agoSeconds) => rows(`insert into public.conversation_read_cursors
    (organization_id, conversation_id, user_id, last_read_message_id, last_read_at)
  values ('${PERSONAL_REALM_ID}', '${conversationId}', '${eli.userId}', ${messageId},
    now() - interval '${agoSeconds} seconds')
  on conflict (organization_id, conversation_id, user_id) do update
    set last_read_message_id = ${messageId}, last_read_at = now() - interval '${agoSeconds} seconds'`);

const sendProbe = async (label) => {
  const body = `Buffer probe ${label} ${runId}`;
  const response = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
    installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `buf-${runId}-${label}`,
    body: {
      organizationId: PERSONAL_REALM_ID,
      clientMessageId: randomUUID(),
      body,
      languageCode: 'en',
    },
  });
  if (response.status !== 201) fail(`send ${label} failed (${response.status})`, response.payload);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const [row] = await rows(`select id from public.messages
      where conversation_id = '${conversationId}' and body = '${body}'`);
    if (row) return row.id;
    await sleep(500);
  }
  return fail(`the ${label} probe never reached the database`);
};

const attemptFor = async (messageId) => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const [row] = await rows(`select a.status, a.last_error_code
      from private.push_delivery_attempts a
      join private.outbox_jobs j on j.id = a.outbox_job_id
      where a.user_id = '${eli.userId}'
        and (j.payload->>'message_id')::bigint = ${messageId}`);
    if (row) return row;
    await sleep(1000);
  }
  return null;
};

// 1. Read the instant it arrives, which is what the app does with the chat
//    open. The notification must still go out.
const freshId = await sendProbe('fresh');
await readCursorTo(freshId, 0);
const fresh = await attemptFor(freshId);
if (!fresh) fail('no delivery was attempted for the fresh probe at all');
if (fresh.last_error_code === 'notifications_muted') {
  fail('a push was dropped for a message read this instant — the buffer is not working', fresh);
}
console.log('ok  read this instant: the notification still goes out —', fresh.status);

// 2. A late push for a message that has been sitting read: what the rule is
//    for. A message cannot be backdated — the service refuses to edit one —
//    so this waits for the first probe to age past the window and enqueues a
//    second push for it, which is what a retry or a stalled worker produces.
console.log('    waiting for the first probe to age past the window…');
await sleep(7_000);
await readCursorTo(freshId, 30);
const [late] = await rows(`insert into private.outbox_jobs
    (organization_id, topic, dedupe_key, payload, status, available_at)
  values ('${PERSONAL_REALM_ID}', 'push', 'buffer-smoke-${runId}',
    jsonb_build_object('message_id', ${freshId}, 'conversation_id', '${conversationId}',
      'organization_id', '${PERSONAL_REALM_ID}'),
    'pending', now())
  returning id`);
if (!late) fail('could not enqueue a late push for the aged probe');
// Wait for the attempt to settle: a row that is still pending has not been
// through the rule yet.
let stale = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  [stale] = await rows(`select status, last_error_code from private.push_delivery_attempts
    where outbox_job_id = ${late.id} and user_id = '${eli.userId}'`);
  if (stale && stale.status !== 'pending') break;
  stale = null;
  await sleep(1000);
}
if (!stale) fail('the late push was never attempted');
if (stale.last_error_code !== 'notifications_muted') {
  fail('a late push went out for a message read half a minute ago', stale);
}
console.log('ok  a late push for something already read is held back');

console.log(`PASS push-read-buffer-smoke: a read from the same instant does not suppress a notification, an older one does (conversation ${conversationId})`);
