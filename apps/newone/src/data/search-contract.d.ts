import type {
  SearchMessageMatchSource,
  SearchLanguageFilter,
  SearchResultType,
  WorkspaceSearchResult,
} from '@/domain/types';

export const searchResultTypes: readonly SearchResultType[];
export const searchMatchSources: readonly WorkspaceSearchResult['matchedSource'][];
export const searchMessageMatchSources: readonly SearchMessageMatchSource[];
export const searchLanguages: readonly SearchLanguageFilter[];

export interface NormalizedSearchRequest {
  organizationId: string;
  query: string;
  types?: SearchResultType[];
  cursor: string | null;
  limit: number;
  senderMembershipId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  matchSources: SearchMessageMatchSource[] | null;
  conversationId: string | null;
  language: SearchLanguageFilter | null;
}

export function normalizeSearchRequest(value: unknown): NormalizedSearchRequest;
export function parseSearchPage(value: unknown, limit?: number): {
  results: WorkspaceSearchResult[];
  nextCursor: string | null;
  hasMore: boolean;
};
export function mergeSearchResults(
  current: WorkspaceSearchResult[],
  incoming: WorkspaceSearchResult[],
): WorkspaceSearchResult[];
export function searchDateBoundary(
  value: string,
  boundary: 'start' | 'end',
): string | null;
