#!/usr/bin/env node
// Real hosted consumer journey simulation. Three synthetic users (English,
// Spanish, Korean) exercise the full consumer surface against the LIVE
// linked project: signup + bootstrap, username discovery + message requests,
// chat depth (reply, reaction, edit, read receipt), real attachment bytes
// through grant -> storage upload -> completion -> hosted scan -> download
// grant, group creation + member add + cross-language translation fan-out,
// private Realtime typing broadcast, profile + conversation preference
// updates, block/unblock fail-closed, unified message search, and push
// device registration. Every step asserts the API response shape AND, where
// a durable effect exists, the database truth through the Management API.
// No mocks. Secrets never reach the artifact.
//
// Usage: NEWONE_HOSTED_E2E=1 node tests/hosted/journey-smoke.mjs
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED_PROJECT_REF, isUuid, makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  PROJECT_URL,
  fail,
  gatewayPost,
  gatewayRequest,
  loadAccessToken,
  managementSql,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') {
  fail('Set NEWONE_HOSTED_E2E=1 to run the hosted journey smoke');
}

const HOSTED_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = join(HOSTED_DIRECTORY, '..', '..');
const ORG = PERSONAL_REALM_ID;
const POLL_INTERVAL_MS = 5000;
const MESSAGE_ID_PATTERN = /^[1-9][0-9]{0,18}$/;

const runId = makeRunId();
const runEntropy = runId.slice(-8);
const startedAt = new Date().toISOString();
const runStartedMs = Date.now();
const steps = [];
const timings = [];
const gaps = [];
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const idem = (label) => `smoke-${runId}-${label}`;
const data = (response) => response.payload?.data ?? response.payload ?? {};
const firstRow = (rows) => (Array.isArray(rows) ? rows[0] : rows?.result?.[0]) ?? {};
const allRows = (rows) => (Array.isArray(rows) ? rows : rows?.result ?? []);
const sql = (query) => managementSql(accessToken, query);

function expect(condition, message, extra) {
  if (!condition) fail(message, extra);
}

function expectStatus(response, status, label) {
  if (response.status !== status) {
    fail(`${label} returned ${response.status} (expected ${status})`, response.payload);
  }
  return data(response);
}

let stepStartedMs = Date.now();
function done(name, detail) {
  const elapsedMs = Date.now() - stepStartedMs;
  stepStartedMs = Date.now();
  steps.push(name);
  timings.push({ step: name, elapsedMs });
  console.log(`ok  ${name} (${elapsedMs}ms)${detail ? ` - ${detail}` : ''}`);
}

function recordGap(step, detail) {
  gaps.push({ step, detail });
  console.log(`GAP ${step}: ${detail}`);
}

// Hosted behavior worth carrying in the artifact that is neither a missing
// feature nor an assertion failure (for example an infrastructure cold start
// the run tolerated within a bounded retry).
const observations = [];
function observe(step, detail) {
  observations.push({ step, detail, at: new Date().toISOString() });
  console.log(`OBS ${step}: ${detail}`);
}

// Command gateway call. Every mutating route requires an Idempotency-Key, so
// each call site names a unique label; read-style command routes opt out.
async function api(actor, method, path, label, body, options = {}) {
  return await gatewayRequest('newone-api', method, path, keys, {
    installationId: actor.installationId,
    accessToken: actor.accessToken,
    idempotencyKey: options.noIdempotency ? undefined : idem(label),
    body: { organizationId: ORG, ...body },
  });
}

async function read(actor, path, body) {
  return await gatewayPost('newone-read', path, keys, {
    installationId: actor.installationId,
    accessToken: actor.accessToken,
    body: { organizationId: ORG, ...body },
  });
}

async function sendText(actor, conversationId, label, text, extra = {}) {
  return await api(actor, 'POST', `/v2/conversations/${conversationId}/messages`, label, {
    clientMessageId: randomUUID(),
    kind: 'text',
    body: text,
    ...extra,
  });
}

function assertSendReceipt(response, label) {
  const receipt = expectStatus(response, 201, label);
  expect(MESSAGE_ID_PATTERN.test(String(receipt.messageId)), `${label}: messageId missing`, receipt);
  expect(isUuid(receipt.clientMessageId), `${label}: clientMessageId missing`, receipt);
  expect(receipt.originalCommitted === true, `${label}: originalCommitted must be true`, receipt);
  expect(Array.isArray(receipt.translationTargets), `${label}: translationTargets missing`, receipt);
  return { ...receipt, messageId: String(receipt.messageId) };
}

async function searchUsers(actor, query) {
  const response = await read(actor, '/v2/users/search', { query, limit: 10 });
  const users = expectStatus(response, 200, 'user search').users;
  expect(Array.isArray(users), 'user search returned no users array', response.payload);
  return users;
}

// 'hidden' means the target is not surfaced at all (block-aware search).
async function connectionState(viewer, target) {
  const card = (await searchUsers(viewer, target.username))
    .find((user) => user.userId === target.userId);
  return card ? card.connectionState : 'hidden';
}

