-- Every bootstrap built a directory of the entire Newone user base and then
-- threw it away. In the personal realm one organization holds every account,
-- so V8's directory query asked can_view_org_member_for_actor about all 210
-- members and built a row for each, with its units, saved-contact flag, block
-- flag and connection state - and then V10, which only ever runs in the
-- personal realm, replaced the whole array with the people the reader actually
-- shares a connection or a conversation with. Three of them.
--
-- Measured on the live stack: V8 720ms and 147KB, V10 83KB. The cost grew with
-- the number of people who have ever signed up, on every chat opened, every
-- message sent and every message received.

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v8_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_directory jsonb;
  v_connections jsonb;
  v_saved_contacts jsonb;
  v_member_blocks jsonb;
  v_viewer_type text;
  v_viewer_expiry timestamptz;
  v_viewer_sponsor uuid;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v7_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  select membership.membership_type, membership.access_expires_at,
      membership.guest_sponsor_user_id
    into v_viewer_type, v_viewer_expiry, v_viewer_sponsor
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );
  if not found then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  -- In the personal realm every account is a member of the one organization,
  -- so this asks can_view_org_member_for_actor about every user of the app and
  -- builds a full row for each - and then V10 discards the answer and rebuilds
  -- the directory from the people this reader actually has a connection or a
  -- conversation with. Measured on the live stack: 210 people built here, 3
  -- kept, and the cost grew with the size of the whole user base. Skip it and
  -- let V10 be the one that answers.
  if p_organization_id = private.personal_realm_organization_id() then
    v_directory := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'user_id', visible.user_id,
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
      select membership.user_id, profile.display_name, profile.avatar_path,
        profile.status_message, profile.preferred_language, profile.time_zone,
        membership.role as membership_role,
        membership.membership_type, membership.status as membership_status,
        membership.access_expires_at, membership.job_title,
        membership.directory_visibility,
        case when v_viewer_type = 'guest' and membership.user_id <> p_actor_user_id
          then '[]'::jsonb else (
            select coalesce(jsonb_agg(unit_member.unit_id order by unit_member.unit_id),
              '[]'::jsonb)
            from public.organization_unit_members unit_member
            where unit_member.organization_id = membership.organization_id
              and unit_member.user_id = membership.user_id
          ) end as unit_ids,
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
      from public.organization_memberships membership
      join public.profiles profile on profile.user_id = membership.user_id
      where membership.organization_id = p_organization_id
        and private.can_view_org_member_for_actor(
          p_organization_id, p_actor_user_id, membership.user_id, now()
        )
      order by profile.display_name, membership.user_id
      limit 500
    ) visible;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'counterpart_user_id', visible.counterpart_user_id,
    'status', visible.status,
    'requested_by_user_id', visible.requested_by_user_id,
    'created_at', visible.created_at,
    'responded_at', visible.responded_at,
    'updated_at', visible.updated_at
  ) order by visible.updated_at desc, visible.counterpart_user_id), '[]'::jsonb)
  into v_connections
  from (
    select case when connection.member_low_user_id = p_actor_user_id
        then connection.member_high_user_id else connection.member_low_user_id end
        as counterpart_user_id,
      connection.status, connection.requested_by_user_id,
      connection.created_at, connection.responded_at, connection.updated_at
    from public.contact_connections connection
    where connection.organization_id = p_organization_id
      and p_actor_user_id in (
        connection.member_low_user_id, connection.member_high_user_id
      )
      and private.can_view_org_member_for_actor(
        p_organization_id, p_actor_user_id,
        case when connection.member_low_user_id = p_actor_user_id
          then connection.member_high_user_id else connection.member_low_user_id end,
        now()
      )
    order by connection.updated_at desc
    limit 500
  ) visible;

  select coalesce(jsonb_agg(jsonb_build_object(
    'contact_user_id', contact.contact_user_id,
    'alias', contact.alias,
    'is_favorite', contact.is_favorite,
    'updated_at', contact.updated_at
  ) order by contact.is_favorite desc, contact.updated_at desc,
      contact.contact_user_id), '[]'::jsonb)
  into v_saved_contacts
  from public.saved_contacts contact
  where contact.organization_id = p_organization_id
    and contact.owner_user_id = p_actor_user_id
    and private.can_view_org_member_for_actor(
      p_organization_id, p_actor_user_id, contact.contact_user_id, now()
    );

  select coalesce(jsonb_agg(jsonb_build_object(
    'blocked_user_id', block.blocked_user_id,
    'blocked_at', block.created_at
  ) order by block.created_at desc, block.blocked_user_id), '[]'::jsonb)
  into v_member_blocks
  from public.member_blocks block
  where block.organization_id = p_organization_id
    and block.blocker_user_id = p_actor_user_id
    and private.can_view_org_member_for_actor(
      p_organization_id, p_actor_user_id, block.blocked_user_id, now()
    );

  v_result := jsonb_set(v_result, '{directory}', v_directory, true);
  v_result := jsonb_set(v_result, '{connections}', v_connections, true);
  v_result := jsonb_set(v_result, '{saved_contacts}', v_saved_contacts, true);
  v_result := jsonb_set(v_result, '{member_blocks}', v_member_blocks, true);
  if v_viewer_type = 'guest' then
    v_result := jsonb_set(v_result, '{units}', '[]'::jsonb, true);
  end if;
  v_result := jsonb_set(
    v_result, '{current_user}',
    coalesce(v_result -> 'current_user', '{}'::jsonb) ||
      jsonb_strip_nulls(jsonb_build_object(
        'membership_type', v_viewer_type,
        'access_expires_at', v_viewer_expiry,
        'guest_sponsor_user_id', v_viewer_sponsor
      )), true
  );
  v_result := jsonb_set(
    v_result, '{organization}',
    coalesce(v_result -> 'organization', '{}'::jsonb) || coalesce((
      select jsonb_build_object(
        'group_creation_policy', organization.group_creation_policy,
        'allow_external_guests', organization.allow_external_guests,
        'external_guest_max_access_days', organization.external_guest_max_access_days,
        'shift_schedule_authoritative', organization.shift_schedule_authoritative,
        'organization_policy_version', organization.organization_policy_version
      )
      from public.organizations organization
      where organization.id = p_organization_id
    ), '{}'::jsonb), true
  );
  return v_result;
end;
$function$
;
