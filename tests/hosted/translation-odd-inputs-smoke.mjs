// Real-API translation of the inputs people actually type: gibberish,
// fragments, emoji, mixed languages, numbers with units, codes, one-word
// replies. Each must reach a completed translation (or, for text with no
// language at all, a stated terminal outcome) without a review failure.
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const kim = await signupUser(keys, { runId, label: 'kim', language: 'ko' });
const post = (user, path, label, body) => gatewayPost('newone-api', path, keys, {
  installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `odd-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});
const request = await post(ana, '/v2/contacts/message-requests', 'req', { targetUserId: kim.userId, body: 'Hi Kim, testing odd inputs.' });
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = (request.payload?.data ?? request.payload)?.conversationId;
const accept = await post(kim, `/v2/contacts/connections/${ana.userId}/respond`, 'acc', { decision: 'accepted' });
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const cases = [
  ['gibberish', 'asdf qwer zxcv poiu'],
  ['fragment', "what's the weather of our erosion situation?\n\nerosion"],
  ['one-word', 'ok'],
  ['emoji-only', '👍👍🔥'],
  ['mixed', "Let's meet at 3, 감사합니다"],
  ['numbers-units', 'Set it to 14:30 and +2°C, ticket AB-1234'],
  ['shouting', 'WHERE ARE YOU?!?!'],
  ['url', 'see https://example.com/path?x=1 for details'],
];
const sent = [];
for (const [label, body] of cases) {
  const r = await post(ana, `/v2/conversations/${conversationId}/messages`, `m-${label}`, { clientMessageId: randomUUID(), kind: 'text', body });
  if (r.status !== 201) fail(`send ${label} failed (${r.status})`, r.payload);
  const d = r.payload?.data ?? r.payload; sent.push([label, String(d?.messageId ?? d?.id)]);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const outcomes = {};
for (let i = 0; i < 45 && Object.keys(outcomes).length < sent.length; i += 1) {
  await sleep(2000);
  for (const [label, id] of sent) {
    if (outcomes[label]) continue;
    const [m] = await rows(`select language_detection_state as det, detected_language as lang, language_detection_method as method from public.messages where id = ${id}`);
    const t = await rows(`select status, failure_code, left(translated_body, 60) as body from public.message_translations where message_id = ${id} and target_language = 'ko'`);
    const row = t[0];
    if (row && (row.status === 'completed' || row.status === 'failed' || row.status === 'blocked')) outcomes[label] = { det: m.det, lang: m.lang, method: (m.method ?? '').replace('openrouter:structured-v1', 'or'), status: row.status, failure: row.failure_code, body: row.body };
    else if (m.det === 'failed') outcomes[label] = { det: m.det, status: 'no-translation' };
  }
}
let bad = 0;
for (const [label] of sent) {
  const o = outcomes[label] ?? { status: 'timeout' };
  const ok = o.status === 'completed' || (label === 'emoji-only' && o.status !== 'timeout');
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'BAD '} ${label.padEnd(14)} det=${o.det ?? '-'}/${o.lang ?? '-'} ${o.method ?? ''} → ${o.status}${o.failure ? ' (' + o.failure + ')' : ''}${o.body ? ' :: ' + o.body : ''}`);
}
if (bad) fail(`${bad} odd input(s) did not translate`);
console.log('PASS: odd inputs all translated');
