-- Make delegated conversation.manage assignments operational without widening
-- ordinary conversation membership, content, or RLS authorization. The one
-- predicate below is shared by command authorization and bootstrap projection.

begin;

-- Actor-aware equivalent of the owner/admin half of is_conversation_admin.
-- This deliberately restores the dynamic-policy eligibility check that the
-- current global helper lost in a later migration, without changing that
-- broader content/RLS predicate in this bounded migration.
create or replace function private.actor_is_current_conversation_admin(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversation_members administrator
    join public.organization_memberships actor
      on actor.organization_id = administrator.organization_id
     and actor.user_id = administrator.user_id
    where administrator.organization_id = p_organization_id
      and administrator.conversation_id = p_conversation_id
      and administrator.user_id = p_actor_user_id
      and administrator.status = 'active'
      and administrator.role in ('owner', 'admin')
      and actor.membership_type <> 'guest'
      and private.organization_membership_access_current(
        actor.organization_id, actor.user_id, now()
      )
      and (
        not private.dynamic_group_policy_conversation(
          p_organization_id, p_conversation_id
        )
        or private.dynamic_group_user_currently_eligible(
          p_organization_id, p_conversation_id, p_actor_user_id, now()
        )
      )
  )
$$;

comment on function private.actor_is_current_conversation_admin(uuid, uuid, uuid) is
  'Actor-aware owner/admin authority for management projections. Active published dynamic policies require the actor to remain currently eligible.';

create or replace function private.actor_can_manage_conversation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversations conversation
    join public.organization_memberships actor
      on actor.organization_id = conversation.organization_id
     and actor.user_id = p_actor_user_id
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind <> 'direct'
      and actor.membership_type <> 'guest'
      and private.organization_membership_access_current(
        actor.organization_id, actor.user_id, now()
      )
      and (
        private.actor_is_current_conversation_admin(
          p_actor_user_id, p_organization_id, p_conversation_id
        )
        or (
          -- Organization-wide announcements are mandatory communication
          -- surfaces, not delegated chat-administration targets. Their actual
          -- current owner/admin authority remains intact.
          not (
            conversation.kind = 'announcement'
            and conversation.unit_id is null
          )
          and private.actor_has_permission(
            p_actor_user_id,
            p_organization_id,
            'conversation.manage',
            conversation.unit_id
          )
        )
      )
  )
$$;

comment on function private.actor_can_manage_conversation(uuid, uuid, uuid) is
  'Canonical metadata/control authorization for non-direct conversations. It combines current conversation administrators with current non-guest conversation.manage assignments scoped to the conversation unit and descendants; delegated assignments never reach unscoped announcements.';

create or replace function private.actor_can_manage_dynamic_group_conversation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.conversations conversation
    join public.organization_memberships actor
      on actor.organization_id = conversation.organization_id
     and actor.user_id = p_actor_user_id
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind in ('group', 'team', 'shift')
      and conversation.unit_id is not null
      and actor.membership_type <> 'guest'
      and private.organization_membership_access_current(
        actor.organization_id, actor.user_id, now()
      )
      and private.actor_has_permission(
        p_actor_user_id,
        p_organization_id,
        'unit.manage',
        conversation.unit_id
      )
  )
$$;

comment on function private.actor_can_manage_dynamic_group_conversation(
  uuid, uuid, uuid
) is
  'Canonical dynamic-group eligibility for current non-guest unit.manage actors. Only unit-scoped group, team, and shift conversations in the exact delegated unit or its descendants qualify.';

-- Conversation control writes are still possible only through the trusted BFF
-- command. The delegated context is transaction-local and is set by that exact
-- command after the canonical helper succeeds.
create or replace function private.validate_conversation_controls_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_delegated_workflow boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(
      current_setting('app.delegated_conversation_management_context', true),
      'off'
    ) = 'on';
begin
  if new.posting_mode is distinct from old.posting_mode
    or new.join_policy is distinct from old.join_policy
    or new.visibility is distinct from old.visibility then
    if coalesce(current_setting('app.conversation_controls_context', true), 'off') <> 'on'
      or not (
        private.is_conversation_admin(old.organization_id, old.id)
        or (
          v_delegated_workflow
          and private.actor_can_manage_conversation(
            v_actor_user_id, old.organization_id, old.id
          )
        )
      ) then
      raise exception 'conversation controls require an administrator workflow'
        using errcode = '42501';
    end if;
    if old.kind not in ('group', 'team')
      or old.is_archived
      or old.closed_at is not null
      or exists (
        select 1
        from public.dynamic_group_policies policy
        where policy.organization_id = old.organization_id
          and policy.conversation_id = old.id
      ) then
      raise exception 'conversation controls are unavailable for this conversation'
        using errcode = '42501';
    end if;
    if new.visibility = 'invite_only' and new.join_policy = 'approval_required' then
      raise exception 'approval-required groups must be discoverable' using errcode = '22023';
    end if;
    if new.visibility <> 'unit' and new.unit_id is distinct from old.unit_id then
      raise exception 'conversation unit scope is not mutable here' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

