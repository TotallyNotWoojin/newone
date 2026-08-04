export type PrivateReportTargetType = 'message' | 'group' | 'member';
export type PrivateReportStatus = 'open' | 'assigned' | 'in_review';
export type PrivateReportNoticeVersion = 'moderation-report-v2' | 'moderation-share-v1';

export interface PrivateReportReceipt {
  reportId: string;
  status: PrivateReportStatus;
  targetType: PrivateReportTargetType;
  created: boolean;
  reporterIdentityProtected: true;
  targetNotNotified: true;
  noticeVersion: PrivateReportNoticeVersion;
  contextBefore: 0 | 1 | 2;
  contextAfter: 0 | 1 | 2;
}

export function parsePrivateReportReceipt(
  value: unknown,
  expectedTargetType: PrivateReportTargetType,
): PrivateReportReceipt;
