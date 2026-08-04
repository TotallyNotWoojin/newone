begin;

-- Complete the privileged organization AI-policy administration contract.
-- The v2 command adds compare-and-set semantics so concurrent security
-- administrators cannot silently overwrite one another. The legacy setter is
-- revoked below because it cannot provide that guarantee.

create or replace function private.bff_get_organization_ai_policy_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_policy public.organization_ai_policies%rowtype;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai.policy.read', true, 0
  );
  if not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'ai.policy.manage', null
  ) then
    raise exception 'AI policy management permission required' using errcode = '42501';
  end if;

  select policy.* into v_policy
  from public.organization_ai_policies policy
  where policy.organization_id = p_organization_id;

  if not found then
    return jsonb_build_object(
      'organization_id', p_organization_id,
      'enabled', false,
      'policy_version', 0,
      'approved_use_cases', '[]'::jsonb,
      'provider_allowlist', '[]'::jsonb,
      'route_policy', 'deny',
      'tenant_approved', false,
      'global_kill_switch_still_required', true
    );
  end if;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'enabled', v_policy.enabled,
    'policy_version', v_policy.policy_version,
    'approved_use_cases', to_jsonb(v_policy.approved_use_cases),
    'provider_allowlist', to_jsonb(v_policy.provider_allowlist),
    'route_policy', v_policy.route_policy,
    'tenant_approved', v_policy.enabled and v_policy.revoked_at is null,
    'global_kill_switch_still_required', true
  );
end;
$$;

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
  -- Enabling employee-data egress requires a login no more than five minutes
  -- old, including an idempotent replay. Revocation intentionally remains
  -- available to any current AAL2 policy manager even when that login is older.
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

  -- Lock one stable tenant row so both the initial insert and later updates use
  -- the same serialization point.
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
    case when p_enabled then now() else null end,
    case when p_enabled then null else p_actor_user_id end,
    case when p_enabled then null else now() end,
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
      updated_at = now();

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

create or replace function public.bff_get_organization_ai_policy(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_get_organization_ai_policy_impl(
    p_actor_user_id, p_organization_id, p_session_id
  )
$$;

create or replace function public.bff_set_organization_ai_policy_v2(
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
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_set_organization_ai_policy_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_enabled,
    p_approved_use_cases, p_provider_allowlist, p_route_policy,
    p_expected_version, p_reason, p_idempotency_key, p_request_sha256
  )
$$;

-- The legacy setter has no expected-version argument. It has no Edge caller
-- and must not remain an executable service-role bypass around the CAS path.
revoke execute on function public.bff_set_organization_ai_policy(
  uuid, uuid, uuid, boolean, text[], text[], text, text, text, text
) from service_role;
revoke execute on function private.bff_set_organization_ai_policy_impl(
  uuid, uuid, uuid, boolean, text[], text[], text, text, text, text
) from service_role;

-- Policy rows are readable only through the service-role BFF getter, which
-- rechecks tenant permission and current AAL2. A fixed five-minute freshness
-- window is reserved for enabling egress; reads remain available for recovery.
-- RLS alone is not that authorization boundary, so authenticated Data API
-- reads must not retain table privilege.
revoke select on table public.organization_ai_policies from authenticated;

revoke all on function public.bff_get_organization_ai_policy(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.bff_set_organization_ai_policy_v2(
  uuid, uuid, uuid, boolean, text[], text[], text, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_get_organization_ai_policy(uuid, uuid, uuid)
  to service_role;
grant execute on function public.bff_set_organization_ai_policy_v2(
  uuid, uuid, uuid, boolean, text[], text[], text, integer, text, text, text
) to service_role;

revoke all on function private.bff_get_organization_ai_policy_impl(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function private.bff_set_organization_ai_policy_v2_impl(
  uuid, uuid, uuid, boolean, text[], text[], text, integer, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_get_organization_ai_policy_impl(uuid, uuid, uuid)
  to service_role;
grant execute on function private.bff_set_organization_ai_policy_v2_impl(
  uuid, uuid, uuid, boolean, text[], text[], text, integer, text, text, text
) to service_role;

commit;
