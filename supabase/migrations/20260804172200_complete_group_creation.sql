begin;

-- CHAT-03: group creation is one policy-checked transaction. Organization
-- defaults govern who may create groups, how large they may be, whether
-- discoverable join approval is available, and whether an explicitly scoped
-- external guest may be included. Guests remain disabled by default.
alter table public.organizations
  add column group_creation_policy text not null default 'members',
  add column allow_external_guests boolean not null default false,
  add column external_guest_max_access_days integer not null default 90,
  add column organization_policy_version bigint not null default 1,
  add constraint organizations_group_creation_policy_allowed check (
    group_creation_policy in ('members', 'managers', 'admins')
  ),
  add constraint organizations_external_guest_max_access_days_range check (
    external_guest_max_access_days between 1 and 365
  ),
  add constraint organizations_policy_version_positive check (
    organization_policy_version >= 1
  );

alter table public.organization_memberships
  add column membership_type text not null default 'employee',
  add column access_expires_at timestamptz,
  add column guest_sponsor_user_id uuid,
  add constraint organization_memberships_membership_type_allowed check (
    membership_type in ('employee', 'contractor', 'guest')
  ),
  add constraint organization_memberships_access_expiry_finite check (
    access_expires_at is null or isfinite(access_expires_at)
  ),
  add constraint organization_memberships_guest_shape check (
    (
      membership_type = 'guest'
      and role = 'member'
      and directory_visibility = 'private'
      and access_expires_at is not null
      and access_expires_at > joined_at
      and guest_sponsor_user_id is not null
      and guest_sponsor_user_id <> user_id
    )
    or (
      membership_type <> 'guest'
      and guest_sponsor_user_id is null
      and (access_expires_at is null or access_expires_at > joined_at)
    )
  ),
  add constraint organization_memberships_guest_sponsor_fkey
    foreign key (organization_id, guest_sponsor_user_id)
    references public.organization_memberships (organization_id, user_id)
    on delete restrict;

create index organization_memberships_active_access_idx
  on public.organization_memberships (
    organization_id, status, membership_type, access_expires_at, user_id
  );

alter table public.organization_invites
  add column membership_type text not null default 'employee',
  add column membership_access_expires_at timestamptz,
  add column guest_sponsor_user_id uuid,
  add constraint organization_invites_membership_type_allowed check (
    membership_type in ('employee', 'contractor', 'guest')
  ),
  add constraint organization_invites_membership_access_expiry_finite check (
    membership_access_expires_at is null
    or isfinite(membership_access_expires_at)
  ),
  add constraint organization_invites_membership_scope_shape check (
    (
      membership_type = 'employee'
      and membership_access_expires_at is null
      and guest_sponsor_user_id is null
    )
    or (
      membership_type = 'contractor'
      and membership_access_expires_at is not null
      and membership_access_expires_at > expires_at
      and guest_sponsor_user_id is null
    )
    or (
      membership_type = 'guest'
      and role = 'member'
      and membership_access_expires_at is not null
      and membership_access_expires_at > expires_at
      and guest_sponsor_user_id is not null
      and guest_sponsor_user_id <> invited_user_id
    )
  ),
  add constraint organization_invites_guest_sponsor_fkey
    foreign key (organization_id, guest_sponsor_user_id)
    references public.organization_memberships (organization_id, user_id)
    on delete restrict;

create index organization_invites_pending_membership_scope_idx
  on public.organization_invites (
    organization_id, membership_type, membership_access_expires_at
  ) where revoked_at is null and accepted_at is null;

create or replace function private.organization_membership_access_current(
  p_organization_id uuid,
  p_user_id uuid,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_at is not null and isfinite(p_at) and exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
      and membership.joined_at <= p_at
      and (
        membership.access_expires_at is null
        or membership.access_expires_at > p_at
      )
      and (
        membership.membership_type <> 'guest'
        or (
          organization.allow_external_guests
          and membership.guest_sponsor_user_id is not null
          and exists (
            select 1
            from public.organization_memberships sponsor
            where sponsor.organization_id = membership.organization_id
              and sponsor.user_id = membership.guest_sponsor_user_id
              and sponsor.status = 'active'
              and sponsor.membership_type <> 'guest'
              and sponsor.joined_at <= p_at
              and (
                sponsor.access_expires_at is null
                or sponsor.access_expires_at > p_at
              )
          )
        )
      )
  )
$$;

-- Security, retention, identity, shift-source, and group-creation policy must
-- move through one recent-AAL2 owner command. The authenticated organizations
-- UPDATE grant remains useful for non-policy profile fields, so a trigger is
-- the authoritative boundary for these high-impact columns.
create or replace function private.validate_organization_policy_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if new.message_retention_days is distinct from old.message_retention_days
    or new.allow_member_direct_messages is distinct from old.allow_member_direct_messages
    or new.dm_policy is distinct from old.dm_policy
    or new.require_mfa_for_admins is distinct from old.require_mfa_for_admins
    or new.shift_schedule_authoritative is distinct from old.shift_schedule_authoritative
    or new.group_creation_policy is distinct from old.group_creation_policy
    or new.allow_external_guests is distinct from old.allow_external_guests
    or new.external_guest_max_access_days is distinct from old.external_guest_max_access_days
    or new.organization_policy_version is distinct from old.organization_policy_version then
    if coalesce(current_setting('app.organization_policy_context', true), 'off') <> 'on'
      or coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
      or v_actor_user_id is null
      or coalesce((select auth.jwt() ->> 'aal'), 'aal1') <> 'aal2'
      or not exists (
        select 1
        from public.organization_memberships membership
        where membership.organization_id = old.id
          and membership.user_id = v_actor_user_id
          and private.organization_membership_access_current(
            membership.organization_id, membership.user_id, now()
          )
          and membership.membership_type <> 'guest'
          and membership.role = 'owner'
      ) then
      raise exception 'organization policy requires the trusted AAL2 owner workflow'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger organizations_04_validate_policy
before update on public.organizations
for each row execute function private.validate_organization_policy_update();

-- Policy-managed groups are employee/contractor automation, never a route for
-- widening a named external guest scope. CHAT-04 routes every candidate through
-- this hook so guest rows are excluded before materialization or reconciliation.
create or replace function private.dynamic_group_candidate_membership_allowed(
  p_organization_id uuid,
  p_user_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_at is not null and isfinite(p_at) and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
      and membership.membership_type in ('employee', 'contractor')
      and membership.joined_at <= p_at
      and (membership.access_expires_at is null
        or membership.access_expires_at > p_at)
  )
$$;

create or replace function private.dynamic_group_candidate_membership_valid_until(
  p_organization_id uuid,
  p_user_id uuid,
  p_at timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_at is null or not isfinite(p_at) then null::timestamptz
    else (
      select membership.access_expires_at
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = p_user_id
        and membership.status = 'active'
        and membership.membership_type in ('employee', 'contractor')
        and membership.joined_at <= p_at
        and (membership.access_expires_at is null
          or membership.access_expires_at > p_at)
    )
  end
$$;

create or replace function private.validate_membership_access_policy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_max_guest_days integer;
  v_allow_external_guests boolean;
begin
  if new.membership_type = 'guest' then
    select organization.external_guest_max_access_days,
        organization.allow_external_guests
      into v_max_guest_days, v_allow_external_guests
    from public.organizations organization
    where organization.id = new.organization_id;
    if not coalesce(v_allow_external_guests, false)
      or new.role <> 'member'
      or new.directory_visibility <> 'private'
      or new.access_expires_at is null
      or new.access_expires_at <= new.joined_at
      or new.access_expires_at > new.joined_at
        + make_interval(days => v_max_guest_days)
      or new.guest_sponsor_user_id is null
      or new.guest_sponsor_user_id = new.user_id
      or not exists (
        select 1
        from public.organization_memberships sponsor
        where sponsor.organization_id = new.organization_id
          and sponsor.user_id = new.guest_sponsor_user_id
          and sponsor.status = 'active'
          and sponsor.membership_type <> 'guest'
          and (sponsor.access_expires_at is null or sponsor.access_expires_at > now())
          and (sponsor.access_expires_at is null
            or sponsor.access_expires_at >= new.access_expires_at)
      ) then
      raise exception 'invalid external guest membership policy'
        using errcode = '23514';
    end if;
  else
    if new.guest_sponsor_user_id is not null then
      raise exception 'guest sponsor is reserved for external guests'
        using errcode = '23514';
    end if;
    if new.access_expires_at is not null
      and (
        new.access_expires_at <= new.joined_at
        or (
          (tg_op = 'INSERT'
            or new.access_expires_at is distinct from old.access_expires_at)
          and new.access_expires_at <= now()
        )
      ) then
      raise exception 'contractor access expiration must be future-bounded'
        using errcode = '23514';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.membership_type is distinct from old.membership_type
    or new.access_expires_at is distinct from old.access_expires_at
    or new.guest_sponsor_user_id is distinct from old.guest_sponsor_user_id
  ) then
    if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
      or v_actor_user_id is null
      or not private.actor_has_permission(
        v_actor_user_id, old.organization_id, 'members.security', null
      ) then
      raise exception 'membership access policy requires an administrator workflow'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger organization_memberships_06_validate_access_policy
before insert or update on public.organization_memberships
for each row execute function private.validate_membership_access_policy();

create or replace function private.mark_dynamic_group_membership_access_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.membership_type is distinct from old.membership_type
    or new.access_expires_at is distinct from old.access_expires_at then
    perform private.enqueue_dynamic_group_user_source_change_internal(
      new.organization_id, new.user_id,
      'organization_memberships.access_update', statement_timestamp()
    );
  end if;
  return new;
end;
$$;

create trigger organization_memberships_97_dynamic_group_access_source
after update of membership_type, access_expires_at
on public.organization_memberships
for each row execute function private.mark_dynamic_group_membership_access_change();

create or replace function private.validate_invite_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_scope_assignment boolean :=
    v_jwt_role = 'service_role'
    and coalesce(
      current_setting('app.invite_membership_scope_context', true), 'off'
    ) = 'on';
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.email is distinct from old.email
    or new.destination_type is distinct from old.destination_type
    or new.destination is distinct from old.destination
    or new.invited_user_id is distinct from old.invited_user_id
    or new.employee_code_hash is distinct from old.employee_code_hash
    or new.activation_mode is distinct from old.activation_mode
    or new.token_hash is distinct from old.token_hash
    or new.role is distinct from old.role
    or new.expires_at is distinct from old.expires_at
    or new.max_uses is distinct from old.max_uses
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'invitation identity fields are immutable' using errcode = '22000';
  end if;
  if (
    new.membership_type is distinct from old.membership_type
    or new.membership_access_expires_at is distinct from old.membership_access_expires_at
    or new.guest_sponsor_user_id is distinct from old.guest_sponsor_user_id
  ) and not (
    v_scope_assignment
    and old.membership_type = 'employee'
    and old.membership_access_expires_at is null
    and old.guest_sponsor_user_id is null
    and old.accepted_at is null
    and old.revoked_at is null
  ) then
    raise exception 'invitation membership scope is immutable' using errcode = '22000';
  end if;
  if v_actor_id is null and v_jwt_role = 'service_role' then return new; end if;
  if current_setting('app.invite_redemption_context', true) = 'on'
    and v_actor_id is not null
    and new.accepted_by_user_id = v_actor_id
    and old.use_count = 0 and new.use_count = 1
    and old.accepted_at is null and new.accepted_at is not null
    and old.revoked_at is null and new.revoked_at is null then
    return new;
  end if;
  if new.use_count is distinct from old.use_count
    or new.accepted_by_user_id is distinct from old.accepted_by_user_id
    or new.accepted_at is distinct from old.accepted_at
    or old.revoked_at is not null
    or new.revoked_at is null then
    raise exception 'administrators may only revoke an active invitation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.bff_issue_organization_invite_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_destination_type text,
  p_destination text,
  p_invited_user_id uuid,
  p_employee_code text,
  p_activation_mode text,
  p_role text,
  p_expires_in_seconds integer,
  p_membership_type text,
  p_membership_access_expires_at timestamptz,
  p_guest_sponsor_user_id uuid,
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
  v_organization public.organizations%rowtype;
  v_response jsonb;
  v_invite_id uuid;
  v_existing_type text;
  v_existing_access_expires_at timestamptz;
  v_existing_sponsor_user_id uuid;
  v_invite_expires_at timestamptz;
  v_replay jsonb;
  v_scope_changed boolean;
