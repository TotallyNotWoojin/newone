export interface OrganizationPolicy {
  messageRetentionDays: number;
  allowMemberDirectMessages: boolean;
  dmPolicy: 'directory_open' | 'request_first' | 'scoped_unit';
  requireMfaForAdmins: boolean;
  shiftScheduleAuthoritative: boolean;
  groupCreationPolicy: 'members' | 'managers' | 'admins';
  allowExternalGuests: boolean;
  externalGuestMaxAccessDays: number;
  version: number;
}

export interface OrganizationPolicyUpdate extends OrganizationPolicy {
  reason: string;
}

export function parseOrganizationPolicy(value: unknown): OrganizationPolicy;
export function normalizeOrganizationPolicyUpdate(value: unknown): OrganizationPolicyUpdate;
