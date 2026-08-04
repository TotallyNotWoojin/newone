export type OrganizationAiUseCase = 'language_detection' | 'translation' | 'summary';

export interface OrganizationAiPolicy {
  organizationId: string;
  enabled: boolean;
  policyVersion: number;
  approvedUseCases: OrganizationAiUseCase[];
  providerAllowlist: string[];
  routePolicy: 'deny' | 'approved_zero_retention';
  tenantApproved: boolean;
  globalKillSwitchStillRequired: true;
}

export interface OrganizationAiPolicyUpdate {
  enabled: boolean;
  approvedUseCases: OrganizationAiUseCase[];
  providerAllowlist: string[];
  routePolicy: 'deny' | 'approved_zero_retention';
  expectedVersion: number;
  reason: string;
}

export function parseOrganizationAiPolicy(
  value: unknown,
  expectedOrganizationId?: string,
): OrganizationAiPolicy;
export function parseOrganizationAiPolicyUpdateReceipt(
  value: unknown,
  expectedOrganizationId: string,
  expectedUpdate: OrganizationAiPolicyUpdate,
): OrganizationAiPolicy;
export function normalizeOrganizationAiPolicyUpdate(value: unknown): OrganizationAiPolicyUpdate;
