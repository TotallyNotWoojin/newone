begin;

-- Official updates carry one typed, server-normalized audience policy. Legacy
-- rows retain their conversation-member scope; every new authoring surface
-- sends an explicit company or organizational-unit selector.
alter table public.announcements
  add column audience_spec jsonb not null default '{"company":false,"conversation_members":true,"site_ids":[],"department_ids":[],"team_ids":[],"unit_ids":[],"roles":[],"membership_roles":[],"languages":[],"current_shift_only":false}'::jsonb,
  add column audience_snapshotted_at timestamptz;

alter table public.announcements
  add constraint announcements_audience_spec_bounded
  check (jsonb_typeof(audience_spec) = 'object' and octet_length(audience_spec::text) <= 16384);

alter table public.announcement_recipients
  add column audience_snapshot jsonb not null default '{}'::jsonb;

alter table public.announcement_recipients
  add constraint announcement_recipients_audience_snapshot_bounded
  check (jsonb_typeof(audience_snapshot) = 'object' and octet_length(audience_snapshot::text) <= 16384);

create index shift_assignments_org_user_current_idx
  on public.shift_assignments (organization_id, user_id, starts_at, ends_at)
  where status = 'assigned';

create or replace function private.normalize_announcement_audience_spec(p_spec jsonb)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_company boolean;
  v_conversation boolean;
  v_current_shift boolean;
  v_site_ids uuid[];
  v_department_ids uuid[];
  v_team_ids uuid[];
  v_unit_ids uuid[];
  v_roles text[];
  v_membership_roles text[];
  v_languages text[];
