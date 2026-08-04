-- Preserve the fixed control policy for direct, announcement, shift, and
-- incident conversations while repairing creation paths that predate the
-- control columns. The application data plane remains RPC-only.

create or replace function private.create_direct_conversation(
  p_organization_id uuid,
  p_other_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_low_user_id uuid;
  v_high_user_id uuid;
  v_conversation_id uuid;
begin
  if v_user_id is null or v_user_id = p_other_user_id then
    raise exception 'a different signed-in member is required' using errcode = '22023';
  end if;
  if not (select private.is_org_member(p_organization_id))
    or not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = p_other_user_id
        and membership.status = 'active'
    ) then
    raise exception 'both users must be active organization members' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
  ) then
    raise exception 'direct messages are disabled for this organization' using errcode = '42501';
  end if;
  if not private.direct_pair_policy_permitted(
    p_organization_id, v_user_id, p_other_user_id
  ) then
    raise exception 'direct conversation is not permitted by organization policy' using errcode = '42501';
  end if;

  v_low_user_id := least(v_user_id, p_other_user_id);
  v_high_user_id := greatest(v_user_id, p_other_user_id);

  select pair.conversation_id into v_conversation_id
  from public.direct_conversation_pairs pair
  where pair.organization_id = p_organization_id
    and pair.member_low_user_id = v_low_user_id
    and pair.member_high_user_id = v_high_user_id;

  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  if not (select private.consume_rate_limit(
    'create-direct-hour',
    p_organization_id::text || ':' || v_user_id::text,
    10,
    3600
  )) then
    raise exception 'direct-conversation rate limit exceeded' using errcode = 'P0001';
  end if;

  v_conversation_id := gen_random_uuid();

  insert into public.conversations (
    id,
    organization_id,
    kind,
    visibility,
    history_policy,
    member_limit,
    posting_mode,
    join_policy,
    created_by_user_id
  ) values (
    v_conversation_id,
    p_organization_id,
    'direct',
    'invite_only',
    'all',
    2,
    'all_members',
    'invite_only',
    v_user_id
  );

  insert into public.direct_conversation_pairs (
    organization_id,
    conversation_id,
    member_low_user_id,
    member_high_user_id
  ) values (
    p_organization_id,
    v_conversation_id,
    v_low_user_id,
    v_high_user_id
  );

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id
  ) values
    (p_organization_id, v_conversation_id, v_user_id, 'member', v_user_id);

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id
  ) values
    (p_organization_id, v_conversation_id, p_other_user_id, 'member', v_user_id);

  return v_conversation_id;
exception when unique_violation then
  select pair.conversation_id into v_conversation_id
  from public.direct_conversation_pairs pair
  where pair.organization_id = p_organization_id
    and pair.member_low_user_id = v_low_user_id
    and pair.member_high_user_id = v_high_user_id;
  if v_conversation_id is null then
    raise;
  end if;
  return v_conversation_id;
end;
$$;

create or replace function private.create_group_conversation(
  p_organization_id uuid,
  p_name text,
  p_member_user_ids uuid[] default array[]::uuid[],
  p_kind text default 'group',
  p_unit_id uuid default null,
  p_history_policy text default 'since_join',
  p_incident_severity text default null,
  p_incident_classification text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_conversation_id uuid;
  v_member_count integer;
begin
  if v_user_id is null or not (select private.is_org_member(p_organization_id)) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_kind not in ('group', 'team', 'shift', 'announcement', 'incident') then
    raise exception 'unsupported group conversation kind' using errcode = '22023';
  end if;
  if p_kind in ('announcement', 'incident')
    and not (select private.is_org_admin(p_organization_id)) then
    raise exception 'organization administrator permission required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 160 then
    raise exception 'conversation name is required' using errcode = '22023';
  end if;
  if p_history_policy not in ('all', 'since_join')
    or ((p_kind = 'incident') is distinct from (
      p_incident_severity in ('low', 'medium', 'high', 'critical')
      and char_length(btrim(coalesce(p_incident_classification, ''))) between 1 and 120
    )) then
    raise exception 'invalid conversation history or incident policy' using errcode = '22023';
  end if;
  if not (select private.consume_rate_limit(
    'create-group-day',
    p_organization_id::text || ':' || v_user_id::text,
    5,
    86400
  )) then
    raise exception 'group-conversation rate limit exceeded' using errcode = 'P0001';
  end if;

  select count(distinct member_id) into v_member_count
  from unnest(array_append(coalesce(p_member_user_ids, array[]::uuid[]), v_user_id)) member_id;
  if v_member_count > 500 then
    raise exception 'initial conversation membership exceeds 500' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_member_user_ids, array[]::uuid[])) requested_user_id
    where not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = requested_user_id
        and membership.status = 'active'
    )
  ) then
    raise exception 'all conversation members must be active organization members' using errcode = '23514';
  end if;

  v_conversation_id := gen_random_uuid();

  insert into public.conversations (
    id,
    organization_id,
    kind,
    name,
    visibility,
    unit_id,
    history_policy,
    incident_severity,
    incident_classification,
    member_limit,
    posting_mode,
    join_policy,
    created_by_user_id
  ) values (
    v_conversation_id,
    p_organization_id,
    p_kind,
    btrim(p_name),
    case when p_unit_id is null then 'invite_only' else 'unit' end,
    p_unit_id,
    p_history_policy,
    p_incident_severity,
    case when p_incident_classification is null then null else btrim(p_incident_classification) end,
    case when p_kind = 'announcement' then 5000 else 500 end,
    case when p_kind = 'announcement' then 'admins_only' else 'all_members' end,
    case when p_kind in ('group', 'team') then 'inherit' else 'invite_only' end,
    v_user_id
  );

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id,
    v_conversation_id,
    v_user_id,
    'owner',
    v_user_id,
    case when p_history_policy = 'since_join' then now() else null end
  );

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id,
    history_visible_from
  )
  select
    p_organization_id,
    v_conversation_id,
    member_id,
    'member',
    v_user_id,
    case when p_history_policy = 'since_join' then now() else null end
  from (
    select distinct member_id
    from unnest(coalesce(p_member_user_ids, array[]::uuid[])) member_id
    where member_id <> v_user_id
  ) members;

  return v_conversation_id;
end;
$$;

-- The function is shared by four source tables. Compare row images as JSONB so
-- an UPDATE never resolves fields that do not exist on the triggering table.
-- Ignore only the housekeeping timestamp touched by a separate BEFORE trigger.
create or replace function private.mark_dynamic_group_user_source_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := case when tg_op = 'DELETE'
    then old.organization_id else new.organization_id end;
  v_user_id uuid := case when tg_op = 'DELETE'
    then old.user_id else new.user_id end;
begin
  if tg_op = 'UPDATE'
    and (to_jsonb(old) - 'updated_at')
      is not distinct from (to_jsonb(new) - 'updated_at') then
    return new;
  end if;
  perform private.enqueue_dynamic_group_user_source_change_internal(
    v_organization_id, v_user_id,
    left(tg_table_name || '.' || lower(tg_op), 120),
    statement_timestamp()
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
