// Real-API proof for mixed-language messages: two English speakers; A sends a
// line with a Korean part; detection falls back to the sender's language, so
// B gets no automatic translation, and B can request one into English.
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const ben = await signupUser(keys, { runId, label: 'ben', language: 'en' });
const post = (user, path, label, body) => gatewayPost('newone-api', path, keys, {
  installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `mix-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const request = await post(ana, '/v2/contacts/message-requests', 'req', { targetUserId: ben.userId, body: 'Hi Ben' });
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = (request.payload?.data ?? request.payload)?.conversationId;
const accept = await post(ben, `/v2/contacts/connections/${ana.userId}/respond`, 'acc', { decision: 'accepted' });
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const send = await post(ana, `/v2/conversations/${conversationId}/messages`, 'msg', { clientMessageId: randomUUID(), kind: 'text', body: "Let's meet at 3, 감사합니다 그리고 내일 봐요" });
if (send.status !== 201) fail(`send failed (${send.status})`, send.payload);
const d = send.payload?.data ?? send.payload; const messageId = String(d?.messageId ?? d?.id ?? '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let det; for (let i = 0; i < 20; i += 1) { await sleep(2000); [det] = await rows(`select language_detection_state as s, detected_language as l, language_detection_method as m from public.messages where id = ${messageId}`); if (det.s === 'completed' || det.s === 'failed' || det.s === 'ambiguous') break; }
console.log('detection:', JSON.stringify(det));
const before = await rows(`select target_language, status from public.message_translations where message_id = ${messageId}`);
console.log('automatic rows (same language, expected none):', JSON.stringify(before));
const req = await post(ben, `/v2/messages/${messageId}/translations`, 'ask', { conversationId, targetLanguage: 'en' });
console.log('request →', req.status, JSON.stringify(req.payload?.data ?? req.payload).slice(0, 160));
if (req.status !== 202) fail(`request was not accepted (${req.status})`, req.payload);
let done = null; for (let i = 0; i < 30; i += 1) { await sleep(2000); const t = await rows(`select target_language, status, failure_code, source_language, left(translated_body, 80) as body from public.message_translations where message_id = ${messageId} and target_language = 'en'`); if (t[0] && ['completed','failed','blocked'].includes(t[0].status)) { done = t[0]; break; } }
if (!done || done.status !== 'completed') fail('mixed request did not complete', done);
console.log(`PASS: mixed message translated for a same-language reader (source ${done.source_language}) → ${done.body}`);
