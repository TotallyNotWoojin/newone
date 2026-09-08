// Real-API proof that archiving is not deletion (owner, Sep 8 2026).
//
// Until v3.4 "isArchived" wrote conversation_preferences.is_hidden, the flag
// the bootstrap uses to drop a conversation from the snapshot: an archived
// chat did not move somewhere quieter, it left the device, with no archive to
// open and no way back. Opening that person again then landed on an empty pane.
//
// Proves, against the deployed stack: an archived chat is still in the
// snapshot and says so; a chat deleted for one person is not; and asking to
// open a direct chat again brings a deleted one back.
// Requires migration 20260908140000 and the newone-api function from it.
import { makeRunId } from './lib.mjs';
import {
  PERSONAL_REALM_ID, fail, gatewayPost, gatewayRequest, loadAccessToken, projectKeys, signupUser,
} from './smoke-lib.mjs';

const runId = makeRunId();
const keys = projectKeys(loadAccessToken());
const data = (response) => response.payload?.data ?? response.payload;

const ana = await signupUser(keys, { runId, label: 'ana', language: 'en' });
const eli = await signupUser(keys, { runId, label: 'eli', language: 'en' });

const request = await gatewayPost('newone-api', '/v2/contacts/message-requests', keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `arch-${runId}-req`,
  body: { organizationId: PERSONAL_REALM_ID, targetUserId: eli.userId, body: 'Hello, archiving test.' },
});
if (request.status !== 201) fail(`message request failed (${request.status})`, request.payload);
const conversationId = data(request)?.conversationId;
const accept = await gatewayPost('newone-api', `/v2/contacts/connections/${ana.userId}/respond`, keys, {
  installationId: eli.installationId, accessToken: eli.accessToken, idempotencyKey: `arch-${runId}-acc`,
  body: { organizationId: PERSONAL_REALM_ID, decision: 'accepted' },
});
if (accept.status !== 200) fail(`accept failed (${accept.status})`, accept.payload);

const bootstrap = async (user) => {
  const response = await gatewayPost('newone-read', '/v2/bootstrap', keys, {
    installationId: user.installationId, accessToken: user.accessToken,
    body: { organizationId: PERSONAL_REALM_ID },
  });
  if (response.status !== 200) fail(`bootstrap failed (${response.status})`, response.payload);
  return data(response)?.conversations ?? [];
};
const find = (conversations) => conversations.find((row) => row.conversationId === conversationId
  || row.id === conversationId);
const preferences = (patch, key) => gatewayRequest('newone-api', 'PATCH',
  `/v2/conversations/${conversationId}/preferences`, keys, {
    installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `arch-${runId}-${key}`,
    body: { organizationId: PERSONAL_REALM_ID, ...patch },
  });

if (!find(await bootstrap(ana))) fail('the chat is missing before anything is archived');
console.log('ok  the chat is in the snapshot to begin with');

const archived = await preferences({ isArchived: true }, 'arch');
if (archived.status !== 200) fail(`archive failed (${archived.status})`, archived.payload);
if (data(archived)?.isArchived !== true) fail('the archive response does not say it is archived', archived.payload);
const afterArchive = find(await bootstrap(ana));
if (!afterArchive) fail('an archived chat left the snapshot — this is the defect v3.4 fixes');
if (afterArchive.preferences?.isArchived !== true) fail('the snapshot does not mark it archived', afterArchive.preferences);
console.log('ok  archived: still there, and it says so, so the list can gather it behind one row');

const unarchived = await preferences({ isArchived: false }, 'unarch');
if (unarchived.status !== 200) fail(`unarchive failed (${unarchived.status})`, unarchived.payload);
if (find(await bootstrap(ana))?.preferences?.isArchived !== false) fail('unarchiving did not take');
console.log('ok  unarchived from the same flag');

const hidden = await preferences({ isHidden: true }, 'hide');
if (hidden.status !== 200) fail(`delete-for-me failed (${hidden.status})`, hidden.payload);
if (find(await bootstrap(ana))) fail('a chat deleted for one person is still in their snapshot');
console.log('ok  deleted for me: gone from my list, and only mine');
if (!find(await bootstrap(eli))) fail("one person's deletion took the chat from the other person too");

const reopen = await gatewayPost('newone-api', '/v2/conversations/direct', keys, {
  installationId: ana.installationId, accessToken: ana.accessToken, idempotencyKey: `arch-${runId}-reopen`,
  body: { organizationId: PERSONAL_REALM_ID, targetMembershipId: eli.userId },
});
if (reopen.status !== 200 && reopen.status !== 201) fail(`reopen failed (${reopen.status})`, reopen.payload);
const reopened = find(await bootstrap(ana));
if (!reopened) fail('reopening the chat did not bring it back — the empty-pane trap is still there');
console.log('ok  opening that person again brings the chat back, so the pane always has something to show');

console.log(`PASS archive-smoke: archiving keeps a chat and marks it, deleting hides only mine, reopening restores it (conversation ${conversationId})`);
