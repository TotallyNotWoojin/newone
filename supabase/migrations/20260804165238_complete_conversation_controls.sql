-- CHAT-05 conversation controls. This migration keeps the application data
-- plane RPC-only while adding durable, tenant-scoped state for posting policy
-- and approval-based group joins.

alter table public.organizations
  add column default_group_join_policy text not null default 'invite_only',
  add column default_group_member_limit integer not null default 500,
  add column join_request_expiry_days integer not null default 7,
  add column max_pending_join_requests_per_user integer not null default 10,
  add column conversation_controls_version bigint not null default 1,
  add constraint organizations_default_group_join_policy_allowed check (
    default_group_join_policy in ('invite_only', 'approval_required')
  ),
  add constraint organizations_default_group_member_limit_range check (
    default_group_member_limit between 2 and 5000
  ),
  add constraint organizations_join_request_expiry_days_range check (
    join_request_expiry_days between 1 and 30
  ),
  add constraint organizations_pending_join_limit_range check (
    max_pending_join_requests_per_user between 1 and 100
  );

alter table public.conversations
  add column posting_mode text not null default 'all_members',
  add column join_policy text not null default 'inherit',
  add constraint conversations_posting_mode_allowed check (
    posting_mode in ('all_members', 'admins_only')
  ),
  add constraint conversations_join_policy_allowed check (
    join_policy in ('inherit', 'invite_only', 'approval_required')
  );

update public.conversations
set posting_mode = 'admins_only', join_policy = 'invite_only'
where kind = 'announcement';

update public.conversations
set join_policy = 'invite_only'
where kind in ('direct', 'shift', 'incident');

alter table public.conversations
  add constraint conversations_control_shape check (
    (kind <> 'direct' or (posting_mode = 'all_members' and join_policy = 'invite_only'))
    and (kind <> 'announcement' or (posting_mode = 'admins_only' and join_policy = 'invite_only'))
    and (kind not in ('shift', 'incident') or join_policy = 'invite_only')
  );

create table public.conversation_join_requests (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  requester_user_id uuid not null,
  status text not null default 'pending',
  version integer not null default 1,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz,
  decided_by_user_id uuid,
  decision_reason text,
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, requester_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, decided_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint conversation_join_requests_status_allowed check (
    status in ('pending', 'approved', 'rejected', 'cancelled', 'expired')
  ),
  constraint conversation_join_requests_version_positive check (version > 0),
  constraint conversation_join_requests_expiry_after_request check (expires_at > requested_at),
  constraint conversation_join_requests_times_finite check (
    isfinite(requested_at) and isfinite(expires_at)
    and (decided_at is null or isfinite(decided_at))
  ),
  constraint conversation_join_requests_expiry_bounded check (
    expires_at <= requested_at + interval '30 days'
  ),
  constraint conversation_join_requests_decision_after_request check (
    decided_at is null or decided_at >= requested_at
  ),
  constraint conversation_join_requests_reason_length check (
    decision_reason is null or char_length(btrim(decision_reason)) between 3 and 500
  ),
  constraint conversation_join_requests_decision_consistent check (
    (status = 'pending' and decided_at is null and decided_by_user_id is null and decision_reason is null)
    or (status = 'cancelled' and decided_at is not null and decided_by_user_id = requester_user_id)
    or (status = 'expired' and decided_at is not null and decided_by_user_id is null)
    or (status in ('approved', 'rejected') and decided_at is not null
      and decided_by_user_id is not null and decision_reason is not null)
  )
);

create unique index conversation_join_requests_one_pending_idx
  on public.conversation_join_requests (organization_id, conversation_id, requester_user_id)
  where status = 'pending';
create index conversation_join_requests_admin_queue_idx
  on public.conversation_join_requests (
    organization_id, conversation_id, status, requested_at, id
  );
create index conversation_join_requests_requester_idx
  on public.conversation_join_requests (
    organization_id, requester_user_id, status, updated_at desc, id
  );
create index conversation_join_requests_decided_by_fk_idx
  on public.conversation_join_requests (organization_id, decided_by_user_id)
  where decided_by_user_id is not null;

alter table public.conversation_join_requests enable row level security;
alter table public.conversation_join_requests force row level security;

-- Deliberately no anon/authenticated policy: reads and writes are bounded BFF
-- DTOs. FORCE RLS remains defense in depth for any future grant drift.
revoke all on table public.conversation_join_requests from public, anon, authenticated;
revoke all on table public.conversation_join_requests from service_role;

