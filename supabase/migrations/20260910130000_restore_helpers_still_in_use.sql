-- Restore ten helpers that the previous migration dropped in error.
--
-- 20260910120000 matched them on name and treated them as workplace leaves,
-- but each is reachable from a function that survives. The dynamic_group
-- ones sit under the attachment and media download authorization checks, so
-- their absence surfaced immediately as a 503 on every download grant:
--
--   dynamic_group_candidate_membership_allowed <- dynamic_group_conversation_access_allowed_for_user,
--                                                 dynamic_group_timestamp_access_allowed,
--                                                 dynamic_group_user_currently_eligible
--   dynamic_group_user_eligible_for_spec       <- dynamic_group_user_currently_eligible
--   reconcile_dynamic_group_user_internal      <- enqueue_dynamic_group_user_source_change_internal
--   announcement_audience_candidates           <- snapshot_announcement_audience_internal
--   announcement_audience_spec_is_live         <- snapshot_announcement_audience_internal
--
-- plus everything those five call in turn.
--
-- Restored verbatim from the migrations that last defined each one. Bodies
-- are not checked while they load, because they reference each other and a
-- single ordering that satisfies every pair does not exist here.

set local check_function_bodies = off;

-- from 20260910130000_restore_helpers_still_in_use.sql
create or replace function private.announcement_audience_candidates(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns table (
  user_id uuid,
  display_name text,
  preferred_language text,
  membership_role text,
  unit_ids uuid[],
  current_shift_assignment_ids uuid[],
  audience_snapshot jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_spec jsonb := private.normalize_announcement_audience_spec(p_spec);
  v_spec_hash text := encode(extensions.digest(
    convert_to(private.normalize_announcement_audience_spec(p_spec)::text, 'UTF8'), 'sha256'
  ), 'hex');
begin
  if p_evaluated_at is null or not isfinite(p_evaluated_at) then
    raise exception 'finite audience evaluation time required' using errcode = '22023';
  end if;
  return query
  select membership.user_id,
    profile.display_name,
    lower(coalesce(preference.message_language, profile.preferred_language)) as preferred_language,
    membership.role,
    coalesce(member_units.ids, '{}'::uuid[]),
    coalesce(current_shifts.ids, '{}'::uuid[]),
    jsonb_build_object(
      'schema_version', 1,
      'evaluated_at', p_evaluated_at,
      'audience_spec_sha256', v_spec_hash,
      'membership_role', membership.role,
      'job_title', membership.job_title,
      'configured_role_names', to_jsonb(coalesce(configured_roles.names, '{}'::text[])),
      'preferred_language', lower(coalesce(
        preference.message_language, profile.preferred_language
      )),
      'unit_ids', to_jsonb(coalesce(member_units.ids, '{}'::uuid[])),
      'current_shift_assignment_ids', to_jsonb(coalesce(current_shifts.ids, '{}'::uuid[]))
    )
  from public.organization_memberships membership
  join public.profiles profile on profile.user_id = membership.user_id
  left join public.organization_user_preferences preference
    on preference.organization_id = membership.organization_id
   and preference.user_id = membership.user_id
  left join lateral (
    select array_agg(unit_member.unit_id order by unit_member.unit_id) as ids
    from public.organization_unit_members unit_member
    join public.organization_units unit
      on unit.organization_id = unit_member.organization_id
     and unit.id = unit_member.unit_id and unit.is_active
    where unit_member.organization_id = membership.organization_id
      and unit_member.user_id = membership.user_id
  ) member_units on true
  left join lateral (
    select array_agg(assignment.id order by assignment.id) as ids
    from public.shift_assignments assignment
    where assignment.organization_id = membership.organization_id
      and assignment.user_id = membership.user_id
      and assignment.status = 'assigned'
      and assignment.starts_at <= p_evaluated_at
      and assignment.ends_at > p_evaluated_at
  ) current_shifts on true
  left join lateral (
    select array_agg(distinct lower(assignment.role_name) order by lower(assignment.role_name)) as names
    from public.organization_role_assignments assignment
    where assignment.organization_id = membership.organization_id
      and assignment.user_id = membership.user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > p_evaluated_at)
  ) configured_roles on true
  where membership.organization_id = p_organization_id
    and membership.status = 'active'
    and (
      (v_spec ->> 'company')::boolean
      or ((v_spec ->> 'conversation_members')::boolean and exists (
        select 1 from public.conversation_members conversation_member
        where conversation_member.organization_id = membership.organization_id
          and conversation_member.conversation_id = p_conversation_id
          and conversation_member.user_id = membership.user_id
          and conversation_member.status = 'active'
      ))
      or exists (
        with recursive selected_units(id) as (
          select roots.id
          from (
            select value::uuid as id from jsonb_array_elements_text(v_spec -> 'site_ids')
            union
            select value::uuid from jsonb_array_elements_text(v_spec -> 'department_ids')
            union
            select value::uuid from jsonb_array_elements_text(v_spec -> 'team_ids')
            union
            select value::uuid from jsonb_array_elements_text(v_spec -> 'unit_ids')
          ) roots
          union
          select child.id
          from public.organization_units child
          join selected_units parent on child.parent_unit_id = parent.id
          where child.organization_id = p_organization_id and child.is_active
        )
        select 1
        from public.organization_unit_members selected_membership
        join public.organization_units selected_unit
          on selected_unit.organization_id = selected_membership.organization_id
         and selected_unit.id = selected_membership.unit_id
         and selected_unit.is_active
        where selected_membership.organization_id = membership.organization_id
          and selected_membership.user_id = membership.user_id
          and selected_unit.id in (select id from selected_units)
      )
    )
    and (jsonb_array_length(v_spec -> 'membership_roles') = 0 or exists (
      select 1
      from jsonb_array_elements_text(v_spec -> 'membership_roles') selected(role_name)
      where selected.role_name = membership.role
    ))
    and (jsonb_array_length(v_spec -> 'roles') = 0 or exists (
      select 1
      from jsonb_array_elements_text(v_spec -> 'roles') selected(role_name)
      where selected.role_name = lower(btrim(coalesce(membership.job_title, '')))
        or selected.role_name = any(coalesce(configured_roles.names, '{}'::text[]))
    ))
    and (jsonb_array_length(v_spec -> 'languages') = 0 or exists (
      select 1 from jsonb_array_elements_text(v_spec -> 'languages') selected(language)
      where selected.language = lower(coalesce(
        preference.message_language, profile.preferred_language
      ))
    ))
    and (not (v_spec ->> 'current_shift_only')::boolean
      or cardinality(coalesce(current_shifts.ids, '{}'::uuid[])) > 0)
  order by profile.display_name, membership.user_id;
end;
$$;

-- from 20260910130000_restore_helpers_still_in_use.sql
create or replace function private.announcement_audience_spec_is_live(
  p_organization_id uuid,
  p_spec jsonb
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_spec jsonb;
begin
  v_spec := private.normalize_announcement_audience_spec(p_spec);
  if (v_spec ->> 'current_shift_only')::boolean and not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.shift_schedule_authoritative
  ) then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'site_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.kind = 'site' and unit.is_active
    )
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'department_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.kind = 'department' and unit.is_active
    )
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'team_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.kind = 'team' and unit.is_active
    )
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'unit_ids') selected(id)
    where not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id
        and unit.id = selected.id::uuid and unit.is_active
    )
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'roles') selected(role_name)
    where not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.status = 'active'
        and lower(btrim(coalesce(membership.job_title, ''))) = selected.role_name
    ) and not exists (
      select 1
      from public.organization_role_assignments assignment
      where assignment.organization_id = p_organization_id
        and assignment.revoked_at is null
        and (assignment.expires_at is null or assignment.expires_at > now())
        and lower(assignment.role_name) = selected.role_name
    )
  ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

-- from 20260910130000_restore_helpers_still_in_use.sql
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

-- from 20260804172200_complete_group_creation.sql
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

-- from 20260804171845_complete_policy_managed_team_groups.sql
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

-- from 20260804171845_complete_policy_managed_team_groups.sql
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

-- from 20260804171845_complete_policy_managed_team_groups.sql
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

-- from 20260910130000_restore_helpers_still_in_use.sql
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

-- from 20260804171845_complete_policy_managed_team_groups.sql
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

-- from 20260910130000_restore_helpers_still_in_use.sql
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