begin
  if p_spec is null or jsonb_typeof(p_spec) <> 'object'
    or octet_length(p_spec::text) > 16384
    or exists (
      select 1
      from jsonb_object_keys(p_spec) key
      where key not in (
        'company', 'conversation_members', 'site_ids', 'department_ids',
        'team_ids', 'unit_ids', 'roles', 'membership_roles', 'languages',
        'current_shift_only'
      )
    ) then
    raise exception 'invalid announcement audience selector' using errcode = '22023';
  end if;

  if (p_spec ? 'company' and jsonb_typeof(p_spec -> 'company') <> 'boolean')
    or (p_spec ? 'conversation_members'
      and jsonb_typeof(p_spec -> 'conversation_members') <> 'boolean')
    or (p_spec ? 'current_shift_only'
      and jsonb_typeof(p_spec -> 'current_shift_only') <> 'boolean') then
    raise exception 'invalid announcement audience selector' using errcode = '22023';
  end if;
  v_company := coalesce((p_spec ->> 'company')::boolean, false);
  v_conversation := coalesce((p_spec ->> 'conversation_members')::boolean, false);
  v_current_shift := coalesce((p_spec ->> 'current_shift_only')::boolean, false);

  if exists (
    select 1 from (values
      ('site_ids'), ('department_ids'), ('team_ids'), ('unit_ids'),
      ('roles'), ('membership_roles'), ('languages')
    ) expected(key)
    where p_spec ? expected.key and jsonb_typeof(p_spec -> expected.key) <> 'array'
  ) then
    raise exception 'invalid announcement audience selector' using errcode = '22023';
  end if;
  if exists (
    select 1 from (values
      ('site_ids'), ('department_ids'), ('team_ids'), ('unit_ids'),
      ('roles'), ('membership_roles'), ('languages')
    ) expected(key)
    cross join lateral jsonb_array_elements(coalesce(p_spec -> expected.key, '[]'::jsonb)) item(value)
    where jsonb_typeof(item.value) <> 'string'
  ) then
    raise exception 'invalid announcement audience selector' using errcode = '22023';
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
    into v_unit_ids
  from jsonb_array_elements_text(coalesce(p_spec -> 'unit_ids', '[]'::jsonb)) item(value);
  select coalesce(array_agg(distinct lower(btrim(value)) order by lower(btrim(value))), '{}'::text[])
    into v_roles
  from jsonb_array_elements_text(coalesce(p_spec -> 'roles', '[]'::jsonb)) item(value);
  select coalesce(array_agg(distinct lower(value) order by lower(value)), '{}'::text[])
    into v_membership_roles
  from jsonb_array_elements_text(
    coalesce(p_spec -> 'membership_roles', '[]'::jsonb)
  ) item(value);
  select coalesce(array_agg(distinct lower(value) order by lower(value)), '{}'::text[])
    into v_languages
  from jsonb_array_elements_text(coalesce(p_spec -> 'languages', '[]'::jsonb)) item(value);

  if cardinality(v_site_ids) > 100 or cardinality(v_department_ids) > 100
    or cardinality(v_team_ids) > 100 or cardinality(v_unit_ids) > 100
    or cardinality(v_roles) > 50 or cardinality(v_membership_roles) > 4
    or cardinality(v_languages) > 20
    or exists (
      select 1 from unnest(v_roles) role_name
      where char_length(role_name) not between 1 and 160
    )
    or not v_membership_roles <@ array['owner', 'admin', 'manager', 'member']::text[]
    or exists (
      select 1 from unnest(v_languages) language
      where char_length(language) not between 2 and 35
        or language !~ '^[a-z]{2,3}(-[a-z0-9]{2,8})*$'
    )
    or (v_company and (v_conversation
      or cardinality(v_site_ids) + cardinality(v_department_ids)
        + cardinality(v_team_ids) + cardinality(v_unit_ids) > 0))
    or (v_conversation and cardinality(v_site_ids) + cardinality(v_department_ids)
        + cardinality(v_team_ids) + cardinality(v_unit_ids) > 0)
    or (not v_company and not v_conversation
      and cardinality(v_site_ids) + cardinality(v_department_ids)
        + cardinality(v_team_ids) + cardinality(v_unit_ids) = 0) then
    raise exception 'invalid announcement audience selector' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'company', v_company,
    'conversation_members', v_conversation,
    'site_ids', to_jsonb(v_site_ids),
    'department_ids', to_jsonb(v_department_ids),
    'team_ids', to_jsonb(v_team_ids),
    'unit_ids', to_jsonb(v_unit_ids),
    'roles', to_jsonb(v_roles),
    'membership_roles', to_jsonb(v_membership_roles),
    'languages', to_jsonb(v_languages),
    'current_shift_only', v_current_shift
  );
exception
  when invalid_text_representation then
    raise exception 'invalid announcement audience selector' using errcode = '22023';
end;
$$;

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

create or replace function private.assert_announcement_audience_authorized(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid,
  p_spec jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_spec jsonb := private.normalize_announcement_audience_spec(p_spec);
begin
  if not exists (
    select 1
    from public.conversations conversation
    join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind = 'announcement'
      and not conversation.is_archived
  ) or not private.announcement_audience_spec_is_live(p_organization_id, v_spec) then
    raise exception 'announcement audience is not permitted' using errcode = '42501';
  end if;

  if ((v_spec ->> 'company')::boolean
      or (v_spec ->> 'conversation_members')::boolean)
    and not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'communications.publish', null
    ) then
    raise exception 'announcement audience is not permitted' using errcode = '42501';
  end if;

  if exists (
    select 1
    from (
      select value::uuid as unit_id from jsonb_array_elements_text(v_spec -> 'site_ids')
      union
      select value::uuid from jsonb_array_elements_text(v_spec -> 'department_ids')
      union
      select value::uuid from jsonb_array_elements_text(v_spec -> 'team_ids')
      union
      select value::uuid from jsonb_array_elements_text(v_spec -> 'unit_ids')
    ) selected
    where not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'communications.publish', selected.unit_id
    )
  ) then
    raise exception 'announcement audience is not permitted' using errcode = '42501';
  end if;
  return v_spec;