create or replace function private.effective_conversation_join_policy(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when conversation.visibility = 'invite_only' then 'invite_only'
    when conversation.join_policy = 'inherit' then organization.default_group_join_policy
    else conversation.join_policy
  end
  from public.conversations conversation
  join public.organizations organization on organization.id = conversation.organization_id
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
$$;

create or replace function private.conversation_join_request_eligible(
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
    join public.organizations organization on organization.id = conversation.organization_id
    join public.organization_memberships requester
      on requester.organization_id = conversation.organization_id
     and requester.user_id = p_actor_user_id
     and requester.status = 'active'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind in ('group', 'team')
      and conversation.visibility in ('organization', 'unit')
      and not conversation.is_archived
      and conversation.closed_at is null
      and case when conversation.visibility = 'invite_only' then 'invite_only'
        when conversation.join_policy = 'inherit'
        then organization.default_group_join_policy else conversation.join_policy end
        = 'approval_required'
      and (
        conversation.visibility = 'organization'
        or exists (
          select 1
          from public.organization_unit_members unit_member
          join public.organization_units unit
            on unit.organization_id = unit_member.organization_id
           and unit.id = unit_member.unit_id
           and unit.is_active
          where unit_member.organization_id = conversation.organization_id
            and unit_member.unit_id = conversation.unit_id
            and unit_member.user_id = p_actor_user_id
        )
      )
      and not exists (
        select 1
        from public.dynamic_group_policies policy
        where policy.organization_id = conversation.organization_id
          and policy.conversation_id = conversation.id
      )
      and not exists (
        select 1
        from public.conversation_members member
        where member.organization_id = conversation.organization_id
          and member.conversation_id = conversation.id
          and member.user_id = p_actor_user_id
          and member.status = 'active'
      )
  )
$$;

create or replace function private.conversation_controls_apply_org_defaults()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind in ('group', 'team', 'shift', 'incident') and new.member_limit = 500 then
    select organization.default_group_member_limit into new.member_limit
    from public.organizations organization
    where organization.id = new.organization_id;
  end if;
  return new;
end;
$$;

create trigger conversations_05_apply_org_control_defaults
before insert on public.conversations
for each row execute function private.conversation_controls_apply_org_defaults();

create or replace function private.validate_conversation_join_request_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
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
      or not private.is_conversation_admin(old.organization_id, old.conversation_id) then
      raise exception 'conversation administrator permission required' using errcode = '42501';
    end if;
  else
    raise exception 'invalid join request transition' using errcode = '42501';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger conversation_join_requests_10_validate_write
before insert or update on public.conversation_join_requests
for each row execute function private.validate_conversation_join_request_write();

create trigger conversation_join_requests_90_touch_updated_at
before update on public.conversation_join_requests
for each row execute function private.touch_updated_at();

create trigger audit_conversation_join_requests
after insert or update on public.conversation_join_requests
for each row execute function private.write_audit_event('conversation_join_request', 'id');

create or replace function private.validate_organization_conversation_controls_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if new.default_group_join_policy is distinct from old.default_group_join_policy
    or new.default_group_member_limit is distinct from old.default_group_member_limit
    or new.join_request_expiry_days is distinct from old.join_request_expiry_days
    or new.max_pending_join_requests_per_user is distinct from old.max_pending_join_requests_per_user
    or new.conversation_controls_version is distinct from old.conversation_controls_version then
    if coalesce(current_setting('app.organization_conversation_controls_context', true), 'off') <> 'on'
      or v_actor_user_id is null
      or coalesce((select auth.jwt() ->> 'aal'), 'aal1') <> 'aal2'
      or not exists (
        select 1
        from public.organization_memberships membership
        where membership.organization_id = old.id
          and membership.user_id = v_actor_user_id
          and membership.status = 'active'
          and membership.role = 'owner'
      ) then
      raise exception 'organization conversation controls require an AAL2 owner workflow'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger organizations_05_validate_conversation_controls
before update on public.organizations
for each row execute function private.validate_organization_conversation_controls_update();

create or replace function private.validate_conversation_controls_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.posting_mode is distinct from old.posting_mode
    or new.join_policy is distinct from old.join_policy
    or new.visibility is distinct from old.visibility then
    if coalesce(current_setting('app.conversation_controls_context', true), 'off') <> 'on'
      or not private.is_conversation_admin(old.organization_id, old.id) then
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

create trigger conversations_06_validate_controls_update
before update on public.conversations
for each row execute function private.validate_conversation_controls_update();

create or replace function private.can_post_to_conversation(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.conversations conversation
    join public.conversation_members conversation_member
      on conversation_member.organization_id = conversation.organization_id
     and conversation_member.conversation_id = conversation.id
     and conversation_member.user_id = v_user_id
     and conversation_member.status = 'active'
     and conversation_member.can_post
    join public.organization_memberships organization_member
      on organization_member.organization_id = conversation.organization_id
     and organization_member.user_id = v_user_id
     and organization_member.status = 'active'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and not conversation.is_archived
      and conversation.closed_at is null
      and (
        conversation.posting_mode = 'all_members'
        or conversation_member.role in ('owner', 'admin')
      )
      and (
        conversation.kind <> 'announcement'
        or conversation_member.role in ('owner', 'admin')
        or organization_member.role in ('owner', 'admin')
      )
      and (
        conversation.kind <> 'direct'
        or exists (
          select 1
          from public.direct_conversation_pairs pair
          where pair.organization_id = conversation.organization_id
            and pair.conversation_id = conversation.id
            and private.direct_pair_policy_permitted(
              pair.organization_id, pair.member_low_user_id, pair.member_high_user_id
            )
        )
      )
  );
end;
$$;

create or replace function private.serialize_message_posting_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_kind text;
  v_posting_mode text;
  v_is_archived boolean;
  v_closed_at timestamptz;
  v_member_role text;
  v_organization_role text;
  v_can_post boolean;
  v_pair_low_user_id uuid;
  v_pair_high_user_id uuid;
begin
  if new.kind = 'system'
    and coalesce(current_setting('app.bff_service_context', true), 'off') = 'on' then
    return new;
  end if;

  if v_actor_user_id is null or new.sender_user_id <> v_actor_user_id then
    raise exception 'active conversation membership with posting access is required'
      using errcode = '42501';
  end if;

  -- Shared row locks make the effective boundary deterministic: a completed
  -- restriction always precedes and rejects a later insert, while a send that
  -- already owns the lock commits before the restriction becomes effective.
  select conversation.kind, conversation.posting_mode,
    conversation.is_archived, conversation.closed_at
    into v_kind, v_posting_mode, v_is_archived, v_closed_at
  from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id
  for share;

  select member.role, organization_member.role, member.can_post
    into v_member_role, v_organization_role, v_can_post
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = new.organization_id
    and member.conversation_id = new.conversation_id
    and member.user_id = v_actor_user_id
    and member.status = 'active'
  for share of member;

  if not found
    or not v_can_post
    or v_is_archived
    or v_closed_at is not null
    or (v_posting_mode = 'admins_only' and v_member_role not in ('owner', 'admin'))
    or (v_kind = 'announcement'
      and v_member_role not in ('owner', 'admin')
      and v_organization_role not in ('owner', 'admin')) then
    raise exception 'active conversation membership with posting access is required'
      using errcode = '42501';
  end if;

  if v_kind = 'direct' then
    select pair.member_low_user_id, pair.member_high_user_id
      into v_pair_low_user_id, v_pair_high_user_id
    from public.direct_conversation_pairs pair
    where pair.organization_id = new.organization_id
      and pair.conversation_id = new.conversation_id;
    if not found then
      raise exception 'active conversation membership with posting access is required'
        using errcode = '42501';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.organization_id::text || ':' || v_pair_low_user_id::text || ':'
        || v_pair_high_user_id::text,
      0
    ));
    if not private.direct_pair_policy_permitted(
      new.organization_id, v_pair_low_user_id, v_pair_high_user_id
    ) then
      raise exception 'active conversation membership with posting access is required'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.serialize_direct_block_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_low_user_id uuid := least(
    case when tg_op = 'DELETE' then old.blocker_user_id else new.blocker_user_id end,
    case when tg_op = 'DELETE' then old.blocked_user_id else new.blocked_user_id end
  );
  v_high_user_id uuid := greatest(
    case when tg_op = 'DELETE' then old.blocker_user_id else new.blocker_user_id end,
    case when tg_op = 'DELETE' then old.blocked_user_id else new.blocked_user_id end
  );
  v_organization_id uuid := case when tg_op = 'DELETE'
    then old.organization_id else new.organization_id end;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_organization_id::text || ':' || v_low_user_id::text || ':' || v_high_user_id::text,
    0
  ));
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger member_blocks_05_serialize_direct_policy
before insert or delete on public.member_blocks
for each row execute function private.serialize_direct_block_change();

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
  if v_actor_id is not null and new.sender_user_id <> v_actor_id then
    raise exception 'message sender must match signed-in user' using errcode = '42501';
  end if;
  if v_jwt_role <> 'service_role' and new.kind = 'system'
    and not (
      coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
      and v_actor_id is not null
      and new.sender_user_id = v_actor_id
      and new.body is null
      and new.language_detection_state = 'not_applicable'
      and new.language_detected_at is not null
      and (new.metadata ->> 'event_type') in (
        'conversation.posting.admins_only',
        'conversation.posting.all_members',
        'conversation.join.approved'
      )
      and not exists (
        select 1
        from jsonb_object_keys(new.metadata) metadata_key
        where metadata_key not in ('event_type', 'target_user_id')
      )
    ) then
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
    if v_actor_conversation_role not in ('owner', 'admin') then
      raise exception 'conversation administrator permission required' using errcode = '42501';
    end if;
    if new.role = 'owner' and v_actor_conversation_role <> 'owner' then
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
    select conversation.history_policy into v_history_policy
    from public.conversations conversation
    where conversation.organization_id = old.organization_id
      and conversation.id = old.conversation_id;
    if v_actor_conversation_role not in ('owner', 'admin')
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
  if v_actor_conversation_role not in ('owner', 'admin') then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if v_actor_conversation_role <> 'owner'
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

