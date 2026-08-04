begin;

-- Keep the current row and recovered history atomic during a live migration.
-- Ordinary reads may continue; policy writes resume after the ACL change and
-- backfill commit together.
lock table public.organization_ai_policies in share row exclusive mode;

-- The service-role BFF must reach tenant AI policy only through the audited,
-- compare-and-set functions. Direct table mutation would bypass permission,
-- recent-auth, idempotency, history, and reason-bearing audit guarantees.
revoke insert, update, delete, truncate
on table public.organization_ai_policies
from public, anon, authenticated, service_role;

-- Distinguish ordinary command history from snapshots recovered from the
-- pre-history current-policy table. Existing v2 rows receive the command
-- provenance default; backfilled rows override it with exact legacy context.
alter table public.organization_ai_policy_versions
  add column provenance jsonb not null default jsonb_build_object(
    'source', 'bff_v2_command',
    'request_sha256_semantics', 'client_request_body_sha256'
  );

alter table public.organization_ai_policy_versions
  add constraint organization_ai_policy_versions_provenance_valid check (
    jsonb_typeof(provenance) = 'object'
    and octet_length(provenance::text) <= 4096
    and (
      provenance @> jsonb_build_object(
        'source', 'bff_v2_command',
        'request_sha256_semantics', 'client_request_body_sha256'
      )
      or provenance @> jsonb_build_object(
        'source', 'legacy_current_policy_backfill',
        'request_sha256_semantics', 'canonical_current_policy_snapshot_sha256_v1'
      )
    )
  );

create or replace function private.backfill_organization_ai_policy_history()
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_inserted integer;
begin
  if exists (
    select 1
    from public.organization_ai_policies policy
    where case when policy.enabled
      then policy.approved_by_user_id
      else policy.revoked_by_user_id
    end is null
  ) then
    raise exception 'legacy AI policy actor provenance is incomplete' using errcode = '23514';
  end if;

  insert into public.organization_ai_policy_versions (
    organization_id,
    policy_version,
    enabled,
    approved_use_cases,
    provider_allowlist,
    route_policy,
    changed_by_user_id,
    changed_at,
    change_reason,
    request_sha256,
    provenance
  )
  select
    policy.organization_id,
    policy.policy_version,
    policy.enabled,
    policy.approved_use_cases,
    policy.provider_allowlist,
    policy.route_policy,
    case when policy.enabled
      then policy.approved_by_user_id
      else policy.revoked_by_user_id
    end,
    case when policy.enabled
      then policy.approved_at
      else policy.revoked_at
    end,
    case when policy.enabled then
      'Legacy current-policy snapshot backfilled; original approval reason was not retained.'
    else
      left(
        'Legacy current-policy snapshot backfilled: ' || policy.revocation_reason,
        500
      )
    end,
    encode(extensions.digest(convert_to(jsonb_build_object(
      'format', 'newone_ai_policy_current_snapshot_v1',
      'organization_id', policy.organization_id,
      'policy_version', policy.policy_version,
      'enabled', policy.enabled,
      'approved_use_cases', to_jsonb(policy.approved_use_cases),
      'provider_allowlist', to_jsonb(policy.provider_allowlist),
      'route_policy', policy.route_policy,
      'approved_by_user_id', policy.approved_by_user_id,
      'approved_at', policy.approved_at,
      'revoked_by_user_id', policy.revoked_by_user_id,
      'revoked_at', policy.revoked_at,
      'revocation_reason', policy.revocation_reason,
      'updated_at', policy.updated_at
    )::text, 'UTF8'), 'sha256'), 'hex'),
    jsonb_strip_nulls(jsonb_build_object(
      'source', 'legacy_current_policy_backfill',
      'migration', '20260804173100_harden_ai_policy_authority_history',
      'request_sha256_semantics', 'canonical_current_policy_snapshot_sha256_v1',
      'original_request_sha256_available', false,
      'current_policy_updated_at', policy.updated_at,
      'original_approved_by_user_id', policy.approved_by_user_id,
      'original_approved_at', policy.approved_at,
      'original_revoked_by_user_id', policy.revoked_by_user_id,
      'original_revoked_at', policy.revoked_at,
      'original_revocation_reason', policy.revocation_reason
    ))
  from public.organization_ai_policies policy
  on conflict (organization_id, policy_version) do nothing;

  get diagnostics v_inserted = row_count;

  -- Idempotent conflict handling must never conceal a divergent current row.
  if exists (
    select 1
    from public.organization_ai_policies policy
    left join public.organization_ai_policy_versions history
      on history.organization_id = policy.organization_id
     and history.policy_version = policy.policy_version
    where history.organization_id is null
      or history.enabled is distinct from policy.enabled
      or history.approved_use_cases is distinct from policy.approved_use_cases
      or history.provider_allowlist is distinct from policy.provider_allowlist
      or history.route_policy is distinct from policy.route_policy
      or history.changed_by_user_id is distinct from case when policy.enabled
        then policy.approved_by_user_id
        else policy.revoked_by_user_id
      end
      or history.changed_at is distinct from case when policy.enabled
        then policy.approved_at
        else policy.revoked_at
      end
  ) then
    raise exception 'current AI policy does not match immutable history' using errcode = '23514';
  end if;

  return v_inserted;
end;
$$;

revoke all on function private.backfill_organization_ai_policy_history()
from public, anon, authenticated, service_role;

select private.backfill_organization_ai_policy_history();

commit;
