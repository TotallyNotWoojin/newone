-- Both people pickers (add to group, new group) matched display names and job
-- titles only, so typing someone's @username found nobody. They now match the
-- handle too (a leading @ is ignored) and return it for display.

CREATE OR REPLACE FUNCTION private.bff_list_conversation_member_candidates_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_query text DEFAULT ''::text, p_cursor text DEFAULT NULL::text, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_snapshot_at timestamptz;
  v_query text;
  v_query_hash text;
  v_cursor_json jsonb;
  v_cursor_actor_user_id uuid;
  v_cursor_organization_id uuid;
  v_cursor_conversation_id uuid;
  v_after_name text;
  v_after_user_id uuid;
  v_candidates jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_last_name text;
  v_last_user_id uuid;
  v_next_cursor text;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member_candidates.read', false, 0
  );

  if p_limit is null or p_limit not between 1 and 100
    or char_length(btrim(coalesce(p_query, ''))) > 120 then
    raise exception 'invalid conversation member candidate query'
      using errcode = '22023';
  end if;

  -- Keep the explicit tenant-membership check even though the canonical
  -- management helper also checks it. This endpoint must never become a
  -- directory oracle if that helper evolves independently.
  if not exists (
    select 1
    from public.organization_memberships actor
    where actor.organization_id = p_organization_id
      and actor.user_id = p_actor_user_id
      and actor.membership_type <> 'guest'
      and private.organization_membership_access_current(
        actor.organization_id, actor.user_id, v_now
      )
  ) or not exists (
    select 1
    from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind <> 'direct'
      and conversation.kind in ('group', 'team', 'shift', 'incident')
      and not conversation.is_archived
      and conversation.closed_at is null
  ) or not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation member candidates unavailable'
      using errcode = '42501';
  end if;

  -- Published dynamic membership is reconciled exclusively by policy. Do not
  -- advertise manual additions that the write path and provenance trigger
  -- will reject, including to a current owner or administrator.
  if private.dynamic_group_policy_conversation(
    p_organization_id, p_conversation_id
  ) then
    return jsonb_build_object(
      'candidates', '[]'::jsonb,
      'next_cursor', null
    );
  end if;

  v_query := private.normalize_search_text(btrim(coalesce(p_query, '')));
  v_query_hash := encode(
    extensions.digest(convert_to(v_query, 'UTF8'), 'sha256'), 'hex'
  );

  if p_cursor is null then
    v_snapshot_at := v_now;
  else
    begin
      if char_length(p_cursor) > 1536
        or p_cursor !~ '^[A-Za-z0-9+/]+={0,2}$' then
        raise exception 'malformed cursor';
      end if;
      v_cursor_json := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      if jsonb_typeof(v_cursor_json) <> 'object'
        or (select count(*) from pg_catalog.jsonb_object_keys(v_cursor_json)) <> 9
        or not (v_cursor_json ?& array[
          'version', 'actor_user_id', 'organization_id', 'conversation_id',
          'query_sha256', 'page_size', 'snapshot_at', 'after_name', 'after_user_id'
        ])
        or v_cursor_json -> 'version' <> '1'::jsonb
        or coalesce(v_cursor_json ->> 'actor_user_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(v_cursor_json ->> 'organization_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(v_cursor_json ->> 'conversation_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(v_cursor_json ->> 'query_sha256', '') !~ '^[0-9a-f]{64}$'
        or coalesce(v_cursor_json ->> 'page_size', '') !~ '^[1-9][0-9]{0,2}$'
        or char_length(coalesce(v_cursor_json ->> 'after_name', '')) not between 1 and 160
        or coalesce(v_cursor_json ->> 'after_user_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception 'malformed cursor payload';
      end if;

      v_cursor_actor_user_id := (v_cursor_json ->> 'actor_user_id')::uuid;
      v_cursor_organization_id := (v_cursor_json ->> 'organization_id')::uuid;
      v_cursor_conversation_id := (v_cursor_json ->> 'conversation_id')::uuid;
      v_snapshot_at := (v_cursor_json ->> 'snapshot_at')::timestamptz;
      v_after_name := v_cursor_json ->> 'after_name';
      v_after_user_id := (v_cursor_json ->> 'after_user_id')::uuid;

      if v_cursor_actor_user_id is null
        or v_cursor_actor_user_id <> p_actor_user_id
        or v_cursor_organization_id is null
        or v_cursor_organization_id <> p_organization_id
        or v_cursor_conversation_id is null
        or v_cursor_conversation_id <> p_conversation_id
        or v_cursor_json ->> 'query_sha256' <> v_query_hash
        or (v_cursor_json ->> 'page_size')::integer <> p_limit
        or v_snapshot_at is null
        or not isfinite(v_snapshot_at)
        or v_snapshot_at > v_now + interval '1 minute'
        or v_snapshot_at < v_now - interval '15 minutes' then
        raise exception 'stale or mismatched cursor';
      end if;
    exception when others then
      raise exception 'invalid conversation member candidate cursor'
        using errcode = '22023';
    end;
  end if;

  with eligible as (
    select
      membership.user_id,
      profile.display_name,
      profile.username::text as username,
      profile.avatar_path,
      membership.job_title as role_label,
      membership.membership_type,
      private.normalize_search_text(profile.display_name) as sort_name
    from public.organization_memberships membership
    join public.profiles profile
      on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id <> p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, v_now
      )
      and membership.updated_at <= v_snapshot_at
      and profile.updated_at <= v_snapshot_at
      and private.can_view_org_member_for_actor(
        p_organization_id, p_actor_user_id, membership.user_id, v_now
      )
      and private.group_member_candidate_permitted(
        p_organization_id, p_actor_user_id, membership.user_id
      )
      and not exists (
        select 1
        from public.conversation_members current_member
        where current_member.organization_id = p_organization_id
          and current_member.conversation_id = p_conversation_id
          and current_member.user_id = membership.user_id
      )
      and (
        v_query = ''
        or private.normalize_search_text(profile.display_name)
          like '%' || v_query || '%'
        or private.normalize_search_text(coalesce(membership.job_title, ''))
          like '%' || v_query || '%'
        -- The @handle is how people find each other; a leading @ is ignored.
        or lower(profile.username::text) like '%' || ltrim(lower(btrim(coalesce(p_query, ''))), '@') || '%'
      )
  ), page as (
    select eligible.*
    from eligible
    where p_cursor is null
      or (eligible.sort_name, eligible.user_id) > (v_after_name, v_after_user_id)
    order by eligible.sort_name, eligible.user_id
    limit p_limit + 1
  ), numbered as (
    select page.*, row_number() over (
      order by page.sort_name, page.user_id
    ) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'user_id', numbered.user_id,
        'display_name', numbered.display_name,
      'username', numbered.username,
        'avatar_path', numbered.avatar_path,
        'role_label', numbered.role_label,
        'membership_type', numbered.membership_type
      )) order by numbered.sort_name, numbered.user_id
    ) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    max(numbered.sort_name) filter (where numbered.row_number = p_limit),
    (max(numbered.user_id::text) filter (
      where numbered.row_number = p_limit
    ))::uuid
  into v_candidates, v_has_more, v_last_name, v_last_user_id
  from numbered;

  if v_has_more then
    v_next_cursor := replace(encode(convert_to(jsonb_build_object(
      'version', 1,
      'actor_user_id', p_actor_user_id,
      'organization_id', p_organization_id,
      'conversation_id', p_conversation_id,
      'query_sha256', v_query_hash,
      'page_size', p_limit,
      'snapshot_at', v_snapshot_at,
      'after_name', v_last_name,
      'after_user_id', v_last_user_id
    )::text, 'UTF8'), 'base64'), E'\n', '');
  end if;

  return jsonb_build_object(
    'candidates', v_candidates,
    'next_cursor', v_next_cursor
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.bff_list_group_creation_candidates_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_query text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_candidates jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.group.candidates.read', false, 0
  );
  if p_limit not between 1 and 100
    or char_length(btrim(coalesce(p_query, ''))) > 120 then
    raise exception 'invalid group candidate query' using errcode = '22023';
  end if;
  if not private.actor_can_create_group(
      p_actor_user_id, p_organization_id, null
    ) and not exists (
      select 1
      from public.organization_role_assignments assignment
      join public.organization_role_permissions permission
        on permission.role_name = assignment.role_name
       and permission.permission = 'conversation.manage'
      where assignment.organization_id = p_organization_id
        and assignment.user_id = p_actor_user_id
        and assignment.revoked_at is null
        and (assignment.expires_at is null or assignment.expires_at > now())
    ) then
    raise exception 'group creation is not permitted' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', candidate.user_id,
    'display_name', candidate.display_name,
      'username', candidate.username,
    'avatar_path', candidate.avatar_path,
    'job_title', candidate.job_title,
    'membership_role', candidate.membership_role,
    'membership_type', candidate.membership_type,
    'access_expires_at', candidate.access_expires_at
  ) order by candidate.display_name, candidate.user_id), '[]'::jsonb)
  into v_candidates
  from (
    select membership.user_id, profile.display_name, profile.username::text as username, profile.avatar_path,
      membership.job_title, membership.role as membership_role,
      membership.membership_type, membership.access_expires_at
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id <> p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and private.can_view_org_member_for_actor(
        p_organization_id, p_actor_user_id, membership.user_id, now()
      )
      and private.group_member_candidate_permitted(
        p_organization_id, p_actor_user_id, membership.user_id
      )
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or private.normalize_search_text(profile.display_name) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'
        or private.normalize_search_text(coalesce(membership.job_title, '')) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'

        or lower(profile.username::text) like
          '%' || ltrim(lower(btrim(p_query)), '@') || '%'
      )
    order by profile.display_name, membership.user_id
    limit p_limit
  ) candidate;
  return jsonb_build_object('candidates', v_candidates, 'limit', p_limit);
end;
$function$
;