create or replace function private.insert_conversation_system_event_internal(
  p_organization_id uuid, p_conversation_id uuid, p_actor_user_id uuid,
  p_event_type text, p_target_user_id uuid default null
)
returns bigint language plpgsql volatile security definer set search_path = ''
as $$
declare v_message_id bigint;
begin
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
    or (select auth.uid()) is distinct from p_actor_user_id
    or p_event_type not in (
      'conversation.posting.admins_only', 'conversation.posting.all_members',
      'conversation.join.approved'
    ) then
    raise exception 'trusted conversation system event required' using errcode = '42501';
  end if;
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, kind, body,
    language_detection_state, language_detected_at, metadata
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id, 'system', null,
    'not_applicable', now(), jsonb_strip_nulls(jsonb_build_object(
      'event_type', p_event_type, 'target_user_id', p_target_user_id
    ))
  ) returning id into v_message_id;
  return v_message_id;
end;
$$;

create or replace function private.broadcast_conversation_control_internal(
  p_organization_id uuid, p_conversation_id uuid,
  p_target_user_id uuid, p_reason text
)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
  v_recipient record;
begin
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
    or p_reason not in (
      'conversation_controls_changed', 'join_requested', 'join_cancelled',
      'join_approved', 'join_rejected'
    ) then
    raise exception 'trusted conversation invalidation required' using errcode = '42501';
  end if;
  for v_recipient in
    select distinct recipient.user_id
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
        and (p_reason in ('conversation_controls_changed', 'join_approved')
          or member.role in ('owner', 'admin'))
      union all select p_target_user_id where p_target_user_id is not null
    ) recipient
  loop
    perform realtime.send(jsonb_build_object(
      'schema_version', 1, 'event_id', v_event_id, 'event', 'workspace.invalidated',
      'organization_id', p_organization_id, 'occurred_at', v_occurred_at,
      'conversation_id', p_conversation_id, 'entity_type', 'conversation_control',
      'entity_id', p_conversation_id, 'version_id', null, 'reason', p_reason
    ), 'workspace.invalidated', 'org:' || p_organization_id::text || ':user:'
      || v_recipient.user_id::text || ':inbox', true);
  end loop;
