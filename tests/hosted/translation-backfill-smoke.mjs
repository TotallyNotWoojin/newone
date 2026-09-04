// Real-API proof: a member who turned translation Off, received a message,
// and switched back to Automatic gets that message translated without asking.
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayRequest, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'es' });
const post = (user, path, label, body) => gatewayPost('newone-api', path, keys, {
  installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `bf-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});
const request = await post(ana, '/v2/contacts/message-requests', 'req', { targetUserId: eli.userId, body: 'Hello Eli, first message.' });
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = (request.payload?.data ?? request.payload)?.conversationId;
const accept = await post(eli, `/v2/contacts/connections/${ana.userId}/respond`, 'acc', { decision: 'accepted' });
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const prefs = (label, mode) => gatewayRequest('newone-api', 'PATCH', `/v2/conversations/${conversationId}/preferences`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `bf-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, translationMode: mode },
});
const off = await prefs('off', 'off');
console.log('translation off →', off.status, JSON.stringify(off.payload?.data ?? off.payload).slice(0, 120));
if (off.status !== 200) fail(`could not turn translation off (${off.status})`, off.payload);
const send = await post(ana, `/v2/conversations/${conversationId}/messages`, 'msg', { clientMessageId: randomUUID(), kind: 'text', body: 'The delivery is confirmed for Tuesday afternoon.' });
if (send.status !== 201) fail(`send failed (${send.status})`, send.payload);
const d = send.payload?.data ?? send.payload; const messageId = String(d?.messageId ?? d?.id ?? '');
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const detection = async () => (await rows(`select language_detection_state as state, detected_language as lang from public.messages where id = ${messageId}`))[0];
for (let i = 0; i < 20 && (await detection())?.state !== 'completed'; i += 1) await sleep(2000);
console.log('detection:', JSON.stringify(await detection()));
const translationsOf = () => rows(`select target_language, status, left(translated_body, 80) as body from public.message_translations where message_id = ${messageId}`);
console.log('while off:', JSON.stringify(await translationsOf()));
if ((await translationsOf()).some((t) => t.target_language === 'es')) fail('a Spanish translation row exists although translation was off');
const on = await prefs('on', 'automatic');
console.log('translation automatic →', on.status);
if (on.status !== 200) fail(`could not turn translation on (${on.status})`, on.payload);
let done = null;
for (let i = 0; i < 30; i += 1) { await sleep(2000); const t = await translationsOf(); if (t.some((r) => r.target_language === 'es' && r.status === 'completed')) { done = { t, seconds: (i + 1) * 2 }; break; } }
if (!done) fail('the message received while off was not translated after re-enabling', await translationsOf());
console.log(`PASS: backfilled after re-enable in ≤${done.seconds}s →`, JSON.stringify(done.t));
