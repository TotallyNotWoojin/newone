const LEVELS = new Set(['all', 'mentions', 'none']);

export function normalizeNotificationLevel(value) {
  return LEVELS.has(value) ? value : 'all';
}

export function activeMutedUntil(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > now ? value : null;
}

export function isConversationMuted(level, mutedUntil, now = Date.now()) {
  return normalizeNotificationLevel(level) === 'none'
    || activeMutedUntil(mutedUntil, now) !== null;
}

export function temporaryMutePatch(level, durationSeconds, now = Date.now()) {
  if (
    !Number.isFinite(now)
    || !Number.isInteger(durationSeconds)
    || durationSeconds < 60
    || durationSeconds > 7 * 24 * 60 * 60
  ) return null;
  const normalizedLevel = normalizeNotificationLevel(level);
  return {
    notificationLevel: normalizedLevel === 'none' ? 'all' : normalizedLevel,
    mutedUntil: new Date(now + durationSeconds * 1000).toISOString(),
  };
}
