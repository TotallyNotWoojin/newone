#!/usr/bin/env node
// Real hosted two-user consumer journey against the linked development
// project: both users sign up through the deployed gateway, user A finds
// user B by username search, sends a message request with a first message,
// both sides observe the pending states, B accepts, B replies, and durable
// database state is verified through the Management API.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/discovery-smoke.mjs
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_PROJECT_REF, makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  adminRequest,
  fail,
  gatewayPost,
  loadAccessToken,
  managementSql,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  fail('Set NEWONE_HOSTED_E2E=1 to run the hosted discovery smoke');
}

const runId = makeRunId();
const startedAt = new Date().toISOString();
const steps = [];
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);

// Step 1: two real signups through the deployed gateway.
const alice = await signupUser(keys, { runId, label: 'alice', language: 'en' });
const bruno = await signupUser(keys, { runId, label: 'bruno', language: 'es' });
steps.push('two_signups_completed');

async function search(actor, query) {
  const result = await gatewayPost('newone-read', '/v2/users/search', keys, {
    installationId: actor.installationId,
    accessToken: actor.accessToken,
    body: { organizationId: PERSONAL_REALM_ID, query, limit: 10 },
  });
  if (result.status !== 200) fail(`user search failed (${result.status})`, result.payload);
  return (result.payload?.data?.users ?? result.payload?.users ?? []);
}

// Step 2: A finds B by username prefix; stranger state is 'none'.
const found = await search(alice, bruno.username.slice(0, 12));
const brunoCard = found.find((user) => user.userId === bruno.userId);
if (!brunoCard) fail('search did not surface the target user', found);
if (brunoCard.connectionState !== 'none') fail('stranger state mismatch', brunoCard);
if (brunoCard.username !== bruno.username) fail('search username mismatch', brunoCard);
steps.push('search_found_stranger');

// Step 3: A sends a message request with the first message.
const requestSend = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: alice.installationId,
  accessToken: alice.accessToken,
  idempotencyKey: `smoke-${runId}-request`,
  body: {
    organizationId: PERSONAL_REALM_ID,
    targetUserId: bruno.userId,
    body: 'Hola! Message request smoke — first message rides along.',
  },
});
if (requestSend.status !== 201) {
  fail(`message request failed (${requestSend.status})`, requestSend.payload);
}
const requestData = requestSend.payload?.data ?? requestSend.payload ?? {};
const conversationId = requestData.conversationId;
if (requestData.connectionStatus !== 'pending' || typeof conversationId !== 'string') {
  fail('message request response shape mismatch', requestData);
}
steps.push('message_request_sent');

// Step 4: both sides observe the pending direction.
const aliceView = (await search(alice, bruno.username)).find((user) => user.userId === bruno.userId);
if (aliceView?.connectionState !== 'pending_outgoing') fail('requester state mismatch', aliceView);
const brunoView = (await search(bruno, alice.username)).find((user) => user.userId === alice.userId);
if (brunoView?.connectionState !== 'pending_incoming') fail('recipient state mismatch', brunoView);
steps.push('pending_states_visible_both_sides');

// Step 5: B accepts the request.
const accept = await gatewayPost(
  'newone-api',
  `/v2/contacts/connections/${alice.userId}/respond`,
  keys,
  {
    installationId: bruno.installationId,
    accessToken: bruno.accessToken,
    idempotencyKey: `smoke-${runId}-accept`,
    body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
  },
);
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);
steps.push('request_accepted');

// Step 6: B replies in the now-open conversation.
const reply = await gatewayPost(
  'newone-api',
  `/v2/conversations/${conversationId}/messages`,
  keys,
  {
    installationId: bruno.installationId,
    accessToken: bruno.accessToken,
    idempotencyKey: `smoke-${runId}-reply`,
    body: {
      organizationId: PERSONAL_REALM_ID,
      clientMessageId: randomUUID(),
      kind: 'text',
      body: 'Accepted — replying works.',
    },
  },
);
if (reply.status !== 201) fail(`reply failed (${reply.status})`, reply.payload);
steps.push('recipient_replied');

// Step 7: durable database evidence.
const evidenceRows = await managementSql(accessToken, `
  select
    (select status from public.contact_connections
      where organization_id = '${PERSONAL_REALM_ID}'
        and member_low_user_id = least('${alice.userId}'::uuid, '${bruno.userId}'::uuid)
        and member_high_user_id = greatest('${alice.userId}'::uuid, '${bruno.userId}'::uuid)
    ) as connection_status,
    (select count(*) from public.messages
      where organization_id = '${PERSONAL_REALM_ID}'
        and conversation_id = '${conversationId}'::uuid
        and kind <> 'system'
    ) as message_count,
    (select count(*) from public.conversation_members
      where organization_id = '${PERSONAL_REALM_ID}'
        and conversation_id = '${conversationId}'::uuid
    ) as member_count
`);
const evidence = Array.isArray(evidenceRows) ? evidenceRows[0] : evidenceRows?.result?.[0];
if (evidence?.connection_status !== 'accepted') fail('connection not accepted in DB', evidence);
if (Number(evidence?.message_count) !== 2) fail('expected exactly 2 messages', evidence);
if (Number(evidence?.member_count) !== 2) fail('expected exactly 2 members', evidence);
steps.push('database_state_verified');

const artifact = {
  runId,
  kind: 'consumer-discovery-smoke',
  projectRef: EXPECTED_PROJECT_REF,
  startedAt,
  finishedAt: new Date().toISOString(),
  identities: {
    alice: { email: alice.email, username: alice.username, userId: alice.userId },
    bruno: { email: bruno.email, username: bruno.username, userId: bruno.userId },
  },
  conversationId,
  steps,
  cleanup: 'retained synthetic identities; sweep with the harness cleanup procedure',
};
const artifactDirectory = join(dirname(fileURLToPath(import.meta.url)), '.artifacts');
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = join(artifactDirectory, `${runId}-discovery-smoke.json`);
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`PASS: hosted consumer discovery smoke (${steps.length} steps)`);
console.log(`identities: ${alice.username} -> ${bruno.username}`);
console.log(`artifact: ${artifactPath}`);
