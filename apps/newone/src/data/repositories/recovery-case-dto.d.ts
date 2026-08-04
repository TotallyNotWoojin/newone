export type RecoveryCaseStatus =
  | 'awaiting_external_verification'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'expired';

export type RecoveryVerificationMethod =
  | 'in_person'
  | 'manager_callback'
  | 'hr_record_match'
  | 'approved_provider';

export interface RecoveryCase {
  caseId: string;
  organizationId: string;
  targetUserId: string;
  status: RecoveryCaseStatus;
  requestReason: string;
  privilegedTarget: boolean;
  requiredApprovals: number;
  approvalsRecorded: number;
  humanVerificationRecorded: boolean;
  verificationMethod: RecoveryVerificationMethod | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface RecoveryCaseList {
  schemaVersion: 1;
  scope: 'self' | 'organization';
  cases: RecoveryCase[];
  humanVerification: {
    performedByNewone: false;
    externalPolicyRequired: true;
  };
}

export interface VerifiedTotpFactor {
  id: string;
  status: 'verified';
  friendlyName: string | null;
}

export const RECOVERY_CASE_STATUSES: readonly RecoveryCaseStatus[];
export const RECOVERY_VERIFICATION_METHODS: readonly RecoveryVerificationMethod[];

export function parseRecoveryCaseList(value: unknown): RecoveryCaseList;
export function parseVerifiedTotpFactors(value: unknown): VerifiedTotpFactor[];
export function parseRecoveryCaseCreateReceipt(value: unknown): {
  caseId: string;
  status: 'awaiting_external_verification';
  privilegedTarget: boolean;
  requiredApprovals: number;
  expiresAt: string;
};
export function parseRecoveryVerificationReceipt(value: unknown): {
  caseId: string;
  status: 'awaiting_approval';
  requiredApprovals: number;
};
export function parseRecoveryApprovalReceipt(value: unknown): {
  caseId: string;
  status: 'awaiting_approval' | 'approved';
  approvalRecorded: boolean;
  approvalsRecorded: number;
  requiredApprovals: number;
};
export function parseRecoveryRejectionReceipt(value: unknown): {
  caseId: string;
  status: 'rejected';
};
export function parseRecoveryExecutionReceipt(value: unknown): {
  caseId: string;
  status: 'completed';
  alreadyCompleted: boolean;
  factorDeleted: true | null;
  allSessionsRevoked: true | null;
  securityNoticeState: 'pending_external_delivery' | null;
  sessionsRevoked: number | null;
  devicesRevoked: number | null;
};
export function maskedRecoveryCaseReference(caseId: string): string;