begin
  perform private.require_service_role();
  -- Preserve the original command's replay-before-policy semantics. A retry
  -- after an ambiguous network failure must return the committed receipt even
  -- if an administrator has since disabled guests or shortened the policy.
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'invite.issue', true, 900
  );
  if char_length(coalesce(p_idempotency_key, '')) between 8 and 200
    and coalesce(p_request_sha256, '') ~ '^[0-9a-f]{64}$' then
    select idempotency.response_body into v_replay
    from private.api_idempotency_keys idempotency
    where idempotency.organization_id = p_organization_id
      and idempotency.actor_user_id = p_actor_user_id
      and idempotency.route = '/v2/admin/invitations'
      and idempotency.idempotency_key = p_idempotency_key
      and idempotency.request_sha256 = decode(p_request_sha256, 'hex')
      and idempotency.state = 'completed';
    if found then
      v_invite_id := nullif(v_replay ->> 'invite_id', '')::uuid;
      select invitation.membership_type,
          invitation.membership_access_expires_at,
          invitation.guest_sponsor_user_id
        into v_existing_type, v_existing_access_expires_at,
          v_existing_sponsor_user_id
      from public.organization_invites invitation
      where invitation.organization_id = p_organization_id
        and invitation.id = v_invite_id;
      if found then
        return v_replay || jsonb_build_object(
          'membership_type', v_existing_type,
          'membership_access_expires_at', v_existing_access_expires_at,
          'guest_sponsor_user_id', v_existing_sponsor_user_id
        );
      end if;
    end if;
  end if;
  select organization.* into v_organization
  from public.organizations organization
  where organization.id = p_organization_id;
  if not found
    or p_membership_type is null
    or p_membership_type not in ('employee', 'contractor', 'guest')
    or p_expires_in_seconds not between 900 and 2592000
    or (
      p_membership_type = 'employee'
      and (p_membership_access_expires_at is not null
        or p_guest_sponsor_user_id is not null)
    )
    or (
      p_membership_type = 'contractor'
      and (
        p_membership_access_expires_at is null
        or not isfinite(p_membership_access_expires_at)
        or p_membership_access_expires_at <=
          now() + make_interval(secs => p_expires_in_seconds)
        or p_membership_access_expires_at > now() + interval '365 days'
        or p_guest_sponsor_user_id is not null
      )
    )
    or (
      p_membership_type = 'guest'
      and (
        not v_organization.allow_external_guests
        or p_role <> 'member'
        or p_membership_access_expires_at is null
        or not isfinite(p_membership_access_expires_at)
        or p_membership_access_expires_at <=
          now() + make_interval(secs => p_expires_in_seconds)
        or p_membership_access_expires_at > now() + make_interval(
          days => v_organization.external_guest_max_access_days
        )
        or p_guest_sponsor_user_id is null
        or p_guest_sponsor_user_id = p_invited_user_id
        or not exists (
          select 1 from public.organization_memberships sponsor
          where sponsor.organization_id = p_organization_id
            and sponsor.user_id = p_guest_sponsor_user_id
            and sponsor.status = 'active'
            and sponsor.membership_type <> 'guest'
            and (sponsor.access_expires_at is null
              or sponsor.access_expires_at > now())
            and (sponsor.access_expires_at is null
              or sponsor.access_expires_at >= p_membership_access_expires_at)
        )
      )
    ) then
    raise exception 'invalid invitation membership scope' using errcode = '22023';
  end if;

  v_response := private.bff_issue_organization_invite_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_destination_type, p_destination, p_invited_user_id,
    p_employee_code, p_activation_mode, p_role, p_expires_in_seconds,
    p_idempotency_key, p_request_sha256
  );
  v_invite_id := (v_response ->> 'invite_id')::uuid;
  select invitation.membership_type,
      invitation.membership_access_expires_at,
      invitation.guest_sponsor_user_id,
      invitation.expires_at
    into v_existing_type, v_existing_access_expires_at,
      v_existing_sponsor_user_id, v_invite_expires_at
  from public.organization_invites invitation
  where invitation.organization_id = p_organization_id
    and invitation.id = v_invite_id
  for update;
  if not found then
    raise exception 'issued invitation not found' using errcode = 'P0002';
  end if;
  -- The legacy issuer establishes expires_at with its own statement timestamp.
  -- Validate against that authoritative value before assigning the extended
  -- membership scope, instead of relying on two close but non-identical now()
  -- calls and surfacing an opaque table-constraint error at the boundary.
  if p_membership_type <> 'employee' and (
    p_membership_access_expires_at is null
    or p_membership_access_expires_at <= v_invite_expires_at
  ) then
    raise exception 'membership access must outlast the invitation'
      using errcode = '22023';
  end if;
  v_scope_changed := v_existing_type is distinct from p_membership_type
    or v_existing_access_expires_at is distinct from p_membership_access_expires_at
    or v_existing_sponsor_user_id is distinct from p_guest_sponsor_user_id;
  if v_scope_changed then
    perform set_config('app.invite_membership_scope_context', 'on', true);
    update public.organization_invites invitation
    set membership_type = p_membership_type,
        membership_access_expires_at = p_membership_access_expires_at,
        guest_sponsor_user_id = p_guest_sponsor_user_id
    where invitation.organization_id = p_organization_id
      and invitation.id = v_invite_id;
    perform set_config('app.invite_membership_scope_context', 'off', true);
    insert into public.audit_events (
      organization_id, actor_user_id, event_type, target_type, target_id, metadata
    ) values (
      p_organization_id, p_actor_user_id, 'organization.invite.scope.assigned',
      'organization_invite', v_invite_id::text,
      jsonb_strip_nulls(jsonb_build_object(
        'membership_type', p_membership_type,
        'membership_access_expires_at', p_membership_access_expires_at,
        'guest_sponsor_user_id', p_guest_sponsor_user_id
      ))
    );
  end if;
  return v_response || jsonb_build_object(
    'membership_type', p_membership_type,
    'membership_access_expires_at', p_membership_access_expires_at,
    'guest_sponsor_user_id', p_guest_sponsor_user_id
  );
exception when invalid_text_representation then
  raise exception 'issued invitation is invalid' using errcode = '22023';
end;
$$;

create or replace function private.redeem_organization_invite_impl(
  p_token text,
  p_employee_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text;
  v_phone text;
  v_email_verified boolean;
  v_phone_verified boolean;
  v_invitation public.organization_invites%rowtype;
  v_user_rate_allowed boolean;
  v_token_rate_allowed boolean;
begin
  if v_user_id is null then
    raise exception 'valid signed-in invitation redemption required'
      using errcode = '42501';
  end if;
  -- Consume actor and token budgets before revealing whether either secret is
  -- well formed or exists. This direct authenticated RPC therefore cannot be
  -- used for unbounded employee-code guesses or cheap database hash abuse.
  v_user_rate_allowed := private.consume_rate_limit(
    'invite-redeem-user-15m', v_user_id::text, 20, 900
  ) and private.consume_rate_limit(
    'invite-redeem-user-day', v_user_id::text, 100, 86400
  );
  v_token_rate_allowed := private.consume_rate_limit(
    'invite-redeem-token-15m', coalesce(p_token, '<missing>'), 10, 900
  );
  if not v_user_rate_allowed or not v_token_rate_allowed
    or coalesce(p_token, '') !~ '^[0-9a-f]{64}$'
    or (p_employee_code is not null
      and p_employee_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$') then
    raise exception 'valid signed-in invitation redemption required'
      using errcode = '42501';
  end if;
  select lower(auth_user.email), auth_user.phone,
      auth_user.email_confirmed_at is not null,
      auth_user.phone_confirmed_at is not null
    into v_email, v_phone, v_email_verified, v_phone_verified
  from auth.users auth_user
  where auth_user.id = v_user_id and auth_user.deleted_at is null;
  if not found then
    raise exception 'verified invitation identity required' using errcode = '42501';
  end if;
  select * into v_invitation
  from public.organization_invites invitation
  where invitation.token_hash = extensions.digest(
    convert_to(p_token, 'UTF8'), 'sha256'
  )
  for update;
  if not found
    or v_invitation.invited_user_id is distinct from v_user_id
    or not coalesce(case v_invitation.destination_type
      when 'email' then v_email_verified
        and v_invitation.destination = v_email::extensions.citext
      when 'phone' then v_phone_verified
        and v_invitation.destination = v_phone::extensions.citext
      else false end, false)
    or not (
      (v_invitation.employee_code_hash is null and p_employee_code is null)
      or (
        v_invitation.employee_code_hash is not null
        and p_employee_code is not null
        and v_invitation.employee_code_hash = extensions.digest(
          convert_to(p_employee_code, 'UTF8'), 'sha256'
        )
      )
    )
    or v_invitation.revoked_at is not null
    or v_invitation.accepted_at is not null
    or v_invitation.use_count <> 0 or v_invitation.max_uses <> 1
    or v_invitation.expires_at <= now()
    or (v_invitation.membership_access_expires_at is not null
      and v_invitation.membership_access_expires_at <= now()) then
    raise exception 'invitation is invalid or expired' using errcode = '42501';
  end if;
  insert into public.organization_memberships (
    organization_id, user_id, role, status, invited_by_user_id,
    directory_visibility, membership_type, access_expires_at,
    guest_sponsor_user_id
  ) values (
    v_invitation.organization_id, v_user_id, v_invitation.role, 'active',
    v_invitation.created_by_user_id,
    case when v_invitation.membership_type = 'guest'
      then 'private' else 'organization' end,
    v_invitation.membership_type,
    v_invitation.membership_access_expires_at,
    v_invitation.guest_sponsor_user_id
  );
  perform set_config('app.invite_redemption_context', 'on', true);
  update public.organization_invites invitation
  set use_count = 1, accepted_by_user_id = v_user_id, accepted_at = now()
  where invitation.id = v_invitation.id;
  return jsonb_build_object(
    'organization_id', v_invitation.organization_id,
    'user_id', v_user_id,
    'role', v_invitation.role,
    'membership_type', v_invitation.membership_type,
    'access_expires_at', v_invitation.membership_access_expires_at,
    'redeemed', true
  );
end;
$$;

-- Expiration is part of every session and BFF authorization decision. A stale
-- JWT therefore cannot preserve an expired contractor or guest membership.
create or replace function private.current_session_active_for_org(
  p_organization_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_claim text := (select auth.jwt() ->> 'session_id');
  v_session_id uuid;
begin
  if v_user_id is null
    or coalesce(v_session_claim, '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_session_id := v_session_claim::uuid;
  return private.organization_membership_access_current(
    p_organization_id, v_user_id, now()
  ) and exists (
    select 1
    from auth.sessions session
    join auth.users auth_user on auth_user.id = session.user_id
    join private.session_installations binding
      on binding.session_id = session.id
     and binding.user_id = session.user_id
     and binding.revoked_at is null
    where session.id = v_session_id
      and session.user_id = v_user_id
      and (session.not_after is null or session.not_after > now())
      and (auth_user.banned_until is null or auth_user.banned_until <= now())
      and not exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = p_organization_id
          and revocation.session_id = session.id
      )
  );
exception when invalid_text_representation then
  return false;
end;
$$;

create or replace function private.authorize_bff_request_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_require_aal2 boolean,
  p_recent_auth_seconds integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_aal text;
  v_session_created_at timestamptz;
  v_not_after timestamptz;
  v_banned_until timestamptz;
  v_revocation_generation bigint;
begin
  if p_actor_user_id is null or p_organization_id is null or p_session_id is null
    or char_length(coalesce(p_operation, '')) not between 1 and 160
    or p_recent_auth_seconds not between 0 and 86400 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_request_context');
  end if;

  select membership.revocation_generation into v_revocation_generation
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active'
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );
  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'inactive_membership');
  end if;

  select session.aal::text, session.created_at, session.not_after,
      auth_user.banned_until
    into v_aal, v_session_created_at, v_not_after, v_banned_until
  from auth.sessions session
  join auth.users auth_user on auth_user.id = session.user_id
  join private.session_installations binding
    on binding.session_id = session.id
   and binding.user_id = session.user_id
   and binding.revoked_at is null
  where session.id = p_session_id and session.user_id = p_actor_user_id;

  if not found
    or (v_not_after is not null and v_not_after <= now())
    or (v_banned_until is not null and v_banned_until > now())
    or exists (
      select 1 from private.session_revocations revocation
      where revocation.organization_id = p_organization_id
        and revocation.session_id = p_session_id
    ) then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_session');
  end if;
  if p_require_aal2 and v_aal <> 'aal2' then
    return jsonb_build_object('allowed', false, 'reason', 'aal2_required');
  end if;
  if p_recent_auth_seconds > 0
    and v_session_created_at < now() - make_interval(secs => p_recent_auth_seconds) then
    return jsonb_build_object('allowed', false, 'reason', 'recent_auth_required');
  end if;
  return jsonb_build_object(
    'allowed', true, 'actor_user_id', p_actor_user_id,
    'organization_id', p_organization_id, 'session_id', p_session_id,
    'aal', v_aal, 'revocation_generation', v_revocation_generation
  );
end;
$$;

create or replace function private.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_active_for_org(p_organization_id)
    and private.organization_membership_access_current(
      p_organization_id, (select auth.uid()), now()
    )
$$;

create or replace function private.is_org_admin(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_active_for_org(p_organization_id) and exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.membership_type <> 'guest'
      and (membership.access_expires_at is null or membership.access_expires_at > now())
      and membership.role in ('owner', 'admin')
      and (
        not organization.require_mfa_for_admins
        or coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      )
  )
$$;

create or replace function private.is_org_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_active_for_org(p_organization_id) and exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.membership_type <> 'guest'
      and (membership.access_expires_at is null or membership.access_expires_at > now())
      and membership.role = 'owner'
  )
$$;

create or replace function private.actor_has_permission(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_permission text,
  p_unit_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_legacy_role text;
  v_membership_type text;
begin
  select membership.role, membership.membership_type
    into v_legacy_role, v_membership_type
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );
  if not found or v_membership_type = 'guest' then return false; end if;
  if v_legacy_role in ('owner', 'admin') then return true; end if;
  return exists (
    select 1
    from public.organization_role_assignments assignment
    join public.organization_role_permissions permission
      on permission.role_name = assignment.role_name
     and permission.permission = p_permission
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_actor_user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
      and (
        assignment.scope_type = 'organization'
        or (
          p_unit_id is not null
          and assignment.scope_type = 'unit'
          and exists (
            with recursive scoped_units(id) as (
              select assignment.unit_id
              union
              select child.id
              from public.organization_units child
              join scoped_units parent on child.parent_unit_id = parent.id
              where child.organization_id = p_organization_id
            )
            select 1 from scoped_units where scoped_units.id = p_unit_id
          )
        )
      )
  );
