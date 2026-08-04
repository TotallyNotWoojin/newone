begin;

-- Account recovery is deliberately isolated from the initial messenger
-- foundation. Supabase Auth owns OTP delivery and MFA factors; Postgres owns
-- organization eligibility, abuse budgets, approval evidence, session/device
-- revocation, and durable security-notification intent.

insert into public.organization_role_permissions (role_name, permission)
values ('security_admin', 'recovery.manage')
on conflict (role_name, permission) do nothing;

create table private.account_security_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete restrict,
  organization_id uuid references public.organizations (id) on delete restrict,
  actor_user_id uuid references auth.users (id) on delete restrict,
  event_type text not null,
  session_id uuid,
  recovery_case_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint account_security_events_type_allowed check (
    event_type in (
      'otp_recovery_completed',
      'factor_reset_requested',
      'factor_reset_completed'
    )
  ),
  constraint account_security_events_metadata_object check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384
  )
);

create table private.account_security_notices (
  id bigint generated always as identity primary key,
  security_event_id bigint not null
    references private.account_security_events (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
  organization_id uuid references public.organizations (id) on delete restrict,
  notice_type text not null,
  delivery_state text not null default 'pending_external_delivery',
  created_at timestamptz not null default now(),
  constraint account_security_notices_type_allowed check (
    notice_type in ('otp_recovery_completed', 'factor_reset_completed')
  ),
  constraint account_security_notices_delivery_allowed check (
    delivery_state = 'pending_external_delivery'
  ),
  unique (security_event_id, notice_type)
);

create table private.account_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  target_user_id uuid not null,
  requested_by_user_id uuid not null,
  target_factor_id uuid not null,
  target_factor_type text not null,
  request_reason text not null,
  status text not null default 'awaiting_external_verification',
  privileged_target boolean not null,
  required_approvals smallint not null,
  verification_method text,
  verification_reference_hash bytea,
  verified_by_user_id uuid,
  verified_at timestamptz,
  execution_version uuid,
  execution_actor_user_id uuid,
  execution_started_at timestamptz,
  execution_attempt_count integer not null default 0,
  factor_deleted_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  rejected_by_user_id uuid,
  rejection_reason text,
  expires_at timestamptz not null default (now() + interval '24 hours'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, target_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, requested_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, verified_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, execution_actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, rejected_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint account_recovery_cases_self_requested check (
    requested_by_user_id = target_user_id
  ),
  constraint account_recovery_cases_factor_type check (target_factor_type = 'totp'),
  constraint account_recovery_cases_reason_length check (
    char_length(btrim(request_reason)) between 10 and 1000
  ),
  constraint account_recovery_cases_status_allowed check (
    status in (
      'awaiting_external_verification', 'awaiting_approval', 'approved',
      'executing', 'completed', 'rejected', 'expired'
    )
  ),
  constraint account_recovery_cases_approval_count check (
    required_approvals = case when privileged_target then 2 else 1 end
  ),
  constraint account_recovery_cases_verification_consistent check (
    (
      verification_method is null and verification_reference_hash is null
      and verified_by_user_id is null and verified_at is null
    ) or (
      verification_method in (
        'in_person', 'manager_callback', 'hr_record_match', 'approved_provider'
      )
      and octet_length(verification_reference_hash) = 32
      and verified_by_user_id is not null and verified_at is not null
    )
  ),
  constraint account_recovery_cases_execution_consistent check (
    (
      execution_version is null and execution_actor_user_id is null
      and execution_started_at is null and execution_attempt_count = 0
    ) or (
      execution_version is not null and execution_actor_user_id is not null
      and execution_started_at is not null and execution_attempt_count > 0
    )
  ),
  constraint account_recovery_cases_completion_consistent check (
    (status = 'completed' and completed_at is not null and factor_deleted_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint account_recovery_cases_rejection_consistent check (
    (
      status in ('rejected', 'expired') and rejected_at is not null
      and char_length(btrim(rejection_reason)) between 3 and 500
    ) or (
      status not in ('rejected', 'expired') and rejected_at is null
      and rejected_by_user_id is null and rejection_reason is null
    )
  ),
  constraint account_recovery_cases_expiry_bounded check (
    expires_at > created_at and expires_at <= created_at + interval '72 hours'
  )
);

create unique index account_recovery_cases_one_active_target_idx
  on private.account_recovery_cases (organization_id, target_user_id)
  where status in (
    'awaiting_external_verification', 'awaiting_approval', 'approved', 'executing'
  );

create index account_recovery_cases_admin_queue_idx
  on private.account_recovery_cases (organization_id, status, expires_at, created_at, id);
create index account_recovery_cases_target_idx
  on private.account_recovery_cases (target_user_id, created_at desc, id);
create index account_recovery_cases_org_target_fk_idx
  on private.account_recovery_cases (organization_id, target_user_id);
create index account_recovery_cases_org_requester_fk_idx
  on private.account_recovery_cases (organization_id, requested_by_user_id);
create index account_recovery_cases_org_verifier_fk_idx
  on private.account_recovery_cases (organization_id, verified_by_user_id);
create index account_recovery_cases_org_executor_fk_idx
  on private.account_recovery_cases (organization_id, execution_actor_user_id);
create index account_recovery_cases_org_rejector_fk_idx
  on private.account_recovery_cases (organization_id, rejected_by_user_id);

create table private.account_recovery_case_approvals (
  recovery_case_id uuid not null
    references private.account_recovery_cases (id) on delete restrict,
  organization_id uuid not null,
  approver_user_id uuid not null,
  approved_at timestamptz not null default now(),
  primary key (recovery_case_id, approver_user_id),
  foreign key (organization_id, approver_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict
);

create index account_recovery_case_approvals_org_idx
  on private.account_recovery_case_approvals (organization_id, approved_at desc);
create index account_recovery_case_approvals_approver_fk_idx
  on private.account_recovery_case_approvals (organization_id, approver_user_id);

create table private.account_recovery_case_events (
  id bigint generated always as identity primary key,
  recovery_case_id uuid not null
    references private.account_recovery_cases (id) on delete restrict,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  actor_user_id uuid,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint account_recovery_case_events_type_allowed check (
    event_type in (
      'requested', 'external_verification_recorded', 'approval_recorded',
      'approved', 'rejected', 'expired', 'execution_started',
      'execution_resumed', 'factor_deletion_confirmed', 'completed'
    )
  ),
  constraint account_recovery_case_events_metadata_object check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8192
  )
);

create index account_recovery_case_events_case_idx
  on private.account_recovery_case_events (recovery_case_id, occurred_at, id);
create index account_recovery_case_events_actor_fk_idx
  on private.account_recovery_case_events (organization_id, actor_user_id);

-- Auth can delete its session rows between the external deleteFactor call and
-- database finalization. Preserve the execution snapshot without a foreign key
-- to auth.sessions so a retry can still audit what was invalidated.
create table private.account_recovery_execution_sessions (
  recovery_case_id uuid not null
    references private.account_recovery_cases (id) on delete restrict,
  session_id uuid not null,
  user_id uuid not null references auth.users (id) on delete restrict,
  captured_at timestamptz not null default now(),
  primary key (recovery_case_id, session_id)
);

create index account_recovery_execution_sessions_user_fk_idx
  on private.account_recovery_execution_sessions (user_id);
create index account_security_events_user_fk_idx
  on private.account_security_events (user_id);
create index account_security_events_org_fk_idx
  on private.account_security_events (organization_id);
create index account_security_events_actor_fk_idx
  on private.account_security_events (actor_user_id);
create index account_security_notices_user_fk_idx
  on private.account_security_notices (user_id);
create index account_security_notices_org_fk_idx
  on private.account_security_notices (organization_id);

create or replace function private.prevent_account_recovery_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'account recovery evidence is append-only' using errcode = '55000';
end;
$$;

create trigger account_security_events_immutable
before update or delete on private.account_security_events
for each row execute function private.prevent_account_recovery_evidence_mutation();

create trigger account_security_notices_immutable
before update or delete on private.account_security_notices
for each row execute function private.prevent_account_recovery_evidence_mutation();

create trigger account_recovery_case_approvals_immutable
before update or delete on private.account_recovery_case_approvals
for each row execute function private.prevent_account_recovery_evidence_mutation();

create trigger account_recovery_case_events_immutable
before update or delete on private.account_recovery_case_events
for each row execute function private.prevent_account_recovery_evidence_mutation();

create trigger account_recovery_execution_sessions_immutable
before update or delete on private.account_recovery_execution_sessions
for each row execute function private.prevent_account_recovery_evidence_mutation();

create trigger account_recovery_cases_touch_updated_at
before update on private.account_recovery_cases
for each row execute function private.touch_updated_at();

create or replace function private.bff_authorize_account_recovery_otp_impl(
  p_destination_type text,
  p_destination text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_destination text := case
    when p_destination_type = 'email' then lower(btrim(coalesce(p_destination, '')))
    else btrim(coalesce(p_destination, ''))
  end;
  v_identity_key text := coalesce(p_destination_type, 'invalid') || ':' || v_destination;
  v_ip_key text := coalesce(p_ip_hash, 'invalid');
  v_installation_key text := coalesce(p_installation_hash, 'invalid');
  v_identity_allowed boolean;
  v_ip_allowed boolean;
  v_installation_allowed boolean;
  v_member_valid boolean := false;
  v_identity_limit integer;
  v_ip_limit integer;
  v_installation_limit integer;
  v_window_seconds integer;
begin
  perform private.require_service_role();
  if p_purpose not in ('request', 'verify') then
    raise exception 'invalid recovery OTP purpose' using errcode = '22023';
  end if;

  v_identity_limit := case p_purpose when 'request' then 3 else 10 end;
  v_ip_limit := case p_purpose when 'request' then 10 else 30 end;
  v_installation_limit := case p_purpose when 'request' then 5 else 15 end;
  v_window_seconds := case p_purpose when 'request' then 3600 else 900 end;

  -- All three counters are consumed before identity eligibility is evaluated.
  -- The BFF returns a constant public envelope, so active, suspended, unknown,
  -- and exhausted identities are indistinguishable to a signed-out caller.
  v_identity_allowed := private.consume_rate_limit(
    'recovery_' || p_purpose || '_identity_' ||
      case p_purpose when 'request' then '1h' else '15m' end,
    v_identity_key,
    v_identity_limit,
    v_window_seconds
  );
  v_ip_allowed := private.consume_rate_limit(
    'recovery_' || p_purpose || '_ip_' ||
      case p_purpose when 'request' then '1h' else '15m' end,
    v_ip_key,
    v_ip_limit,
    v_window_seconds
  );
  v_installation_allowed := private.consume_rate_limit(
    'recovery_' || p_purpose || '_installation_' ||
      case p_purpose when 'request' then '1h' else '15m' end,
    v_installation_key,
    v_installation_limit,
    v_window_seconds
  );

  if p_destination_type in ('email', 'phone')
    and (
      (p_destination_type = 'email'
        and v_destination ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
      or (p_destination_type = 'phone'
        and v_destination ~ '^\+[1-9][0-9]{7,14}$')
    )
    and coalesce(p_ip_hash, '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_installation_hash, '') ~ '^[0-9a-f]{64}$' then
    select exists (
      select 1
      from auth.users auth_user
      join public.organization_memberships membership
        on membership.user_id = auth_user.id
       and membership.status = 'active'
      where auth_user.deleted_at is null
        and (auth_user.banned_until is null or auth_user.banned_until <= now())
        and case p_destination_type
          when 'email' then auth_user.email_confirmed_at is not null
            and lower(auth_user.email) = v_destination
          when 'phone' then auth_user.phone_confirmed_at is not null
            and auth_user.phone = v_destination
          else false
        end
    ) into v_member_valid;
  end if;

  return jsonb_build_object(
    'allowed', v_member_valid and v_identity_allowed
      and v_ip_allowed and v_installation_allowed,
    'channel_configured', p_destination_type = 'email',
    'retry_after_seconds', case
      when not v_identity_allowed or not v_ip_allowed or not v_installation_allowed
        then v_window_seconds
      when not v_member_valid then 60
      else 0
    end
  );
end;
$$;

create or replace function private.bff_complete_account_recovery_impl(
  p_actor_user_id uuid,
  p_current_session_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_authorization_org_id uuid;
  v_other_session_ids uuid[] := array[]::uuid[];
  v_revoked_bindings integer := 0;
  v_revoked_devices integer := 0;
  v_deleted_sessions integer := 0;
  v_security_event_id bigint;
  v_notice_id bigint;
begin
  perform private.require_service_role();
  if p_actor_user_id is null or p_current_session_id is null then
    raise exception 'invalid recovery session context' using errcode = '22023';
  end if;

  -- Serialize recovery completion for one principal. The current session must
  -- already have an active installation binding before any membership lookup.
  perform 1 from auth.users auth_user
  where auth_user.id = p_actor_user_id
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= now())
  for update;
  if not found then
    raise exception 'active account required' using errcode = '42501';
  end if;

  select membership.organization_id into v_authorization_org_id
  from public.organization_memberships membership
  where membership.user_id = p_actor_user_id and membership.status = 'active'
  order by membership.organization_id
  limit 1;
  if not found then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id,
    v_authorization_org_id,
    p_current_session_id,
    'account.recovery.complete',
    false,
    0
  );
  if not coalesce((v_authorization ->> 'allowed')::boolean, false) then
    raise exception 'bound recovery session required' using errcode = '42501';
  end if;

  select coalesce(array_agg(session.id order by session.id), array[]::uuid[])
    into v_other_session_ids
  from auth.sessions session
  where session.user_id = p_actor_user_id
    and session.id <> p_current_session_id;

  insert into private.session_revocations (
    organization_id, session_id, user_id, revoked_by_user_id, reason
  )
  select membership.organization_id, recovered_session_id,
    p_actor_user_id, p_actor_user_id, 'Account recovery revoked another session'
  from public.organization_memberships membership
  cross join unnest(v_other_session_ids) recovered_session_id
  where membership.user_id = p_actor_user_id
    and membership.status = 'active'
  on conflict (organization_id, session_id) do nothing;

  update private.session_installations binding
  set revoked_at = coalesce(binding.revoked_at, now())
  where binding.user_id = p_actor_user_id
    and binding.session_id is distinct from p_current_session_id
    and binding.revoked_at is null;
  get diagnostics v_revoked_bindings = row_count;

  update public.device_registrations device
  set revoked_at = coalesce(device.revoked_at, now())
  where device.user_id = p_actor_user_id
    and device.session_id is distinct from p_current_session_id
    and device.revoked_at is null;
  get diagnostics v_revoked_devices = row_count;

  delete from auth.sessions session
  where session.user_id = p_actor_user_id
    and session.id <> p_current_session_id;
  get diagnostics v_deleted_sessions = row_count;

  insert into private.account_security_events (
    user_id, actor_user_id, event_type, session_id, metadata
  ) values (
    p_actor_user_id,
    p_actor_user_id,
    'otp_recovery_completed',
    p_current_session_id,
    jsonb_build_object(
      'other_sessions_revoked', cardinality(v_other_session_ids),
      'session_bindings_revoked', v_revoked_bindings,
      'devices_revoked', v_revoked_devices,
      'current_session_preserved', true
    )
  ) returning id into v_security_event_id;

  insert into private.account_security_notices (
    security_event_id, user_id, notice_type
  ) values (
    v_security_event_id, p_actor_user_id, 'otp_recovery_completed'
  ) returning id into v_notice_id;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  )
  select membership.organization_id, p_actor_user_id,
    'account.recovery.completed', 'auth_user', p_actor_user_id::text,
    jsonb_build_object(
      'security_event_id', v_security_event_id,
      'other_sessions_revoked', cardinality(v_other_session_ids),
      'current_session_preserved', true
    )
  from public.organization_memberships membership
  where membership.user_id = p_actor_user_id
    and membership.status = 'active';

  return jsonb_build_object(
    'recovered', true,
    'current_session_id', p_current_session_id,
    'current_session_preserved', true,
    'other_sessions_revoked', cardinality(v_other_session_ids),
    'auth_sessions_deleted', v_deleted_sessions,
    'session_bindings_revoked', v_revoked_bindings,
    'devices_revoked', v_revoked_devices,
    'security_event_recorded', true,
    'security_notice_id', v_notice_id,
    'security_notice_state', 'pending_external_delivery'
  );
end;
$$;

create or replace function private.assert_recovery_manager_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
begin
  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_operation,
    true,
    300
  );
  if not coalesce((v_authorization ->> 'allowed')::boolean, false)
    or not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'recovery.manage', null
    ) then
    raise exception 'recent AAL2 recovery manager authorization required'
      using errcode = '42501';
  end if;
  return v_authorization;
end;
$$;

create or replace function private.expire_account_recovery_case_internal(
  p_case private.account_recovery_cases
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_case.status <> 'executing'
    and p_case.status not in ('completed', 'rejected', 'expired')
    and p_case.expires_at <= now() then
    update private.account_recovery_cases recovery_case
    set status = 'expired',
        rejected_at = now(),
        rejected_by_user_id = null,
        rejection_reason = 'Recovery case expired before execution'
    where recovery_case.id = p_case.id;
    insert into private.account_recovery_case_events (
      recovery_case_id, organization_id, event_type,
      metadata
    ) values (
      p_case.id, p_case.organization_id, 'expired',
      jsonb_build_object('expired_at', p_case.expires_at)
    );
    return true;
  end if;
  return p_case.status = 'expired';
end;
$$;

create or replace function private.bff_create_account_recovery_case_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_factor_id uuid,
  p_factor_type text,
  p_factor_status text,
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
  v_case_id uuid;
  v_privileged boolean;
  v_required_approvals smallint;
  v_security_event_id bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    'recovery.case.create',
    false,
    0,
    '/v2/auth/recovery/cases',
    p_idempotency_key,
    p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  if p_factor_id is null or p_factor_type <> 'totp' or p_factor_status <> 'verified'
    or char_length(btrim(coalesce(p_reason, ''))) not between 10 and 1000 then
    raise exception 'verified TOTP recovery request required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
  ) then
    raise exception 'active target membership required' using errcode = '42501';
  end if;

  select membership.role in ('owner', 'admin') or exists (
    select 1
    from public.organization_role_assignments assignment
    join public.organization_roles organization_role
      on organization_role.role_name = assignment.role_name
     and organization_role.sensitive
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_actor_user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
  ) into v_privileged
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  v_required_approvals := case when v_privileged then 2 else 1 end;

  begin
    insert into private.account_recovery_cases (
      organization_id, target_user_id, requested_by_user_id,
      target_factor_id, target_factor_type, request_reason,
      privileged_target, required_approvals
    ) values (
      p_organization_id, p_actor_user_id, p_actor_user_id,
      p_factor_id, p_factor_type, btrim(p_reason),
      v_privileged, v_required_approvals
    ) returning id into v_case_id;
  exception when unique_violation then
    raise exception 'an active recovery case already exists for this member'
      using errcode = '23505';
  end;

  insert into private.account_recovery_case_events (
    recovery_case_id, organization_id, actor_user_id, event_type, metadata
  ) values (
    v_case_id, p_organization_id, p_actor_user_id, 'requested',
    jsonb_build_object(
      'privileged_target', v_privileged,
      'required_approvals', v_required_approvals,
      'human_verification', 'external_required'
    )
  );

  insert into private.account_security_events (
    user_id, organization_id, actor_user_id, event_type, recovery_case_id,
    metadata
  ) values (
    p_actor_user_id, p_organization_id, p_actor_user_id,
    'factor_reset_requested', v_case_id,
    jsonb_build_object(
      'privileged_target', v_privileged,
      'required_approvals', v_required_approvals
    )
  ) returning id into v_security_event_id;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'account.factor_reset.requested',
    'account_recovery_case', v_case_id::text,
    jsonb_build_object(
      'security_event_id', v_security_event_id,
      'target_user_id', p_actor_user_id,
      'privileged_target', v_privileged,
      'required_approvals', v_required_approvals,
      'human_verification', 'external_required'
    )
  );

  v_response := jsonb_build_object(
    'case_id', v_case_id,
    'status', 'awaiting_external_verification',
    'privileged_target', v_privileged,
    'required_approvals', v_required_approvals,
    'approvals_recorded', 0,
    'human_verification', jsonb_build_object(
      'performed_by_newone', false,
      'external_policy_required', true,
      'evidence_reference_stored_as_hash', true
    ),
    'expires_at', (
      select recovery_case.expires_at
      from private.account_recovery_cases recovery_case
      where recovery_case.id = v_case_id
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/auth/recovery/cases',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_record_account_recovery_verification_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_verification_method text,
  p_verification_reference_hash text,
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
  v_case private.account_recovery_cases%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'recovery.case.verify', true, 300,
    '/v2/auth/recovery/cases/:id/verify',
    p_idempotency_key, p_request_sha256
  );
  perform private.assert_recovery_manager_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'recovery.case.verify'
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_verification_method not in (
    'in_person', 'manager_callback', 'hr_record_match', 'approved_provider'
  ) or coalesce(p_verification_reference_hash, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'valid external verification evidence required' using errcode = '22023';
  end if;

  select * into v_case
  from private.account_recovery_cases recovery_case
  where recovery_case.id = p_case_id
    and recovery_case.organization_id = p_organization_id
  for update;
  if not found then raise exception 'recovery case not found' using errcode = 'P0002'; end if;
  if private.expire_account_recovery_case_internal(v_case) then
    v_response := jsonb_build_object('case_id', p_case_id, 'status', 'expired');
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id,
      '/v2/auth/recovery/cases/:id/verify', p_idempotency_key,
      p_request_sha256, v_response
    );
  end if;
  if v_case.status <> 'awaiting_external_verification'
    or p_actor_user_id in (v_case.target_user_id, v_case.requested_by_user_id) then
    raise exception 'independent verification actor and pending case required'
      using errcode = '42501';
  end if;

  update private.account_recovery_cases recovery_case
  set status = 'awaiting_approval',
      verification_method = p_verification_method,
      verification_reference_hash = decode(p_verification_reference_hash, 'hex'),
      verified_by_user_id = p_actor_user_id,
      verified_at = now()
  where recovery_case.id = p_case_id;
  insert into private.account_recovery_case_events (
    recovery_case_id, organization_id, actor_user_id, event_type, metadata
  ) values (
    p_case_id, p_organization_id, p_actor_user_id,
    'external_verification_recorded',
    jsonb_build_object(
      'method', p_verification_method,
      'reference_persisted', 'hmac_sha256_digest_only'
    )
  );
  v_response := jsonb_build_object(
    'case_id', p_case_id,
    'status', 'awaiting_approval',
    'human_verification_recorded', true,
    'required_approvals', v_case.required_approvals,
    'approvals_recorded', 0
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/auth/recovery/cases/:id/verify', p_idempotency_key,
    p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_approve_account_recovery_case_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
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
  v_case private.account_recovery_cases%rowtype;
  v_approval_inserted boolean := false;
  v_approval_count integer;
  v_status text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'recovery.case.approve', true, 300,
    '/v2/auth/recovery/cases/:id/approve',
    p_idempotency_key, p_request_sha256
  );
  perform private.assert_recovery_manager_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'recovery.case.approve'
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  select * into v_case
  from private.account_recovery_cases recovery_case
  where recovery_case.id = p_case_id
    and recovery_case.organization_id = p_organization_id
  for update;
  if not found then raise exception 'recovery case not found' using errcode = 'P0002'; end if;
  if private.expire_account_recovery_case_internal(v_case) then
    v_response := jsonb_build_object('case_id', p_case_id, 'status', 'expired');
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id,
      '/v2/auth/recovery/cases/:id/approve', p_idempotency_key,
      p_request_sha256, v_response
    );
  end if;
  if v_case.status not in ('awaiting_approval', 'approved')
    or v_case.verified_by_user_id is null
    or p_actor_user_id in (
      v_case.target_user_id,
      v_case.requested_by_user_id,
      v_case.verified_by_user_id
    ) then
    raise exception 'independent recovery approver and verified case required'
      using errcode = '42501';
  end if;
  if v_case.status = 'approved' and not exists (
    select 1 from private.account_recovery_case_approvals approval
    where approval.recovery_case_id = p_case_id
      and approval.approver_user_id = p_actor_user_id
  ) then
    raise exception 'recovery case already has its required approvals'
      using errcode = '23505';
  end if;

  insert into private.account_recovery_case_approvals (
    recovery_case_id, organization_id, approver_user_id
  ) values (
    p_case_id, p_organization_id, p_actor_user_id
  )
  on conflict (recovery_case_id, approver_user_id) do nothing
  returning true into v_approval_inserted;

  select count(*)::integer into v_approval_count
  from private.account_recovery_case_approvals approval
  where approval.recovery_case_id = p_case_id;

  if v_approval_inserted then
    insert into private.account_recovery_case_events (
      recovery_case_id, organization_id, actor_user_id, event_type, metadata
    ) values (
      p_case_id, p_organization_id, p_actor_user_id, 'approval_recorded',
      jsonb_build_object(
        'approval_number', v_approval_count,
        'required_approvals', v_case.required_approvals
      )
    );
  end if;

  v_status := case
    when v_approval_count >= v_case.required_approvals then 'approved'
    else 'awaiting_approval'
  end;
  if v_status = 'approved' and v_case.status <> 'approved' then
    update private.account_recovery_cases recovery_case
    set status = 'approved'
    where recovery_case.id = p_case_id;
    insert into private.account_recovery_case_events (
      recovery_case_id, organization_id, actor_user_id, event_type, metadata
    ) values (
      p_case_id, p_organization_id, p_actor_user_id, 'approved',
      jsonb_build_object(
        'approvals_recorded', v_approval_count,
        'required_approvals', v_case.required_approvals
      )
    );
  end if;

  v_response := jsonb_build_object(
    'case_id', p_case_id,
    'status', v_status,
    'approval_recorded', v_approval_inserted,
    'approvals_recorded', v_approval_count,
    'required_approvals', v_case.required_approvals,
    'privileged_target', v_case.privileged_target
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/auth/recovery/cases/:id/approve', p_idempotency_key,
    p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_reject_account_recovery_case_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
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
  v_case private.account_recovery_cases%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'recovery.case.reject', true, 300,
    '/v2/auth/recovery/cases/:id/reject',
    p_idempotency_key, p_request_sha256
  );
  perform private.assert_recovery_manager_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'recovery.case.reject'
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'recovery rejection reason required' using errcode = '22023';
  end if;

  select * into v_case
  from private.account_recovery_cases recovery_case
  where recovery_case.id = p_case_id
    and recovery_case.organization_id = p_organization_id
  for update;
  if not found then raise exception 'recovery case not found' using errcode = 'P0002'; end if;
  if v_case.status in ('completed', 'rejected', 'expired', 'executing')
    or p_actor_user_id in (v_case.target_user_id, v_case.requested_by_user_id) then
    raise exception 'rejectable recovery case and independent actor required'
      using errcode = '42501';
  end if;

  update private.account_recovery_cases recovery_case
  set status = 'rejected',
      rejected_at = now(),
      rejected_by_user_id = p_actor_user_id,
      rejection_reason = btrim(p_reason)
  where recovery_case.id = p_case_id;
  insert into private.account_recovery_case_events (
    recovery_case_id, organization_id, actor_user_id, event_type, metadata
  ) values (
    p_case_id, p_organization_id, p_actor_user_id, 'rejected',
    jsonb_build_object('reason_recorded', true)
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'account.factor_reset.rejected',
    'account_recovery_case', p_case_id::text,
    jsonb_build_object('target_user_id', v_case.target_user_id)
  );
  v_response := jsonb_build_object('case_id', p_case_id, 'status', 'rejected');
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/auth/recovery/cases/:id/reject', p_idempotency_key,
    p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_list_account_recovery_cases_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_include_organization boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base_authorization jsonb;
  v_manager_authorization jsonb;
  v_is_manager boolean := false;
  v_cases jsonb;
begin
  perform private.require_service_role();
  v_base_authorization := private.authorize_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'recovery.case.list', false, 0
  );
  if not coalesce((v_base_authorization ->> 'allowed')::boolean, false) then
    raise exception 'active bound session required' using errcode = '42501';
  end if;
  if p_include_organization then
    v_manager_authorization := private.authorize_bff_request_internal(
      p_actor_user_id, p_organization_id, p_session_id,
      'recovery.case.list.organization', true, 300
    );
    v_is_manager := coalesce((v_manager_authorization ->> 'allowed')::boolean, false)
      and private.actor_has_permission(
        p_actor_user_id, p_organization_id, 'recovery.manage', null
      );
    if not v_is_manager then
      raise exception 'recent AAL2 recovery manager authorization required'
        using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'case_id', recovery_case.id,
    'organization_id', recovery_case.organization_id,
    'target_user_id', recovery_case.target_user_id,
    'target_factor_id', recovery_case.target_factor_id,
    'status', recovery_case.status,
    'request_reason', recovery_case.request_reason,
    'privileged_target', recovery_case.privileged_target,
    'required_approvals', recovery_case.required_approvals,
    'approvals_recorded', (
      select count(*)::integer
      from private.account_recovery_case_approvals approval
      where approval.recovery_case_id = recovery_case.id
    ),
    'human_verification_recorded', recovery_case.verified_at is not null,
    'verification_method', recovery_case.verification_method,
    'external_verification_performed_by_newone', false,
    'expires_at', recovery_case.expires_at,
    'created_at', recovery_case.created_at,
    'updated_at', recovery_case.updated_at,
    'completed_at', recovery_case.completed_at
  ) order by recovery_case.created_at desc, recovery_case.id), '[]'::jsonb)
  into v_cases
  from (
    select candidate.*
    from private.account_recovery_cases candidate
    where candidate.organization_id = p_organization_id
      and (p_include_organization or candidate.target_user_id = p_actor_user_id)
    order by candidate.created_at desc, candidate.id
    limit 100
  ) recovery_case;
  return jsonb_build_object(
    'schema_version', 1,
    'scope', case when p_include_organization then 'organization' else 'self' end,
    'cases', v_cases,
    'human_verification_policy', jsonb_build_object(
      'performed_by_newone', false,
      'external_policy_required', true
    )
  );
