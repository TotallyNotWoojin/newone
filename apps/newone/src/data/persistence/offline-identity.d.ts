export const offlineIdentityCacheKey: string;
export function offlineIdentityExpiresAt(now?: number): string;
export function serializeOfflineIdentity(userId: unknown, now?: number): string | null;
export function parseOfflineIdentity(serialized: unknown, now?: number): string | null;
export function retainSessionForMembershipFailure(error: unknown): boolean;