-- Retain all existing membership invariants while treating a delegated manager
-- exactly like a conversation admin, never like an owner. In particular, a
-- delegate cannot add, remove, or mutate an owner and cannot change any role.
create or replace function private.validate_conversation_member_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_actor_conversation_role text;
  v_conversation_kind text;
  v_history_policy text;
  v_member_limit integer;
  v_conversation_creator uuid;
  v_existing_member_count integer;
  v_delegated_workflow boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(
      current_setting('app.delegated_conversation_management_context', true),
      'off'
    ) = 'on';
  v_delegated_manager boolean := false;
  v_offboarding boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.member_offboarding_context', true), 'off') = 'on';
  v_join_reactivation boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.conversation_join_reactivation_context', true), 'off') = 'on';
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = new.organization_id
        and membership.user_id = new.user_id
        and membership.status = 'active'
    ) then
      raise exception 'conversation members must be active organization members' using errcode = '23514';
    end if;

    select conversation.kind, conversation.member_limit, conversation.created_by_user_id
      into v_conversation_kind, v_member_limit, v_conversation_creator
    from public.conversations conversation
    where conversation.organization_id = new.organization_id
      and conversation.id = new.conversation_id;

    if v_conversation_kind = 'direct' and not exists (
      select 1 from public.direct_conversation_pairs pair
      where pair.organization_id = new.organization_id
        and pair.conversation_id = new.conversation_id
        and new.user_id in (pair.member_low_user_id, pair.member_high_user_id)
    ) then
      raise exception 'direct conversations are limited to their canonical pair' using errcode = '23514';
    end if;

    select count(*) into v_existing_member_count
    from public.conversation_members existing_member
    where existing_member.organization_id = new.organization_id
      and existing_member.conversation_id = new.conversation_id
      and existing_member.status = 'active';
    if v_existing_member_count >= v_member_limit then
      raise exception 'conversation member limit reached' using errcode = '23514';
    end if;

    if v_offboarding and v_actor_id is not null
      and new.user_id = v_actor_id and new.role = 'owner'
      and new.status = 'active' and new.left_at is null
      and v_conversation_kind in ('group', 'incident') then
      return new;
    end if;
    if v_actor_id is null and v_jwt_role = 'service_role' then return new; end if;
    if v_actor_id is null then
      raise exception 'signed-in user required' using errcode = '42501';
    end if;
    if new.status <> 'active' or new.left_at is not null then
      raise exception 'new conversation members must start active' using errcode = '22000';
    end if;
    if new.joined_by_user_id is distinct from v_actor_id then
      raise exception 'conversation join actor must match signed-in user' using errcode = '42501';
    end if;
    if v_conversation_kind = 'direct' then
      if v_actor_id <> v_conversation_creator then
        raise exception 'direct membership is created only by the conversation creator workflow' using errcode = '42501';
      end if;
      new.role := 'member';
      return new;
    end if;
    if v_existing_member_count = 0 then
      if v_actor_id <> v_conversation_creator or new.user_id <> v_actor_id or new.role <> 'owner' then
        raise exception 'the conversation creator must initialize the owner membership' using errcode = '42501';
      end if;
      return new;
    end if;
    select conversation_member.role into v_actor_conversation_role
    from public.conversation_members conversation_member
    where conversation_member.organization_id = new.organization_id
      and conversation_member.conversation_id = new.conversation_id
      and conversation_member.user_id = v_actor_id
      and conversation_member.status = 'active';
    v_delegated_manager := v_delegated_workflow
      and private.actor_can_manage_conversation(
        v_actor_id, new.organization_id, new.conversation_id
      );
    if coalesce(v_actor_conversation_role, '') not in ('owner', 'admin')
      and not v_delegated_manager then
      raise exception 'conversation administrator permission required' using errcode = '42501';
    end if;
    if v_delegated_manager
      and not private.actor_is_current_conversation_admin(
        v_actor_id, new.organization_id, new.conversation_id
      ) then
      if new.role <> 'member' then
        raise exception 'delegated managers may add conversation members only'
          using errcode = '42501';
      end if;
      if new.managed_by_policy_id is not null
        or private.dynamic_group_policy_conversation(
          new.organization_id, new.conversation_id
        ) then
        raise exception 'delegated managers cannot override policy-managed membership'
          using errcode = '42501';
      end if;
    end if;
    if new.role = 'owner' and coalesce(v_actor_conversation_role, '') <> 'owner' then
      raise exception 'only conversation owners may add another owner' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.user_id is distinct from old.user_id
    or new.joined_by_user_id is distinct from old.joined_by_user_id
    or new.joined_at is distinct from old.joined_at then
    raise exception 'conversation membership identity fields are immutable' using errcode = '22000';
  end if;

  if new.managed_by_policy_id is distinct from old.managed_by_policy_id
    and v_jwt_role <> 'service_role'
    and coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'dynamic membership provenance is server-owned' using errcode = '42501';
  end if;

  if v_offboarding and v_actor_id is not null then
    if new.user_id = v_actor_id and new.status = 'active' and new.role = 'owner'
      and new.left_at is null then return new; end if;
    if old.user_id <> v_actor_id
      and old.status = 'active' and new.status = 'removed'
      and new.role = (case when old.role = 'owner' then 'member' else old.role end)
      and new.can_post = false and new.left_at is not null
      and new.notification_level is not distinct from old.notification_level
      and new.muted_until is not distinct from old.muted_until
      and new.managed_by_policy_id is not distinct from old.managed_by_policy_id
      and new.history_visible_from is not distinct from old.history_visible_from then
      return new;
    end if;
  end if;

  if v_join_reactivation and v_actor_id is not null
    and old.user_id <> v_actor_id and old.status in ('left', 'removed')
    and new.status = 'active' and new.role = 'member' and new.can_post
    and new.left_at is null and old.managed_by_policy_id is null
    and new.managed_by_policy_id is null
    and new.notification_level is not distinct from old.notification_level
    and new.muted_until is not distinct from old.muted_until
    and exists (
      select 1 from public.organization_memberships target
      where target.organization_id = old.organization_id
        and target.user_id = old.user_id and target.status = 'active'
    ) then
    select administrator.role into v_actor_conversation_role
    from public.conversation_members administrator
    where administrator.organization_id = old.organization_id
      and administrator.conversation_id = old.conversation_id
      and administrator.user_id = v_actor_id
      and administrator.status = 'active';
    v_delegated_manager := v_delegated_workflow
      and private.actor_can_manage_conversation(
        v_actor_id, old.organization_id, old.conversation_id
      );
    select conversation.history_policy into v_history_policy
    from public.conversations conversation
    where conversation.organization_id = old.organization_id
      and conversation.id = old.conversation_id;
    if (
        coalesce(v_actor_conversation_role, '') not in ('owner', 'admin')
        and not v_delegated_manager
      )
      or (v_history_policy = 'all' and new.history_visible_from is not null)
      or (v_history_policy = 'since_join' and (
        new.history_visible_from is null
        or new.history_visible_from < statement_timestamp() - interval '5 minutes'
        or new.history_visible_from > statement_timestamp() + interval '1 minute'
      )) then
      raise exception 'approved conversation reactivation is invalid' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status <> 'active' and new.status = 'active' and v_jwt_role <> 'service_role' then
    raise exception 'left or removed members require a service workflow to rejoin' using errcode = '42501';
  end if;
  if new.status = 'active' then new.left_at := null;
  else new.left_at := coalesce(new.left_at, now()); end if;
  if v_actor_id is null and v_jwt_role = 'service_role' then return new; end if;
  if v_actor_id = old.user_id then
    if new.role is distinct from old.role
      or new.can_post is distinct from old.can_post
      or (new.status is distinct from old.status
        and not (old.status = 'active' and new.status = 'left')) then
      raise exception 'members may only change preferences or leave' using errcode = '42501';
    end if;
    return new;
  end if;

  select conversation_member.role into v_actor_conversation_role
  from public.conversation_members conversation_member
  where conversation_member.organization_id = old.organization_id
    and conversation_member.conversation_id = old.conversation_id
    and conversation_member.user_id = v_actor_id
    and conversation_member.status = 'active';
  v_delegated_manager := v_delegated_workflow
    and private.actor_can_manage_conversation(
      v_actor_id, old.organization_id, old.conversation_id
    );
  if coalesce(v_actor_conversation_role, '') not in ('owner', 'admin')
    and not v_delegated_manager then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if v_delegated_manager
    and not private.actor_is_current_conversation_admin(
      v_actor_id, old.organization_id, old.conversation_id
    )
    and (
      old.role <> 'member'
      or old.managed_by_policy_id is not null
      or private.dynamic_group_policy_conversation(
        old.organization_id, old.conversation_id
      )
    ) then
    raise exception 'delegated managers may remove ordinary non-policy members only'
      using errcode = '42501';
  end if;
  if coalesce(v_actor_conversation_role, '') <> 'owner'
    and (new.role is distinct from old.role or old.role = 'owner' or new.role = 'owner') then
    raise exception 'only conversation owners may manage owner roles' using errcode = '42501';
  end if;
  if old.role = 'owner' and old.status = 'active'
    and (new.role <> 'owner' or new.status <> 'active') then
    perform 1 from public.conversations conversation
    where conversation.organization_id = old.organization_id
      and conversation.id = old.conversation_id for update;
    if not exists (
      select 1 from public.conversation_members other_owner
      where other_owner.organization_id = old.organization_id
        and other_owner.conversation_id = old.conversation_id
        and other_owner.user_id <> old.user_id
        and other_owner.role = 'owner' and other_owner.status = 'active'
    ) then
      raise exception 'a managed conversation must retain an active owner' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.validate_conversation_join_request_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_delegated_workflow boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(
      current_setting('app.delegated_conversation_management_context', true),
      'off'
    ) = 'on';
