begin;

-- Preserve the exact client-facing execute ACLs of pre-existing private
-- functions while this migration revokes the default PUBLIC execute grant
-- from every newly created helper.
create temporary table dynamic_group_private_function_acl_snapshot
on commit drop
as
select function_row.oid as function_oid,
  case when acl.grantee = 0 then 'public'::text else role_row.rolname end as grantee
from pg_catalog.pg_proc function_row
join pg_catalog.pg_namespace namespace_row
  on namespace_row.oid = function_row.pronamespace
cross join lateral pg_catalog.aclexplode(coalesce(
  function_row.proacl,
  pg_catalog.acldefault('f', function_row.proowner)
)) acl
left join pg_catalog.pg_roles role_row on role_row.oid = acl.grantee
where namespace_row.nspname = 'private'
  and acl.privilege_type = 'EXECUTE'
  and (
    acl.grantee = 0
    or role_row.rolname in ('anon', 'authenticated')
  );

-- CHAT-04: policy-managed team groups.  Conversation membership remains a
-- delivery/materialization cache; current policy eligibility is the security
-- boundary.  Immutable intervals preserve only the history a member actually
-- acquired while eligible.

do $block$
declare
  v_definition text;
begin
  select pg_get_constraintdef(constraint_row.oid)
    into v_definition
  from pg_constraint constraint_row
  where constraint_row.conrelid = 'public.organization_units'::regclass
    and constraint_row.conname = 'organization_units_kind_allowed';

  if coalesce(v_definition, '') not like '%line%' then
    alter table public.organization_units
      drop constraint if exists organization_units_kind_allowed;
    alter table public.organization_units
      add constraint organization_units_kind_allowed
      check (kind in ('site', 'department', 'team', 'line', 'shift'));
  end if;
end;
$block$;

create or replace function private.validate_organization_unit_hierarchy()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cycle boolean;
begin
  if new.parent_unit_id is null then
    return new;
  end if;
  if new.parent_unit_id = new.id or not exists (
    select 1
    from public.organization_units parent
    where parent.organization_id = new.organization_id
      and parent.id = new.parent_unit_id
  ) then
    raise exception 'organization unit hierarchy is invalid' using errcode = '23514';
  end if;

  with recursive ancestors(id, parent_unit_id, path, repeated) as (
    select parent.id, parent.parent_unit_id, array[parent.id], false
    from public.organization_units parent
    where parent.organization_id = new.organization_id
      and parent.id = new.parent_unit_id
    union all
    select parent.id, parent.parent_unit_id,
      ancestors.path || parent.id,
      parent.id = any(ancestors.path)
    from ancestors
    join public.organization_units parent
      on parent.organization_id = new.organization_id
     and parent.id = ancestors.parent_unit_id
    where not ancestors.repeated
  )
  select coalesce(bool_or(id = new.id or repeated), false)
    into v_cycle
  from ancestors;

  if v_cycle then
    raise exception 'organization unit hierarchy cycle is not permitted'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_units_05_validate_hierarchy
  on public.organization_units;
create trigger organization_units_05_validate_hierarchy
before insert or update of organization_id, parent_unit_id
on public.organization_units
for each row execute function private.validate_organization_unit_hierarchy();

alter table public.dynamic_group_policies
  add column if not exists policy_spec jsonb not null default
    '{"site_ids":[],"department_ids":[],"team_ids":[],"line_ids":[],"unit_ids":[],"include_descendants":true,"operational_roles":[],"membership_roles":["member"],"shift_mode":"none","scheduled_shift_starts_at":null,"scheduled_shift_ends_at":null}'::jsonb,
  add column if not exists draft_state text not null default 'draft',
  add column if not exists selector_fingerprint text not null default repeat('0', 64),
  add column if not exists published_version_id uuid,
  add column if not exists last_preview_fingerprint text,
  add column if not exists last_previewed_at timestamptz,
  add column if not exists next_evaluation_at timestamptz,
  add column if not exists source_changed_at timestamptz,
  add column if not exists maximum_members integer not null default 5000;

alter table public.dynamic_group_policies
  add constraint dynamic_group_policies_policy_spec_bounded
    check (jsonb_typeof(policy_spec) = 'object' and octet_length(policy_spec::text) <= 16384),
  add constraint dynamic_group_policies_draft_state_allowed
    check (draft_state in ('draft', 'previewed', 'published')),
  add constraint dynamic_group_policies_selector_fingerprint_format
    check (selector_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint dynamic_group_policies_preview_fingerprint_format
    check (last_preview_fingerprint is null or last_preview_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint dynamic_group_policies_maximum_members_bounded
    check (maximum_members between 1 and 5000),
  add constraint dynamic_group_policies_next_evaluation_finite
    check (next_evaluation_at is null or isfinite(next_evaluation_at)),
  add constraint dynamic_group_policies_source_changed_finite
    check (source_changed_at is null or isfinite(source_changed_at));

create table public.dynamic_group_policy_versions (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  policy_id uuid not null,
  conversation_id uuid not null,
  policy_version integer not null,
  policy_spec jsonb not null,
  selector_fingerprint text not null,
  membership_state_fingerprint text not null,
  evaluated_at timestamptz not null,
  eligible_count integer not null,
  added_count integer not null,
  removed_count integer not null,
  unchanged_count integer not null,
  published_by_user_id uuid not null,
  published_at timestamptz not null default now(),
  next_boundary_at timestamptz,
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, policy_id, policy_version),
  foreign key (organization_id, policy_id)
    references public.dynamic_group_policies (organization_id, id) on delete restrict,
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, published_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint dynamic_group_policy_versions_version_positive check (policy_version > 0),
  constraint dynamic_group_policy_versions_spec_bounded check (
    jsonb_typeof(policy_spec) = 'object' and octet_length(policy_spec::text) <= 16384
  ),
  constraint dynamic_group_policy_versions_fingerprint_format check (
    selector_fingerprint ~ '^[0-9a-f]{64}$'
    and membership_state_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint dynamic_group_policy_versions_times_finite check (
    isfinite(evaluated_at) and isfinite(published_at)
    and (next_boundary_at is null or isfinite(next_boundary_at))
  ),
  constraint dynamic_group_policy_versions_counts_bounded check (
    eligible_count between 0 and 5000
    and added_count between 0 and 5000
    and removed_count between 0 and 5000
    and unchanged_count between 0 and 5000
    and added_count + unchanged_count = eligible_count
  )
);

alter table public.dynamic_group_policies
  add constraint dynamic_group_policies_published_version_fkey
  foreign key (organization_id, published_version_id)
  references public.dynamic_group_policy_versions (organization_id, id)
  on delete restrict;

create table private.dynamic_group_policy_previews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  policy_id uuid not null,
  policy_version integer not null,
  selector_fingerprint text not null,
  membership_state_fingerprint text not null,
  preview_fingerprint text not null unique,
  evaluated_at timestamptz not null,
  valid_until timestamptz not null,
  eligible_count integer not null,
  added_count integer not null,
  removed_count integer not null,
  unchanged_count integer not null,
  added_sample uuid[] not null default '{}'::uuid[],
  removed_sample uuid[] not null default '{}'::uuid[],
  unchanged_sample uuid[] not null default '{}'::uuid[],
  next_boundary_at timestamptz,
  previewed_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, policy_id)
    references public.dynamic_group_policies (organization_id, id) on delete restrict,
  foreign key (organization_id, previewed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint dynamic_group_policy_previews_version_positive check (policy_version > 0),
  constraint dynamic_group_policy_previews_fingerprints check (
    selector_fingerprint ~ '^[0-9a-f]{64}$'
    and membership_state_fingerprint ~ '^[0-9a-f]{64}$'
    and preview_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint dynamic_group_policy_previews_time_window check (
    isfinite(evaluated_at) and isfinite(valid_until) and valid_until > created_at
    and valid_until <= created_at + interval '10 minutes'
    and (next_boundary_at is null or isfinite(next_boundary_at))
  ),
  constraint dynamic_group_policy_previews_counts check (
    eligible_count between 0 and 5000 and added_count between 0 and 5000
    and removed_count between 0 and 5000 and unchanged_count between 0 and 5000
    and added_count + unchanged_count = eligible_count
  ),
  constraint dynamic_group_policy_previews_samples_bounded check (
    cardinality(added_sample) <= 200 and cardinality(removed_sample) <= 200
    and cardinality(unchanged_sample) <= 200
  )
);

create table private.dynamic_group_access_intervals (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  policy_id uuid not null,
  policy_version_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  valid_from timestamptz not null,
  valid_until timestamptz,
  eligibility_valid_until timestamptz,
  cancelled_at timestamptz,
  history_visible_from timestamptz,
  selector_fingerprint text not null,
  source_snapshot jsonb not null default '{}'::jsonb,
  opened_reason text not null,
  closed_reason text,
  created_at timestamptz not null default now(),
  foreign key (organization_id, policy_id)
    references public.dynamic_group_policies (organization_id, id) on delete restrict,
  foreign key (organization_id, policy_version_id)
    references public.dynamic_group_policy_versions (organization_id, id) on delete restrict,
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint dynamic_group_access_intervals_times check (
    isfinite(valid_from)
    and (valid_until is null or (isfinite(valid_until) and valid_until >= valid_from))
    and (eligibility_valid_until is null or (
      isfinite(eligibility_valid_until) and eligibility_valid_until > valid_from
    ))
    and (cancelled_at is null or isfinite(cancelled_at))
    and (history_visible_from is null or isfinite(history_visible_from))
  ),
  constraint dynamic_group_access_intervals_fingerprint check (
    selector_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  constraint dynamic_group_access_intervals_snapshot_bounded check (
    jsonb_typeof(source_snapshot) = 'object'
    and octet_length(source_snapshot::text) <= 16384
  ),
  constraint dynamic_group_access_intervals_reason_bounded check (
    char_length(opened_reason) between 1 and 120
    and (closed_reason is null or char_length(closed_reason) between 1 and 120)
  )
);

create unique index dynamic_group_access_intervals_one_open_idx
  on private.dynamic_group_access_intervals (organization_id, policy_id, user_id)
  where valid_until is null and cancelled_at is null;
create index dynamic_group_access_intervals_history_idx
  on private.dynamic_group_access_intervals (
    organization_id, conversation_id, user_id, valid_from, valid_until
  );

create table private.dynamic_group_reconciliation_queue (
  organization_id uuid not null,
  policy_id uuid not null,
  policy_version_id uuid not null,
  reason text not null,
  cursor_user_id uuid,
  requested_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error_code text,
  primary key (organization_id, policy_id),
  foreign key (organization_id, policy_id)
    references public.dynamic_group_policies (organization_id, id) on delete restrict,
  foreign key (organization_id, policy_version_id)
    references public.dynamic_group_policy_versions (organization_id, id) on delete restrict,
  constraint dynamic_group_reconciliation_queue_reason check (
    char_length(reason) between 1 and 120
  ),
  constraint dynamic_group_reconciliation_queue_attempts check (attempts between 0 and 1000),
  constraint dynamic_group_reconciliation_queue_error check (
    last_error_code is null or char_length(last_error_code) <= 120
  )
);

create table private.dynamic_group_dirty_users (
  organization_id uuid not null,
  policy_id uuid not null,
  user_id uuid not null,
  reason text not null,
  requested_at timestamptz not null default now(),
  primary key (organization_id, policy_id, user_id),
  foreign key (organization_id, policy_id)
    references public.dynamic_group_policies (organization_id, id) on delete restrict,
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint dynamic_group_dirty_users_reason check (char_length(reason) between 1 and 120)
);

create table private.dynamic_group_policy_source_boundaries (
  organization_id uuid not null,
  policy_id uuid not null,
  boundary_at timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, policy_id, boundary_at),
  foreign key (organization_id, policy_id)
    references public.dynamic_group_policies (organization_id, id) on delete restrict,
  constraint dynamic_group_policy_source_boundaries_finite check (
    isfinite(boundary_at) and isfinite(created_at)
  ),
  constraint dynamic_group_policy_source_boundaries_reason check (
    char_length(reason) between 1 and 120
  )
);

create index dynamic_group_policy_source_boundaries_policy_idx
  on private.dynamic_group_policy_source_boundaries (
    organization_id, policy_id, boundary_at
  );

create index dynamic_group_policy_versions_policy_idx
  on public.dynamic_group_policy_versions (
    organization_id, policy_id, policy_version desc, published_at desc
  );
create index dynamic_group_policy_previews_policy_idx
  on private.dynamic_group_policy_previews (
    organization_id, policy_id, policy_version, created_at desc
  );
create index dynamic_group_reconciliation_queue_available_idx
  on private.dynamic_group_reconciliation_queue (available_at, requested_at, policy_id);

create or replace function private.normalize_dynamic_group_policy_spec(p_spec jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_site_ids uuid[];
  v_department_ids uuid[];
  v_team_ids uuid[];
  v_line_ids uuid[];
  v_unit_ids uuid[];
  v_operational_roles text[];
  v_membership_roles text[];
  v_include_descendants boolean;
  v_shift_mode text;
  v_shift_starts_at timestamptz;
  v_shift_ends_at timestamptz;
begin
  if p_spec is null or jsonb_typeof(p_spec) <> 'object'
    or octet_length(p_spec::text) > 16384
    or exists (
      select 1 from jsonb_object_keys(p_spec) key
      where key not in (
        'site_ids', 'department_ids', 'team_ids', 'line_ids', 'unit_ids',
        'include_descendants', 'operational_roles', 'membership_roles',
        'shift_mode', 'scheduled_shift_starts_at', 'scheduled_shift_ends_at'
      )
    ) then
    raise exception 'invalid dynamic-group policy selector' using errcode = '22023';
  end if;

  if p_spec ? 'include_descendants'
    and jsonb_typeof(p_spec -> 'include_descendants') <> 'boolean' then
    raise exception 'invalid dynamic-group policy selector' using errcode = '22023';
  end if;
  if exists (
    select 1 from (values
      ('site_ids'), ('department_ids'), ('team_ids'), ('line_ids'), ('unit_ids'),
      ('operational_roles'), ('membership_roles')
    ) expected(key)
    where p_spec ? expected.key
      and jsonb_typeof(p_spec -> expected.key) <> 'array'
  ) or exists (
    select 1
    from (values
      ('site_ids'), ('department_ids'), ('team_ids'), ('line_ids'), ('unit_ids'),
      ('operational_roles'), ('membership_roles')
    ) expected(key)
    cross join lateral jsonb_array_elements(
      coalesce(p_spec -> expected.key, '[]'::jsonb)
    ) item(value)
    where jsonb_typeof(item.value) <> 'string'
  ) then
    raise exception 'invalid dynamic-group policy selector' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct value::uuid order by value::uuid), '{}'::uuid[])
    into v_site_ids
  from jsonb_array_elements_text(coalesce(p_spec -> 'site_ids', '[]'::jsonb)) item(value);
  select coalesce(array_agg(distinct value::uuid order by value::uuid), '{}'::uuid[])
    into v_department_ids
  from jsonb_array_elements_text(coalesce(p_spec -> 'department_ids', '[]'::jsonb)) item(value);
  select coalesce(array_agg(distinct value::uuid order by value::uuid), '{}'::uuid[])
    into v_team_ids
  from jsonb_array_elements_text(coalesce(p_spec -> 'team_ids', '[]'::jsonb)) item(value);
  select coalesce(array_agg(distinct value::uuid order by value::uuid), '{}'::uuid[])
    into v_line_ids
  from jsonb_array_elements_text(coalesce(p_spec -> 'line_ids', '[]'::jsonb)) item(value);
  select coalesce(array_agg(distinct value::uuid order by value::uuid), '{}'::uuid[])
    into v_unit_ids
  from jsonb_array_elements_text(coalesce(p_spec -> 'unit_ids', '[]'::jsonb)) item(value);
  select coalesce(array_agg(distinct lower(btrim(value)) order by lower(btrim(value))), '{}')
    into v_operational_roles
  from jsonb_array_elements_text(
    coalesce(p_spec -> 'operational_roles', '[]'::jsonb)
  ) item(value);
  select coalesce(array_agg(distinct lower(value) order by lower(value)), '{}')
    into v_membership_roles
  from jsonb_array_elements_text(
    coalesce(p_spec -> 'membership_roles', '[]'::jsonb)
  ) item(value);

  v_include_descendants := coalesce(
    (p_spec ->> 'include_descendants')::boolean, true
  );
  v_shift_mode := lower(coalesce(p_spec ->> 'shift_mode', 'none'));
  if v_shift_mode not in ('none', 'current', 'scheduled') then
    raise exception 'invalid dynamic-group policy selector' using errcode = '22023';
  end if;
  if p_spec ->> 'scheduled_shift_starts_at' is not null then
    v_shift_starts_at := (p_spec ->> 'scheduled_shift_starts_at')::timestamptz;
  end if;
  if p_spec ->> 'scheduled_shift_ends_at' is not null then
    v_shift_ends_at := (p_spec ->> 'scheduled_shift_ends_at')::timestamptz;
  end if;

  if cardinality(v_site_ids) > 100 or cardinality(v_department_ids) > 100
    or cardinality(v_team_ids) > 100 or cardinality(v_line_ids) > 100
    or cardinality(v_unit_ids) > 100 or cardinality(v_operational_roles) > 50
    or cardinality(v_membership_roles) > 4
    or exists (
      select 1 from unnest(v_operational_roles) role_name
      where char_length(role_name) not between 1 and 160
    )
    or not v_membership_roles <@ array['owner', 'admin', 'manager', 'member']::text[]
    or (
      cardinality(v_site_ids) + cardinality(v_department_ids)
      + cardinality(v_team_ids) + cardinality(v_line_ids) + cardinality(v_unit_ids)
      + cardinality(v_operational_roles) + cardinality(v_membership_roles) = 0
      and v_shift_mode = 'none'
    )
    or (v_shift_mode <> 'scheduled' and (
      v_shift_starts_at is not null or v_shift_ends_at is not null
    ))
    or (v_shift_mode = 'scheduled' and (
      v_shift_starts_at is null or v_shift_ends_at is null
      or not isfinite(v_shift_starts_at) or not isfinite(v_shift_ends_at)
      or v_shift_ends_at <= v_shift_starts_at
      or v_shift_ends_at - v_shift_starts_at > interval '31 days'
    )) then
    raise exception 'invalid dynamic-group policy selector' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'site_ids', to_jsonb(v_site_ids),
    'department_ids', to_jsonb(v_department_ids),
    'team_ids', to_jsonb(v_team_ids),
    'line_ids', to_jsonb(v_line_ids),
    'unit_ids', to_jsonb(v_unit_ids),
    'include_descendants', v_include_descendants,
    'operational_roles', to_jsonb(v_operational_roles),
    'membership_roles', to_jsonb(v_membership_roles),
    'shift_mode', v_shift_mode,
    'scheduled_shift_starts_at', v_shift_starts_at,
    'scheduled_shift_ends_at', v_shift_ends_at
  );
exception
  when invalid_text_representation or datetime_field_overflow then
    raise exception 'invalid dynamic-group policy selector' using errcode = '22023';
end;
$$;

create or replace function private.dynamic_group_selector_fingerprint(p_spec jsonb)
returns text
language sql
stable
security invoker
set search_path = ''
as $$
  select encode(extensions.digest(
    convert_to(private.normalize_dynamic_group_policy_spec(p_spec)::text, 'UTF8'),
    'sha256'
  ), 'hex')
$$;

create or replace function private.dynamic_group_policy_evaluation_time(
  p_spec jsonb,
  p_now timestamptz
)
returns timestamptz
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_spec jsonb := private.normalize_dynamic_group_policy_spec(p_spec);
  v_start timestamptz;
begin
  if p_now is null or not isfinite(p_now) then
    raise exception 'finite dynamic-group evaluation time required' using errcode = '22023';
  end if;
  if v_spec ->> 'shift_mode' = 'scheduled' then
    v_start := (v_spec ->> 'scheduled_shift_starts_at')::timestamptz;
    return greatest(p_now, v_start);
  end if;
  return p_now;
end;
$$;

