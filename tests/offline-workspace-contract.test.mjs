import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  offlineWorkspaceCacheKey,
  offlineWorkspaceExpiresAt,
  offlineWorkspaceSnapshotExpiresAt,
  parseOfflineWorkspace,
  serializeOfflineWorkspace,
} from '../apps/newone/src/data/persistence/offline-workspace.mjs';

const userId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';
const conversationId = '00000000-0000-4000-8000-000000000003';
const now = Date.parse('2026-08-04T12:00:00.000Z');

function snapshot() {
  return {
    organizationId,
    organizationName: 'Acme',
    currentUser: {
      id: userId,
      preferredLanguage: 'ko',
      membershipType: 'employee',
      accessExpiresAt: null,
      guestSponsorUserId: null,
    },
    messageDisplayLanguage: 'es',
    conversations: [{ id: conversationId }],
    messages: { [conversationId]: [{ id: '1', conversationId }] },
    people: [], updates: [], handoffs: [], summaries: [], actions: [],
    moderationReports: [{ id: 'must-not-cache' }],
    auditEvents: [{ id: 'must-not-cache' }],
    capabilities: ['members.security'],
    scopes: [{ id: 'must-not-cache' }],
    cursors: { [conversationId]: 'cursor' },
  };
}

test('offline workspace cache is bounded, identity-bound, and strips privileged state', () => {
  const serialized = serializeOfflineWorkspace(snapshot(), now);
  assert.equal(typeof serialized, 'string');
  const restored = parseOfflineWorkspace(serialized, userId, now + 1_000);
  assert.equal(restored?.organizationId, organizationId);
  assert.equal(restored?.messageDisplayLanguage, 'es');
  assert.deepEqual(restored?.capabilities, []);
  assert.deepEqual(restored?.scopes, []);
  assert.deepEqual(restored?.moderationReports, []);
  assert.deepEqual(restored?.auditEvents, []);
  assert.equal(offlineWorkspaceCacheKey(userId), `workspace-snapshot.${userId}`);
  assert.equal(offlineWorkspaceCacheKey('not-a-user-id'), null);
});

test('guest snapshots and expired contractor snapshots are never serialized', () => {
  const guest = snapshot();
  guest.currentUser = {
    ...guest.currentUser,
    membershipType: 'guest',
    accessExpiresAt: new Date(now + 60_000).toISOString(),
    guestSponsorUserId: '00000000-0000-4000-8000-000000000099',
  };
  assert.equal(serializeOfflineWorkspace(guest, now), null);

  const expiredContractor = snapshot();
  expiredContractor.currentUser = {
    ...expiredContractor.currentUser,
    membershipType: 'contractor',
    accessExpiresAt: new Date(now).toISOString(),
    guestSponsorUserId: null,
  };
  assert.equal(serializeOfflineWorkspace(expiredContractor, now), null);
});

test('contractor envelope and hydration cannot outlive access expiry', () => {
  const accessExpiresAt = new Date(now + 90 * 60 * 1_000).toISOString();
  const contractor = snapshot();
  contractor.currentUser = {
    ...contractor.currentUser,
    membershipType: 'contractor',
    accessExpiresAt,
    guestSponsorUserId: null,
  };
  const serialized = serializeOfflineWorkspace(contractor, now);
  assert.ok(serialized);
  assert.equal(JSON.parse(serialized).expiresAt, accessExpiresAt);
  assert.equal(offlineWorkspaceExpiresAt(contractor, now), accessExpiresAt);

  const restored = parseOfflineWorkspace(serialized, userId, now + 1_000);
  assert.ok(restored);
  assert.equal(offlineWorkspaceSnapshotExpiresAt(restored), accessExpiresAt);
  assert.equal(parseOfflineWorkspace(serialized, userId, Date.parse(accessExpiresAt)), null);

  const tampered = JSON.parse(serialized);
  tampered.expiresAt = new Date(now + 24 * 60 * 60 * 1_000).toISOString();
  assert.equal(parseOfflineWorkspace(JSON.stringify(tampered), userId, now), null);
  const legacy = JSON.parse(serialized);
  legacy.version = 1;
  assert.equal(parseOfflineWorkspace(JSON.stringify(legacy), userId, now), null);
});

test('offline workspace rejects another user, stale data, and tampered structure', () => {
  const serialized = serializeOfflineWorkspace(snapshot(), now);
  assert.ok(serialized);
  assert.equal(parseOfflineWorkspace(serialized, '00000000-0000-4000-8000-000000000099', now), null);
  assert.equal(parseOfflineWorkspace(serialized, userId, Number.NaN), null);
  assert.equal(parseOfflineWorkspace(serialized, userId, now + 25 * 60 * 60 * 1_000), null);
  const tampered = JSON.parse(serialized);
  tampered.snapshot.capabilities = ['members.security'];
  assert.equal(parseOfflineWorkspace(JSON.stringify(tampered), userId, now), null);
});

test('management-only conversation shells and their state remain online-only', () => {
  const managementConversationId = '00000000-0000-4000-8000-000000000004';
  const withManagementShell = snapshot();
  withManagementShell.conversations.push({
    id: managementConversationId,
    managementOnly: true,
    canManageConversation: true,
    memberIds: ['00000000-0000-4000-8000-000000000005'],
  });
  withManagementShell.messages[managementConversationId] = [{
    id: 'must-not-cache',
    conversationId: managementConversationId,
  }];
  withManagementShell.cursors[managementConversationId] = 'must-not-cache';

  const serialized = serializeOfflineWorkspace(withManagementShell, now);
  assert.ok(serialized);
  const envelope = JSON.parse(serialized);
  assert.deepEqual(envelope.snapshot.conversations.map((item) => item.id), [conversationId]);
  assert.equal(envelope.snapshot.messages[managementConversationId], undefined);
  assert.equal(envelope.snapshot.cursors[managementConversationId], undefined);

  envelope.snapshot.conversations.push({ id: managementConversationId, managementOnly: true });
  assert.equal(parseOfflineWorkspace(JSON.stringify(envelope), userId, now), null);
});

test('native and web stores encrypt sensitive cache records and bind purge to the user', () => {
  const nativeStore = readFileSync('apps/newone/src/data/persistence/client-store.native.ts', 'utf8');
  const webStore = readFileSync('apps/newone/src/data/persistence/client-store.web.ts', 'utf8');
  const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
  assert.match(nativeStore, /CREATE TABLE IF NOT EXISTS secure_cache_entries/);
  assert.match(nativeStore, /aesEncryptAsync/);
  assert.match(nativeStore, /recordType: 'secure_cache'/);
  assert.match(nativeStore, /DELETE FROM secure_cache_entries WHERE owner_hash/);
  assert.match(nativeStore, /purgeAllEncryptedData/);
  assert.match(webStore, /extractable === false/);
  assert.match(webStore, /kind: 'cache'/);
  assert.match(webStore, /index\('ownerHash'\)\.getAll\(ownerHash\)/);
  assert.match(workspace, /connectivity !== 'online'/);
  assert.match(workspace, /parseOfflineWorkspace\(serialized, userId\)/);
  assert.match(workspace, /loadError instanceof RepositoryError\s*&& loadError\.retryable/);
  assert.match(workspace, /setConnectivity\('offline'\)/);
});