end;
$$;

-- Capability/scoping projections must describe the same effective access that
-- authorization enforces. In particular, guests never advertise direct-chat
-- creation or inherited administrative role assignments.
create or replace function private.effective_capabilities_internal(
  p_actor_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with membership as (
    select member.role, member.membership_type
    from public.organization_memberships member
    where member.organization_id = p_organization_id
      and member.user_id = p_actor_user_id
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
  ), effective(capability) as (
    select capability from (values
      ('messaging.read'), ('message.send'), ('contacts.manage'),
      ('summary.request'), ('actions.propose'), ('attachments.upload')
    ) base(capability)
    where exists (select 1 from membership)
    union
    select 'conversation.direct.create'
    from public.organizations organization
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
      and exists (
        select 1 from membership where membership_type <> 'guest'
      )
    union
    select permission.permission
    from public.organization_role_assignments assignment
    join public.organization_role_permissions permission
      on permission.role_name = assignment.role_name
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_actor_user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
      and exists (
        select 1 from membership where membership_type <> 'guest'
      )
    union
    select permission.permission
    from public.organization_role_permissions permission
    where exists (
      select 1 from membership
      where membership_type <> 'guest' and role in ('owner', 'admin')
    )
  )
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb)
  from (select distinct capability from effective) deduplicated
$$;

create or replace function private.effective_scopes_internal(
  p_actor_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with membership as (
    select member.role, member.membership_type
    from public.organization_memberships member
    where member.organization_id = p_organization_id
      and member.user_id = p_actor_user_id
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
  ), assigned as (
    select assignment.id as assignment_id, assignment.role_name,
      assignment.scope_type, assignment.unit_id, assignment.expires_at,
      coalesce(jsonb_agg(permission.permission order by permission.permission),
        '[]'::jsonb) as permissions
    from public.organization_role_assignments assignment
    join public.organization_role_permissions permission
      on permission.role_name = assignment.role_name
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_actor_user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
      and exists (
        select 1 from membership where membership_type <> 'guest'
      )
    group by assignment.id, assignment.role_name, assignment.scope_type,
      assignment.unit_id, assignment.expires_at
  ), scopes as (
    select jsonb_build_object(
      'assignment_id', assigned.assignment_id,
      'role_name', assigned.role_name,
      'scope_type', assigned.scope_type,
      'unit_id', assigned.unit_id,
      'permissions', assigned.permissions,
      'expires_at', assigned.expires_at
    ) as scope, assigned.role_name, assigned.assignment_id
    from assigned
    union all
    select jsonb_build_object(
      'assignment_id', null,
      'role_name', 'legacy_' || membership.role,
      'scope_type', 'organization',
      'unit_id', null,
      'permissions', (
        select coalesce(jsonb_agg(permission.permission order by permission.permission),
          '[]'::jsonb)
        from public.organization_role_permissions permission
      ),
      'expires_at', null
    ), 'legacy_' || membership.role, null::uuid
    from membership
    where membership.membership_type <> 'guest'
      and membership.role in ('owner', 'admin')
  )
  select coalesce(jsonb_agg(scope order by role_name,
    assignment_id nulls first), '[]'::jsonb)
  from scopes
$$;

create or replace function private.is_conversation_member(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_active_for_org(p_organization_id) and exists (
    select 1
    from public.conversation_members member
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.user_id = (select auth.uid())
      and member.status = 'active'
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
  )
$$;

create or replace function private.is_conversation_admin(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_active_for_org(p_organization_id) and exists (
    select 1
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.user_id = (select auth.uid())
      and member.status = 'active'
      and member.role in ('owner', 'admin')
      and organization_member.status = 'active'
      and organization_member.membership_type <> 'guest'
      and (
        organization_member.access_expires_at is null
        or organization_member.access_expires_at > now()
      )
  )
$$;

create or replace function private.direct_pair_policy_permitted(
  p_organization_id uuid,
  p_first_user_id uuid,
  p_second_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organizations organization
    join public.organization_memberships first_member
      on first_member.organization_id = organization.id
     and first_member.user_id = p_first_user_id
    join public.organization_memberships second_member
      on second_member.organization_id = organization.id
     and second_member.user_id = p_second_user_id
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
      and p_first_user_id <> p_second_user_id
      and first_member.status = 'active'
      and second_member.status = 'active'
      and first_member.membership_type <> 'guest'
      and second_member.membership_type <> 'guest'
      and (first_member.access_expires_at is null or first_member.access_expires_at > now())
      and (second_member.access_expires_at is null or second_member.access_expires_at > now())
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and (
            (block.blocker_user_id = p_first_user_id and block.blocked_user_id = p_second_user_id)
            or (block.blocker_user_id = p_second_user_id and block.blocked_user_id = p_first_user_id)
          )
      )
      and case organization.dm_policy
        when 'directory_open' then true
        when 'request_first' then exists (
          select 1 from public.contact_connections connection
          where connection.organization_id = p_organization_id
            and connection.member_low_user_id = least(p_first_user_id, p_second_user_id)
            and connection.member_high_user_id = greatest(p_first_user_id, p_second_user_id)
            and connection.status = 'accepted'
        )
        when 'scoped_unit' then exists (
          select 1
          from public.organization_unit_members first_unit
          join public.organization_unit_members second_unit
            on second_unit.organization_id = first_unit.organization_id
           and second_unit.unit_id = first_unit.unit_id
           and second_unit.user_id = p_second_user_id
          where first_unit.organization_id = p_organization_id
            and first_unit.user_id = p_first_user_id
        )
        else false
      end
  )
$$;

-- External guests are explicitly invited into named groups. They never browse
-- organization-visible groups or self-expand their scope through join requests.
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
    join public.organizations organization
      on organization.id = conversation.organization_id
    join public.organization_memberships requester
      on requester.organization_id = conversation.organization_id
     and requester.user_id = p_actor_user_id
     and requester.membership_type <> 'guest'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and private.organization_membership_access_current(
        requester.organization_id, requester.user_id, now()
      )
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
        select 1 from public.dynamic_group_policies policy
        where policy.organization_id = conversation.organization_id
          and policy.conversation_id = conversation.id
      )
      and not exists (
        select 1 from public.conversation_members member
        where member.organization_id = conversation.organization_id
          and member.conversation_id = conversation.id
          and member.user_id = p_actor_user_id
          and member.status = 'active'
      )
  )
$$;

-- Canonical actor-aware directory rule. CHAT-04 calls this same signature for
-- search and policy-roster projections. Guests never receive a general
-- organization directory; private guest identities remain scoped to a sponsor,
-- an organization-level administrator, or a shared named conversation.
create or replace function private.can_view_org_member_for_actor(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_at timestamptz default now()
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_viewer public.organization_memberships%rowtype;
  v_target public.organization_memberships%rowtype;
  v_privileged boolean := false;
  v_shared_named_conversation boolean := false;
  v_contact_scope boolean := false;
begin
  if p_organization_id is null or p_actor_user_id is null
    or p_target_user_id is null or p_at is null or not isfinite(p_at) then
    return false;
  end if;
  select membership.* into v_viewer
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, p_at
    );
  select membership.* into v_target
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_target_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, p_at
    );
  if v_viewer.user_id is null or v_target.user_id is null then return false; end if;
  if p_actor_user_id = p_target_user_id then return true; end if;

  v_privileged := v_viewer.membership_type <> 'guest' and (
    v_viewer.role in ('owner', 'admin')
    or private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'directory.read', null
    )
    or private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'conversation.manage', null
    )
  );
  select exists (
    select 1
    from public.conversation_members viewer_member
    join public.conversation_members target_member
      on target_member.organization_id = viewer_member.organization_id
     and target_member.conversation_id = viewer_member.conversation_id
     and target_member.user_id = p_target_user_id
     and target_member.status = 'active'
    join public.conversations conversation
      on conversation.organization_id = viewer_member.organization_id
     and conversation.id = viewer_member.conversation_id
    where viewer_member.organization_id = p_organization_id
      and viewer_member.user_id = p_actor_user_id
      and viewer_member.status = 'active'
      and conversation.kind in ('group', 'team', 'shift', 'incident')
      and char_length(btrim(coalesce(conversation.name, ''))) > 0
      and not conversation.is_archived
      and not exists (
        select 1 from public.dynamic_group_policies policy
        where policy.organization_id = conversation.organization_id
          and policy.conversation_id = conversation.id
      )
  ) into v_shared_named_conversation;
  select exists (
    select 1 from public.contact_connections connection
    where connection.organization_id = p_organization_id
      and connection.member_low_user_id = least(
        p_actor_user_id, p_target_user_id
      )
      and connection.member_high_user_id = greatest(
        p_actor_user_id, p_target_user_id
      )
      and connection.status in ('pending', 'accepted')
  ) into v_contact_scope;

  if v_target.membership_type = 'guest' then
    return v_viewer.membership_type <> 'guest' and (
      v_target.guest_sponsor_user_id = p_actor_user_id
      or v_privileged
      or v_shared_named_conversation
    );
  end if;
  if v_viewer.membership_type = 'guest' then
    return v_shared_named_conversation;
  end if;
  if v_privileged or v_shared_named_conversation then return true; end if;
  if exists (
    select 1 from public.member_blocks block
    where block.organization_id = p_organization_id
      and (
        (block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = p_target_user_id)
        or (block.blocker_user_id = p_target_user_id
          and block.blocked_user_id = p_actor_user_id)
      )
  ) then return false; end if;
  if v_contact_scope then return true; end if;
  if v_target.directory_visibility = 'organization' then return true; end if;
  return v_target.directory_visibility = 'unit' and exists (
    select 1
    from public.organization_unit_members viewer_unit
    join public.organization_unit_members target_unit
      on target_unit.organization_id = viewer_unit.organization_id
     and target_unit.unit_id = viewer_unit.unit_id
     and target_unit.user_id = p_target_user_id
    where viewer_unit.organization_id = p_organization_id
      and viewer_unit.user_id = p_actor_user_id
  );
end;
$$;

-- Contact and block mutations are BFF commands, not identity-discovery
-- oracles. Require the same current, visible target that the directory exposed
-- before allowing a new relationship row.
create or replace function private.validate_identity_relationship_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_target_user_id uuid;
begin
  if tg_table_name = 'contact_connections' then
    v_target_user_id := case when new.member_low_user_id = v_actor_user_id
      then new.member_high_user_id else new.member_low_user_id end;
    if new.requested_by_user_id is distinct from v_actor_user_id
      or v_actor_user_id not in (new.member_low_user_id, new.member_high_user_id) then
      raise exception 'visible relationship target required' using errcode = '42501';
    end if;
  elsif tg_table_name = 'member_blocks' then
    if new.blocker_user_id is distinct from v_actor_user_id then
      raise exception 'visible relationship target required' using errcode = '42501';
    end if;
    v_target_user_id := new.blocked_user_id;
  else
    raise exception 'unsupported identity relationship' using errcode = '42501';
  end if;
  if v_actor_user_id is null or v_target_user_id is null
    or v_target_user_id = v_actor_user_id
    or not private.current_session_active_for_org(new.organization_id)
    or not private.can_view_org_member_for_actor(
      new.organization_id, v_actor_user_id, v_target_user_id, now()
    ) then
    raise exception 'visible relationship target required' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger contact_connections_05_validate_current_scope
before insert on public.contact_connections
for each row execute function private.validate_identity_relationship_target();

create trigger member_blocks_05_validate_current_scope
before insert on public.member_blocks
for each row execute function private.validate_identity_relationship_target();

-- Raw authenticated table policies use the legacy two-argument hook. Route it
-- through the same explicit-actor rule as every BFF projection so a guest,
-- expired contractor, or stale session cannot use the Data API as a second
-- directory with broader visibility.
create or replace function private.can_view_org_member(
  p_organization_id uuid,
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and private.current_session_active_for_org(p_organization_id)
    and private.can_view_org_member_for_actor(
      p_organization_id, (select auth.uid()), p_target_user_id, now()
    )
$$;

create or replace function private.can_view_organization_units(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and private.current_session_active_for_org(p_organization_id)
    and exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = (select auth.uid())
        and membership.membership_type <> 'guest'
        and private.organization_membership_access_current(
          membership.organization_id, membership.user_id, now()
        )
    )
$$;

drop policy organization_units_select_member on public.organization_units;
create policy organization_units_select_internal_member
on public.organization_units for select
to authenticated
using ((select private.can_view_organization_units(organization_id)));

drop policy organization_unit_members_select_visible
on public.organization_unit_members;
create policy organization_unit_members_select_internal_visible
on public.organization_unit_members for select
to authenticated
using (
  (select private.can_view_organization_units(organization_id))
  and (select private.can_view_org_member(organization_id, user_id))
);

create or replace function private.validate_guest_conversation_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text;
  v_expires_at timestamptz;
  v_allow_guests boolean;
  v_kind text;
  v_name text;
  v_dynamic boolean;
begin
  select membership.membership_type, membership.access_expires_at,
      organization.allow_external_guests
    into v_type, v_expires_at, v_allow_guests
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = new.organization_id
    and membership.user_id = new.user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );
  if new.status <> 'active' then return new; end if;
  if not found then
    raise exception 'current organization membership is required'
      using errcode = '42501';
  end if;
  if v_type is distinct from 'guest' then return new; end if;
  select conversation.kind, conversation.name,
      exists (
        select 1 from public.dynamic_group_policies policy
        where policy.organization_id = conversation.organization_id
          and policy.conversation_id = conversation.id
      )
    into v_kind, v_name, v_dynamic
  from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id;
  if not v_allow_guests
    or v_expires_at is null or v_expires_at <= now()
    or v_kind not in ('group', 'team', 'shift', 'incident')
    or char_length(btrim(coalesce(v_name, ''))) < 1
    or new.role <> 'member'
    or coalesce(v_dynamic, false) then
    raise exception 'external guest is not permitted in this conversation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger conversation_members_07_validate_guest_scope