end;
$$;

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

-- Existing recipients predate dimensional authoring. Mark those rows as an
-- explicit compatibility backfill before enforcing snapshot immutability.
update public.announcements announcement
set audience_snapshotted_at = coalesce(announcement.published_at, announcement.created_at)
where announcement.status in ('published', 'archived')
  and announcement.audience_snapshotted_at is null;

update public.announcement_recipients recipient
set audience_snapshot = jsonb_build_object(
  'schema_version', 1,
  'legacy_backfill', true,
  'evaluated_at', announcement.audience_snapshotted_at,
  'membership_role', (
    select membership.role
    from public.organization_memberships membership
    where membership.organization_id = recipient.organization_id
      and membership.user_id = recipient.user_id
  ),
  'preferred_language', (
    select lower(coalesce(preference.message_language, profile.preferred_language))
    from public.profiles profile
    left join public.organization_user_preferences preference
      on preference.organization_id = recipient.organization_id
     and preference.user_id = profile.user_id
    where profile.user_id = recipient.user_id
  ),
  'unit_ids', (
    select coalesce(jsonb_agg(unit_member.unit_id order by unit_member.unit_id), '[]'::jsonb)
    from public.organization_unit_members unit_member
    where unit_member.organization_id = recipient.organization_id
      and unit_member.user_id = recipient.user_id
  ),
  'current_shift_assignment_ids', '[]'::jsonb
)
from public.announcements announcement
where announcement.organization_id = recipient.organization_id
  and announcement.id = recipient.announcement_id
  and recipient.audience_snapshot = '{}'::jsonb;

create or replace function private.bind_announcement_audience_spec()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_context text := nullif(current_setting('app.announcement_audience_spec', true), '');
begin
  if tg_op = 'INSERT' then
    new.audience_spec := private.normalize_announcement_audience_spec(
      case when v_context is null then new.audience_spec else v_context::jsonb end
    );
    new.audience_snapshotted_at := case
      when new.status = 'published' then coalesce(new.published_at, now())
      else null
    end;
    return new;
  end if;

  if new.audience_spec is distinct from old.audience_spec then
    raise exception 'announcement audience selector is immutable' using errcode = '22000';
  end if;
  if old.status = 'scheduled' and new.status = 'published'
    and old.audience_snapshotted_at is null then
    new.audience_snapshotted_at := coalesce(new.published_at, now());
  elsif new.audience_snapshotted_at is distinct from old.audience_snapshotted_at then
    raise exception 'announcement audience snapshot time is immutable' using errcode = '22000';
  end if;
  return new;
exception when invalid_text_representation then
  raise exception 'invalid announcement audience selector' using errcode = '22023';
end;
$$;

create trigger announcements_05_bind_audience_spec
before insert or update on public.announcements
for each row execute function private.bind_announcement_audience_spec();

