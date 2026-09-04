export type ErrorCode =
  | 'bad_request'
  | 'invalid_json'
  | 'unsupported_media_type'
  | 'payload_too_large'
  | 'unsupported_content_encoding'
  | 'unauthorized'
  | 'forbidden'
  | 'message_request_cap'
  | 'csrf_failed'
  | 'origin_not_allowed'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'signup_expired'
  | 'invalid_username'
  | 'username_reserved'
  | 'username_taken'
  | 'invalid_display_name'
  | 'invalid_language'
  | 'attachment_not_ready'
  | 'attachment_integrity_failed'
  | 'rate_limited'
  | 'delivery_channel_unavailable'
  | 'dependency_unavailable'
  | 'code_delivery_failed'
  | 'ai_processing_disabled'
  | 'ai_output_needs_review'
  | 'provider_unavailable'
  | 'method_not_allowed'
  | 'internal_error';

const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  bad_request: 'The request is invalid.',
  invalid_json: 'The request body must be valid JSON.',
  unsupported_media_type: 'The request must use application/json.',
  payload_too_large: 'The request is too large.',
  unsupported_content_encoding: 'Compressed request bodies are not accepted.',
  unauthorized: 'Authentication is required.',
  forbidden: 'This action is not permitted.',
  message_request_cap: 'This message request already holds its three messages.',
  csrf_failed: 'The request could not be verified.',
  origin_not_allowed: 'The request origin is not allowed.',
  not_found: 'The requested resource was not found.',
  conflict: 'The request conflicts with the current state.',
  idempotency_conflict: 'The idempotency key was already used for another request.',
  signup_expired: 'The signup verification window expired. Restart signup.',
  invalid_username: 'The username format is not allowed.',
  username_reserved: 'That username is reserved.',
  username_taken: 'That username is already taken.',
  invalid_display_name: 'The display name is not allowed.',
  invalid_language: 'That language is not supported.',
  attachment_not_ready: 'The attachment upload is not ready.',
  attachment_integrity_failed: 'The uploaded attachment failed integrity verification.',
  rate_limited: 'Too many requests. Try again later.',
  delivery_channel_unavailable: 'That verification channel is not configured.',
  dependency_unavailable: 'A required service is temporarily unavailable.',
  code_delivery_failed: 'We could not send your code. Try again.',
  ai_processing_disabled: 'Language processing is not enabled.',
  ai_output_needs_review: 'The generated language output requires review.',
  provider_unavailable: 'Language processing is temporarily unavailable.',
  method_not_allowed: 'This method is not allowed.',
  internal_error: 'The request could not be completed.',
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(
    status: number,
    code: ErrorCode,
    message = DEFAULT_MESSAGES[code],
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface DatabaseErrorLike {
  code?: string;
  message?: string;
  status?: number;
}

export function fromDatabaseError(error: unknown): ApiError {
  const value = (error ?? {}) as DatabaseErrorLike;

  switch (value.code) {
    case '40001':
    case '23505':
      return new ApiError(409, 'conflict');
    case '22000':
    case '22023':
    case '23514':
      return new ApiError(400, 'bad_request');
    case '42501':
      // The database names one permission case the client has copy for: a
      // pending message request that already holds its three messages.
      return value.message === 'message_request_cap'
        ? new ApiError(403, 'message_request_cap')
        : new ApiError(403, 'forbidden');
    case 'P0001':
      return new ApiError(429, 'rate_limited', undefined, 60);
    case 'PGRST116':
      return new ApiError(404, 'not_found');
    case 'PGRST202':
    case '42883':
      return new ApiError(503, 'dependency_unavailable', undefined, 5);
    case '55000':
      return value.message === 'idempotency key is unavailable'
        ? new ApiError(409, 'idempotency_conflict')
        : new ApiError(503, 'dependency_unavailable', undefined, 5);
    default:
      if (value.status === 401) return new ApiError(401, 'unauthorized');
      if (value.status === 403) return new ApiError(403, 'forbidden');
      if (value.status === 404) return new ApiError(404, 'not_found');
      if (value.status === 409) return new ApiError(409, 'conflict');
      if (value.status === 429) return new ApiError(429, 'rate_limited', undefined, 60);
      return new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
}

export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error : new ApiError(500, 'internal_error');
}
