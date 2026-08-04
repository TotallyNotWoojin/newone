import {
  OFFLINE_WORKSPACE_MAX_AGE_MS,
  offlineWorkspaceEntitlement,
} from './offline-workspace-entitlement.mjs';

const CACHE_VERSION = 2;
const MAX_SERIALIZED_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const textEncoder = new TextEncoder();
const parsedSnapshotExpiries = new WeakMap();

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function boundedArray(value, limit) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function languageCode(value, fallback = 'en') {
  return value === 'en' || value === 'ko' || value === 'es' ? value : fallback;
}

export function offlineWorkspaceCacheKey(userId) {
  return typeof userId === 'string' && UUID.test(userId)
    ? `workspace-snapshot.${userId}`
    : null;
}

export function offlineWorkspaceExpiresAt(snapshot, now = Date.now()) {
  return offlineWorkspaceEntitlement(objectValue(snapshot)?.currentUser, now).expiresAt;
}

export function offlineWorkspaceSnapshotExpiresAt(snapshot) {
  return snapshot && typeof snapshot === 'object'
    ? parsedSnapshotExpiries.get(snapshot) ?? null
    : null;
}

/**
 * Persist only a bounded employee or contractor workspace view. Privileged capabilities,
 * authorization scopes, reports, and audit data are deliberately omitted so
 * a stale offline snapshot can never render an administrative control plane.
 */
export function serializeOfflineWorkspace(snapshot, now = Date.now()) {
  const root = objectValue(snapshot);
  const currentUser = objectValue(root?.currentUser);
  const entitlement = offlineWorkspaceEntitlement(currentUser, now);
  if (
    !root
    || !entitlement.eligible
    || entitlement.expiresAt === null
    || typeof root.organizationId !== 'string'
    || !UUID.test(root.organizationId)
    || typeof currentUser?.id !== 'string'
    || !UUID.test(currentUser.id)
  ) return null;

  const conversations = boundedArray(root.conversations, 100)
    .filter((conversation) => {
      const row = objectValue(conversation);
      return row && row.managementOnly !== true && typeof row.id === 'string';
    });
  const conversationIds = new Set(conversations.map((conversation) => conversation.id));
  const sourceMessages = objectValue(root.messages) ?? {};
  const messages = {};
  let remainingMessages = 1_000;
  for (const conversation of conversations) {
    if (remainingMessages <= 0) break;
    const items = boundedArray(sourceMessages[conversation.id], 100)
      .filter((message) => {
        const row = objectValue(message);
        return row && row.conversationId === conversation.id && typeof row.id === 'string';
      });
    const kept = items.slice(Math.max(0, items.length - remainingMessages));
    messages[conversation.id] = kept;
    remainingMessages -= kept.length;
  }

  const sourceCursors = objectValue(root.cursors) ?? {};
  const cursors = Object.fromEntries([...conversationIds].map((conversationId) => {
    const cursor = sourceCursors[conversationId];
    return [conversationId, typeof cursor === 'string' || cursor === null ? cursor : null];
  }));
  const savedAt = new Date(now).toISOString();
  const envelope = {
    version: CACHE_VERSION,
    savedAt,
    expiresAt: entitlement.expiresAt,
    userId: currentUser.id,
    organizationId: root.organizationId,
    snapshot: {
      organizationId: root.organizationId,
      organizationName: typeof root.organizationName === 'string' ? root.organizationName : 'Newone',
      conversationControlsVersion: Number.isSafeInteger(root.conversationControlsVersion)
        ? root.conversationControlsVersion
        : 1,
      currentMembershipRole: 'member',
      organizationPolicy: {
        messageRetentionDays: 365,
        allowMemberDirectMessages: true,
        dmPolicy: 'directory_open',
        requireMfaForAdmins: true,
        shiftScheduleAuthoritative: false,
        groupCreationPolicy: 'members',
        allowExternalGuests: false,
        externalGuestMaxAccessDays: 90,
        version: 1,
      },
      currentUser,
      messageDisplayLanguage: languageCode(
        root.messageDisplayLanguage,
        languageCode(currentUser.preferredLanguage),
      ),
      conversations,
      messages,
      people: boundedArray(root.people, 500),
      units: boundedArray(root.units, 500),
      updates: boundedArray(root.updates, 100),
      handoffs: boundedArray(root.handoffs, 100),
      summaries: boundedArray(root.summaries, 50),
      actions: boundedArray(root.actions, 200),
      moderationReports: [],
      auditEvents: [],
      capabilities: [],
      scopes: [],
      cursors,
      discoverableConversations: [],
    },
  };
  const serialized = JSON.stringify(envelope);
  return textEncoder.encode(serialized).byteLength <= MAX_SERIALIZED_BYTES ? serialized : null;
}

