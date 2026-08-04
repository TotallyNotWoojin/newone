-- Conversation departure is deliberately narrower than member removal.
-- Only ordinary, invite-only groups can be left voluntarily. Mandatory and
-- policy-managed audiences remain controlled by their authoritative workflow.

-- Serialize message commit against self-departure on the sender's membership
-- row. A send that owns this lock commits before departure; a send arriving
-- after departure wakes, rechecks the active predicate, and is rejected.
create or replace function private.validate_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is null and v_jwt_role <> 'service_role' then
    raise exception 'signed-in user required' using errcode = '42501';
  end if;
  if v_actor_id is not null then
    if new.sender_user_id <> v_actor_id then
      raise exception 'message sender must match signed-in user' using errcode = '42501';
    end if;
    perform member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = new.organization_id
      and member.conversation_id = new.conversation_id
      and member.user_id = v_actor_id
      and member.status = 'active'
      and member.can_post
    for share of member;
    if not found then
      raise exception 'active conversation membership with posting access is required'
        using errcode = '42501';
    end if;
  end if;
  if v_jwt_role <> 'service_role' and new.kind = 'system' then
    raise exception 'system messages require a service workflow' using errcode = '42501';
  end if;
  if new.edited_at is not null
    or new.deleted_at is not null
    or new.deleted_by_user_id is not null
    or new.deletion_reason is not null then
    raise exception 'new messages cannot be edited or deleted' using errcode = '22000';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create or replace function private.conversation_departure_options_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_visibility text;
  v_role text;
  v_restriction text;
  v_active_owner_count integer;
  v_policy_managed boolean;
begin
  select conversation.kind, conversation.visibility, member.role,
    exists (
      select 1
      from public.dynamic_group_policies policy
      where policy.organization_id = conversation.organization_id
        and policy.conversation_id = conversation.id
    ) or member.managed_by_policy_id is not null
    into v_kind, v_visibility, v_role, v_policy_managed
  from public.conversations conversation
  join public.conversation_members member
    on member.organization_id = conversation.organization_id
   and member.conversation_id = conversation.id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;

  -- A missing row is intentionally indistinguishable from an unauthorized row.
  if not found then
    return null;
  end if;

  v_restriction := case
    when v_kind = 'direct' then 'direct_mandatory'
    when v_kind = 'announcement' then 'announcement_mandatory'
    when v_kind = 'team' then 'team_mandatory'
    when v_kind = 'shift' then 'shift_mandatory'
    when v_kind = 'incident' then 'incident_mandatory'
    when v_kind = 'group' and v_policy_managed then 'policy_managed'
    when v_kind = 'group' and v_visibility <> 'invite_only' then 'audience_mandatory'
    when v_kind = 'group' then null
    else 'mandatory_audience'
  end;

  select count(*)::integer into v_active_owner_count
  from public.conversation_members owner_member
  join public.organization_memberships owner_organization_member
    on owner_organization_member.organization_id = owner_member.organization_id
   and owner_organization_member.user_id = owner_member.user_id
   and owner_organization_member.status = 'active'
  where owner_member.organization_id = p_organization_id
    and owner_member.conversation_id = p_conversation_id
    and owner_member.status = 'active'
    and owner_member.role = 'owner';

  return jsonb_build_object(
    'eligible', v_restriction is null,
    'restriction', v_restriction,
    'requires_ownership_transfer',
      v_restriction is null and v_role = 'owner' and v_active_owner_count = 1,
    'history_preserved', true,
    'future_access_revoked', true
  );
end;
$$;

create or replace function private.broadcast_conversation_departure_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_departed_user_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
  v_recipient record;
begin
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'conversation departure invalidation requires trusted BFF context'
      using errcode = '42501';
  end if;

  -- Include the departed member once so every one of their connected clients
  -- immediately reconciles and drops the conversation. Remaining active
  -- members receive the same content-free membership hint.
  for v_recipient in
    select recipient.user_id
    from (
      select member.user_id
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.status = 'active'
      union
      select p_departed_user_id
    ) recipient
    order by recipient.user_id
  loop
    perform realtime.send(
      jsonb_build_object(
        'schema_version', 1,
        'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'organization_id', p_organization_id,
        'occurred_at', v_occurred_at,
        'conversation_id', p_conversation_id,
        'entity_type', 'membership',
        'entity_id', p_conversation_id,
        'version_id', null,
        'reason', 'member_left'
      ),
      'workspace.invalidated',
      'org:' || p_organization_id::text || ':user:'
        || v_recipient.user_id::text || ':inbox',
      true
    );
  end loop;
end;
$$;

