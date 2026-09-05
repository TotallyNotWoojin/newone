
import { apiUrlFor, nativeEdgeRequestHeaders, publicRuntimeConfig } from '@/config/runtime';
import type {
  RepositoryContext,
  SearchPage,
  SearchRepository,
} from '@/data/repositories/contracts';
import { RepositoryError } from '@/data/repositories/contracts';
import { normalizeSearchRequest, parseSearchPage } from '@/data/search-contract.mjs';
import { usesCookieSession } from '@/lib/session-transport';
import { getWebCsrfToken } from '@/lib/web-auth';

type UnknownRecord = Record<string, unknown>;

function objectValue(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {};
}

export class BffSearchRepository implements SearchRepository {
  constructor(private readonly context: RepositoryContext) {}

  async search(input: Parameters<SearchRepository['search']>[0]): Promise<SearchPage> {
    let normalized: ReturnType<typeof normalizeSearchRequest>;
    try {
      normalized = normalizeSearchRequest(input);
    } catch {
      throw new RepositoryError('Search terms must be between 2 and 200 characters.', 'invalid_query', false);
    }
    if (!publicRuntimeConfig.apiUrl) {
      throw new RepositoryError('The secure search service is not configured.', 'service_unconfigured', false);
    }
    const cookieSession = usesCookieSession();
    const session = await this.context.getSession();
    if (!cookieSession && !session?.access_token) {
      throw new RepositoryError('Sign in again to search.', 'authentication_required', false);
    }
    const csrfToken = cookieSession ? getWebCsrfToken() : null;
    if (cookieSession && !csrfToken) {
      throw new RepositoryError('Your secure web session needs to be refreshed.', 'csrf_required', false);
    }
    const url = apiUrlFor('/v2/search');
    if (!url) {
      throw new RepositoryError('The secure search service is not configured.', 'service_unconfigured', false);
    }
    const edgeHeaders = nativeEdgeRequestHeaders(session?.access_token);
    if (!edgeHeaders) {
      throw new RepositoryError('The native search service is not configured.', 'service_unconfigured', false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        credentials: cookieSession ? 'include' : 'omit',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
          ...edgeHeaders,
        },
        body: JSON.stringify({
          organizationId: normalized.organizationId,
          query: normalized.query,
          ...(normalized.types?.length ? { types: normalized.types } : {}),
          cursor: normalized.cursor,
          limit: normalized.limit,
          ...(normalized.senderMembershipId
            ? { senderMembershipId: normalized.senderMembershipId }
            : {}),
          ...(normalized.dateFrom ? { dateFrom: normalized.dateFrom } : {}),
          ...(normalized.dateTo ? { dateTo: normalized.dateTo } : {}),
          ...(normalized.matchSources ? { matchSources: normalized.matchSources } : {}),
          ...(normalized.conversationId ? { conversationId: normalized.conversationId } : {}),
          ...(normalized.language ? { language: normalized.language } : {}),
        }),
        signal: controller.signal,
      });
    } catch {
      throw new RepositoryError('Newone cannot reach secure search.', 'network_unavailable', true);
    } finally {
      clearTimeout(timeout);
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Malformed responses are rejected below without exposing response text.
    }
    const root = objectValue(payload);
    const data = objectValue(root.data ?? root);
    if (!response.ok) {
      const problem = objectValue(root.error ?? root);
      throw new RepositoryError(
        'Search was rejected.',
        typeof problem.code === 'string' ? problem.code : `http_${response.status}`,
        response.status === 408 || response.status === 429 || response.status >= 500,
        typeof problem.correlationId === 'string' ? problem.correlationId : undefined,
        response.status,
      );
    }
    try {
      return parseSearchPage(data, normalized.limit);
    } catch {
      throw new RepositoryError('The search service returned an invalid result list.', 'invalid_response', true);
    }
  }
}
