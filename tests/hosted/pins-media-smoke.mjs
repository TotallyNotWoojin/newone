// Real-API proof for backlog 41 and 42: a chat's pins can be read back, the
// same read gathers pins across every chat, unpinning removes a row, and a
// chat's photos-and-files page answers with the shape the grid parses and
// never with a storage path.
//
// Two real signups, a chat, three messages, then: pin two of them, read the
// chat's pins (newest first), read every chat's pins, unpin one and read
// again. The media page is asserted on the empty case plus the deployed
// function's own shape, because uploading a real attachment needs a storage
// grant, an upload and a scan pass that this smoke has no business running.
//
// Requires the 20260908050000 migration and the newone-read function from the
// same change to be deployed.
import { randomUUID } from 'node:crypto';
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID,
  fail,
  gatewayPost,
  loadAccessToken,
  managementSql,
  projectKeys,
  signupUser,
} from './smoke-lib.mjs';

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1 to run the pins and media smoke');

const runId = makeRunId();
const accessToken = loadAccessToken();
const keys = projectKeys(accessToken);
const data = (response) => response.payload?.data ?? response.payload;
const rows = async (query) => {
  const result = await managementSql(accessToken, query);
  return Array.isArray(result) ? result : result?.result ?? [];
};

const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });
const post = (user, path, label, body) => gatewayPost('newone-api', path, keys, {
  installationId: user.installationId,
  accessToken: user.accessToken,
  idempotencyKey: `pins-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});
const read = (user, path, body) => gatewayPost('newone-read', path, keys, {
  installationId: user.installationId,
  accessToken: user.accessToken,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});

const request = await post(ana, '/v2/contacts/message-requests', 'req', {
  targetUserId: eli.userId,
  body: `Hi Eli, testing pins ${runId}`,
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = data(request)?.conversationId;
const accept = await post(eli, `/v2/contacts/connections/${ana.userId}/respond`, 'acc', {
  decision: 'accepted',
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);

const send = async (user, label, body) => {
  const response = await post(user, `/v2/conversations/${conversationId}/messages`, label, {
    clientMessageId: randomUUID(),
    kind: 'text',
    body,
  });
  if (response.status !== 201) fail(`send ${label} failed (${response.status})`, response.payload);
  const sent = data(response);
  const messageId = String(sent?.messageId ?? sent?.id ?? '');
  if (!messageId) fail(`send ${label} returned no message id`, sent);
  return messageId;
};
const setPin = async (user, messageId, label, pinned) => {
  const response = await post(user, `/v2/messages/${messageId}/pin`, label, {
    conversationId,
    pinned,
  });
  if (response.status !== 200) {
    fail(`${pinned ? 'pin' : 'unpin'} ${label} failed (${response.status})`, response.payload);
  }
};

const first = await send(ana, 'm1', `Ferry at six ${runId}`);
const second = await send(eli, 'm2', `Bring the tickets ${runId}`);
await send(ana, 'm3', `Nothing pinned about this one ${runId}`);

// 1. Pinning both, newest pin first when they are read back.
await setPin(ana, first, 'p1', true);
await setPin(ana, second, 'p2', true);
const chatPins = await read(ana, '/v2/pins/query', { conversationId });
if (chatPins.status !== 200) fail(`reading the chat's pins failed (${chatPins.status})`, chatPins.payload);
const pins = data(chatPins)?.pins ?? [];
if (pins.length !== 2) fail(`expected two pins, read ${pins.length}`, pins);
if (String(pins[0]?.messageId) !== second) fail('the newest pin is not first', pins);
if (!pins[0]?.senderDisplayName) fail('a pinned row carries no sender name', pins[0]);
if (!String(pins[0]?.body ?? '').includes(runId)) fail('a pinned row carries no text', pins[0]);
if (pins.some((pin) => pin.canUnpin !== true)) fail('the pinner cannot unpin their own pin', pins);
console.log('a chat’s pins → 2 rows, newest first, with sender, text and unpin');

// 2. The same read with no chat named gathers them across every chat.
const everyChat = await read(ana, '/v2/pins/query', {});
if (everyChat.status !== 200) fail(`reading every chat's pins failed (${everyChat.status})`, everyChat.payload);
const allPins = data(everyChat)?.pins ?? [];
if (!allPins.some((pin) => String(pin.messageId) === first)
  || !allPins.some((pin) => String(pin.messageId) === second)) {
  fail('the cross-chat read is missing this chat’s pins', allPins);
}
if (allPins.some((pin) => pin.conversationId !== conversationId && !pin.conversationId)) {
  fail('a cross-chat pin has no chat to open', allPins);
}
console.log('every chat’s pins → both rows present, each naming its chat');

// 3. Unpinning takes the row away.
await setPin(ana, first, 'u1', false);
const afterUnpin = await read(ana, '/v2/pins/query', { conversationId });
const remaining = data(afterUnpin)?.pins ?? [];
if (remaining.length !== 1 || String(remaining[0]?.messageId) !== second) {
  fail('unpinning did not remove exactly the unpinned row', remaining);
}
console.log('unpin → one row left, and it is the other one');

// 4. Someone outside the chat reads nothing.
const stranger = await signupUser(keys, { runId, label: 'sam', language: 'en' });
const strangerPins = await read(stranger, '/v2/pins/query', { conversationId });
if (strangerPins.status !== 200) fail(`a stranger's pin read errored (${strangerPins.status})`, strangerPins.payload);
if ((data(strangerPins)?.pins ?? []).length !== 0) {
  fail('a stranger can read another chat’s pins', data(strangerPins));
}
console.log('a stranger → no pins at all');

// 5. The media page answers with the shape the grid parses.
const media = await read(ana, `/v2/conversations/${conversationId}/media/query`, {});
if (media.status !== 200) fail(`reading the chat's media failed (${media.status})`, media.payload);
const page = data(media);
if (page?.schemaVersion !== 1 || page?.conversationId !== conversationId) {
  fail('the media page does not identify itself', page);
}
if (!Array.isArray(page?.items) || page.items.length !== 0 || page.hasMore !== false) {
  fail('a chat with no files answered with something other than an empty page', page);
}
const halfCursor = await read(ana, `/v2/conversations/${conversationId}/media/query`, {
  beforeCreatedAt: new Date().toISOString(),
});
if (halfCursor.status !== 400) {
  fail(`half a media keyset returned ${halfCursor.status}, expected 400`, halfCursor.payload);
}
console.log('media page → empty and well formed, and half a keyset is refused');

// 6. The deployed read hands the gateway a bucket and a path; the gateway must
// be the only thing that ever sees them.
const definition = (await rows(`select pg_get_functiondef(p.oid) as def from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'bff_read_conversation_media_impl'`))[0]?.def ?? '';
if (!definition) fail('private.bff_read_conversation_media_impl is not deployed');
for (const expected of ["'bucket_id', file.bucket_id", "'storage_path', file.storage_path"]) {
  if (!definition.includes(expected)) fail(`the deployed media read is missing: ${expected}`);
}
if (JSON.stringify(page).includes('storagePath') || JSON.stringify(page).includes('bucketId')) {
  fail('the gateway leaked a storage location to the device', page);
}
console.log('storage locations → in the database read, never in the answer');

console.log(`PASS pins-media-smoke: pins read back per chat and across chats, unpin removes one, strangers read none, and the media page is bounded and path-free (conversation ${conversationId})`);