begin
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
    or v_actor_user_id is null then
    raise exception 'join requests require a trusted BFF workflow' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.requester_user_id <> v_actor_user_id
      or new.status <> 'pending'
      or new.version <> 1
      or new.decided_at is not null
      or new.decided_by_user_id is not null
      or new.decision_reason is not null then
      raise exception 'invalid initial join request state' using errcode = '42501';
    end if;
    new.requested_at := now();
    new.updated_at := now();
    return new;
  end if;

  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.requester_user_id is distinct from old.requester_user_id
    or new.requested_at is distinct from old.requested_at
    or new.expires_at is distinct from old.expires_at
    or old.status <> 'pending'
    or new.version <> old.version + 1 then
    raise exception 'join request transition conflict' using errcode = '40001';
  end if;

  if new.status = 'cancelled' then
    if v_actor_user_id <> old.requester_user_id
      or new.decided_by_user_id <> v_actor_user_id
      or new.decision_reason is not null then
      raise exception 'join request cancellation denied' using errcode = '42501';
    end if;
  elsif new.status = 'expired' then
    if new.decided_by_user_id is not null or new.decision_reason is not null then
      raise exception 'invalid join request expiry' using errcode = '42501';
    end if;
  elsif new.status in ('approved', 'rejected') then
    if new.decided_by_user_id <> v_actor_user_id
      or not (
        private.is_conversation_admin(old.organization_id, old.conversation_id)
        or (
          v_delegated_workflow
          and private.actor_can_manage_conversation(
            v_actor_user_id, old.organization_id, old.conversation_id
          )
        )
      ) then
      raise exception 'conversation administrator permission required' using errcode = '42501';
    end if;
  else
    raise exception 'invalid join request transition' using errcode = '42501';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.bff_update_conversation_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_patch jsonb,
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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.update', false, 0, '/v2/conversations/:id',
    p_idempotency_key, p_request_sha256
  );
  if not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if p_patch ? 'avatar_path'
    and not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) then
    raise exception 'conversation avatar management requires a current conversation administrator'
      using errcode = '42501';
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if jsonb_typeof(p_patch) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(p_patch) patch_key
      where patch_key not in ('name', 'description', 'avatar_path', 'is_archived')
    )
    or (p_patch ? 'is_archived' and jsonb_typeof(p_patch -> 'is_archived') <> 'boolean') then
    raise exception 'invalid conversation patch' using errcode = '22023';
  end if;

  update public.conversations conversation
  set name = case when p_patch ? 'name' then p_patch ->> 'name' else conversation.name end,
      description = case when p_patch ? 'description' then p_patch ->> 'description' else conversation.description end,
      avatar_path = case when p_patch ? 'avatar_path' then p_patch ->> 'avatar_path' else conversation.avatar_path end,
      is_archived = case when p_patch ? 'is_archived' then (p_patch ->> 'is_archived')::boolean else conversation.is_archived end
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    -- Re-evaluate current authority in the mutation statement so a revocation
    -- committed after the initial/replay gate cannot authorize this write.
    and private.actor_can_manage_conversation(
      p_actor_user_id, p_organization_id, conversation.id
    )
    and (
      not (p_patch ? 'avatar_path')
      or private.actor_is_current_conversation_admin(
        p_actor_user_id, p_organization_id, conversation.id
      )
    );
  if not found then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;

  v_response := jsonb_build_object('conversation_id', p_conversation_id, 'updated', true);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_add_conversation_member_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_target_user_id uuid,
  p_role text,
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
  v_history_policy text;
  v_history_visible_from timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.add', false, 0, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256
  );
  if not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;
  if p_target_user_id = p_actor_user_id
    and not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) then
    raise exception 'delegated managers cannot add themselves to conversations'
      using errcode = '42501';
  end if;
  -- Serialize member-limit validation with join approval and concurrent adds.
  -- The locked row also makes kind/lifecycle and dynamic-policy checks below
  -- describe one authoritative conversation state.
  perform 1
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift', 'incident')
    and not conversation.is_archived
    and conversation.closed_at is null
  for update;
  if not found then
    raise exception 'open named group required' using errcode = '42501';
  end if;
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) and private.dynamic_group_policy_conversation(
      p_organization_id, p_conversation_id
    ) then
    raise exception 'delegated managers cannot override policy-managed membership'
      using errcode = '42501';
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_role is null or p_role not in ('owner', 'admin', 'member') then
    raise exception 'invalid conversation role' using errcode = '22023';
  end if;
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    )
    and p_role <> 'member' then
    raise exception 'delegated managers may add conversation members only'
      using errcode = '42501';
  end if;
  if not private.organization_membership_access_current(
    p_organization_id, p_target_user_id, now()
  ) or not private.can_view_org_member_for_actor(
    p_organization_id, p_actor_user_id, p_target_user_id, now()
  ) then
    raise exception 'current organization member required' using errcode = '42501';
  end if;
  perform set_config('app.delegated_conversation_management_context', 'on', true);
  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id, p_conversation_id, p_target_user_id, p_role,
    p_actor_user_id,
    case when exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.history_policy = 'since_join'
    ) then now() else null end
  );
  perform set_config('app.delegated_conversation_management_context', 'off', true);
  select conversation.history_policy, membership.history_visible_from
    into v_history_policy, v_history_visible_from
  from public.conversations conversation
  join public.conversation_members membership
    on membership.organization_id = conversation.organization_id
   and membership.conversation_id = conversation.id
   and membership.user_id = p_target_user_id
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  if exists (
    select 1 from public.conversation_members actor_member
    where actor_member.organization_id = p_organization_id
      and actor_member.conversation_id = p_conversation_id
      and actor_member.user_id = p_actor_user_id
      and actor_member.status = 'active'
  ) then
    perform private.insert_conversation_system_event_internal(
      p_organization_id, p_conversation_id, p_actor_user_id,
      'conversation.member.added', p_target_user_id
    );
  end if;
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, p_target_user_id, 'member_added'
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'role', p_role,
    'history_policy', v_history_policy,
    'history_visible_from', v_history_visible_from,
    'history_disclosure', jsonb_build_object(
      'policy', v_history_policy,
      'visible_from', v_history_visible_from,
      'label_key', case when v_history_policy = 'all'
        then 'conversation.history.all' else 'conversation.history.since_join' end
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_remove_conversation_member_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_target_user_id uuid,
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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.remove', false, 0,
    '/v2/conversations/:id/members/:membershipId',
    p_idempotency_key, p_request_sha256
  );
  if not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  -- Delegated removal is roster management for named operational groups. It
  -- never edits mandatory announcement membership.
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    )
    and not exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.kind in ('group', 'team', 'shift', 'incident')
  ) then
    raise exception 'conversation membership is policy managed' using errcode = '42501';
  end if;
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) and not exists (
      select 1
      from public.conversation_members target
      where target.organization_id = p_organization_id
        and target.conversation_id = p_conversation_id
        and target.user_id = p_target_user_id
        and target.status = 'active'
        and target.role = 'member'
        and target.managed_by_policy_id is null
        and not private.dynamic_group_policy_conversation(
          target.organization_id, target.conversation_id
        )
    ) then
    raise exception 'delegated managers may remove ordinary non-policy members only'
      using errcode = '42501';
  end if;

  perform set_config('app.delegated_conversation_management_context', 'on', true);
  update public.conversation_members membership
  set status = 'removed', left_at = now()
  where membership.organization_id = p_organization_id
    and membership.conversation_id = p_conversation_id
    and membership.user_id = p_target_user_id
    and membership.status = 'active'
    and (
      private.actor_is_current_conversation_admin(
        p_actor_user_id, p_organization_id, p_conversation_id
      )
      or (
        membership.role = 'member'
        and membership.managed_by_policy_id is null
        and not private.dynamic_group_policy_conversation(
          membership.organization_id, membership.conversation_id
        )
      )
    );
  if not found then
    raise exception 'active conversation member not found' using errcode = 'P0002';
  end if;
  perform set_config('app.delegated_conversation_management_context', 'off', true);
  if exists (
    select 1 from public.conversation_members actor_member
    where actor_member.organization_id = p_organization_id
      and actor_member.conversation_id = p_conversation_id
      and actor_member.user_id = p_actor_user_id
      and actor_member.status = 'active'
  ) then
    perform private.insert_conversation_system_event_internal(
      p_organization_id, p_conversation_id, p_actor_user_id,
      'conversation.member.removed', p_target_user_id
    );
  end if;
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, p_target_user_id, 'member_removed'
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'removed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversations/:id/members/:membershipId',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_update_conversation_controls_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_posting_mode text,
  p_join_policy text,
  p_visibility text,
  p_reason text,
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
  v_old public.conversations%rowtype;
  v_new public.conversations%rowtype;
  v_old_effective_join_policy text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.controls.update', true, 300,
    '/v2/conversations/:id/controls', p_idempotency_key, p_request_sha256
  );
  if not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation controls are unavailable' using errcode = '42501';
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500
    or (p_posting_mode is null and p_join_policy is null and p_visibility is null) then
    raise exception 'valid conversation controls and reason required' using errcode = '22023';
  end if;

  select conversation.* into v_old
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  for update;
  if not found then
    raise exception 'conversation controls are unavailable' using errcode = '42501';
  end if;
  select case when v_old.visibility = 'invite_only' then 'invite_only'
    when v_old.join_policy = 'inherit' then organization.default_group_join_policy
    else v_old.join_policy end
    into v_old_effective_join_policy
  from public.organizations organization where organization.id = p_organization_id;
  if not private.consume_rate_limit(
    'conversation-controls-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    30, 3600
  ) then
    raise exception 'conversation control update limit exceeded' using errcode = 'P0001';
  end if;

  perform set_config('app.delegated_conversation_management_context', 'on', true);
  perform set_config('app.conversation_controls_context', 'on', true);
  update public.conversations conversation
  set posting_mode = coalesce(p_posting_mode, conversation.posting_mode),
      join_policy = coalesce(p_join_policy, conversation.join_policy),
      visibility = coalesce(p_visibility, conversation.visibility)
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  returning conversation.* into v_new;
  perform set_config('app.conversation_controls_context', 'off', true);
  perform set_config('app.delegated_conversation_management_context', 'off', true);

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id,
    'conversation.controls.updated', 'conversation', p_conversation_id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'before', jsonb_build_object(
        'posting_mode', v_old.posting_mode,
        'configured_join_policy', v_old.join_policy,
        'join_policy', v_old_effective_join_policy,
        'visibility', v_old.visibility
      ),
      'after', jsonb_build_object(
        'posting_mode', v_new.posting_mode,
        'configured_join_policy', v_new.join_policy,
        'join_policy', private.effective_conversation_join_policy(
          p_organization_id, p_conversation_id
        ),
        'visibility', v_new.visibility
      )
    )
  );

  if v_new.posting_mode is distinct from v_old.posting_mode and exists (
    select 1 from public.conversation_members actor_member
    where actor_member.organization_id = p_organization_id
      and actor_member.conversation_id = p_conversation_id
      and actor_member.user_id = p_actor_user_id
      and actor_member.status = 'active'
  ) then
    perform private.insert_conversation_system_event_internal(
      p_organization_id, p_conversation_id, p_actor_user_id,
      case when v_new.posting_mode = 'admins_only'
        then 'conversation.posting.admins_only'
        else 'conversation.posting.all_members' end,
      null
    );
  end if;
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, null, 'conversation_controls_changed'
  );

  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'posting_mode', v_new.posting_mode,
    'join_policy', private.effective_conversation_join_policy(
      p_organization_id, p_conversation_id
    ),
    'configured_join_policy', v_new.join_policy,
    'visibility', v_new.visibility
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/controls',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_decide_conversation_join_request_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_decision text,
  p_reason text,
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
  v_conversation public.conversations%rowtype;
  v_request public.conversation_join_requests%rowtype;
  v_history_visible_from timestamptz;
  v_active_member_count integer;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.join.decide', true, 300,
    '/v2/conversation-join-requests/:id/decision', p_idempotency_key, p_request_sha256
  );
  select request.* into v_request
  from public.conversation_join_requests request
  where request.organization_id = p_organization_id and request.id = p_request_id;
  if not found or not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, v_request.conversation_id
  ) then
    raise exception 'conversation join request unavailable' using errcode = '42501';
  end if;
  if v_request.requester_user_id = p_actor_user_id then
    raise exception 'conversation administrators cannot decide their own join request'
      using errcode = '42501';
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version < 1 or p_decision not in ('approved', 'rejected')
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'valid join decision, version, and reason required' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'conversation-join-decision-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    60, 3600
  ) then
    raise exception 'join decision limit exceeded' using errcode = 'P0001';
  end if;

  select request.* into v_request
  from public.conversation_join_requests request
  where request.organization_id = p_organization_id and request.id = p_request_id;
  if not found then
    raise exception 'conversation join request unavailable' using errcode = '42501';
  end if;
  select conversation.* into v_conversation
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = v_request.conversation_id
  for update;
  if not found or not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, v_request.conversation_id
  ) then
    raise exception 'conversation join request unavailable' using errcode = '42501';
  end if;
  if p_decision = 'approved' then
    perform 1 from public.organization_memberships requester_membership
    where requester_membership.organization_id = p_organization_id
      and requester_membership.user_id = v_request.requester_user_id
      and requester_membership.status = 'active'
    for share;
    if not found then
      raise exception 'conversation join request unavailable' using errcode = '42501';
    end if;
  end if;
  select request.* into v_request
  from public.conversation_join_requests request
  where request.organization_id = p_organization_id and request.id = p_request_id
  for update;
  if v_request.status <> 'pending' or v_request.version <> p_expected_version then
    raise exception 'conversation join request conflict' using errcode = '40001';
  end if;

  perform set_config('app.delegated_conversation_management_context', 'on', true);
  if v_request.expires_at <= clock_timestamp() then
    update public.conversation_join_requests request
    set status = 'expired', version = request.version + 1, decided_at = now()
    where request.organization_id = p_organization_id and request.id = p_request_id
    returning request.* into v_request;
    perform set_config('app.delegated_conversation_management_context', 'off', true);
    v_response := jsonb_build_object(
      'request_id', v_request.id, 'conversation_id', v_request.conversation_id,
      'requester_user_id', v_request.requester_user_id,
      'status', v_request.status, 'version', v_request.version,
      'requested_at', v_request.requested_at, 'expires_at', v_request.expires_at,
      'decided_at', v_request.decided_at
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id,
      '/v2/conversation-join-requests/:id/decision',
      p_idempotency_key, p_request_sha256, v_response
    );
  end if;

  if p_decision = 'approved' and not private.conversation_join_request_eligible(
    v_request.requester_user_id, p_organization_id, v_request.conversation_id
  ) then
    raise exception 'conversation join request unavailable' using errcode = '42501';
  end if;

  if p_decision = 'approved' then
    select count(*)::integer into v_active_member_count
    from public.conversation_members member
    where member.organization_id = p_organization_id
      and member.conversation_id = v_request.conversation_id
      and member.status = 'active';
    if v_active_member_count >= v_conversation.member_limit then
      raise exception 'conversation member limit reached' using errcode = '23514';
    end if;
    v_history_visible_from := case when v_conversation.history_policy = 'since_join'
      then now() else null end;

    if exists (
      select 1 from public.conversation_members member
      where member.organization_id = p_organization_id
        and member.conversation_id = v_request.conversation_id
        and member.user_id = v_request.requester_user_id
    ) then
      perform set_config('app.conversation_join_reactivation_context', 'on', true);
      update public.conversation_members member
      set status = 'active', role = 'member', can_post = true, left_at = null,
          history_visible_from = v_history_visible_from
      where member.organization_id = p_organization_id
        and member.conversation_id = v_request.conversation_id
        and member.user_id = v_request.requester_user_id
        and member.status in ('left', 'removed');
      if not found then
        raise exception 'conversation join request conflict' using errcode = '40001';
      end if;
      perform set_config('app.conversation_join_reactivation_context', 'off', true);
    else
      insert into public.conversation_members (
        organization_id, conversation_id, user_id, role, can_post,
        joined_by_user_id, history_visible_from
      ) values (
        p_organization_id, v_request.conversation_id, v_request.requester_user_id,
        'member', true, p_actor_user_id, v_history_visible_from
      );
    end if;
  end if;

  update public.conversation_join_requests request
  set status = p_decision, version = request.version + 1,
      decided_at = now(), decided_by_user_id = p_actor_user_id,
      decision_reason = btrim(p_reason)
  where request.organization_id = p_organization_id and request.id = p_request_id
  returning request.* into v_request;
  perform set_config('app.delegated_conversation_management_context', 'off', true);

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id,
    'conversation.join.' || p_decision, 'conversation', v_request.conversation_id::text,
    jsonb_build_object(
      'request_id', v_request.id,
      'requester_user_id', v_request.requester_user_id,
      'reason', btrim(p_reason),
      'history_visible_from', v_history_visible_from
    )
  );
  if p_decision = 'approved' and exists (
    select 1 from public.conversation_members actor_member
    where actor_member.organization_id = p_organization_id
      and actor_member.conversation_id = v_request.conversation_id
      and actor_member.user_id = p_actor_user_id
      and actor_member.status = 'active'
  ) then
    perform private.insert_conversation_system_event_internal(
      p_organization_id, v_request.conversation_id, p_actor_user_id,
      'conversation.join.approved', v_request.requester_user_id
    );
  end if;
  perform private.broadcast_conversation_control_internal(
    p_organization_id, v_request.conversation_id, v_request.requester_user_id,
    case when p_decision = 'approved' then 'join_approved' else 'join_rejected' end
  );

  v_response := jsonb_build_object(
    'request_id', v_request.id,
    'conversation_id', v_request.conversation_id,
    'requester_user_id', v_request.requester_user_id,
    'status', v_request.status,
    'version', v_request.version,
    'requested_at', v_request.requested_at,
    'expires_at', v_request.expires_at,
    'decided_at', v_request.decided_at,
    'history_disclosure', case when p_decision = 'approved' then jsonb_build_object(
      'policy', v_conversation.history_policy,
      'visible_from', v_history_visible_from,
      'label_key', case when v_conversation.history_policy = 'all'
        then 'conversation.history.all' else 'conversation.history.since_join' end
    ) else null end
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversation-join-requests/:id/decision',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_list_conversation_join_requests_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.join_requests.read', true, 300
  );
  if p_limit not between 1 and 200 then
    raise exception 'invalid join request limit' using errcode = '22023';
  end if;
  if not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation join requests unavailable' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row.payload order by row.requested_at, row.request_id), '[]'::jsonb)
    into v_items
  from (
    select request.id as request_id, request.requested_at,
      jsonb_build_object(
        'request_id', request.id,
        'conversation_id', request.conversation_id,
        'requester_user_id', request.requester_user_id,
        'requester_display_name', profile.display_name,
        'requester_avatar_path', profile.avatar_path,
        'status', case when request.status = 'pending' and request.expires_at <= clock_timestamp()
          then 'expired' else request.status end,
        'version', request.version,
        'requested_at', request.requested_at,
        'expires_at', request.expires_at
      ) as payload
    from public.conversation_join_requests request
    join public.organization_memberships requester
      on requester.organization_id = request.organization_id
     and requester.user_id = request.requester_user_id
     and requester.status = 'active'
     and private.organization_membership_access_current(
       requester.organization_id, requester.user_id, now()
     )
    join public.profiles profile on profile.user_id = request.requester_user_id
    where request.organization_id = p_organization_id
      and request.conversation_id = p_conversation_id
      and request.requester_user_id <> p_actor_user_id
      and private.conversation_join_request_eligible(
        request.requester_user_id,
        request.organization_id,
        request.conversation_id
      )
      and request.status = 'pending'
      and request.expires_at > clock_timestamp()
    order by request.requested_at, request.id
    limit p_limit
  ) row;
  return jsonb_build_object('join_requests', v_items);
