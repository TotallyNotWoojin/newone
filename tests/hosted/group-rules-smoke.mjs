// Real-API proof of the four group rules the owner asked for (backlog 36, 37,
// 50):
//   1. a group of two is refused at creation;
//   2. the same set of people is never made twice -- the existing group comes
//      back instead, with its own outcome;
//   3. a muted person produces no push delivery;
//   4. a blocked person's group message is invisible to the blocker and still
//      visible to everyone else, and the group carries on.
// Requires migrations 20260908011000-20260908016000 and the newone-api,
// newone-read and newone-outbox-worker functions from the same change to be
// deployed.
import { randomBytes, randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID, fail, gatewayPost, gatewayRequest, loadAccessToken, managementSql,
  projectKeys, signupUser,
} from './smoke-lib.mjs';

const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const ORG = PERSONAL_REALM_ID;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = async (query) => {
  const r = await managementSql(accessToken, query);
  return Array.isArray(r) ? r : r?.result ?? [];
};
const data = (response) => response.payload?.data ?? response.payload;
const api = (actor, method, path, label, body = {}) => gatewayRequest('newone-api', method, path, keys, {
  installationId: actor.installationId,
  accessToken: actor.accessToken,
  idempotencyKey: `grules-${runId}-${label}`,
  body: { organizationId: ORG, ...body },
});
const read = (actor, path, body = {}) => gatewayPost('newone-read', path, keys, {
  installationId: actor.installationId,
  accessToken: actor.accessToken,
  body: { organizationId: ORG, ...body },
});

const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const ben = await signupUser(keys, { runId, label: 'ben', language: 'en' });
const cara = await signupUser(keys, { runId, label: 'cara', language: 'en' });
const dev = await signupUser(keys, { runId, label: 'dev', language: 'en' });
console.log('ok  four accounts');

// ---------------------------------------------------------------------------
// 1. A group needs three people.
// ---------------------------------------------------------------------------
const tooSmall = await api(ana, 'POST', '/v2/conversations/group', 'small', {
  name: `Too small ${runId}`,
  kind: 'group',
  memberAssignments: [{ membershipId: ben.userId, role: 'member' }],
});
if (tooSmall.status !== 400) {
  fail(`a two-person group was not refused (${tooSmall.status})`, tooSmall.payload);
}
const smallCount = Number((await rows(`select count(*)::int as n from public.conversations
  where organization_id = '${ORG}' and name = 'Too small ${runId}'`))[0]?.n ?? -1);
if (smallCount !== 0) fail('a refused group was still written', smallCount);
console.log('ok  two people refused at creation (400, nothing written)');

// ---------------------------------------------------------------------------
// 2. The same set of people is never made twice.
// ---------------------------------------------------------------------------
const trio = [
  { membershipId: ben.userId, role: 'member' },
  { membershipId: cara.userId, role: 'member' },
];
const first = await api(ana, 'POST', '/v2/conversations/group', 'first', {
  name: `Crew ${runId}`, kind: 'group', memberAssignments: trio,
});
if (first.status !== 201) fail(`group creation failed (${first.status})`, first.payload);
const conversationId = data(first)?.conversationId;
if (!conversationId) fail('group creation returned no conversation id', first.payload);
console.log('ok  group created', conversationId);

// The same people in the other order, under a different name.
const again = await api(ana, 'POST', '/v2/conversations/group', 'again', {
  name: `Crew again ${runId}`,
  kind: 'group',
  memberAssignments: [trio[1], trio[0]],
});
if (again.status !== 200) fail(`a duplicate member set was not recognised (${again.status})`, again.payload);
const existing = data(again);
if (existing?.alreadyExists !== true || existing?.conversationId !== conversationId) {
  fail('the duplicate answer did not point at the group that exists', existing);
}
const duplicateCount = Number((await rows(`select count(*)::int as n from public.conversations
  where organization_id = '${ORG}' and name = 'Crew again ${runId}'`))[0]?.n ?? -1);
