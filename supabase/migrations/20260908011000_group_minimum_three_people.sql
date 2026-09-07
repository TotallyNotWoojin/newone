-- A consumer group needs three people in total: the creator and at least two
-- others. Enforced at creation time only, so leaving never breaks a group that
-- is already running. Workplace realms are unchanged.
CREATE OR REPLACE FUNCTION private.bff_create_group_conversation_v2_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_name text, p_description text, p_member_assignments jsonb, p_kind text, p_unit_id uuid, p_history_policy text, p_posting_mode text, p_join_policy text, p_incident_severity text, p_incident_classification text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_organization public.organizations%rowtype;
  v_conversation_id uuid := gen_random_uuid();
  v_effective_join_policy text;
  v_visibility text;
  v_member_count integer;
  v_history_visible_from timestamptz := case
    when p_history_policy = 'since_join' then statement_timestamp() else null end;
  v_assignment record;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.group.create', p_kind = 'incident',
    case when p_kind = 'incident' then 900 else 0 end,
    '/v2/conversations/group', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  select * into v_organization
  from public.organizations organization
  where organization.id = p_organization_id
  for share;
  if not found or not private.actor_can_create_group(
    p_actor_user_id, p_organization_id, p_unit_id
  ) then
    raise exception 'group creation is not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('group', 'team', 'shift', 'incident')
    or char_length(btrim(coalesce(p_name, ''))) not between 1 and 160
    or (p_description is not null
      and char_length(btrim(p_description)) not between 1 and 2000)
    or p_history_policy is null
    or p_history_policy not in ('all', 'since_join')
    or p_posting_mode is null
    or p_posting_mode not in ('all_members', 'admins_only')
    or p_join_policy is null
    or p_join_policy not in ('inherit', 'invite_only', 'approval_required')
    or (p_kind in ('shift', 'incident') and p_join_policy <> 'invite_only')
    or (
      p_kind = 'incident' and (
        p_incident_severity is null
        or p_incident_severity not in ('low', 'medium', 'high', 'critical')
        or char_length(btrim(coalesce(p_incident_classification, '')))
          not between 1 and 120
      )
    )
    or (
      p_kind <> 'incident'
      and (p_incident_severity is not null
        or p_incident_classification is not null)
    ) then
    raise exception 'invalid group creation policy' using errcode = '22023';
  end if;
  if p_kind = 'incident' and not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'conversation.manage', p_unit_id
  ) then
    raise exception 'incident creation requires administrator permission'
      using errcode = '42501';
  end if;
  if p_unit_id is not null and not exists (
    select 1 from public.organization_units unit
    where unit.organization_id = p_organization_id
      and unit.id = p_unit_id and unit.is_active
  ) then
    raise exception 'active organization unit required' using errcode = '22023';
  end if;
  if p_unit_id is not null and not (
    exists (
      select 1 from public.organization_unit_members unit_member
      where unit_member.organization_id = p_organization_id
        and unit_member.unit_id = p_unit_id
        and unit_member.user_id = p_actor_user_id
    )
    or private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'conversation.manage', null
    )
  ) then
    raise exception 'group creator is not authorized for organization unit'
      using errcode = '42501';
  end if;

  if p_member_assignments is null
    or jsonb_typeof(p_member_assignments) <> 'array'
    or jsonb_array_length(p_member_assignments) < 1
    or jsonb_array_length(p_member_assignments) >= v_organization.default_group_member_limit
    or octet_length(p_member_assignments::text) > 262144
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or not (item.value ? 'user_id' and item.value ? 'role')
        or exists (
          select 1 from jsonb_object_keys(item.value) supplied(key)
          where supplied.key not in ('user_id', 'role')
        )
        or jsonb_typeof(item.value -> 'user_id') <> 'string'
        or jsonb_typeof(item.value -> 'role') <> 'string'
        or item.value ->> 'role' not in ('owner', 'admin', 'member')
        or coalesce(item.value ->> 'user_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      where (item.value ->> 'user_id')::uuid = p_actor_user_id
    )
    or (
      select count(*) <> count(distinct item.value ->> 'user_id')
      from jsonb_array_elements(p_member_assignments) item(value)
    ) then
    raise exception 'invalid initial group member assignments' using errcode = '22023';
  end if;

  select jsonb_array_length(p_member_assignments) + 1 into v_member_count;

  -- A group is three people or more: you and at least two others. The rule is
  -- checked only here, at creation. A group that later drops to two because
  -- somebody left keeps working exactly as it did.
  if p_organization_id = private.personal_realm_organization_id()
    and v_member_count < 3 then
    raise exception 'a group needs at least three people' using errcode = '22023';
  end if;
  if v_member_count > v_organization.default_group_member_limit
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      left join public.organization_memberships membership
        on membership.organization_id = p_organization_id
       and membership.user_id = (item.value ->> 'user_id')::uuid
      where membership.user_id is null
        or not private.organization_membership_access_current(
          p_organization_id, (item.value ->> 'user_id')::uuid, now()
        )
        or not private.can_view_org_member_for_actor(
          p_organization_id, p_actor_user_id,
          (item.value ->> 'user_id')::uuid, now()
        )
        or not private.group_member_candidate_permitted(
          p_organization_id, p_actor_user_id, (item.value ->> 'user_id')::uuid
        )
        or (membership.membership_type = 'guest' and (
          not v_organization.allow_external_guests
          or item.value ->> 'role' <> 'member'
        ))
    ) then
    raise exception 'initial group membership is not permitted' using errcode = '42501';
  end if;

  v_effective_join_policy := case when p_join_policy = 'inherit'
    then v_organization.default_group_join_policy else p_join_policy end;
  v_visibility := case
    when p_unit_id is not null then 'unit'
    when v_effective_join_policy = 'approval_required' then 'organization'
    else 'invite_only'
  end;

  insert into public.conversations (
    id, organization_id, kind, name, description, visibility, unit_id,
    history_policy, incident_severity, incident_classification,
    member_limit, posting_mode, join_policy, created_by_user_id
  ) values (
    v_conversation_id, p_organization_id, p_kind, btrim(p_name),
    case when p_description is null then null else btrim(p_description) end,
    v_visibility, p_unit_id, p_history_policy, p_incident_severity,
    case when p_incident_classification is null then null
      else btrim(p_incident_classification) end,
    v_organization.default_group_member_limit, p_posting_mode, p_join_policy,
    p_actor_user_id
  );

  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id, v_conversation_id, p_actor_user_id, 'owner',
    p_actor_user_id, v_history_visible_from
  );
  for v_assignment in
    select (item.value ->> 'user_id')::uuid as user_id,
      item.value ->> 'role' as role
    from jsonb_array_elements(p_member_assignments)
      with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    insert into public.conversation_members (
      organization_id, conversation_id, user_id, role, joined_by_user_id,
      history_visible_from
    ) values (
      p_organization_id, v_conversation_id, v_assignment.user_id,
      v_assignment.role, p_actor_user_id, v_history_visible_from
    );
  end loop;

  perform private.insert_conversation_system_event_internal(
    p_organization_id, v_conversation_id, p_actor_user_id,
    'conversation.created', null
  );
  for v_assignment in
    select (item.value ->> 'user_id')::uuid as user_id
    from jsonb_array_elements(p_member_assignments) item(value)
  loop
    perform private.insert_conversation_system_event_internal(
      p_organization_id, v_conversation_id, p_actor_user_id,
      'conversation.member.added', v_assignment.user_id
    );
  end loop;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.group.created',
    'conversation', v_conversation_id::text,
    jsonb_build_object(
      'kind', p_kind, 'member_count', v_member_count,
      'history_policy', p_history_policy, 'posting_mode', p_posting_mode,
      'join_policy', v_effective_join_policy,
      'guest_count', (
        select count(*)
        from jsonb_array_elements(p_member_assignments) item(value)
        join public.organization_memberships membership
          on membership.organization_id = p_organization_id
         and membership.user_id = (item.value ->> 'user_id')::uuid
        where membership.membership_type = 'guest'
      )
    )
  );

  v_response := jsonb_build_object(
    'conversation_id', v_conversation_id, 'kind', p_kind,
    'name', btrim(p_name),
    'description', case when p_description is null then null else btrim(p_description) end,
    'history_policy', p_history_policy,
    'history_disclosure', jsonb_build_object(
      'policy', p_history_policy, 'visible_from', v_history_visible_from,
      'label_key', case when p_history_policy = 'all'
        then 'conversation.history.all' else 'conversation.history.since_join' end
    ),
    'posting_mode', p_posting_mode,
    'join_policy', v_effective_join_policy,
    'configured_join_policy', p_join_policy,
    'visibility', v_visibility, 'member_count', v_member_count,
    'member_limit', v_organization.default_group_member_limit,
    'is_read_only', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/group',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
exception when invalid_text_representation then
  raise exception 'invalid initial group member assignments' using errcode = '22023';
end;
$function$;