end;
$$;

-- V9 makes scoped administration discoverable without treating it as message
-- membership. Existing conversation rows receive server-authoritative flags;
-- nonmembers receive a bounded metadata-only shell and never a message page.
create or replace function private.bff_bootstrap_messaging_state_v9_impl(
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
  v_base_selected_conversation_id uuid := p_selected_conversation_id;
  v_result jsonb;
  v_conversations jsonb;
  v_management_shells jsonb;
  v_selected_management_only boolean := false;
begin
  perform private.require_service_role();

  -- The legacy bootstrap correctly rejects arbitrary nonmember selections. A
  -- canonical management target is the one deliberate exception, and V9 later
  -- replaces the inherited default timeline with an empty page.
  v_selected_management_only := p_selected_conversation_id is not null
    and not private.dynamic_group_conversation_access_allowed_for_user(
      p_organization_id,
      p_selected_conversation_id,
      p_actor_user_id,
      now()
    )
    and (
      private.actor_can_manage_conversation(
        p_actor_user_id, p_organization_id, p_selected_conversation_id
      )
      or private.actor_can_manage_dynamic_group_conversation(
        p_actor_user_id, p_organization_id, p_selected_conversation_id
      )
    );
  if v_selected_management_only then
    v_base_selected_conversation_id := null;
  end if;

  v_result := private.bff_bootstrap_messaging_state_v8_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    v_base_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );

  select coalesce(jsonb_agg(
    item.value || jsonb_build_object(
      -- can_manage remains the narrow owner/admin authority consumed by
      -- avatar, role, summary, incident, and content-adjacent UI.
      'can_manage', private.actor_is_current_conversation_admin(
        p_actor_user_id,
        p_organization_id,
        (item.value ->> 'conversation_id')::uuid
      ),
      -- Delegated metadata, access-control, roster, and join-request workflows
      -- consume this separate capability.
      'can_manage_conversation', private.actor_can_manage_conversation(
        p_actor_user_id,
        p_organization_id,
        (item.value ->> 'conversation_id')::uuid
      ),
      'can_manage_dynamic_group',
        private.actor_can_manage_dynamic_group_conversation(
          p_actor_user_id,
          p_organization_id,
          (item.value ->> 'conversation_id')::uuid
        ),
      'policy_managed', private.dynamic_group_policy_conversation(
        p_organization_id,
        (item.value ->> 'conversation_id')::uuid
      )
    ) order by item.ordinality
  ), '[]'::jsonb)
  into v_conversations
  from jsonb_array_elements(coalesce(v_result -> 'conversations', '[]'::jsonb))
    with ordinality as item(value, ordinality);

  -- A selected management-only target receives one slot without allowing the
  -- combined collection to exceed the caller's existing conversation bound.
  if v_selected_management_only
    and jsonb_array_length(v_conversations) >= p_conversation_limit then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
      into v_conversations
    from jsonb_array_elements(v_conversations)
      with ordinality as item(value, ordinality)
    where item.ordinality < p_conversation_limit;
  end if;

  select coalesce(jsonb_agg(candidate.payload order by
    candidate.is_selected desc, candidate.updated_at desc,
    candidate.conversation_id
  ), '[]'::jsonb)
  into v_management_shells
  from (
    select conversation.id as conversation_id,
      conversation.updated_at,
      conversation.id = p_selected_conversation_id as is_selected,
      jsonb_strip_nulls(jsonb_build_object(
        'conversation_id', conversation.id,
        'kind', conversation.kind,
        'name', conversation.name,
        'description', conversation.description,
        'is_archived', conversation.is_archived,
        'is_read_only', conversation.closed_at is not null,
        'updated_at', conversation.updated_at,
        'preferences', jsonb_build_object(
          'is_favorite', false,
          'is_pinned', false,
          'notification_level', 'all',
          'muted_until', null,
          'translation_mode', 'automatic'
        ),
        'last_read_message_id', null,
        'unread_count', 0,
        'preview', null,
        'member_count', (
          select count(*)
          from public.conversation_members counted_member
          join public.organization_memberships counted_organization_member
            on counted_organization_member.organization_id = counted_member.organization_id
           and counted_organization_member.user_id = counted_member.user_id
          where counted_member.organization_id = conversation.organization_id
            and counted_member.conversation_id = conversation.id
            and counted_member.status = 'active'
            and private.organization_membership_access_current(
              counted_organization_member.organization_id,
              counted_organization_member.user_id,
              now()
            )
            and (
              not private.dynamic_group_policy_conversation(
                counted_member.organization_id, counted_member.conversation_id
              )
              or private.dynamic_group_user_currently_eligible(
                counted_member.organization_id,
                counted_member.conversation_id,
                counted_member.user_id,
                now()
              )
            )
        ),
        -- A roster is necessary only when the selected shell is authorized for
        -- conversation membership controls. Dynamic-group-only shells need no
        -- member identities.
        'members', case when conversation.id = p_selected_conversation_id
          and private.actor_can_manage_conversation(
            p_actor_user_id, p_organization_id, conversation.id
          ) then (
            select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'user_id', listed.user_id,
              'display_name', listed.display_name,
              'avatar_path', listed.avatar_path,
              'role', listed.role,
              'can_post', listed.can_post
            )) order by listed.display_name, listed.user_id), '[]'::jsonb)
            from (
              select member.user_id, profile.display_name, profile.avatar_path,
                member.role, member.can_post
              from public.conversation_members member
              join public.organization_memberships organization_member
                on organization_member.organization_id = member.organization_id
               and organization_member.user_id = member.user_id
              join public.profiles profile on profile.user_id = member.user_id
              where member.organization_id = conversation.organization_id
                and member.conversation_id = conversation.id
                and member.status = 'active'
                and private.organization_membership_access_current(
                  organization_member.organization_id,
                  organization_member.user_id,
                  now()
                )
                and (
                  not private.dynamic_group_policy_conversation(
                    member.organization_id, member.conversation_id
                  )
                  or private.dynamic_group_user_currently_eligible(
                    member.organization_id,
                    member.conversation_id,
                    member.user_id,
                    now()
                  )
                )
              order by profile.display_name, member.user_id
              limit 500
            ) listed
          ) else '[]'::jsonb end,
        'posting_mode', conversation.posting_mode,
        'configured_join_policy', conversation.join_policy,
        'join_policy', private.effective_conversation_join_policy(
          conversation.organization_id, conversation.id
        ),
        'visibility', conversation.visibility,
        'can_post', false,
        'can_manage', false,
        'can_manage_conversation', private.actor_can_manage_conversation(
          p_actor_user_id, p_organization_id, conversation.id
        ),
        'can_manage_dynamic_group',
          private.actor_can_manage_dynamic_group_conversation(
            p_actor_user_id, p_organization_id, conversation.id
          ),
        'policy_managed', private.dynamic_group_policy_conversation(
          p_organization_id, conversation.id
        ),
        'management_only', true
      )) as payload
    from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and (
        private.actor_can_manage_conversation(
          p_actor_user_id, p_organization_id, conversation.id
        )
        or private.actor_can_manage_dynamic_group_conversation(
          p_actor_user_id, p_organization_id, conversation.id
        )
      )
      -- Shells are exclusively for actors without current or retained-history
      -- content access. Published policies deliberately leave some ineligible
      -- administrators as active physical rows with can_post=false, so raw
      -- membership status is not an authorization discriminator here.
      and not private.dynamic_group_conversation_access_allowed_for_user(
        conversation.organization_id,
        conversation.id,
        p_actor_user_id,
        now()
      )
      and not exists (
        select 1
        from jsonb_array_elements(v_conversations) existing(value)
        where existing.value ->> 'conversation_id' = conversation.id::text
      )
    order by conversation.id = p_selected_conversation_id desc,
      conversation.updated_at desc, conversation.id
    limit greatest(
      p_conversation_limit - jsonb_array_length(v_conversations),
      0
    )
  ) candidate;

  v_conversations := v_conversations || v_management_shells;
  v_result := jsonb_set(v_result, '{conversations}', v_conversations, true);

  -- A management target is not also a join/discovery target. Keep this
  -- defense server-side so every client receives one unambiguous projection.
  v_result := jsonb_set(
    v_result,
    '{discoverable_conversations}',
    coalesce((
      select jsonb_agg(discoverable.value order by discoverable.ordinality)
      from jsonb_array_elements(
        coalesce(v_result -> 'discoverable_conversations', '[]'::jsonb)
      ) with ordinality as discoverable(value, ordinality)
      where not exists (
        select 1
        from jsonb_array_elements(coalesce(v_management_shells, '[]'::jsonb)) shell(value)
        where shell.value ->> 'conversation_id'
          = discoverable.value ->> 'conversation_id'
      )
    ), '[]'::jsonb),
    true
  );

  v_selected_management_only := p_selected_conversation_id is not null
    and exists (
      select 1
      from jsonb_array_elements(coalesce(v_management_shells, '[]'::jsonb)) shell(value)
      where shell.value ->> 'conversation_id' = p_selected_conversation_id::text
    );

  if v_selected_management_only then
    v_result := jsonb_set(
      v_result,
      '{selected_conversation_id}',
      to_jsonb(p_selected_conversation_id),
      true
    );
    v_result := jsonb_set(
      v_result,
      '{timeline}',
      jsonb_build_object(
        'messages', '[]'::jsonb,
        'has_more', false,
        'next_before_message_id', null
      ),
      true
    );
  end if;
  return v_result;
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
  select private.bff_bootstrap_messaging_state_v9_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  )