create or replace function private.snapshot_announcement_audience_internal(
  p_organization_id uuid,
  p_announcement_id uuid,
  p_conversation_id uuid,
  p_spec jsonb,
  p_evaluated_at timestamptz
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_evaluated_at is null or not isfinite(p_evaluated_at)
    or not private.announcement_audience_spec_is_live(p_organization_id, p_spec) then
    raise exception 'announcement audience cannot be snapshotted' using errcode = '42501';
  end if;
  insert into public.announcement_recipients (
    organization_id, announcement_id, user_id, audience_snapshot
  )
  select p_organization_id, p_announcement_id,
    candidate.user_id, candidate.audience_snapshot
  from private.announcement_audience_candidates(
    p_organization_id, p_conversation_id, p_spec, p_evaluated_at
  ) candidate
  on conflict (organization_id, announcement_id, user_id) do nothing;

  select count(*)::integer into v_count
  from public.announcement_recipients recipient
  where recipient.organization_id = p_organization_id
    and recipient.announcement_id = p_announcement_id;
  if v_count = 0 then
    raise exception 'announcement audience resolved to no active recipients'
      using errcode = '22023';
  end if;
  return v_count;
end;
$$;

create or replace function private.snapshot_announcement_recipients()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is not null and v_actor_id <> new.created_by_user_id then
    raise exception 'announcement creator does not match request user' using errcode = '42501';
  end if;
  if v_actor_id is null and v_jwt_role not in ('', 'service_role') then
    raise exception 'announcement recipient snapshot is not authorized' using errcode = '42501';
  end if;
  if new.status = 'published' then
    perform private.snapshot_announcement_audience_internal(
      new.organization_id, new.id, new.conversation_id,
      new.audience_spec, new.audience_snapshotted_at
    );
  end if;
  return new;
end;
$$;

create or replace function private.validate_announcement_recipient_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if new.organization_id is distinct from old.organization_id
    or new.announcement_id is distinct from old.announcement_id
    or new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at
    or new.audience_snapshot is distinct from old.audience_snapshot then
    raise exception 'announcement recipient identity and audience snapshot are immutable'
      using errcode = '22000';
  end if;
  if v_actor_id is not null then
    if new.user_id <> v_actor_id then
      raise exception 'recipients may update only their own state' using errcode = '42501';
    end if;
    if new.delivered_at is distinct from old.delivered_at then
      raise exception 'delivery timestamps are assigned by the trusted delivery service'
        using errcode = '42501';
    end if;
    if new.read_at is distinct from old.read_at then
      if old.read_at is not null or new.read_at is null then
        raise exception 'read state cannot move backwards' using errcode = '22000';
      end if;
      new.read_at := now();
      new.delivered_at := coalesce(old.delivered_at, new.read_at);
    end if;
  elsif v_jwt_role <> 'service_role' then
    raise exception 'announcement recipient update is not authorized' using errcode = '42501';
  end if;
  if old.delivered_at is not null and new.delivered_at is null then
    raise exception 'delivery state cannot move backwards' using errcode = '22000';
  end if;
  if old.read_at is not null and new.read_at is null then
    raise exception 'read state cannot move backwards' using errcode = '22000';
  end if;
  if new.read_at is not null then
    new.delivered_at := coalesce(new.delivered_at, new.read_at);
  end if;
  return new;
end;
$$;

create or replace function private.bff_create_targeted_announcement_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_language_code text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_scheduled_at timestamptz,
  p_acknowledgement_schema jsonb,
  p_notification_class text,
  p_critical_category text,
  p_quiet_hours_override_reason text,
  p_reminder_policy jsonb,
  p_audience_spec jsonb,
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
  v_spec jsonb;
  v_response jsonb;
  v_previous_claim_sub text := coalesce(
    current_setting('request.jwt.claim.sub', true), ''
  );
begin
  perform private.require_service_role();
  v_spec := private.assert_announcement_audience_authorized(
    p_actor_user_id, p_organization_id, p_conversation_id, p_audience_spec
  );
  -- The service-role BFF is the only caller of this RPC. Bind the actor already
  -- proven by the session checks to the legacy message primitive for this
  -- transaction, then restore any ambient claim before returning.
  perform set_config('request.jwt.claim.sub', p_actor_user_id::text, true);
  perform set_config('app.announcement_audience_spec', v_spec::text, true);
  v_response := private.bff_create_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_title, p_body, p_language_code, p_priority,
    p_requires_acknowledgement, p_expires_at, p_scheduled_at,
    p_acknowledgement_schema, p_notification_class, p_critical_category,
    p_quiet_hours_override_reason, p_reminder_policy,
    p_idempotency_key, p_request_sha256
  );
  perform set_config('app.announcement_audience_spec', '', true);
  perform set_config('request.jwt.claim.sub', v_previous_claim_sub, true);
  return v_response || jsonb_build_object(
    'audience_spec', v_spec,
    'snapshot_basis', case when p_scheduled_at is null
      then 'active_members_at_publish'
      else 'reevaluated_at_scheduled_publish'
    end
  );
