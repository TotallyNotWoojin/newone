// Real-API proof for backlog 47(f): naming somebody in a group notifies them
// even when they have muted the group.
//
// Three real signups (a group is three people or more), a group, Eli registers
// a device and mutes the conversation for an hour through the route the app's
// notification settings use. Ana then sends two messages: one that names
// nobody, and one that names Eli. The first must produce no push delivery for
// Eli's device — that is what muting means — and the second must produce one,
// because being named is how you reach somebody when the room is noisy.
//
// Requires the 20260908022000 migration to be deployed. Nothing else changed:
// the mention marker rides inside content_title, so the outbox worker is
// untouched by this and does not need redeploying for the smoke to pass.
import { randomBytes, randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  fail,
  gatewayPost,
  gatewayRequest,
  loadAccessToken,
  managementSql,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1 to run the mention push smoke');

const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const data = (response) => response.payload?.data ?? response.payload;
const rows = async (query) => {
  const result = await managementSql(accessToken, query);
  return Array.isArray(result) ? result : result?.result ?? [];
};

const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });
const cara = await signupUser(keys, { runId, label: 'cara', language: 'en' });
const post = (user, path, label, body) => gatewayPost('newone-api', path, keys, {
  installationId: user.installationId,
  accessToken: user.accessToken,
  idempotencyKey: `mention-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});

const request = await post(ana, '/v2/contacts/message-requests', 'req', {
  targetUserId: eli.userId,
  body: 'Hi Eli, group time.',
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const accept = await post(eli, `/v2/contacts/connections/${ana.userId}/respond`, 'acc', {
  decision: 'accepted',
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);

const group = await post(ana, '/v2/conversations/group', 'grp', {
  name: `Mention smoke ${runId}`,
  kind: 'group',
  memberAssignments: [
    { membershipId: eli.userId, role: 'member' },
    { membershipId: cara.userId, role: 'member' },
  ],
});
if (group.status !== 201) fail(`group creation failed (${group.status})`, group.payload);
const conversationId = data(group)?.conversationId;
if (!conversationId) fail('group creation returned no conversation', group.payload);
console.log('group →', conversationId);

// Eli's device. The push token is well-formed but not real, so any provider
// outcome is fine; what matters is whether a delivery row exists at all.
const pushToken = `ExponentPushToken[ment${randomBytes(6).toString('hex')}xxxx]`;
const device = await post(eli, '/v2/devices', 'dev', {
  installationId: eli.installationId,
  platform: 'ios',
  pushToken,
  pushTokenType: 'expo',
  pushProjectId: randomUUID(),
  pushEnvironment: 'production',
  appVersion: '0.0.0-mention-smoke',
  locale: 'en',
});
if (device.status !== 200 || data(device)?.registered !== true) {
  fail(`device registration failed (${device.status})`, device.payload);
}
const deviceId = data(device).deviceId;
console.log('device registered →', deviceId);

// Eli mutes the group for an hour, the way the app's chat settings do.
const mutedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const mute = await gatewayRequest('newone-api', 'PATCH', `/v2/conversations/${conversationId}/preferences`, keys, {
  installationId: eli.installationId,
  accessToken: eli.accessToken,
  idempotencyKey: `mention-${runId}-mute`,
  body: { organizationId: PERSONAL_REALM_ID, mutedUntil },
});
if (mute.status !== 200) fail(`muting the group failed (${mute.status})`, mute.payload);
const mutedRow = (await rows(`select muted_until from public.conversation_preferences
  where organization_id = '${PERSONAL_REALM_ID}' and conversation_id = '${conversationId}'
    and user_id = '${eli.userId}'`))[0];
console.log('muted until →', mutedRow?.muted_until ?? '(no preference row)');

const send = async (label, body, mentionUserIds) => {
  const response = await post(ana, `/v2/conversations/${conversationId}/messages`, label, {
    clientMessageId: randomUUID(),
    kind: 'text',
    body,
    ...(mentionUserIds ? { mentionUserIds } : {}),
  });
  if (response.status !== 201) fail(`send ${label} failed (${response.status})`, response.payload);
  const sent = data(response);
  const messageId = String(sent?.messageId ?? sent?.id ?? '');
  if (!messageId) fail(`send ${label} returned no message id`, sent);
  return messageId;
};

const jobFor = async (messageId) => (await rows(`select id, status from private.outbox_jobs
  where topic = 'push' and organization_id = '${PERSONAL_REALM_ID}'
    and payload ->> 'message_id' = '${messageId}' order by id desc limit 1`))[0];
const attemptFor = async (messageId) => (await rows(`select attempt.id, attempt.status
  from private.outbox_jobs job
  join private.push_delivery_attempts attempt on attempt.outbox_job_id = job.id
  where job.topic = 'push' and job.organization_id = '${PERSONAL_REALM_ID}'
    and job.payload ->> 'message_id' = '${messageId}'
    and attempt.device_id = '${deviceId}' limit 1`))[0];

const waitForJob = async (messageId, label) => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await sleep(2000);
    const job = await jobFor(messageId);
    if (job?.status === 'completed') return job;
  }
  fail(`${label}: the push job never completed`, await jobFor(messageId));
};

// 1. A message that names nobody, in a group Eli has muted: no delivery.
const quiet = await send('m1', `Nothing for anyone in particular ${runId}`);
await waitForJob(quiet, 'unmentioned message');
const quietAttempt = await attemptFor(quiet);
if (quietAttempt) fail('a muted group still pushed a message that named nobody', quietAttempt);
console.log('unmentioned message → no delivery for the muted device, as it should be');

// 2. A message that names Eli, in the same muted group: a delivery.
const named = await send('m2', `@Eli can you confirm the gate? ${runId}`, [eli.userId]);
const storedMention = (await rows(`select mentioned_user_id from public.message_mentions
  where organization_id = '${PERSONAL_REALM_ID}' and conversation_id = '${conversationId}'
    and message_id = ${named}`))[0];
if (storedMention?.mentioned_user_id !== eli.userId) {
  fail('the mention was not stored against the message', storedMention);
}
await waitForJob(named, 'mentioning message');
let namedAttempt = null;
for (let attempt = 0; attempt < 15 && !namedAttempt; attempt += 1) {
  namedAttempt = await attemptFor(named);
  if (!namedAttempt) await sleep(2000);
}
if (!namedAttempt) {
  fail('a mention did not get through the mute: no delivery was created for the named member');
}
console.log('mentioning message → delivery', namedAttempt.id, namedAttempt.status);

console.log(`PASS mention-push-smoke: muted group swallowed the unnamed message and let the mention through (conversation ${conversationId})`);