export function parseOfflineWorkspace(serialized, expectedUserId, now = Date.now()) {
  if (
    typeof serialized !== 'string'
    || serialized.length < 2
    || textEncoder.encode(serialized).byteLength > MAX_SERIALIZED_BYTES
    || typeof expectedUserId !== 'string'
    || !UUID.test(expectedUserId)
    || !Number.isFinite(now)
  ) return null;
  try {
    const envelope = objectValue(JSON.parse(serialized));
    const snapshot = objectValue(envelope?.snapshot);
    const currentUser = objectValue(snapshot?.currentUser);
    const savedAt = Date.parse(envelope?.savedAt);
    const expiresAt = Date.parse(envelope?.expiresAt);
    const entitlementAtSave = offlineWorkspaceEntitlement(currentUser, savedAt);
    if (
      envelope?.version !== CACHE_VERSION
      || envelope.userId !== expectedUserId
      || currentUser?.id !== expectedUserId
      || typeof envelope.organizationId !== 'string'
      || !UUID.test(envelope.organizationId)
      || snapshot?.organizationId !== envelope.organizationId
      || !Number.isFinite(savedAt)
      || !Number.isFinite(expiresAt)
      || !entitlementAtSave.eligible
      || entitlementAtSave.expiresAt !== envelope.expiresAt
      || savedAt > now + 5 * 60 * 1000
      || now - savedAt > OFFLINE_WORKSPACE_MAX_AGE_MS
      || now >= expiresAt
      || typeof snapshot.organizationName !== 'string'
      || !Array.isArray(snapshot.conversations)
      || !Array.isArray(snapshot.people)
      || !Array.isArray(snapshot.units)
      || !Array.isArray(snapshot.updates)
      || !Array.isArray(snapshot.handoffs)
      || !Array.isArray(snapshot.summaries)
      || !Array.isArray(snapshot.actions)
      || !['en', 'ko', 'es'].includes(snapshot.messageDisplayLanguage)
      || !objectValue(snapshot.messages)
      || !objectValue(snapshot.cursors)
      || snapshot.conversations.length > 100
      || snapshot.people.length > 500
      || snapshot.units.length > 500
      || snapshot.updates.length > 100
      || snapshot.handoffs.length > 100
      || snapshot.summaries.length > 50
      || snapshot.actions.length > 200
      || snapshot.capabilities?.length !== 0
      || snapshot.scopes?.length !== 0
      || snapshot.moderationReports?.length !== 0
      || snapshot.auditEvents?.length !== 0
    ) return null;

    const conversationIds = new Set();
    for (const conversation of snapshot.conversations) {
      const row = objectValue(conversation);
      if (
        !row
        || row.managementOnly === true
        || typeof row.id !== 'string'
        || conversationIds.has(row.id)
      ) return null;
      conversationIds.add(row.id);
    }
    let messageCount = 0;
    for (const [conversationId, value] of Object.entries(snapshot.messages)) {
      if (!conversationIds.has(conversationId) || !Array.isArray(value) || value.length > 100) return null;
      messageCount += value.length;
      if (messageCount > 1_000) return null;
      if (value.some((message) => {
        const row = objectValue(message);
        return !row || row.conversationId !== conversationId || typeof row.id !== 'string';
      })) return null;
    }
    parsedSnapshotExpiries.set(snapshot, envelope.expiresAt);
    return snapshot;
  } catch {
    return null;
  }
}
