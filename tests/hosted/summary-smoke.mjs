// Real-API proof for the conversation summary (v3.1, reader-defined scope):
// two real signups, a message request accepted, a short thread, then the
// requester asks for a summary of "today" about a subject through the route
// the app uses. A second, long thread (about 20,000 characters) is summarized
// as "everything", which the AI worker must cut into slices and merge.
// Expected: 202s, rows that reach draft with the scope columns filled, a
// "summary_range_empty" refusal for a range with nothing in it, provenance
// slices > 1 for the long run, and the timing of each.
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sent = 0;
const send = async (user, body) => {
  sent += 1;
  const r = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
    installationId: user.installationId, accessToken: user.accessToken, idempotencyKey: `sum-${runId}-m${sent}`,
    body: { organizationId: PERSONAL_REALM_ID, clientMessageId: randomUUID(), kind: 'text', body },
  });
  if (r.status !== 201) fail(`message ${sent} failed (${r.status})`, r.payload);
  const d = r.payload?.data ?? r.payload;
  return String(d?.messageId ?? d?.id ?? '');
};
await send(eli, 'Monday morning works. The paper arrives Friday so we can start at 8.');
await send(ana, 'Great. Please bring the two proof copies and the invoice for the client.');
await send(eli, 'Will do. I will also ask the courier to pick up at noon.');
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const utcOffsetMinutes = -new Date().getTimezoneOffset();
const requestSummary = async (label, range, expectedStatus = 202) => {
  const response = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/summaries`, keys, {
    installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `sum-${runId}-${label}`,
    body: { organizationId: PERSONAL_REALM_ID, languageCode: 'en', range: { utcOffsetMinutes, ...range } },
  });
  console.log(`summary request (${label}) →`, response.status, JSON.stringify(response.payload?.data ?? response.payload).slice(0, 300));
  if (response.status !== expectedStatus) fail(`summary request ${label} returned ${response.status}, expected ${expectedStatus}`, response.payload);
  return response.payload?.data ?? response.payload;
};
const summariesOf = () => rows(`select id, status, request_mode, failure_code, scope_kind, scope_subject,
    cardinality(source_message_ids) as source_count, processor_provenance->>'slices' as slices,
    primary_topic, left(summary_body, 240) as summary_body, decisions, action_items, created_at, updated_at
  from public.conversation_summaries where conversation_id = '${conversationId}' order by created_at desc`);
const waitForTerminal = async (summaryId, requestedAt) => {
  let final = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    const row = (await summariesOf()).find((entry) => entry.id === summaryId);
    if (row && !['queued', 'pending', 'generating', 'processing', 'requested'].includes(String(row.status))) { final = row; break; }
  }
  const seconds = Math.round((Date.now() - requestedAt) / 1000);
  console.log(`after ${seconds}s:`, JSON.stringify(final, null, 1));
  if (!final) fail(`summary ${summaryId} did not reach a terminal state within 180s`, await summariesOf());
  if (final.status !== 'draft' && final.status !== 'approved') {
    fail(`summary ended in ${final.status} (${final.failure_code ?? 'no failure code'})`, final);
  }
  const text = `${final.primary_topic ?? ''} ${final.summary_body ?? ''}`;
  if (/\bs[0-9]{4}\b/.test(text) || /participant [0-9]/i.test(text)) fail('summary text carries source ids or participant labels', final);
  return { final, seconds };
};

// 1. Today, about a subject: the four text messages so far.
const shortRequestedAt = Date.now();
const short = await requestSummary('today', { kind: 'today', subject: 'the print run' });
if (short.scopeKind !== 'today' || short.scopeSubject !== 'the print run' || short.sourceMessageCount !== 4) {
  fail('summary receipt did not echo the reader\'s scope', short);
}
const shortResult = await waitForTerminal(short.summaryId, shortRequestedAt);
if (shortResult.final.scope_kind !== 'today' || shortResult.final.scope_subject !== 'the print run' || Number(shortResult.final.source_count) !== 4) {
  fail('summary row did not keep the reader\'s scope', shortResult.final);
}
console.log(`PASS (today · about the print run): ${shortResult.final.status} in ≤${shortResult.seconds}s — topic: ${shortResult.final.primary_topic ?? '(none)'}`);

// 2. A range with nothing in it is refused by name, never queued.
const empty = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/summaries`, keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `sum-${runId}-yesterday`,
  body: { organizationId: PERSONAL_REALM_ID, languageCode: 'en', range: { kind: 'yesterday', utcOffsetMinutes } },
});
console.log('summary request (yesterday) →', empty.status, JSON.stringify(empty.payload).slice(0, 200));
if (empty.status !== 422 || !JSON.stringify(empty.payload).includes('summary_range_empty')) {
  fail('an empty range should answer 422 summary_range_empty', empty.payload);
}

// 3. A long thread (12 messages of ~1,700 characters ≈ 20,400 characters,
//    over the 18,000-character slice limit) summarized as "everything".
const topics = ['the paper stock', 'the courier pickup', 'the proof copies', 'the invoice', 'the press schedule', 'the client meeting'];
const longBody = (index) => {
  const topic = topics[index % topics.length];
  const sentences = [];
  for (let n = 1; sentences.join(' ').length < 1650; n += 1) {
    sentences.push(`Update ${index + 1}.${n} on ${topic}: we agreed to keep the plan as discussed and to confirm the details with the team before Monday.`);
  }
  return sentences.join(' ');
};
for (let index = 0; index < 12; index += 1) {
  await send(index % 2 === 0 ? eli : ana, longBody(index));
  await sleep(150);
}
const longRequestedAt = Date.now();
const long = await requestSummary('everything', { kind: 'everything', subject: null });
if (long.scopeKind !== 'everything' || long.sourceMessageCount !== 16) fail('long-range receipt did not cover every text message', long);
const longResult = await waitForTerminal(long.summaryId, longRequestedAt);
if (Number(longResult.final.slices) < 2 || Number(longResult.final.source_count) !== 16) {
  fail('the long range should have been summarized in slices', longResult.final);
}
const jobs = await rows(`select id, topic, status, attempts, last_error_code, created_at, completed_at from private.outbox_jobs
  where topic = 'summary' and organization_id = '${PERSONAL_REALM_ID}' and created_at > now() - interval '15 minutes' order by id desc limit 5`);
console.log('summary jobs:', JSON.stringify(jobs));
console.log(`PASS (everything, ${longResult.final.slices} slices, ${longResult.final.source_count} messages): ${longResult.final.status} in ≤${longResult.seconds}s — topic: ${longResult.final.primary_topic ?? '(none)'}`);