before insert or update of role, status on public.conversation_members
for each row execute function private.validate_guest_conversation_membership();

create or replace function private.actor_can_create_group(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_unit_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.membership_type <> 'guest'
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and case organization.group_creation_policy
        when 'members' then true
        when 'managers' then membership.role in ('owner', 'admin', 'manager')
          or private.actor_has_permission(
            p_actor_user_id, p_organization_id, 'conversation.manage', p_unit_id
          )
        when 'admins' then membership.role in ('owner', 'admin')
          or private.actor_has_permission(
            p_actor_user_id, p_organization_id, 'conversation.manage', p_unit_id
          )
        else false
      end
  )
$$;

create or replace function private.bff_list_group_creation_candidates_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    'avatar_path', candidate.avatar_path,
    'job_title', candidate.job_title,
    'membership_role', candidate.membership_role,
    'membership_type', candidate.membership_type,
    'access_expires_at', candidate.access_expires_at
  ) order by candidate.display_name, candidate.user_id), '[]'::jsonb)
  into v_candidates
  from (
    select membership.user_id, profile.display_name, profile.avatar_path,
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
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or private.normalize_search_text(profile.display_name) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'
        or private.normalize_search_text(coalesce(membership.job_title, '')) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'
      )
    order by profile.display_name, membership.user_id
    limit p_limit
  ) candidate;
  return jsonb_build_object('candidates', v_candidates, 'limit', p_limit);
end;
$$;

-- Expand the trusted system-event vocabulary so membership changes are visible
-- in the conversation without admitting arbitrary client-authored system rows.
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
    -- Serialize ordinary sends and trusted system events against departure.
    -- System events require active membership but do not require can_post,
    -- because an administrator may be recording the transition that made a
    -- policy-managed conversation read-only.
    perform member.user_id
    from public.conversation_members member
    where member.organization_id = new.organization_id
      and member.conversation_id = new.conversation_id
      and member.user_id = v_actor_id
      and member.status = 'active'
      and (new.kind = 'system' or member.can_post)
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
    for share of member;
    if not found then
      raise exception 'active conversation membership with posting access is required'
        using errcode = '42501';
    end if;
  end if;
  if v_jwt_role <> 'service_role' and new.kind = 'system'
    and not (
      coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
      and v_actor_id is not null
      and new.sender_user_id = v_actor_id
      and new.body is null
      and new.language_detection_state = 'not_applicable'
      and new.language_detected_at is not null
      and (
        (
          (new.metadata ->> 'event_type') in (
            'conversation.posting.admins_only',
            'conversation.posting.all_members',
            'conversation.join.approved',
            'conversation.created',
            'conversation.member.added',
            'conversation.member.removed',
            'conversation.member.role_changed',
            'conversation.avatar.changed',
            'conversation.avatar.removed'
          )
          and not exists (
            select 1 from jsonb_object_keys(new.metadata) metadata_key
            where metadata_key not in ('event_type', 'target_user_id')
          )
          and case
            when new.metadata ->> 'event_type' in (
              'conversation.member.added', 'conversation.member.removed',
              'conversation.member.role_changed', 'conversation.join.approved'
            ) then coalesce(new.metadata ->> 'target_user_id', '') ~*
              '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            else not (new.metadata ? 'target_user_id')
          end
        )
        or (
          new.metadata ->> 'event_type' = 'dynamic_group.policy.paused'
          and jsonb_typeof(new.metadata -> 'policy_version') = 'number'
          and (new.metadata ->> 'policy_version') ~ '^[1-9][0-9]{0,9}$'
          and not exists (
            select 1 from jsonb_object_keys(new.metadata) metadata_key
            where metadata_key not in ('event_type', 'policy_version')
          )
        )
        or (
          new.metadata ->> 'event_type' = 'dynamic_group.policy.published'
          and jsonb_typeof(new.metadata -> 'policy_version') = 'number'
          and jsonb_typeof(new.metadata -> 'added_count') = 'number'
          and jsonb_typeof(new.metadata -> 'removed_count') = 'number'
          and jsonb_typeof(new.metadata -> 'unchanged_count') = 'number'
          and (new.metadata ->> 'policy_version') ~ '^[1-9][0-9]{0,9}$'
          and (new.metadata ->> 'added_count') ~ '^(0|[1-9][0-9]{0,9})$'
          and (new.metadata ->> 'removed_count') ~ '^(0|[1-9][0-9]{0,9})$'
          and (new.metadata ->> 'unchanged_count') ~ '^(0|[1-9][0-9]{0,9})$'
          and not exists (
            select 1 from jsonb_object_keys(new.metadata) metadata_key
            where metadata_key not in (
              'event_type', 'policy_version', 'added_count',
              'removed_count', 'unchanged_count'
            )
          )
        )
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

create or replace function private.insert_conversation_system_event_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_event_type text,
  p_target_user_id uuid default null
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_message_id bigint;
begin
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
    or (select auth.uid()) is distinct from p_actor_user_id
    or p_event_type not in (
      'conversation.posting.admins_only', 'conversation.posting.all_members',
      'conversation.join.approved', 'conversation.created',
      'conversation.member.added', 'conversation.member.removed',
      'conversation.member.role_changed', 'conversation.avatar.changed',
      'conversation.avatar.removed'
    )
    or (
      p_event_type in (
        'conversation.member.added', 'conversation.member.removed',
        'conversation.member.role_changed', 'conversation.join.approved'
      ) and p_target_user_id is null
    )
    or (
      p_event_type in (
        'conversation.posting.admins_only',
        'conversation.posting.all_members', 'conversation.created',
        'conversation.avatar.changed', 'conversation.avatar.removed'
      ) and p_target_user_id is not null
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
  p_organization_id uuid,
  p_conversation_id uuid,
  p_target_user_id uuid,
  p_reason text
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
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
    or p_reason not in (
      'conversation_controls_changed', 'join_requested', 'join_cancelled',
      'join_approved', 'join_rejected', 'member_added', 'member_removed',
      'member_role_changed'
    ) then
    raise exception 'trusted conversation invalidation required'
      using errcode = '42501';
  end if;
  for v_recipient in
    select distinct recipient.user_id
    from (
      select member.user_id
      from public.conversation_members member
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.status = 'active'
        and private.organization_membership_access_current(
          member.organization_id, member.user_id, now()
        )
        and (
          p_reason in (
            'conversation_controls_changed', 'join_approved', 'member_added',
            'member_removed', 'member_role_changed'
          ) or member.role in ('owner', 'admin')
        )
      union all
      select p_target_user_id
      where p_target_user_id is not null
        and private.organization_membership_access_current(
          p_organization_id, p_target_user_id, now()
        )
    ) recipient
  loop
    perform realtime.send(jsonb_build_object(
      'schema_version', 1, 'event_id', v_event_id,
      'event', 'workspace.invalidated',
      'organization_id', p_organization_id, 'occurred_at', v_occurred_at,
      'conversation_id', p_conversation_id,
      'entity_type', 'conversation_control',
      'entity_id', p_conversation_id, 'version_id', null,
      'reason', p_reason
    ), 'workspace.invalidated', 'org:' || p_organization_id::text || ':user:'
      || v_recipient.user_id::text || ':inbox', true);
  end loop;
end;
$$;

create or replace function private.validate_conversation_avatar_path_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.avatar_path is distinct from old.avatar_path
    and coalesce(
      current_setting('app.conversation_avatar_context', true), 'off'
    ) <> 'on' then
    raise exception 'conversation avatars require the scanned activation workflow'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger conversations_05_validate_avatar_path_change
before update of avatar_path on public.conversations
for each row execute function private.validate_conversation_avatar_path_change();

create or replace function private.preserve_active_conversation_avatar_message()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null and exists (
    select 1
    from public.message_attachments attachment
    join public.conversations conversation
      on conversation.organization_id = attachment.organization_id
     and conversation.id = attachment.conversation_id
     and conversation.avatar_path = attachment.storage_path
    where attachment.organization_id = old.organization_id
      and attachment.conversation_id = old.conversation_id
      and attachment.message_id = old.id
      and attachment.scan_status = 'clean'
  ) then
    raise exception 'active conversation avatar must be replaced or removed first'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger messages_06_preserve_active_conversation_avatar
before update of deleted_at on public.messages
for each row execute function private.preserve_active_conversation_avatar_message();

-- Avatar uploads use the attachment scanner, but they are control-plane
-- candidates rather than chat messages. Keep their backing messages permanently
-- unavailable to the ordinary timeline/storage predicates. The currently active
-- avatar is read only through the dedicated current-path authorizer below.
-- Candidates that never become active expire after 24 hours; the existing
-- retention update trigger then quarantines the attachment and enqueues its
-- storage object for purge.
create index messages_avatar_candidate_retention_idx
  on public.messages (created_at, id)
  where deleted_at is null
    and metadata ->> 'purpose' = 'conversation_avatar';

create or replace function private.scrub_conversation_avatar_candidates_internal(
  p_batch_size integer,
  p_at timestamptz default now()
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scrubbed integer;
begin
  perform private.require_service_role();
  if p_batch_size not between 1 and 5000
    or p_at is null or not isfinite(p_at) then
    raise exception 'invalid conversation avatar retention request'
      using errcode = '22023';
  end if;
  with candidates as (
    select message.id
    from public.messages message
    where message.deleted_at is null
      and message.metadata = jsonb_build_object('purpose', 'conversation_avatar')
      and message.created_at < p_at - interval '24 hours'
      and not exists (
        select 1
        from public.message_attachments attachment
        join public.conversations conversation
          on conversation.organization_id = attachment.organization_id
         and conversation.id = attachment.conversation_id
         and conversation.avatar_path = attachment.storage_path
        where attachment.organization_id = message.organization_id
          and attachment.conversation_id = message.conversation_id
          and attachment.message_id = message.id
      )
    order by message.created_at, message.id
    for update of message skip locked
    limit p_batch_size
  ), scrubbed as (
    update public.messages message
    set deleted_at = now()
    from candidates
    where message.id = candidates.id
    returning message.id
  )
  select count(*) into v_scrubbed from scrubbed;
  return v_scrubbed;
end;
$$;

-- Preserve the existing organization retention contract while prioritizing the
-- much shorter avatar-candidate TTL. Active avatar backing messages are excluded
-- from both passes so one old avatar cannot block the whole retention batch.
create or replace function private.bff_scrub_retention_impl(p_batch_size integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_avatar_scrubbed integer;
  v_message_scrubbed integer := 0;
  v_remaining integer;
begin
  perform private.require_service_role();
  if p_batch_size not between 1 and 5000 then
    raise exception 'invalid retention batch size' using errcode = '22023';
  end if;
  v_avatar_scrubbed := private.scrub_conversation_avatar_candidates_internal(
    p_batch_size, now()
  );
  v_remaining := p_batch_size - v_avatar_scrubbed;
  if v_remaining > 0 then
    with candidates as (
      select message.id
      from public.messages message
      join public.organizations organization
        on organization.id = message.organization_id
      where message.deleted_at is null
        and message.created_at
          < now() - make_interval(days => organization.message_retention_days)
        and not exists (
          select 1
          from public.message_attachments attachment
          join public.conversations conversation
            on conversation.organization_id = attachment.organization_id
           and conversation.id = attachment.conversation_id
           and conversation.avatar_path = attachment.storage_path
          where attachment.organization_id = message.organization_id
            and attachment.conversation_id = message.conversation_id
            and attachment.message_id = message.id
        )
      order by message.created_at, message.id
      for update of message skip locked
      limit v_remaining
    ), scrubbed as (
      update public.messages message
      set deleted_at = now()
      from candidates
      where message.id = candidates.id
      returning message.id
    )
    select count(*) into v_message_scrubbed from scrubbed;
  end if;
  return jsonb_build_object(
    'scrubbed_messages', v_avatar_scrubbed + v_message_scrubbed,
    'scrubbed_avatar_candidates', v_avatar_scrubbed
  );
end;
$$;

create or replace function private.bff_create_conversation_avatar_upload_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256_hex text,
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
  v_attachment_id uuid := gen_random_uuid();
  v_message_id bigint;
  v_storage_path text;
  v_hour_bytes bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.avatar.upload.create', false, 0,
    '/v2/conversations/:id/avatar/grants',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id)
    or not exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.kind in ('group', 'team', 'shift', 'incident')
        and not conversation.is_archived
        and conversation.closed_at is null
    ) then
    raise exception 'active group administrator permission required'
      using errcode = '42501';
  end if;
  if char_length(coalesce(p_file_name, '')) not between 1 and 255
    or p_file_name ~ '[/\\]'
    or p_mime_type is null
    or lower(p_mime_type) not in ('image/jpeg', 'image/png', 'image/webp')
    or p_byte_size not between 1 and 5242880
    or coalesce(p_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid conversation avatar upload metadata'
      using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'avatar-upload-minute',
    p_organization_id::text || ':' || p_actor_user_id::text, 5, 60
  ) then
    raise exception 'conversation avatar upload rate limit exceeded'
      using errcode = 'P0001';
  end if;
  select coalesce(sum(attachment.byte_size), 0) into v_hour_bytes
  from public.message_attachments attachment
  join public.messages message
    on message.organization_id = attachment.organization_id
   and message.conversation_id = attachment.conversation_id
   and message.id = attachment.message_id
  where attachment.organization_id = p_organization_id
    and attachment.created_by_user_id = p_actor_user_id
    and attachment.created_at >= now() - interval '1 hour'
    and message.metadata ->> 'purpose' = 'conversation_avatar';
  if v_hour_bytes + p_byte_size > 52428800 then
    raise exception 'conversation avatar hourly byte quota exceeded'
      using errcode = 'P0001';
  end if;

  insert into public.messages (
    organization_id, conversation_id, sender_user_id, kind, body,
    language_detection_state, language_detection_method,
    language_detected_at, available_at, metadata
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id, 'attachment', null,
    'not_applicable', 'system', now(),
    'infinity'::timestamptz,
    jsonb_build_object('purpose', 'conversation_avatar')
  ) returning id into v_message_id;
  v_storage_path := p_organization_id::text || '/' || p_conversation_id::text
    || '/' || p_actor_user_id::text || '/' || v_attachment_id::text || '/upload';
  insert into public.message_attachments (
    id, organization_id, conversation_id, message_id, created_by_user_id,
    storage_path, file_name, mime_type, byte_size, sha256_hex
  ) values (
    v_attachment_id, p_organization_id, p_conversation_id, v_message_id,
    p_actor_user_id, v_storage_path, p_file_name, lower(p_mime_type),
    p_byte_size, p_sha256_hex
  );
  v_response := jsonb_build_object(
    'attachment_id', v_attachment_id,
    'message_id', v_message_id,
    'bucket_id', 'message-attachments',
    'storage_path', v_storage_path,
    'scan_status', 'pending',
    'maximum_byte_size', 5242880
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversations/:id/avatar/grants',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_activate_conversation_avatar_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_attachment_id uuid,
  p_expected_avatar_path text,
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
  v_attachment public.message_attachments%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.avatar.activate', false, 0,
    '/v2/conversations/:id/avatar/:attachmentId/activate',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'group administrator permission required' using errcode = '42501';
  end if;
  select conversation.* into v_conversation
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift', 'incident')
    and not conversation.is_archived
    and conversation.closed_at is null
  for update;
  if not found then
    raise exception 'active group conversation required' using errcode = '42501';
  end if;
  if v_conversation.avatar_path is distinct from p_expected_avatar_path then
    raise exception 'conversation avatar version conflict' using errcode = '40001';
  end if;
  select attachment.* into v_attachment
  from public.message_attachments attachment
  join public.messages message
    on message.organization_id = attachment.organization_id
   and message.conversation_id = attachment.conversation_id
   and message.id = attachment.message_id
  where attachment.organization_id = p_organization_id
    and attachment.conversation_id = p_conversation_id
    and attachment.id = p_attachment_id
    and attachment.created_by_user_id = p_actor_user_id
    and attachment.scan_status = 'clean'
    and attachment.mime_type in ('image/jpeg', 'image/png', 'image/webp')
    and attachment.detected_mime_type = attachment.mime_type
    and message.deleted_at is null
    and message.metadata = jsonb_build_object('purpose', 'conversation_avatar')
  for update of attachment;
  if not found then
    raise exception 'clean actor-owned conversation avatar upload required'
      using errcode = '42501';
  end if;
  perform set_config('app.conversation_avatar_context', 'on', true);
  update public.conversations conversation
  set avatar_path = v_attachment.storage_path
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  perform set_config('app.conversation_avatar_context', 'off', true);
  perform private.insert_conversation_system_event_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    'conversation.avatar.changed', null
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.avatar.changed',
    'conversation', p_conversation_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'attachment_id', p_attachment_id,
      'previous_avatar_path', v_conversation.avatar_path,
      'avatar_path', v_attachment.storage_path
    ))
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'attachment_id', p_attachment_id,
    'avatar_path', v_attachment.storage_path,
    'previous_avatar_path', v_conversation.avatar_path,
    'activated', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversations/:id/avatar/:attachmentId/activate',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_remove_conversation_avatar_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_expected_avatar_path text,
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
  v_current_avatar_path text;
  v_is_archived boolean;
  v_closed_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.avatar.remove', false, 0,
    '/v2/conversations/:id/avatar', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'group administrator permission required' using errcode = '42501';
  end if;
  select conversation.avatar_path, conversation.is_archived,
      conversation.closed_at
    into v_current_avatar_path, v_is_archived, v_closed_at
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift', 'incident')
  for update;
  if not found then raise exception 'group conversation not found' using errcode = 'P0002'; end if;
  if v_current_avatar_path is distinct from p_expected_avatar_path
    or v_current_avatar_path is null then
    raise exception 'conversation avatar version conflict' using errcode = '40001';
  end if;
  -- Removal remains available after archive/closure as a deliberate
  -- data-minimization escape hatch. It is still admin-only, CAS-bound, visible
  -- to the conversation, and the audit row below records that lifecycle override.
  perform set_config('app.conversation_avatar_context', 'on', true);
  update public.conversations conversation set avatar_path = null
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  perform set_config('app.conversation_avatar_context', 'off', true);
  perform private.insert_conversation_system_event_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    'conversation.avatar.removed', null
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.avatar.removed',
    'conversation', p_conversation_id::text,
    jsonb_build_object(
      'previous_avatar_path', v_current_avatar_path,
      'reason', 'data_minimization',
      'lifecycle_override', v_is_archived or v_closed_at is not null
    )
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'previous_avatar_path', v_current_avatar_path,
    'avatar_path', null,
    'removed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/avatar',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_authorize_conversation_avatar_download_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_attachment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.avatar.download.authorize', false, 0
  );
  select jsonb_build_object(
    'authorized', true,
    'conversation_id', conversation.id,
    'attachment_id', attachment.id,
    'bucket_id', attachment.bucket_id,
    'storage_path', attachment.storage_path,
    'mime_type', attachment.mime_type,
    'byte_size', attachment.byte_size
  ) into v_result
  from public.conversations conversation
  join public.message_attachments attachment
    on attachment.organization_id = conversation.organization_id
   and attachment.conversation_id = conversation.id
   and attachment.storage_path = conversation.avatar_path
  join public.messages message
    on message.organization_id = attachment.organization_id
   and message.conversation_id = attachment.conversation_id
   and message.id = attachment.message_id
   and message.deleted_at is null
   and message.metadata = jsonb_build_object('purpose', 'conversation_avatar')
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'clean'
    and attachment.detected_mime_type = attachment.mime_type
    and private.dynamic_group_conversation_access_allowed_for_user(
      attachment.organization_id, attachment.conversation_id,
      p_actor_user_id, now()
    )
    and (
      not private.dynamic_group_policy_conversation(
        attachment.organization_id, attachment.conversation_id
      )
      or private.dynamic_group_user_currently_eligible(
        attachment.organization_id, attachment.conversation_id,
        p_actor_user_id, now()
      )
    );
  if not found then return jsonb_build_object('authorized', false); end if;
  return v_result;
end;
$$;

-- Generic attachment delivery must never become a second route to an avatar
-- candidate. The dedicated avatar authorizer above additionally proves that the
-- clean object is still the conversation's current avatar.
create or replace function private.storage_download_authorized(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or char_length(coalesce(p_name, '')) not between 1 and 1024 then
    return false;
  end if;
  return exists (
    select 1
    from public.message_attachments attachment
    join public.messages message
      on message.organization_id = attachment.organization_id
     and message.conversation_id = attachment.conversation_id
     and message.id = attachment.message_id
    where attachment.bucket_id = 'message-attachments'
      and attachment.storage_path = p_name
      and attachment.scan_status = 'clean'
      and message.metadata ->> 'purpose' is distinct from 'conversation_avatar'
      and private.current_session_active_for_org(attachment.organization_id)
      and private.dynamic_group_message_access_allowed_for_user(
        attachment.organization_id, attachment.conversation_id,
        attachment.message_id, v_user_id, now()
      )
  );
end;
$$;

create or replace function private.bff_authorize_attachment_download_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_result jsonb;
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.download.authorize', false, 0
  );
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal'
  );
  select jsonb_build_object(
    'authorized', true,
    'attachment_id', attachment.id,
    'bucket_id', attachment.bucket_id,
    'storage_path', attachment.storage_path,
    'file_name', attachment.file_name,
    'mime_type', attachment.mime_type,
    'byte_size', attachment.byte_size
  ) into v_result
  from public.message_attachments attachment
  join public.messages message
    on message.organization_id = attachment.organization_id
   and message.conversation_id = attachment.conversation_id
   and message.id = attachment.message_id
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'clean'
    and message.metadata ->> 'purpose' is distinct from 'conversation_avatar'
    and private.dynamic_group_message_access_allowed_for_user(
      attachment.organization_id, attachment.conversation_id,
      attachment.message_id, p_actor_user_id, now()
    );
  perform private.clear_bff_actor_context_internal();
  if v_result is null then return jsonb_build_object('authorized', false); end if;
  return v_result;
