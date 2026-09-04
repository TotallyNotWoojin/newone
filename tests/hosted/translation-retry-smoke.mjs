// Real-API proof for the translation retry after a failed language detection:
// two real signups, a real English reply, the detection forced into the
// 'failed' state the way a provider outage leaves it, then the recipient
// asks for a translation through the same route the app uses. Expected: the
// request is accepted, detection re-runs, the translation completes, and the
// per-message limit refuses the fourth retry within the hour.
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import { PERSONAL_REALM_ID, fail, gatewayPost, loadAccessToken, managementSql, projectKeys, signupUser } from './smoke-lib.mjs';

const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ana = await signupUser(keys, { runId, label: 'ana', language: 'es' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });

const request = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `retry-${runId}-req`,
  body: { organizationId: PERSONAL_REALM_ID, targetUserId: eli.userId, body: 'Hola, ¿todo listo para el lunes?' },
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = (request.payload?.data ?? request.payload)?.conversationId;
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${ana.userId}/respond`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `retry-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const reply = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `retry-${runId}-rep`,
  body: { organizationId: PERSONAL_REALM_ID, clientMessageId: randomUUID(), kind: 'text', body: 'Yes, everything is ready for Monday.' },
});
if (reply.status !== 201) fail(`reply failed (${reply.status})`, reply.payload);
const messageId = String((reply.payload?.data ?? reply.payload)?.messageId ?? (reply.payload?.data ?? reply.payload)?.id ?? '');
if (!/^\d+$/.test(messageId)) fail('no message id in reply payload', reply.payload);

const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const forceFailure = () => rows(`
  do $$ begin
    perform set_config('app.bff_service_context', 'on', true);
    perform set_config('app.language_detection_context', 'on', true);
    update public.messages set language_detection_state = 'failed', detected_language = null,
      language_detection_method = 'newone-detector-v1', language_detection_confidence = null, language_detected_at = now()
      where id = ${messageId};
    update public.message_translations set status = 'blocked', failure_code = 'provider_unavailable',
      translated_body = null, provider = null, model = null, confidence = null
      where message_id = ${messageId};
  end $$;`);
const stateOf = async () => (await rows(`select language_detection_state as state, detected_language as lang from public.messages where id = ${messageId}`))[0];
const translationsOf = () => rows(`select target_language, status, failure_code from public.message_translations where message_id = ${messageId} order by target_language`);
const retry = (n) => gatewayPost('newone-api', `/v2/messages/${messageId}/translations`, keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `retry-${runId}-${n}`,
  body: { organizationId: PERSONAL_REALM_ID, conversationId, targetLanguage: 'es' },
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Let the normal pipeline finish first so the forced failure is unambiguous.
for (let i = 0; i < 20 && (await stateOf())?.state !== 'completed'; i += 1) await sleep(2000);
console.log('before:', JSON.stringify(await stateOf()), JSON.stringify(await translationsOf()));

await forceFailure();
console.log('forced:', JSON.stringify(await stateOf()), JSON.stringify(await translationsOf()));
const first = await retry(1);
console.log('retry 1 →', first.status, JSON.stringify(first.payload?.data ?? first.payload).slice(0, 160));
if (first.status !== 202) fail(`retry was not accepted (${first.status})`, first.payload);

let done = null;
for (let i = 0; i < 30; i += 1) {
  await sleep(2000);
  const s = await stateOf(); const t = await translationsOf();
  if (s?.state === 'completed' && t.some((r) => r.target_language === 'es' && r.status === 'completed')) { done = { s, t, seconds: (i + 1) * 2 }; break; }
}
if (!done) fail('detection or translation did not recover after the retry', { state: await stateOf(), translations: await translationsOf() });
console.log(`recovered in ≤${done.seconds}s:`, JSON.stringify(done.s), JSON.stringify(done.t));

// Spam guard: every further forced failure can be retried up to the per-message
// limit (3 per hour); the fourth is refused with 429.
const statuses = [];
for (let n = 2; n <= 4; n += 1) { await forceFailure(); const r = await retry(n); statuses.push(r.status); }
console.log('retries 2-4 →', statuses.join(', '));
if (statuses[0] !== 202 || statuses[1] !== 202 || statuses[2] !== 429) fail('rate limit did not behave (expected 202, 202, 429)', statuses);
console.log('PASS: translation retry after failed detection (accepted, recovered, rate-limited on the 4th)');
