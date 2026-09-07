import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
const repository = readFileSync('apps/newone/src/data/repositories/web-read-repository.ts', 'utf8');
const contracts = readFileSync('apps/newone/src/data/repositories/contracts.ts', 'utf8');
const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');
const statusBanner = readFileSync('apps/newone/src/components/workspace/workspace-state.tsx', 'utf8');

function section(start, end) {
  const startIndex = workspace.indexOf(start);
  const endIndex = workspace.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `missing section ${start}`);
  return workspace.slice(startIndex, endIndex);
}

test('bootstrap lifecycle fields are normalized into strict current-user state', () => {
  assert.match(contracts, /currentUser: CurrentWorkspaceUser/);
  assert.match(repository, /parseOfflineWorkspaceMembership\(currentRow\)/);
  assert.match(repository, /const currentUser: CurrentWorkspaceUser/);
  assert.match(repository, /\.\.\.currentMembership/);
});

test('guest and expired outboxes purge before hydration or synchronization', () => {
  const hydrate = section('const hydrateOutbox', 'const refreshIdentity');
  assert.ok(
    hydrate.indexOf('offlineWorkspaceEntitlement(nextSnapshot.currentUser)')
      < hydrate.indexOf('clientStore.listOutbox'),
  );
  assert.match(hydrate, /clientStore\.purgeUser\(nextSnapshot\.currentUser\.id\)/);

  const synchronize = section('const synchronizeMessageOutbox', 'const editOutboxMessage');
  assert.ok(
    synchronize.indexOf('offlineWorkspaceEntitlement(current.currentUser)')
      < synchronize.indexOf('clientStore.listOutbox'),
  );
  assert.match(synchronize, /clientStore\.purgeUser\(current\.currentUser\.id\)/);
});

test('guest sends and reply previews are online-only and never reach durable enqueue', () => {
  const send = section('const sendMessage = useCallback', 'const synchronizeMessageOutbox');
  const guestBranch = send.indexOf("snapshot.currentUser.membershipType === 'guest'");
  const durableEnqueue = send.indexOf('clientStore.enqueue(command)');
  assert.ok(guestBranch >= 0 && durableEnqueue > guestBranch);
  assert.ok(send.indexOf('return;', guestBranch) < durableEnqueue);
  // The preview also carries the quoted message's id, so tapping the quote can
  // go to it even before the send has come back from the server.
  assert.match(send, /replyPreview: \{\s*messageId: replyTo\.serverId,/);
  assert.match(send, /senderName: replyTo\.senderName,\s*preview: replyTo\.originalText/);
  assert.match(send, /errors\.guestOnlineRequired/);

  const receipts = section('const enqueueMessageReceipt', 'const observeConversation');
  assert.ok(
    receipts.indexOf("currentUser?.membershipType === 'guest'")
      < receipts.indexOf('clientStore.enqueue(command)'),
  );

  const acknowledgement = section('const acknowledgeUpdate', 'const createHandoff');
  assert.ok(
    acknowledgement.indexOf("snapshot.currentUser.membershipType === 'guest'")
      < acknowledgement.indexOf('clientStore.enqueue({'),
  );
});

test('guest cursor persistence is disabled and expiry purges the full user store', () => {
  assert.match(workspace, /next\.currentUser\.membershipType === 'guest'\) break/);
  assert.match(workspace, /latest\.currentUser\.membershipType !== 'guest'/);
  assert.match(workspace, /workspaceAccessDeadline/);
  assert.match(workspace, /clientStore\.purgeUser\(current\.currentUser\.id\)/);
});

test('guest offline and retry guidance is localized in every catalog', () => {
  assert.equal([...catalog.matchAll(/'errors\.guestOnlineRequired':/g)].length, 3);
  assert.equal([...catalog.matchAll(/'status\.guestOffline':/g)].length, 3);
  assert.match(statusBanner, /workspace\.offlineQueueAvailable/);
  assert.match(statusBanner, /status\.guestOffline/);
});