exception when others then
  perform private.clear_bff_actor_context_internal();
  raise;
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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.add', false, 0, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('owner', 'admin', 'member') then
    raise exception 'invalid conversation role' using errcode = '22023';
  end if;
  if not private.organization_membership_access_current(
    p_organization_id, p_target_user_id, now()
  ) or not private.can_view_org_member_for_actor(
    p_organization_id, p_actor_user_id, p_target_user_id, now()
  ) then
    raise exception 'current organization member required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind in ('group', 'team', 'shift', 'incident')
      and not conversation.is_archived
      and conversation.closed_at is null
  ) then
    raise exception 'open named group required' using errcode = '42501';
  end if;

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
  perform private.insert_conversation_system_event_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    'conversation.member.added', p_target_user_id
  );
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, p_target_user_id, 'member_added'
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'role', p_role,
    'history_disclosure', (
      select jsonb_build_object(
        'policy', conversation.history_policy,
        'visible_from', membership.history_visible_from,
        'label_key', case when conversation.history_policy = 'all'
          then 'conversation.history.all' else 'conversation.history.since_join' end
      )
      from public.conversations conversation
      join public.conversation_members membership
        on membership.organization_id = conversation.organization_id
       and membership.conversation_id = conversation.id
       and membership.user_id = p_target_user_id
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
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
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;
  update public.conversation_members membership
  set status = 'removed', left_at = now()
  where membership.organization_id = p_organization_id
    and membership.conversation_id = p_conversation_id
    and membership.user_id = p_target_user_id
    and membership.status = 'active';
  if not found then
    raise exception 'active conversation member not found' using errcode = 'P0002';
  end if;
  perform private.insert_conversation_system_event_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    'conversation.member.removed', p_target_user_id
  );
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

create or replace function private.bff_update_conversation_member_role_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_target_user_id uuid,
  p_expected_role text,
  p_new_role text,
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
  v_current_role text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.role.update', true, 900,
    '/v2/conversations/:id/members/:membershipId/role',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;
  if p_expected_role is null or p_expected_role not in ('owner', 'admin', 'member')
    or p_new_role is null or p_new_role not in ('owner', 'admin', 'member')
    or p_expected_role = p_new_role then
    raise exception 'valid distinct conversation roles required'
      using errcode = '22023';
  end if;
  select membership.role into v_current_role
  from public.conversation_members membership
  where membership.organization_id = p_organization_id
    and membership.conversation_id = p_conversation_id
    and membership.user_id = p_target_user_id
    and membership.status = 'active'
  for update;
  if not found then
    raise exception 'active conversation member not found' using errcode = 'P0002';
  end if;
  if v_current_role <> p_expected_role then
    raise exception 'conversation membership role conflict' using errcode = '40001';
  end if;
  update public.conversation_members membership
  set role = p_new_role
  where membership.organization_id = p_organization_id
    and membership.conversation_id = p_conversation_id
    and membership.user_id = p_target_user_id
    and membership.status = 'active'
    and membership.role = p_expected_role;
  if not found then
    raise exception 'conversation membership role conflict' using errcode = '40001';
  end if;
  perform private.insert_conversation_system_event_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    'conversation.member.role_changed', p_target_user_id
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.member.role.changed',
    'conversation_member', p_target_user_id::text,
    jsonb_build_object(
      'conversation_id', p_conversation_id,
      'previous_role', p_expected_role,
      'new_role', p_new_role
    )
  );
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, p_target_user_id,
    'member_role_changed'
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'previous_role', p_expected_role,
    'role', p_new_role
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversations/:id/members/:membershipId/role',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.broadcast_organization_policy_internal(
  p_organization_id uuid
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
    raise exception 'trusted organization policy invalidation required'
      using errcode = '42501';
  end if;
  -- The durable organization_policy_version is authoritative. Realtime only
  -- accelerates refresh and therefore remains safely bounded for large tenants.
  for v_recipient in
    select membership.user_id
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
    order by membership.user_id
    limit 5000
  loop
    perform realtime.send(jsonb_build_object(
      'schema_version', 1,
      'event_id', v_event_id,
      'event', 'workspace.invalidated',
      'organization_id', p_organization_id,
      'occurred_at', v_occurred_at,
      'conversation_id', null,
      'entity_type', 'organization_policy',
      'entity_id', p_organization_id,
      'version_id', null,
      'reason', 'organization_policy_changed'
    ), 'workspace.invalidated', 'org:' || p_organization_id::text || ':user:'
      || v_recipient.user_id::text || ':inbox', true);
  end loop;