end;
$$;

create or replace function private.bff_prepare_account_recovery_execution_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
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
  v_case private.account_recovery_cases%rowtype;
  v_approval_count integer;
  v_execution_version uuid := gen_random_uuid();
  v_resumed boolean;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'recovery.case.execute', true, 300,
    '/v2/auth/recovery/cases/:id/execute',
    p_idempotency_key, p_request_sha256
  );
  perform private.assert_recovery_manager_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'recovery.case.execute'
  );
  if v_command ->> 'state' = 'replay' then
    -- The cached first-phase response cannot safely drive a retry: factor
    -- deletion may already have succeeded, and a later execution attempt may
    -- have replaced its version. Re-read the locked case and return only the
    -- current execution claim. This also rechecks the manager permission above.
    select * into v_case
    from private.account_recovery_cases recovery_case
    where recovery_case.id = p_case_id
      and recovery_case.organization_id = p_organization_id
    for update;
    if not found then raise exception 'recovery case not found' using errcode = 'P0002'; end if;
    if v_case.status = 'completed' then
      return jsonb_build_object(
        'case_id', p_case_id, 'status', 'completed', 'already_completed', true
      );
    end if;
    if v_case.status <> 'executing'
      or v_case.execution_actor_user_id is distinct from p_actor_user_id then
      raise exception 'current recovery execution claim required' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'case_id', p_case_id,
      'status', 'executing',
      'target_user_id', v_case.target_user_id,
      'factor_id', v_case.target_factor_id,
      'factor_type', v_case.target_factor_type,
      'execution_version', v_case.execution_version,
      'resumed', true,
      'factor_deletion_required', true,
      'finalization_required', true
    );
  end if;
  if not private.consume_rate_limit(
    'recovery_execution_actor_1h',
    p_organization_id::text || ':' || p_actor_user_id::text,
    10,
    3600
  ) or not private.consume_rate_limit(
    'recovery_execution_case_1h', p_case_id::text, 10, 3600
  ) then
    raise exception 'recovery execution rate limit exceeded' using errcode = 'P0001';
  end if;

  select * into v_case
  from private.account_recovery_cases recovery_case
  where recovery_case.id = p_case_id
    and recovery_case.organization_id = p_organization_id
  for update;
  if not found then raise exception 'recovery case not found' using errcode = 'P0002'; end if;
  if private.expire_account_recovery_case_internal(v_case) then
    v_response := jsonb_build_object('case_id', p_case_id, 'status', 'expired');
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id,
      '/v2/auth/recovery/cases/:id/execute', p_idempotency_key,
      p_request_sha256, v_response
    );
  end if;
  if p_actor_user_id in (
    v_case.target_user_id,
    v_case.requested_by_user_id,
    v_case.verified_by_user_id
  ) then
    raise exception 'independent recovery execution actor required' using errcode = '42501';
  end if;
  if v_case.status = 'completed' then
    v_response := jsonb_build_object(
      'case_id', p_case_id, 'status', 'completed', 'already_completed', true
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id,
      '/v2/auth/recovery/cases/:id/execute', p_idempotency_key,
      p_request_sha256, v_response
    );
  end if;
  if v_case.status not in ('approved', 'executing') then
    raise exception 'approved recovery case required' using errcode = '42501';
  end if;

  select count(*)::integer into v_approval_count
  from private.account_recovery_case_approvals approval
  where approval.recovery_case_id = p_case_id;
  if v_case.verified_at is null or v_approval_count < v_case.required_approvals then
    raise exception 'verified case and required independent approvals required'
      using errcode = '42501';
  end if;

  v_resumed := v_case.status = 'executing';
  if not v_resumed then
    insert into private.account_recovery_execution_sessions (
      recovery_case_id, session_id, user_id
    )
    select p_case_id, auth_session.id, auth_session.user_id
    from auth.sessions auth_session
    where auth_session.user_id = v_case.target_user_id
    on conflict (recovery_case_id, session_id) do nothing;
  end if;

  update private.account_recovery_cases recovery_case
  set status = 'executing',
      execution_version = v_execution_version,
      execution_actor_user_id = p_actor_user_id,
      execution_started_at = coalesce(recovery_case.execution_started_at, now()),
      execution_attempt_count = recovery_case.execution_attempt_count + 1
  where recovery_case.id = p_case_id;
  insert into private.account_recovery_case_events (
    recovery_case_id, organization_id, actor_user_id, event_type, metadata
  ) values (
    p_case_id, p_organization_id, p_actor_user_id,
    case when v_resumed then 'execution_resumed' else 'execution_started' end,
    jsonb_build_object(
      'attempt_number', v_case.execution_attempt_count + 1,
      'captured_session_count', (
        select count(*)::integer
        from private.account_recovery_execution_sessions execution_session
        where execution_session.recovery_case_id = p_case_id
      )
    )
  );

  v_response := jsonb_build_object(
    'case_id', p_case_id,
    'status', 'executing',
    'target_user_id', v_case.target_user_id,
    'factor_id', v_case.target_factor_id,
    'factor_type', v_case.target_factor_type,
    'execution_version', v_execution_version,
    'resumed', v_resumed,
    'factor_deletion_required', true,
    'finalization_required', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/auth/recovery/cases/:id/execute', p_idempotency_key,
    p_request_sha256, v_response, 202
  );