exception when others then
  perform set_config('app.announcement_audience_spec', '', true);
  perform set_config('request.jwt.claim.sub', v_previous_claim_sub, true);
  raise;
end;
$$;

create or replace function private.bff_preview_targeted_announcement_audience_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_audience_spec jsonb,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_spec jsonb;
  v_evaluated_at timestamptz := now();
  v_audience_count integer;
  v_active_count integer;
  v_inactive_count integer;
  v_preview jsonb;
  v_languages jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.preview', true, 900
  );
  if p_limit not between 1 and 200 then
    raise exception 'valid announcement audience preview limit required'
      using errcode = '22023';
  end if;
  v_spec := private.assert_announcement_audience_authorized(
    p_actor_user_id, p_organization_id, p_conversation_id, p_audience_spec
  );

  select count(*) filter (where membership.status = 'active')::integer,
      count(*) filter (where membership.status <> 'active')::integer
    into v_active_count, v_inactive_count
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id;

  select count(*)::integer into v_audience_count
  from private.announcement_audience_candidates(
    p_organization_id, p_conversation_id, v_spec, v_evaluated_at
  );

  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', sample.user_id,
      'display_name', sample.display_name,
      'preferred_language', sample.preferred_language,
      'membership_role', sample.membership_role,
      'unit_ids', to_jsonb(sample.unit_ids),
      'current_shift', cardinality(sample.current_shift_assignment_ids) > 0
    ) order by sample.display_name, sample.user_id), '[]'::jsonb)
    into v_preview
  from (
    select candidate.*
    from private.announcement_audience_candidates(
      p_organization_id, p_conversation_id, v_spec, v_evaluated_at
    ) candidate
    order by candidate.display_name, candidate.user_id
    limit p_limit
  ) sample;

  select coalesce(jsonb_agg(language order by language), '[]'::jsonb)
    into v_languages
  from (
    select distinct candidate.preferred_language as language
    from private.announcement_audience_candidates(
      p_organization_id, p_conversation_id, v_spec, v_evaluated_at
    ) candidate
  ) languages;

  return jsonb_build_object(
    'conversation_id', p_conversation_id,
    'audience_spec', v_spec,
    'total_count', v_audience_count,
    'preview', v_preview,
    'excluded_count', greatest(v_active_count - v_audience_count, 0) + v_inactive_count,
    'exclusion_counts', jsonb_build_object(
      'inactive_members', v_inactive_count,
      'selector_mismatch', greatest(v_active_count - v_audience_count, 0)
    ),
    'notification_languages', v_languages,
    'snapshot_basis', case when (v_spec ->> 'current_shift_only')::boolean
      then 'active_members_and_current_shift_at_publish'
      else 'active_members_at_publish'
    end,
    'generated_at', v_evaluated_at,
    'reconcile_after', v_evaluated_at
  );
end;
$$;

create or replace function public.bff_create_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_language_code text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_scheduled_at timestamptz,
  p_acknowledgement_schema jsonb,
  p_notification_class text,
  p_critical_category text,
  p_quiet_hours_override_reason text,
  p_reminder_policy jsonb,
  p_audience_spec jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_targeted_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_title, p_body, p_language_code, p_priority,
    p_requires_acknowledgement, p_expires_at, p_scheduled_at,
    p_acknowledgement_schema, p_notification_class, p_critical_category,
    p_quiet_hours_override_reason, p_reminder_policy, p_audience_spec,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_preview_announcement_audience(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_audience_spec jsonb,
  p_limit integer default 25
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_preview_targeted_announcement_audience_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_audience_spec, p_limit
  )
$$;