end;
$$;

create or replace function private.bff_update_organization_policy_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_message_retention_days integer,
  p_allow_member_direct_messages boolean,
  p_dm_policy text,
  p_require_mfa_for_admins boolean,
  p_shift_schedule_authoritative boolean,
  p_group_creation_policy text,
  p_allow_external_guests boolean,
  p_external_guest_max_access_days integer,
  p_expected_version bigint,
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
    'organization.policy.update', true, 300,
    '/v2/admin/organization-policy', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_message_retention_days is null
    or p_message_retention_days not between 1 and 3650
    or p_allow_member_direct_messages is null
    or p_dm_policy is null
    or p_dm_policy not in ('directory_open', 'request_first', 'scoped_unit')
    or p_require_mfa_for_admins is null
    or p_shift_schedule_authoritative is null
    or p_group_creation_policy is null
    or p_group_creation_policy not in ('members', 'managers', 'admins')
    or p_allow_external_guests is null
    or p_external_guest_max_access_days is null
    or p_external_guest_max_access_days not between 1 and 365
    or p_expected_version is null or p_expected_version < 1
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'valid complete organization policy and reason required'
      using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'organization-policy-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    10, 3600
  ) then
    raise exception 'organization policy update limit exceeded' using errcode = 'P0001';
  end if;

  select organization.* into v_old
  from public.organizations organization
  join public.organization_memberships membership
    on membership.organization_id = organization.id
   and membership.user_id = p_actor_user_id
   and membership.role = 'owner'
   and membership.membership_type <> 'guest'
  where organization.id = p_organization_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    )
  for update of organization, membership;
  if not found then
    raise exception 'organization owner permission required' using errcode = '42501';
  end if;
  if v_old.organization_policy_version <> p_expected_version then
    raise exception 'organization policy version conflict' using errcode = '40001';
  end if;
  if v_old.message_retention_days = p_message_retention_days
    and v_old.allow_member_direct_messages = p_allow_member_direct_messages
    and v_old.dm_policy = p_dm_policy
    and v_old.require_mfa_for_admins = p_require_mfa_for_admins
    and v_old.shift_schedule_authoritative = p_shift_schedule_authoritative
    and v_old.group_creation_policy = p_group_creation_policy
    and v_old.allow_external_guests = p_allow_external_guests
    and v_old.external_guest_max_access_days = p_external_guest_max_access_days then
    raise exception 'organization policy change required' using errcode = '22023';
  end if;

  perform set_config('app.organization_policy_context', 'on', true);
  update public.organizations organization
  set message_retention_days = p_message_retention_days,
      allow_member_direct_messages = p_allow_member_direct_messages,
      dm_policy = p_dm_policy,
      require_mfa_for_admins = p_require_mfa_for_admins,
      shift_schedule_authoritative = p_shift_schedule_authoritative,
      group_creation_policy = p_group_creation_policy,
      allow_external_guests = p_allow_external_guests,
      external_guest_max_access_days = p_external_guest_max_access_days,
      organization_policy_version = organization.organization_policy_version + 1
  where organization.id = p_organization_id
    and organization.organization_policy_version = p_expected_version
  returning organization.* into v_new;
  perform set_config('app.organization_policy_context', 'off', true);
  if not found then
    raise exception 'organization policy version conflict' using errcode = '40001';
  end if;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'organization.policy.updated',
    'organization', p_organization_id::text,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'before', jsonb_build_object(
        'message_retention_days', v_old.message_retention_days,
        'allow_member_direct_messages', v_old.allow_member_direct_messages,
        'dm_policy', v_old.dm_policy,
        'require_mfa_for_admins', v_old.require_mfa_for_admins,
        'shift_schedule_authoritative', v_old.shift_schedule_authoritative,
        'group_creation_policy', v_old.group_creation_policy,
        'allow_external_guests', v_old.allow_external_guests,
        'external_guest_max_access_days', v_old.external_guest_max_access_days,
        'organization_policy_version', v_old.organization_policy_version
      ),
      'after', jsonb_build_object(
        'message_retention_days', v_new.message_retention_days,
        'allow_member_direct_messages', v_new.allow_member_direct_messages,
        'dm_policy', v_new.dm_policy,
        'require_mfa_for_admins', v_new.require_mfa_for_admins,
        'shift_schedule_authoritative', v_new.shift_schedule_authoritative,
        'group_creation_policy', v_new.group_creation_policy,
        'allow_external_guests', v_new.allow_external_guests,
        'external_guest_max_access_days', v_new.external_guest_max_access_days,
        'organization_policy_version', v_new.organization_policy_version
      )
    )
  );
  perform private.broadcast_organization_policy_internal(p_organization_id);

  v_response := jsonb_build_object(
    'message_retention_days', v_new.message_retention_days,
    'allow_member_direct_messages', v_new.allow_member_direct_messages,
    'dm_policy', v_new.dm_policy,
    'require_mfa_for_admins', v_new.require_mfa_for_admins,
    'shift_schedule_authoritative', v_new.shift_schedule_authoritative,
    'group_creation_policy', v_new.group_creation_policy,
    'allow_external_guests', v_new.allow_external_guests,
    'external_guest_max_access_days', v_new.external_guest_max_access_days,
    'version', v_new.organization_policy_version
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/organization-policy',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_create_group_conversation_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_name text,
  p_description text,
  p_member_assignments jsonb,
  p_kind text,
  p_unit_id uuid,
  p_history_policy text,
  p_posting_mode text,
  p_join_policy text,
  p_incident_severity text,
  p_incident_classification text,
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
$$;

-- Principal resolution happens before the workspace bootstrap, so it must not
-- advertise expired organizations or let a disabled/sponsorless guest select a
-- workspace that every later command would reject.
create or replace function private.bff_resolve_principal_context_v2_impl(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_requested_organization_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_selected_organization_id uuid;
  v_user jsonb;
  v_organizations jsonb;
  v_not_after timestamptz;
  v_banned_until timestamptz;
  v_deleted_at timestamptz;
begin
  perform private.require_service_role();
  if p_actor_user_id is null or p_session_id is null then
    raise exception 'principal and session are required' using errcode = '22023';
  end if;
  select session.not_after, auth_user.banned_until, auth_user.deleted_at
    into v_not_after, v_banned_until, v_deleted_at
  from auth.sessions session
  join auth.users auth_user on auth_user.id = session.user_id
  join private.session_installations binding
    on binding.session_id = session.id
   and binding.user_id = session.user_id
   and binding.revoked_at is null
  where session.id = p_session_id and session.user_id = p_actor_user_id;
  if not found
    or v_deleted_at is not null
    or (v_not_after is not null and v_not_after <= now())
    or (v_banned_until is not null and v_banned_until > now()) then
    raise exception 'active Auth session required' using errcode = '42501';
  end if;

  if p_requested_organization_id is not null then
    if not private.organization_membership_access_current(
      p_requested_organization_id, p_actor_user_id, now()
    ) or exists (
      select 1 from private.session_revocations revocation
      where revocation.organization_id = p_requested_organization_id
        and revocation.session_id = p_session_id
    ) then
      raise exception 'organization is not available to this session'
        using errcode = '42501';
    end if;
    v_selected_organization_id := p_requested_organization_id;
  else
    select membership.organization_id into v_selected_organization_id
    from public.organization_memberships membership
    where membership.user_id = p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and not exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = membership.organization_id
          and revocation.session_id = p_session_id
      )
    order by membership.joined_at, membership.organization_id
    limit 1;
  end if;

  select jsonb_strip_nulls(jsonb_build_object(
    'user_id', profile.user_id,
    'display_name', profile.display_name,
    'avatar_path', profile.avatar_path,
    'status_message', profile.status_message,
    'preferred_language', profile.preferred_language,
    'time_zone', profile.time_zone
  )) into v_user
  from public.profiles profile where profile.user_id = p_actor_user_id;
  v_user := coalesce(v_user, jsonb_build_object('user_id', p_actor_user_id));

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'organization_id', authorized.organization_id,
    'slug', authorized.slug,
    'name', authorized.name,
    'default_language', authorized.default_language,
    'membership_role', authorized.membership_role,
    'membership_type', authorized.membership_type,
    'access_expires_at', authorized.access_expires_at,
    'job_title', authorized.job_title,
    'joined_at', authorized.joined_at,
    'revocation_generation', authorized.revocation_generation,
    'capabilities', private.effective_capabilities_internal(
      p_actor_user_id, authorized.organization_id
    ),
    'scopes', private.effective_scopes_internal(
      p_actor_user_id, authorized.organization_id
    )
  )) order by authorized.selected desc, authorized.joined_at,
      authorized.organization_id), '[]'::jsonb)
  into v_organizations
  from (
    select organization.id as organization_id, organization.slug,
      organization.name, organization.default_language,
      membership.role as membership_role, membership.membership_type,
      membership.access_expires_at, membership.job_title,
      membership.joined_at, membership.revocation_generation,
      organization.id = v_selected_organization_id as selected
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
    where membership.user_id = p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and not exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = membership.organization_id
          and revocation.session_id = p_session_id
      )
    order by selected desc, membership.joined_at, membership.organization_id
    limit 20
  ) authorized;

  return jsonb_build_object(
    'schema_version', 1,
    'user', v_user,
    'organizations', v_organizations,
    'selected_organization_id', v_selected_organization_id,
    'realtime', case when v_selected_organization_id is null then null
      else jsonb_build_object(
        'inbox_topic', 'org:' || v_selected_organization_id::text || ':user:'
          || p_actor_user_id::text || ':inbox',
        'control_topic', 'org:' || v_selected_organization_id::text || ':user:'
          || p_actor_user_id::text || ':control'
      ) end,
    'reconcile_after', now()
  );
end;
$$;