end;
$$;

create or replace function private.broadcast_organization_conversation_controls_internal(
  p_organization_id uuid
)
returns void language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
  v_recipient record;
begin
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'trusted organization invalidation required' using errcode = '42501';
  end if;
  -- Realtime is an acceleration only. The durable organization revision is
  -- authoritative, so large tenants are never prevented from changing policy.
  for v_recipient in
    with affected as (
      select conversation.id, conversation.visibility, conversation.unit_id
      from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.kind in ('group', 'team')
        and conversation.join_policy = 'inherit'
        and conversation.visibility in ('organization', 'unit')
        and not conversation.is_archived and conversation.closed_at is null
        and not exists (
          select 1 from public.dynamic_group_policies policy
          where policy.organization_id = conversation.organization_id
            and policy.conversation_id = conversation.id
        )
    )
    select membership.user_id
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id and membership.status = 'active'
      and exists (
        select 1 from affected conversation
        where conversation.visibility = 'organization'
          or exists (
            select 1 from public.organization_unit_members unit_member
            where unit_member.organization_id = p_organization_id
              and unit_member.unit_id = conversation.unit_id
              and unit_member.user_id = membership.user_id
          )
          or exists (
            select 1 from public.conversation_members member
            where member.organization_id = p_organization_id
              and member.conversation_id = conversation.id
              and member.user_id = membership.user_id and member.status = 'active'
          )
      )
    order by membership.user_id limit 5000
  loop
    perform realtime.send(jsonb_build_object(
      'schema_version', 1, 'event_id', v_event_id, 'event', 'workspace.invalidated',
      'organization_id', p_organization_id, 'occurred_at', v_occurred_at,
      'conversation_id', null, 'entity_type', 'organization_control',
      'entity_id', p_organization_id, 'version_id', null,
      'reason', 'organization_conversation_controls_changed'
    ), 'workspace.invalidated', 'org:' || p_organization_id::text || ':user:'
      || v_recipient.user_id::text || ':inbox', true);
  end loop;
end;
$$;

