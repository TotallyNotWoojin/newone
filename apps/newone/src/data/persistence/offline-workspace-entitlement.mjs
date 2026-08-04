export const OFFLINE_WORKSPACE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function denied(reason) {
  return Object.freeze({
    eligible: false,
    expiresAt: null,
    reason,
  });
}

function eligible(expiresAt) {
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) return denied('invalid_membership');
  return Object.freeze({
    eligible: true,
    expiresAt: expiry.toISOString(),
    reason: 'eligible',
  });
}

/** Parse the bootstrap-v8 current-membership tuple without coercion. */
export function parseOfflineWorkspaceMembership(value) {
  if (!value || typeof value !== 'object') return null;
  const { membershipType, accessExpiresAt, guestSponsorUserId } = value;
  const normalizedAccessExpiry = accessExpiresAt ?? null;
  const normalizedGuestSponsor = guestSponsorUserId ?? null;

  if (
    membershipType === 'employee'
    && normalizedAccessExpiry === null
    && normalizedGuestSponsor === null
  ) return Object.freeze({
    membershipType,
    accessExpiresAt: null,
    guestSponsorUserId: null,
  });

  if (
    membershipType === 'contractor'
    && typeof normalizedAccessExpiry === 'string'
    && Number.isFinite(Date.parse(normalizedAccessExpiry))
    && normalizedGuestSponsor === null
  ) return Object.freeze({
    membershipType,
    accessExpiresAt: normalizedAccessExpiry,
    guestSponsorUserId: null,
  });

  if (
    membershipType === 'guest'
    && typeof accessExpiresAt === 'string'
    && Number.isFinite(Date.parse(accessExpiresAt))
    && typeof guestSponsorUserId === 'string'
    && UUID.test(guestSponsorUserId)
  ) return Object.freeze({ membershipType, accessExpiresAt, guestSponsorUserId });

  return null;
}

/**
 * Decide whether a canonical current-membership projection may back an offline
 * workspace snapshot. This is deliberately stricter than online access:
 * external guests never receive an offline workspace, and every malformed or
 * expired entitlement fails closed.
 */
export function offlineWorkspaceEntitlement(membership, now = Date.now()) {
  const parsed = parseOfflineWorkspaceMembership(membership);
  if (!Number.isFinite(now) || !parsed) {
    return denied('invalid_membership');
  }

  const { membershipType, accessExpiresAt } = parsed;
  const maximumExpiry = now + OFFLINE_WORKSPACE_MAX_AGE_MS;
  if (!Number.isFinite(maximumExpiry)) return denied('invalid_membership');

  if (membershipType === 'employee') {
    return eligible(maximumExpiry);
  }

  if (membershipType === 'contractor') {
    const accessExpiry = Date.parse(accessExpiresAt);
    if (accessExpiry <= now) return denied('membership_expired');
    return eligible(Math.min(maximumExpiry, accessExpiry));
  }

  if (membershipType === 'guest') {
    return denied('guest_offline_cache_disabled');
  }

  return denied('invalid_membership');
}
