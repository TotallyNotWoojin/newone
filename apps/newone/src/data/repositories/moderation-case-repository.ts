
import { apiUrlFor, nativeEdgeRequestHeaders, publicRuntimeConfig } from '@/config/runtime';
import {
  parseModerationAssignmentReceipt,
  parseModerationCaseDetail,
  parseModerationCaseList,
  parseModerationTransitionReceipt,
} from '@/data/repositories/moderation-case-dto.mjs';
import type {
  ModerationCaseCursor,
  ModerationCaseDetail,
  ModerationCaseListItem,
  ModerationCaseStatus,
  ModerationEvidenceMetadata,
} from '@/data/repositories/moderation-case-dto.mjs';
import { usesCookieSession } from '@/lib/session-transport';
import { getWebCsrfToken } from '@/lib/web-auth';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_RESPONSE_BYTES = 524_288;
const REQUEST_TIMEOUT_MS = 15_000;

type AccessTokenProvider = () => Promise<string | null> | string | null;
type Parser<T> = (payload: unknown) => T;

export type {
  ModerationCaseCursor,
  ModerationCaseDetail,
  ModerationCaseListItem,
  ModerationCaseStatus,
  ModerationEvidenceMetadata,
};

export class ModerationCaseRepositoryError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly correlationId?: string,
    public readonly status?: number,
  ) {
    super('The scoped moderation case request could not be completed.');
    this.name = 'ModerationCaseRepositoryError';
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new ModerationCaseRepositoryError(`invalid_${label}`, false);
  }
  return value.toLowerCase();
}

function boundedText(
  value: string,
  minimum: number,
  maximum: number,
  code: string,
): string {
  const normalized = value.trim();
  if (
    normalized.length < minimum || normalized.length > maximum ||
    CONTROL_PATTERN.test(normalized)
  ) throw new ModerationCaseRepositoryError(code, false);
  return normalized;
}

function parseProblem(payload: unknown, status: number) {
  const root = objectValue(payload);
  const error = objectValue(root.error ?? root);
  const code = typeof error.code === 'string' && /^[a-z0-9_]{2,80}$/i.test(error.code)
    ? error.code
    : `http_${status}`;
  const correlationId = typeof error.correlationId === 'string' &&
      /^[a-z0-9_-]{1,128}$/i.test(error.correlationId)
    ? error.correlationId
    : undefined;
  return { code, correlationId };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:problem\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new ModerationCaseRepositoryError('invalid_response', true, undefined, response.status);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new ModerationCaseRepositoryError(
        'response_too_large',
        true,
        undefined,
        response.status,
      );
    }
  }
  const text = await response.text();
  if (byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new ModerationCaseRepositoryError('response_too_large', true, undefined, response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ModerationCaseRepositoryError('invalid_response', true, undefined, response.status);
  }
}

function evidenceMetadata(input: ModerationEvidenceMetadata): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (input.referenceIds !== undefined) {
    if (input.referenceIds.length > 20) {
      throw new ModerationCaseRepositoryError('invalid_evidence', false);
    }
    const references = input.referenceIds.map((reference) =>
      boundedText(reference, 1, 120, 'invalid_evidence')
    );
    if (new Set(references).size !== references.length) {
      throw new ModerationCaseRepositoryError('invalid_evidence', false);
    }
    result.referenceIds = references;
  }
  if (input.policyCode !== undefined) {
    const policyCode = boundedText(input.policyCode, 2, 80, 'invalid_evidence');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$/.test(policyCode)) {
      throw new ModerationCaseRepositoryError('invalid_evidence', false);
    }
    result.policyCode = policyCode;
  }
  if (input.severity !== undefined) {
    if (!['low', 'medium', 'high', 'critical'].includes(input.severity)) {
      throw new ModerationCaseRepositoryError('invalid_evidence', false);
    }
    result.severity = input.severity;
  }
  return result;
}

export class ModerationCaseRepository {
  constructor(private readonly getAccessToken: AccessTokenProvider) {}

