-- Fix a bad substitution, and the transform that made it.
--
-- The reduction that replaced subqueries over dropped tables with null treated
-- every "(select ...)" as a scalar subquery. A LEFT JOIN LATERAL (select ...)
-- is not one, so two functions came out holding "left join lateral null x on
-- true", which is not valid SQL. Nothing caught it at migration time because
-- the migration ran with check_function_bodies off, and these are SQL bodies
-- that are only parsed when executed -- so it surfaced as a 503 on every
-- bootstrap, because v7_pre_dynamic_group_impl calls this one.
--
-- Consumers have no discoverable conversations: the route is gone and the
-- join-request tables with it. The answer is the empty list it was already
-- returning, so the function says so directly.

create or replace function private.bff_list_discoverable_conversations_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_limit integer default 50
) returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $$
begin
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.discover.read', false, 0
  );
  if p_limit not between 1 and 100 then
    raise exception 'invalid discoverable conversation limit' using errcode = '22023';
  end if;
  return jsonb_build_object('conversations', '[]'::jsonb);
end;
$$;

-- Nothing calls either of these any more.
drop function if exists public.bff_list_discoverable_conversations(uuid,uuid,uuid,integer);
drop function if exists private.announcement_audience_candidates(uuid,uuid,jsonb,timestamp with time zone);