create or replace function private.dynamic_group_policy_spec_is_live(
  p_organization_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_spec jsonb;
  v_shift_mode text;
begin
  if p_organization_id is null or p_evaluated_at is null
    or not isfinite(p_evaluated_at) then
    return false;
  end if;
  v_spec := private.normalize_dynamic_group_policy_spec(p_spec);
  v_shift_mode := v_spec ->> 'shift_mode';

  if not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
  ) or (v_shift_mode <> 'none' and not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.shift_schedule_authoritative
  )) then
    return false;
  end if;

  if v_shift_mode = 'scheduled' and not (
    p_evaluated_at >= (v_spec ->> 'scheduled_shift_starts_at')::timestamptz
    and p_evaluated_at < (v_spec ->> 'scheduled_shift_ends_at')::timestamptz
  ) then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'site_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.kind = 'site' and unit.is_active
    )
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'department_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.kind = 'department' and unit.is_active
    )
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'team_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.kind = 'team' and unit.is_active
    )
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'line_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.kind = 'line' and unit.is_active
    )
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'unit_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.is_active
    )
  ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- Canonical source-membership hook. CHAT-03 replaces this function after the
-- contractor/guest columns exist, preserving the signature while excluding
-- guests and enforcing access expiration at the exact evaluation instant.
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
      and membership.joined_at <= p_at
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
  -- The pre-guest membership model has no finite organization-access expiry.
  -- CHAT-03 replaces this with the exact contractor access_expires_at boundary.
  select null::timestamptz
$$;

create or replace function private.dynamic_group_policy_candidates(
  p_organization_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns table (
  user_id uuid,
  eligible_from timestamptz,
  eligible_until timestamptz,
  source_snapshot jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_spec jsonb := private.normalize_dynamic_group_policy_spec(p_spec);
  v_has_units boolean;
  v_shift_mode text := v_spec ->> 'shift_mode';
begin
  if p_evaluated_at is null or not isfinite(p_evaluated_at) then
    raise exception 'finite dynamic-group evaluation time required' using errcode = '22023';
  end if;
  if not private.dynamic_group_policy_spec_is_live(
    p_organization_id, v_spec, p_evaluated_at
  ) then
    return;
  end if;
  v_has_units := jsonb_array_length(v_spec -> 'site_ids')
    + jsonb_array_length(v_spec -> 'department_ids')
    + jsonb_array_length(v_spec -> 'team_ids')
    + jsonb_array_length(v_spec -> 'line_ids')
    + jsonb_array_length(v_spec -> 'unit_ids') > 0;

  return query
  with recursive root_units(id) as (
    select value::uuid from jsonb_array_elements_text(v_spec -> 'site_ids')
    union
    select value::uuid from jsonb_array_elements_text(v_spec -> 'department_ids')
    union
    select value::uuid from jsonb_array_elements_text(v_spec -> 'team_ids')
    union
    select value::uuid from jsonb_array_elements_text(v_spec -> 'line_ids')
    union
    select value::uuid from jsonb_array_elements_text(v_spec -> 'unit_ids')
  ), eligible_units(id) as (
    select root.id from root_units root
    union
    select child.id
    from public.organization_units child
    join eligible_units parent on child.parent_unit_id = parent.id
    where child.organization_id = p_organization_id
      and child.is_active
      and (v_spec ->> 'include_descendants')::boolean
  )
  select membership.user_id,
    greatest(
      membership.joined_at,
      coalesce(unit_match.eligible_from, membership.joined_at),
      coalesce(role_match.eligible_from, membership.joined_at),
      case when v_shift_mode = 'none' then membership.joined_at
        else coalesce(shift_match.eligible_from, membership.joined_at) end,
      case when v_shift_mode = 'scheduled'
        then (v_spec ->> 'scheduled_shift_starts_at')::timestamptz
        else membership.joined_at end
    ) as eligible_from,
    least(
      membership_access.eligible_until,
      role_match.eligible_until,
      case when v_shift_mode = 'none' then null::timestamptz
        else shift_match.eligible_until end,
      case when v_shift_mode = 'scheduled'
        then (v_spec ->> 'scheduled_shift_ends_at')::timestamptz
        else null::timestamptz end
    ) as eligible_until,
    jsonb_build_object(
      'schema_version', 1,
      'evaluated_at', p_evaluated_at,
      'membership_role', membership.role,
      'job_title', membership.job_title,
      'membership_valid_until', membership_access.eligible_until,
      'matched_unit_ids', to_jsonb(coalesce(unit_match.unit_ids, '{}'::uuid[])),
      'configured_role_names', to_jsonb(coalesce(role_match.role_names, '{}'::text[])),
      'shift_assignment_ids', to_jsonb(coalesce(shift_match.assignment_ids, '{}'::uuid[]))
    )
  from public.organization_memberships membership
  left join lateral (
    select private.dynamic_group_candidate_membership_valid_until(
      membership.organization_id, membership.user_id, p_evaluated_at
    ) as eligible_until
  ) membership_access on true
  left join lateral (
    select min(unit_member.added_at) as eligible_from,
      array_agg(unit_member.unit_id order by unit_member.unit_id) as unit_ids
    from public.organization_unit_members unit_member
    join public.organization_units unit
      on unit.organization_id = unit_member.organization_id
     and unit.id = unit_member.unit_id and unit.is_active
    where unit_member.organization_id = membership.organization_id
      and unit_member.user_id = membership.user_id
      and unit_member.unit_id in (select id from eligible_units)
  ) unit_match on true
  left join lateral (
    select
      case
        when lower(btrim(coalesce(membership.job_title, ''))) in (
          select value from jsonb_array_elements_text(v_spec -> 'operational_roles')
        ) then membership.joined_at
        else min(assignment.granted_at)
      end as eligible_from,
      case
        when lower(btrim(coalesce(membership.job_title, ''))) in (
          select value from jsonb_array_elements_text(v_spec -> 'operational_roles')
        ) or bool_or(assignment.expires_at is null) then null::timestamptz
        else max(assignment.expires_at)
      end as eligible_until,
      array_agg(distinct lower(assignment.role_name) order by lower(assignment.role_name))
        filter (where assignment.id is not null) as role_names,
      coalesce(
        lower(btrim(coalesce(membership.job_title, ''))) in (
          select value from jsonb_array_elements_text(v_spec -> 'operational_roles')
        ), false
      ) or count(assignment.id) > 0 as matched
    from public.organization_role_assignments assignment
    where assignment.organization_id = membership.organization_id
      and assignment.user_id = membership.user_id
      and lower(assignment.role_name) in (
        select value from jsonb_array_elements_text(v_spec -> 'operational_roles')
      )
      and assignment.granted_at <= p_evaluated_at
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
      and (
        assignment.scope_type = 'organization'
        or not v_has_units
        or assignment.unit_id in (select id from eligible_units)
      )
  ) role_match on true
  left join lateral (
    select min(assignment.starts_at) as eligible_from,
      max(assignment.ends_at) as eligible_until,
      array_agg(assignment.id order by assignment.id) as assignment_ids,
      count(*) > 0 as matched
    from public.shift_assignments assignment
    where assignment.organization_id = membership.organization_id
      and assignment.user_id = membership.user_id
      and assignment.status = 'assigned'
      and assignment.starts_at <= p_evaluated_at
      and assignment.ends_at > p_evaluated_at
      and (
        not v_has_units
        or assignment.unit_id in (select id from eligible_units)
      )
  ) shift_match on true
  where membership.organization_id = p_organization_id
    and private.dynamic_group_candidate_membership_allowed(
      membership.organization_id, membership.user_id, p_evaluated_at
    )
    and (membership_access.eligible_until is null
      or membership_access.eligible_until > p_evaluated_at)
    and (not v_has_units or unit_match.eligible_from is not null)
    and (
      jsonb_array_length(v_spec -> 'operational_roles') = 0
      or coalesce(role_match.matched, false)
    )
    and (
      jsonb_array_length(v_spec -> 'membership_roles') = 0
      or membership.role in (
        select value from jsonb_array_elements_text(v_spec -> 'membership_roles')
      )
    )
    and (v_shift_mode = 'none' or coalesce(shift_match.matched, false))
  order by membership.user_id;
end;
$$;

create or replace function private.dynamic_group_user_eligible_for_spec(
  p_organization_id uuid,
  p_user_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.dynamic_group_policy_candidates(
      p_organization_id, p_spec, p_evaluated_at
    ) candidate
    where candidate.user_id = p_user_id
  )
$$;

create or replace function private.assert_dynamic_group_policy_authorized(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_spec jsonb := private.normalize_dynamic_group_policy_spec(p_spec);
  v_conversation_unit_id uuid;
  v_has_selected_units boolean;
begin
  select conversation.unit_id into v_conversation_unit_id
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift')
    and not conversation.is_archived
    and conversation.closed_at is null;
  if not found or not private.dynamic_group_policy_spec_is_live(
    p_organization_id, v_spec, p_evaluated_at
  ) then
    raise exception 'dynamic-group policy is not permitted' using errcode = '42501';
  end if;

  v_has_selected_units := jsonb_array_length(v_spec -> 'site_ids')
    + jsonb_array_length(v_spec -> 'department_ids')
    + jsonb_array_length(v_spec -> 'team_ids')
    + jsonb_array_length(v_spec -> 'line_ids')
    + jsonb_array_length(v_spec -> 'unit_ids') > 0;

  if (v_conversation_unit_id is not null and not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'unit.manage', v_conversation_unit_id
  )) or (not v_has_selected_units and not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'unit.manage', null
  )) or exists (
    select 1
    from (
      select value::uuid as unit_id from jsonb_array_elements_text(v_spec -> 'site_ids')
      union
      select value::uuid from jsonb_array_elements_text(v_spec -> 'department_ids')
      union
      select value::uuid from jsonb_array_elements_text(v_spec -> 'team_ids')
      union
      select value::uuid from jsonb_array_elements_text(v_spec -> 'line_ids')
      union
      select value::uuid from jsonb_array_elements_text(v_spec -> 'unit_ids')
    ) selected
    where not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'unit.manage', selected.unit_id
    )
  ) then
    raise exception 'dynamic-group policy is not permitted' using errcode = '42501';
  end if;
  return v_spec;
end;
$$;

create or replace function private.dynamic_group_membership_state_fingerprint(
  p_organization_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    candidate.user_id::text || ':' || candidate.eligible_from::text || ':'
      || coalesce(candidate.eligible_until::text, 'infinity'),
    ',' order by candidate.user_id
  ), ''), 'UTF8'), 'sha256'), 'hex')
  from private.dynamic_group_policy_candidates(
    p_organization_id, p_spec, p_evaluated_at
  ) candidate
$$;

create or replace function private.dynamic_group_policy_next_boundary(
  p_organization_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select min(boundary_at)
  from (
    select candidate.eligible_until as boundary_at
    from private.dynamic_group_policy_candidates(
      p_organization_id, p_spec, p_evaluated_at
    ) candidate
    where candidate.eligible_until > p_evaluated_at
    union all
    select (normalized.spec ->> 'scheduled_shift_starts_at')::timestamptz
    from (select private.normalize_dynamic_group_policy_spec(p_spec) spec) normalized
    where normalized.spec ->> 'shift_mode' = 'scheduled'
      and (normalized.spec ->> 'scheduled_shift_starts_at')::timestamptz > p_evaluated_at
    union all
    select (normalized.spec ->> 'scheduled_shift_ends_at')::timestamptz
    from (select private.normalize_dynamic_group_policy_spec(p_spec) spec) normalized
    where normalized.spec ->> 'shift_mode' = 'scheduled'
      and (normalized.spec ->> 'scheduled_shift_ends_at')::timestamptz > p_evaluated_at
    union all
    select least(assignment.starts_at, assignment.ends_at)
    from public.shift_assignments assignment
    cross join (select private.normalize_dynamic_group_policy_spec(p_spec) spec) normalized
    where normalized.spec ->> 'shift_mode' in ('current', 'scheduled')
      and assignment.organization_id = p_organization_id
      and assignment.status = 'assigned'
      and assignment.starts_at > p_evaluated_at
    union all
    select assignment.ends_at
    from public.shift_assignments assignment
    cross join (select private.normalize_dynamic_group_policy_spec(p_spec) spec) normalized
    where normalized.spec ->> 'shift_mode' in ('current', 'scheduled')
      and assignment.organization_id = p_organization_id
      and assignment.status = 'assigned'
      and assignment.ends_at > p_evaluated_at
  ) boundaries
$$;

create or replace function private.dynamic_group_user_currently_eligible(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.dynamic_group_policies policy
    join public.dynamic_group_policy_versions version
      on version.organization_id = policy.organization_id
     and version.id = policy.published_version_id
     and version.policy_id = policy.id
    join public.organization_memberships organization_member
      on organization_member.organization_id = policy.organization_id
     and organization_member.user_id = p_user_id
     and organization_member.status = 'active'
    where policy.organization_id = p_organization_id
      and policy.conversation_id = p_conversation_id
      and policy.status = 'active'
      and policy.source_changed_at is null
      and policy.draft_state in ('published', 'draft', 'previewed')
      and private.dynamic_group_candidate_membership_allowed(
        policy.organization_id, p_user_id, p_at
      )
      and private.dynamic_group_user_eligible_for_spec(
        policy.organization_id, p_user_id, version.policy_spec, p_at
      )
  )
$$;

create or replace function private.dynamic_group_policy_conversation(
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
    select 1 from public.dynamic_group_policies policy
    where policy.organization_id = p_organization_id
      and policy.conversation_id = p_conversation_id
      and policy.published_version_id is not null
  )
$$;

create or replace function private.dynamic_group_timestamp_access_allowed(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_occurred_at timestamptz,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_occurred_at is not null
    and exists (
      select 1 from public.organization_memberships organization_member
      where organization_member.organization_id = p_organization_id
        and organization_member.user_id = p_user_id
        and organization_member.status = 'active'
    )
    and case
      when not private.dynamic_group_policy_conversation(
        p_organization_id, p_conversation_id
      ) then exists (
        select 1
        from public.conversation_members member
        where member.organization_id = p_organization_id
          and member.conversation_id = p_conversation_id
          and member.user_id = p_user_id
          and member.status = 'active'
          and (member.history_visible_from is null
            or p_occurred_at >= member.history_visible_from)
      )
      else private.dynamic_group_candidate_membership_allowed(
        p_organization_id, p_user_id, p_at
      ) and exists (
        select 1
        from private.dynamic_group_access_intervals access_interval
        join public.dynamic_group_policies policy
          on policy.organization_id = access_interval.organization_id
         and policy.id = access_interval.policy_id
         and policy.conversation_id = access_interval.conversation_id
        where access_interval.organization_id = p_organization_id
          and access_interval.conversation_id = p_conversation_id
          and access_interval.user_id = p_user_id
          and access_interval.cancelled_at is null
          and access_interval.valid_from <= p_at
          and p_occurred_at >= coalesce(
            access_interval.history_visible_from, '-infinity'::timestamptz
          )
          and p_occurred_at < least(
            coalesce(access_interval.valid_until, 'infinity'::timestamptz),
            coalesce(access_interval.eligibility_valid_until, 'infinity'::timestamptz),
            coalesce((
              select min(boundary.boundary_at)
              from private.dynamic_group_policy_source_boundaries boundary
              where boundary.organization_id = access_interval.organization_id
                and boundary.policy_id = access_interval.policy_id
                and boundary.boundary_at > access_interval.created_at
            ), 'infinity'::timestamptz)
          )
      )
    end
$$;

create or replace function private.dynamic_group_message_access_allowed_for_user(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_user_id uuid,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_message_id
      and message.deleted_at is null
      and message.available_at <= p_at
      and private.dynamic_group_timestamp_access_allowed(
        p_organization_id, p_conversation_id, p_user_id, message.created_at, p_at
      )
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_user_id
      )
  )
$$;

create or replace function private.dynamic_group_message_access_allowed(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and private.current_session_active_for_org(p_organization_id)
    and private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_message_id, (select auth.uid()), now()
    )
$$;

create or replace function private.dynamic_group_conversation_access_allowed_for_user(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organization_memberships organization_member
    where organization_member.organization_id = p_organization_id
      and organization_member.user_id = p_user_id
      and organization_member.status = 'active'
  ) and case
    when not private.dynamic_group_policy_conversation(
      p_organization_id, p_conversation_id
    ) then exists (
      select 1 from public.conversation_members member
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.user_id = p_user_id and member.status = 'active'
    )
    else private.dynamic_group_candidate_membership_allowed(
      p_organization_id, p_user_id, p_at
    ) and (
      private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_user_id, p_at
      ) or exists (
        select 1 from private.dynamic_group_access_intervals access_interval
        join public.dynamic_group_policies policy
          on policy.organization_id = access_interval.organization_id
         and policy.id = access_interval.policy_id
        where access_interval.organization_id = p_organization_id
          and access_interval.conversation_id = p_conversation_id
          and access_interval.user_id = p_user_id
          and access_interval.cancelled_at is null
          and access_interval.valid_from <= p_at
          and access_interval.valid_from < least(
            coalesce(access_interval.valid_until, 'infinity'::timestamptz),
            coalesce(access_interval.eligibility_valid_until, 'infinity'::timestamptz),
            coalesce((
              select min(boundary.boundary_at)
              from private.dynamic_group_policy_source_boundaries boundary
              where boundary.organization_id = access_interval.organization_id
                and boundary.policy_id = access_interval.policy_id
                and boundary.boundary_at > access_interval.created_at
            ), 'infinity'::timestamptz)
          )
      )
    )
  end
$$;

create or replace function private.prevent_dynamic_group_version_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'published dynamic-group policy versions are immutable'
    using errcode = '55000';
end;
$$;

create trigger dynamic_group_policy_versions_05_immutable
before update or delete on public.dynamic_group_policy_versions
for each row execute function private.prevent_dynamic_group_version_mutation();

create or replace function private.validate_dynamic_group_access_interval_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'dynamic-group access intervals cannot be deleted'
      using errcode = '55000';
  end if;
  if new.organization_id is distinct from old.organization_id
    or new.policy_id is distinct from old.policy_id
    or new.policy_version_id is distinct from old.policy_version_id
    or new.conversation_id is distinct from old.conversation_id
    or new.user_id is distinct from old.user_id
    or new.valid_from is distinct from old.valid_from
    or new.eligibility_valid_until is distinct from old.eligibility_valid_until
    or new.history_visible_from is distinct from old.history_visible_from
    or new.selector_fingerprint is distinct from old.selector_fingerprint
    or new.source_snapshot is distinct from old.source_snapshot
    or new.opened_reason is distinct from old.opened_reason
    or new.created_at is distinct from old.created_at
    or (old.valid_until is not null and new.valid_until is distinct from old.valid_until)
    or (old.cancelled_at is not null and new.cancelled_at is distinct from old.cancelled_at)
    or (old.closed_reason is not null and new.closed_reason is distinct from old.closed_reason)
    or (old.valid_until is null and new.valid_until is not null
      and new.cancelled_at is null
      and new.valid_until > statement_timestamp())
    or (old.cancelled_at is null and new.cancelled_at is not null
      and new.cancelled_at > statement_timestamp()) then
    raise exception 'dynamic-group access intervals may only close monotonically'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger dynamic_group_access_intervals_05_monotonic
before update or delete on private.dynamic_group_access_intervals
for each row execute function private.validate_dynamic_group_access_interval_mutation();