async function bootstrap(actor, label) {
  const response = await read(actor, '/v2/bootstrap', { conversationLimit: 50, timelineLimit: 20 });
  const snapshot = expectStatus(response, 200, `bootstrap for ${label}`);
  expect(snapshot.schemaVersion === 1, `bootstrap schemaVersion for ${label}`, snapshot.schemaVersion);
  expect(
    snapshot.organization?.organizationId === ORG,
    `bootstrap organization for ${label} is not the personal realm`,
    snapshot.organization,
  );
  expect(snapshot.currentUser?.userId === actor.userId, `bootstrap currentUser for ${label}`, snapshot.currentUser);
  expect(Array.isArray(snapshot.conversations), `bootstrap conversations for ${label}`, Object.keys(snapshot));
  return snapshot;
}

function loadSupabaseSdk() {
  try {
    return createRequire(join(REPOSITORY_ROOT, 'apps/newone/package.json'))('@supabase/supabase-js');
  } catch {
    return fail('Install apps/newone dependencies (@supabase/supabase-js) before running the journey smoke');
  }
}

// 1x1 transparent PNG: real magic bytes, real IHDR/IDAT/IEND chunks.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// Minimal ISO BMFF audio container: an `ftyp` box with the M4A major brand
// (what a real iPhone voice note starts with) followed by a `free` box. The
// hosted signature gate classifies the `M4A ` brand as audio/mp4.
function minimalM4a() {
  const box = (type, payload) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + payload.length);
    return Buffer.concat([size, Buffer.from(type, 'latin1'), payload]);
  };
  const ftyp = box('ftyp', Buffer.concat([
    Buffer.from('M4A ', 'latin1'),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from('M4A mp42isommp41', 'latin1'),
  ]));
  return Buffer.concat([ftyp, box('free', Buffer.alloc(16))]);
}

// Full real attachment pipeline for one file: attachment message -> upload
// grant -> raw bytes to the signed storage target -> completion (server-side
// size + sha256 verification) -> hosted scan worker -> state route ->
// recipient download grant -> bytes fetched back and compared.
async function sendAttachment({ sender, recipient, conversationId, label, fileName, mimeType, bytes }) {
  const sha256Hex = createHash('sha256').update(bytes).digest('hex');
  const message = assertSendReceipt(
    await api(sender, 'POST', `/v2/conversations/${conversationId}/messages`, `${label}-message`, {
      clientMessageId: randomUUID(),
      kind: 'attachment',
      body: null,
    }),
    `${label} attachment message`,
  );

  const grantResponse = await api(sender, 'POST', '/v2/attachments/grants', `${label}-grant`, {
    action: 'upload',
    conversationId,
    messageId: message.messageId,
    fileName,
    mimeType,
    byteSize: bytes.length,
    sha256Hex,
  });
  const grant = expectStatus(grantResponse, 201, `${label} upload grant`).grant ?? {};
  expect(
    grant.action === 'upload' && isUuid(grant.attachmentId) && grant.bucket === 'message-attachments',
    `${label} upload grant shape`,
    grant,
  );
  const pathParts = String(grant.path).split('/');
  expect(
    pathParts.length === 5 && pathParts[0] === ORG && pathParts[1] === conversationId &&
      pathParts[2] === sender.userId && pathParts[3] === grant.attachmentId && pathParts[4] === 'upload',
    `${label} grant storage path shape`,
    grant.path,
  );
  expect(
    typeof grant.signedUrl === 'string' && typeof grant.token === 'string' && grant.expiresInSeconds === 7200,
    `${label} grant signed upload target missing`,
    Object.keys(grant),
  );

  // Upload exactly as the grant dictates: PUT raw bytes to the signed URL
  // (token in the query string), declared content type, no upsert.
  const uploadUrl = grant.signedUrl.startsWith('http')
    ? grant.signedUrl
    : `${PROJECT_URL}/storage/v1${grant.signedUrl}`;
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': mimeType, 'x-upsert': 'false' },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  const uploadBody = await upload.text().catch(() => '');
  expect(upload.ok, `${label} storage upload failed (${upload.status})`, uploadBody.slice(0, 400));

  const completion = expectStatus(
    await api(sender, 'POST', `/v2/attachments/${grant.attachmentId}/complete`, `${label}-complete`, {
      bucket: grant.bucket,
      path: grant.path,
      byteSize: bytes.length,
      sha256Hex,
    }),
    202,
    `${label} completion`,
  );

  // The hosted scan worker (signature-only, every 10s) must flip the row
  // from pending to clean; anything else fails closed.
  let scan = null;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    scan = firstRow(await sql(`
      select scan_status, detected_mime_type, scanner_name, scan_policy_code,
        scan_failure_code, sha256_hex, byte_size, message_id, mime_type
      from public.message_attachments
      where organization_id = '${ORG}' and id = '${grant.attachmentId}'
    `));
    if (scan.scan_status && scan.scan_status !== 'pending') break;
  }
  expect(scan?.scan_status === 'clean', `${label} attachment did not scan clean`, scan);
  expect(
    scan.sha256_hex === sha256Hex && Number(scan.byte_size) === bytes.length &&
      String(scan.message_id) === message.messageId && scan.mime_type === mimeType,
    `${label} attachment row does not match the uploaded bytes`,
    scan,
  );

  const state = expectStatus(
    await api(sender, 'POST', `/v2/attachments/${grant.attachmentId}/state`, `${label}-state`, {}, {
      noIdempotency: true,
    }),
    200,
    `${label} attachment state`,
  );
  expect(
    state.found === true && state.attachment?.scanStatus === 'clean' &&
      state.attachment?.attachmentId === grant.attachmentId,
    `${label} attachment state shape`,
    state,
  );

  const downloadGrant = expectStatus(
    await api(recipient, 'POST', '/v2/attachments/grants', `${label}-download`, {
      action: 'download',
      conversationId,
      attachmentId: grant.attachmentId,
    }),
    200,
    `${label} download grant (recipient)`,
  ).grant ?? {};
  expect(
    downloadGrant.action === 'download' && downloadGrant.attachmentId === grant.attachmentId &&
      typeof downloadGrant.signedUrl === 'string' && downloadGrant.expiresInSeconds === 120,
    `${label} download grant shape`,
    downloadGrant,
  );
  const downloadUrl = downloadGrant.signedUrl.startsWith('http')
    ? downloadGrant.signedUrl
    : `${PROJECT_URL}/storage/v1${downloadGrant.signedUrl}`;
  const download = await fetch(downloadUrl, { signal: AbortSignal.timeout(30_000) });
  expect(download.ok, `${label} signed download failed (${download.status})`);
  const fetched = Buffer.from(await download.arrayBuffer());
  expect(
    fetched.length === bytes.length && createHash('sha256').update(fetched).digest('hex') === sha256Hex,
    `${label} downloaded bytes differ from the uploaded bytes`,
    { uploaded: bytes.length, fetched: fetched.length },
  );

  return {
    messageId: message.messageId,
    attachmentId: grant.attachmentId,
    fileName,
    mimeType,
    byteSize: bytes.length,
    scanner: scan.scanner_name,
    detectedMimeType: scan.detected_mime_type,
    completion: completion.scanStatus ?? completion.scan_status ?? null,
  };
}

