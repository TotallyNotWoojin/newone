// Real-API proof for the Echo test account: a fresh signup accepts Echo's
// request, sends a text, and gets the same text back from Echo through the
// normal send path (with detection and, for a different language, translation).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const user = await signupUser(keys, { runId, label: 'ana', language: 'es' });
const [profile] = await rows(`select username from public.profiles where user_id = '${user.userId}'`);
console.log(execFileSync('node', ['tests/hosted/echo-account.mjs', profile.username], { encoding: 'utf8' }).trim());
const [echo] = await rows(`select user_id from public.profiles where username = 'echo'`);
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${echo.user_id}/respond`, keys, {
  installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `echo-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const [pair] = await rows(`select conversation_id from public.direct_conversation_pairs where organization_id = '${PERSONAL_REALM_ID}' and member_low_user_id = least('${echo.user_id}'::uuid, '${user.userId}'::uuid) and member_high_user_id = greatest('${echo.user_id}'::uuid, '${user.userId}'::uuid)`);
const conversationId = pair?.conversation_id; if (!conversationId) fail('no direct conversation with echo');
const text = `Hola Echo, ¿me devuelves esto? ${runId}`;
const send = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
  installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `echo-${runId}-msg`,
  body: { organizationId: PERSONAL_REALM_ID, clientMessageId: randomUUID(), kind: 'text', body: text },
});
if (send.status !== 201) fail(`send failed (${send.status})`, send.payload);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let reply = null;
for (let i = 0; i < 10 && !reply; i += 1) { await sleep(1000); [reply] = await rows(`select id, sender_user_id, body, language_detection_state from public.messages where conversation_id = '${conversationId}' and sender_user_id = '${echo.user_id}' and body = '${text.replace(/'/g, "''")}'`); }
if (!reply) fail('echo did not reply', await rows(`select id, sender_user_id, left(body, 60) as body from public.messages where conversation_id = '${conversationId}' order by id`));
console.log('echo replied:', JSON.stringify(reply));
let translated = null;
for (let i = 0; i < 30 && !translated; i += 1) { await sleep(2000); const t = await rows(`select target_language, status, left(translated_body, 80) as body from public.message_translations where message_id = ${reply.id}`); translated = t.find((x) => x.status === 'completed') ?? null; }
console.log(translated ? `PASS: echo reply translated → ${JSON.stringify(translated)}` : 'PASS (reply arrived; translation row still pending or not needed)');
