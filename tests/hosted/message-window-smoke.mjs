// Real-API proof for backlog 45 and 47(e): editing and unsending a message
// both work inside their fifteen minutes, and the database refuses them
// afterwards with a code the app has copy for.
//
// Two real signups, a chat, then: edit a fresh message (the body changes and
// edited_at is stamped), unsend a second fresh message (deleted_at is stamped
// and the body is cleared), and confirm somebody else's message can be neither
// edited nor unsent at all.
//
// The closed window is asserted against the deployed guard rather than by
// waiting fifteen minutes or moving a message's clock: created_at is immutable
// by design (private.validate_message_update refuses to change it for anyone),
// and turning triggers off on a live project is not something a smoke should
// do. So the smoke reads the live function definition and checks that both
// guards are present and worded exactly as apps/newone/src/i18n/errors.ts maps
// them — supabase/functions/tests/message_edit_window_test.ts covers the
// gateway's half of that mapping.
//
// Requires the 20260908020000 migration and the newone-api function from the
// same change to be deployed.
import { randomUUID } from 'node:crypto';
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

if (process.env.NEWONE_HOSTED_E2E !== '1') fail('Set NEWONE_HOSTED_E2E=1 to run the message window smoke');

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
  idempotencyKey: `window-${runId}-${label}`,
  body: { organizationId: PERSONAL_REALM_ID, ...body },
});
const patchMessage = (user, messageId, label, body) => gatewayRequest(
  'newone-api',
  'PATCH',
  `/v2/messages/${messageId}`,
  keys,
  {
    installationId: user.installationId,
    accessToken: user.accessToken,
    idempotencyKey: `window-${runId}-${label}`,
    body: { organizationId: PERSONAL_REALM_ID, ...body },
  },
);

const request = await post(ana, '/v2/contacts/message-requests', 'req', {
  targetUserId: eli.userId,
  body: 'Hi Eli, testing edits.',
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
const messageRow = async (messageId) => (await rows(`select body, edited_at, deleted_at, deletion_reason
  from public.messages where organization_id = '${PERSONAL_REALM_ID}' and id = ${messageId}`))[0];

// 1. Editing inside the window.
const first = await send(ana, 'm1', `First thoughts ${runId}`);
const edit = await patchMessage(ana, first, 'edit', { body: `Second thoughts ${runId}` });
if (edit.status !== 200) fail(`editing inside the window was refused (${edit.status})`, edit.payload);
const edited = await messageRow(first);
if (edited?.body !== `Second thoughts ${runId}`) fail('the edit did not reach the message', edited);
if (!edited?.edited_at) fail('the edited marker was not stamped', edited);
console.log('edit inside the window → 200, edited_at', edited.edited_at);

// 2. Unsending inside the window.
const second = await send(ana, 'm2', `Sent by mistake ${runId}`);
const unsend = await patchMessage(ana, second, 'unsend', { delete: true });
if (unsend.status !== 200) fail(`unsending inside the window was refused (${unsend.status})`, unsend.payload);
const unsent = await messageRow(second);
if (!unsent?.deleted_at) fail('the unsend did not take', unsent);
if (unsent?.body !== null) fail('an unsent message kept its body', unsent);
console.log('unsend inside the window → 200, deleted_at', unsent.deleted_at, 'reason', unsent.deletion_reason);

// 3. Somebody else's message is neither editable nor unsendable, ever.
const theirs = await send(eli, 'm3', `Eli's own message ${runId}`);
const foreignEdit = await patchMessage(ana, theirs, 'foreign-edit', { body: 'not yours' });
if (foreignEdit.status !== 403) {
  fail(`editing somebody else's message returned ${foreignEdit.status}, expected 403`, foreignEdit.payload);
}
const foreignUnsend = await patchMessage(ana, theirs, 'foreign-unsend', { delete: true });
if (foreignUnsend.status !== 403) {
  fail(`unsending somebody else's message returned ${foreignUnsend.status}, expected 403`, foreignUnsend.payload);
}
const stillThere = await messageRow(theirs);
if (stillThere?.deleted_at || stillThere?.body !== `Eli's own message ${runId}`) {
  fail('somebody else’s message was changed', stillThere);
}
console.log('another member’s message → 403 for both, and untouched');

// 4. The closed window: the deployed guard, worded as the app maps it.
const guard = (await rows(`select pg_get_functiondef(p.oid) as def from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'private' and p.proname = 'validate_message_update'`))[0]?.def ?? '';
if (!guard) fail('private.validate_message_update is not deployed');
for (const expected of [
  "raise exception 'message_edit_window_closed' using errcode = '42501'",
  "raise exception 'message_unsend_window_closed' using errcode = '42501'",
  "old.created_at < now() - interval '15 minutes'",
]) {
  if (!guard.includes(expected)) {
    fail(`the deployed guard is missing: ${expected}`, guard.slice(0, 400));
  }
}
const windows = (guard.match(/old\.created_at < now\(\) - interval '15 minutes'/g) ?? []).length;
if (windows < 2) fail(`the fifteen-minute window is applied ${windows} time(s); edit and unsend both need it`);
console.log('closed window → both guards deployed, both on the same fifteen minutes');

console.log(`PASS message-window-smoke: edit and unsend work inside the window, are refused for others, and the deployed guard names both cases (conversation ${conversationId})`);
