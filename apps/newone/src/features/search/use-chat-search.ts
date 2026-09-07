import { useEffect, useMemo, useRef, useState } from 'react';

import { BffSearchRepository } from '@/data/repositories/bff-search-repository';
import type { UserSearchResult } from '@/data/repositories/contracts';
import type { WorkspaceSearchResult } from '@/domain/types';
import {
  suggestionNeedle,
  type ParsedSearch,
  type SearchMessageRef,
  type SearchPersonRef,
} from '@/features/search/chat-search';
import { getSupabaseClient } from '@/lib/supabase';
import { useWorkspace } from '@/state/workspace';

/** The same beat the People search uses, so typing never feels chased. */
export const CHAT_SEARCH_DEBOUNCE_MS = 350;
const MINIMUM_QUERY = 2;

export interface ChatSearchResults {
  strangers: SearchPersonRef[];
  messages: SearchMessageRef[];
  loading: boolean;
}

function asPerson(result: UserSearchResult): SearchPersonRef {
  return {
    id: result.userId,
    displayName: result.displayName ?? result.username,
    username: result.username,
  };
}

function asMessage(result: WorkspaceSearchResult): SearchMessageRef | null {
  if (result.type !== 'messages' || !result.conversationId) return null;
  return {
    id: result.id,
    conversationId: result.conversationId,
    title: result.title,
    snippet: result.snippet,
    occurredAt: result.occurredAt,
  };
}

/**
 * The two server calls the Chats field already had behind the Search tab: the
 * user search that People uses, and the message search the search repository
 * exposes. Nothing new is asked of the server; the field just asks sooner.
 */
export function useChatSearch(parsed: ParsedSearch): ChatSearchResults {
  const workspace = useWorkspace();
  const searchUsers = workspace.searchUsers;
  const organizationId = workspace.organizationId;
  const [strangers, setStrangers] = useState<SearchPersonRef[]>([]);
  const [messages, setMessages] = useState<SearchMessageRef[]>([]);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const repository = useMemo(
    () => new BffSearchRepository({
      getSession: async () => {
        const client = getSupabaseClient();
        if (!client) return null;
        const { data } = await client.auth.getSession();
        return data.session;
      },
    }),
    [],
  );

  const needle = suggestionNeedle(parsed);
  // Loose words are what the message search can answer; the chips narrow the
  // rows locally, because membership is already on the device.
  const words = parsed.terms.join(' ').trim();

  useEffect(() => {
    const wantsPeople = needle.trim().length >= MINIMUM_QUERY;
    const wantsMessages = words.length >= MINIMUM_QUERY;
    const sequence = ++generation.current;
    if (!wantsPeople && !wantsMessages) {
      setStrangers([]);
      setMessages([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      const settle = () => {
        if (generation.current === sequence) setLoading(false);
      };
      const peopleRequest = wantsPeople
        ? searchUsers(needle.trim()).then((results) => {
            if (generation.current !== sequence) return;
            setStrangers((results ?? []).map(asPerson));
          }).catch(() => undefined)
        : Promise.resolve(setStrangers([]));
      const messageRequest = wantsMessages
        ? repository.search({
            organizationId,
            query: words,
            types: ['messages'],
            cursor: null,
            limit: 20,
          }).then((page) => {
            if (generation.current !== sequence) return;
            setMessages(page.results
              .map(asMessage)
              .filter((item): item is SearchMessageRef => item !== null));
          }).catch(() => {
            if (generation.current === sequence) setMessages([]);
          })
        : Promise.resolve(setMessages([]));
      void Promise.all([peopleRequest, messageRequest]).then(settle, settle);
    }, CHAT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [needle, organizationId, repository, searchUsers, words]);

  return { strangers, messages, loading };
}