if (duplicateCount !== 0) fail('a second group was created anyway', duplicateCount);
console.log('ok  same people, no second group; the existing one came back');

// A different set of people is a different group.
const wider = await api(ana, 'POST', '/v2/conversations/group', 'wider', {
  name: `Crew plus ${runId}`,
  kind: 'group',
  memberAssignments: [...trio, { membershipId: dev.userId, role: 'member' }],
});
if (wider.status !== 201 || data(wider)?.conversationId === conversationId) {
  fail(`a different member set did not create its own group (${wider.status})`, wider.payload);
}
console.log('ok  a different set of people is its own group', data(wider).conversationId);

const signature = (await rows(`select members_signature, member_count
  from private.conversation_member_signatures
  where organization_id = '${ORG}' and conversation_id = '${conversationId}'`))[0];
if (!signature?.members_signature || Number(signature.member_count) !== 3) {
  fail('the members signature was not maintained at creation', signature);
}
console.log('ok  members signature stored', signature.members_signature, signature.member_count);

// ---------------------------------------------------------------------------
// 3. A muted person produces no push delivery.
// ---------------------------------------------------------------------------
const pushToken = `ExponentPushToken[grules${randomBytes(5).toString('hex')}xx]`;
const device = await gatewayPost('newone-api', '/v2/devices', keys, {
  installationId: ben.installationId,
  accessToken: ben.accessToken,
  idempotencyKey: `grules-${runId}-dev`,
  body: {
    organizationId: ORG, installationId: ben.installationId, platform: 'ios',
    pushToken, pushTokenType: 'expo', pushProjectId: randomUUID(),
    pushEnvironment: 'production', appVersion: '0.0.0-group-rules-smoke', locale: 'en',
  },
});
if (device.status !== 200 || data(device)?.registered !== true) {
  fail(`device registration failed (${device.status})`, device.payload);
}
const deviceId = data(device).deviceId;

const mute = await api(ben, 'PUT', `/v2/people/${ana.userId}/mute`, 'mute-on');
if (mute.status !== 200 || data(mute)?.muted !== true) {
  fail(`muting Ana failed (${mute.status})`, mute.payload);
}
const muteRow = (await rows(`select 1 as present from public.person_mutes
  where organization_id = '${ORG}' and muter_user_id = '${ben.userId}'
    and muted_user_id = '${ana.userId}'`))[0];
if (!muteRow) fail('the mute was not stored');

const send = async (label, body) => {
  const r = await api(ana, 'POST', `/v2/conversations/${conversationId}/messages`, label, {
    clientMessageId: randomUUID(), kind: 'text', body,
  });
  if (r.status !== 201) fail(`message ${label} failed (${r.status})`, r.payload);
  const d = data(r);
  return String(d?.messageId ?? d?.id ?? '');
};
const attemptFor = async (messageId) => (await rows(`select job.id as job_id, job.status as job_status,
    attempt.status, attempt.last_error_code, attempt.provider_ticket_id
  from private.outbox_jobs job
  left join private.push_delivery_attempts attempt
    on attempt.outbox_job_id = job.id and attempt.device_id = '${deviceId}'
  where job.topic = 'push' and job.organization_id = '${ORG}'
    and job.payload ->> 'message_id' = '${messageId}'
  order by job.id desc limit 1`))[0];
const waitForSettled = async (messageId, label) => {
  for (let i = 0; i < 90; i += 1) {
    await sleep(2000);
    const row = await attemptFor(messageId);
    if (row?.job_status === 'completed' && row?.status && !['pending', 'retry_wait'].includes(row.status)) {
      return row;
    }
  }
  fail(`${label}: push delivery did not settle within 180s`, await attemptFor(messageId));
};