// ---------------------------------------------------------------------------
// 1. Signup x3 and bootstrap
// ---------------------------------------------------------------------------
console.log(`run ${runId} against ${EXPECTED_PROJECT_REF}`);
const alice = await signupUser(keys, { runId, label: 'alice', language: 'en' });
const bruno = await signupUser(keys, { runId, label: 'bruno', language: 'es' });
const chae = await signupUser(keys, { runId, label: 'chae', language: 'ko' });
const users = { alice, bruno, chae };
const languages = { alice: 'en', bruno: 'es', chae: 'ko' };
done('three_signups_completed', `${alice.username}, ${bruno.username}, ${chae.username}`);

for (const [label, user] of Object.entries(users)) {
  const snapshot = await bootstrap(user, label);
  expect(
    snapshot.currentUser?.displayName === `Smoke ${label}`,
    `bootstrap displayName for ${label}`,
    snapshot.currentUser?.displayName,
  );
}
const profileRows = allRows(await sql(`
  select profile.user_id, profile.username::text as username, profile.display_name,
    profile.preferred_language, membership.status as membership_status,
    membership.directory_visibility
  from public.profiles profile
  join public.organization_memberships membership
    on membership.user_id = profile.user_id and membership.organization_id = '${ORG}'
  where profile.user_id in ('${alice.userId}', '${bruno.userId}', '${chae.userId}')
`));
for (const [label, user] of Object.entries(users)) {
  const row = profileRows.find((entry) => entry.user_id === user.userId);
  expect(row?.username === user.username, `profile username for ${label}`, row);
  expect(row?.display_name === `Smoke ${label}`, `profile display name for ${label}`, row);
  expect(row?.preferred_language === languages[label], `preferred language for ${label}`, row);
  expect(row?.membership_status === 'active', `realm membership for ${label}`, row);
  expect(row?.directory_visibility === 'private', `consumer membership must be directory-private (${label})`, row);
}
done('bootstrap_and_profiles_verified');

// ---------------------------------------------------------------------------
// 2. Friends: A finds B, message request, pending both sides, accept
// ---------------------------------------------------------------------------
const strangerCard = (await searchUsers(alice, bruno.username.slice(0, 12)))
  .find((user) => user.userId === bruno.userId);
expect(strangerCard, 'search did not surface bruno');
expect(strangerCard.connectionState === 'none', 'stranger state mismatch', strangerCard);
expect(strangerCard.username === bruno.username, 'search username mismatch', strangerCard);
expect(strangerCard.displayName === 'Smoke bruno', 'search display name mismatch', strangerCard);

const searchToken = `zephyr${runEntropy}`;
const requestAB = expectStatus(
  await api(alice, 'POST', '/v2/contacts/message-requests', 'request-ab', {
    targetUserId: bruno.userId,
    body: `Hello Bruno, first hello from the journey smoke ${searchToken}`,
  }),
  201,
  'message request A->B',
);
expect(
  requestAB.connectionStatus === 'pending' && isUuid(requestAB.conversationId) &&
    MESSAGE_ID_PATTERN.test(String(requestAB.messageId)),
  'message request response shape',
  requestAB,
);
const abConversationId = requestAB.conversationId;
const firstMessageId = String(requestAB.messageId);

