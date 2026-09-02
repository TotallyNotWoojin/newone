#!/usr/bin/env node
// Real hosted translation smoke: an English speaker and a Spanish speaker
// exchange messages through the deployed gateways; the scheduled AI worker
// must complete language detection and produce completed translations via
// the pinned zero-retention OpenRouter route. Verified through durable
// message_translations rows.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/translation-smoke.mjs
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  fail,
  gatewayPost,
  loadAccessToken,
  managementSql,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  fail('Set NEWONE_HOSTED_E2E=1 to run the hosted translation smoke');
}

const runId = makeRunId();
const startedAt = new Date().toISOString();
const steps = [];
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);

const ana = await signupUser(keys, { runId, label: 'ana', language: 'es' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });
steps.push('two_signups_completed');

// Ana opens the conversation with a Spanish message request.
const request = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: ana.installationId,
  accessToken: ana.accessToken,
  idempotencyKey: `smoke-${runId}-req`,
  body: {
    organizationId: PERSONAL_REALM_ID,
    targetUserId: eli.userId,
    body: 'Hola, ¿cómo va el proyecto de la próxima semana?',
  },
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = (request.payload?.data ?? request.payload)?.conversationId;
steps.push('spanish_message_sent');

// Eli accepts and replies in English.
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${ana.userId}/respond`, keys, {
  installationId: eli.installationId,
  accessToken: eli.accessToken,
  idempotencyKey: `smoke-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
const reply = await gatewayPost('newone-api', `/v2/conversations/${conversationId}/messages`, keys, {
  installationId: eli.installationId,
  accessToken: eli.accessToken,
  idempotencyKey: `smoke-${runId}-rep`,
  body: {
    organizationId: PERSONAL_REALM_ID,
    clientMessageId: randomUUID(),
    kind: 'text',
    body: 'The project is on track, the review is scheduled for Monday.',
  },
});
if (reply.status !== 201) fail(`reply failed (${reply.status})`, reply.payload);
steps.push('english_reply_sent');

// Poll for completed translations (detection -> translation via the 10s worker).
let evidence = null;
for (let attempt = 0; attempt < 24; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const rows = await managementSql(accessToken, `
    select
      (select count(*) from public.message_translations
        where conversation_id = '${conversationId}'::uuid
          and status = 'completed'
          and char_length(coalesce(translated_body, '')) > 0) as completed,
      (select count(*) from public.message_translations
        where conversation_id = '${conversationId}'::uuid
          and status in ('failed', 'blocked')) as failed,
      (select count(*) from public.messages
        where conversation_id = '${conversationId}'::uuid
          and language_detection_state = 'completed'
          and kind <> 'system') as detected
  `);
  evidence = Array.isArray(rows) ? rows[0] : rows?.result?.[0];
  if (Number(evidence?.completed) >= 2) break;
  if (Number(evidence?.failed) > 0) break;
}
if (Number(evidence?.failed) > 0) fail('translations failed or were blocked', evidence);
if (Number(evidence?.completed) < 2) fail('translations did not complete in time', evidence);
steps.push('translations_completed');

// Show the actual translated texts as human-checkable evidence.
const texts = await managementSql(accessToken, `
  select target_language, left(translated_body, 120) as translated
  from public.message_translations
  where conversation_id = '${conversationId}'::uuid and status = 'completed'
  order by message_id
`);
const translations = Array.isArray(texts) ? texts : texts?.result ?? [];
steps.push('translated_texts_retrieved');

const artifact = {
  runId,
  kind: 'consumer-translation-smoke',
  projectRef: EXPECTED_PROJECT_REF,
  startedAt,
  finishedAt: new Date().toISOString(),
  identities: {
    ana: { email: ana.email, username: ana.username, userId: ana.userId, language: 'es' },
    eli: { email: eli.email, username: eli.username, userId: eli.userId, language: 'en' },
  },
  conversationId,
  evidence,
  translations,
  steps,
  cleanup: 'retained synthetic identities; sweep with the harness cleanup procedure',
};
const artifactDirectory = join(dirname(fileURLToPath(import.meta.url)), '.artifacts');
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = join(artifactDirectory, `${runId}-translation-smoke.json`);
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`PASS: hosted translation smoke (${steps.length} steps)`);
for (const row of translations) console.log(`  [${row.target_language}] ${row.translated}`);
console.log(`artifact: ${artifactPath}`);