create or replace function private.bff_update_organization_conversation_controls_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_default_join_policy text,
  p_default_group_member_limit integer,
  p_join_request_expiry_days integer,
  p_max_pending_join_requests_per_user integer,
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
  v_old public.organizations%rowtype;
  v_new public.organizations%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'organization.conversation_controls.update', true, 300,
    '/v2/admin/conversation-controls', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500
    or (p_default_join_policy is null and p_default_group_member_limit is null
      and p_join_request_expiry_days is null
      and p_max_pending_join_requests_per_user is null) then
    raise exception 'valid organization conversation controls and reason required'
      using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'organization-conversation-controls-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    10, 3600
  ) then
    raise exception 'organization conversation control limit exceeded' using errcode = 'P0001';
  end if;

  select organization.* into v_old
  from public.organizations organization
  join public.organization_memberships membership
    on membership.organization_id = organization.id
   and membership.user_id = p_actor_user_id
   and membership.status = 'active'
   and membership.role = 'owner'
  where organization.id = p_organization_id
  for update of organization, membership;
  if not found then
    raise exception 'organization owner permission required' using errcode = '42501';
  end if;

  perform set_config('app.organization_conversation_controls_context', 'on', true);
  update public.organizations organization
  set default_group_join_policy = coalesce(p_default_join_policy, organization.default_group_join_policy),
      default_group_member_limit = coalesce(
        p_default_group_member_limit, organization.default_group_member_limit
      ),
      join_request_expiry_days = coalesce(
        p_join_request_expiry_days, organization.join_request_expiry_days
      ),
      max_pending_join_requests_per_user = coalesce(
        p_max_pending_join_requests_per_user,
        organization.max_pending_join_requests_per_user
      ),
      conversation_controls_version = organization.conversation_controls_version + 1
  where organization.id = p_organization_id
  returning organization.* into v_new;
  perform set_config('app.organization_conversation_controls_context', 'off', true);
  perform private.broadcast_organization_conversation_controls_internal(p_organization_id);

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id,
    'organization.conversation_controls.updated', 'organization', p_organization_id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'before', jsonb_build_object(
        'default_join_policy', v_old.default_group_join_policy,
        'default_group_member_limit', v_old.default_group_member_limit,
        'join_request_expiry_days', v_old.join_request_expiry_days,
        'max_pending_join_requests_per_user', v_old.max_pending_join_requests_per_user,
        'conversation_controls_version', v_old.conversation_controls_version
      ),
      'after', jsonb_build_object(
        'default_join_policy', v_new.default_group_join_policy,
        'default_group_member_limit', v_new.default_group_member_limit,
        'join_request_expiry_days', v_new.join_request_expiry_days,
        'max_pending_join_requests_per_user', v_new.max_pending_join_requests_per_user,
        'conversation_controls_version', v_new.conversation_controls_version
      )
    )
  );

  v_response := jsonb_build_object(
    'default_join_policy', v_new.default_group_join_policy,
    'default_group_member_limit', v_new.default_group_member_limit,
    'join_request_expiry_days', v_new.join_request_expiry_days,
    'max_pending_join_requests_per_user', v_new.max_pending_join_requests_per_user,
    'conversation_controls_version', v_new.conversation_controls_version
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/conversation-controls',
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
  v_actor_role text;
  v_old_effective_join_policy text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.controls.update', true, 300,
    '/v2/conversations/:id/controls', p_idempotency_key, p_request_sha256
  );
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
  select member.role into v_actor_role
  from public.conversation_members member
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.user_id = p_actor_user_id
    and member.status = 'active'
  for update;
  if v_actor_role not in ('owner', 'admin') then
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

  perform set_config('app.conversation_controls_context', 'on', true);
  update public.conversations conversation
  set posting_mode = coalesce(p_posting_mode, conversation.posting_mode),
      join_policy = coalesce(p_join_policy, conversation.join_policy),
      visibility = coalesce(p_visibility, conversation.visibility)
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  returning conversation.* into v_new;
  perform set_config('app.conversation_controls_context', 'off', true);

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

  if v_new.posting_mode is distinct from v_old.posting_mode then
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