expect(await connectionState(alice, bruno) === 'pending_outgoing', 'requester state mismatch');
expect(await connectionState(bruno, alice) === 'pending_incoming', 'recipient state mismatch');

const acceptAB = expectStatus(
  await api(bruno, 'POST', `/v2/contacts/connections/${alice.userId}/respond`, 'accept-ab', {
    decision: 'accepted',
  }),
  200,
  'accept A->B',
);
expect(acceptAB.status === 'accepted' && typeof acceptAB.respondedAt === 'string', 'accept response shape', acceptAB);
expect(await connectionState(alice, bruno) === 'accepted', 'A does not see accepted');
expect(await connectionState(bruno, alice) === 'accepted', 'B does not see accepted');

const connectionRow = firstRow(await sql(`
  select status, requested_by_user_id, responded_at is not null as responded
  from public.contact_connections
  where organization_id = '${ORG}'
    and member_low_user_id = least('${alice.userId}'::uuid, '${bruno.userId}'::uuid)
    and member_high_user_id = greatest('${alice.userId}'::uuid, '${bruno.userId}'::uuid)
`));
expect(
  connectionRow.status === 'accepted' && connectionRow.requested_by_user_id === alice.userId &&
    connectionRow.responded === true,
  'contact_connections row mismatch',
  connectionRow,
);
done('friends_connected_a_b', abConversationId);

// ---------------------------------------------------------------------------
// 3. Chat depth: plain text both ways, reply, reaction, edit, read receipt
// ---------------------------------------------------------------------------
const brunoText = assertSendReceipt(
  await sendText(bruno, abConversationId, 'b-text', 'Perfecto, acepto tu solicitud. Hola desde el smoke.'),
  'bruno plain text',
);
const aliceReply = assertSendReceipt(
  await sendText(alice, abConversationId, 'a-reply', 'Replying inline to your Spanish hello, depth check.', {
    replyToMessageId: brunoText.messageId,
  }),
  'alice reply',
);
expectStatus(
  await api(bruno, 'POST', `/v2/messages/${aliceReply.messageId}/reactions`, 'b-react', {
    conversationId: abConversationId,
    emoji: '👍',
    active: true,
  }),
  200,
  'reaction',
);
const editedBody = 'Replying inline to your Spanish hello, depth check (edited).';
expectStatus(
  await api(alice, 'PATCH', `/v2/messages/${aliceReply.messageId}`, 'a-edit', {
    conversationId: abConversationId,
    body: editedBody,
  }),
  200,
  'edit',
);
expectStatus(
  await api(bruno, 'POST', `/v2/messages/${aliceReply.messageId}/receipt`, 'b-read', {
    conversationId: abConversationId,
    state: 'read',
  }),
  200,
  'read receipt',
);
const depth = firstRow(await sql(`
  select
    (select count(*) from public.messages
      where organization_id = '${ORG}' and conversation_id = '${abConversationId}'
        and kind <> 'system') as message_count,
    (select reply_to_message_id from public.messages where id = ${aliceReply.messageId}) as reply_to,
    (select body from public.messages where id = ${aliceReply.messageId}) as reply_body,
    (select edited_at is not null from public.messages where id = ${aliceReply.messageId}) as edited,
    (select count(*) from public.message_reactions
      where message_id = ${aliceReply.messageId} and user_id = '${bruno.userId}'
        and emoji = '👍') as reaction_count,
    (select read_at is not null and delivered_at is not null from public.message_receipts
      where message_id = ${aliceReply.messageId} and user_id = '${bruno.userId}') as read_receipt
`));
expect(Number(depth.message_count) === 3, 'expected exactly 3 non-system messages in A-B', depth);
expect(String(depth.reply_to) === brunoText.messageId, 'reply_to_message_id mismatch', depth);
expect(depth.reply_body === editedBody, 'edited body not persisted', depth);
expect(depth.edited === true, 'edited_at not set', depth);
expect(Number(depth.reaction_count) === 1, 'reaction row missing', depth);
expect(depth.read_receipt === true, 'read receipt row missing', depth);
done('chat_depth_verified', `reply=${aliceReply.messageId} -> ${brunoText.messageId}`);

// ---------------------------------------------------------------------------
// 4. Attachments A -> B: real PNG bytes, then a real M4A container
// ---------------------------------------------------------------------------
const pngAttachment = await sendAttachment({
  sender: alice,
  recipient: bruno,
  conversationId: abConversationId,
  label: 'png',
  fileName: `journey-${runEntropy}.png`,
  mimeType: 'image/png',
  bytes: PNG_BYTES,
});
done('image_attachment_round_trip', `${pngAttachment.attachmentId} via ${pngAttachment.scanner}`);

const audioAttachment = await sendAttachment({
  sender: alice,
  recipient: bruno,
  conversationId: abConversationId,
  label: 'm4a',
  fileName: `voice-${runEntropy}.m4a`,
  mimeType: 'audio/mp4',
  bytes: minimalM4a(),
});
done('audio_attachment_round_trip', `${audioAttachment.attachmentId} detected ${audioAttachment.detectedMimeType}`);