create or replace function private.reconcile_dynamic_group_user_internal(
  p_organization_id uuid,
  p_policy_id uuid,
  p_user_id uuid,
  p_boundary_at timestamptz,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy public.dynamic_group_policies%rowtype;
  v_version public.dynamic_group_policy_versions%rowtype;
  v_candidate record;
  v_evaluated_at timestamptz;
  v_valid_from timestamptz;
  v_history_visible_from timestamptz;
  v_is_eligible boolean := false;
  v_closed integer := 0;
  v_opened integer := 0;
  v_prior_jwt_claims text := current_setting('request.jwt.claims', true);
begin
  if p_boundary_at is null or not isfinite(p_boundary_at)
    or p_boundary_at > statement_timestamp()
    or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 120 then
    raise exception 'invalid dynamic-group reconciliation boundary'
      using errcode = '22023';
  end if;

  select policy.* into v_policy
  from public.dynamic_group_policies policy
  where policy.organization_id = p_organization_id
    and policy.id = p_policy_id
  for update;
  if not found or v_policy.published_version_id is null then
    return jsonb_build_object('opened', 0, 'closed', 0, 'eligible', false);
  end if;
  select version.* into strict v_version
  from public.dynamic_group_policy_versions version
  where version.organization_id = p_organization_id
    and version.id = v_policy.published_version_id
    and version.policy_id = v_policy.id;

  v_evaluated_at := private.dynamic_group_policy_evaluation_time(
    v_version.policy_spec, p_boundary_at
  );
  select candidate.* into v_candidate
  from private.dynamic_group_policy_candidates(
    p_organization_id, v_version.policy_spec, v_evaluated_at
  ) candidate
  where candidate.user_id = p_user_id;
  v_is_eligible := found;

  update private.dynamic_group_access_intervals access_interval
  set valid_until = case
        when access_interval.valid_from > p_boundary_at then access_interval.valid_from
        else least(
          p_boundary_at,
          coalesce(access_interval.eligibility_valid_until, p_boundary_at)
        )
      end,
      cancelled_at = case when access_interval.valid_from > p_boundary_at
        then p_boundary_at else access_interval.cancelled_at end,
      closed_reason = left(btrim(p_reason), 120)
  where access_interval.organization_id = p_organization_id
    and access_interval.policy_id = p_policy_id
    and access_interval.user_id = p_user_id
    and access_interval.valid_until is null
    and access_interval.cancelled_at is null;
  get diagnostics v_closed = row_count;

  perform set_config('app.dynamic_group_reconcile_context', 'on', true);
  perform set_config('app.bff_service_context', 'on', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if v_is_eligible and v_policy.status = 'active' then
    v_valid_from := greatest(
      statement_timestamp(), p_boundary_at, v_candidate.eligible_from
    );
    if v_candidate.eligible_until is null
      or v_candidate.eligible_until > v_valid_from then
      select case when conversation.history_policy = 'all'
          then null::timestamptz else v_valid_from end
        into v_history_visible_from
      from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = v_policy.conversation_id;

      insert into private.dynamic_group_access_intervals (
        organization_id, policy_id, policy_version_id, conversation_id,
        user_id, valid_from, eligibility_valid_until, history_visible_from,
        selector_fingerprint, source_snapshot, opened_reason
      ) values (
        p_organization_id, p_policy_id, v_version.id, v_policy.conversation_id,
        p_user_id, v_valid_from, v_candidate.eligible_until,
        v_history_visible_from, v_version.selector_fingerprint,
        v_candidate.source_snapshot, left(btrim(p_reason), 120)
      );
      v_opened := 1;

      insert into public.conversation_members (
        organization_id, conversation_id, user_id, role, status, can_post,
        joined_by_user_id, joined_at, history_visible_from, left_at,
        managed_by_policy_id
      ) values (
        p_organization_id, v_policy.conversation_id, p_user_id, 'member',
        'active',
        v_valid_from <= statement_timestamp(),
        v_policy.approved_by_user_id, v_valid_from, v_history_visible_from,
        null,
        p_policy_id
      )
      on conflict (organization_id, conversation_id, user_id) do update
      set status = excluded.status,
          left_at = excluded.left_at,
          can_post = excluded.can_post,
          managed_by_policy_id = case
            when public.conversation_members.role = 'member'
              then excluded.managed_by_policy_id
            else public.conversation_members.managed_by_policy_id
          end,
          history_visible_from = case
            when public.conversation_members.history_visible_from is null
              or excluded.history_visible_from is null then null
            else least(
              public.conversation_members.history_visible_from,
              excluded.history_visible_from
            )
          end;
    end if;
  else
    update public.conversation_members member
    set can_post = false
    where member.organization_id = p_organization_id
      and member.conversation_id = v_policy.conversation_id
      and member.user_id = p_user_id
      and member.status = 'active';
  end if;
  perform set_config('app.dynamic_group_reconcile_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);
  perform set_config(
    'request.jwt.claims', coalesce(nullif(v_prior_jwt_claims, ''), '{}'), true
  );

  delete from private.dynamic_group_dirty_users dirty
  where dirty.organization_id = p_organization_id
    and dirty.policy_id = p_policy_id and dirty.user_id = p_user_id;
  return jsonb_build_object(
    'opened', v_opened,
    'closed', v_closed,
    'eligible', v_opened = 1
  );
end;
$$;

create or replace function private.enqueue_dynamic_group_user_source_change_internal(
  p_organization_id uuid,
  p_user_id uuid,
  p_reason text,
  p_boundary_at timestamptz
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy_id uuid;
begin
  if p_organization_id is null or p_user_id is null
    or p_boundary_at is null or not isfinite(p_boundary_at)
    or p_boundary_at > statement_timestamp()
    or char_length(btrim(coalesce(p_reason, ''))) not between 1 and 120 then
    raise exception 'invalid dynamic-group user source change'
      using errcode = '22023';
  end if;
  -- Every relevant policy head is locked in a deterministic order. Message
  -- inserts lock the same head, so a post is ordered on one side of the
  -- authoritative source commit instead of racing a stale cache row.
  perform policy.id
  from public.dynamic_group_policies policy
  where policy.organization_id = p_organization_id
    and policy.published_version_id is not null
  order by policy.id
  for update;

  insert into private.dynamic_group_dirty_users (
    organization_id, policy_id, user_id, reason, requested_at
  )
  select p_organization_id, policy.id, p_user_id,
    left(btrim(p_reason), 120), p_boundary_at
  from public.dynamic_group_policies policy
  where policy.organization_id = p_organization_id
    and policy.published_version_id is not null
  on conflict (organization_id, policy_id, user_id) do update
  set requested_at = least(
        private.dynamic_group_dirty_users.requested_at, excluded.requested_at
      ),
      reason = excluded.reason;

  for v_policy_id in
    select policy.id
    from public.dynamic_group_policies policy
    where policy.organization_id = p_organization_id
      and policy.published_version_id is not null
    order by policy.id
  loop
    perform private.reconcile_dynamic_group_user_internal(
      p_organization_id, v_policy_id, p_user_id, p_boundary_at,
      left(btrim(p_reason), 120)
    );
  end loop;
end;
$$;

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
    and old.status is not distinct from new.status
    and old.role is not distinct from new.role
    and old.job_title is not distinct from new.job_title then
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

create or replace function private.mark_dynamic_group_unit_source_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := case
    when tg_table_name = 'organizations' and tg_op = 'DELETE' then old.id
    when tg_table_name = 'organizations' then new.id
    when tg_op = 'DELETE' then old.organization_id
    else new.organization_id end;
  v_boundary_at timestamptz := statement_timestamp();
begin
  perform set_config('app.dynamic_group_policy_write_context', 'on', true);
  update public.dynamic_group_policies policy
  set source_changed_at = case when policy.source_changed_at is null
        then v_boundary_at else greatest(policy.source_changed_at, v_boundary_at) end
  where policy.organization_id = v_organization_id
    and policy.published_version_id is not null;
  perform set_config('app.dynamic_group_policy_write_context', 'off', true);
  insert into private.dynamic_group_policy_source_boundaries (
    organization_id, policy_id, boundary_at, reason
  )
  select v_organization_id, policy.id, v_boundary_at,
    left(tg_table_name || '.' || lower(tg_op), 120)
  from public.dynamic_group_policies policy
  where policy.organization_id = v_organization_id
    and policy.published_version_id is not null
  on conflict (organization_id, policy_id, boundary_at) do nothing;
  insert into private.dynamic_group_reconciliation_queue (
    organization_id, policy_id, policy_version_id, reason, requested_at, available_at
  )
  select v_organization_id, policy.id, policy.published_version_id,
    left(tg_table_name || '.' || lower(tg_op), 120), v_boundary_at, v_boundary_at
  from public.dynamic_group_policies policy
  where policy.organization_id = v_organization_id
    and policy.published_version_id is not null
  on conflict (organization_id, policy_id) do update
  set policy_version_id = excluded.policy_version_id,
      reason = excluded.reason,
      cursor_user_id = null,
      requested_at = least(
        private.dynamic_group_reconciliation_queue.requested_at,
        excluded.requested_at
      ), available_at = least(
        private.dynamic_group_reconciliation_queue.available_at,
        excluded.available_at
      );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger organization_memberships_96_dynamic_group_source
after insert or delete or update of status, role, job_title
on public.organization_memberships
for each row execute function private.mark_dynamic_group_user_source_change();

create trigger organization_unit_members_95_dynamic_group_source
after insert or update or delete on public.organization_unit_members
for each row execute function private.mark_dynamic_group_user_source_change();

create trigger organization_role_assignments_95_dynamic_group_source
after insert or update or delete on public.organization_role_assignments
for each row execute function private.mark_dynamic_group_user_source_change();

create trigger shift_assignments_95_dynamic_group_source
after insert or update or delete on public.shift_assignments
for each row execute function private.mark_dynamic_group_user_source_change();

create trigger organization_units_95_dynamic_group_source
after insert or delete or update of organization_id, parent_unit_id, kind, is_active
on public.organization_units
for each row execute function private.mark_dynamic_group_unit_source_change();

create trigger organizations_95_dynamic_group_shift_authority_source
after update of shift_schedule_authoritative on public.organizations
for each row when (
  old.shift_schedule_authoritative is distinct from new.shift_schedule_authoritative
) execute function private.mark_dynamic_group_unit_source_change();

create or replace function private.prevent_organization_membership_identity_reassignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.joined_at is distinct from old.joined_at then
    raise exception 'organization membership identity and join boundary are immutable'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

create trigger organization_memberships_05_immutable_identity
before update on public.organization_memberships
for each row execute function private.prevent_organization_membership_identity_reassignment();

create or replace function private.prevent_unit_member_identity_reassignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.organization_id is distinct from old.organization_id
    or new.unit_id is distinct from old.unit_id
    or new.user_id is distinct from old.user_id then
    raise exception 'organization unit membership identity is immutable'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

create trigger organization_unit_members_05_immutable_identity
before update on public.organization_unit_members
for each row execute function private.prevent_unit_member_identity_reassignment();

create or replace function private.prevent_role_assignment_identity_reassignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id then
    raise exception 'organization role assignment identity is immutable'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

create trigger organization_role_assignments_05_immutable_identity
before update on public.organization_role_assignments
for each row execute function private.prevent_role_assignment_identity_reassignment();

create or replace function private.prevent_shift_assignment_identity_reassignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id then
    raise exception 'shift assignment identity is immutable'
      using errcode = '22000';
  end if;
  return new;
end;
$$;

create trigger shift_assignments_05_immutable_identity
before update on public.shift_assignments
for each row execute function private.prevent_shift_assignment_identity_reassignment();

create or replace function private.bff_save_dynamic_group_policy_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_policy_id uuid,
  p_expected_version integer,
  p_policy_spec jsonb,
  p_maximum_members integer,
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
  v_policy public.dynamic_group_policies%rowtype;
  v_policy_id uuid := p_policy_id;
  v_spec jsonb;
  v_fingerprint text;
  v_evaluated_at timestamptz;
  v_roles text[];
  v_legacy_unit_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'dynamic_group.policy.save', true, 900,
    '/v2/dynamic-groups/policies', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version is null or p_expected_version < 0
    or p_maximum_members not between 1 and 5000 then
    raise exception 'invalid dynamic-group policy CAS request' using errcode = '22023';
  end if;
  v_spec := private.normalize_dynamic_group_policy_spec(p_policy_spec);
  v_evaluated_at := private.dynamic_group_policy_evaluation_time(v_spec, now());
  v_spec := private.assert_dynamic_group_policy_authorized(
    p_actor_user_id, p_organization_id, p_conversation_id,
    v_spec, v_evaluated_at
  );
  v_fingerprint := private.dynamic_group_selector_fingerprint(v_spec);
  select coalesce(array_agg(value order by value), array[
      'owner', 'admin', 'manager', 'member'
    ]::text[])
    into v_roles
  from jsonb_array_elements_text(v_spec -> 'membership_roles') role_name(value);
  select selected.id into v_legacy_unit_id
  from (
    select value::uuid id from jsonb_array_elements_text(v_spec -> 'site_ids')
    union all select value::uuid from jsonb_array_elements_text(v_spec -> 'department_ids')
    union all select value::uuid from jsonb_array_elements_text(v_spec -> 'team_ids')
    union all select value::uuid from jsonb_array_elements_text(v_spec -> 'line_ids')
    union all select value::uuid from jsonb_array_elements_text(v_spec -> 'unit_ids')
  ) selected order by selected.id limit 1;

  perform set_config('app.dynamic_group_policy_write_context', 'on', true);
  if p_policy_id is null then
    if p_expected_version <> 0 then
      raise exception 'dynamic-group policy version conflict' using errcode = '40001';
    end if;
    insert into public.dynamic_group_policies (
      organization_id, conversation_id, unit_id, member_roles,
      include_unit_descendants, status, version, created_by_user_id,
      policy_spec, draft_state, selector_fingerprint, maximum_members
    ) values (
      p_organization_id, p_conversation_id, v_legacy_unit_id, v_roles,
      (v_spec ->> 'include_descendants')::boolean, 'draft', 1,
      p_actor_user_id, v_spec, 'draft', v_fingerprint, p_maximum_members
    ) returning * into v_policy;
    v_policy_id := v_policy.id;
  else
    select policy.* into v_policy
    from public.dynamic_group_policies policy
    where policy.organization_id = p_organization_id
      and policy.id = p_policy_id
      and policy.conversation_id = p_conversation_id
    for update;
    if not found then
      raise exception 'dynamic-group policy not found' using errcode = 'P0002';
    end if;
    if v_policy.version <> p_expected_version then
      raise exception 'dynamic-group policy version conflict' using errcode = '40001';
    end if;
    update public.dynamic_group_policies policy
    set unit_id = v_legacy_unit_id,
        member_roles = v_roles,
        include_unit_descendants = (v_spec ->> 'include_descendants')::boolean,
        policy_spec = v_spec,
        selector_fingerprint = v_fingerprint,
        maximum_members = p_maximum_members,
        version = policy.version + 1,
        draft_state = 'draft',
        last_preview_fingerprint = null,
        last_previewed_at = null
    where policy.organization_id = p_organization_id and policy.id = p_policy_id
    returning * into v_policy;
  end if;
  perform set_config('app.dynamic_group_policy_write_context', 'off', true);
  v_response := jsonb_build_object(
    'policy_id', v_policy_id,
    'conversation_id', p_conversation_id,
    'version', v_policy.version,
    'draft_state', 'draft',
    'selector_fingerprint', v_fingerprint,
    'requires_preview', true,
    'published_version_id', v_policy.published_version_id
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/dynamic-groups/policies',
    p_idempotency_key, p_request_sha256, v_response,
    case when p_policy_id is null then 201 else 200 end
  );
end;
$$;

create or replace function private.bff_preview_dynamic_group_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_expected_version integer,
  p_sample_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy public.dynamic_group_policies%rowtype;
  v_published_spec jsonb;
  v_spec jsonb;
  v_evaluated_at timestamptz;
  v_selector_fingerprint text;
  v_membership_fingerprint text;
  v_new_ids uuid[] := '{}'::uuid[];
  v_old_ids uuid[] := '{}'::uuid[];
  v_added_ids uuid[] := '{}'::uuid[];
  v_removed_ids uuid[] := '{}'::uuid[];
  v_unchanged_ids uuid[] := '{}'::uuid[];
  v_preview_id uuid := gen_random_uuid();
  v_preview_fingerprint text;
  v_next_boundary_at timestamptz;
  v_member_limit integer;
  v_materialized_count integer;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'dynamic_group.preview', true, 900
  );
  if p_expected_version is null or p_expected_version < 1
    or p_sample_limit not between 1 and 200 then
    raise exception 'invalid dynamic-group preview request' using errcode = '22023';
  end if;
  select policy.* into v_policy
  from public.dynamic_group_policies policy
  join public.conversations conversation
    on conversation.organization_id = policy.organization_id
   and conversation.id = policy.conversation_id
  where policy.organization_id = p_organization_id and policy.id = p_policy_id
  for update of policy;
  if not found then raise exception 'dynamic-group policy not found' using errcode = 'P0002'; end if;
  select conversation.member_limit into strict v_member_limit
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = v_policy.conversation_id;
  if v_policy.version <> p_expected_version then
    raise exception 'dynamic-group policy version conflict' using errcode = '40001';
  end if;
  v_spec := private.normalize_dynamic_group_policy_spec(v_policy.policy_spec);
  v_evaluated_at := private.dynamic_group_policy_evaluation_time(v_spec, now());
  v_spec := private.assert_dynamic_group_policy_authorized(
    p_actor_user_id, p_organization_id, v_policy.conversation_id,
    v_spec, v_evaluated_at
  );
  v_selector_fingerprint := private.dynamic_group_selector_fingerprint(v_spec);
  select coalesce(array_agg(candidate.user_id order by candidate.user_id), '{}'::uuid[])
    into v_new_ids
  from private.dynamic_group_policy_candidates(
    p_organization_id, v_spec, v_evaluated_at
  ) candidate;
  if cardinality(v_new_ids) > least(v_policy.maximum_members, v_member_limit) then
    raise exception 'dynamic-group audience exceeds configured member limit'
      using errcode = '54000';
  end if;
  select count(distinct member_id)::integer into v_materialized_count
  from (
    select unnest(v_new_ids) member_id
    union all
    select member.user_id
    from public.conversation_members member
    where member.organization_id = p_organization_id
      and member.conversation_id = v_policy.conversation_id
      and member.status = 'active' and member.role in ('owner', 'admin')
  ) materialized;
  if v_materialized_count > v_member_limit then
    raise exception 'dynamic-group audience plus governance exceeds conversation limit'
      using errcode = '54000';
  end if;

  if v_policy.published_version_id is not null then
    select version.policy_spec into v_published_spec
    from public.dynamic_group_policy_versions version
    where version.organization_id = p_organization_id
      and version.id = v_policy.published_version_id;
    select coalesce(array_agg(candidate.user_id order by candidate.user_id), '{}'::uuid[])
      into v_old_ids
    from private.dynamic_group_policy_candidates(
      p_organization_id, v_published_spec, v_evaluated_at
    ) candidate;
  end if;
  select coalesce(array_agg(candidate_id order by candidate_id), '{}'::uuid[])
    into v_added_ids from unnest(v_new_ids) candidate_id
    where not candidate_id = any(v_old_ids);
  select coalesce(array_agg(candidate_id order by candidate_id), '{}'::uuid[])
    into v_removed_ids from unnest(v_old_ids) candidate_id
    where not candidate_id = any(v_new_ids);
  select coalesce(array_agg(candidate_id order by candidate_id), '{}'::uuid[])
    into v_unchanged_ids from unnest(v_new_ids) candidate_id
    where candidate_id = any(v_old_ids);
  v_membership_fingerprint := private.dynamic_group_membership_state_fingerprint(
    p_organization_id, v_spec, v_evaluated_at
  );
  v_next_boundary_at := private.dynamic_group_policy_next_boundary(
    p_organization_id, v_spec, v_evaluated_at
  );
  v_preview_fingerprint := encode(extensions.digest(convert_to(
    v_preview_id::text || ':' || p_policy_id::text || ':' || v_policy.version::text
      || ':' || v_selector_fingerprint || ':' || v_membership_fingerprint
      || ':' || v_evaluated_at::text,
    'UTF8'
  ), 'sha256'), 'hex');
  insert into private.dynamic_group_policy_previews (
    id, organization_id, policy_id, policy_version, selector_fingerprint,
    membership_state_fingerprint, preview_fingerprint, evaluated_at,
    valid_until, eligible_count, added_count, removed_count, unchanged_count,
    added_sample, removed_sample, unchanged_sample, next_boundary_at,
    previewed_by_user_id
  ) values (
    v_preview_id, p_organization_id, p_policy_id, v_policy.version,
    v_selector_fingerprint, v_membership_fingerprint, v_preview_fingerprint,
    v_evaluated_at, now() + interval '5 minutes', cardinality(v_new_ids),
    cardinality(v_added_ids), cardinality(v_removed_ids),
    cardinality(v_unchanged_ids),
    coalesce(v_added_ids[1:p_sample_limit], '{}'::uuid[]),
    coalesce(v_removed_ids[1:p_sample_limit], '{}'::uuid[]),
    coalesce(v_unchanged_ids[1:p_sample_limit], '{}'::uuid[]),
    v_next_boundary_at, p_actor_user_id
  );
  perform set_config('app.dynamic_group_policy_write_context', 'on', true);
  update public.dynamic_group_policies policy
  set draft_state = 'previewed',
      last_preview_fingerprint = v_preview_fingerprint,
      last_previewed_at = now()
  where policy.organization_id = p_organization_id and policy.id = p_policy_id;
  perform set_config('app.dynamic_group_policy_write_context', 'off', true);
  return jsonb_build_object(
    'policy_id', p_policy_id,
    'policy_version', v_policy.version,
    'preview_fingerprint', v_preview_fingerprint,
    'selector_fingerprint', v_selector_fingerprint,
    'membership_state_fingerprint', v_membership_fingerprint,
    'evaluated_at', v_evaluated_at,
    'valid_until', now() + interval '5 minutes',
    'eligible_count', cardinality(v_new_ids),
    'added_count', cardinality(v_added_ids),
    'removed_count', cardinality(v_removed_ids),
    'unchanged_count', cardinality(v_unchanged_ids),
    'added_sample_user_ids', to_jsonb(coalesce(v_added_ids[1:p_sample_limit], '{}'::uuid[])),
    'removed_sample_user_ids', to_jsonb(coalesce(v_removed_ids[1:p_sample_limit], '{}'::uuid[])),
    'unchanged_sample_user_ids', to_jsonb(coalesce(v_unchanged_ids[1:p_sample_limit], '{}'::uuid[])),
    'next_boundary_at', v_next_boundary_at
  );
end;
$$;

create or replace function private.bff_publish_dynamic_group_policy_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_expected_version integer,
  p_preview_fingerprint text,
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
  v_policy public.dynamic_group_policies%rowtype;
  v_preview private.dynamic_group_policy_previews%rowtype;
  v_version_id uuid := gen_random_uuid();
  v_publish_at timestamptz := statement_timestamp();
  v_current_membership_fingerprint text;
  v_current_count integer;
  v_member_limit integer;
  v_materialized_count integer;
  v_system_message_id bigint;
  v_prior_jwt_claims text := current_setting('request.jwt.claims', true);
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'dynamic_group.sync', true, 900,
    '/v2/dynamic-groups/:id/publish', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version is null or p_expected_version < 1
    or coalesce(p_preview_fingerprint, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid dynamic-group publish request' using errcode = '22023';
  end if;
  select policy.* into v_policy
  from public.dynamic_group_policies policy
  join public.conversations conversation
    on conversation.organization_id = policy.organization_id
   and conversation.id = policy.conversation_id
  where policy.organization_id = p_organization_id and policy.id = p_policy_id
  for update of policy;
  if not found then raise exception 'dynamic-group policy not found' using errcode = 'P0002'; end if;
  select conversation.member_limit into strict v_member_limit
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = v_policy.conversation_id;
  if v_policy.version <> p_expected_version
    or v_policy.draft_state <> 'previewed'
    or v_policy.last_preview_fingerprint is distinct from p_preview_fingerprint then
    raise exception 'dynamic-group policy publish conflict' using errcode = '40001';
  end if;
  perform private.assert_dynamic_group_policy_authorized(
    p_actor_user_id, p_organization_id, v_policy.conversation_id,
    v_policy.policy_spec,
    private.dynamic_group_policy_evaluation_time(v_policy.policy_spec, now())
  );
  select preview.* into v_preview
  from private.dynamic_group_policy_previews preview
  where preview.organization_id = p_organization_id
    and preview.policy_id = p_policy_id
    and preview.policy_version = p_expected_version
    and preview.preview_fingerprint = p_preview_fingerprint
    and preview.valid_until > now()
    and preview.selector_fingerprint = v_policy.selector_fingerprint
  for update;
  if not found then
    raise exception 'fresh matching dynamic-group preview required' using errcode = '40001';
  end if;
  v_current_membership_fingerprint := private.dynamic_group_membership_state_fingerprint(
    p_organization_id, v_policy.policy_spec, v_preview.evaluated_at
  );
  if v_current_membership_fingerprint <> v_preview.membership_state_fingerprint then
    raise exception 'dynamic-group source changed after preview' using errcode = '40001';
  end if;
  select count(*)::integer into v_current_count
  from private.dynamic_group_policy_candidates(
    p_organization_id, v_policy.policy_spec, v_preview.evaluated_at
  );
  if v_current_count <> v_preview.eligible_count
    or v_current_count > least(v_policy.maximum_members, v_member_limit) then
    raise exception 'dynamic-group preview is stale or exceeds configured limit'
      using errcode = '40001';
  end if;
  select count(distinct member_id)::integer into v_materialized_count
  from (
    select candidate.user_id member_id
    from private.dynamic_group_policy_candidates(
      p_organization_id, v_policy.policy_spec, v_preview.evaluated_at
    ) candidate
    union all
    select member.user_id
    from public.conversation_members member
    where member.organization_id = p_organization_id
      and member.conversation_id = v_policy.conversation_id
      and member.status = 'active' and member.role in ('owner', 'admin')
  ) materialized;
  if v_materialized_count > v_member_limit then
    raise exception 'dynamic-group audience plus governance exceeds conversation limit'
      using errcode = '54000';
  end if;

  perform set_config('app.dynamic_group_policy_write_context', 'on', true);
  insert into public.dynamic_group_policy_versions (
    id, organization_id, policy_id, conversation_id, policy_version,
    policy_spec, selector_fingerprint, membership_state_fingerprint,
    evaluated_at, eligible_count, added_count, removed_count, unchanged_count,
    published_by_user_id, published_at, next_boundary_at
  ) values (
    v_version_id, p_organization_id, p_policy_id, v_policy.conversation_id,
    v_policy.version, v_policy.policy_spec, v_policy.selector_fingerprint,
    v_preview.membership_state_fingerprint, v_preview.evaluated_at,
    v_preview.eligible_count, v_preview.added_count, v_preview.removed_count,
    v_preview.unchanged_count, p_actor_user_id, v_publish_at,
    v_preview.next_boundary_at
  );

  -- A first publication converts any legitimately existing manual access to
  -- an explicitly bounded history interval. Governance roles remain rows for
  -- administration, but never become a content-access bypass.
  if v_policy.published_version_id is null then
    insert into private.dynamic_group_access_intervals (
      organization_id, policy_id, policy_version_id, conversation_id, user_id,
      valid_from, valid_until, history_visible_from, selector_fingerprint,
      source_snapshot, opened_reason, closed_reason
    )
    select p_organization_id, p_policy_id, v_version_id, v_policy.conversation_id,
      member.user_id, least(member.joined_at, v_publish_at), v_publish_at,
      member.history_visible_from, v_policy.selector_fingerprint,
      jsonb_build_object('schema_version', 1, 'converted_manual_access', true),
      'pre-policy-history', 'policy.published'
    from public.conversation_members member
    where member.organization_id = p_organization_id
      and member.conversation_id = v_policy.conversation_id
      and member.status = 'active';
  else
    update private.dynamic_group_access_intervals access_interval
    set valid_until = case when access_interval.valid_from > v_publish_at
          then access_interval.valid_from
          else least(
            v_publish_at,
            coalesce(access_interval.eligibility_valid_until, v_publish_at)
          ) end,
        cancelled_at = case when access_interval.valid_from > v_publish_at
          then v_publish_at else access_interval.cancelled_at end,
        closed_reason = 'policy.published'
    where access_interval.organization_id = p_organization_id
      and access_interval.policy_id = p_policy_id
      and access_interval.valid_until is null
      and access_interval.cancelled_at is null;
  end if;

  insert into private.dynamic_group_access_intervals (
    organization_id, policy_id, policy_version_id, conversation_id, user_id,
    valid_from, eligibility_valid_until, history_visible_from,
    selector_fingerprint, source_snapshot, opened_reason
  )
  select p_organization_id, p_policy_id, v_version_id, v_policy.conversation_id,
    candidate.user_id,
    greatest(v_publish_at, candidate.eligible_from),
    candidate.eligible_until,
    case when conversation.history_policy = 'all' then null::timestamptz
      else greatest(v_publish_at, candidate.eligible_from) end,
    v_policy.selector_fingerprint, candidate.source_snapshot, 'policy.published'
  from private.dynamic_group_policy_candidates(
    p_organization_id, v_policy.policy_spec, v_preview.evaluated_at
  ) candidate
  join public.conversations conversation
    on conversation.organization_id = p_organization_id
   and conversation.id = v_policy.conversation_id
  where candidate.eligible_until is null
    or candidate.eligible_until > greatest(v_publish_at, candidate.eligible_from);

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('app.dynamic_group_reconcile_context', 'on', true);
  perform set_config('app.bff_service_context', 'on', true);
  update public.conversation_members member
  set can_post = false
  where member.organization_id = p_organization_id
    and member.conversation_id = v_policy.conversation_id
    and member.status = 'active';

  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, status, can_post,
    joined_by_user_id, joined_at, history_visible_from, left_at,
    managed_by_policy_id
  )
  select p_organization_id, v_policy.conversation_id, candidate.user_id,
    'member',
    'active',
    greatest(v_publish_at, candidate.eligible_from) <= v_publish_at,
    p_actor_user_id, greatest(v_publish_at, candidate.eligible_from),
    case when conversation.history_policy = 'all' then null::timestamptz
      else greatest(v_publish_at, candidate.eligible_from) end,
    null::timestamptz,
    p_policy_id
  from private.dynamic_group_policy_candidates(
    p_organization_id, v_policy.policy_spec, v_preview.evaluated_at
  ) candidate
  join public.conversations conversation
    on conversation.organization_id = p_organization_id
   and conversation.id = v_policy.conversation_id
  on conflict (organization_id, conversation_id, user_id) do update
  set status = excluded.status,
      left_at = excluded.left_at,
      can_post = excluded.can_post,
      managed_by_policy_id = case
        when public.conversation_members.role = 'member' then p_policy_id
        else public.conversation_members.managed_by_policy_id end,
      history_visible_from = case
        when public.conversation_members.history_visible_from is null
          or excluded.history_visible_from is null then null
        else least(
          public.conversation_members.history_visible_from,
          excluded.history_visible_from
        ) end;

  perform set_config('app.dynamic_group_policy_write_context', 'on', true);
  update public.dynamic_group_policies policy
  set status = 'active',
      approved_by_user_id = p_actor_user_id,
      approved_at = v_publish_at,
      published_version_id = v_version_id,
      draft_state = 'published',
      last_synced_at = v_publish_at,
      next_evaluation_at = v_preview.next_boundary_at,
      source_changed_at = null
  where policy.organization_id = p_organization_id and policy.id = p_policy_id;
  perform set_config('app.dynamic_group_policy_write_context', 'off', true);

  insert into public.messages (
    organization_id, conversation_id, sender_user_id, kind, body,
    language_detection_state, language_detection_method,
    language_detected_at, metadata
  ) values (
    p_organization_id, v_policy.conversation_id, p_actor_user_id, 'system', null,
    'not_applicable', 'system', v_publish_at,
    jsonb_build_object(
      'event_type', 'dynamic_group.policy.published',
      'policy_version', v_policy.version,
      'added_count', v_preview.added_count,
      'removed_count', v_preview.removed_count,
      'unchanged_count', v_preview.unchanged_count
    )
  ) returning id into v_system_message_id;
  perform set_config('app.dynamic_group_reconcile_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);
  perform set_config(
    'request.jwt.claims', coalesce(nullif(v_prior_jwt_claims, ''), '{}'), true
  );

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'dynamic_group.policy.published',
    'dynamic_group_policy', p_policy_id::text,
    jsonb_build_object(
      'policy_version', v_policy.version,
      'selector_fingerprint', v_policy.selector_fingerprint,
      'membership_state_fingerprint', v_preview.membership_state_fingerprint,
      'eligible_count', v_preview.eligible_count,
      'added_count', v_preview.added_count,
      'removed_count', v_preview.removed_count,
      'unchanged_count', v_preview.unchanged_count,
      'system_message_id', v_system_message_id
    )
  );
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'dynamic_group_sync',
    'dynamic-group:' || p_policy_id::text || ':version:' || v_policy.version::text,
    jsonb_build_object(
      'policy_id', p_policy_id,
      'conversation_id', v_policy.conversation_id,
      'policy_version', v_policy.version,
      'selector_fingerprint', v_policy.selector_fingerprint,
      'added_count', v_preview.added_count,
      'removed_count', v_preview.removed_count,
      'unchanged_count', v_preview.unchanged_count,
      'invalidate_membership', true
    )
  );
  v_response := jsonb_build_object(
    'policy_id', p_policy_id,
    'policy_version', v_policy.version,
    'published_version_id', v_version_id,
    'status', 'active',
    'draft_state', 'published',
    'eligible_count', v_preview.eligible_count,
    'added_count', v_preview.added_count,
    'removed_count', v_preview.removed_count,
    'unchanged_count', v_preview.unchanged_count,
    'selector_fingerprint', v_policy.selector_fingerprint,
    'next_evaluation_at', v_preview.next_boundary_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/dynamic-groups/:id/publish',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.lock_policy_managed_conversation_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid := case when tg_op = 'DELETE'
    then old.organization_id else new.organization_id end;
  v_conversation_id uuid := case when tg_op = 'DELETE'
    then old.conversation_id else new.conversation_id end;
  v_service boolean := coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or session_user in ('postgres', 'service_role');
begin
  if tg_op = 'UPDATE'
    and new.organization_id is not distinct from old.organization_id
    and new.conversation_id is not distinct from old.conversation_id
    and new.user_id is not distinct from old.user_id
    and new.role is not distinct from old.role
    and new.status is not distinct from old.status
    and new.can_post is not distinct from old.can_post
    and new.joined_by_user_id is not distinct from old.joined_by_user_id
    and new.joined_at is not distinct from old.joined_at
    and new.history_visible_from is not distinct from old.history_visible_from
    and new.left_at is not distinct from old.left_at
    and new.managed_by_policy_id is not distinct from old.managed_by_policy_id then
    -- Per-user notification preferences are not membership governance.
    return new;
  end if;
  if exists (
    select 1 from public.dynamic_group_policies policy
    where policy.organization_id = v_organization_id
      and policy.conversation_id = v_conversation_id
      and policy.published_version_id is not null
  ) and not (
    v_service and coalesce(
      current_setting('app.dynamic_group_reconcile_context', true), 'off'
    ) = 'on'
  ) and not (
    v_service
    and coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.member_offboarding_context', true), 'off') = 'on'
  ) then
    raise exception 'manual membership is locked by the published dynamic policy'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger conversation_members_05_lock_dynamic_policy
before insert or update or delete on public.conversation_members
for each row execute function private.lock_policy_managed_conversation_membership();

create or replace function private.is_conversation_member(
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
  if v_user_id is null or not private.current_session_active_for_org(p_organization_id) then
    return false;
  end if;
  if private.dynamic_group_policy_conversation(
    p_organization_id, p_conversation_id
  ) then
    return private.dynamic_group_user_currently_eligible(
      p_organization_id, p_conversation_id, v_user_id, now()
    );
  end if;
  return exists (
    select 1
    from public.conversation_members conversation_member
    join public.organization_memberships organization_member
      on organization_member.organization_id = conversation_member.organization_id
     and organization_member.user_id = conversation_member.user_id
     and organization_member.status = 'active'
    where conversation_member.organization_id = p_organization_id
      and conversation_member.conversation_id = p_conversation_id
      and conversation_member.user_id = v_user_id
      and conversation_member.status = 'active'
  );
end;
$$;

create or replace function private.is_conversation_admin(
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
  if v_user_id is null or not private.current_session_active_for_org(p_organization_id) then
    return false;
  end if;
  if private.dynamic_group_policy_conversation(
    p_organization_id, p_conversation_id
  ) and not private.dynamic_group_user_currently_eligible(
    p_organization_id, p_conversation_id, v_user_id, now()
  ) then
    return false;
  end if;
  return exists (
    select 1
    from public.conversation_members conversation_member
    join public.organization_memberships organization_member
      on organization_member.organization_id = conversation_member.organization_id
     and organization_member.user_id = conversation_member.user_id
     and organization_member.status = 'active'
    where conversation_member.organization_id = p_organization_id
      and conversation_member.conversation_id = p_conversation_id
      and conversation_member.user_id = v_user_id
      and conversation_member.status = 'active'
      and conversation_member.role in ('owner', 'admin')
  );
end;
$$;

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
  if v_user_id is null then return false; end if;
  return exists (
    select 1
    from public.conversations conversation
    join public.organization_memberships organization_member
      on organization_member.organization_id = conversation.organization_id
     and organization_member.user_id = v_user_id
     and organization_member.status = 'active'
    left join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = v_user_id
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and not conversation.is_archived and conversation.closed_at is null
      and private.current_session_active_for_org(p_organization_id)
      and case
        when private.dynamic_group_policy_conversation(
          p_organization_id, p_conversation_id
        ) then private.dynamic_group_user_currently_eligible(
          p_organization_id, p_conversation_id, v_user_id, now()
        )
        else member.status = 'active' and member.can_post
      end
      and (
        conversation.posting_mode = 'all_members'
        or member.role in ('owner', 'admin')
      )
      and (
        conversation.kind <> 'announcement'
        or member.role in ('owner', 'admin')
        or organization_member.role in ('owner', 'admin')
      )
      and (
        conversation.kind <> 'direct'
        or exists (
          select 1 from public.direct_conversation_pairs pair
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
  v_policy_id uuid;
begin
  if new.kind = 'system'
    and coalesce(current_setting('app.bff_service_context', true), 'off') = 'on' then
    return new;
  end if;
  if v_actor_user_id is null or new.sender_user_id <> v_actor_user_id then
    raise exception 'active conversation membership with posting access is required'
      using errcode = '42501';
  end if;
  select conversation.kind, conversation.posting_mode,
    conversation.is_archived, conversation.closed_at
    into v_kind, v_posting_mode, v_is_archived, v_closed_at
  from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id
  for share;
  if not found then
    raise exception 'active conversation membership with posting access is required'
      using errcode = '42501';
  end if;

  select policy.id into v_policy_id
  from public.dynamic_group_policies policy
  where policy.organization_id = new.organization_id
    and policy.conversation_id = new.conversation_id
    and policy.published_version_id is not null
  for share;

  select coalesce(member.role, 'member'), organization_member.role,
    coalesce(member.can_post, false)
    into v_member_role, v_organization_role, v_can_post
  from public.organization_memberships organization_member
  left join public.conversation_members member
    on member.organization_id = organization_member.organization_id
   and member.conversation_id = new.conversation_id
   and member.user_id = organization_member.user_id
  where organization_member.organization_id = new.organization_id
    and organization_member.user_id = v_actor_user_id
    and organization_member.status = 'active';

  if not found or v_is_archived or v_closed_at is not null
    or (v_policy_id is null and not v_can_post)
    or (v_policy_id is not null and not private.dynamic_group_user_currently_eligible(
      new.organization_id, new.conversation_id, v_actor_user_id, now()
    ))
    or (v_posting_mode = 'admins_only' and v_member_role not in ('owner', 'admin'))
    or (v_kind = 'announcement' and v_member_role not in ('owner', 'admin')
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
        || v_pair_high_user_id::text, 0
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

create or replace function public.bff_save_dynamic_group_policy_v2(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_policy_id uuid,
  p_expected_version integer,
  p_policy_spec jsonb,
  p_maximum_members integer,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_save_dynamic_group_policy_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_policy_id, p_expected_version, p_policy_spec, p_maximum_members,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_preview_dynamic_group_v2(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_expected_version integer,
  p_sample_limit integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_preview_dynamic_group_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_policy_id,
    p_expected_version, p_sample_limit
  )
$$;

create or replace function public.bff_publish_dynamic_group_policy(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_expected_version integer,
  p_preview_fingerprint text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_publish_dynamic_group_policy_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_policy_id,
    p_expected_version, p_preview_fingerprint,
    p_idempotency_key, p_request_sha256
  )
$$;

-- The legacy save/sync contract has no compare-and-swap or preview token and
-- therefore cannot safely mutate policy state. Keep its signature only as a
-- fail-closed compatibility response while clients migrate to v2.
create or replace function private.bff_save_dynamic_group_policy_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_policy_id uuid,
  p_unit_id uuid,
  p_member_roles text[],
  p_include_unit_descendants boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  raise exception 'dynamic-group v2 CAS save and preview/publish are required'
    using errcode = '0A000';
end;
$$;

create or replace function private.bff_sync_dynamic_group_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  raise exception 'dynamic-group preview fingerprint and CAS publish are required'
    using errcode = '0A000';
end;
$$;

create or replace function private.bff_process_dynamic_group_boundaries_impl(
  p_policy_limit integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_policy record;
  v_processed integer := 0;
  v_now timestamptz := statement_timestamp();
  v_boundary_at timestamptz;
begin
  perform private.require_service_role();
  if p_policy_limit not between 1 and 100 then
    raise exception 'dynamic-group boundary limit must be between 1 and 100'
      using errcode = '22023';
  end if;
  for v_policy in
    select policy.organization_id, policy.id, policy.published_version_id,
      policy.next_evaluation_at as boundary_at
    from public.dynamic_group_policies policy
    where policy.status = 'active'
      and policy.published_version_id is not null
      and policy.next_evaluation_at is not null
      and policy.next_evaluation_at <= v_now
    order by policy.next_evaluation_at, policy.organization_id, policy.id
    for update skip locked
    limit p_policy_limit
  loop
    -- A delayed worker must preserve the authoritative scheduled cutoff. Its
    -- execution time is availability metadata, never the history boundary.
    v_boundary_at := v_policy.boundary_at;
    perform set_config('app.dynamic_group_policy_write_context', 'on', true);
    update public.dynamic_group_policies policy
    set source_changed_at = case when policy.source_changed_at is null
          then v_boundary_at else greatest(policy.source_changed_at, v_boundary_at) end,
        next_evaluation_at = null
    where policy.organization_id = v_policy.organization_id
      and policy.id = v_policy.id;
    perform set_config('app.dynamic_group_policy_write_context', 'off', true);
    insert into private.dynamic_group_policy_source_boundaries (
      organization_id, policy_id, boundary_at, reason
    ) values (
      v_policy.organization_id, v_policy.id, v_boundary_at, 'time.boundary'
    ) on conflict (organization_id, policy_id, boundary_at) do nothing;
    insert into private.dynamic_group_reconciliation_queue (
      organization_id, policy_id, policy_version_id, reason,
      cursor_user_id, requested_at, available_at
    ) values (
      v_policy.organization_id, v_policy.id, v_policy.published_version_id,
      'time.boundary', null, v_boundary_at, v_boundary_at
    ) on conflict (organization_id, policy_id) do update
      set policy_version_id = excluded.policy_version_id,
          reason = excluded.reason,
          cursor_user_id = null,
          requested_at = least(
            private.dynamic_group_reconciliation_queue.requested_at,
            excluded.requested_at
          ), available_at = least(
            private.dynamic_group_reconciliation_queue.available_at,
            excluded.available_at
          );
    v_processed := v_processed + 1;
  end loop;
  return jsonb_build_object('processed_policy_boundaries', v_processed);
end;
$$;

create or replace function private.bff_process_dynamic_group_reconciliation_impl(
  p_policy_limit integer default 5,
  p_user_limit integer default 200
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_queue private.dynamic_group_reconciliation_queue%rowtype;
  v_policy public.dynamic_group_policies%rowtype;
  v_version public.dynamic_group_policy_versions%rowtype;
  v_user_id uuid;
  v_user_ids uuid[];
  v_last_user_id uuid;
  v_processed_policies integer := 0;
  v_processed_users integer := 0;
  v_has_more boolean;
  v_boundary_at timestamptz;
begin
  perform private.require_service_role();
  if p_policy_limit not between 1 and 20 or p_user_limit not between 1 and 500 then
    raise exception 'invalid bounded dynamic-group reconciliation request'
      using errcode = '22023';
  end if;
  for v_queue in
    select queue.*
    from private.dynamic_group_reconciliation_queue queue
    where queue.available_at <= statement_timestamp()
    order by queue.available_at, queue.organization_id, queue.policy_id
    for update skip locked
    limit p_policy_limit
  loop
    select policy.* into v_policy
    from public.dynamic_group_policies policy
    where policy.organization_id = v_queue.organization_id
      and policy.id = v_queue.policy_id
    for update;
    if not found or v_policy.published_version_id is distinct from v_queue.policy_version_id then
      delete from private.dynamic_group_reconciliation_queue queue
      where queue.organization_id = v_queue.organization_id
        and queue.policy_id = v_queue.policy_id;
      continue;
    end if;
    select version.* into strict v_version
    from public.dynamic_group_policy_versions version
    where version.organization_id = v_policy.organization_id
      and version.id = v_policy.published_version_id;
    select least(statement_timestamp(), coalesce(
      min(boundary.boundary_at), v_queue.requested_at
    )) into v_boundary_at
    from private.dynamic_group_policy_source_boundaries boundary
    where boundary.organization_id = v_policy.organization_id
      and boundary.policy_id = v_policy.id;
    select coalesce(array_agg(candidate_user_id order by candidate_user_id), '{}'::uuid[])
      into v_user_ids
    from (
      select users.candidate_user_id
      from (
        select candidate.user_id candidate_user_id
        from private.dynamic_group_policy_candidates(
          v_policy.organization_id, v_version.policy_spec,
          private.dynamic_group_policy_evaluation_time(
            v_version.policy_spec, statement_timestamp()
          )
        ) candidate
        union
        select member.user_id
        from public.conversation_members member
        where member.organization_id = v_policy.organization_id
          and member.conversation_id = v_policy.conversation_id
          and (member.managed_by_policy_id = v_policy.id
            or member.role in ('owner', 'admin'))
        union
        select access_interval.user_id
        from private.dynamic_group_access_intervals access_interval
        where access_interval.organization_id = v_policy.organization_id
          and access_interval.policy_id = v_policy.id
          and access_interval.valid_until is null
          and access_interval.cancelled_at is null
      ) users
      where v_queue.cursor_user_id is null
        or users.candidate_user_id > v_queue.cursor_user_id
      order by users.candidate_user_id
      limit p_user_limit + 1
    ) bounded_users;
    v_has_more := cardinality(v_user_ids) > p_user_limit;
    if v_has_more then v_user_ids := v_user_ids[1:p_user_limit]; end if;
    foreach v_user_id in array v_user_ids loop
      perform private.reconcile_dynamic_group_user_internal(
        v_policy.organization_id, v_policy.id, v_user_id,
        v_boundary_at, v_queue.reason
      );
      v_last_user_id := v_user_id;
      v_processed_users := v_processed_users + 1;
    end loop;
    if v_has_more then
      update private.dynamic_group_reconciliation_queue queue
      set cursor_user_id = v_last_user_id,
          available_at = statement_timestamp(),
          attempts = queue.attempts + 1,
          last_error_code = null
      where queue.organization_id = v_queue.organization_id
        and queue.policy_id = v_queue.policy_id;
    else
      delete from private.dynamic_group_reconciliation_queue queue
      where queue.organization_id = v_queue.organization_id
        and queue.policy_id = v_queue.policy_id;
      perform set_config('app.dynamic_group_policy_write_context', 'on', true);
      update public.dynamic_group_policies policy
      set source_changed_at = null,
          last_synced_at = statement_timestamp(),
          next_evaluation_at = private.dynamic_group_policy_next_boundary(
            v_policy.organization_id, v_version.policy_spec, statement_timestamp()
          )
      where policy.organization_id = v_policy.organization_id
        and policy.id = v_policy.id
        and policy.published_version_id = v_version.id;
      perform set_config('app.dynamic_group_policy_write_context', 'off', true);
      delete from private.dynamic_group_policy_source_boundaries boundary
      where boundary.organization_id = v_policy.organization_id
        and boundary.policy_id = v_policy.id;
    end if;
    v_processed_policies := v_processed_policies + 1;
  end loop;
  return jsonb_build_object(
    'processed_policies', v_processed_policies,
    'processed_users', v_processed_users,
    'policy_limit', p_policy_limit,
    'user_limit', p_user_limit
  );
end;
$$;

create or replace function public.bff_process_dynamic_group_boundaries(
  p_policy_limit integer default 20
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_process_dynamic_group_boundaries_impl(p_policy_limit)
$$;

create or replace function public.bff_process_dynamic_group_reconciliation(
  p_policy_limit integer default 5,
  p_user_limit integer default 200
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_process_dynamic_group_reconciliation_impl(
    p_policy_limit, p_user_limit
  )
$$;

create or replace function private.validate_dynamic_group_policy_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service boolean := coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or session_user in ('postgres', 'service_role');
begin
  if session_user = 'postgres' then
    if tg_op = 'DELETE' then
      raise exception 'dynamic-group policies cannot be deleted; pause them explicitly'
        using errcode = '55000';
    end if;
    return new;
  end if;
  if not v_service or coalesce(
    current_setting('app.dynamic_group_policy_write_context', true), 'off'
  ) <> 'on' then
    raise exception 'dynamic-group policy state is service-workflow owned'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'dynamic-group policies cannot be deleted; pause them explicitly'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger dynamic_group_policies_05_validate_workflow
before insert or update or delete on public.dynamic_group_policies
for each row execute function private.validate_dynamic_group_policy_write();

create or replace function private.validate_dynamic_group_version_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_service boolean := coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or session_user in ('postgres', 'service_role');
begin
  if session_user = 'postgres' then
    return new;
  end if;
  if not v_service or coalesce(
    current_setting('app.dynamic_group_policy_write_context', true), 'off'
  ) <> 'on' then
    raise exception 'dynamic-group policy versions require publish workflow'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger dynamic_group_policy_versions_04_validate_insert
before insert on public.dynamic_group_policy_versions
for each row execute function private.validate_dynamic_group_version_insert();

create or replace function private.storage_upload_authorized(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_match text[];
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then return false; end if;
  v_match := regexp_match(
    p_name,
    '^([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/[^/]+$'
  );
  if v_match is null or lower(v_match[3]) <> lower(v_user_id::text) then
    return false;
  end if;
  begin
    return private.current_session_active_for_org(v_match[1]::uuid)
      and private.can_post_to_conversation(v_match[1]::uuid, v_match[2]::uuid)
      and exists (
        select 1 from public.message_attachments attachment
        where attachment.organization_id = v_match[1]::uuid
          and attachment.conversation_id = v_match[2]::uuid
          and attachment.created_by_user_id = v_user_id
          and attachment.bucket_id = 'message-attachments'
          and attachment.storage_path = p_name
          and attachment.scan_status = 'pending'
      );
  exception when invalid_text_representation then
    return false;
  end;
end;
$$;

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
    where attachment.bucket_id = 'message-attachments'
      and attachment.storage_path = p_name
      and attachment.scan_status = 'clean'
      and private.current_session_active_for_org(attachment.organization_id)
      and private.dynamic_group_message_access_allowed_for_user(
        attachment.organization_id, attachment.conversation_id,
        attachment.message_id, v_user_id, now()
      )
  );
end;
$$;

create or replace function private.bff_get_attachment_state_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
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
    'attachment.state.read', false, 0
  );
  select jsonb_build_object(
    'attachment_id', attachment.id,
    'message_id', attachment.message_id,
    'scan_status', attachment.scan_status,
    'byte_size', attachment.byte_size,
    'mime_type', attachment.mime_type,
    'created_at', attachment.created_at,
    'purge_requested_at', attachment.purge_requested_at
  ) into v_result
  from public.message_attachments attachment
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
    and (
      attachment.created_by_user_id = p_actor_user_id
      and private.dynamic_group_message_access_allowed_for_user(
        attachment.organization_id, attachment.conversation_id,
        attachment.message_id, p_actor_user_id, now()
      )
      or attachment.scan_status = 'clean'
      and private.dynamic_group_message_access_allowed_for_user(
        attachment.organization_id, attachment.conversation_id,
        attachment.message_id, p_actor_user_id, now()
      )
    );
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'attachment', v_result);
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
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'clean'
    and private.dynamic_group_message_access_allowed_for_user(
      attachment.organization_id, attachment.conversation_id,
      attachment.message_id, p_actor_user_id, now()
    );
  perform private.clear_bff_actor_context_internal();
  if not found then return jsonb_build_object('authorized', false); end if;
  return v_result;
exception when others then
  perform private.clear_bff_actor_context_internal();
  raise;
end;
$$;

drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member
on public.conversations for select
to authenticated
using (
  (select private.current_session_active_for_org(organization_id))
  and private.dynamic_group_conversation_access_allowed_for_user(
    organization_id, id, (select auth.uid()), now()
  )
);

drop policy if exists conversation_members_select_member on public.conversation_members;
create policy conversation_members_select_member
on public.conversation_members for select
to authenticated
using (
  (select private.current_session_active_for_org(organization_id))
  and private.dynamic_group_conversation_access_allowed_for_user(
    organization_id, conversation_id, (select auth.uid()), now()
  )
  and case
    when private.dynamic_group_policy_conversation(
      organization_id, conversation_id
    ) then case
      -- A current policy audience may see only the current policy audience.
      -- A retained-history viewer may inspect their own cache row, but cannot
      -- use direct RLS to enumerate the current or stale roster.
      when private.dynamic_group_user_currently_eligible(
        organization_id, conversation_id, (select auth.uid()), now()
      ) then private.dynamic_group_user_currently_eligible(
        organization_id, conversation_id, user_id, now()
      )
      else user_id = (select auth.uid())
    end
    else true
  end
);

drop policy if exists messages_select_member on public.messages;
create policy messages_select_member
on public.messages for select
to authenticated
using (
  (select private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, id
  ))
);

drop policy if exists message_translations_select_member on public.message_translations;
create policy message_translations_select_member
on public.message_translations for select
to authenticated
using (
  (select private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  ))
  and exists (
    select 1 from public.messages source_message
    where source_message.organization_id = message_translations.organization_id
      and source_message.conversation_id = message_translations.conversation_id
      and source_message.id = message_translations.message_id
      and source_message.deleted_at is null
      and message_translations.source_body_sha256 = extensions.digest(
        convert_to(source_message.body, 'UTF8'), 'sha256'
      )
  )
);

drop policy if exists message_reactions_select_member on public.message_reactions;
create policy message_reactions_select_member
on public.message_reactions for select
to authenticated
using (
  (select private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  ))
);

drop policy if exists message_attachments_select_member on public.message_attachments;
create policy message_attachments_select_member
on public.message_attachments for select
to authenticated
using (
  scan_status = 'clean'
  and (select private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  ))
);

drop policy if exists message_attachments_insert_sender on public.message_attachments;
create policy message_attachments_insert_sender
on public.message_attachments for insert
to authenticated
with check (
  created_by_user_id = (select auth.uid())
  and scan_status = 'pending'
  and (select private.can_post_to_conversation(organization_id, conversation_id))
  and (select private.is_message_sender(organization_id, conversation_id, message_id))
);

create or replace function private.dynamic_group_receipt_payload_for_user(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_viewer_user_id uuid,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_message public.messages%rowtype;
  v_result jsonb;
begin
  select message.* into v_message
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
    and private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_message_id,
      p_viewer_user_id, p_at
    );
  if not found or not private.dynamic_group_user_currently_eligible(
    p_organization_id, p_conversation_id, p_viewer_user_id, p_at
  ) then
    -- Retained history never exposes live delivery/read activity after loss.
    return null;
  end if;

  if v_message.sender_user_id <> p_viewer_user_id then
    select jsonb_build_object(
      'scope', 'self',
      'delivered', coalesce(bool_or(receipt.delivered_at is not null), false),
      'delivered_at', min(receipt.delivered_at),
      'read', coalesce(bool_or(receipt.read_at is not null), false),
      'read_at', min(receipt.read_at)
    ) into v_result
    from public.message_receipts receipt
    where receipt.organization_id = p_organization_id
      and receipt.conversation_id = p_conversation_id
      and receipt.message_id = p_message_id
      and receipt.user_id = p_viewer_user_id;
    return v_result;
  end if;

  select jsonb_build_object(
    'scope', 'aggregate',
    'recipient_count', count(*),
    'delivered_count', count(*) filter (where receipt.delivered_at is not null),
    'visible_read_eligible_count', count(*) filter (where
      coalesce(preference.read_visibility, 'everyone') = 'everyone'
      or (coalesce(preference.read_visibility, 'everyone') = 'contacts'
        and connection.status = 'accepted')
    ),
    'visible_read_count', count(*) filter (where receipt.read_at is not null and (
      coalesce(preference.read_visibility, 'everyone') = 'everyone'
      or (coalesce(preference.read_visibility, 'everyone') = 'contacts'
        and connection.status = 'accepted')
    )),
    'delivered', coalesce(bool_or(receipt.delivered_at is not null), false),
    'delivered_at', min(receipt.delivered_at),
    'read', coalesce(bool_or(receipt.read_at is not null and (
      coalesce(preference.read_visibility, 'everyone') = 'everyone'
      or (coalesce(preference.read_visibility, 'everyone') = 'contacts'
        and connection.status = 'accepted')
    )), false),
    'read_at', min(receipt.read_at) filter (where
      coalesce(preference.read_visibility, 'everyone') = 'everyone'
      or (coalesce(preference.read_visibility, 'everyone') = 'contacts'
        and connection.status = 'accepted')
    )
  ) into v_result
  from public.organization_memberships recipient
  left join public.message_receipts receipt
    on receipt.organization_id = p_organization_id
   and receipt.conversation_id = p_conversation_id
   and receipt.message_id = p_message_id
   and receipt.user_id = recipient.user_id
  left join public.organization_user_preferences preference
    on preference.organization_id = recipient.organization_id
   and preference.user_id = recipient.user_id
  left join public.contact_connections connection
    on connection.organization_id = recipient.organization_id
   and connection.member_low_user_id = least(
     v_message.sender_user_id, recipient.user_id
   )
   and connection.member_high_user_id = greatest(
     v_message.sender_user_id, recipient.user_id
   )
   and connection.status = 'accepted'
  where recipient.organization_id = p_organization_id
    and recipient.status = 'active'
    and recipient.user_id <> v_message.sender_user_id
    and private.dynamic_group_timestamp_access_allowed(
      p_organization_id, p_conversation_id, recipient.user_id,
      v_message.created_at, p_at
    )
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = p_organization_id
        and visibility.conversation_id = p_conversation_id
        and visibility.message_id = p_message_id
        and visibility.user_id = recipient.user_id
    );
  return v_result;
end;
$$;

-- Explicit-actor directory visibility is the canonical hook for BFF projections.
-- CHAT-03 replaces this function after guest columns exist, preserving this
-- signature while adding sponsor/admin/shared-named-conversation guest scope.
create or replace function private.can_view_org_member_for_actor(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select isfinite(p_at) and exists (
    select 1
    from public.organization_memberships viewer
    join public.organization_memberships target
      on target.organization_id = viewer.organization_id
     and target.user_id = p_target_user_id
     and target.status = 'active'
    where viewer.organization_id = p_organization_id
      and viewer.user_id = p_actor_user_id
      and viewer.status = 'active'
      and (
        viewer.user_id = target.user_id
        or viewer.role in ('owner', 'admin')
        or (
          target.directory_visibility <> 'private'
          and not exists (
            select 1
            from public.member_blocks block
            where block.organization_id = p_organization_id
              and (
                (block.blocker_user_id = p_actor_user_id
                  and block.blocked_user_id = p_target_user_id)
                or (block.blocker_user_id = p_target_user_id
                  and block.blocked_user_id = p_actor_user_id)
              )
          )
          and (
            target.directory_visibility = 'organization'
            or exists (
              select 1
              from public.organization_unit_members viewer_unit
              join public.organization_unit_members target_unit
                on target_unit.organization_id = viewer_unit.organization_id
               and target_unit.unit_id = viewer_unit.unit_id
               and target_unit.user_id = p_target_user_id
              where viewer_unit.organization_id = p_organization_id
                and viewer_unit.user_id = p_actor_user_id
            )
          )
        )
      )
  )
$$;

create or replace function private.dynamic_group_conversation_list_item_for_user(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_item jsonb,
  p_at timestamptz default now()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_conversation_id uuid := nullif(p_item ->> 'conversation_id', '')::uuid;
  v_current boolean;
  v_members jsonb := '[]'::jsonb;
  v_preview jsonb;
  v_latest_authorized_at timestamptz;
  v_safe_last_read_message_id bigint;
  v_raw_last_read_message_id bigint;
  v_unread_count bigint := 0;
  v_created_at timestamptz;
begin
  if not private.dynamic_group_policy_conversation(
    p_organization_id, v_conversation_id
  ) then
    return p_item;
  end if;
  v_current := private.dynamic_group_user_currently_eligible(
    p_organization_id, v_conversation_id, p_actor_user_id, p_at
  );
  if v_current then
    select coalesce(
      jsonb_agg(member_item.value order by member_item.ordinality), '[]'::jsonb
    ) into v_members
    from jsonb_array_elements(coalesce(p_item -> 'members', '[]'::jsonb))
      with ordinality member_item(value, ordinality)
    where private.dynamic_group_user_currently_eligible(
      p_organization_id, v_conversation_id,
      (member_item.value ->> 'user_id')::uuid, p_at
    ) and private.can_view_org_member_for_actor(
      p_organization_id, p_actor_user_id,
      (member_item.value ->> 'user_id')::uuid, p_at
    );
  end if;

  begin
    v_raw_last_read_message_id := nullif(
      p_item ->> 'last_read_message_id', ''
    )::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    v_raw_last_read_message_id := null;
  end;
  if v_raw_last_read_message_id is not null then
    select max(message.id) into v_safe_last_read_message_id
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = v_conversation_id
      and message.id <= v_raw_last_read_message_id
      and private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, v_conversation_id, message.id,
        p_actor_user_id, p_at
      );
  end if;

  select jsonb_build_object(
      'message_id', message.id,
      'sender_user_id', message.sender_user_id,
      'kind', message.kind,
      'body', message.body,
      'created_at', message.created_at,
      'edited_at', message.edited_at
    ), message.created_at
    into v_preview, v_latest_authorized_at
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = v_conversation_id
    and private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, v_conversation_id, message.id,
      p_actor_user_id, p_at
    )
  order by message.created_at desc, message.id desc
  limit 1;

  select count(*) into v_unread_count
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = v_conversation_id
    and message.id > coalesce(v_safe_last_read_message_id, 0)
    and message.sender_user_id <> p_actor_user_id
    and private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, v_conversation_id, message.id,
      p_actor_user_id, p_at
    );
  select conversation.created_at into v_created_at
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = v_conversation_id;

  return p_item || jsonb_build_object(
    'can_post', v_current and (
      coalesce(p_item ->> 'posting_mode', 'all_members') = 'all_members'
      or p_item ->> 'member_role' in ('owner', 'admin')
    ),
    'members', v_members,
    'preview', coalesce(v_preview, 'null'::jsonb),
    'unread_count', v_unread_count,
    'last_read_message_id', coalesce(
      to_jsonb(v_safe_last_read_message_id), 'null'::jsonb
    ),
    -- Do not let a stale conversation timestamp become a side channel for
    -- messages created during an ineligible interval.
    'updated_at', coalesce(v_latest_authorized_at, v_created_at)
  );
end;
$$;

alter function private.bff_bootstrap_messaging_state_v7_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) rename to bff_bootstrap_messaging_state_v7_pre_dynamic_group_impl;

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
  v_result jsonb;
  v_conversations jsonb;
  v_messages jsonb;
  v_updates jsonb;
  v_handoffs jsonb;
  v_summaries jsonb;
  v_actions jsonb;
  v_reports jsonb;
  v_discoverable jsonb;
  v_selected uuid;
begin
  v_result := private.bff_bootstrap_messaging_state_v7_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  select coalesce(jsonb_agg(
    private.dynamic_group_conversation_list_item_for_user(
      p_organization_id, p_actor_user_id, item.value, now()
    ) order by item.ordinality
  ), '[]'::jsonb) into v_conversations
  from jsonb_array_elements(coalesce(v_result -> 'conversations', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          item.value,
          '{reply}',
          case when item.value #>> '{reply,message_id}' is null
            or private.dynamic_group_message_access_allowed_for_user(
              p_organization_id, (item.value ->> 'conversation_id')::uuid,
              (item.value #>> '{reply,message_id}')::bigint,
              p_actor_user_id, now()
            ) then coalesce(item.value -> 'reply', 'null'::jsonb)
            else 'null'::jsonb end,
          true
        ),
        '{receipt}',
        case when private.dynamic_group_policy_conversation(
          p_organization_id, (item.value ->> 'conversation_id')::uuid
        ) then coalesce(private.dynamic_group_receipt_payload_for_user(
          p_organization_id, (item.value ->> 'conversation_id')::uuid,
          (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
        ), 'null'::jsonb)
        else coalesce(item.value -> 'receipt', 'null'::jsonb) end,
        true
      ),
      '{forward}',
      case when item.value #>> '{forward,source_message_id}' is null
        or private.dynamic_group_message_access_allowed_for_user(
          p_organization_id,
          (item.value #>> '{forward,source_conversation_id}')::uuid,
          (item.value #>> '{forward,source_message_id}')::bigint,
          p_actor_user_id, now()
        ) then coalesce(item.value -> 'forward', 'null'::jsonb)
        else '{"forwarded":true}'::jsonb end,
      true
    ) order by item.ordinality
  ), '[]'::jsonb)
    into v_messages
  from jsonb_array_elements(coalesce(v_result #> '{timeline,messages}', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id,
    (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint,
    p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_updates
  from jsonb_array_elements(coalesce(v_result -> 'updates', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_handoffs
  from jsonb_array_elements(coalesce(v_result -> 'handoffs', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where not exists (
    select 1 from jsonb_array_elements_text(
      coalesce(item.value -> 'source_message_ids', '[]'::jsonb)
    ) source_id(value)
    where not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      source_id.value::bigint, p_actor_user_id, now()
    )
  ) and private.dynamic_group_timestamp_access_allowed(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id,
    (select max(version.created_at)
     from public.handoff_versions version
     where version.organization_id = p_organization_id
       and version.handoff_id = (item.value ->> 'handoff_id')::uuid), now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_summaries
  from jsonb_array_elements(coalesce(v_result -> 'summaries', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where not exists (
    select 1 from jsonb_array_elements_text(
      coalesce(item.value -> 'source_message_ids', '[]'::jsonb)
    ) source_id(value)
    where not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      source_id.value::bigint, p_actor_user_id, now()
    )
  ) and private.dynamic_group_timestamp_access_allowed(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id, (item.value ->> 'created_at')::timestamptz, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_actions
  from jsonb_array_elements(coalesce(v_result -> 'actions', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where case when item.value ->> 'source_message_id' is null
    then private.dynamic_group_timestamp_access_allowed(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      p_actor_user_id, (item.value ->> 'created_at')::timestamptz, now()
    ) else private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      (item.value ->> 'source_message_id')::bigint, p_actor_user_id, now()
    ) end;

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_reports
  from jsonb_array_elements(coalesce(v_result -> 'moderation_reports', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_discoverable
  from jsonb_array_elements(coalesce(
    v_result -> 'discoverable_conversations', '[]'::jsonb
  )) with ordinality item(value, ordinality)
  where not private.dynamic_group_policy_conversation(
    p_organization_id, (item.value ->> 'conversation_id')::uuid
  );

  v_selected := nullif(v_result ->> 'selected_conversation_id', '')::uuid;
  if v_selected is not null and not private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, v_selected, p_actor_user_id, now()
  ) then
    v_selected := null;
    v_messages := '[]'::jsonb;
  end if;
  v_result := jsonb_set(v_result, '{conversations}', v_conversations, true);
  v_result := jsonb_set(v_result, '{timeline,messages}', v_messages, true);
  v_result := jsonb_set(v_result, '{updates}', v_updates, true);
  v_result := jsonb_set(v_result, '{handoffs}', v_handoffs, true);
  v_result := jsonb_set(v_result, '{summaries}', v_summaries, true);
  v_result := jsonb_set(v_result, '{actions}', v_actions, true);
  v_result := jsonb_set(v_result, '{moderation_reports}', v_reports, true);
  v_result := jsonb_set(
    v_result, '{discoverable_conversations}', v_discoverable, true
  );
  v_result := jsonb_set(
    v_result, '{selected_conversation_id}',
    coalesce(to_jsonb(v_selected), 'null'::jsonb), true
  );
  return v_result;
end;
$$;

create or replace function private.dynamic_group_search_item_allowed_for_user(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_item jsonb,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case p_item ->> 'type'
    when 'people' then private.can_view_org_member_for_actor(
      p_organization_id, p_actor_user_id,
      (p_item ->> 'id')::uuid, p_at
    )
    when 'messages' then private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (p_item ->> 'conversation_id')::uuid,
      (p_item ->> 'id')::bigint, p_actor_user_id, p_at
    )
    when 'announcements' then exists (
      select 1
      from public.announcement_versions version
      where version.organization_id = p_organization_id
        and version.announcement_id = (p_item ->> 'id')::uuid
        and private.dynamic_group_message_access_allowed_for_user(
          version.organization_id, version.conversation_id,
          version.message_id, p_actor_user_id, p_at
        )
    )
    when 'handoffs' then exists (
      select 1 from public.handoff_versions version
      where version.organization_id = p_organization_id
        and version.handoff_id = (p_item ->> 'id')::uuid
        and private.dynamic_group_timestamp_access_allowed(
          version.organization_id, version.conversation_id,
          p_actor_user_id, version.created_at, p_at
        )
        and not exists (
          select 1 from unnest(version.source_message_ids) source_id
          where not private.dynamic_group_message_access_allowed_for_user(
            version.organization_id, version.conversation_id,
            source_id, p_actor_user_id, p_at
          )
        )
    )
    when 'conversations' then private.dynamic_group_conversation_access_allowed_for_user(
      p_organization_id, (p_item ->> 'id')::uuid, p_actor_user_id, p_at
    )
    else true
  end
$$;

alter function private.bff_search_v3_impl(
  uuid, uuid, uuid, text, text[], text, integer, uuid,
  timestamptz, timestamptz, text[], uuid, text
) rename to bff_search_v3_pre_dynamic_group_impl;

create or replace function private.bff_search_v3_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_types text[],
  p_cursor text,
  p_limit integer,
  p_sender_user_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_match_sources text[] default null,
  p_conversation_id uuid default null,
  p_language text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page jsonb;
  v_page_filtered jsonb;
  v_authorized jsonb := '[]'::jsonb;
  v_scan_cursor text := p_cursor;
  v_next_cursor text;
  v_page_has_more boolean;
  v_needed integer;
  v_filtered_count integer;
  v_anchor_ordinal integer;
  v_iteration integer;
begin
  if p_limit not between 1 and 50 then
    -- Preserve the inherited request contract before any scan work.
    return private.bff_search_v3_pre_dynamic_group_impl(
      p_actor_user_id, p_organization_id, p_session_id, p_query, p_types,
      p_cursor, p_limit, p_sender_user_id, p_date_from, p_date_to,
      p_match_sources, p_conversation_id, p_language
    );
  end if;

  -- Search up to 500 underlying rows per request. An authorization-empty page
  -- is never represented as terminal while the underlying cursor has work.
  for v_iteration in 1..10 loop
    v_page := private.bff_search_v3_pre_dynamic_group_impl(
      p_actor_user_id, p_organization_id, p_session_id, p_query, p_types,
      v_scan_cursor, 50, p_sender_user_id, p_date_from, p_date_to,
      p_match_sources, p_conversation_id, p_language
    );
    v_page_has_more := coalesce((v_page ->> 'has_more')::boolean, false);
    select coalesce(
        jsonb_agg(item.value order by item.ordinality), '[]'::jsonb
      ), count(*)::integer
      into v_page_filtered, v_filtered_count
    from jsonb_array_elements(coalesce(v_page -> 'results', '[]'::jsonb))
      with ordinality item(value, ordinality)
    where private.dynamic_group_search_item_allowed_for_user(
      p_organization_id, p_actor_user_id, item.value, now()
    );

    v_needed := p_limit - jsonb_array_length(v_authorized);
    if v_filtered_count >= v_needed then
      select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
        into v_page_filtered
      from jsonb_array_elements(v_page_filtered)
        with ordinality item(value, ordinality)
      where item.ordinality <= v_needed;
      v_authorized := v_authorized || v_page_filtered;

      if v_filtered_count > v_needed or v_page_has_more then
        with allowed as (
          select item.ordinality,
            row_number() over (order by item.ordinality) allowed_ordinality
          from jsonb_array_elements(coalesce(v_page -> 'results', '[]'::jsonb))
            with ordinality item(value, ordinality)
          where private.dynamic_group_search_item_allowed_for_user(
            p_organization_id, p_actor_user_id, item.value, now()
          )
        )
        select allowed.ordinality::integer into v_anchor_ordinal
        from allowed where allowed.allowed_ordinality = v_needed;
        -- Ask the inherited cursor encoder to bind a cursor to the last row
        -- actually returned, leaving later authorized rows reachable.
        v_next_cursor := private.bff_search_v3_pre_dynamic_group_impl(
          p_actor_user_id, p_organization_id, p_session_id, p_query, p_types,
          v_scan_cursor, v_anchor_ordinal, p_sender_user_id, p_date_from,
          p_date_to, p_match_sources, p_conversation_id, p_language
        ) ->> 'next_cursor';
      end if;
      return jsonb_build_object(
        'results', v_authorized,
        'next_cursor', v_next_cursor,
        'has_more', v_next_cursor is not null
      );
    end if;

    v_authorized := v_authorized || v_page_filtered;
    if not v_page_has_more then
      return jsonb_build_object(
        'results', v_authorized, 'next_cursor', null, 'has_more', false
      );
    end if;
    v_scan_cursor := v_page ->> 'next_cursor';
  end loop;

  return jsonb_build_object(
    'results', v_authorized,
    'next_cursor', v_scan_cursor,
    'has_more', v_scan_cursor is not null
  );
end;
$$;

create or replace function private.summary_source_snapshot_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_source_message_ids bigint[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
  v_fingerprint bytea;
begin
  if cardinality(p_source_message_ids) not between 1 and 500 then
    raise exception 'authorized summary sources required' using errcode = '42501';
  end if;
  select array_agg(message.id order by message.id),
    extensions.digest(convert_to(string_agg(
      message.id::text || ':' || encode(extensions.digest(convert_to(
        coalesce(message.body, '') || ':' || message.metadata::text || ':'
          || coalesce(message.edited_at::text, ''), 'UTF8'
      ), 'sha256'), 'hex'), ',' order by message.id
    ), 'UTF8'), 'sha256')
    into v_ids, v_fingerprint
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = any(p_source_message_ids)
    and private.dynamic_group_message_access_allowed_for_user(
      message.organization_id, message.conversation_id,
      message.id, p_actor_user_id, now()
    );
  if cardinality(v_ids) is distinct from cardinality(p_source_message_ids)
    or cardinality(v_ids) is distinct from cardinality(array(
      select distinct source_id from unnest(p_source_message_ids) source_id
    )) then
    raise exception 'summary source is missing, duplicated, deleted, or unauthorized'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'source_message_ids', to_jsonb(v_ids),
    'source_first_message_id', v_ids[1],
    'source_last_message_id', v_ids[cardinality(v_ids)],
    'source_fingerprint', encode(v_fingerprint, 'hex')
  );
end;
$$;

create or replace function private.handoff_source_snapshot_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_source_message_ids bigint[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids bigint[] := '{}'::bigint[];
  v_fingerprint bytea;
begin
  if cardinality(coalesce(p_source_message_ids, '{}'::bigint[])) > 500 then
    raise exception 'handoff source set exceeds 500 messages' using errcode = '22023';
  end if;
  if not private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, p_conversation_id, p_actor_user_id, now()
  ) then
    raise exception 'active or retained conversation access required' using errcode = '42501';
  end if;
  select coalesce(array_agg(message.id order by message.id), '{}'::bigint[]),
    extensions.digest(convert_to(coalesce(string_agg(
      message.id::text || ':' || message.kind || ':'
        || coalesce(encode(extensions.digest(convert_to(message.body, 'UTF8'), 'sha256'), 'hex'), '')
        || ':' || coalesce(message.edited_at::text, '')
        || ':' || coalesce(message.deleted_at::text, ''),
      '|' order by message.id
    ), ''), 'UTF8'), 'sha256')
  into v_ids, v_fingerprint
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = any(coalesce(p_source_message_ids, '{}'::bigint[]))
    and private.dynamic_group_message_access_allowed_for_user(
      message.organization_id, message.conversation_id,
      message.id, p_actor_user_id, now()
    );
  if cardinality(v_ids) <> cardinality(coalesce(p_source_message_ids, '{}'::bigint[]))
    or v_ids <> (
      select coalesce(array_agg(distinct source_id order by source_id), '{}'::bigint[])
      from unnest(coalesce(p_source_message_ids, '{}'::bigint[])) source_id
    ) then
    raise exception 'handoff sources must be unique, current, visible messages in one conversation'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'source_message_ids', to_jsonb(v_ids),
    'source_fingerprint', encode(v_fingerprint, 'hex')
  );
end;
$$;

create or replace function private.bff_forward_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_source_conversation_id uuid,
  p_source_message_id bigint,
  p_target_conversation_id uuid,
  p_client_nonce uuid,
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
  v_source public.messages%rowtype;
  v_target_message_id bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.forward', false, 0, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select message.* into v_source
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_source_conversation_id
    and message.id = p_source_message_id
    and message.kind = 'text' and message.body is not null
    and private.dynamic_group_message_access_allowed_for_user(
      message.organization_id, message.conversation_id,
      message.id, p_actor_user_id, now()
    )
    and not exists (
      select 1 from public.message_attachments attachment
      where attachment.organization_id = message.organization_id
        and attachment.conversation_id = message.conversation_id
        and attachment.message_id = message.id
    );
  if not found then
    raise exception 'readable forwardable text message not found' using errcode = '42501';
  end if;
  v_target_message_id := private.send_message(
    p_organization_id, p_target_conversation_id, p_client_nonce, 'text',
    v_source.body, v_source.language_code, null, null, '{}'::jsonb
  );
  insert into public.message_forward_provenance (
    organization_id, target_conversation_id, target_message_id,
    source_conversation_id, source_message_id, forwarded_by_user_id
  ) values (
    p_organization_id, p_target_conversation_id, v_target_message_id,
    p_source_conversation_id, p_source_message_id, p_actor_user_id
  ) on conflict (organization_id, target_conversation_id, target_message_id) do nothing;
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'push',
    'message:' || p_organization_id::text || ':' || p_target_conversation_id::text
      || ':' || v_target_message_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', p_target_conversation_id,
      'message_id', v_target_message_id
    )
  );
  v_response := jsonb_build_object(
    'message_id', v_target_message_id,
    'client_nonce', p_client_nonce,
    'forwarded', true,
    'source', jsonb_build_object(
      'conversation_id', p_source_conversation_id,
      'message_id', p_source_message_id
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
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
     and requester.user_id = p_actor_user_id and requester.status = 'active'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind in ('group', 'team')
      and conversation.visibility in ('organization', 'unit')
      and not conversation.is_archived and conversation.closed_at is null
      and case when conversation.visibility = 'invite_only' then 'invite_only'
        when conversation.join_policy = 'inherit'
          then organization.default_group_join_policy
        else conversation.join_policy end = 'approval_required'
      and (
        conversation.visibility = 'organization'
        or exists (
          select 1 from public.organization_unit_members unit_member
          join public.organization_units unit
            on unit.organization_id = unit_member.organization_id
           and unit.id = unit_member.unit_id and unit.is_active
          where unit_member.organization_id = conversation.organization_id
            and unit_member.unit_id = conversation.unit_id
            and unit_member.user_id = p_actor_user_id
        )
      )
      and not private.dynamic_group_policy_conversation(
        conversation.organization_id, conversation.id
      )
      and not exists (
        select 1 from public.conversation_members member
        where member.organization_id = conversation.organization_id
          and member.conversation_id = conversation.id
          and member.user_id = p_actor_user_id and member.status = 'active'
      )
  )
$$;

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
    if old.kind not in ('group', 'team') or old.is_archived
      or old.closed_at is not null
      or private.dynamic_group_policy_conversation(old.organization_id, old.id) then
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

alter function private.bff_report_target_v3_impl(
  uuid, uuid, uuid, text, uuid, bigint, uuid, text, text, boolean,
  integer, integer, text, text, text
) rename to bff_report_target_v3_pre_dynamic_group_impl;

create or replace function private.bff_report_target_v3_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_type text,
  p_conversation_id uuid,
  p_message_id bigint,
  p_subject_user_id uuid,
  p_category text,
  p_details text,
  p_consent_to_share boolean,
  p_context_before integer,
  p_context_after integer,
  p_notice_version text,
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
  v_policy_managed boolean := p_conversation_id is not null
    and private.dynamic_group_policy_conversation(
      p_organization_id, p_conversation_id
    );
begin
  if p_target_type = 'message' and v_policy_managed
    and not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_message_id,
      p_actor_user_id, now()
    ) then
    raise exception 'message is not available' using errcode = '42501';
  end if;
  if p_target_type = 'group' and v_policy_managed
    and not private.dynamic_group_user_currently_eligible(
      p_organization_id, p_conversation_id, p_actor_user_id, now()
    ) then
    raise exception 'group is not available' using errcode = '42501';
  end if;
  -- Adjacent moderation evidence is otherwise selected by physical membership
  -- in the inherited implementation. For a policy-managed conversation, only
  -- the separately authorized target is captured until the evidence selector
  -- itself is interval-aware.
  return private.bff_report_target_v3_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_target_type,
    p_conversation_id, p_message_id, p_subject_user_id, p_category,
    p_details, p_consent_to_share,
    case when v_policy_managed then 0 else p_context_before end,
    case when v_policy_managed then 0 else p_context_after end,
    p_notice_version, p_idempotency_key, p_request_sha256
  );
end;
$$;

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

alter function private.bff_resolve_push_job_impl(
  uuid, bigint, uuid, integer
) rename to bff_resolve_push_job_pre_dynamic_group_impl;

create or replace function private.bff_resolve_push_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_after_device_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_conversation_id uuid;
  v_deliveries jsonb;
begin
  v_result := private.bff_resolve_push_job_pre_dynamic_group_impl(
    p_worker_id, p_job_id, p_after_device_id, p_limit
  );
  v_conversation_id := nullif(v_result #>> '{event,conversation_id}', '')::uuid;
  if v_conversation_id is null or not private.dynamic_group_policy_conversation(
    (v_result #>> '{event,organization_id}')::uuid, v_conversation_id
  ) then
    return v_result;
  end if;
  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_deliveries
  from jsonb_array_elements(coalesce(v_result -> 'deliveries', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_user_currently_eligible(
    (v_result #>> '{event,organization_id}')::uuid,
    v_conversation_id, (item.value ->> 'user_id')::uuid, now()
  );
  return jsonb_set(v_result, '{deliveries}', v_deliveries, true);
end;
$$;

create or replace function private.bff_read_conversation_page_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_before_message_id bigint,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_bootstrap jsonb;
begin
  perform private.require_service_role();
  if p_limit not between 1 and 100 then
    raise exception 'invalid message page bound' using errcode = '22023';
  end if;
  v_bootstrap := private.bff_bootstrap_messaging_state_v7_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_before_message_id, 1, p_limit
  );
  return jsonb_build_object(
    'schema_version', 1,
    'conversation_id', p_conversation_id,
    'messages', coalesce(v_bootstrap #> '{timeline,messages}', '[]'::jsonb),
    'has_more', coalesce((v_bootstrap #>> '{timeline,has_more}')::boolean, false),
    'next_before_message_id', v_bootstrap #> '{timeline,next_before_message_id}',
    'reconcile_after', now()
  );
end;
$$;

alter function private.bff_resolve_summary_job_sources_impl(
  uuid, bigint, text
) rename to bff_resolve_summary_job_sources_pre_dynamic_group_impl;

create or replace function private.bff_resolve_summary_job_sources_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_provider text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_summary public.conversation_summaries%rowtype;
begin
  perform private.require_service_role();
  select job.* into v_job
  from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'summary'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then
    raise exception 'active summary lease required' using errcode = '55000';
  end if;
  select summary.* into v_summary
  from public.conversation_summaries summary
  where summary.organization_id = v_job.organization_id
    and summary.id = (v_job.payload ->> 'summary_id')::uuid
    and summary.status in ('queued', 'processing')
  for update;
  if not found then
    raise exception 'queued summary version not found' using errcode = '55000';
  end if;
  if private.dynamic_group_policy_conversation(
      v_summary.organization_id, v_summary.conversation_id
    ) and (
      not private.dynamic_group_user_currently_eligible(
        v_summary.organization_id, v_summary.conversation_id,
        v_summary.requested_by_user_id, now()
      ) or exists (
        select 1 from unnest(v_summary.source_message_ids) source_id
        where not private.dynamic_group_message_access_allowed_for_user(
          v_summary.organization_id, v_summary.conversation_id,
          source_id, v_summary.requested_by_user_id, now()
        )
      )
    ) then
    perform set_config('app.summary_stale_context', 'on', true);
    update public.conversation_summaries summary
    set status = 'stale', primary_topic = null, summary_body = null,
        key_topics = null, decisions = null, action_items = null,
        ambiguities = null, output_fingerprint = null,
        processor_type = null, provider = null, model = null,
        processor_provenance = '{}'::jsonb,
        failure_code = 'requester_or_source_unauthorized',
        reviewed_by_user_id = null, reviewed_at = null,
        review_note = null, updated_at = now()
    where summary.id = v_summary.id;
    perform set_config('app.summary_stale_context', 'off', true);
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'summary_id', v_summary.id,
      'status', 'stale',
      'failure_code', 'requester_or_source_unauthorized',
      'source_content_released', false
    );
  end if;
  return private.bff_resolve_summary_job_sources_pre_dynamic_group_impl(
    p_worker_id, p_job_id, p_provider
  );
end;
$$;

-- Exact-target command guards. Current membership authorizes a command class;
-- the referenced message must independently fall inside the actor's explicit
-- policy interval. This prevents guessed IDs from an ineligibility gap.
alter function private.bff_edit_message_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) rename to bff_edit_message_pre_dynamic_group_impl;

create or replace function private.bff_edit_message_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_body text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(
    p_organization_id, p_conversation_id
  ) and (
    not private.dynamic_group_user_currently_eligible(
      p_organization_id, p_conversation_id, p_actor_user_id, now()
    ) or not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_message_id,
      p_actor_user_id, now()
    )
  ) then
    raise exception 'message mutation requires current policy access'
      using errcode = '42501';
  end if;
  return private.bff_edit_message_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_body, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_delete_message_impl(
  uuid, uuid, uuid, uuid, bigint, text, text
) rename to bff_delete_message_pre_dynamic_group_impl;

create or replace function private.bff_delete_message_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(
    p_organization_id, p_conversation_id
  ) and (
    not private.dynamic_group_user_currently_eligible(
      p_organization_id, p_conversation_id, p_actor_user_id, now()
    ) or not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_message_id,
      p_actor_user_id, now()
    )
  ) then
    raise exception 'message mutation requires current policy access'
      using errcode = '42501';
  end if;
  return private.bff_delete_message_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_send_message_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb, text, text
) rename to bff_send_message_pre_dynamic_group_impl;

create or replace function private.bff_send_message_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_client_nonce uuid, p_kind text, p_body text,
  p_language_code text, p_reply_to_message_id bigint,
  p_thread_root_message_id bigint, p_metadata jsonb,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(
    p_organization_id, p_conversation_id
  ) and (
    (p_reply_to_message_id is not null and
      not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_reply_to_message_id,
        p_actor_user_id, now()
      ))
    or (p_thread_root_message_id is not null and
      not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_thread_root_message_id,
        p_actor_user_id, now()
      ))
    or (jsonb_typeof(p_metadata -> 'mentionUserIds') = 'array' and exists (
      select 1
      from jsonb_array_elements_text(p_metadata -> 'mentionUserIds') mention(value)
      where mention.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and not private.dynamic_group_user_currently_eligible(
          p_organization_id, p_conversation_id, mention.value::uuid, now()
        )
    ))
  ) then
    raise exception 'reply, thread, and mentions require current policy access'
      using errcode = '42501';
  end if;
  return private.bff_send_message_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_kind, p_body, p_language_code, p_reply_to_message_id,
    p_thread_root_message_id, p_metadata, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_set_message_reaction_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) rename to bff_set_message_reaction_pre_dynamic_group_impl;
create or replace function private.bff_set_message_reaction_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_emoji text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
      )
    ) then
    raise exception 'reaction target is not available' using errcode = '42501';
  end if;
  return private.bff_set_message_reaction_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_emoji, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_remove_message_reaction_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) rename to bff_remove_message_reaction_pre_dynamic_group_impl;
create or replace function private.bff_remove_message_reaction_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_emoji text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
      )
    ) then
    raise exception 'reaction target is not available' using errcode = '42501';
  end if;
  return private.bff_remove_message_reaction_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_emoji, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_set_message_pin_impl(
  uuid, uuid, uuid, uuid, bigint, boolean, text, text
) rename to bff_set_message_pin_pre_dynamic_group_impl;
create or replace function private.bff_set_message_pin_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_pinned boolean,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
      )
    ) then
    raise exception 'pin target is not available' using errcode = '42501';
  end if;
  return private.bff_set_message_pin_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_pinned, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_enqueue_translation_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) rename to bff_enqueue_translation_pre_dynamic_group_impl;
create or replace function private.bff_enqueue_translation_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_target_language text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
      )
    ) then
    raise exception 'translation source is not available' using errcode = '42501';
  end if;
  return private.bff_enqueue_translation_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_target_language, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_propose_translation_correction_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text, text, text
) rename to bff_propose_translation_correction_pre_dynamic_group_impl;
create or replace function private.bff_propose_translation_correction_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_target_language text,
  p_corrected_body text, p_rationale text, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
      )
    ) then
    raise exception 'translation correction source is not available'
      using errcode = '42501';
  end if;
  return private.bff_propose_translation_correction_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_target_language, p_corrected_body, p_rationale,
    p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_review_translation_correction_impl(
  uuid, uuid, uuid, uuid, text, text, text, text
) rename to bff_review_translation_correction_pre_dynamic_group_impl;
create or replace function private.bff_review_translation_correction_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_correction_id uuid, p_decision text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_message_id bigint;
begin
  select correction.conversation_id, correction.message_id
    into v_conversation_id, v_message_id
  from public.translation_corrections correction
  where correction.organization_id = p_organization_id
    and correction.id = p_correction_id;
  if v_conversation_id is not null
    and private.dynamic_group_policy_conversation(
      p_organization_id, v_conversation_id
    ) and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, v_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, v_conversation_id, v_message_id,
        p_actor_user_id, now()
      )
    ) then
    raise exception 'translation correction is not available'
      using errcode = '42501';
  end if;
  return private.bff_review_translation_correction_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_correction_id,
    p_decision, p_note, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_review_conversation_summary_impl(
  uuid, uuid, uuid, uuid, text, text, text, text
) rename to bff_review_conversation_summary_pre_dynamic_group_impl;
create or replace function private.bff_review_conversation_summary_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_summary_id uuid, p_decision text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_conversation_id uuid;
  v_source_message_ids bigint[];