$$;

revoke all on function
  private.actor_is_current_conversation_admin(uuid, uuid, uuid),
  private.actor_can_manage_conversation(uuid, uuid, uuid),
  private.actor_can_manage_dynamic_group_conversation(uuid, uuid, uuid),
  private.validate_conversation_controls_update(),
  private.validate_conversation_member_write(),
  private.validate_conversation_join_request_write()
from public, anon, authenticated, service_role;

revoke all on function private.bff_update_conversation_impl(
  uuid, uuid, uuid, uuid, jsonb, text, text
) from public, anon, authenticated;
grant execute on function private.bff_update_conversation_impl(
  uuid, uuid, uuid, uuid, jsonb, text, text
) to service_role;

revoke all on function private.bff_add_conversation_member_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_add_conversation_member_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) to service_role;

revoke all on function private.bff_remove_conversation_member_impl(
  uuid, uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function private.bff_remove_conversation_member_impl(
  uuid, uuid, uuid, uuid, uuid, text, text
) to service_role;

revoke all on function private.bff_update_conversation_controls_impl(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_update_conversation_controls_impl(
  uuid, uuid, uuid, uuid, text, text, text, text, text, text
) to service_role;

revoke all on function private.bff_decide_conversation_join_request_impl(
  uuid, uuid, uuid, uuid, integer, text, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_decide_conversation_join_request_impl(
  uuid, uuid, uuid, uuid, integer, text, text, text, text
) to service_role;

revoke all on function private.bff_list_conversation_join_requests_impl(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function private.bff_list_conversation_join_requests_impl(
  uuid, uuid, uuid, uuid, integer
) to service_role;

revoke all on function private.bff_bootstrap_messaging_state_v9_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function private.bff_bootstrap_messaging_state_v9_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

revoke all on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

commit;
