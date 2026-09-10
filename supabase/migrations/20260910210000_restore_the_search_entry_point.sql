-- Restore public.bff_search. I dropped the live search entry point.
--
-- 20260910170000 dropped it as a "public wrapper whose impl we are dropping".
-- That was wrong twice over: the impl it delegates to, private.bff_search_v3_impl,
-- is very much alive, and public.bff_search is what newone-read calls for every
-- search. I checked callers of bff_search_impl -- a different, genuinely dead
-- function -- and read the answer as covering this one.
--
-- Restored exactly as 20260804155917_complete_search_filters.sql defined it:
-- a thin delegation, with the same grants.

create or replace function public.bff_search(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_query text, p_types text[], p_cursor text default null,
  p_limit integer default 20, p_sender_user_id uuid default null,
  p_date_from timestamptz default null, p_date_to timestamptz default null,
  p_match_sources text[] default null, p_conversation_id uuid default null,
  p_language text default null
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_search_v3_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_query,
  p_types, p_cursor, p_limit, p_sender_user_id, p_date_from, p_date_to,
  p_match_sources, p_conversation_id, p_language
) $$;

revoke execute on function public.bff_search(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) from public, anon, authenticated;
grant execute on function public.bff_search(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) to service_role;

comment on function public.bff_search(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) is 'Authorization-trimmed unified search. Conversation and language filters only narrow already-visible results.';
