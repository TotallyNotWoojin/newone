// Real-API proof for the conversation briefing (AI summary): two real
// signups, a message request accepted, three real messages, then the
// requester asks for a summary draft through the route the app uses.
// Expected: 202, a conversation_summaries row that reaches a terminal state,
// and the timing from request to that state.
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';
const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });
const request = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `sum-${runId}-req`,
  body: { organizationId: PERSONAL_REALM_ID, targetUserId: eli.userId, body: 'Hi Eli, can we move the print run to Monday morning?' },
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = (request.payload?.data ?? request.payload)?.conversationId;
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${ana.userId}/respond`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `sum-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const send = async (user, n, body) => {
  const r = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
    installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `sum-${runId}-m${n}`,
    body: { organizationId: PERSONAL_REALM_ID, clientMessageId: randomUUID(), kind: 'text', body },
  });
  if (r.status !== 201) fail(`message ${n} failed (${r.status})`, r.payload);
  const d = r.payload?.data ?? r.payload;
  return String(d?.messageId ?? d?.id ?? '');
};
const ids = [
  await send(eli, 1, 'Monday morning works. The paper arrives Friday so we can start at 8.'),
  await send(ana, 2, 'Great. Please bring the two proof copies and the invoice for the client.'),
  await send(eli, 3, 'Will do. I will also ask the courier to pick up at noon.'),
];
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const sourceMessageIds = ids.map((id) => Number(id));
const requestedAt = Date.now();
const summary = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/summaries`, keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `sum-${runId}-s1`,
  body: { organizationId: PERSONAL_REALM_ID, sourceMessageIds, languageCode: 'en' },
});
console.log('summary request →', summary.status, JSON.stringify(summary.payload?.data ?? summary.payload).slice(0, 300));
if (summary.status !== 202) fail(`summary request was not accepted (${summary.status})`, summary.payload);
const summariesOf = () => rows(`select id, status, request_mode, failure_code, primary_topic, left(summary_body, 240) as summary_body, created_at, updated_at
  from public.conversation_summaries where conversation_id = '${conversationId}' order by created_at desc`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let final = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(2000);
  const list = await summariesOf();
  const row = list[0];
  if (row && !['queued', 'pending', 'generating', 'processing', 'requested'].includes(String(row.status))) { final = row; break; }
}
const seconds = Math.round((Date.now() - requestedAt) / 1000);
const list = await summariesOf();
console.log(`after ${seconds}s:`, JSON.stringify(list, null, 1));
const jobs = await rows(`select id, topic, status, attempts, last_error_code, created_at, completed_at from private.outbox_jobs
  where topic = 'summary' and organization_id = '${PERSONAL_REALM_ID}' and created_at > now() - interval '10 minutes' order by id desc limit 3`);
console.log('summary jobs:', JSON.stringify(jobs));
if (!final) fail('summary did not reach a terminal state within 120s', list);
if (final.status !== 'draft' && final.status !== 'completed' && final.status !== 'unapproved') {
  fail(`summary ended in ${final.status} (${final.failure_code ?? 'no failure code'})`, final);
}
console.log(`PASS: summary ${final.status} in ≤${seconds}s — topic: ${final.primary_topic ?? '(none)'}`);
