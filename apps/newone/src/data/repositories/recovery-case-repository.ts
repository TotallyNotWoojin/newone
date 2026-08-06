import { Platform } from 'react-native';

import { apiUrlFor, nativeEdgeRequestHeaders, publicRuntimeConfig } from '@/config/runtime';
import {
  parseRecoveryApprovalReceipt,
  parseRecoveryCaseCreateReceipt,
  parseRecoveryCaseList,
  parseRecoveryExecutionReceipt,
  parseRecoveryRejectionReceipt,
  parseRecoveryVerificationReceipt,
  parseVerifiedTotpFactors,
} from '@/data/repositories/recovery-case-dto.mjs';
import { getWebCsrfToken } from '@/lib/web-auth';
import { getSupabaseClient } from '@/lib/supabase';

export type RecoveryVerificationMethod =
  | 'in_person'
  | 'manager_callback'
  | 'hr_record_match'
  | 'approved_provider';
export type RecoveryCaseStatus =
  | 'awaiting_external_verification'
  | 'awaiting_approval'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'rejected'
  | 'expired';
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

const MAX_RESPONSE_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFICATION_METHODS = new Set<RecoveryVerificationMethod>([
  'in_person',
  'manager_callback',
  'hr_record_match',
  'approved_provider',
]);

type AccessTokenProvider = () => Promise<string | null> | string | null;
type ReceiptParser<T> = (payload: unknown) => T;

export class RecoveryCaseRepositoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
    public readonly status?: number,
  ) {
    super('The secure account-recovery request could not be completed.');
    this.name = 'RecoveryCaseRepositoryError';
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validUuid(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) {
    throw new RecoveryCaseRepositoryError(`invalid_${label}`, false);
  }
  return value.toLowerCase();
}

function boundedText(value: string, minimum: number, maximum: number, code: string) {
  const normalized = value.trim();
  if (
    normalized.length < minimum || normalized.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)
  ) {
    throw new RecoveryCaseRepositoryError(code, false);
  }
  return normalized;
}

function parseProblem(payload: unknown, status: number) {
  const root = objectValue(payload);
  const problem = objectValue(root.error ?? root);
  const code = typeof problem.code === 'string' && /^[a-z0-9_]{2,80}$/i.test(problem.code)
    ? problem.code
    : `http_${status}`;
  const correlationId = typeof problem.correlationId === 'string' &&
    /^[a-z0-9_-]{1,128}$/i.test(problem.correlationId)
    ? problem.correlationId
    : undefined;
  return { code, correlationId };
}

function utf8ByteLength(value: string) {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      length += 4;
      index += 1;
    } else length += 3;
  }
  return length;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:problem\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new RecoveryCaseRepositoryError('invalid_response', true, undefined, response.status);
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) {
      throw new RecoveryCaseRepositoryError('response_too_large', true, undefined, response.status);
    }
  }
  const text = await response.text();
  if (utf8ByteLength(text) > MAX_RESPONSE_BYTES) {
    throw new RecoveryCaseRepositoryError('response_too_large', true, undefined, response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RecoveryCaseRepositoryError('invalid_response', true, undefined, response.status);
  }
}