// ---------------------------------------------------------------------------
// 5. Group: A connects with C, creates a group with B, adds C, everyone posts
// ---------------------------------------------------------------------------
const requestAC = expectStatus(
  await api(alice, 'POST', '/v2/contacts/message-requests', 'request-ac', {
    targetUserId: chae.userId,
    body: 'Hello Chae, welcome hello from the journey smoke.',
  }),
  201,
  'message request A->C',
);
const acConversationId = requestAC.conversationId;
expect(isUuid(acConversationId), 'A->C conversation missing', requestAC);
expectStatus(
  await api(chae, 'POST', `/v2/contacts/connections/${alice.userId}/respond`, 'accept-ac', {
    decision: 'accepted',
  }),
  200,
  'accept A->C',
);
expect(await connectionState(alice, chae) === 'accepted', 'A does not see C accepted');
done('friends_connected_a_c', acConversationId);

const groupName = `Journey ${runEntropy} lounge`;
const group = expectStatus(
  await api(alice, 'POST', '/v2/conversations/group', 'group-create', {
    name: groupName,
    kind: 'group',
    memberAssignments: [{ membershipId: bruno.userId, role: 'member' }],
  }),
  201,
  'group creation',
);
expect(
  isUuid(group.conversationId) && group.kind === 'group' && group.name === groupName &&
    group.memberCount === 2 && group.isReadOnly === false && group.postingMode === 'all_members',
  'group creation receipt shape',
  group,
);
const groupConversationId = group.conversationId;
expectStatus(
  await api(alice, 'POST', `/v2/conversations/${groupConversationId}/members`, 'group-add-c', {
    membershipId: chae.userId,
    role: 'member',
  }),
  201,
  'group member add (C)',
);

const groupA = assertSendReceipt(
  await sendText(alice, groupConversationId, 'g-a', 'Group kickoff in English, welcome both of you.'),
  'group message A',
);
const groupB = assertSendReceipt(
  await sendText(bruno, groupConversationId, 'g-b', 'Hola grupo, saludos en español desde el smoke.'),
  'group message B',
);
const groupC = assertSendReceipt(
  await sendText(chae, groupConversationId, 'g-c', '안녕하세요, 다음 주 월요일에 프로젝트 회의가 있습니다.'),
  'group message C',
);
expect(groupC.translationTargets.length >= 1, 'Korean group message has no translation targets', groupC);

const membershipRows = allRows(await sql(`
  select user_id, role, status from public.conversation_members
  where organization_id = '${ORG}' and conversation_id = '${groupConversationId}'
`));
const memberRole = (user) => membershipRows.find((row) => row.user_id === user.userId);
expect(membershipRows.length === 3, 'expected 3 group members', membershipRows);
expect(memberRole(alice)?.role === 'owner' && memberRole(alice)?.status === 'active', 'A must own the group', membershipRows);
expect(memberRole(bruno)?.role === 'member' && memberRole(bruno)?.status === 'active', 'B membership', membershipRows);
expect(memberRole(chae)?.role === 'member' && memberRole(chae)?.status === 'active', 'C membership', membershipRows);
const groupMessages = firstRow(await sql(`
  select count(*) as message_count,
    count(distinct sender_user_id) as sender_count
  from public.messages
  where organization_id = '${ORG}' and conversation_id = '${groupConversationId}' and kind <> 'system'
`));
expect(
  Number(groupMessages.message_count) === 3 && Number(groupMessages.sender_count) === 3,
  'expected one group message per member',
  groupMessages,
);
done('group_created_and_populated', groupConversationId);

// C's Korean message must fan out completed translations for A (en) and B (es).
let translationEvidence = null;
for (let attempt = 0; attempt < 18; attempt += 1) {
  await sleep(POLL_INTERVAL_MS);
  translationEvidence = firstRow(await sql(`
    select
      (select count(*) from public.message_translations
        where message_id = ${groupC.messageId} and status = 'completed'
          and char_length(coalesce(translated_body, '')) > 0) as completed,
      (select count(*) from public.message_translations
        where message_id = ${groupC.messageId} and status in ('failed', 'blocked')) as failed,
      (select language_detection_state from public.messages where id = ${groupC.messageId}) as detection,
      (select detected_language from public.messages where id = ${groupC.messageId}) as detected
  `));
  if (Number(translationEvidence.completed) >= 2 || Number(translationEvidence.failed) > 0) break;
}
expect(Number(translationEvidence?.failed) === 0, 'Korean group translations failed or were blocked', translationEvidence);
expect(Number(translationEvidence?.completed) >= 2, 'Korean group translations did not complete within 90s', translationEvidence);
const translatedTexts = allRows(await sql(`
  select target_language, left(translated_body, 120) as translated
  from public.message_translations
  where message_id = ${groupC.messageId} and status = 'completed'
  order by target_language
`));
const translatedLanguages = new Set(translatedTexts.map((row) => row.target_language));
expect(translatedLanguages.has('en') && translatedLanguages.has('es'), 'expected en + es translations', translatedTexts);
done('korean_group_message_translated', `detected=${translationEvidence.detected} -> ${[...translatedLanguages].join(',')}`);

