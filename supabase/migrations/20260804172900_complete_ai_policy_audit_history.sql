begin;

create or replace function private.valid_ai_provider_allowlist(p_providers text[])
returns boolean
language sql
immutable
parallel safe
security invoker
set search_path = ''
as $$
  select p_providers is not null
    and cardinality(p_providers) between 0 and 20
    and array_position(p_providers, null) is null
    and not exists (
      select 1
      from unnest(p_providers) provider
      where provider !~ '^[a-z0-9][a-z0-9._/-]{1,159}$'
    )
$$;

-- Every AI egress decision is retained as an immutable policy snapshot. The
-- current row remains the fast authorization source; this table is evidence,
-- not a second mutable policy surface.
create table public.organization_ai_policy_versions (
  organization_id uuid not null references public.organizations(id) on delete restrict,
  policy_version integer not null check (policy_version >= 1),
  enabled boolean not null,
  approved_use_cases text[] not null default array[]::text[],
  provider_allowlist text[] not null default array[]::text[],
  route_policy text not null check (route_policy in ('deny', 'approved_zero_retention')),
  changed_by_user_id uuid not null,
  changed_at timestamptz not null default now(),
  change_reason text not null check (char_length(btrim(change_reason)) between 3 and 500),
  request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
  primary key (organization_id, policy_version),
  foreign key (organization_id, changed_by_user_id)
    references public.organization_memberships (organization_id, user_id)
    on delete restrict,
  check (cardinality(approved_use_cases) between 0 and 3),
  check (approved_use_cases <@ array['language_detection', 'translation', 'summary']::text[]),
  check (array_position(approved_use_cases, null) is null),
  check (private.valid_ai_provider_allowlist(provider_allowlist)),
  check (
    (enabled and route_policy = 'approved_zero_retention'
      and cardinality(approved_use_cases) > 0
      and cardinality(provider_allowlist) > 0)
    or
    (not enabled and route_policy = 'deny'
      and cardinality(approved_use_cases) = 0
      and cardinality(provider_allowlist) = 0)
  )
);

create index organization_ai_policy_versions_changed_idx
  on public.organization_ai_policy_versions (organization_id, changed_at desc);

alter table public.organization_ai_policy_versions enable row level security;
alter table public.organization_ai_policy_versions force row level security;
revoke all on table public.organization_ai_policy_versions
  from public, anon, authenticated, service_role;

create or replace function private.prevent_ai_policy_version_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'organization AI policy versions are immutable'
    using errcode = '55000';
end;
$$;

create trigger organization_ai_policy_versions_immutable
before update or delete on public.organization_ai_policy_versions
for each row execute function private.prevent_ai_policy_version_mutation();

revoke all on function private.prevent_ai_policy_version_mutation()
  from public, anon, authenticated, service_role;
revoke all on function private.valid_ai_provider_allowlist(text[])
  from public, anon, authenticated, service_role;