create or replace function private.bff_leave_conversation_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_replacement_owner_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_kind text;
  v_visibility text;
  v_actor_role text;
  v_actor_managed_by_policy_id uuid;
  v_other_owner_count integer;
  v_left_at timestamptz := now();
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    'conversation.leave',
    false,
    0,
    '/v2/conversations/:id/leave',
    p_idempotency_key,
    p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then
    return v_command -> 'response';
  end if;

  -- Conversation first, then every active membership in UUID order. The same
  -- ordering is used by every invocation, so concurrent transfer/departure
  -- attempts cannot observe a partially transferred owner set.
  select conversation.kind, conversation.visibility, member.role,
    member.managed_by_policy_id
    into v_kind, v_visibility, v_actor_role, v_actor_managed_by_policy_id
  from public.conversations conversation
  join public.conversation_members member
    on member.organization_id = conversation.organization_id
   and member.conversation_id = conversation.id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  for update of conversation;

  if not found then
    raise exception 'conversation is not eligible for self-leave' using errcode = '42501';
  end if;

  perform member.user_id
  from public.conversation_members member
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.status = 'active'
  order by member.user_id
  for update;

  if v_kind <> 'group'
    or v_visibility <> 'invite_only'
    or v_actor_managed_by_policy_id is not null
    or exists (
      select 1
      from public.dynamic_group_policies policy
      where policy.organization_id = p_organization_id
        and policy.conversation_id = p_conversation_id
    ) then
    raise exception 'conversation is not eligible for self-leave' using errcode = '42501';
  end if;

  select count(*)::integer into v_other_owner_count
  from public.conversation_members owner_member
  join public.organization_memberships organization_member
    on organization_member.organization_id = owner_member.organization_id
   and organization_member.user_id = owner_member.user_id
   and organization_member.status = 'active'
  where owner_member.organization_id = p_organization_id
    and owner_member.conversation_id = p_conversation_id
    and owner_member.user_id <> p_actor_user_id
    and owner_member.status = 'active'
    and owner_member.role = 'owner';

  if v_actor_role = 'owner' and v_other_owner_count = 0 then
    if p_replacement_owner_user_id is null
      or p_replacement_owner_user_id = p_actor_user_id
      or not exists (
        select 1
        from public.conversation_members replacement
        join public.organization_memberships replacement_organization_member
          on replacement_organization_member.organization_id = replacement.organization_id
         and replacement_organization_member.user_id = replacement.user_id
         and replacement_organization_member.status = 'active'
        where replacement.organization_id = p_organization_id
          and replacement.conversation_id = p_conversation_id
          and replacement.user_id = p_replacement_owner_user_id
          and replacement.status = 'active'
      ) then
      raise exception 'an active replacement owner is required' using errcode = '42501';
    end if;

    update public.conversation_members replacement
    set role = 'owner'
    where replacement.organization_id = p_organization_id
      and replacement.conversation_id = p_conversation_id
      and replacement.user_id = p_replacement_owner_user_id
      and replacement.status = 'active';
  elsif p_replacement_owner_user_id is not null then
    -- Reject ambiguous intent instead of silently promoting an unnecessary
    -- owner or using the replacement field as a membership oracle.
    raise exception 'replacement owner is not accepted for this departure'
      using errcode = '42501';
  end if;

  update public.conversation_members departing
  set status = 'left', left_at = v_left_at
  where departing.organization_id = p_organization_id
    and departing.conversation_id = p_conversation_id
    and departing.user_id = p_actor_user_id
    and departing.status = 'active';
  if not found then
    raise exception 'conversation is not eligible for self-leave' using errcode = '42501';
  end if;

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    event_type,
    target_type,
    target_id,
    metadata
  ) values (
    p_organization_id,
    p_actor_user_id,
    'conversation.member.left',
    'conversation',
    p_conversation_id::text,
    jsonb_build_object(
      'history_preserved', true,
      'future_access_revoked', true,
      'ownership_transferred',
        v_actor_role = 'owner' and v_other_owner_count = 0
    )
  );

  perform private.broadcast_conversation_departure_internal(
    p_organization_id,
    p_conversation_id,
    p_actor_user_id
  );

  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'left', true,
    'role_at_departure', v_actor_role,
    'ownership_transferred',
      v_actor_role = 'owner' and v_other_owner_count = 0,
    'history_preserved', true,
    'future_access_revoked', true,
    'left_at', v_left_at
  );

  return private.finish_bff_command_internal(
    p_actor_user_id,
    p_organization_id,
    '/v2/conversations/:id/leave',
    p_idempotency_key,
    p_request_sha256,
    v_response
  );
end;
$$;

create or replace function public.bff_leave_conversation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_replacement_owner_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_leave_conversation_impl(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_conversation_id,
    p_replacement_owner_user_id,
    p_idempotency_key,
    p_request_sha256
  )
$$;

-- Preserve the translation-enriched v4 bootstrap and enrich only conversations
-- the caller is already authorized to read.
create or replace function private.bff_bootstrap_messaging_state_v5_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_conversations jsonb;
begin
  v_base := private.bff_bootstrap_messaging_state_v4_impl(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_selected_conversation_id,
    p_before_message_id,
    p_conversation_limit,
    p_timeline_limit
  );

  select coalesce(jsonb_agg(
    item.value || jsonb_build_object(
      'departure', private.conversation_departure_options_internal(
        p_actor_user_id,
        p_organization_id,
        (item.value ->> 'conversation_id')::uuid
      )
    ) order by item.ordinality
  ), '[]'::jsonb)
  into v_conversations
  from jsonb_array_elements(coalesce(v_base -> 'conversations', '[]'::jsonb))
    with ordinality as item(value, ordinality);

  return jsonb_set(v_base, '{conversations}', v_conversations, true);
end;
$$;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid default null,
  p_before_message_id bigint default null,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_bootstrap_messaging_state_v5_impl(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_selected_conversation_id,
    p_before_message_id,
    p_conversation_limit,
    p_timeline_limit
  )
$$;

revoke execute on function
  private.conversation_departure_options_internal(uuid, uuid, uuid),
  private.broadcast_conversation_departure_internal(uuid, uuid, uuid),
  private.bff_leave_conversation_impl(uuid, uuid, uuid, uuid, uuid, text, text),
  private.bff_bootstrap_messaging_state_v5_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
from public, anon, authenticated, service_role;

grant execute on function
  private.bff_leave_conversation_impl(uuid, uuid, uuid, uuid, uuid, text, text),
  private.bff_bootstrap_messaging_state_v5_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
to service_role;

revoke execute on function
  public.bff_leave_conversation(uuid, uuid, uuid, uuid, uuid, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.bff_leave_conversation(uuid, uuid, uuid, uuid, uuid, text, text)
to service_role;