// ---------------------------------------------------------------------------
// 6. Realtime: private typing topic, B broadcasts, A receives
// ---------------------------------------------------------------------------
const { createClient } = loadSupabaseSdk();
const sdkOptions = {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  global: { headers: { apikey: keys.publishableKey } },
};
const realtimeA = createClient(PROJECT_URL, keys.publishableKey, sdkOptions);
const realtimeB = createClient(PROJECT_URL, keys.publishableKey, sdkOptions);
const typingTopic = `org:${ORG}:conversation:${abConversationId}:typing`;

// One private-channel join attempt. Resolves with the channel on SUBSCRIBED
// and with the failure detail otherwise; the channel is removed on failure
// outside the status callback (removing inside it recurses in realtime-js).
async function subscribePrivate(client, topic, onTyping, ack) {
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { self: false, ack } },
  });
  if (onTyping) channel.on('broadcast', { event: 'typing' }, onTyping);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'TIMED_OUT', detail: 'client-side 20s timeout' }), 20_000);
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') {
        clearTimeout(timer);
        resolve({ status });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timer);
        resolve({ status, detail: error?.message ?? 'no detail' });
      }
    });
  });
  if (outcome.status === 'SUBSCRIBED') return { channel };
  await client.removeChannel(channel).catch(() => null);
  return { failure: `${outcome.status}: ${outcome.detail}` };
}

// Supabase Realtime maps any check_violation on realtime.messages during its
// policy probe to "MissingPartition". A tenant idle for days has no partition
// for today until the Realtime janitor wakes with the first connection, so
// the very first private join can race that creation. That is hosted
// infrastructure behavior, not a product gap: tolerate it within a short
// bounded retry, record it, and fail on anything else.
const COLD_START_PATTERN = /MissingPartition|messages partition/i;
async function subscribePrivateWithColdStartRetry(client, topic, onTyping, ack, label) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = await subscribePrivate(client, topic, onTyping, ack);
    if (result.channel) return result.channel;
    if (!COLD_START_PATTERN.test(result.failure) || attempt === 4) {
      return fail(`private typing channel subscription failed for ${label}`, result.failure);
    }
    observe('realtime_cold_start', `${label} join attempt ${attempt}: ${result.failure}; retrying in ${POLL_INTERVAL_MS}ms`);
    await sleep(POLL_INTERVAL_MS);
  }
  return fail(`private typing channel subscription exhausted retries for ${label}`);
}

let typingResolve;
const typingReceived = new Promise((resolve) => {
  typingResolve = resolve;
});
await realtimeA.realtime.setAuth(alice.accessToken);
await realtimeB.realtime.setAuth(bruno.accessToken);
const channelA = await subscribePrivateWithColdStartRetry(
  realtimeA, typingTopic, (message) => typingResolve(message), false, 'alice',
);
const channelB = await subscribePrivateWithColdStartRetry(realtimeB, typingTopic, null, true, 'bruno');
const typingPayload = { userId: bruno.userId, displayName: 'Smoke bruno' };
const receiveDeadline = Date.now() + 10_000;
const sendResults = [];
let typingEvent = null;
while (!typingEvent && Date.now() < receiveDeadline) {
  sendResults.push(await channelB.send({ type: 'broadcast', event: 'typing', payload: typingPayload }));
  typingEvent = await Promise.race([typingReceived, sleep(2500).then(() => null)]);
}
expect(typingEvent, 'A did not receive B typing broadcast within 10s', sendResults);
const outer = typingEvent.payload && typeof typingEvent.payload === 'object' ? typingEvent.payload : typingEvent;
const peer = outer.payload && typeof outer.payload === 'object' ? outer.payload : outer;
expect(
  typingEvent.event === 'typing' && peer.userId === bruno.userId && peer.displayName === 'Smoke bruno',
  'typing payload mismatch',
  typingEvent,
);
await realtimeA.removeChannel(channelA);
await realtimeB.removeChannel(channelB);
realtimeA.realtime.disconnect();
realtimeB.realtime.disconnect();
done('realtime_typing_broadcast_received', `sends=${sendResults.join(',')}`);

