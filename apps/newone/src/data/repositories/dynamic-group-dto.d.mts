export type DynamicGroupMembershipRole = 'owner' | 'admin' | 'manager' | 'member';
export type DynamicGroupShiftMode = 'none' | 'current' | 'scheduled';

export interface DynamicGroupPolicySpec {
  siteIds: string[];
  departmentIds: string[];
  teamIds: string[];
  lineIds: string[];
  unitIds: string[];
  includeDescendants: boolean;
  operationalRoles: string[];
  membershipRoles: DynamicGroupMembershipRole[];
  shiftMode: DynamicGroupShiftMode;
  scheduledShiftStartsAt: string | null;
  scheduledShiftEndsAt: string | null;
}

export interface DynamicGroupPolicy {
  policyId: string;
  conversationId: string;
  conversationName: string;
  conversationKind: 'group' | 'team' | 'shift';
  conversationUnitId: string | null;
  status: 'draft' | 'active' | 'paused';
  version: number;
  draftState: 'draft' | 'previewed' | 'published';
  policySpec: DynamicGroupPolicySpec;
  maximumMembers: number;
  selectorFingerprint: string;
  publishedVersionId: string | null;
  lastPreviewFingerprint: string | null;
  lastPreviewedAt: string | null;
  lastSyncedAt: string | null;
  nextEvaluationAt: string | null;
  sourceChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DynamicGroupPolicyList {
  policies: DynamicGroupPolicy[];
  limit: number;
  nextAfterPolicyId: string | null;
}

export interface DynamicGroupSaveReceipt {
  policyId: string;
  conversationId: string;
  version: number;
  draftState: 'draft';
  selectorFingerprint: string;
  requiresPreview: true;
  publishedVersionId: string | null;
}

export interface DynamicGroupPreviewReceipt {
  policyId: string;
  policyVersion: number;
  previewFingerprint: string;
  selectorFingerprint: string;
  membershipStateFingerprint: string;
  evaluatedAt: string;
  validUntil: string;
  eligibleCount: number;
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  addedSampleUserIds: string[];
  removedSampleUserIds: string[];
  unchangedSampleUserIds: string[];
  nextBoundaryAt: string | null;
}

export interface DynamicGroupPublishReceipt {
  policyId: string;
  policyVersion: number;
  publishedVersionId: string;
  status: 'active';
  draftState: 'published';
  eligibleCount: number;
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  selectorFingerprint: string;
  nextEvaluationAt: string | null;
}

export interface DynamicGroupPauseReceipt {
  policyId: string;
  policyVersion: number;
  status: 'paused';
  pausedAt: string;
}

export function parseDynamicGroupPolicySpec(value: unknown): DynamicGroupPolicySpec;
export function parseDynamicGroupPolicyList(value: unknown): DynamicGroupPolicyList;
export function parseDynamicGroupSaveReceipt(value: unknown): DynamicGroupSaveReceipt;
export function parseDynamicGroupPreviewReceipt(value: unknown): DynamicGroupPreviewReceipt;
export function parseDynamicGroupPublishReceipt(value: unknown): DynamicGroupPublishReceipt;
export function parseDynamicGroupPauseReceipt(value: unknown): DynamicGroupPauseReceipt;
