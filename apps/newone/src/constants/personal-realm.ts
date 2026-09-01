/**
 * The reserved, platform-managed organization that hosts every consumer
 * account. Created by migration; never listed as a joinable workspace.
 */
export const PERSONAL_REALM_ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

/** True when the given organization is the consumer personal realm. */
export function isPersonalRealm(organizationId: string | null | undefined): boolean {
  return organizationId === PERSONAL_REALM_ORGANIZATION_ID;
}