// ---------------------------------------------------------------------------
// 7. Profile + preferences
// ---------------------------------------------------------------------------
// Display name and status message change through the gateway command
// PATCH /v2/profile, which calls the service-only RPC bff_update_profile
// under the actor-authorization prelude. The username is gateway-owned and
// must survive the rename untouched; bounds fail closed before any write.
const newDisplayName = `Smoke alice ${runEntropy}`;
const newStatusMessage = `On shift ${runEntropy}`;
const profileRow = () => sql(`
  select display_name, status_message, username::text as username
  from public.profiles where user_id = '${alice.userId}'
`);
const profilePatch = await api(alice, 'PATCH', '/v2/profile', 'profile-update', {
  displayName: `  ${newDisplayName}  `,
  statusMessage: newStatusMessage,
});
const profileReceipt = expectStatus(profilePatch, 200, 'profile update');
expect(
  profileReceipt.userId === alice.userId
    && profileReceipt.displayName === newDisplayName
    && profileReceipt.statusMessage === newStatusMessage,
  'profile update receipt mismatch',
  profileReceipt,
);
const renamedRow = firstRow(await profileRow());
expect(
  renamedRow.display_name === newDisplayName
    && renamedRow.status_message === newStatusMessage
    && renamedRow.username === alice.username,
  'profile rename not persisted or username drifted',
  renamedRow,
);
const rebootstrap = await bootstrap(alice, 'alice (after rename)');
expect(
  rebootstrap.currentUser?.displayName === newDisplayName
    && rebootstrap.currentUser?.statusMessage === newStatusMessage,
  'bootstrap does not reflect the new display name and status',
  rebootstrap.currentUser,
);
const oversizedPatch = await api(alice, 'PATCH', '/v2/profile', 'profile-update-oversized', {
  displayName: 'x'.repeat(121),
});
expect(
  oversizedPatch.status === 400,
  `oversized display name was not rejected (${oversizedPatch.status})`,
  oversizedPatch.payload,
);
const usernamePatch = await api(alice, 'PATCH', '/v2/profile', 'profile-update-username', {
  displayName: newDisplayName,
  username: `stolen_${runEntropy}`,
});
expect(
  usernamePatch.status === 400,
  `username smuggled through the profile route (${usernamePatch.status})`,
  usernamePatch.payload,
);
const afterRejected = firstRow(await profileRow());
expect(
  afterRejected.display_name === newDisplayName && afterRejected.username === alice.username,
  'rejected profile requests must not change the profile',
  afterRejected,
);
done('profile_display_name_updated', newDisplayName);

const translationModeRow = () => sql(`
  select translation_mode from public.conversation_preferences
  where organization_id = '${ORG}' and conversation_id = '${abConversationId}' and user_id = '${alice.userId}'
`);
const preferenceOff = expectStatus(
  await api(alice, 'PATCH', `/v2/conversations/${abConversationId}/preferences`, 'pref-off', {
    translationMode: 'off',
  }),
  200,
  'translation mode off',
);
expect(
  preferenceOff.translationMode === 'off' && preferenceOff.conversationId === abConversationId &&
    preferenceOff.isArchived === false,
  'preference (off) response shape',
  preferenceOff,
);
expect(firstRow(await translationModeRow()).translation_mode === 'off', 'translation_mode off not persisted');
const preferenceOn = expectStatus(
  await api(alice, 'PATCH', `/v2/conversations/${abConversationId}/preferences`, 'pref-on', {
    translationMode: 'automatic',
  }),
  200,
  'translation mode automatic',
);
expect(preferenceOn.translationMode === 'automatic', 'preference (automatic) response shape', preferenceOn);
expect(firstRow(await translationModeRow()).translation_mode === 'automatic', 'translation_mode automatic not persisted');
done('conversation_preference_toggled');

// ---------------------------------------------------------------------------
// 8. Block: C blocks A, A's send fails closed, unblock restores
// ---------------------------------------------------------------------------
const aliceToChaeCount = async () => Number(firstRow(await sql(`
  select count(*) as sent from public.messages
  where organization_id = '${ORG}' and conversation_id = '${acConversationId}'
    and sender_user_id = '${alice.userId}' and kind <> 'system'
`)).sent);
const blockCount = async () => Number(firstRow(await sql(`
  select count(*) as blocks from public.member_blocks
  where organization_id = '${ORG}' and blocker_user_id = '${chae.userId}' and blocked_user_id = '${alice.userId}'
`)).blocks);

assertSendReceipt(
  await sendText(alice, acConversationId, 'ac-open', 'Before the block: this should land.'),
  'A->C pre-block send',
);
expect(await aliceToChaeCount() === 2, 'A->C should hold 2 messages before the block');

const block = expectStatus(await api(chae, 'PUT', `/v2/people/${alice.userId}/block`, 'c-block-a', {}), 200, 'block');
expect(block.blocked === true && block.targetUserId === alice.userId, 'block response shape', block);
expect(await blockCount() === 1, 'member_blocks row missing after block');
expect(await connectionState(alice, chae) === 'hidden', 'blocked user must not surface in A search');

const denied = await sendText(alice, acConversationId, 'ac-blocked', 'During the block: this must be refused.');
expect(denied.status === 403, `blocked send must fail closed with 403, got ${denied.status}`, denied.payload);
expect(denied.payload?.error?.code === 'forbidden', 'blocked send error code', denied.payload);
expect(await aliceToChaeCount() === 2, 'blocked message must not land in the database');

const unblock = expectStatus(await api(chae, 'DELETE', `/v2/people/${alice.userId}/block`, 'c-unblock-a', {}), 200, 'unblock');
expect(unblock.blocked === false && unblock.targetUserId === alice.userId, 'unblock response shape', unblock);
expect(await blockCount() === 0, 'member_blocks row still present after unblock');
assertSendReceipt(
  await sendText(alice, acConversationId, 'ac-reopen', 'After the unblock: this should land again.'),
  'A->C post-unblock send',
);
expect(await aliceToChaeCount() === 3, 'A->C should hold 3 messages after the unblock');
expect(await connectionState(alice, chae) === 'accepted', 'connection must survive block/unblock');
done('block_fails_closed_then_unblock_restores');