export class RecoveryCaseRepository {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  private async request<T>(
    path: `/${string}`,
    body: Record<string, unknown>,
    parser: ReceiptParser<T>,
    idempotencyKey?: string,
  ): Promise<T> {
    if (!publicRuntimeConfig.apiUrl) {
      throw new RecoveryCaseRepositoryError('service_unconfigured', false);
    }
    const accessToken = await this.getAccessToken();
    if (Platform.OS !== 'web' && !accessToken) {
      throw new RecoveryCaseRepositoryError('authentication_required', false);
    }
    const csrfToken = Platform.OS === 'web' ? getWebCsrfToken() : null;
    if (Platform.OS === 'web' && !csrfToken) {
      throw new RecoveryCaseRepositoryError('csrf_required', false);
    }
    const url = apiUrlFor(path);
    const edgeHeaders = nativeEdgeRequestHeaders(accessToken ?? undefined);
    if (!url || !edgeHeaders) {
      throw new RecoveryCaseRepositoryError('service_unconfigured', false);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(idempotencyKey ? {
            'Idempotency-Key': validUuid(idempotencyKey, 'idempotency_key'),
          } : {}),
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...edgeHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      payload = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof RecoveryCaseRepositoryError) throw error;
      throw new RecoveryCaseRepositoryError('network_unavailable', true);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const problem = parseProblem(payload, response.status);
      throw new RecoveryCaseRepositoryError(
        problem.code,
        response.status === 408 || response.status === 425 || response.status === 429 ||
          response.status >= 500,
        problem.correlationId,
        response.status,
      );
    }
    try {
      return parser(payload);
    } catch (error) {
      if (error instanceof RecoveryCaseRepositoryError) throw error;
      throw new RecoveryCaseRepositoryError('invalid_response', true, undefined, response.status);
    }
  }

  async listCases(organizationId: string): Promise<RecoveryCaseList> {
    const expectedOrganizationId = validUuid(organizationId, 'organization_id');
    const result = await this.request(
      '/v2/auth/recovery/cases/query',
      { organizationId: expectedOrganizationId, includeOrganization: true },
      parseRecoveryCaseList as (payload: unknown) => RecoveryCaseList,
    );
    if (
      result.scope !== 'organization' ||
      result.cases.some((item) => item.organizationId !== expectedOrganizationId)
    ) throw new RecoveryCaseRepositoryError('invalid_response', true);
    return result;
  }

  async listVerifiedTotpFactors(): Promise<VerifiedTotpFactor[]> {
    if (Platform.OS === 'web') {
      return this.request(
        '/v2/auth/mfa/factors',
        {},
        parseVerifiedTotpFactors as (payload: unknown) => VerifiedTotpFactor[],
      );
    }
    const client = getSupabaseClient();
    if (!client) throw new RecoveryCaseRepositoryError('service_unconfigured', false);
    const result = await client.auth.mfa.listFactors();
    if (result.error) {
      throw new RecoveryCaseRepositoryError('factor_list_failed', true);
    }
    try {
      return parseVerifiedTotpFactors({
        factors: result.data.all.map((factor) => ({
          id: factor.id,
          type: factor.factor_type,
          status: factor.status,
          friendlyName: factor.friendly_name ?? null,
          createdAt: factor.created_at,
          updatedAt: factor.updated_at,
        })),
      }) as VerifiedTotpFactor[];
    } catch {
      throw new RecoveryCaseRepositoryError('invalid_response', true);
    }
  }

  createCase(input: {
    organizationId: string;
    factorId: string;
    reason: string;
    idempotencyKey: string;
  }) {
    return this.request(
      '/v2/auth/recovery/cases',
      {
        organizationId: validUuid(input.organizationId, 'organization_id'),
        factorId: validUuid(input.factorId, 'factor_id'),
        reason: boundedText(input.reason, 10, 1000, 'invalid_reason'),
      },
      parseRecoveryCaseCreateReceipt,
      input.idempotencyKey,
    );
  }

  async recordVerification(input: {
    organizationId: string;
    caseId: string;
    method: RecoveryVerificationMethod;
    evidenceReference: string;
    idempotencyKey: string;
  }) {
    const caseId = validUuid(input.caseId, 'case_id');
    if (!VERIFICATION_METHODS.has(input.method)) {
      throw new RecoveryCaseRepositoryError('invalid_verification_method', false);
    }
    const receipt = await this.request(
      `/v2/auth/recovery/cases/${caseId}/verify`,
      {
        organizationId: validUuid(input.organizationId, 'organization_id'),
        method: input.method,
        evidenceReference: boundedText(
          input.evidenceReference,
          8,
          500,
          'invalid_evidence_reference',
        ),
      },
      parseRecoveryVerificationReceipt,
      input.idempotencyKey,
    );
    if (receipt.caseId !== caseId) {
      throw new RecoveryCaseRepositoryError('invalid_response', true);
    }
    return receipt;
  }

  async approveCase(input: {
    organizationId: string;
    caseId: string;
    idempotencyKey: string;
  }) {
    const caseId = validUuid(input.caseId, 'case_id');
    const receipt = await this.request(
      `/v2/auth/recovery/cases/${caseId}/approve`,
      { organizationId: validUuid(input.organizationId, 'organization_id') },
      parseRecoveryApprovalReceipt,
      input.idempotencyKey,
    );
    if (receipt.caseId !== caseId) {
      throw new RecoveryCaseRepositoryError('invalid_response', true);
    }
    return receipt;
  }

  async rejectCase(input: {
    organizationId: string;
    caseId: string;
    reason: string;
    idempotencyKey: string;
  }) {
    const caseId = validUuid(input.caseId, 'case_id');
    const receipt = await this.request(
      `/v2/auth/recovery/cases/${caseId}/reject`,
      {
        organizationId: validUuid(input.organizationId, 'organization_id'),
        reason: boundedText(input.reason, 3, 500, 'invalid_rejection_reason'),
      },
      parseRecoveryRejectionReceipt,
      input.idempotencyKey,
    );
    if (receipt.caseId !== caseId) {
      throw new RecoveryCaseRepositoryError('invalid_response', true);
    }
    return receipt;
  }

  async executeCase(input: {
    organizationId: string;
    caseId: string;
    idempotencyKey: string;
  }) {
    const caseId = validUuid(input.caseId, 'case_id');
    const receipt = await this.request(
      `/v2/auth/recovery/cases/${caseId}/execute`,
      { organizationId: validUuid(input.organizationId, 'organization_id') },
      parseRecoveryExecutionReceipt,
      input.idempotencyKey,
    );
    if (receipt.caseId !== caseId) {
      throw new RecoveryCaseRepositoryError('invalid_response', true);
    }
    return receipt;
  }
}