create or replace function private.bff_promote_due_announcements_impl(
  p_worker_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_announcement record;
  v_version record;
  v_evaluated_at timestamptz;
  v_candidate_count integer;
  v_recipient_count integer;
  v_ids uuid[] := array[]::uuid[];
  v_blocked_ids uuid[] := array[]::uuid[];
  v_promoted integer := 0;
begin
  perform private.require_service_role();
  if p_worker_id is null or p_limit not between 1 and 200 then
    raise exception 'valid scheduler worker and limit required' using errcode = '22023';
  end if;
  for v_announcement in
    select announcement.*
    from public.announcements announcement
    where announcement.status = 'scheduled'
      and announcement.scheduled_at <= now()
      and (announcement.expires_at is null or announcement.expires_at > now())
    order by announcement.scheduled_at, announcement.id
    limit p_limit
    for update skip locked
  loop
    v_evaluated_at := clock_timestamp();
    if not private.announcement_audience_spec_is_live(
      v_announcement.organization_id, v_announcement.audience_spec
    ) or not exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = v_announcement.organization_id
        and conversation.id = v_announcement.conversation_id
        and conversation.kind = 'announcement'
        and not conversation.is_archived
    ) then
      v_blocked_ids := array_append(v_blocked_ids, v_announcement.id);
      continue;
    end if;

    select count(*)::integer into v_candidate_count
    from private.announcement_audience_candidates(
      v_announcement.organization_id, v_announcement.conversation_id,
      v_announcement.audience_spec, v_evaluated_at
    );
    if v_candidate_count = 0 then
      v_blocked_ids := array_append(v_blocked_ids, v_announcement.id);
      continue;
    end if;

    update public.announcements announcement
    set status = 'published', published_at = v_evaluated_at
    where announcement.organization_id = v_announcement.organization_id
      and announcement.id = v_announcement.id
      and announcement.status = 'scheduled';
    if not found then continue; end if;

    v_recipient_count := private.snapshot_announcement_audience_internal(
      v_announcement.organization_id, v_announcement.id,
      v_announcement.conversation_id, v_announcement.audience_spec,
      v_evaluated_at
    );

    select version.* into v_version
    from public.announcement_versions version
    where version.organization_id = v_announcement.organization_id
      and version.announcement_id = v_announcement.id
    order by version.version_number desc
    limit 1;
    perform private.enqueue_outbox_job_internal(
      v_announcement.organization_id, 'push',
      'announcement:' || v_announcement.id::text || ':published',
      jsonb_build_object(
        'organization_id', v_announcement.organization_id,
        'conversation_id', v_announcement.conversation_id,
        'announcement_id', v_announcement.id,
        'announcement_version_id', v_version.id,
        'message_id', v_version.message_id,
        'state', 'published',
        'notification_class', v_version.notification_class,
        'critical_category', v_version.critical_category,
        'quiet_hours_override_reason', v_version.quiet_hours_override_reason,
        'scheduler_worker_id', p_worker_id,
        'audience_count', v_recipient_count,
        'audience_spec_sha256', encode(extensions.digest(
          convert_to(v_announcement.audience_spec::text, 'UTF8'), 'sha256'
        ), 'hex')
      )
    );
    v_ids := array_append(v_ids, v_announcement.id);
    v_promoted := v_promoted + 1;
  end loop;
  return jsonb_build_object(
    'processed', v_promoted + cardinality(v_blocked_ids),
    'promoted', v_promoted,
    'blocked', cardinality(v_blocked_ids),
    'announcement_ids', to_jsonb(v_ids),
    'blocked_announcement_ids', to_jsonb(v_blocked_ids),
    'snapshot_basis', 'reevaluated_at_scheduled_publish'
  );
end;
$$;