begin
  select summary.conversation_id, summary.source_message_ids
    into v_conversation_id, v_source_message_ids
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id
    and summary.id = p_summary_id;
  if v_conversation_id is not null
    and private.dynamic_group_policy_conversation(
      p_organization_id, v_conversation_id
    ) and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, v_conversation_id, p_actor_user_id, now()
      ) or exists (
        select 1 from unnest(v_source_message_ids) source_id
        where not private.dynamic_group_message_access_allowed_for_user(
          p_organization_id, v_conversation_id, source_id,
          p_actor_user_id, now()
        )
      )
    ) then
    raise exception 'summary sources are not available' using errcode = '42501';
  end if;
  return private.bff_review_conversation_summary_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_summary_id,
    p_decision, p_note, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_create_attachment_upload_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, bigint, text, text, text
) rename to bff_create_attachment_upload_pre_dynamic_group_impl;
create or replace function private.bff_create_attachment_upload_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_file_name text,
  p_mime_type text, p_byte_size bigint, p_sha256_hex text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_message_id,
        p_actor_user_id, now()
      )
    ) then
    raise exception 'attachment source is not available' using errcode = '42501';
  end if;
  return private.bff_create_attachment_upload_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_file_name, p_mime_type, p_byte_size, p_sha256_hex,
    p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_propose_operational_action_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text, text
) rename to bff_propose_operational_action_pre_dynamic_group_impl;
create or replace function private.bff_propose_operational_action_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_source_message_id bigint, p_title text,
  p_details text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_source_message_id is not null
    and private.dynamic_group_policy_conversation(
      p_organization_id, p_conversation_id
    ) and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_source_message_id,
        p_actor_user_id, now()
      )
    ) then
    raise exception 'operational action source is not available'
      using errcode = '42501';
  end if;
  return private.bff_propose_operational_action_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_source_message_id, p_title, p_details, p_idempotency_key, p_request_sha256
  );