const mutedMessageId = await send('m-muted', `Muted person test ${runId}`);
const skipped = await waitForSettled(mutedMessageId, 'muted person');
if (
  skipped.status !== 'permanent_failure'
  || skipped.last_error_code !== 'notifications_muted'
  || skipped.provider_ticket_id !== null
) fail('a muted person still produced a push delivery', skipped);
console.log('ok  muted person: delivery skipped, nothing sent to the provider');

const unmute = await api(ben, 'DELETE', `/v2/people/${ana.userId}/mute`, 'mute-off');
if (unmute.status !== 200) fail(`unmuting failed (${unmute.status})`, unmute.payload);
const unmutedMessageId = await send('m-unmuted', `Unmuted person test ${runId}`);
const delivered = await waitForSettled(unmutedMessageId, 'unmuted person');
if (delivered.last_error_code === 'notifications_muted') {
  fail('an unmuted person was still skipped for mute', delivered);
}
console.log('ok  unmuted person: delivery not skipped for mute', delivered.status);

// The muted person was never hidden: Ben still sees both messages.
const benTimeline = await read(ben, `/v2/conversations/${conversationId}/messages/query`, { limit: 50 });
if (benTimeline.status !== 200) fail(`Ben's page read failed (${benTimeline.status})`, benTimeline.payload);
const benBodies = (data(benTimeline)?.messages ?? []).map((m) => m.body ?? m.originalBody ?? '');
if (!benBodies.some((body) => body.includes(`Muted person test ${runId}`))) {
  fail('muting hid a message; it must only silence notifications', benBodies);
}
console.log('ok  muting hid nothing');

// ---------------------------------------------------------------------------
// 4. A blocked person's group message is hidden from the blocker only.
// ---------------------------------------------------------------------------
const block = await api(cara, 'PUT', `/v2/people/${ana.userId}/block`, 'block-on');
if (block.status !== 200) fail(`blocking Ana failed (${block.status})`, block.payload);

const blockedBody = `Blocked person test ${runId}`;
const blockedMessageId = await send('m-blocked', blockedBody);
if (!blockedMessageId) fail('the blocked-sender message was not accepted');

const bodiesFor = async (actor, label) => {
  const page = await read(actor, `/v2/conversations/${conversationId}/messages/query`, { limit: 50 });
  if (page.status !== 200) fail(`${label} page read failed (${page.status})`, page.payload);
  return (data(page)?.messages ?? []).map((m) => m.body ?? m.originalBody ?? '');
};
const caraBodies = await bodiesFor(cara, 'Cara');
if (caraBodies.some((body) => body.includes(blockedBody))) {
  fail('a blocked person’s message was still visible to the blocker', caraBodies);
}
const benAfterBlock = await bodiesFor(ben, 'Ben');
if (!benAfterBlock.some((body) => body.includes(blockedBody))) {
  fail('blocking removed the message for everyone else too', benAfterBlock);
}
console.log('ok  blocked sender hidden from the blocker, visible to everyone else');

// The group carries on for the blocker: she can still post and be read.
const caraBody = `Cara carries on ${runId}`;
const caraSend = await api(cara, 'POST', `/v2/conversations/${conversationId}/messages`, 'm-cara', {
  clientMessageId: randomUUID(), kind: 'text', body: caraBody,
});
if (caraSend.status !== 201) fail(`the blocker could not post (${caraSend.status})`, caraSend.payload);
const benSeesCara = await bodiesFor(ben, 'Ben');
if (!benSeesCara.some((body) => body.includes(caraBody))) {
  fail('the group did not carry on for everyone else', benSeesCara);
}
const activeMembers = Number((await rows(`select count(*)::int as n from public.conversation_members
  where organization_id = '${ORG}' and conversation_id = '${conversationId}' and status = 'active'`))[0]?.n ?? -1);
if (activeMembers !== 3) fail('blocking changed the group roster', activeMembers);
console.log('ok  the group carries on: 3 active members, the blocker still posts');

console.log(`PASS: group rules (minimum of three, one group per member set, mute silences, block hides only for the blocker) — run ${runId}`);