-- Signature-compatible service wrappers preserve deployed workers and older
-- clients while routing them through the same validated legacy conversation
-- scope. The new Edge contract always supplies an explicit dimensional spec.
create or replace function public.bff_create_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_language_code text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_scheduled_at timestamptz,
  p_acknowledgement_schema jsonb,
  p_notification_class text,
  p_critical_category text,
  p_quiet_hours_override_reason text,
  p_reminder_policy jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_targeted_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_title, p_body, p_language_code, p_priority,
    p_requires_acknowledgement, p_expires_at, p_scheduled_at,
    p_acknowledgement_schema, p_notification_class, p_critical_category,
    p_quiet_hours_override_reason, p_reminder_policy,
    '{"company":false,"conversation_members":true,"site_ids":[],"department_ids":[],"team_ids":[],"unit_ids":[],"roles":[],"membership_roles":[],"languages":[],"current_shift_only":false}'::jsonb,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_preview_announcement_audience(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_limit integer default 25
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_preview_targeted_announcement_audience_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    '{"company":false,"conversation_members":true,"site_ids":[],"department_ids":[],"team_ids":[],"unit_ids":[],"roles":[],"membership_roles":[],"languages":[],"current_shift_only":false}'::jsonb,
    p_limit
  )
$$;

create or replace function public.bff_publish_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_language_code text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_targeted_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_title, p_body, p_language_code, p_priority,
    p_requires_acknowledgement, p_expires_at, null,
    '{"schema_version":1,"attestation_required":false,"attestation_prompt":null,"required_keys":[],"carry_forward_on_correction":false}'::jsonb,
    private.notification_class_for_priority(p_priority), null, null,
    '{"enabled":false,"deadline_at":null,"interval_seconds":null,"maximum_reminders":0,"escalate_after_seconds":null,"sms_fallback":false}'::jsonb,
    '{"company":false,"conversation_members":true,"site_ids":[],"department_ids":[],"team_ids":[],"unit_ids":[],"roles":[],"membership_roles":[],"languages":[],"current_shift_only":false}'::jsonb,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function public.bff_create_announcement(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, timestamptz, jsonb, text, text, text, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.bff_create_announcement(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, timestamptz, jsonb, text, text, text, jsonb, jsonb, text, text
) to service_role;

revoke all on function public.bff_preview_announcement_audience(
  uuid, uuid, uuid, uuid, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.bff_preview_announcement_audience(
  uuid, uuid, uuid, uuid, jsonb, integer
) to service_role;

revoke all on function public.bff_create_announcement(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, timestamptz, jsonb, text, text, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.bff_create_announcement(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, timestamptz, jsonb, text, text, text, jsonb, text, text
) to service_role;

revoke all on function public.bff_preview_announcement_audience(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.bff_preview_announcement_audience(
  uuid, uuid, uuid, uuid, integer
) to service_role;

revoke all on function public.bff_publish_announcement(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.bff_publish_announcement(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, text, text
) to service_role;

revoke execute on function private.bff_create_targeted_announcement_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, timestamptz, jsonb, text, text, text, jsonb, jsonb, text, text
) from public, anon, authenticated;
grant execute on function private.bff_create_targeted_announcement_impl(
  uuid, uuid, uuid, uuid, uuid, text, text, text, text, boolean,
  timestamptz, timestamptz, jsonb, text, text, text, jsonb, jsonb, text, text
) to service_role;

revoke execute on function private.bff_preview_targeted_announcement_audience_impl(
  uuid, uuid, uuid, uuid, jsonb, integer
) from public, anon, authenticated;
grant execute on function private.bff_preview_targeted_announcement_audience_impl(
  uuid, uuid, uuid, uuid, jsonb, integer
) to service_role;

comment on column public.announcements.audience_spec is
  'Immutable, normalized company or hierarchical unit selector plus operational role, access role, language, and authoritative current-shift filters.';
comment on column public.announcement_recipients.audience_snapshot is
  'Immutable publish-time membership, operational context, language, unit, shift, and selector fingerprint evidence.';
comment on function public.bff_preview_announcement_audience(uuid, uuid, uuid, uuid, jsonb, integer) is
  'Service-only authorized dimensional audience preview; snapshots are created only at actual publication.';

commit;