end;
$$;

alter function private.bff_hide_message_for_me_impl(
  uuid, uuid, uuid, uuid, bigint, text, text
) rename to bff_hide_message_for_me_pre_dynamic_group_impl;
create or replace function private.bff_hide_message_for_me_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
    ) then
    raise exception 'message is not available' using errcode = '42501';
  end if;
  return private.bff_hide_message_for_me_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_idempotency_key, p_request_sha256
  );
end;
$$;

create or replace function private.filter_dynamic_group_bulk_receipt_write()
returns trigger
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if coalesce(
      current_setting('app.dynamic_group_bulk_receipt_context', true), 'off'
    ) = 'on'
    and private.dynamic_group_policy_conversation(
      new.organization_id, new.conversation_id
    )
    and not private.dynamic_group_message_access_allowed_for_user(
      new.organization_id, new.conversation_id, new.message_id,
      new.user_id, now()
    ) then
    return null;
  end if;
  return new;
end;
$$;
create trigger message_receipts_04_filter_dynamic_bulk
before insert or update on public.message_receipts
for each row execute function private.filter_dynamic_group_bulk_receipt_write();

alter function private.bff_mark_message_receipt_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) rename to bff_mark_message_receipt_pre_dynamic_group_impl;
create or replace function private.bff_mark_message_receipt_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_state text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
    ) then
    raise exception 'readable message not found' using errcode = '42501';
  end if;
  perform set_config('app.dynamic_group_bulk_receipt_context', 'on', true);
  v_result := private.bff_mark_message_receipt_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_state, p_idempotency_key, p_request_sha256
  );
  perform set_config('app.dynamic_group_bulk_receipt_context', 'off', true);
  return v_result;
