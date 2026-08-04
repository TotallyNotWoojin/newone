const VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const offlineIdentityCacheKey = 'offline-session.last-user';

export function offlineIdentityExpiresAt(now = Date.now()) {
  return new Date(now + MAX_AGE_MS).toISOString();
}

export function serializeOfflineIdentity(userId, now = Date.now()) {
  if (typeof userId !== 'string' || !UUID.test(userId)) return null;
  return JSON.stringify({ version: VERSION, userId, savedAt: new Date(now).toISOString() });
}

export function parseOfflineIdentity(serialized, now = Date.now()) {
  if (typeof serialized !== 'string' || serialized.length > 512) return null;
  try {
    const value = JSON.parse(serialized);
    const savedAt = Date.parse(value?.savedAt);
    if (
      value?.version !== VERSION
      || typeof value.userId !== 'string'
      || !UUID.test(value.userId)
      || !Number.isFinite(savedAt)
      || savedAt > now + 5 * 60 * 1000
      || now - savedAt > MAX_AGE_MS
    ) return null;
    return value.userId;
  } catch {
    return null;
  }
}

export function retainSessionForMembershipFailure(error) {
  const code = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code.toLocaleLowerCase()
    : '';
  return code === 'network_unavailable'
    || code === 'dependency_unavailable'
    || code === 'http_408'
    || code === 'http_429'
    || /^http_5\d\d$/.test(code);
}
