-- People search matched only a username prefix, and returned an empty list
-- without explanation for anything that was not username-shaped (uppercase,
-- spaces, Hangul). Two real users could not find each other by name. Search
-- now also matches display names, ranked handle-first.
--
-- The bootstrap also never carried the @handle, so no screen could show who a
-- display name belongs to. directory[] and current_user now include username.

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v10_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_directory jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v9_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if p_organization_id <> private.personal_realm_organization_id() then
    return v_result;
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'user_id', visible.user_id,
    'username', visible.username,
    'display_name', visible.display_name,
    'avatar_path', visible.avatar_path,
    'status_message', visible.status_message,
    'preferred_language', visible.preferred_language,
    'time_zone', visible.time_zone,
    'membership_role', visible.membership_role,
    'membership_type', visible.membership_type,
    'membership_status', visible.membership_status,
    'access_expires_at', visible.access_expires_at,
    'job_title', visible.job_title,
    'directory_visibility', visible.directory_visibility,
    'unit_ids', visible.unit_ids,
    'is_saved_contact', visible.is_saved_contact,
    'is_blocked', visible.is_blocked,
    'connection', visible.connection
  )) order by visible.display_name, visible.user_id), '[]'::jsonb)
  into v_directory
  from (
    select membership.user_id, profile.username::text as username,
      profile.display_name, profile.avatar_path,
      profile.status_message, profile.preferred_language, profile.time_zone,
      membership.role as membership_role,
      membership.membership_type, membership.status as membership_status,
      membership.access_expires_at, membership.job_title,
      membership.directory_visibility,
      (
        select coalesce(jsonb_agg(unit_member.unit_id order by unit_member.unit_id),
          '[]'::jsonb)
        from public.organization_unit_members unit_member
        where unit_member.organization_id = membership.organization_id
          and unit_member.user_id = membership.user_id
      ) as unit_ids,
      exists (
        select 1 from public.saved_contacts saved
        where saved.organization_id = membership.organization_id
          and saved.owner_user_id = p_actor_user_id
          and saved.contact_user_id = membership.user_id
      ) as is_saved_contact,
      exists (
        select 1 from public.member_blocks block
        where block.organization_id = membership.organization_id
          and block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = membership.user_id
      ) as is_blocked,
      (
        select jsonb_build_object(
          'status', connection.status,
          'requested_by_user_id', connection.requested_by_user_id,
          'created_at', connection.created_at,
          'responded_at', connection.responded_at,
          'updated_at', connection.updated_at
        )
        from public.contact_connections connection
        where connection.organization_id = membership.organization_id
          and p_actor_user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
          and membership.user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
          and membership.user_id <> p_actor_user_id
      ) as connection
    from (
      select relevant.user_id
      from (
        select case when connection.member_low_user_id = p_actor_user_id
            then connection.member_high_user_id
            else connection.member_low_user_id end as user_id
        from public.contact_connections connection
        where connection.organization_id = p_organization_id
          and p_actor_user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
        union
        select co_member.user_id
        from public.conversation_members actor_member
        join public.conversation_members co_member
          on co_member.organization_id = actor_member.organization_id
         and co_member.conversation_id = actor_member.conversation_id
         and co_member.user_id <> p_actor_user_id
         and co_member.status = 'active'
        where actor_member.organization_id = p_organization_id
          and actor_member.user_id = p_actor_user_id
          and actor_member.status = 'active'
      ) relevant
    ) scoped
    join public.organization_memberships membership
      on membership.organization_id = p_organization_id
     and membership.user_id = scoped.user_id
    join public.profiles profile on profile.user_id = membership.user_id
    order by profile.display_name, membership.user_id
    limit 500
  ) visible;

  v_result := jsonb_set(
    v_result, '{current_user}',
    coalesce(v_result -> 'current_user', '{}'::jsonb) ||
      coalesce((
        select jsonb_strip_nulls(jsonb_build_object('username', profile.username::text))
        from public.profiles profile
        where profile.user_id = p_actor_user_id
      ), '{}'::jsonb), true
  );
  return jsonb_set(v_result, '{directory}', v_directory, true);
end;
$function$
;

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
    where profile.username is not null
      and (
        lower(profile.username::text) like v_escaped || '%' escape '\'
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

grant execute on function private.bff_search_users_by_username_impl(uuid, uuid, uuid, text, integer) to service_role;