exception when others then
  perform set_config('app.dynamic_group_bulk_receipt_context', 'off', true);
  raise;
end;
$$;

-- The legacy preview can neither bind a source-state fingerprint nor support
-- a publish CAS. Keep the public compatibility surface fail closed.
create or replace function private.bff_preview_dynamic_group_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_policy_id uuid, p_limit integer
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  perform private.require_service_role();
  raise exception 'dynamic-group v2 CAS preview is required'
    using errcode = '0A000';
end;
$$;

drop policy if exists message_reactions_insert_self on public.message_reactions;
create policy message_reactions_insert_self
on public.message_reactions for insert to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.current_session_active_for_org(organization_id))
  and private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  )
);
drop policy if exists message_reactions_delete_self on public.message_reactions;
create policy message_reactions_delete_self
on public.message_reactions for delete to authenticated
using (
  user_id = (select auth.uid())
  and private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  )
);

drop policy if exists message_pins_select_member on public.message_pins;
create policy message_pins_select_member
on public.message_pins for select to authenticated
using (
  private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  )
);
drop policy if exists message_receipts_select_participant on public.message_receipts;
create policy message_receipts_select_participant
on public.message_receipts for select to authenticated
using (
  user_id = (select auth.uid())
  and private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  )
);
drop policy if exists message_mentions_select_member on public.message_mentions;
create policy message_mentions_select_member
on public.message_mentions for select to authenticated
using (
  private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  )
);