create or replace function private.bff_request_conversation_join_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
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
  v_expiry_days integer;
  v_pending_limit integer;
  v_request public.conversation_join_requests%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.join.request', false, 0,
    '/v2/conversations/:id/join-requests', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  select organization.join_request_expiry_days,
    organization.max_pending_join_requests_per_user
    into v_expiry_days, v_pending_limit
  from public.organizations organization
  where organization.id = p_organization_id
  for share;
  perform 1 from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active'
  for share;
  perform 1 from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  for share;

  -- One organization/requester lock protects both the per-user pending budget
  -- across different groups and deterministic duplicate requests to one group.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_organization_id::text || ':join-budget:' || p_actor_user_id::text,
    0
  ));

  if not private.conversation_join_request_eligible(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation join request is unavailable' using errcode = '42501';
  end if;
  if not private.consume_rate_limit(
    'conversation-join-request-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    10, 3600
  ) then
    raise exception 'conversation join request limit exceeded' using errcode = 'P0001';
  end if;

  update public.conversation_join_requests request
  set status = 'expired', version = request.version + 1, decided_at = now()
  where request.organization_id = p_organization_id
    and request.requester_user_id = p_actor_user_id
    and request.status = 'pending'
    and request.expires_at <= clock_timestamp();

  select request.* into v_request
  from public.conversation_join_requests request
  where request.organization_id = p_organization_id
    and request.conversation_id = p_conversation_id
    and request.requester_user_id = p_actor_user_id
    and request.status = 'pending'
    and request.expires_at > clock_timestamp()
  order by request.requested_at desc, request.id desc
  limit 1;
  if found then
    v_response := jsonb_build_object(
      'request_id', v_request.id,
      'conversation_id', p_conversation_id,
      'requester_user_id', v_request.requester_user_id,
      'status', v_request.status,
      'version', v_request.version,
      'requested_at', v_request.requested_at,
      'expires_at', v_request.expires_at
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, '/v2/conversations/:id/join-requests',
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;

  if (select count(*) from public.conversation_join_requests request
      where request.organization_id = p_organization_id
        and request.requester_user_id = p_actor_user_id
        and request.status = 'pending'
        and request.expires_at > clock_timestamp()) >= v_pending_limit then
    raise exception 'pending conversation join request limit exceeded' using errcode = 'P0001';
  end if;

  insert into public.conversation_join_requests (
    organization_id, conversation_id, requester_user_id, expires_at
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id,
    clock_timestamp() + make_interval(days => v_expiry_days)
  ) returning * into v_request;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.join.requested',
    'conversation', p_conversation_id::text,
    jsonb_build_object('request_id', v_request.id, 'expires_at', v_request.expires_at)
  );
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, p_actor_user_id, 'join_requested'
  );

  v_response := jsonb_build_object(
    'request_id', v_request.id,
    'conversation_id', p_conversation_id,
    'requester_user_id', v_request.requester_user_id,
    'status', v_request.status,
    'version', v_request.version,
    'requested_at', v_request.requested_at,
    'expires_at', v_request.expires_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/join-requests',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_cancel_conversation_join_request_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_request_id uuid,
  p_expected_version integer,
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
  v_request public.conversation_join_requests%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.join.cancel', false, 0,
    '/v2/conversation-join-requests/:id/cancel', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version < 1 then
    raise exception 'valid join request version required' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'conversation-join-cancel-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    30, 3600
  ) then
    raise exception 'join cancellation limit exceeded' using errcode = 'P0001';
  end if;

  select request.* into v_request
  from public.conversation_join_requests request
  where request.organization_id = p_organization_id
    and request.id = p_request_id
    and request.requester_user_id = p_actor_user_id
  for update;
  if not found or v_request.status <> 'pending'
    or v_request.version <> p_expected_version then
    raise exception 'conversation join request conflict' using errcode = '40001';
  end if;

  if v_request.expires_at <= clock_timestamp() then
    update public.conversation_join_requests request
    set status = 'expired', version = request.version + 1, decided_at = now()
    where request.organization_id = p_organization_id and request.id = p_request_id
    returning request.* into v_request;
  else
    update public.conversation_join_requests request
    set status = 'cancelled', version = request.version + 1,
        decided_at = now(), decided_by_user_id = p_actor_user_id
    where request.organization_id = p_organization_id and request.id = p_request_id
    returning request.* into v_request;
    insert into public.audit_events (
      organization_id, actor_user_id, event_type, target_type, target_id, metadata
    ) values (
      p_organization_id, p_actor_user_id, 'conversation.join.cancelled',
      'conversation', v_request.conversation_id::text,
      jsonb_build_object('request_id', v_request.id)
    );
  end if;
  perform private.broadcast_conversation_control_internal(
    p_organization_id, v_request.conversation_id, p_actor_user_id, 'join_cancelled'
  );

  v_response := jsonb_build_object(
    'request_id', v_request.id,
    'conversation_id', v_request.conversation_id,
    'requester_user_id', v_request.requester_user_id,
    'status', v_request.status,
    'version', v_request.version,
    'requested_at', v_request.requested_at,
    'expires_at', v_request.expires_at,
    'decided_at', v_request.decided_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversation-join-requests/:id/cancel',
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
  v_actor_role text;
  v_history_visible_from timestamptz;
  v_active_member_count integer;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.join.decide', true, 300,
    '/v2/conversation-join-requests/:id/decision', p_idempotency_key, p_request_sha256
  );
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
  if not found then
    raise exception 'conversation join request unavailable' using errcode = '42501';
  end if;
  select member.role into v_actor_role
  from public.conversation_members member
  where member.organization_id = p_organization_id
    and member.conversation_id = v_request.conversation_id
    and member.user_id = p_actor_user_id
    and member.status = 'active'
  for update;
  if v_actor_role not in ('owner', 'admin') then
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

  if v_request.expires_at <= clock_timestamp() then
    update public.conversation_join_requests request
    set status = 'expired', version = request.version + 1, decided_at = now()
    where request.organization_id = p_organization_id and request.id = p_request_id
    returning request.* into v_request;
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
      perform set_config('app.conversation_join_reactivation_context', 'off', true);
      if not found then
        raise exception 'conversation join request conflict' using errcode = '40001';
      end if;
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
  if p_decision = 'approved' then
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