// ---------------------------------------------------------------------------
// 9. Message search for the distinctive first-hello token
// ---------------------------------------------------------------------------
const search = expectStatus(
  await read(alice, '/v2/search', { query: searchToken, types: ['messages'], limit: 20 }),
  200,
  'message search',
);
expect(Array.isArray(search.results) && typeof search.hasMore === 'boolean', 'search response shape', search);
const hit = search.results.find((result) => result.type === 'messages' && String(result.id) === firstMessageId);
expect(hit, 'search did not return the distinctive first message', search.results);
expect(
  hit.conversationId === abConversationId && ['original', 'translation'].includes(hit.matchedSource) &&
    typeof hit.snippet === 'string',
  'search hit shape',
  hit,
);
done('message_search_hit', `${hit.matchedSource} in ${hit.conversationId}`);

// ---------------------------------------------------------------------------
// 10. Push device registration (registration row only; no delivery assert)
// ---------------------------------------------------------------------------
const pushToken = `ExponentPushToken[journey${runEntropy}${'x'.repeat(12)}]`;
const pushProjectId = randomUUID();
const device = expectStatus(
  await api(alice, 'POST', '/v2/devices', 'device', {
    installationId: alice.installationId,
    platform: 'ios',
    pushToken,
    pushTokenType: 'expo',
    pushProjectId,
    pushEnvironment: 'development',
    appVersion: '0.0.0-journey-smoke',
    locale: 'en',
  }),
  200,
  'device registration',
);
expect(
  device.registered === true && isUuid(device.deviceId) && device.installationId === alice.installationId &&
    device.platform === 'ios' && device.pushProjectId === pushProjectId,
  'device registration response shape',
  device,
);
const deviceRow = firstRow(await sql(`
  select platform, push_token_type, push_project_id, push_environment, locale, app_version,
    revoked_at, session_id is not null as has_session,
    push_token_ciphertext ~ '^(kms|vault|ciphertext):' as ciphertext_shape,
    position('${pushToken}' in push_token_ciphertext) = 0 as token_not_plaintext
  from public.device_registrations
  where organization_id = '${ORG}' and user_id = '${alice.userId}' and installation_id = '${alice.installationId}'
`));
expect(
  deviceRow.platform === 'ios' && deviceRow.push_token_type === 'expo' &&
    deviceRow.push_project_id === pushProjectId && deviceRow.push_environment === 'development' &&
    deviceRow.locale === 'en' && deviceRow.revoked_at === null && deviceRow.has_session === true &&
    deviceRow.ciphertext_shape === true && deviceRow.token_not_plaintext === true,
  'device_registrations row mismatch',
  deviceRow,
);
done('device_registered', device.deviceId);

// ---------------------------------------------------------------------------
// 11. Artifact
// ---------------------------------------------------------------------------
const finishedAt = new Date().toISOString();
const artifact = {
  runId,
  kind: 'consumer-journey-smoke',
  projectRef: EXPECTED_PROJECT_REF,
  startedAt,
  finishedAt,
  totalElapsedMs: Date.now() - runStartedMs,
  identities: {
    alice: { email: alice.email, username: alice.username, userId: alice.userId, language: 'en' },
    bruno: { email: bruno.email, username: bruno.username, userId: bruno.userId, language: 'es' },
    chae: { email: chae.email, username: chae.username, userId: chae.userId, language: 'ko' },
  },
  conversations: {
    directAB: abConversationId,
    directAC: acConversationId,
    group: groupConversationId,
  },
  messages: {
    firstHello: firstMessageId,
    brunoText: brunoText.messageId,
    aliceReply: aliceReply.messageId,
    groupA: groupA.messageId,
    groupB: groupB.messageId,
    groupC: groupC.messageId,
  },
  attachments: { png: pngAttachment, m4a: audioAttachment },
  translations: translatedTexts,
  realtime: { topic: typingTopic, sendResults },
  device: { deviceId: device.deviceId, installationId: alice.installationId },
  searchToken,
  steps,
  timings,
  gaps,
  observations,
  cleanup: 'retained synthetic identities; sweep with the harness cleanup procedure',
};
const artifactDirectory = join(HOSTED_DIRECTORY, '.artifacts');
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = join(artifactDirectory, `${runId}-journey-smoke.json`);
writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

console.log(`PASS: hosted consumer journey smoke (${steps.length} steps, ${Math.round(artifact.totalElapsedMs / 1000)}s)`);
console.log(`identities: ${alice.username} (en), ${bruno.username} (es), ${chae.username} (ko)`);
for (const row of translatedTexts) console.log(`  [${row.target_language}] ${row.translated}`);
if (gaps.length > 0) {
  console.log('gaps:');
  for (const entry of gaps) console.log(`  ${entry.step}: ${entry.detail}`);
} else {
  console.log('gaps: none');
}
if (observations.length > 0) {
  console.log('observations:');
  for (const entry of observations) console.log(`  ${entry.step}: ${entry.detail}`);
}
console.log(`artifact: ${artifactPath}`);
process.exit(0);