drop policy if exists conversation_read_cursors_select_member
  on public.conversation_read_cursors;
create policy conversation_read_cursors_select_member
on public.conversation_read_cursors for select to authenticated
using (
  user_id = (select auth.uid())
  and private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, last_read_message_id
  )
);
drop policy if exists conversation_read_cursors_insert_self
  on public.conversation_read_cursors;
create policy conversation_read_cursors_insert_self
on public.conversation_read_cursors for insert to authenticated
with check (
  user_id = (select auth.uid())
  and private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, last_read_message_id
  )
);
drop policy if exists conversation_read_cursors_update_self
  on public.conversation_read_cursors;
create policy conversation_read_cursors_update_self
on public.conversation_read_cursors for update to authenticated
using (
  user_id = (select auth.uid())
  and private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, last_read_message_id
  )
)
with check (
  user_id = (select auth.uid())
  and private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, last_read_message_id
  )
);

drop policy if exists message_forward_provenance_select_authorized
  on public.message_forward_provenance;
create policy message_forward_provenance_select_authorized
on public.message_forward_provenance for select to authenticated
using (
  private.dynamic_group_message_access_allowed(
    organization_id, target_conversation_id, target_message_id
  )
  and private.dynamic_group_message_access_allowed(
    organization_id, source_conversation_id, source_message_id
  )
);

drop policy if exists conversation_summaries_select_member
  on public.conversation_summaries;
create policy conversation_summaries_select_member
on public.conversation_summaries for select to authenticated
using (
  private.current_session_active_for_org(organization_id)
  and not exists (
    select 1 from unnest(source_message_ids) source_id
    where not private.dynamic_group_message_access_allowed(
      organization_id, conversation_id, source_id
    )
  )
);

drop policy if exists translation_corrections_select_proposer_or_admin
  on public.translation_corrections;
create policy translation_corrections_select_proposer_or_admin
on public.translation_corrections for select to authenticated
using (
  private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, message_id
  )
  and (
    proposed_by_user_id = (select auth.uid())
    or (select private.is_conversation_admin(organization_id, conversation_id))
    or (select private.is_org_admin(organization_id))
  )
);

drop policy if exists operational_actions_select_member
  on public.operational_actions;
create policy operational_actions_select_member
on public.operational_actions for select to authenticated
using (
  case when source_message_id is null then
    private.dynamic_group_timestamp_access_allowed(
      organization_id, conversation_id, (select auth.uid()), created_at, now()
    )
  else private.dynamic_group_message_access_allowed(
    organization_id, conversation_id, source_message_id
  ) end
);
drop policy if exists operational_action_events_select_member
  on public.operational_action_events;
create policy operational_action_events_select_member
on public.operational_action_events for select to authenticated
using (
  exists (
    select 1 from public.operational_actions action
    where action.organization_id = operational_action_events.organization_id
      and action.id = operational_action_events.action_id
      and case when action.source_message_id is null then
        private.dynamic_group_timestamp_access_allowed(
          action.organization_id, action.conversation_id,
          (select auth.uid()), action.created_at, now()
        )
      else private.dynamic_group_message_access_allowed(
        action.organization_id, action.conversation_id, action.source_message_id
      ) end
  )
);

