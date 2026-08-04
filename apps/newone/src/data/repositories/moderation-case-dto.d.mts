export type ModerationCaseStatus = 'open' | 'assigned' | 'in_review' | 'resolved' | 'dismissed';
export type ModerationCaseCategory =
  | 'harassment'
  | 'threat'
  | 'spam'
  | 'privacy'
  | 'misinformation'
  | 'other';
export type ModerationTargetType = 'message' | 'group' | 'member';

export interface ModerationCaseTarget {
  type: ModerationTargetType;
  label: string;
}

export interface ModerationCaseCursor {
  beforeUpdatedAt: string;
  beforeCaseId: string;
}

export interface ModerationCaseListItem {
  caseId: string;
  status: ModerationCaseStatus;
  category: ModerationCaseCategory;
  target: ModerationCaseTarget;
  unitId: string | null;
  reportedAt: string;
  updatedAt: string;
  recordVersion: number;
  assignedAt: string | null;
  assignedToMe: boolean;
  assignedInvestigatorUserId: string | null;
  canClaim: boolean;
  canAssign: boolean;
  canViewEvidence: boolean;
  readOnly: boolean;
  eligibleInvestigatorUserIds: string[];
}

export interface ModerationEvidenceMetadata {
  referenceIds?: string[];
  policyCode?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

export interface ModerationCaseDetail {
  caseId: string;
  status: Exclude<ModerationCaseStatus, 'open'>;
  category: ModerationCaseCategory;
  target: ModerationCaseTarget;
  details: string | null;
  reporterLabel: 'protected';
  reportedAt: string;
  updatedAt: string;
  assignedAt: string;
  recordVersion: number;
  readOnly: boolean;
  evidence: Array<{
    evidenceId: number;
    relationship: 'reported' | 'context_before' | 'context_after';
    relativePosition: number;
    messageKind: string;
    messageBody: string | null;
    senderLabel: string;
    sentAt: string;
    bodySha256: string;
  }>;
  history: Array<{
    eventId: number;
    eventType:
      | 'reported'
      | 'assigned'
      | 'reassigned'
      | 'claimed'
      | 'accessed'
      | 'review_started'
      | 'resolved'
      | 'dismissed';
    fromStatus: ModerationCaseStatus | null;
    toStatus: ModerationCaseStatus | null;
    reason: string | null;
    evidenceMetadata: ModerationEvidenceMetadata;
    actorLabel: 'protected_reporter' | 'assigned_investigator' | 'authorized_case_manager';
    occurredAt: string;
  }>;
}

export const MODERATION_CASE_STATUSES: readonly ModerationCaseStatus[];
export const MODERATION_CASE_CATEGORIES: readonly ModerationCaseCategory[];
export const MODERATION_TARGET_TYPES: readonly ModerationTargetType[];
export function parseModerationCaseList(value: unknown): {
  schemaVersion: 2;
  cases: ModerationCaseListItem[];
  nextCursor: ModerationCaseCursor | null;
};
export function parseModerationCaseDetail(value: unknown): {
  schemaVersion: 2;
  case: ModerationCaseDetail;
};
export function parseModerationAssignmentReceipt(value: unknown): {
  caseId: string;
  status: 'assigned';
  recordVersion: number;
  assignedAt: string;
  assignedInvestigatorUserId: string;
};
export function parseModerationTransitionReceipt(value: unknown): {
  caseId: string;
  status: 'in_review' | 'resolved' | 'dismissed';
  recordVersion: number;
  updatedAt: string;
  readOnly: boolean;
};