-- V7 contains all prior bootstrap enrichments and CHAT-04 retained-history
-- filtering. V8 narrows every identity-bearing collection through the final
-- guest-aware directory rule and omits internal unit structure from guests.
create or replace function private.bff_bootstrap_messaging_state_v8_impl(
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
$$;

create or replace function public.bff_resolve_principal_context(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_requested_organization_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_resolve_principal_context_v2_impl(
    p_actor_user_id, p_session_id, p_requested_organization_id
  )
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
  select private.bff_bootstrap_messaging_state_v8_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  )
$$;

create or replace function public.bff_issue_organization_invite_v2(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_destination_type text,
  p_destination text,
  p_invited_user_id uuid,
  p_employee_code text,
  p_activation_mode text,
  p_role text,
  p_expires_in_seconds integer,
  p_membership_type text,
  p_membership_access_expires_at timestamptz,
  p_guest_sponsor_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_issue_organization_invite_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_destination_type, p_destination, p_invited_user_id,
    p_employee_code, p_activation_mode, p_role, p_expires_in_seconds,
    p_membership_type, p_membership_access_expires_at,
    p_guest_sponsor_user_id, p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_issue_organization_invite_v2(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer,
  text, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.bff_issue_organization_invite_v2(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer,
  text, timestamptz, uuid, text, text
) to service_role;

comment on function public.bff_issue_organization_invite_v2(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer,
  text, timestamptz, uuid, text, text
) is
  'Issues employee, bounded contractor, or explicitly sponsored private-guest invitations; redemption atomically propagates the membership scope.';

create or replace function public.bff_authorize_conversation_avatar_download(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_attachment_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_authorize_conversation_avatar_download_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_attachment_id
  )
$$;

revoke all on function public.bff_authorize_conversation_avatar_download(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.bff_authorize_conversation_avatar_download(
  uuid, uuid, uuid, uuid, uuid
) to service_role;

create or replace function public.bff_create_conversation_avatar_upload(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256_hex text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_conversation_avatar_upload_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_file_name, p_mime_type, p_byte_size, p_sha256_hex,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_create_conversation_avatar_upload(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_create_conversation_avatar_upload(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, text
) to service_role;

create or replace function public.bff_activate_conversation_avatar(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_attachment_id uuid,
  p_expected_avatar_path text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_activate_conversation_avatar_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_attachment_id, p_expected_avatar_path,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_activate_conversation_avatar(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_activate_conversation_avatar(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) to service_role;

create or replace function public.bff_remove_conversation_avatar(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_expected_avatar_path text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_remove_conversation_avatar_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_expected_avatar_path, p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_remove_conversation_avatar(
  uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_remove_conversation_avatar(
  uuid, uuid, uuid, uuid, text, text, text
) to service_role;

comment on function public.bff_create_conversation_avatar_upload(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, text
) is
  'Creates an image-only, size-limited conversation-avatar attachment grant; activation remains impossible until malware scan completion.';
comment on function public.bff_authorize_conversation_avatar_download(
  uuid, uuid, uuid, uuid, uuid
) is
  'Authorizes inline delivery only when a clean attachment is still the current avatar and its backing message remains visible to the actor.';
comment on function public.bff_activate_conversation_avatar(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) is
  'Compare-and-swap activation of a clean actor-owned avatar attachment in the same group conversation.';
comment on function public.bff_remove_conversation_avatar(
  uuid, uuid, uuid, uuid, text, text, text
) is
  'Compare-and-swap removal of a group avatar while preserving the scanned attachment audit trail.';

create or replace function public.bff_update_organization_policy(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_message_retention_days integer,
  p_allow_member_direct_messages boolean,
  p_dm_policy text,
  p_require_mfa_for_admins boolean,
  p_shift_schedule_authoritative boolean,
  p_group_creation_policy text,
  p_allow_external_guests boolean,
  p_external_guest_max_access_days integer,
  p_expected_version bigint,
  p_reason text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_update_organization_policy_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_message_retention_days, p_allow_member_direct_messages, p_dm_policy,
    p_require_mfa_for_admins, p_shift_schedule_authoritative,
    p_group_creation_policy, p_allow_external_guests,
    p_external_guest_max_access_days, p_expected_version, p_reason,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_update_organization_policy(
  uuid, uuid, uuid, integer, boolean, text, boolean, boolean, text, boolean,
  integer, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_update_organization_policy(
  uuid, uuid, uuid, integer, boolean, text, boolean, boolean, text, boolean,
  integer, bigint, text, text, text
) to service_role;

comment on function public.bff_update_organization_policy(
  uuid, uuid, uuid, integer, boolean, text, boolean, boolean, text, boolean,
  integer, bigint, text, text, text
) is
  'Recent-AAL2 owner-only CAS update for organization security, retention, shift-source, guest, and group-creation policy with bounded audit and invalidation.';

create or replace function public.bff_list_group_creation_candidates(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_limit integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_list_group_creation_candidates_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_query, p_limit
  )
$$;

revoke all on function public.bff_list_group_creation_candidates(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
grant execute on function public.bff_list_group_creation_candidates(
  uuid, uuid, uuid, text, integer
) to service_role;

comment on function public.bff_list_group_creation_candidates(
  uuid, uuid, uuid, text, integer
) is
  'Bounded group-member picker projection with actor-aware private guest and directory visibility.';

create or replace function public.bff_update_conversation_member_role(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_target_user_id uuid,
  p_expected_role text,
  p_new_role text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_update_conversation_member_role_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_target_user_id, p_expected_role, p_new_role,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_update_conversation_member_role(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_update_conversation_member_role(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) to service_role;

comment on function public.bff_update_conversation_member_role(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) is
  'AAL2, recent-auth, compare-and-swap conversation role mutation with visible event and bounded audit metadata.';

create or replace function public.bff_create_group_conversation_v2(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_name text,
  p_description text,
  p_member_assignments jsonb,
  p_kind text,
  p_unit_id uuid,
  p_history_policy text,
  p_posting_mode text,
  p_join_policy text,
  p_incident_severity text,
  p_incident_classification text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_group_conversation_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_name, p_description,
    p_member_assignments, p_kind, p_unit_id, p_history_policy,
    p_posting_mode, p_join_policy, p_incident_severity,
    p_incident_classification, p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_create_group_conversation_v2(
  uuid, uuid, uuid, text, text, jsonb, text, uuid, text, text, text,
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_create_group_conversation_v2(
  uuid, uuid, uuid, text, text, jsonb, text, uuid, text, text, text,
  text, text, text, text
) to service_role;

comment on function public.bff_create_group_conversation_v2(
  uuid, uuid, uuid, text, text, jsonb, text, uuid, text, text, text,
  text, text, text, text
) is
  'Atomic policy-aware group creation with exact initial roles, guest scoping, history disclosure, and visible/audited membership events.';

-- Final realtime membership gates. Cached conversation rows and private inbox
-- topics must not outlive temporary organization access. Dynamic-group checks
-- remain an additional content-eligibility boundary.
create or replace function private.broadcast_message_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient record;
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
begin
  for v_recipient in
    select member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = new.organization_id
      and member.conversation_id = new.conversation_id
      and member.status = 'active'
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
      and (
        not private.dynamic_group_policy_conversation(
          member.organization_id, member.conversation_id
        ) or private.dynamic_group_user_currently_eligible(
          member.organization_id, member.conversation_id, member.user_id, now()
        )
      )
  loop
    perform realtime.send(
      jsonb_build_object(
        'schema_version', 1, 'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'organization_id', new.organization_id,
        'occurred_at', v_occurred_at,
        'conversation_id', new.conversation_id,
        'entity_type', 'message', 'entity_id', new.id::text,
        'version_id', null, 'reason', 'message_changed'
      ),
      'workspace.invalidated',
      'org:' || new.organization_id::text || ':user:'
        || v_recipient.user_id::text || ':inbox', true
    );
  end loop;
  return null;
end;
$$;

create or replace function private.broadcast_receipt_invalidation_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient record;
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
begin
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'receipt invalidation requires trusted BFF context'
      using errcode = '42501';
  end if;
  for v_recipient in
    select member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.status = 'active'
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
      and (
        not private.dynamic_group_policy_conversation(
          member.organization_id, member.conversation_id
        ) or private.dynamic_group_user_currently_eligible(
          member.organization_id, member.conversation_id, member.user_id, now()
        )
      )
  loop
    perform realtime.send(
      jsonb_build_object(
        'schema_version', 1, 'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'organization_id', p_organization_id,
        'occurred_at', v_occurred_at,
        'conversation_id', p_conversation_id,
        'entity_type', 'receipt', 'entity_id', p_message_id::text,
        'version_id', null, 'reason', 'receipt_changed'
      ),
      'workspace.invalidated',
      'org:' || p_organization_id::text || ':user:'
        || v_recipient.user_id::text || ':inbox', true
    );
  end loop;
end;
$$;

create or replace function private.bff_resolve_realtime_fanout_impl(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_event text,
  p_entity_type text,
  p_entity_id text,
  p_version_id text,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
  v_deliveries jsonb;
begin
  perform private.require_service_role();
  if p_event <> 'workspace.invalidated'
    or p_entity_type not in (
      'conversation', 'message', 'reaction', 'translation', 'receipt',
      'attachment', 'membership', 'announcement', 'handoff', 'summary', 'action'
    )
    or char_length(coalesce(p_entity_id, '')) not between 1 and 240
    or (p_version_id is not null and char_length(p_version_id) > 240)
    or (p_reason is not null and char_length(p_reason) > 160) then
    raise exception 'invalid realtime fanout envelope' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
  ) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'topic', 'org:' || member.organization_id::text || ':user:'
      || member.user_id::text || ':inbox',
    'event', 'workspace.invalidated',
    'payload', jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 1, 'event_id', v_event_id,
      'event', 'workspace.invalidated',
      'organization_id', member.organization_id,
      'occurred_at', v_occurred_at,
      'conversation_id', member.conversation_id,
      'entity_type', p_entity_type, 'entity_id', p_entity_id,
      'version_id', p_version_id, 'reason', p_reason
    ))
  ) order by member.user_id), '[]'::jsonb) into v_deliveries
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.status = 'active'
    and private.organization_membership_access_current(
      member.organization_id, member.user_id, now()
    )
    and (
      not private.dynamic_group_policy_conversation(
        member.organization_id, member.conversation_id
      ) or private.dynamic_group_user_currently_eligible(
        member.organization_id, member.conversation_id, member.user_id, now()
      )
    );
  return jsonb_build_object('schema_version', 1, 'deliveries', v_deliveries);
end;
$$;

-- A normal conversation departure still reaches the departed member while
-- their organization access is current, but an already-expired principal
-- receives no new private-topic event.
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
        and private.organization_membership_access_current(
          member.organization_id, member.user_id, now()
        )
      union
      select p_departed_user_id
      where private.organization_membership_access_current(
        p_organization_id, p_departed_user_id, now()
      )
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
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
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

-- Final organization-access gate for push delivery. CHAT-NOTIF is ordered
-- before the temporary-membership columns exist, so this final override lives
-- here, after organization_membership_access_current is defined. Every
-- authoritative audience branch and the device layer independently fail closed.
create or replace function private.bff_resolve_push_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_after_device_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_deliveries jsonb;
  v_has_more boolean;
  v_next_device_id uuid;
  v_event jsonb;
  v_quiet_hours_override boolean := false;
begin
  perform private.require_service_role();
  if p_limit not between 1 and 1000 then
    raise exception 'invalid push delivery page size' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'push'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now();
  if not found then raise exception 'active push lease required' using errcode = '42501'; end if;
  if v_job.payload ? 'announcement_id' and v_job.payload ? 'announcement_version_id' then
    select exists (
      select 1
      from public.announcements announcement
      join public.announcement_versions version
        on version.organization_id = announcement.organization_id
       and version.announcement_id = announcement.id
      where announcement.organization_id = v_job.organization_id
        and announcement.id = nullif(v_job.payload ->> 'announcement_id', '')::uuid
        and announcement.status in ('published', 'archived')
        and version.id = nullif(v_job.payload ->> 'announcement_version_id', '')::uuid
        and version.notification_class in ('urgent', 'critical')
        and version.critical_category
          in ('safety', 'security', 'operations', 'weather', 'business_continuity')
        and char_length(btrim(coalesce(version.quiet_hours_override_reason, '')))
          between 3 and 500
        and v_job.payload ->> 'notification_class' = version.notification_class
        and v_job.payload ->> 'critical_category' = version.critical_category
        and v_job.payload ->> 'quiet_hours_override_reason' =
          version.quiet_hours_override_reason
        and not exists (
          select 1
          from public.announcement_versions newer
          where newer.organization_id = version.organization_id
            and newer.announcement_id = version.announcement_id
            and newer.version_number > version.version_number
        )
    ) into v_quiet_hours_override;
  end if;
  v_event := jsonb_strip_nulls(jsonb_build_object(
    'event_type', case
      when v_job.payload ? 'announcement_id' then 'announcement.changed'
      when v_job.payload ? 'handoff_id' then 'handoff.changed'
      when v_job.payload ? 'message_id' then 'message.changed'
      when v_job.payload ? 'conversation_id' then 'conversation.changed'
      else 'organization.changed'
    end,
    'organization_id', v_job.organization_id,
    'conversation_id', v_job.payload -> 'conversation_id',
    'message_id', v_job.payload -> 'message_id',
    'announcement_id', v_job.payload -> 'announcement_id',
    'announcement_version_id', v_job.payload -> 'announcement_version_id',
    'handoff_id', v_job.payload -> 'handoff_id',
    'state', v_job.payload -> 'state'
  ));
  with eligible_users as (
    select member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = v_job.organization_id
      and member.status = 'active'
      and member.conversation_id = nullif(v_job.payload ->> 'conversation_id', '')::uuid
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
      -- Announcement and handoff fanout have their own authoritative audience
      -- branches below. Letting the generic conversation branch participate
      -- would widen a targeted announcement to every cached member.
      and not (v_job.payload ? 'announcement_id')
      and not (v_job.payload ? 'handoff_id')
      and (
        not private.dynamic_group_policy_conversation(
          member.organization_id, member.conversation_id
        )
        or (
          private.dynamic_group_user_currently_eligible(
            member.organization_id, member.conversation_id, member.user_id, now()
          )
          and (
            not (v_job.payload ? 'message_id')
            or private.dynamic_group_message_access_allowed_for_user(
              member.organization_id, member.conversation_id,
              nullif(v_job.payload ->> 'message_id', '')::bigint,
              member.user_id, now()
            )
          )
        )
      )
    union
    select recipient.user_id
    from public.announcement_recipients recipient
    join public.organization_memberships organization_member
      on organization_member.organization_id = recipient.organization_id
     and organization_member.user_id = recipient.user_id
     and organization_member.status = 'active'
    where recipient.organization_id = v_job.organization_id
      and recipient.announcement_id = nullif(v_job.payload ->> 'announcement_id', '')::uuid
      and private.organization_membership_access_current(
        recipient.organization_id, recipient.user_id, now()
      )
      and (
        not (v_job.payload ? 'target_user_id')
        or recipient.user_id = nullif(v_job.payload ->> 'target_user_id', '')::uuid
      )
    union
    select member.user_id
    from public.shift_handoffs handoff
    join public.conversation_members member
      on member.organization_id = handoff.organization_id
     and member.conversation_id = handoff.conversation_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where handoff.organization_id = v_job.organization_id
      and handoff.id = nullif(v_job.payload ->> 'handoff_id', '')::uuid
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
  ), candidate_devices as (
    select device.*,
      coalesce(
        device.notification_preview_override, preference.notification_preview
      ) as notification_preview,
      coalesce(
        device.sound_enabled_override, preference.sound_enabled
      ) as sound_enabled,
      coalesce(
        device.vibration_enabled_override, preference.vibration_enabled
      ) as vibration_enabled,
      preference.shift_aware_suppression,
      preference.time_zone, preference.quiet_hours_start,
      preference.quiet_hours_end, preference.quiet_days
    from public.device_registrations device
    join eligible_users eligible on eligible.user_id = device.user_id
    join auth.sessions device_session
      on device_session.id = device.session_id
     and device_session.user_id = device.user_id
    join auth.users device_user on device_user.id = device_session.user_id
    join private.session_installations session_binding
      on session_binding.session_id = device_session.id
     and session_binding.user_id = device.user_id
     and session_binding.installation_id = device.installation_id
     and session_binding.platform = device.platform
     and session_binding.revoked_at is null
    left join private.push_delivery_attempts existing_attempt
      on existing_attempt.outbox_job_id = p_job_id
     and existing_attempt.device_id = device.id
    left join private.session_revocations session_revocation
      on session_revocation.organization_id = device.organization_id
     and session_revocation.session_id = device_session.id
    left join public.organization_user_preferences preference
      on preference.organization_id = device.organization_id
     and preference.user_id = device.user_id
    where device.organization_id = v_job.organization_id
      and device.revoked_at is null
      and private.organization_membership_access_current(
        device.organization_id, device.user_id, now()
      )
      and session_revocation.session_id is null
      and (device_session.not_after is null or device_session.not_after > now())
      and (device_user.banned_until is null or device_user.banned_until <= now())
      -- The later device-preference resolver must retain the dynamic-group
      -- security boundary. Exact message access prevents a delayed job from
      -- notifying somebody about content created during an eligibility gap.
      and (
        nullif(v_job.payload ->> 'conversation_id', '') is null
        or not private.dynamic_group_policy_conversation(
          v_job.organization_id,
          nullif(v_job.payload ->> 'conversation_id', '')::uuid
        )
        or case
          when v_job.payload ? 'message_id' then
            private.dynamic_group_message_access_allowed_for_user(
              v_job.organization_id,
              nullif(v_job.payload ->> 'conversation_id', '')::uuid,
              nullif(v_job.payload ->> 'message_id', '')::bigint,
              device.user_id, now()
            )
          when v_job.payload ? 'handoff_id' then
            private.dynamic_group_user_currently_eligible(
              v_job.organization_id,
              nullif(v_job.payload ->> 'conversation_id', '')::uuid,
              device.user_id, now()
            ) and exists (
              select 1
              from public.handoff_versions handoff_version
              where handoff_version.organization_id = v_job.organization_id
                and handoff_version.handoff_id =
                  nullif(v_job.payload ->> 'handoff_id', '')::uuid
                and not exists (
                  select 1 from public.handoff_versions newer
                  where newer.organization_id = handoff_version.organization_id
                    and newer.handoff_id = handoff_version.handoff_id
                    and newer.version_number > handoff_version.version_number
                )
                and private.dynamic_group_timestamp_access_allowed(
                  handoff_version.organization_id,
                  handoff_version.conversation_id,
                  device.user_id, handoff_version.created_at, now()
                )
                and not exists (
                  select 1 from unnest(handoff_version.source_message_ids) source_id
                  where not private.dynamic_group_message_access_allowed_for_user(
                    handoff_version.organization_id,
                    handoff_version.conversation_id,
                    source_id, device.user_id, now()
                  )
                )
            )
          else private.dynamic_group_user_currently_eligible(
            v_job.organization_id,
            nullif(v_job.payload ->> 'conversation_id', '')::uuid,
            device.user_id, now()
          )
        end
      )
      and (
        nullif(v_job.payload ->> 'conversation_id', '') is null
        or v_quiet_hours_override
        or exists (
          select 1
          from public.conversation_members notification_member
          join public.conversations notification_conversation
            on notification_conversation.organization_id = notification_member.organization_id
           and notification_conversation.id = notification_member.conversation_id
          left join public.conversation_preferences notification_preference
            on notification_preference.organization_id = notification_member.organization_id
           and notification_preference.conversation_id = notification_member.conversation_id
           and notification_preference.user_id = notification_member.user_id
          where notification_member.organization_id = v_job.organization_id
            and notification_member.conversation_id =
              nullif(v_job.payload ->> 'conversation_id', '')::uuid
            and notification_member.user_id = device.user_id
            and notification_member.status = 'active'
            and coalesce(
              notification_preference.notification_level,
              notification_member.notification_level,
              'all'
            ) <> 'none'
            and (
              case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end is null
              or case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end <= now()
            )
            and (
              coalesce(
                notification_preference.notification_level,
                notification_member.notification_level,
                'all'
              ) <> 'mentions'
              or (
                v_job.payload ? 'message_id'
                and not (v_job.payload ? 'announcement_id')
                and not (v_job.payload ? 'handoff_id')
                and (
                  notification_conversation.kind = 'direct'
                  or exists (
                    select 1
                    from public.message_mentions mention
                    where mention.organization_id = v_job.organization_id
                      and mention.conversation_id = notification_member.conversation_id
                      and mention.message_id = (v_job.payload ->> 'message_id')::bigint
                      and mention.mentioned_user_id = device.user_id
                  )
                )
              )
            )
            and (
              not (v_job.payload ? 'message_id')
              or v_job.payload ? 'announcement_id'
              or v_job.payload ? 'handoff_id'
              or exists (
                select 1
                from public.messages pushed_message
                where pushed_message.organization_id = v_job.organization_id
                  and pushed_message.conversation_id = notification_member.conversation_id
                  and pushed_message.id = (v_job.payload ->> 'message_id')::bigint
                  and pushed_message.sender_user_id <> device.user_id
              )
            )
        )
      )
      and (
        existing_attempt.id is null
        or existing_attempt.status = 'pending'
        or (
          existing_attempt.status = 'retry_wait'
          and existing_attempt.next_attempt_at <= now()
        )
      )
      and (p_after_device_id is null or device.id > p_after_device_id)
    order by device.id
    limit p_limit + 1
  ), inserted_attempts as (
    insert into private.push_delivery_attempts (
      organization_id, outbox_job_id, device_id, user_id
    )
    select v_job.organization_id, p_job_id, candidate.id, candidate.user_id
    from candidate_devices candidate
    on conflict (outbox_job_id, device_id) do nothing
    returning id, device_id, status, next_attempt_at
  ), attempt_rows as (
    select inserted.id, inserted.device_id, inserted.status, inserted.next_attempt_at
    from inserted_attempts inserted
    union all
    select attempt.id, attempt.device_id, attempt.status, attempt.next_attempt_at
    from private.push_delivery_attempts attempt
    join candidate_devices candidate on candidate.id = attempt.device_id
    where attempt.outbox_job_id = p_job_id
      and not exists (
        select 1 from inserted_attempts inserted where inserted.device_id = attempt.device_id
      )
  ), page as (
    select candidate.*, attempt.id as attempt_id, attempt.status as dispatch_status,
      attempt.next_attempt_at
    from candidate_devices candidate
    join attempt_rows attempt on attempt.device_id = candidate.id
  ), numbered as (
    select page.*, row_number() over (order by page.id) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'device_id', numbered.id,
      'attempt_id', numbered.attempt_id,
      'dispatch_status', numbered.dispatch_status,
      'dispatchable', true,
      'next_attempt_at', numbered.next_attempt_at,
      'user_id', numbered.user_id,
      'installation_id', numbered.installation_id,
      'platform', numbered.platform,
      'push_token_ciphertext', numbered.push_token_ciphertext,
      'push_token_type', numbered.push_token_type,
      'push_project_id', numbered.push_project_id,
      'push_environment', numbered.push_environment,
      'locale', numbered.locale,
      'app_version', numbered.app_version,
      'currently_off_shift', private.currently_off_shift_internal(
        v_job.organization_id, numbered.user_id, now()
      ),
      'notification_class', case when v_quiet_hours_override
        then v_job.payload ->> 'notification_class' else 'routine' end,
      'critical_category', case when v_quiet_hours_override
        then v_job.payload ->> 'critical_category' else null end,
      'quiet_hours_override', v_quiet_hours_override,
      'quiet_hours_override_reason', case
        when v_quiet_hours_override
          then v_job.payload ->> 'quiet_hours_override_reason'
        else null
      end,
      'preferences', jsonb_build_object(
        'notification_preview', coalesce(numbered.notification_preview, 'generic'),
        'sound_enabled', coalesce(numbered.sound_enabled, true),
        'vibration_enabled', coalesce(numbered.vibration_enabled, true),
        'shift_aware_suppression', coalesce(numbered.shift_aware_suppression, false),
        'time_zone', coalesce(numbered.time_zone, 'UTC'),
        'quiet_hours_start', numbered.quiet_hours_start,
        'quiet_hours_end', numbered.quiet_hours_end,
        'quiet_days', coalesce(to_jsonb(numbered.quiet_days), '[0,1,2,3,4,5,6]'::jsonb)
      )
    ) order by numbered.id) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    (array_agg(numbered.id order by numbered.id)
      filter (where numbered.row_number = p_limit))[1]
  into v_deliveries, v_has_more, v_next_device_id
  from numbered;
  if not v_has_more then
    update private.outbox_jobs job
    set payload = job.payload || jsonb_build_object(
          'fanout_resolved', true,
          'fanout_count', (
            select count(*) from private.push_delivery_attempts attempt
            where attempt.outbox_job_id = p_job_id
          )
        ),
        updated_at = now()
    where job.id = p_job_id
      and job.claimed_by = p_worker_id
      and job.status = 'processing';
  end if;
  return jsonb_build_object(
    'job_id', p_job_id,
    'event', v_event,
    'deliveries', v_deliveries,
    'has_more', v_has_more,
    'next_device_id', case when v_has_more then v_next_device_id else null end
  );
end;
$$;


-- Public BFF wrappers are SECURITY INVOKER by design. Their private business
-- implementations therefore need an explicit service_role bridge while
-- remaining unavailable to Data API callers.
-- Relationship writes have command endpoints with rate limits, idempotency,
-- audit context, and target-visibility checks; authenticated table writes would
-- bypass those controls.
revoke insert, update on table public.contact_connections from authenticated;
revoke insert, delete on table public.member_blocks from authenticated;

revoke all on function public.bff_resolve_principal_context(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.bff_resolve_principal_context(
  uuid, uuid, uuid
) to service_role;

revoke all on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

revoke all on function private.bff_resolve_principal_context_v2_impl(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function private.bff_resolve_principal_context_v2_impl(
  uuid, uuid, uuid
) to service_role;

revoke all on function private.bff_bootstrap_messaging_state_v8_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function private.bff_bootstrap_messaging_state_v8_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

-- These new SECURITY DEFINER predicates and trigger helpers are internal
-- composition points, not callable APIs. Existing policy-facing replacements
-- retain their prior narrow grants through CREATE OR REPLACE.
revoke all on function
  private.organization_membership_access_current(uuid, uuid, timestamptz),
  private.validate_organization_policy_update(),
  private.broadcast_organization_policy_internal(uuid),
  private.dynamic_group_candidate_membership_allowed(uuid, uuid, timestamptz),
  private.dynamic_group_candidate_membership_valid_until(uuid, uuid, timestamptz),
  private.validate_membership_access_policy(),
  private.mark_dynamic_group_membership_access_change(),
  private.can_view_org_member_for_actor(uuid, uuid, uuid, timestamptz),
  private.validate_identity_relationship_target(),
  private.validate_guest_conversation_membership(),
  private.actor_can_create_group(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

revoke all on function private.bff_update_organization_policy_impl(
  uuid, uuid, uuid, integer, boolean, text, boolean, boolean, text, boolean,
  integer, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_update_organization_policy_impl(
  uuid, uuid, uuid, integer, boolean, text, boolean, boolean, text, boolean,
  integer, bigint, text, text, text
) to service_role;

revoke all on function private.can_view_organization_units(uuid)
from public, anon, authenticated, service_role;
grant execute on function private.can_view_organization_units(uuid)
to authenticated;

revoke all on function private.bff_issue_organization_invite_v2_impl(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer,
  text, timestamptz, uuid, text, text
) from public, anon, authenticated;
grant execute on function private.bff_issue_organization_invite_v2_impl(
  uuid, uuid, uuid, text, text, uuid, text, text, text, integer,
  text, timestamptz, uuid, text, text
) to service_role;

revoke all on function private.bff_authorize_conversation_avatar_download_impl(
  uuid, uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function private.bff_authorize_conversation_avatar_download_impl(
  uuid, uuid, uuid, uuid, uuid
) to service_role;

revoke all on function private.bff_create_conversation_avatar_upload_impl(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_create_conversation_avatar_upload_impl(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, text
) to service_role;

revoke all on function private.bff_activate_conversation_avatar_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_activate_conversation_avatar_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text
) to service_role;

revoke all on function private.bff_remove_conversation_avatar_impl(
  uuid, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_remove_conversation_avatar_impl(
  uuid, uuid, uuid, uuid, text, text, text
) to service_role;

-- Avatar trigger and retention helpers are internal implementation details.
-- The storage predicate remains executable only by the authenticated RLS role,
-- while both generic and avatar-specific BFF authorizers stay service-only.
revoke all on function private.validate_conversation_avatar_path_change(),
  private.preserve_active_conversation_avatar_message(),
  private.scrub_conversation_avatar_candidates_internal(integer, timestamptz)
from public, anon, authenticated, service_role;

revoke all on function private.bff_scrub_retention_impl(integer),
  private.bff_authorize_attachment_download_impl(uuid, uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function private.bff_scrub_retention_impl(integer),
  private.bff_authorize_attachment_download_impl(uuid, uuid, uuid, uuid)
to service_role;

revoke all on function private.storage_download_authorized(text)
from public, anon, service_role;
grant execute on function private.storage_download_authorized(text)
to authenticated;

revoke all on function private.bff_list_group_creation_candidates_impl(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
grant execute on function private.bff_list_group_creation_candidates_impl(
  uuid, uuid, uuid, text, integer
) to service_role;

revoke all on function private.bff_update_conversation_member_role_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_update_conversation_member_role_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text
) to service_role;

revoke all on function private.bff_create_group_conversation_v2_impl(
  uuid, uuid, uuid, text, text, jsonb, text, uuid, text, text, text,
  text, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_create_group_conversation_v2_impl(
  uuid, uuid, uuid, text, text, jsonb, text, uuid, text, text, text,
  text, text, text, text
) to service_role;

commit;