end;
$$;

create or replace function private.bff_cancel_account_recovery_execution_impl(
  p_case_id uuid,
  p_execution_version uuid,
  p_actor_user_id uuid,
  p_failure_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_case private.account_recovery_cases%rowtype;
begin
  perform private.require_service_role();
  if p_failure_code not in ('factor_missing_before_delete', 'factor_not_verified_totp') then
    raise exception 'invalid recovery cancellation code' using errcode = '22023';
  end if;
  select * into v_case
  from private.account_recovery_cases recovery_case
  where recovery_case.id = p_case_id
  for update;
  if not found then raise exception 'recovery case not found' using errcode = 'P0002'; end if;
  if v_case.status <> 'executing'
    or v_case.execution_version is distinct from p_execution_version
    or v_case.execution_actor_user_id is distinct from p_actor_user_id then
    raise exception 'current recovery execution claim required' using errcode = '42501';
  end if;
  update private.account_recovery_cases recovery_case
  set status = 'rejected',
      rejected_at = now(),
      rejected_by_user_id = p_actor_user_id,
      rejection_reason = case p_failure_code
        when 'factor_missing_before_delete' then 'Target factor was absent before reset execution'
        else 'Target factor was not a verified TOTP factor at reset execution'
      end
  where recovery_case.id = p_case_id;
  insert into private.account_recovery_case_events (
    recovery_case_id, organization_id, actor_user_id, event_type, metadata
  ) values (
    p_case_id, v_case.organization_id, p_actor_user_id, 'rejected',
    jsonb_build_object('failure_code', p_failure_code)
  );
  return jsonb_build_object(
    'case_id', p_case_id, 'status', 'rejected', 'failure_code', p_failure_code
  );
end;
$$;

create or replace function private.bff_finalize_account_recovery_execution_impl(
  p_case_id uuid,
  p_execution_version uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_factor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_case private.account_recovery_cases%rowtype;
  v_revoked_bindings integer := 0;
  v_revoked_devices integer := 0;
  v_deleted_sessions integer := 0;
  v_snapshot_sessions integer := 0;
  v_security_event_id bigint;
  v_notice_id bigint;
begin
  perform private.require_service_role();
  select * into v_case
  from private.account_recovery_cases recovery_case
  where recovery_case.id = p_case_id
  for update;
  if not found then raise exception 'recovery case not found' using errcode = 'P0002'; end if;

  if v_case.status = 'completed' then
    if v_case.target_user_id is distinct from p_target_user_id
      or v_case.target_factor_id is distinct from p_factor_id
      or v_case.execution_version is distinct from p_execution_version
      or v_case.execution_actor_user_id is distinct from p_actor_user_id then
      raise exception 'completed recovery target mismatch' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'case_id', p_case_id,
      'status', 'completed',
      'completed', true,
      'already_completed', true,
      'security_notice_state', 'pending_external_delivery'
    );
  end if;
  if v_case.status <> 'executing'
    or v_case.execution_version is distinct from p_execution_version
    or v_case.execution_actor_user_id is distinct from p_actor_user_id
    or v_case.target_user_id is distinct from p_target_user_id
    or v_case.target_factor_id is distinct from p_factor_id then
    raise exception 'current recovery execution claim and exact target required'
      using errcode = '42501';
  end if;

  select count(*)::integer into v_snapshot_sessions
  from private.account_recovery_execution_sessions execution_session
  where execution_session.recovery_case_id = p_case_id;

  insert into private.session_revocations (
    organization_id, session_id, user_id, revoked_by_user_id, reason
  )
  select v_case.organization_id, execution_session.session_id,
    v_case.target_user_id, p_actor_user_id,
    'Approved helpdesk factor reset revoked all sessions'
  from private.account_recovery_execution_sessions execution_session
  where execution_session.recovery_case_id = p_case_id
  on conflict (organization_id, session_id) do nothing;

  update private.session_installations binding
  set revoked_at = coalesce(binding.revoked_at, now())
  where binding.user_id = v_case.target_user_id
    and binding.revoked_at is null;
  get diagnostics v_revoked_bindings = row_count;

  update public.device_registrations device
  set revoked_at = coalesce(device.revoked_at, now())
  where device.user_id = v_case.target_user_id
    and device.revoked_at is null;
  get diagnostics v_revoked_devices = row_count;

  delete from auth.sessions auth_session
  where auth_session.user_id = v_case.target_user_id;
  get diagnostics v_deleted_sessions = row_count;

  update private.account_recovery_cases recovery_case
  set status = 'completed',
      factor_deleted_at = now(),
      completed_at = now()
  where recovery_case.id = p_case_id;
  insert into private.account_recovery_case_events (
    recovery_case_id, organization_id, actor_user_id, event_type, metadata
  ) values
    (
      p_case_id, v_case.organization_id, p_actor_user_id,
      'factor_deletion_confirmed', jsonb_build_object('factor_type', 'totp')
    ),
    (
      p_case_id, v_case.organization_id, p_actor_user_id, 'completed',
      jsonb_build_object(
        'captured_sessions', v_snapshot_sessions,
        'session_bindings_revoked', v_revoked_bindings,
        'devices_revoked', v_revoked_devices
      )
    );

  insert into private.account_security_events (
    user_id, organization_id, actor_user_id, event_type, recovery_case_id, metadata
  ) values (
    v_case.target_user_id, v_case.organization_id, p_actor_user_id,
    'factor_reset_completed', p_case_id,
    jsonb_build_object(
      'captured_sessions', v_snapshot_sessions,
      'auth_sessions_deleted_during_finalization', v_deleted_sessions,
      'session_bindings_revoked', v_revoked_bindings,
      'devices_revoked', v_revoked_devices,
      'all_sessions_revoked', true
    )
  ) returning id into v_security_event_id;
  insert into private.account_security_notices (
    security_event_id, user_id, organization_id, notice_type
  ) values (
    v_security_event_id, v_case.target_user_id, v_case.organization_id,
    'factor_reset_completed'
  ) returning id into v_notice_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    v_case.organization_id, p_actor_user_id, 'account.factor_reset.completed',
    'account_recovery_case', p_case_id::text,
    jsonb_build_object(
      'security_event_id', v_security_event_id,
      'target_user_id', v_case.target_user_id,
      'all_sessions_revoked', true,
      'notification_queued', true
    )
  );
  return jsonb_build_object(
    'case_id', p_case_id,
    'status', 'completed',
    'completed', true,
    'factor_deleted', true,
    'all_sessions_revoked', true,
    'captured_sessions', v_snapshot_sessions,
    'auth_sessions_deleted_during_finalization', v_deleted_sessions,
    'session_bindings_revoked', v_revoked_bindings,
    'devices_revoked', v_revoked_devices,
    'security_event_recorded', true,
    'security_notice_id', v_notice_id,
    'security_notice_state', 'pending_external_delivery'
  );
