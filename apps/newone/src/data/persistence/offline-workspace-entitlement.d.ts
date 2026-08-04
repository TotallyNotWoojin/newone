export type OfflineWorkspaceMembershipType = 'employee' | 'contractor' | 'guest';

export interface OfflineWorkspaceMembership {
  membershipType: OfflineWorkspaceMembershipType;
  accessExpiresAt: string | null;
  guestSponsorUserId: string | null;
}

export interface OfflineWorkspaceEntitlement {
  eligible: boolean;
  expiresAt: string | null;
  reason:
    | 'eligible'
    | 'invalid_membership'
    | 'membership_expired'
    | 'guest_offline_cache_disabled';
}

export const OFFLINE_WORKSPACE_MAX_AGE_MS: number;

export function parseOfflineWorkspaceMembership(
  value: unknown,
): Readonly<OfflineWorkspaceMembership> | null;

export function offlineWorkspaceEntitlement(
  membership: unknown,
  now?: number,
): OfflineWorkspaceEntitlement;