create or replace function private.bff_pause_dynamic_group_policy_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_policy public.dynamic_group_policies%rowtype;
  v_conversation_unit_id uuid;
  v_pause_at timestamptz := statement_timestamp();
  v_system_message_id bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'dynamic_group.policy.pause', true, 900,
    '/v2/dynamic-groups/:id/pause', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version is null or p_expected_version < 1
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'valid dynamic-group pause request required'
      using errcode = '22023';
  end if;
  select policy.* into v_policy
  from public.dynamic_group_policies policy
  join public.conversations conversation
    on conversation.organization_id = policy.organization_id
   and conversation.id = policy.conversation_id
  where policy.organization_id = p_organization_id
    and policy.id = p_policy_id
  for update of policy;
  if not found or v_policy.version <> p_expected_version
    or v_policy.published_version_id is null or v_policy.status <> 'active' then
    raise exception 'active dynamic-group policy version conflict'
      using errcode = '40001';
  end if;
  select conversation.unit_id into v_conversation_unit_id
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = v_policy.conversation_id;
  if not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'unit.manage', v_conversation_unit_id
  ) then
    raise exception 'dynamic-group policy pause is not permitted'
      using errcode = '42501';
  end if;

  update private.dynamic_group_access_intervals access_interval
  set valid_until = case when access_interval.valid_from > v_pause_at
        then access_interval.valid_from
        else least(
          v_pause_at,
          coalesce(access_interval.eligibility_valid_until, v_pause_at)
        ) end,
      cancelled_at = case when access_interval.valid_from > v_pause_at
        then v_pause_at else access_interval.cancelled_at end,
      closed_reason = 'policy.paused'
  where access_interval.organization_id = p_organization_id
    and access_interval.policy_id = p_policy_id
    and access_interval.valid_until is null
    and access_interval.cancelled_at is null;

  perform set_config('app.dynamic_group_reconcile_context', 'on', true);
  perform set_config('app.bff_service_context', 'on', true);
  update public.conversation_members member
  set can_post = false
  where member.organization_id = p_organization_id
    and member.conversation_id = v_policy.conversation_id
    and member.status = 'active';
  perform set_config('app.dynamic_group_policy_write_context', 'on', true);
  update public.dynamic_group_policies policy
  set status = 'paused', next_evaluation_at = null,
      source_changed_at = null, last_synced_at = v_pause_at
  where policy.organization_id = p_organization_id and policy.id = p_policy_id;
  perform set_config('app.dynamic_group_policy_write_context', 'off', true);
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, kind, body,
    language_detection_state, language_detection_method,
    language_detected_at, metadata
  ) values (
    p_organization_id, v_policy.conversation_id, p_actor_user_id,
    'system', null, 'not_applicable', 'system', v_pause_at,
    jsonb_build_object(
      'event_type', 'dynamic_group.policy.paused',
      'policy_version', v_policy.version
    )
  ) returning id into v_system_message_id;
  perform set_config('app.dynamic_group_reconcile_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);

  delete from private.dynamic_group_reconciliation_queue queue
  where queue.organization_id = p_organization_id
    and queue.policy_id = p_policy_id;
  delete from private.dynamic_group_policy_source_boundaries boundary
  where boundary.organization_id = p_organization_id
    and boundary.policy_id = p_policy_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'dynamic_group.policy.paused',
    'dynamic_group_policy', p_policy_id::text,
    jsonb_build_object(
      'policy_version', v_policy.version,
      'reason', btrim(p_reason),
      'system_message_id', v_system_message_id
    )
  );
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'dynamic_group_sync',
    'dynamic-group:' || p_policy_id::text || ':paused:' || v_policy.version::text,
    jsonb_build_object(
      'policy_id', p_policy_id,
      'conversation_id', v_policy.conversation_id,
      'policy_version', v_policy.version,
      'status', 'paused',
      'invalidate_membership', true
    )
  );
  v_response := jsonb_build_object(
    'policy_id', p_policy_id,
    'policy_version', v_policy.version,
    'status', 'paused',
    'paused_at', v_pause_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/dynamic-groups/:id/pause',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function public.bff_pause_dynamic_group_policy(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_policy_id uuid, p_expected_version integer, p_reason text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$
  select private.bff_pause_dynamic_group_policy_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_policy_id,
    p_expected_version, p_reason, p_idempotency_key, p_request_sha256
  )
$$;

-- Upgrade any policy created by the legacy unit/organization-role contract.
-- Published legacy access is cut at one migration boundary, then only current
-- authoritative candidates receive a new open interval. Oversized legacy
-- audiences abort the migration instead of silently broadening or truncating.
do $backfill$
declare
  v_policy public.dynamic_group_policies%rowtype;
  v_unit_kind text;
  v_spec jsonb;
  v_selector_fingerprint text;
  v_membership_fingerprint text;
  v_version_id uuid;
  v_candidate_ids uuid[];
  v_existing_ids uuid[];
  v_added_count integer;
  v_removed_count integer;
  v_unchanged_count integer;
  v_member_limit integer;
  v_materialized_count integer;
  v_backfill_at timestamptz := statement_timestamp();
begin
  for v_policy in
    select policy.* from public.dynamic_group_policies policy
    where policy.published_version_id is null
    order by policy.organization_id, policy.id
    for update
  loop
    select unit.kind into v_unit_kind
    from public.organization_units unit
    where unit.organization_id = v_policy.organization_id
      and unit.id = v_policy.unit_id;
    v_spec := private.normalize_dynamic_group_policy_spec(jsonb_build_object(
      'site_ids', case when v_unit_kind = 'site'
        then jsonb_build_array(v_policy.unit_id) else '[]'::jsonb end,
      'department_ids', case when v_unit_kind = 'department'
        then jsonb_build_array(v_policy.unit_id) else '[]'::jsonb end,
      'team_ids', case when v_unit_kind = 'team'
        then jsonb_build_array(v_policy.unit_id) else '[]'::jsonb end,
      'line_ids', case when v_unit_kind = 'line'
        then jsonb_build_array(v_policy.unit_id) else '[]'::jsonb end,
      'unit_ids', case when v_policy.unit_id is not null
          and coalesce(v_unit_kind, '') not in ('site', 'department', 'team', 'line')
        then jsonb_build_array(v_policy.unit_id) else '[]'::jsonb end,
      'include_descendants', v_policy.include_unit_descendants,
      'operational_roles', '[]'::jsonb,
      'membership_roles', to_jsonb(v_policy.member_roles),
      'shift_mode', 'none',
      'scheduled_shift_starts_at', null,
      'scheduled_shift_ends_at', null
    ));
    v_selector_fingerprint := private.dynamic_group_selector_fingerprint(v_spec);
    perform set_config('app.dynamic_group_policy_write_context', 'on', true);
    update public.dynamic_group_policies policy
    set policy_spec = v_spec,
        selector_fingerprint = v_selector_fingerprint,
        draft_state = case when policy.status = 'draft'
          then 'draft' else 'published' end,
        last_preview_fingerprint = null,
        last_previewed_at = null
    where policy.organization_id = v_policy.organization_id
      and policy.id = v_policy.id;
    perform set_config('app.dynamic_group_policy_write_context', 'off', true);
    if v_policy.status = 'draft' then
      continue;
    end if;

    select conversation.member_limit into strict v_member_limit
    from public.conversations conversation
    where conversation.organization_id = v_policy.organization_id
      and conversation.id = v_policy.conversation_id;
    select coalesce(array_agg(candidate.user_id order by candidate.user_id), '{}'::uuid[])
      into v_candidate_ids
    from private.dynamic_group_policy_candidates(
      v_policy.organization_id, v_spec, v_backfill_at
    ) candidate;
    if cardinality(v_candidate_ids) > least(v_policy.maximum_members, v_member_limit) then
      raise exception 'legacy dynamic-group audience exceeds safe migration limit for policy %',
        v_policy.id using errcode = '54000';
    end if;
    select count(distinct materialized.user_id)::integer
      into v_materialized_count
    from (
      select unnest(v_candidate_ids) user_id
      union all
      select member.user_id
      from public.conversation_members member
      where member.organization_id = v_policy.organization_id
        and member.conversation_id = v_policy.conversation_id
        and member.status = 'active'
        and member.role in ('owner', 'admin')
    ) materialized;
    if v_materialized_count > v_member_limit then
      raise exception 'legacy dynamic-group audience plus governance exceeds conversation limit for policy %',
        v_policy.id using errcode = '54000';
    end if;
    select coalesce(array_agg(member.user_id order by member.user_id), '{}'::uuid[])
      into v_existing_ids
    from public.conversation_members member
    where member.organization_id = v_policy.organization_id
      and member.conversation_id = v_policy.conversation_id
      and member.status = 'active';
    select count(*)::integer into v_added_count
    from unnest(v_candidate_ids) candidate_id
    where not candidate_id = any(v_existing_ids);
    select count(*)::integer into v_removed_count
    from unnest(v_existing_ids) member_id
    where not member_id = any(v_candidate_ids);
    select count(*)::integer into v_unchanged_count
    from unnest(v_candidate_ids) candidate_id
    where candidate_id = any(v_existing_ids);
    v_membership_fingerprint := private.dynamic_group_membership_state_fingerprint(
      v_policy.organization_id, v_spec, v_backfill_at
    );
    v_version_id := gen_random_uuid();
    perform set_config('app.dynamic_group_policy_write_context', 'on', true);
    insert into public.dynamic_group_policy_versions (
      id, organization_id, policy_id, conversation_id, policy_version,
      policy_spec, selector_fingerprint, membership_state_fingerprint,
      evaluated_at, eligible_count, added_count, removed_count, unchanged_count,
      published_by_user_id, published_at, next_boundary_at
    ) values (
      v_version_id, v_policy.organization_id, v_policy.id,
      v_policy.conversation_id, v_policy.version, v_spec,
      v_selector_fingerprint, v_membership_fingerprint, v_backfill_at,
      cardinality(v_candidate_ids), v_added_count, v_removed_count,
      v_unchanged_count, coalesce(v_policy.approved_by_user_id,
        v_policy.created_by_user_id), coalesce(v_policy.approved_at, v_backfill_at),
      private.dynamic_group_policy_next_boundary(
        v_policy.organization_id, v_spec, v_backfill_at
      )
    );

    insert into private.dynamic_group_access_intervals (
      organization_id, policy_id, policy_version_id, conversation_id, user_id,
      valid_from, valid_until, history_visible_from, selector_fingerprint,
      source_snapshot, opened_reason, closed_reason
    )
    select v_policy.organization_id, v_policy.id, v_version_id,
      v_policy.conversation_id, member.user_id,
      least(member.joined_at, v_backfill_at), v_backfill_at,
      member.history_visible_from, v_selector_fingerprint,
      jsonb_build_object('schema_version', 1, 'legacy_backfill', true),
      'legacy.backfill', 'legacy.backfill.cutover'
    from public.conversation_members member
    where member.organization_id = v_policy.organization_id
      and member.conversation_id = v_policy.conversation_id
      and member.status = 'active';

    perform set_config('app.dynamic_group_reconcile_context', 'on', true);
    perform set_config('app.bff_service_context', 'on', true);
    update public.conversation_members member
    set can_post = false
    where member.organization_id = v_policy.organization_id
      and member.conversation_id = v_policy.conversation_id
      and member.status = 'active';
    if v_policy.status = 'active' then
      insert into private.dynamic_group_access_intervals (
        organization_id, policy_id, policy_version_id, conversation_id,
        user_id, valid_from, eligibility_valid_until, history_visible_from,
        selector_fingerprint, source_snapshot, opened_reason
      )
      select v_policy.organization_id, v_policy.id, v_version_id,
        v_policy.conversation_id, candidate.user_id,
        greatest(v_backfill_at, candidate.eligible_from),
        candidate.eligible_until,
        case when conversation.history_policy = 'all' then null::timestamptz
          else greatest(v_backfill_at, candidate.eligible_from) end,
        v_selector_fingerprint, candidate.source_snapshot, 'legacy.backfill'
      from private.dynamic_group_policy_candidates(
        v_policy.organization_id, v_spec, v_backfill_at
      ) candidate
      join public.conversations conversation
        on conversation.organization_id = v_policy.organization_id
       and conversation.id = v_policy.conversation_id
      where candidate.eligible_until is null
        or candidate.eligible_until > greatest(v_backfill_at, candidate.eligible_from);

      insert into public.conversation_members (
        organization_id, conversation_id, user_id, role, status, can_post,
        joined_by_user_id, joined_at, history_visible_from, left_at,
        managed_by_policy_id
      )
      select v_policy.organization_id, v_policy.conversation_id,
        candidate.user_id, 'member', 'active', true,
        coalesce(v_policy.approved_by_user_id, v_policy.created_by_user_id),
        greatest(v_backfill_at, candidate.eligible_from),
        case when conversation.history_policy = 'all' then null::timestamptz
          else greatest(v_backfill_at, candidate.eligible_from) end,
        null::timestamptz, v_policy.id
      from private.dynamic_group_policy_candidates(
        v_policy.organization_id, v_spec, v_backfill_at
      ) candidate
      join public.conversations conversation
        on conversation.organization_id = v_policy.organization_id
       and conversation.id = v_policy.conversation_id
      on conflict (organization_id, conversation_id, user_id) do update
      set status = excluded.status,
          left_at = null,
          can_post = true,
          managed_by_policy_id = case
            when public.conversation_members.role = 'member' then v_policy.id
            else public.conversation_members.managed_by_policy_id end;
    end if;
    perform set_config('app.dynamic_group_reconcile_context', 'off', true);
    perform set_config('app.bff_service_context', 'off', true);
    update public.dynamic_group_policies policy
    set published_version_id = v_version_id,
        draft_state = 'published',
        next_evaluation_at = case when policy.status = 'active' then
          private.dynamic_group_policy_next_boundary(
            v_policy.organization_id, v_spec, v_backfill_at
          ) else null end,
        source_changed_at = null,
        last_synced_at = v_backfill_at
    where policy.organization_id = v_policy.organization_id
      and policy.id = v_policy.id;
    perform set_config('app.dynamic_group_policy_write_context', 'off', true);

    insert into public.audit_events (
      organization_id, actor_user_id, event_type, target_type, target_id, metadata
    ) values (
      v_policy.organization_id,
      coalesce(v_policy.approved_by_user_id, v_policy.created_by_user_id),
      'dynamic_group.policy.legacy_backfilled', 'dynamic_group_policy',
      v_policy.id::text,
      jsonb_build_object(
        'policy_version', v_policy.version,
        'selector_fingerprint', v_selector_fingerprint,
        'eligible_count', cardinality(v_candidate_ids),
        'cutover_at', v_backfill_at
      )
    );
  end loop;
end;
$backfill$;

alter table public.dynamic_group_policy_versions enable row level security;
alter table public.dynamic_group_policy_versions force row level security;

revoke all on table public.dynamic_group_policy_versions
  from public, anon, authenticated, service_role;
revoke all on table
  private.dynamic_group_policy_previews,
  private.dynamic_group_access_intervals,
  private.dynamic_group_reconciliation_queue,
  private.dynamic_group_dirty_users,
  private.dynamic_group_policy_source_boundaries
from public, anon, authenticated, service_role;

-- Private helpers are never a client API. The selected BFF implementations
-- below are callable only by service_role and all inherited pre-guard entry
-- points remain revoked even though the owning wrappers may invoke them.
revoke execute on all functions in schema private
  from public, anon, authenticated;
do $restore_private_function_acls$
declare
  v_acl record;
begin
  for v_acl in
    select snapshot.function_oid, snapshot.grantee
    from dynamic_group_private_function_acl_snapshot snapshot
    join pg_catalog.pg_proc function_row
      on function_row.oid = snapshot.function_oid
    order by snapshot.function_oid, snapshot.grantee
  loop
    execute format(
      'grant execute on function %s to %I',
      v_acl.function_oid::regprocedure,
      v_acl.grantee
    );
  end loop;
end;
$restore_private_function_acls$;

grant execute on function
  private.dynamic_group_policy_conversation(uuid, uuid),
  private.dynamic_group_user_currently_eligible(
    uuid, uuid, uuid, timestamptz
  ),
  private.dynamic_group_timestamp_access_allowed(
    uuid, uuid, uuid, timestamptz, timestamptz
  ),
  private.dynamic_group_message_access_allowed(uuid, uuid, bigint),
  private.dynamic_group_conversation_access_allowed_for_user(
    uuid, uuid, uuid, timestamptz
  )
to authenticated;
revoke execute on function
  private.bff_bootstrap_messaging_state_v7_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, integer, integer
  ),
  private.bff_search_v3_pre_dynamic_group_impl(
    uuid, uuid, uuid, text, text[], text, integer, uuid,
    timestamptz, timestamptz, text[], uuid, text
  ),
  private.bff_report_target_v3_pre_dynamic_group_impl(
    uuid, uuid, uuid, text, uuid, bigint, uuid, text, text, boolean,
    integer, integer, text, text, text
  ),
  private.bff_resolve_push_job_pre_dynamic_group_impl(uuid, bigint, uuid, integer),
  private.bff_resolve_summary_job_sources_pre_dynamic_group_impl(uuid, bigint, text),
  private.bff_edit_message_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_delete_message_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text
  ),
  private.bff_send_message_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb, text, text
  ),
  private.bff_set_message_reaction_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_remove_message_reaction_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_set_message_pin_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, boolean, text, text
  ),
  private.bff_enqueue_translation_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_propose_translation_correction_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text, text, text
  ),
  private.bff_review_translation_correction_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, text, text, text, text
  ),
  private.bff_review_conversation_summary_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, text, text, text, text
  ),
  private.bff_create_attachment_upload_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, bigint, text, text, text
  ),
  private.bff_propose_operational_action_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text, text
  ),
  private.bff_hide_message_for_me_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text
  ),
  private.bff_mark_message_receipt_pre_dynamic_group_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  )
from public, anon, authenticated, service_role;

grant execute on function
  private.bff_save_dynamic_group_policy_v2_impl(
    uuid, uuid, uuid, uuid, uuid, integer, jsonb, integer, text, text
  ),
  private.bff_preview_dynamic_group_v2_impl(
    uuid, uuid, uuid, uuid, integer, integer
  ),
  private.bff_publish_dynamic_group_policy_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text
  ),
  private.bff_pause_dynamic_group_policy_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text
  ),
  private.bff_process_dynamic_group_boundaries_impl(integer),
  private.bff_process_dynamic_group_reconciliation_impl(integer, integer),
  private.bff_bootstrap_messaging_state_v7_impl(
    uuid, uuid, uuid, uuid, bigint, integer, integer
  ),
  private.bff_search_v3_impl(
    uuid, uuid, uuid, text, text[], text, integer, uuid,
    timestamptz, timestamptz, text[], uuid, text
  ),
  private.bff_report_target_v3_impl(
    uuid, uuid, uuid, text, uuid, bigint, uuid, text, text, boolean,
    integer, integer, text, text, text
  ),
  private.bff_resolve_push_job_impl(uuid, bigint, uuid, integer),
  private.bff_resolve_summary_job_sources_impl(uuid, bigint, text),
  private.bff_edit_message_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_delete_message_impl(
    uuid, uuid, uuid, uuid, bigint, text, text
  ),
  private.bff_send_message_impl(
    uuid, uuid, uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb, text, text
  ),
  private.bff_set_message_reaction_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_remove_message_reaction_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_set_message_pin_impl(
    uuid, uuid, uuid, uuid, bigint, boolean, text, text
  ),
  private.bff_enqueue_translation_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  ),
  private.bff_propose_translation_correction_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text, text, text
  ),
  private.bff_review_translation_correction_impl(
    uuid, uuid, uuid, uuid, text, text, text, text
  ),
  private.bff_review_conversation_summary_impl(
    uuid, uuid, uuid, uuid, text, text, text, text
  ),
  private.bff_create_attachment_upload_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, bigint, text, text, text
  ),
  private.bff_propose_operational_action_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text, text
  ),
  private.bff_hide_message_for_me_impl(
    uuid, uuid, uuid, uuid, bigint, text, text
  ),
  private.bff_mark_message_receipt_impl(
    uuid, uuid, uuid, uuid, bigint, text, text, text
  )
to service_role;

revoke execute on function
  public.bff_save_dynamic_group_policy_v2(
    uuid, uuid, uuid, uuid, uuid, integer, jsonb, integer, text, text
  ),
  public.bff_preview_dynamic_group_v2(
    uuid, uuid, uuid, uuid, integer, integer
  ),
  public.bff_publish_dynamic_group_policy(
    uuid, uuid, uuid, uuid, integer, text, text, text
  ),
  public.bff_pause_dynamic_group_policy(
    uuid, uuid, uuid, uuid, integer, text, text, text
  ),
  public.bff_process_dynamic_group_boundaries(integer),
  public.bff_process_dynamic_group_reconciliation(integer, integer)
from public, anon, authenticated;
grant execute on function
  public.bff_save_dynamic_group_policy_v2(
    uuid, uuid, uuid, uuid, uuid, integer, jsonb, integer, text, text
  ),
  public.bff_preview_dynamic_group_v2(
    uuid, uuid, uuid, uuid, integer, integer
  ),
  public.bff_publish_dynamic_group_policy(
    uuid, uuid, uuid, uuid, integer, text, text, text
  ),
  public.bff_pause_dynamic_group_policy(
    uuid, uuid, uuid, uuid, integer, text, text, text
  ),
  public.bff_process_dynamic_group_boundaries(integer),
  public.bff_process_dynamic_group_reconciliation(integer, integer)
to service_role;

comment on table public.dynamic_group_policy_versions is
  'Immutable normalized policy publications with selector and source-state fingerprints.';
comment on table private.dynamic_group_access_intervals is
  'Monotonic explicit history grants. Current access is always re-evaluated from authoritative sources.';
comment on table private.dynamic_group_policy_source_boundaries is
  'Durable broad-source cutoffs retained until bounded reconciliation completes.';
comment on function public.bff_publish_dynamic_group_policy(
  uuid, uuid, uuid, uuid, integer, text, text, text
) is 'CAS publish requiring a fresh exact preview fingerprint; materializes only an access cache.';
comment on function public.bff_pause_dynamic_group_policy(
  uuid, uuid, uuid, uuid, integer, text, text, text
) is 'AAL2 CAS pause that closes every open policy interval and invalidates posting immediately.';

commit;