end;
$$;

create or replace function public.bff_authorize_account_recovery_otp(
  p_destination_type text,
  p_destination text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_authorize_account_recovery_otp_impl(
    p_destination_type, p_destination, p_ip_hash, p_installation_hash, p_purpose
  )
$$;

create or replace function public.bff_complete_account_recovery(
  p_actor_user_id uuid,
  p_current_session_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_complete_account_recovery_impl(
    p_actor_user_id, p_current_session_id
  )
$$;

create or replace function public.bff_create_account_recovery_case(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_factor_id uuid,
  p_factor_type text,
  p_factor_status text,
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
  select private.bff_create_account_recovery_case_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_factor_id, p_factor_type, p_factor_status, p_reason,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_record_account_recovery_verification(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_verification_method text,
  p_verification_reference_hash text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_record_account_recovery_verification_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_case_id,
    p_verification_method, p_verification_reference_hash,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_approve_account_recovery_case(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_approve_account_recovery_case_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_case_id,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_reject_account_recovery_case(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
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
  select private.bff_reject_account_recovery_case_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_case_id, p_reason,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_list_account_recovery_cases(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_include_organization boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_list_account_recovery_cases_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_include_organization
  )
$$;

create or replace function public.bff_prepare_account_recovery_execution(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_prepare_account_recovery_execution_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_case_id,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_cancel_account_recovery_execution(
  p_case_id uuid,
  p_execution_version uuid,
  p_actor_user_id uuid,
  p_failure_code text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_cancel_account_recovery_execution_impl(
    p_case_id, p_execution_version, p_actor_user_id, p_failure_code
  )
$$;

create or replace function public.bff_finalize_account_recovery_execution(
  p_case_id uuid,
  p_execution_version uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_factor_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_finalize_account_recovery_execution_impl(
    p_case_id, p_execution_version, p_actor_user_id,
    p_target_user_id, p_factor_id
  )
$$;

revoke all on table
  private.account_security_events,
  private.account_security_notices,
  private.account_recovery_cases,
  private.account_recovery_case_approvals,
  private.account_recovery_case_events,
  private.account_recovery_execution_sessions
from public, anon, authenticated, service_role;

revoke execute on function
  public.bff_authorize_account_recovery_otp(text, text, text, text, text),
  public.bff_complete_account_recovery(uuid, uuid),
  public.bff_create_account_recovery_case(uuid, uuid, uuid, uuid, text, text, text, text, text),
  public.bff_record_account_recovery_verification(uuid, uuid, uuid, uuid, text, text, text, text),
  public.bff_approve_account_recovery_case(uuid, uuid, uuid, uuid, text, text),
  public.bff_reject_account_recovery_case(uuid, uuid, uuid, uuid, text, text, text),
  public.bff_list_account_recovery_cases(uuid, uuid, uuid, boolean),
  public.bff_prepare_account_recovery_execution(uuid, uuid, uuid, uuid, text, text),
  public.bff_cancel_account_recovery_execution(uuid, uuid, uuid, text),
  public.bff_finalize_account_recovery_execution(uuid, uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.bff_authorize_account_recovery_otp(text, text, text, text, text),
  public.bff_complete_account_recovery(uuid, uuid),
  public.bff_create_account_recovery_case(uuid, uuid, uuid, uuid, text, text, text, text, text),
  public.bff_record_account_recovery_verification(uuid, uuid, uuid, uuid, text, text, text, text),
  public.bff_approve_account_recovery_case(uuid, uuid, uuid, uuid, text, text),
  public.bff_reject_account_recovery_case(uuid, uuid, uuid, uuid, text, text, text),
  public.bff_list_account_recovery_cases(uuid, uuid, uuid, boolean),
  public.bff_prepare_account_recovery_execution(uuid, uuid, uuid, uuid, text, text),
  public.bff_cancel_account_recovery_execution(uuid, uuid, uuid, text),
  public.bff_finalize_account_recovery_execution(uuid, uuid, uuid, uuid, uuid)
to service_role;

revoke execute on function
  private.prevent_account_recovery_evidence_mutation(),
  private.assert_recovery_manager_internal(uuid, uuid, uuid, text),
  private.expire_account_recovery_case_internal(private.account_recovery_cases),
  private.bff_authorize_account_recovery_otp_impl(text, text, text, text, text),
  private.bff_complete_account_recovery_impl(uuid, uuid),
  private.bff_create_account_recovery_case_impl(uuid, uuid, uuid, uuid, text, text, text, text, text),
  private.bff_record_account_recovery_verification_impl(uuid, uuid, uuid, uuid, text, text, text, text),
  private.bff_approve_account_recovery_case_impl(uuid, uuid, uuid, uuid, text, text),
  private.bff_reject_account_recovery_case_impl(uuid, uuid, uuid, uuid, text, text, text),
  private.bff_list_account_recovery_cases_impl(uuid, uuid, uuid, boolean),
  private.bff_prepare_account_recovery_execution_impl(uuid, uuid, uuid, uuid, text, text),
  private.bff_cancel_account_recovery_execution_impl(uuid, uuid, uuid, text),
  private.bff_finalize_account_recovery_execution_impl(uuid, uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  private.bff_authorize_account_recovery_otp_impl(text, text, text, text, text),
  private.bff_complete_account_recovery_impl(uuid, uuid),
  private.bff_create_account_recovery_case_impl(uuid, uuid, uuid, uuid, text, text, text, text, text),
  private.bff_record_account_recovery_verification_impl(uuid, uuid, uuid, uuid, text, text, text, text),
  private.bff_approve_account_recovery_case_impl(uuid, uuid, uuid, uuid, text, text),
  private.bff_reject_account_recovery_case_impl(uuid, uuid, uuid, uuid, text, text, text),
  private.bff_list_account_recovery_cases_impl(uuid, uuid, uuid, boolean),
  private.bff_prepare_account_recovery_execution_impl(uuid, uuid, uuid, uuid, text, text),
  private.bff_cancel_account_recovery_execution_impl(uuid, uuid, uuid, text),
  private.bff_finalize_account_recovery_execution_impl(uuid, uuid, uuid, uuid, uuid)
to service_role;

comment on table private.account_recovery_cases is
  'Lost-TOTP helpdesk cases. Newone records a hash of externally verified evidence; it does not itself perform the human identity-proofing step.';
comment on table private.account_recovery_case_events is
  'Append-only state-transition evidence for account recovery cases.';
comment on table private.account_security_notices is
  'Durable user-notification intent. External security-notice delivery remains a separately verified release dependency.';
comment on function public.bff_finalize_account_recovery_execution(uuid, uuid, uuid, uuid, uuid) is
  'Retryable second phase called only after Supabase Admin deleteFactor succeeds or a resumed execution proves the factor is already absent.';

commit;