create or replace function private.bff_list_discoverable_conversations_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_limit integer default 50
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
    'conversation.discover.read', false, 0
  );
  if p_limit not between 1 and 100 then
    raise exception 'invalid discoverable conversation limit' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row.payload order by row.name, row.conversation_id), '[]'::jsonb)
    into v_items
  from (
    select conversation.id as conversation_id, conversation.name,
      jsonb_strip_nulls(jsonb_build_object(
        'conversation_id', conversation.id,
        'kind', conversation.kind,
        'name', conversation.name,
        'description', conversation.description,
        'avatar_path', conversation.avatar_path,
        'visibility', conversation.visibility,
        'posting_mode', conversation.posting_mode,
        'join_policy', private.effective_conversation_join_policy(
          conversation.organization_id, conversation.id
        ),
        'member_count', (
          select count(*) from public.conversation_members member
          join public.organization_memberships organization_member
            on organization_member.organization_id = member.organization_id
           and organization_member.user_id = member.user_id
           and organization_member.status = 'active'
          where member.organization_id = conversation.organization_id
            and member.conversation_id = conversation.id
            and member.status = 'active'
        ),
        'history_disclosure', jsonb_build_object(
          'policy', conversation.history_policy,
          'visible_from', case when conversation.history_policy = 'since_join' then now() else null end,
          'label_key', case when conversation.history_policy = 'all'
            then 'conversation.history.all' else 'conversation.history.since_join' end
        ),
        'my_join_request', case when latest_request.id is null then null else jsonb_build_object(
          'request_id', latest_request.id,
          'status', case when latest_request.status = 'pending'
            and latest_request.expires_at <= clock_timestamp() then 'expired' else latest_request.status end,
          'version', latest_request.version,
          'requested_at', latest_request.requested_at,
          'expires_at', latest_request.expires_at,
          'decided_at', latest_request.decided_at
        ) end
      )) as payload
    from public.conversations conversation
    left join lateral (
      select request.*
      from public.conversation_join_requests request
      where request.organization_id = conversation.organization_id
        and request.conversation_id = conversation.id
        and request.requester_user_id = p_actor_user_id
      order by request.requested_at desc, request.id desc
      limit 1
    ) latest_request on true
    where conversation.organization_id = p_organization_id
      and private.conversation_join_request_eligible(
        p_actor_user_id, p_organization_id, conversation.id
      )
    order by conversation.name, conversation.id
    limit p_limit
  ) row;
  return jsonb_build_object('conversations', v_items);
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
  if not exists (
    select 1 from public.conversation_members member
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.user_id = p_actor_user_id
      and member.status = 'active'
      and member.role in ('owner', 'admin')
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
    join public.profiles profile on profile.user_id = request.requester_user_id
    where request.organization_id = p_organization_id
      and request.conversation_id = p_conversation_id
      and request.status = 'pending'
      and request.expires_at > clock_timestamp()
    order by request.requested_at, request.id
    limit p_limit
  ) row;
  return jsonb_build_object('join_requests', v_items);
end;
$$;