create or replace function private.bff_set_organization_ai_policy_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_enabled boolean,
  p_approved_use_cases text[],
  p_provider_allowlist text[],
  p_route_policy text,
  p_expected_version integer,
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
  v_current_version integer;
  v_version integer;
  v_use_cases text[];
  v_providers text[];
  v_response jsonb;
  v_changed_at timestamptz := now();
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai.policy.set', true, 0, '/v2/admin/ai-policy',
    p_idempotency_key, p_request_sha256
  );
  if not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'ai.policy.manage', null
  ) then
    raise exception 'AI policy management permission required' using errcode = '42501';
  end if;
  -- Recheck five-minute freshness before both first execution and replay when
  -- employee-data egress is being enabled. Revocation remains available to a
  -- current AAL2 policy manager regardless of login age.
  if p_enabled then
    perform private.assert_bff_request_internal(
      p_actor_user_id, p_organization_id, p_session_id,
      'ai.policy.enable', true, 300
    );
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  if p_enabled is null
    or p_route_policy is null
    or p_expected_version is null or p_expected_version < 0
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500
    or cardinality(coalesce(p_approved_use_cases, array[]::text[])) not between 0 and 3
    or not (coalesce(p_approved_use_cases, array[]::text[]) <@
      array['language_detection', 'translation', 'summary']::text[])
    or exists (
      select 1
      from unnest(coalesce(p_approved_use_cases, array[]::text[])) use_case
      where use_case is null
    )
    or cardinality(coalesce(p_provider_allowlist, array[]::text[])) not between 0 and 20
    or (p_enabled and (
      cardinality(coalesce(p_approved_use_cases, array[]::text[])) = 0
      or cardinality(coalesce(p_provider_allowlist, array[]::text[])) = 0
      or p_route_policy <> 'approved_zero_retention'
    ))
    or (not p_enabled and (
      p_route_policy <> 'deny'
      or cardinality(coalesce(p_approved_use_cases, array[]::text[])) <> 0
      or cardinality(coalesce(p_provider_allowlist, array[]::text[])) <> 0
    ))
    or exists (
      select 1
      from unnest(coalesce(p_provider_allowlist, array[]::text[])) provider
      where provider is null or provider !~ '^[a-z0-9][a-z0-9._/-]{1,159}$'
    ) then
    raise exception 'authorized valid tenant AI policy required' using errcode = '42501';
  end if;

  perform 1
  from public.organizations organization
  where organization.id = p_organization_id
  for update;
  if not found then
    raise exception 'organization not found' using errcode = '23503';
  end if;

  select policy.policy_version into v_current_version
  from public.organization_ai_policies policy
  where policy.organization_id = p_organization_id;
  v_current_version := coalesce(v_current_version, 0);
  if v_current_version <> p_expected_version then
    raise exception 'organization AI policy version conflict' using errcode = '40001';
  end if;

  v_version := v_current_version + 1;
  v_use_cases := case when p_enabled then array(
    select distinct lower(value)
    from unnest(p_approved_use_cases) value
    order by 1
  ) else array[]::text[] end;
  v_providers := case when p_enabled then array(
    select distinct lower(value)
    from unnest(p_provider_allowlist) value
    order by 1
  ) else array[]::text[] end;

  insert into public.organization_ai_policies (
    organization_id, enabled, policy_version, approved_use_cases,
    provider_allowlist, route_policy, approved_by_user_id, approved_at,
    revoked_by_user_id, revoked_at, revocation_reason
  ) values (
    p_organization_id, p_enabled, v_version, v_use_cases,
    v_providers, p_route_policy,
    case when p_enabled then p_actor_user_id else null end,
    case when p_enabled then v_changed_at else null end,
    case when p_enabled then null else p_actor_user_id end,
    case when p_enabled then null else v_changed_at end,
    case when p_enabled then null else btrim(p_reason) end
  ) on conflict (organization_id) do update
  set enabled = excluded.enabled,
      policy_version = excluded.policy_version,
      approved_use_cases = excluded.approved_use_cases,
      provider_allowlist = excluded.provider_allowlist,
      route_policy = excluded.route_policy,
      approved_by_user_id = excluded.approved_by_user_id,
      approved_at = excluded.approved_at,
      revoked_by_user_id = excluded.revoked_by_user_id,
      revoked_at = excluded.revoked_at,
      revocation_reason = excluded.revocation_reason,
      updated_at = v_changed_at;

  insert into public.organization_ai_policy_versions (
    organization_id, policy_version, enabled, approved_use_cases,
    provider_allowlist, route_policy, changed_by_user_id, changed_at,
    change_reason, request_sha256
  ) values (
    p_organization_id, v_version, p_enabled, v_use_cases,
    v_providers, p_route_policy, p_actor_user_id, v_changed_at,
    btrim(p_reason), p_request_sha256
  );

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id,
    p_actor_user_id,
    case when p_enabled
      then 'organization.ai_policy.enabled'
      else 'organization.ai_policy.revoked'
    end,
    'organization_ai_policy',
    p_organization_id::text,
    jsonb_build_object(
      'policy_version', v_version,
      'enabled', p_enabled,
      'approved_use_cases', to_jsonb(v_use_cases),
      'provider_allowlist', to_jsonb(v_providers),
      'route_policy', p_route_policy,
      'reason', btrim(p_reason),
      'request_sha256', p_request_sha256
    )
  );

  v_response := jsonb_build_object(
    'organization_id', p_organization_id,
    'enabled', p_enabled,
    'policy_version', v_version,
    'approved_use_cases', to_jsonb(v_use_cases),
    'provider_allowlist', to_jsonb(v_providers),
    'route_policy', p_route_policy,
    'tenant_approved', p_enabled,
    'global_kill_switch_still_required', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/ai-policy',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

revoke all on function private.bff_set_organization_ai_policy_v2_impl(
  uuid, uuid, uuid, boolean, text[], text[], text, integer, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_set_organization_ai_policy_v2_impl(
  uuid, uuid, uuid, boolean, text[], text[], text, integer, text, text, text
) to service_role;

commit;