  private async request<T>(
    path: `/${string}`,
    body: Record<string, unknown>,
    parser: Parser<T>,
    idempotencyKey?: string,
  ): Promise<T> {
    if (!publicRuntimeConfig.apiUrl) {
      throw new ModerationCaseRepositoryError('service_unconfigured', false);
    }
    const cookieSession = usesCookieSession();
    const accessToken = await this.getAccessToken();
    if (!cookieSession && !accessToken) {
      throw new ModerationCaseRepositoryError('authentication_required', false);
    }
    const csrfToken = cookieSession ? getWebCsrfToken() : null;
    if (cookieSession && !csrfToken) {
      throw new ModerationCaseRepositoryError('csrf_required', false);
    }
    const url = apiUrlFor(path);
    const edgeHeaders = nativeEdgeRequestHeaders(accessToken ?? undefined);
    if (!url || !edgeHeaders) {
      throw new ModerationCaseRepositoryError('service_unconfigured', false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    let payload: unknown;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: cookieSession ? 'include' : 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': uuid(idempotencyKey, 'idempotency_key') } : {}),
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...edgeHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      payload = await boundedJson(response);
    } catch (error) {
      if (error instanceof ModerationCaseRepositoryError) throw error;
      throw new ModerationCaseRepositoryError('network_unavailable', true);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const problem = parseProblem(payload, response.status);
      throw new ModerationCaseRepositoryError(
        problem.code,
        response.status === 408 || response.status === 409 || response.status === 425 ||
          response.status === 429 || response.status >= 500,
        problem.correlationId,
        response.status,
      );
    }
    try {
      return parser(payload);
    } catch {
      throw new ModerationCaseRepositoryError('invalid_response', true, undefined, response.status);
    }
  }

  queryCases(input: {
    organizationId: string;
    statuses: ModerationCaseStatus[];
    cursor?: ModerationCaseCursor | null;
    limit?: number;
  }): Promise<{ schemaVersion: 2; cases: ModerationCaseListItem[]; nextCursor: ModerationCaseCursor | null }> {
    const statuses = [...new Set(input.statuses)];
    if (statuses.length < 1 || statuses.length > 5) {
      throw new ModerationCaseRepositoryError('invalid_statuses', false);
    }
    return this.request(
      '/v2/moderation/cases/query',
      {
        organizationId: uuid(input.organizationId, 'organization_id'),
        statuses,
        ...(input.cursor ? {
          cursor: {
            beforeUpdatedAt: input.cursor.beforeUpdatedAt,
            beforeCaseId: uuid(input.cursor.beforeCaseId, 'cursor_case_id'),
          },
        } : {}),
        limit: input.limit ?? 50,
      },
      parseModerationCaseList,
    );
  }

  async readCase(input: { organizationId: string; caseId: string }): Promise<ModerationCaseDetail> {
    const caseId = uuid(input.caseId, 'case_id');
    const result = await this.request(
      `/v2/moderation/cases/${caseId}/query`,
      { organizationId: uuid(input.organizationId, 'organization_id') },
      parseModerationCaseDetail,
    );
    if (result.case.caseId !== caseId) {
      throw new ModerationCaseRepositoryError('invalid_response', true);
    }
    return result.case;
  }

  async assignCase(input: {
    organizationId: string;
    caseId: string;
    investigatorUserId: string;
    expectedVersion: number;
    reason: string;
    idempotencyKey: string;
  }) {
    const caseId = uuid(input.caseId, 'case_id');
    const result = await this.request(
      `/v2/moderation/cases/${caseId}/assign`,
      {
        organizationId: uuid(input.organizationId, 'organization_id'),
        investigatorUserId: uuid(input.investigatorUserId, 'investigator_user_id'),
        expectedVersion: input.expectedVersion,
        reason: boundedText(input.reason, 3, 1000, 'invalid_reason'),
      },
      parseModerationAssignmentReceipt,
      input.idempotencyKey,
    );
    if (result.caseId !== caseId) throw new ModerationCaseRepositoryError('invalid_response', true);
    return result;
  }

  async claimCase(input: {
    organizationId: string;
    caseId: string;
    expectedVersion: number;
    reason: string;
    idempotencyKey: string;
  }) {
    const caseId = uuid(input.caseId, 'case_id');
    const result = await this.request(
      `/v2/moderation/cases/${caseId}/claim`,
      {
        organizationId: uuid(input.organizationId, 'organization_id'),
        expectedVersion: input.expectedVersion,
        reason: boundedText(input.reason, 3, 1000, 'invalid_reason'),
      },
      parseModerationAssignmentReceipt,
      input.idempotencyKey,
    );
    if (result.caseId !== caseId) throw new ModerationCaseRepositoryError('invalid_response', true);
    return result;
  }

  async transitionCase(input: {
    organizationId: string;
    caseId: string;
    status: 'in_review' | 'resolved' | 'dismissed';
    expectedVersion: number;
    reason: string;
    evidenceMetadata?: ModerationEvidenceMetadata;
    idempotencyKey: string;
  }) {
    const caseId = uuid(input.caseId, 'case_id');
    const metadata = evidenceMetadata(input.evidenceMetadata ?? {});
    if (input.status !== 'in_review' && Object.keys(metadata).length === 0) {
      throw new ModerationCaseRepositoryError('invalid_evidence', false);
    }
    const result = await this.request(
      `/v2/moderation/cases/${caseId}/transition`,
      {
        organizationId: uuid(input.organizationId, 'organization_id'),
        status: input.status,
        expectedVersion: input.expectedVersion,
        reason: boundedText(input.reason, 3, 2000, 'invalid_reason'),
        evidenceMetadata: metadata,
      },
      parseModerationTransitionReceipt,
      input.idempotencyKey,
    );
    if (result.caseId !== caseId) throw new ModerationCaseRepositoryError('invalid_response', true);
    return result;
  }
}
