-- Keep organization-bound rate-limit state attributable and exactly removable.
-- The enforcement key remains a one-way hash; this nullable foreign key only
-- records an organization when the trusted key begins with an existing
-- organization UUID followed by a colon. Global Auth/recovery buckets stay
-- unscoped and cannot be swept by organization cleanup.

alter table private.rate_limit_buckets
  add column organization_id uuid
  references public.organizations (id)
  on delete cascade;

create index rate_limit_buckets_organization_idx
  on private.rate_limit_buckets (organization_id);

create or replace function private.consume_rate_limit(
  p_scope text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_now timestamptz;
  v_key_hash bytea;
  v_window_start timestamptz;
  v_count integer;
  v_organization_id uuid;
  v_key_prefix text;
begin
  if v_user_id is null and v_jwt_role <> 'service_role' then
    return false;
  end if;

  if p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit configuration' using errcode = '22023';
  end if;

  v_key_hash := extensions.digest(p_key, 'sha256');
  if pg_catalog.strpos(p_key, ':') > 0 then
    v_key_prefix := pg_catalog.split_part(p_key, ':', 1);
    if v_key_prefix ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      select organization.id
      into v_organization_id
      from public.organizations organization
      where organization.id = v_key_prefix::uuid;
    end if;
  end if;

  -- Serialize a scope/key pair before locating its active bucket. Buckets are
  -- anchored to the first request instead of wall-clock boundaries, preventing
  -- a caller from doubling its burst allowance by straddling an epoch edge.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_scope || pg_catalog.chr(31) || p_key, 0)
  );
  -- A waiter may have spent most or all of a window behind the lock. Read the
  -- clock only after admission so it never evaluates buckets with stale time.
  v_now := clock_timestamp();

  select bucket.window_started_at
  into v_window_start
  from private.rate_limit_buckets bucket
  where bucket.scope = p_scope
    and bucket.key_hash = v_key_hash
    and bucket.window_started_at > v_now - make_interval(secs => p_window_seconds)
    and bucket.expires_at = bucket.window_started_at
      + make_interval(secs => p_window_seconds * 2)
  order by bucket.window_started_at desc
  limit 1
  for update;

  if found then
    update private.rate_limit_buckets bucket
    set request_count = bucket.request_count + 1,
        organization_id = coalesce(bucket.organization_id, v_organization_id)
    where bucket.scope = p_scope
      and bucket.key_hash = v_key_hash
      and bucket.window_started_at = v_window_start
    returning bucket.request_count into v_count;
  else
    v_window_start := v_now;
    insert into private.rate_limit_buckets (
      scope,
      key_hash,
      window_started_at,
      request_count,
      expires_at,
      organization_id
    ) values (
      p_scope,
      v_key_hash,
      v_window_start,
      1,
      v_window_start + make_interval(secs => p_window_seconds * 2),
      v_organization_id
    )
    returning request_count into v_count;
  end if;

  return v_count <= p_limit;
end;
$$;

comment on table private.rate_limit_buckets is
  'Atomic first-request-anchored counters. Organization-prefixed trusted keys carry an exact tenant FK; global Auth and recovery counters remain unscoped.';
comment on column private.rate_limit_buckets.organization_id is
  'Exact cleanup ownership inferred only when a trusted rate key starts with an existing organization UUID and a colon.';
comment on function private.consume_rate_limit(text, text, integer, integer) is
  'Trusted-server primitive. It hashes enforcement keys, records exact tenant ownership for organization-prefixed keys, and is not executable by Data API roles.';
