import type { LanguageCode } from '@/domain/types';

export interface HandoffCorrectionInput {
  organizationId: string;
  handoffId: string;
  expectedVersionId: string;
  expectedVersionNumber: number;
  title: string;
  details: string;
  sourceLanguage: LanguageCode;
  shiftStartedAt: string;
  shiftEndedAt: string;
  sourceMessageIds: string[];
  acknowledgementDueAt: string | null;
  reason: string;
  idempotencyKey: string;
}

export interface HandoffCorrectionReceipt {
  handoffId: string;
  versionId: string;
  versionNumber: number;
  status: 'draft';
  requiresSignature: true;
  sourceMessageIds: string[];
  sourceFingerprint: string;
  sourceState: 'current';
  acknowledgementDueAt: string | null;
  reminderState: 'not_due';
  escalationState: 'not_due';
  smsFallbackAvailable: false;
}

export function normalizeHandoffCorrectionRequest(value: unknown): HandoffCorrectionInput;
export function parseHandoffCorrectionReceipt(
  value: unknown,
  expected: unknown,
): HandoffCorrectionReceipt;
