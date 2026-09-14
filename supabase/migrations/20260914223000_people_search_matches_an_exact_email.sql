-- People search finds an account by its exact email address as well as by
-- handle or name (owner request, Sep 14 2026: "put back the feature where you
-- can find people by email"). Whole address only: a prefix or a fragment of an
-- address matches nothing, so the member list cannot be walked letter by
-- letter, and everything else about the search -- blocks, access, the rate
-- budget, the ranking -- is unchanged. Recreates the function whole; the
-- wrapper and grants are untouched.

create or replace function private.bff_search_users_by_username_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_query text, p_limit integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := coalesce(p_limit, 25);
  v_escaped text;
  -- An address is matched whole, never by prefix, so nobody can walk the
  -- member list one letter at a time (owner request, Sep 14 2026).
  v_is_email boolean := v_query like '%_@_%.__%';
  v_users jsonb := '[]'::jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'user.search.read', false, 0
  );

  if p_organization_id <> private.personal_realm_organization_id() then
    raise exception 'people search is a personal-realm capability'
      using errcode = '22023';
  end if;
  if v_limit not between 1 and 25 then
    raise exception 'invalid people search limit' using errcode = '22023';
  end if;

  -- Consume the search budget before answering anything, including malformed
  -- probes, so every query shape shares one abuse envelope.
  if not private.consume_rate_limit(
    'user-search-minute',
    p_organization_id::text || ':' || p_actor_user_id::text,
    30, 60
  ) then
    raise exception 'people search rate limit exceeded' using errcode = 'P0001';
  end if;

  -- Two people who know each other's names could not find each other because
  -- this only ever matched a username prefix, and silently returned nothing
  -- for uppercase, spaces, or Hangul. Any short query now finds nobody rather
  -- than erroring, but a real query matches the handle or the display name.
  if char_length(v_query) < 2 or char_length(v_query) > 64 then
    return jsonb_build_object('users', '[]'::jsonb);
  end if;

  -- LIKE metacharacters are literal in a search box.
  v_escaped := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'user_id', candidate.user_id,
    'username', candidate.username,
    'display_name', candidate.display_name,
    'avatar_path', candidate.avatar_path,
    'connection_state', candidate.connection_state
  )) order by candidate.match_rank, candidate.display_name, candidate.username,
    candidate.user_id), '[]'::jsonb)
  into v_users
  from (
    select
      membership.user_id,
      profile.username::text as username,
      profile.display_name,
      profile.avatar_path,
      case
        when v_is_email and lower(account.email) = v_query then 0
        when lower(profile.username::text) = v_query then 0
        when lower(profile.username::text) like v_escaped || '%' escape '\' then 1
        when lower(profile.display_name) like v_escaped || '%' escape '\' then 2
        else 3
      end as match_rank,
      coalesce((
        select case
          when connection.status = 'accepted' then 'accepted'
          when connection.status = 'pending'
            and connection.requested_by_user_id = p_actor_user_id
            then 'pending_outgoing'
          when connection.status = 'pending' then 'pending_incoming'
          else 'none'
        end
        from public.contact_connections connection
        where connection.organization_id = p_organization_id
          and connection.member_low_user_id
            = least(p_actor_user_id, membership.user_id)
          and connection.member_high_user_id
            = greatest(p_actor_user_id, membership.user_id)
      ), 'none') as connection_state
    from public.profiles profile
    join public.organization_memberships membership
      on membership.user_id = profile.user_id
     and membership.organization_id = p_organization_id
    left join auth.users account
      on account.id = membership.user_id
    where profile.username is not null
      and (
        (v_is_email and lower(account.email) = v_query)
        or lower(profile.username::text) like v_escaped || '%' escape '\'
        or lower(profile.display_name) like '%' || v_escaped || '%' escape '\'
      )
      and membership.user_id <> p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and (
            (block.blocker_user_id = p_actor_user_id
              and block.blocked_user_id = membership.user_id)
            or (block.blocker_user_id = membership.user_id
              and block.blocked_user_id = p_actor_user_id)
          )
      )
    order by match_rank, profile.display_name, profile.username, membership.user_id
    limit v_limit
  ) candidate;

  return jsonb_build_object('users', v_users);
end;
$function$;