create or replace function private.bff_bootstrap_messaging_state_v7_impl(
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
  v_discoverable jsonb;
begin
  v_base := private.bff_bootstrap_messaging_state_v6_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  select coalesce(jsonb_agg(
    item.value || jsonb_build_object(
      'posting_mode', conversation.posting_mode,
      'configured_join_policy', conversation.join_policy,
      'join_policy', private.effective_conversation_join_policy(
        p_organization_id, conversation.id
      ),
      'visibility', conversation.visibility,
      'can_post', member.can_post
        and not conversation.is_archived
        and conversation.closed_at is null
        and (conversation.posting_mode = 'all_members' or member.role in ('owner', 'admin'))
        and (conversation.kind <> 'announcement'
          or member.role in ('owner', 'admin')
          or organization_member.role in ('owner', 'admin'))
        and (conversation.kind <> 'direct' or exists (
          select 1 from public.direct_conversation_pairs pair
          where pair.organization_id = conversation.organization_id
            and pair.conversation_id = conversation.id
            and private.direct_pair_policy_permitted(
              conversation.organization_id,
              pair.member_low_user_id,
              pair.member_high_user_id
            )
        ))
    ) order by item.ordinality
  ), '[]'::jsonb) into v_conversations
  from jsonb_array_elements(coalesce(v_base -> 'conversations', '[]'::jsonb))
    with ordinality as item(value, ordinality)
  join public.conversations conversation
    on conversation.organization_id = p_organization_id
   and conversation.id = (item.value ->> 'conversation_id')::uuid
  join public.conversation_members member
    on member.organization_id = conversation.organization_id
   and member.conversation_id = conversation.id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active';

  v_discoverable := private.bff_list_discoverable_conversations_impl(
    p_actor_user_id, p_organization_id, p_session_id, 50
  ) -> 'conversations';
  return jsonb_set(
    jsonb_set(
      jsonb_set(v_base, '{conversations}', v_conversations, true),
      '{organization,conversation_controls_version}',
      to_jsonb((select organization.conversation_controls_version
        from public.organizations organization where organization.id = p_organization_id)),
      true
    ),
    '{discoverable_conversations}', coalesce(v_discoverable, '[]'::jsonb), true
  );
end;
$$;

create or replace function public.bff_update_organization_conversation_controls(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_default_join_policy text, p_default_group_member_limit integer,
  p_join_request_expiry_days integer, p_max_pending_join_requests_per_user integer,
  p_reason text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_update_organization_conversation_controls_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_default_join_policy,
  p_default_group_member_limit, p_join_request_expiry_days,
  p_max_pending_join_requests_per_user, p_reason, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_update_conversation_controls(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_posting_mode text, p_join_policy text,
  p_visibility text, p_reason text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_update_conversation_controls_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_posting_mode, p_join_policy, p_visibility, p_reason,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_request_conversation_join(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_request_conversation_join_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_cancel_conversation_join_request(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_request_id uuid, p_expected_version integer,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_cancel_conversation_join_request_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_request_id,
  p_expected_version, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_decide_conversation_join_request(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_request_id uuid, p_expected_version integer, p_decision text, p_reason text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_decide_conversation_join_request_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_request_id,
  p_expected_version, p_decision, p_reason, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_list_discoverable_conversations(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_limit integer default 50
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_list_discoverable_conversations_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_limit
) $$;

create or replace function public.bff_list_conversation_join_requests(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_limit integer default 100
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_list_conversation_join_requests_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id, p_limit
) $$;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid default null,
  p_before_message_id bigint default null,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_bootstrap_messaging_state_v7_impl(
  p_actor_user_id, p_organization_id, p_session_id,
  p_selected_conversation_id, p_before_message_id,
  p_conversation_limit, p_timeline_limit
) $$;

revoke execute on function
  private.effective_conversation_join_policy(uuid, uuid),
  private.conversation_join_request_eligible(uuid, uuid, uuid),
  private.conversation_controls_apply_org_defaults(),
  private.validate_conversation_join_request_write(),
  private.validate_organization_conversation_controls_update(),
  private.validate_conversation_controls_update(),
  private.serialize_message_posting_access(),
  private.serialize_direct_block_change(),
  private.insert_conversation_system_event_internal(uuid, uuid, uuid, text, uuid),
  private.broadcast_conversation_control_internal(uuid, uuid, uuid, text),
  private.broadcast_organization_conversation_controls_internal(uuid),
  private.bff_update_organization_conversation_controls_impl(
    uuid, uuid, uuid, text, integer, integer, integer, text, text, text
  ),
  private.bff_update_conversation_controls_impl(
    uuid, uuid, uuid, uuid, text, text, text, text, text, text
  ),
  private.bff_request_conversation_join_impl(uuid, uuid, uuid, uuid, text, text),
  private.bff_cancel_conversation_join_request_impl(
    uuid, uuid, uuid, uuid, integer, text, text
  ),
  private.bff_decide_conversation_join_request_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  private.bff_list_discoverable_conversations_impl(uuid, uuid, uuid, integer),
  private.bff_list_conversation_join_requests_impl(uuid, uuid, uuid, uuid, integer),
  private.bff_bootstrap_messaging_state_v7_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
from public, anon, authenticated, service_role;

grant execute on function
  private.bff_update_organization_conversation_controls_impl(
    uuid, uuid, uuid, text, integer, integer, integer, text, text, text
  ),
  private.bff_update_conversation_controls_impl(
    uuid, uuid, uuid, uuid, text, text, text, text, text, text
  ),
  private.bff_request_conversation_join_impl(uuid, uuid, uuid, uuid, text, text),
  private.bff_cancel_conversation_join_request_impl(
    uuid, uuid, uuid, uuid, integer, text, text
  ),
  private.bff_decide_conversation_join_request_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  private.bff_list_discoverable_conversations_impl(uuid, uuid, uuid, integer),
  private.bff_list_conversation_join_requests_impl(uuid, uuid, uuid, uuid, integer),
  private.bff_bootstrap_messaging_state_v7_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
to service_role;

revoke execute on function
  public.bff_update_organization_conversation_controls(
    uuid, uuid, uuid, text, integer, integer, integer, text, text, text
  ),
  public.bff_update_conversation_controls(
    uuid, uuid, uuid, uuid, text, text, text, text, text, text
  ),
  public.bff_request_conversation_join(uuid, uuid, uuid, uuid, text, text),
  public.bff_cancel_conversation_join_request(uuid, uuid, uuid, uuid, integer, text, text),
  public.bff_decide_conversation_join_request(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  public.bff_list_discoverable_conversations(uuid, uuid, uuid, integer),
  public.bff_list_conversation_join_requests(uuid, uuid, uuid, uuid, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.bff_update_organization_conversation_controls(
    uuid, uuid, uuid, text, integer, integer, integer, text, text, text
  ),
  public.bff_update_conversation_controls(
    uuid, uuid, uuid, uuid, text, text, text, text, text, text
  ),
  public.bff_request_conversation_join(uuid, uuid, uuid, uuid, text, text),
  public.bff_cancel_conversation_join_request(uuid, uuid, uuid, uuid, integer, text, text),
  public.bff_decide_conversation_join_request(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  public.bff_list_discoverable_conversations(uuid, uuid, uuid, integer),
  public.bff_list_conversation_join_requests(uuid, uuid, uuid, uuid, integer)
to service_role;

comment on table public.conversation_join_requests is
  'Forced-RLS, RPC-only conversation join lifecycle with finite expiry and compare-and-set decisions.';
comment on column public.conversations.posting_mode is
  'Conversation-wide posting policy; effective posting also requires active membership and can_post.';
comment on column public.conversations.join_policy is
  'Configured join policy. Invite-only visibility always resolves to invite_only; inherit uses the organization default.';
comment on column public.organizations.conversation_controls_version is
  'Durable reconciliation revision incremented for every organization conversation-control update; realtime delivery is best-effort.';
comment on function private.conversation_join_request_eligible(uuid, uuid, uuid) is
  'Eligibility uses exact organization-unit membership for unit-visible conversations; descendant units are not implicitly included.';

create trigger messages_05_serialize_posting_access
before insert on public.messages
for each row execute function private.serialize_message_posting_access();
