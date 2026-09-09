#!/usr/bin/env node
// What the app actually waits for. Times the reads a chat screen depends on:
// the full bootstrap the client runs on entering a chat and after every send,
// against the single-conversation page read that already exists beside it.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/latency-probe.mjs [groupSize]
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID, fail, gatewayPost, gatewayRequest, loadAccessToken, projectKeys, signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1');
const keys = projectKeys(loadAccessToken());
const ORG = PERSONAL_REALM_ID;
const runId = makeRunId();
const MEMBERS = Number(process.argv[2] ?? 4);
const MESSAGES = Number(process.argv[3] ?? 60);

const api = (actor, method, path, body) => gatewayRequest('newone-api', method, path, keys, {
  installationId: actor.installationId,
  accessToken: actor.accessToken,
  idempotencyKey: randomUUID(),
  body: { organizationId: ORG, ...body },
});
const read = (actor, path, body) => gatewayPost('newone-read', path, keys, {
  installationId: actor.installationId,
  accessToken: actor.accessToken,
  body: { organizationId: ORG, ...body },
});

async function timed(label, run, times = 5) {
  const samples = [];
  let last = null;
  for (let i = 0; i < times; i += 1) {
    const started = performance.now();
    last = await run();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`${label.padEnd(42)} median ${median.toFixed(0).padStart(5)}ms   min ${samples[0].toFixed(0)}  max ${samples.at(-1).toFixed(0)}`);
  return { median, last };
}

console.log(`building a ${MEMBERS}-person group with ${MESSAGES} messages...`);
const people = [];
for (let i = 0; i < MEMBERS; i += 1) {
  people.push(await signupUser(keys, { runId, label: `lat${i}`, language: i === 1 ? 'es' : 'en' }));
}
const [owner, ...others] = people;

const group = await api(owner, 'POST', '/v2/conversations/group', {
  name: `Latency ${runId}`,
  kind: 'group',
  memberAssignments: others.map((person) => ({ membershipId: person.userId, role: 'member' })),
});
const conversationId = group.payload?.conversationId;
if (!conversationId) fail('group not created', group);

for (let i = 0; i < MESSAGES; i += 1) {
  const sender = people[i % people.length];
  await api(sender, 'POST', `/v2/conversations/${conversationId}/messages`, {
    clientMessageId: randomUUID(), kind: 'text', body: `message ${i}`,
  });
}

// A second conversation each, so the chat list is not a single row.
for (const person of others) {
  await api(owner, 'POST', '/v2/conversations/direct', {
    targetMembershipId: person.userId,
  });
}

console.log('\n--- what the client waits for ---');
await timed('bootstrap (no conversation selected)', () => read(owner, '/v2/bootstrap', {
  selectedConversationId: null, beforeMessageId: null, conversationLimit: 100, timelineLimit: 100,
}));
await timed('bootstrap (a chat open) — every send too', () => read(owner, '/v2/bootstrap', {
  selectedConversationId: conversationId, beforeMessageId: null, conversationLimit: 100, timelineLimit: 100,
}));
await timed('one conversation page (100 messages)', () => read(
  owner, `/v2/conversations/${conversationId}/messages/query`, { beforeMessageId: null, limit: 100 },
));
await timed('one conversation page (30 messages)', () => read(
  owner, `/v2/conversations/${conversationId}/messages/query`, { beforeMessageId: null, limit: 30 },
));
await timed('send a message', () => api(owner, 'POST', `/v2/conversations/${conversationId}/messages`, {
  clientMessageId: randomUUID(), kind: 'text', body: 'timing',
}), 5);

const boot = await read(owner, '/v2/bootstrap', {
  selectedConversationId: conversationId, beforeMessageId: null, conversationLimit: 100, timelineLimit: 100,
});
console.log('\nbootstrap payload:', (JSON.stringify(boot.payload).length / 1024).toFixed(0), 'KB');
const page = await read(owner, `/v2/conversations/${conversationId}/messages/query`, { beforeMessageId: null, limit: 100 });
console.log('one page payload:  ', (JSON.stringify(page.payload).length / 1024).toFixed(0), 'KB');
