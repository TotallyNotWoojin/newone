begin;

-- Moderation is deliberately separate from ordinary organization administration.
-- A case manager can assign a case without receiving its evidence, and an
-- investigator can read evidence only after an explicit assignment or a
-- self-claim backed by an active, scope-compatible designated-investigator grant.
insert into public.organization_role_permissions (role_name, permission)
values ('security_admin', 'reports.assign')
on conflict do nothing;

alter table private.message_reports
  drop constraint if exists message_reports_status_allowed;

do $$
begin
  if exists (select 1 from private.message_reports) then
    raise exception 'legacy moderation reports require an explicit consent-preserving evidence migration';
  end if;
end;
$$;

alter table private.message_reports
  add column if not exists subject_user_id uuid,
  add column if not exists conversation_unit_id uuid,
  add column if not exists reporter_notice_version text,
  add column if not exists reporter_consent_at timestamptz,
  add column if not exists context_before_count integer not null default 0,
  add column if not exists context_after_count integer not null default 0,
  add column if not exists assigned_investigator_user_id uuid,
  add column if not exists assigned_by_user_id uuid,
  add column if not exists assigned_at timestamptz,
  add column if not exists assignment_reason text,
  add column if not exists closed_by_user_id uuid,
  add column if not exists closed_at timestamptz,
  add column if not exists resolution_reason text,
  add column if not exists resolution_evidence_metadata jsonb,
  add column if not exists record_version integer not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table private.message_reports
  alter column subject_user_id set not null,
  alter column reporter_notice_version set not null,
  alter column reporter_consent_at set not null,
  add constraint message_reports_organization_id_id_unique unique (organization_id, id),
  add constraint message_reports_status_allowed
    check (status in ('open', 'assigned', 'in_review', 'resolved', 'dismissed')),
  add constraint message_reports_subject_membership_fkey
    foreign key (organization_id, subject_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  add constraint message_reports_unit_fkey
    foreign key (organization_id, conversation_unit_id)
    references public.organization_units (organization_id, id) on delete restrict,
  add constraint message_reports_assigned_investigator_fkey
    foreign key (organization_id, assigned_investigator_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  add constraint message_reports_assigned_by_fkey
    foreign key (organization_id, assigned_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  add constraint message_reports_closed_by_fkey
    foreign key (organization_id, closed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  add constraint message_reports_notice_version_length
    check (char_length(reporter_notice_version) between 3 and 80),
  add constraint message_reports_context_bounds
    check (context_before_count between 0 and 2 and context_after_count between 0 and 2),
  add constraint message_reports_assignment_reason_length
    check (assignment_reason is null or char_length(btrim(assignment_reason)) between 3 and 1000),
  add constraint message_reports_resolution_reason_length
    check (resolution_reason is null or char_length(btrim(resolution_reason)) between 3 and 2000),
  add constraint message_reports_record_version_positive
    check (record_version > 0),
  add constraint message_reports_case_separation check (
    reporter_user_id <> subject_user_id
    and (assigned_investigator_user_id is null or (
      assigned_investigator_user_id <> reporter_user_id
      and assigned_investigator_user_id <> subject_user_id
    ))
    and (assigned_by_user_id is null or (
      assigned_by_user_id <> reporter_user_id
      and assigned_by_user_id <> subject_user_id
    ))
    and (closed_by_user_id is null or (
      closed_by_user_id <> reporter_user_id
      and closed_by_user_id <> subject_user_id
    ))
  ),
  add constraint message_reports_assignment_consistent check (
    (status = 'open'
      and assigned_investigator_user_id is null
      and assigned_by_user_id is null
      and assigned_at is null
      and assignment_reason is null)
    or (status in ('assigned', 'in_review', 'resolved', 'dismissed')
      and assigned_investigator_user_id is not null
      and assigned_by_user_id is not null
      and assigned_at is not null
      and assignment_reason is not null)
  ),
  add constraint message_reports_closure_consistent check (
    (status in ('open', 'assigned', 'in_review')
      and closed_by_user_id is null
      and closed_at is null
      and resolution_reason is null
      and resolution_evidence_metadata is null)
    or (status in ('resolved', 'dismissed')
      and closed_by_user_id is not null
      and closed_at is not null
      and resolution_reason is not null
      and resolution_evidence_metadata is not null)
  );

create table private.moderation_case_evidence (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  case_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  relationship text not null,
  relative_position integer not null,
  sender_user_id uuid not null,
  message_kind text not null,
  message_body text,
  message_created_at timestamptz not null,
  body_sha256 bytea not null,
  captured_at timestamptz not null default now(),
  unique (organization_id, case_id, relative_position),
  unique (organization_id, case_id, message_id),
  foreign key (organization_id, case_id)
    references private.message_reports (organization_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, sender_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint moderation_case_evidence_relationship_allowed
    check (relationship in ('reported', 'context_before', 'context_after')),
  constraint moderation_case_evidence_position_consistent check (
    (relationship = 'reported' and relative_position = 0)
    or (relationship = 'context_before' and relative_position between -2 and -1)
    or (relationship = 'context_after' and relative_position between 1 and 2)
  ),
  constraint moderation_case_evidence_kind_length
    check (char_length(message_kind) between 1 and 40),
  constraint moderation_case_evidence_body_length
    check (message_body is null or char_length(message_body) <= 20000),
  constraint moderation_case_evidence_hash_length
    check (octet_length(body_sha256) = 32)
);

create table private.moderation_case_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  case_id uuid not null,
  actor_user_id uuid not null,
  event_type text not null,
  from_status text,
  to_status text,
  reason text,
  evidence_metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, case_id)
    references private.message_reports (organization_id, id) on delete restrict,
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint moderation_case_history_event_allowed check (
    event_type in ('reported', 'assigned', 'reassigned', 'claimed', 'accessed',
      'review_started', 'resolved', 'dismissed')
  ),
  constraint moderation_case_history_status_allowed check (
    (from_status is null or from_status in ('open', 'assigned', 'in_review', 'resolved', 'dismissed'))
    and (to_status is null or to_status in ('open', 'assigned', 'in_review', 'resolved', 'dismissed'))
  ),
  constraint moderation_case_history_reason_length
    check (reason is null or char_length(btrim(reason)) between 3 and 2000),
  constraint moderation_case_history_metadata_bounds
    check (jsonb_typeof(evidence_metadata) = 'object'
      and octet_length(evidence_metadata::text) <= 8192)
);

create unique index moderation_case_evidence_reported_unique_idx
  on private.moderation_case_evidence (organization_id, case_id)
  where relationship = 'reported';
create index moderation_case_evidence_case_order_idx
  on private.moderation_case_evidence (organization_id, case_id, relative_position);
create index moderation_case_evidence_message_fk_idx
  on private.moderation_case_evidence (organization_id, conversation_id, message_id);
create index moderation_case_evidence_sender_fk_idx
  on private.moderation_case_evidence (organization_id, sender_user_id);
create index moderation_case_history_case_cursor_idx
  on private.moderation_case_history (organization_id, case_id, occurred_at, id);
create index moderation_case_history_actor_idx
  on private.moderation_case_history (organization_id, actor_user_id, occurred_at desc);
create index message_reports_assignee_status_cursor_idx
  on private.message_reports (
    organization_id, assigned_investigator_user_id, status, updated_at desc, id desc
  ) where assigned_investigator_user_id is not null;
create index message_reports_unit_status_cursor_idx
  on private.message_reports (organization_id, conversation_unit_id, status, updated_at desc, id desc);
create index message_reports_subject_idx
  on private.message_reports (organization_id, subject_user_id, created_at desc);
create index message_reports_assigned_by_idx
  on private.message_reports (organization_id, assigned_by_user_id, assigned_at desc)
  where assigned_by_user_id is not null;
create index message_reports_closed_by_idx
  on private.message_reports (organization_id, closed_by_user_id, closed_at desc)
  where closed_by_user_id is not null;

alter table private.message_reports enable row level security;
alter table private.message_reports force row level security;
alter table private.moderation_case_evidence enable row level security;
alter table private.moderation_case_evidence force row level security;
alter table private.moderation_case_history enable row level security;
alter table private.moderation_case_history force row level security;

create or replace function private.prevent_moderation_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'moderation evidence and case history are append-only' using errcode = '55000';
end;
$$;

create or replace function private.enforce_moderation_case_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'moderation case records cannot be deleted' using errcode = '55000';
  end if;
  if old.status in ('resolved', 'dismissed') then
    raise exception 'closed moderation case records are read-only' using errcode = '55000';
  end if;
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.message_id is distinct from old.message_id
    or new.reporter_user_id is distinct from old.reporter_user_id
    or new.subject_user_id is distinct from old.subject_user_id
    or new.conversation_unit_id is distinct from old.conversation_unit_id
    or new.category is distinct from old.category
    or new.details is distinct from old.details
    or new.reporter_notice_version is distinct from old.reporter_notice_version
    or new.reporter_consent_at is distinct from old.reporter_consent_at
    or new.context_before_count is distinct from old.context_before_count
    or new.context_after_count is distinct from old.context_after_count
    or new.created_at is distinct from old.created_at then
    raise exception 'moderation case source and consent fields are immutable' using errcode = '55000';
  end if;
  if new.record_version <> old.record_version + 1 or new.updated_at <= old.updated_at then
    raise exception 'moderation case version must advance once per transition' using errcode = '55000';
  end if;
  if not (
    (old.status = 'open' and new.status = 'assigned')
    or (old.status = 'assigned' and new.status = 'assigned'
      and new.assigned_investigator_user_id is distinct from old.assigned_investigator_user_id)
    or (old.status = 'in_review' and new.status = 'assigned'
      and new.assigned_investigator_user_id is distinct from old.assigned_investigator_user_id)
    or (old.status = 'assigned' and new.status = 'in_review')
    or (old.status = 'in_review' and new.status in ('resolved', 'dismissed'))
  ) then
    raise exception 'invalid moderation case transition' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger moderation_case_evidence_immutable
before update or delete on private.moderation_case_evidence
for each row execute function private.prevent_moderation_evidence_mutation();
create trigger moderation_case_history_immutable
before update or delete on private.moderation_case_history
for each row execute function private.prevent_moderation_evidence_mutation();
create trigger moderation_case_lifecycle_guard
before update or delete on private.message_reports
for each row execute function private.enforce_moderation_case_lifecycle();
create trigger audit_moderation_case_history
after insert on private.moderation_case_history
for each row execute function private.write_audit_event('moderation_case_event', 'case_id');

create or replace function private.valid_moderation_evidence_metadata(p_metadata jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_reference jsonb;
begin
  if jsonb_typeof(p_metadata) <> 'object'
    or octet_length(p_metadata::text) > 8192
    or exists (
      select 1 from jsonb_object_keys(p_metadata) key
      where key not in ('reference_ids', 'policy_code', 'severity')
    ) then
    return false;
  end if;
  if p_metadata ? 'policy_code'
    and coalesce(p_metadata ->> 'policy_code', '') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$' then
    return false;
  end if;
  if p_metadata ? 'severity'
    and coalesce(p_metadata ->> 'severity', '') not in ('low', 'medium', 'high', 'critical') then
    return false;
  end if;
  if p_metadata ? 'reference_ids' then
    if jsonb_typeof(p_metadata -> 'reference_ids') <> 'array'
      or jsonb_array_length(p_metadata -> 'reference_ids') > 20 then
      return false;
    end if;
    for v_reference in select value from jsonb_array_elements(p_metadata -> 'reference_ids')
    loop
      if jsonb_typeof(v_reference) <> 'string'
        or char_length(v_reference #>> '{}') not between 1 and 120
        or (v_reference #>> '{}') ~ '[[:cntrl:]]' then
        return false;
      end if;
    end loop;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function private.is_active_designated_investigator_internal(
  p_user_id uuid,
  p_organization_id uuid,
  p_unit_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_role_assignments assignment
    join public.organization_memberships membership
      on membership.organization_id = assignment.organization_id
     and membership.user_id = assignment.user_id
     and membership.status = 'active'
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_user_id
      and assignment.role_name = 'designated_investigator'
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
      and private.actor_has_permission(
        p_user_id, p_organization_id, 'reports.investigate', p_unit_id
      )
  )
$$;

create or replace function private.enqueue_moderation_invalidation_internal(
  p_organization_id uuid,
  p_case_id uuid,
  p_target_user_id uuid,
  p_state text,
  p_reason text,
  p_version integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_state not in ('open', 'assigned', 'in_review', 'resolved', 'dismissed')
    or p_reason not in ('case_available', 'case_assigned', 'case_reassigned', 'case_status_changed')
    or p_version < 1
    or not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = p_target_user_id
        and membership.status = 'active'
    ) then
    raise exception 'invalid moderation invalidation target' using errcode = '22023';
  end if;
  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'realtime_control',
    'moderation:' || p_case_id::text || ':' || p_version::text || ':'
      || p_target_user_id::text || ':' || p_reason,
    jsonb_build_object(
      'schema_version', 1,
      'event_id', gen_random_uuid(),
      'event', 'workspace.invalidated',
      'control_topic', 'org:' || p_organization_id::text || ':user:'
        || p_target_user_id::text || ':inbox',
      'organization_id', p_organization_id,
      'occurred_at', now(),
      'user_id', p_target_user_id,
      'entity_type', 'moderation_case',
      'entity_id', p_case_id,
      'reason', p_reason
    )
  );
end;
$$;

create or replace function private.notify_moderation_viewers_internal(
  p_organization_id uuid,
  p_case_id uuid,
  p_state text,
  p_reason text,
  p_version integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_case private.message_reports%rowtype;
  v_target record;
begin
  select * into v_case
  from private.message_reports report
  where report.organization_id = p_organization_id
    and report.id = p_case_id;
  if not found then
    raise exception 'moderation case not found' using errcode = 'P0002';
  end if;
  for v_target in
    select membership.user_id
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.user_id <> v_case.reporter_user_id
      and membership.user_id <> v_case.subject_user_id
      and (
        private.actor_has_permission(
          membership.user_id, p_organization_id, 'reports.assign', v_case.conversation_unit_id
        )
        or private.is_active_designated_investigator_internal(
          membership.user_id, p_organization_id, v_case.conversation_unit_id
        )
      )
    order by membership.user_id
  loop
    perform private.enqueue_moderation_invalidation_internal(
      p_organization_id, p_case_id, v_target.user_id, p_state, p_reason, p_version
    );
  end loop;
end;
$$;

create or replace function private.bff_report_message_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
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
  v_command jsonb;
  v_report_id uuid;
  v_existing private.message_reports%rowtype;
  v_subject_user_id uuid;
  v_unit_id uuid;
  v_history_visible_from timestamptz;
  v_created boolean := false;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.report', false, 0, '/v2/messages/:id/report',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_consent_to_share is not true
    or p_context_before not between 0 and 2
    or p_context_after not between 0 and 2
    or p_notice_version <> 'moderation-share-v1'
    or p_category not in ('harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other')
    or (p_details is not null and (
      char_length(btrim(p_details)) > 2000
      or regexp_replace(p_details, E'[\\t\\n\\r]', '', 'g') ~ '[[:cntrl:]]'
    )) then
    raise exception 'valid report consent and bounded case scope required' using errcode = '22023';
  end if;

  select message.sender_user_id, conversation.unit_id, member.history_visible_from
    into v_subject_user_id, v_unit_id, v_history_visible_from
  from public.messages message
  join public.conversations conversation
    on conversation.organization_id = message.organization_id
   and conversation.id = message.conversation_id
  join public.conversation_members member
    on member.organization_id = message.organization_id
   and member.conversation_id = message.conversation_id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
    and message.deleted_at is null
    and message.available_at <= now()
    and (member.history_visible_from is null or message.created_at >= member.history_visible_from)
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = message.organization_id
        and visibility.conversation_id = message.conversation_id
        and visibility.message_id = message.id
        and visibility.user_id = p_actor_user_id
    )
  for share of message;
  if not found then
    raise exception 'message is not available' using errcode = '42501';
  end if;
  if v_subject_user_id = p_actor_user_id then
    raise exception 'a reporter cannot report their own message' using errcode = '22023';
  end if;

  select * into v_existing
  from private.message_reports report
  where report.organization_id = p_organization_id
    and report.conversation_id = p_conversation_id
    and report.message_id = p_message_id
    and report.reporter_user_id = p_actor_user_id;
  if found then
    v_response := jsonb_build_object(
      'report_id', v_existing.id,
      'status', v_existing.status,
      'created', false,
      'reporter_identity_protected', true,
      'notice_version', v_existing.reporter_notice_version,
      'context_before', v_existing.context_before_count,
      'context_after', v_existing.context_after_count
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, '/v2/messages/:id/report',
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;

  insert into private.message_reports (
    organization_id, conversation_id, message_id, reporter_user_id,
    subject_user_id, conversation_unit_id, category, details, status,
    reporter_notice_version, reporter_consent_at,
    context_before_count, context_after_count
  ) values (
    p_organization_id, p_conversation_id, p_message_id, p_actor_user_id,
    v_subject_user_id, v_unit_id, p_category,
    nullif(btrim(p_details), ''), 'open', p_notice_version, now(),
    p_context_before, p_context_after
  )
  on conflict (organization_id, conversation_id, message_id, reporter_user_id)
  do nothing
  returning id into v_report_id;

  if v_report_id is null then
    select * into v_existing
    from private.message_reports report
    where report.organization_id = p_organization_id
      and report.conversation_id = p_conversation_id
      and report.message_id = p_message_id
      and report.reporter_user_id = p_actor_user_id;
    if not found then raise exception 'report creation conflict' using errcode = '55000'; end if;
    v_response := jsonb_build_object(
      'report_id', v_existing.id,
      'status', v_existing.status,
      'created', false,
      'reporter_identity_protected', true,
      'notice_version', v_existing.reporter_notice_version,
      'context_before', v_existing.context_before_count,
      'context_after', v_existing.context_after_count
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, '/v2/messages/:id/report',
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;
  v_created := true;

  with visible as (
    select message.id, message.sender_user_id, message.kind, message.body, message.created_at
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.deleted_at is null
      and message.available_at <= now()
      and (v_history_visible_from is null or message.created_at >= v_history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
  ), before_rows as (
    select selected.*, -row_number() over (order by selected.id desc)::integer as relative_position
    from (
      select * from visible where id < p_message_id order by id desc limit p_context_before
    ) selected
  ), after_rows as (
    select selected.*, row_number() over (order by selected.id)::integer as relative_position
    from (
      select * from visible where id > p_message_id order by id limit p_context_after
    ) selected
  ), evidence as (
    select reported.id, reported.sender_user_id, reported.kind, reported.body,
      reported.created_at, 'reported'::text as relationship, 0 as relative_position
    from visible reported where reported.id = p_message_id
    union all
    select before_rows.id, before_rows.sender_user_id, before_rows.kind, before_rows.body,
      before_rows.created_at, 'context_before'::text, before_rows.relative_position
    from before_rows
    union all
    select after_rows.id, after_rows.sender_user_id, after_rows.kind, after_rows.body,
      after_rows.created_at, 'context_after'::text, after_rows.relative_position
    from after_rows
  )
  insert into private.moderation_case_evidence (
    organization_id, case_id, conversation_id, message_id, relationship,
    relative_position, sender_user_id, message_kind, message_body,
    message_created_at, body_sha256
  )
  select p_organization_id, v_report_id, p_conversation_id, evidence.id,
    evidence.relationship, evidence.relative_position, evidence.sender_user_id,
    evidence.kind, evidence.body, evidence.created_at,
    extensions.digest(convert_to(coalesce(evidence.body, ''), 'UTF8'), 'sha256')
  from evidence;

  insert into private.moderation_case_history (
    organization_id, case_id, actor_user_id, event_type,
    from_status, to_status, reason, evidence_metadata
  ) values (
    p_organization_id, v_report_id, p_actor_user_id, 'reported',
    null, 'open', null,
    jsonb_build_object(
      'notice_version', p_notice_version,
      'context_before', p_context_before,
      'context_after', p_context_after
    )
  );

  perform private.notify_moderation_viewers_internal(
    p_organization_id, v_report_id, 'open', 'case_available', 1
  );

  v_response := jsonb_build_object(
    'report_id', v_report_id,
    'status', 'open',
    'created', v_created,
    'reporter_identity_protected', true,
    'notice_version', p_notice_version,
    'context_before', p_context_before,
    'context_after', p_context_after
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/report',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

-- Preserve the prior server-only signature only as an intentionally retired
-- symbol. It cannot bypass the current versioned disclosure and is revoked
-- from service_role below.
create or replace function private.bff_report_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_category text,
  p_details text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security definer
set search_path = ''
as $$
  select private.bff_report_message_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_message_id, p_category, p_details,
    true, 0, 0, 'legacy-server-report-v1',
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function private.bff_query_moderation_cases_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_statuses text[],
  p_before_updated_at timestamptz,
  p_before_case_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_statuses text[];
  v_cases jsonb;
  v_count integer;
  v_last_updated_at timestamptz;
  v_last_case_id uuid;
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'moderation.case.query', true, 300
  );
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal', 'moderation.case.query'
  );
  select array_agg(distinct status order by status) into v_statuses
  from unnest(coalesce(p_statuses, array[]::text[])) status;
  if p_limit not between 1 and 100
    or cardinality(v_statuses) not between 1 and 5
    or not (v_statuses <@ array['open', 'assigned', 'in_review', 'resolved', 'dismissed']::text[])
    or ((p_before_updated_at is null) <> (p_before_case_id is null)) then
    raise exception 'invalid moderation case query' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'moderation-case-query-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    600, 3600
  ) then
    raise exception 'moderation case query rate limit exceeded' using errcode = 'P0001';
  end if;

  with authorized as (
    select report.*,
      private.actor_has_permission(
        p_actor_user_id, p_organization_id, 'reports.assign', report.conversation_unit_id
      ) as can_assign,
      private.is_active_designated_investigator_internal(
        p_actor_user_id, p_organization_id, report.conversation_unit_id
      ) as investigator_in_scope
    from private.message_reports report
    where report.organization_id = p_organization_id
      and report.status = any(v_statuses)
      and (
        p_before_updated_at is null
        or (report.updated_at, report.id) < (p_before_updated_at, p_before_case_id)
      )
  ), visible as (
    select authorized.*
    from authorized
    where authorized.subject_user_id <> p_actor_user_id
      and authorized.reporter_user_id <> p_actor_user_id
      and (authorized.can_assign
      or (authorized.assigned_investigator_user_id = p_actor_user_id
        and authorized.investigator_in_scope)
      or (authorized.status = 'open' and authorized.investigator_in_scope)
      )
    order by authorized.updated_at desc, authorized.id desc
    limit p_limit
  ), projected as (
    select visible.updated_at, visible.id,
      jsonb_build_object(
        'case_id', visible.id,
        'status', visible.status,
        'category', visible.category,
        'unit_id', visible.conversation_unit_id,
        'reported_at', visible.created_at,
        'updated_at', visible.updated_at,
        'record_version', visible.record_version,
        'assigned_at', visible.assigned_at,
        'assigned_to_me', coalesce(
          visible.assigned_investigator_user_id = p_actor_user_id, false
        ) and visible.investigator_in_scope,
        'assigned_investigator_user_id', case when visible.can_assign
          then visible.assigned_investigator_user_id else null end,
        'can_claim', visible.status = 'open' and visible.investigator_in_scope,
        'can_assign', visible.status in ('open', 'assigned', 'in_review') and visible.can_assign,
        'can_view_evidence', coalesce(
          visible.assigned_investigator_user_id = p_actor_user_id, false
        ) and visible.investigator_in_scope,
        'read_only', visible.status in ('resolved', 'dismissed'),
        'reporter_label', 'protected',
        'eligible_investigator_user_ids', case when visible.can_assign then (
          select coalesce(jsonb_agg(candidate.user_id order by candidate.user_id), '[]'::jsonb)
          from (
            select distinct assignment.user_id
            from public.organization_role_assignments assignment
            where assignment.organization_id = p_organization_id
              and assignment.role_name = 'designated_investigator'
              and assignment.user_id <> p_actor_user_id
              and assignment.user_id <> visible.reporter_user_id
              and assignment.user_id <> visible.subject_user_id
              and assignment.revoked_at is null
              and (assignment.expires_at is null or assignment.expires_at > now())
              and private.is_active_designated_investigator_internal(
                assignment.user_id, p_organization_id, visible.conversation_unit_id
              )
            order by assignment.user_id
            limit 100
          ) candidate
        ) else '[]'::jsonb end
      ) as payload
    from visible
  )
  select coalesce(jsonb_agg(projected.payload order by projected.updated_at desc, projected.id desc), '[]'::jsonb),
    count(*)::integer
    into v_cases, v_count
  from projected;

  if v_count = p_limit then
    with authorized as (
      select report.*,
        private.actor_has_permission(
          p_actor_user_id, p_organization_id, 'reports.assign', report.conversation_unit_id
        ) as can_assign,
        private.is_active_designated_investigator_internal(
          p_actor_user_id, p_organization_id, report.conversation_unit_id
        ) as investigator_in_scope
      from private.message_reports report
      where report.organization_id = p_organization_id
        and report.status = any(v_statuses)
        and (
          p_before_updated_at is null
          or (report.updated_at, report.id) < (p_before_updated_at, p_before_case_id)
        )
    )
    select visible.updated_at, visible.id into v_last_updated_at, v_last_case_id
    from authorized visible
    where visible.subject_user_id <> p_actor_user_id
      and visible.reporter_user_id <> p_actor_user_id
      and (visible.can_assign
      or (visible.assigned_investigator_user_id = p_actor_user_id
        and visible.investigator_in_scope)
      or (visible.status = 'open' and visible.investigator_in_scope)
      )
    order by visible.updated_at desc, visible.id desc
    offset p_limit - 1 limit 1;
  end if;

  perform private.clear_bff_actor_context_internal();
  return jsonb_build_object(
    'schema_version', 1,
    'cases', v_cases,
    'next_cursor', case when v_last_case_id is null then null else jsonb_build_object(
      'before_updated_at', v_last_updated_at,
      'before_case_id', v_last_case_id
    ) end,
    'content_included', false,
    'reporter_identity_included', false,
    'requires_explicit_assignment_for_evidence', true
  );
end;
$$;

create or replace function private.bff_read_moderation_case_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_case private.message_reports%rowtype;
  v_evidence jsonb;
  v_history jsonb;
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'moderation.case.read', true, 300
  );
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal', 'moderation.case.read'
  );
  select * into v_case
  from private.message_reports report
  where report.organization_id = p_organization_id
    and report.id = p_case_id
    and report.assigned_investigator_user_id = p_actor_user_id
    and report.reporter_user_id <> p_actor_user_id
    and report.subject_user_id <> p_actor_user_id
    and private.is_active_designated_investigator_internal(
      p_actor_user_id, p_organization_id, report.conversation_unit_id
    );
  if not found then
    raise exception 'assigned moderation case not found' using errcode = 'P0002';
  end if;
  if not private.consume_rate_limit(
    'moderation-case-access-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    300, 3600
  ) then
    raise exception 'moderation case access rate limit exceeded' using errcode = 'P0001';
  end if;

  insert into private.moderation_case_history (
    organization_id, case_id, actor_user_id, event_type,
    from_status, to_status, reason, evidence_metadata
  ) values (
    p_organization_id, p_case_id, p_actor_user_id, 'accessed',
    v_case.status, v_case.status, null, '{}'::jsonb
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'evidence_id', evidence.id,
    'relationship', evidence.relationship,
    'relative_position', evidence.relative_position,
    'message_kind', evidence.message_kind,
    'message_body', evidence.message_body,
    'sender_label', case when evidence.sender_user_id = v_case.reporter_user_id
      then 'Protected reporter' else coalesce(profile.display_name, 'Conversation participant') end,
    'sent_at', evidence.message_created_at,
    'body_sha256', encode(evidence.body_sha256, 'hex')
  ) order by evidence.relative_position), '[]'::jsonb)
  into v_evidence
  from private.moderation_case_evidence evidence
  left join public.profiles profile on profile.user_id = evidence.sender_user_id
  where evidence.organization_id = p_organization_id
    and evidence.case_id = p_case_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'event_id', history.id,
    'event_type', history.event_type,
    'from_status', history.from_status,
    'to_status', history.to_status,
    'reason', history.reason,
    'evidence_metadata', case when history.event_type in ('resolved', 'dismissed')
      then history.evidence_metadata else '{}'::jsonb end,
    'actor_label', case
      when history.event_type = 'reported' then 'protected_reporter'
      when history.event_type in (
        'claimed', 'accessed', 'review_started', 'resolved', 'dismissed'
      ) then 'assigned_investigator'
      else 'authorized_case_manager'
    end,
    'occurred_at', history.occurred_at
  ) order by history.occurred_at, history.id), '[]'::jsonb)
  into v_history
  from (
    select * from private.moderation_case_history history
    where history.organization_id = p_organization_id
      and history.case_id = p_case_id
    order by history.occurred_at desc, history.id desc
    limit 200
  ) history;

  perform private.clear_bff_actor_context_internal();
  return jsonb_build_object(
    'schema_version', 1,
    'case', jsonb_build_object(
      'case_id', v_case.id,
      'status', v_case.status,
      'category', v_case.category,
      'details', v_case.details,
      'reporter_label', 'protected',
      'reported_at', v_case.created_at,
      'updated_at', v_case.updated_at,
      'assigned_at', v_case.assigned_at,
      'record_version', v_case.record_version,
      'read_only', v_case.status in ('resolved', 'dismissed'),
      'evidence', v_evidence,
      'history', v_history
    ),
    'scope', jsonb_build_object(
      'reported_item_and_consented_context_only', true,
      'reporter_identity_included', false,
      'other_conversations_included', false
    )
  );
end;
$$;

create or replace function private.bff_assign_moderation_case_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_investigator_user_id uuid,
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
  v_case private.message_reports%rowtype;
  v_from_status text;
  v_event text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'moderation.case.assign', true, 300, '/v2/moderation/cases/:id/assign',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version < 1
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000
    or p_actor_user_id = p_investigator_user_id then
    raise exception 'valid independent moderation assignment required' using errcode = '22023';
  end if;
  select * into v_case
  from private.message_reports report
  where report.organization_id = p_organization_id and report.id = p_case_id
  for update;
  if not found then raise exception 'moderation case not found' using errcode = 'P0002'; end if;
  if v_case.record_version <> p_expected_version then
    raise exception 'moderation case version conflict' using errcode = '40001';
  end if;
  if v_case.status not in ('open', 'assigned', 'in_review')
    or p_actor_user_id in (v_case.reporter_user_id, v_case.subject_user_id)
    or p_investigator_user_id in (v_case.reporter_user_id, v_case.subject_user_id)
    or not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'reports.assign', v_case.conversation_unit_id
    )
    or not private.is_active_designated_investigator_internal(
      p_investigator_user_id, p_organization_id, v_case.conversation_unit_id
    ) then
    raise exception 'moderation assignment is not permitted' using errcode = '42501';
  end if;
  if v_case.assigned_investigator_user_id = p_investigator_user_id then
    raise exception 'case is already assigned to this investigator' using errcode = '55000';
  end if;
  v_from_status := v_case.status;
  v_event := case when v_case.status = 'open' then 'assigned' else 'reassigned' end;

  update private.message_reports report
  set status = 'assigned',
      assigned_investigator_user_id = p_investigator_user_id,
      assigned_by_user_id = p_actor_user_id,
      assigned_at = now(),
      assignment_reason = btrim(p_reason),
      record_version = report.record_version + 1,
      updated_at = clock_timestamp()
  where report.organization_id = p_organization_id and report.id = p_case_id
  returning * into v_case;
  insert into private.moderation_case_history (
    organization_id, case_id, actor_user_id, event_type,
    from_status, to_status, reason, evidence_metadata
  ) values (
    p_organization_id, p_case_id, p_actor_user_id, v_event,
    v_from_status,
    'assigned', btrim(p_reason), '{}'::jsonb
  );
  perform private.notify_moderation_viewers_internal(
    p_organization_id, p_case_id, 'assigned',
    case when v_event = 'assigned' then 'case_assigned' else 'case_reassigned' end,
    v_case.record_version
  );
  v_response := jsonb_build_object(
    'case_id', p_case_id,
    'status', 'assigned',
    'record_version', v_case.record_version,
    'assigned_at', v_case.assigned_at,
    'assigned_investigator_user_id', p_investigator_user_id,
    'reporter_identity_included', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/moderation/cases/:id/assign',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_claim_moderation_case_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
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
  v_case private.message_reports%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'moderation.case.claim', true, 300, '/v2/moderation/cases/:id/claim',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version < 1
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000 then
    raise exception 'valid moderation claim reason required' using errcode = '22023';
  end if;
  select * into v_case
  from private.message_reports report
  where report.organization_id = p_organization_id and report.id = p_case_id
  for update;
  if not found then raise exception 'moderation case not found' using errcode = 'P0002'; end if;
  if v_case.record_version <> p_expected_version then
    raise exception 'moderation case version conflict' using errcode = '40001';
  end if;
  if v_case.status <> 'open'
    or p_actor_user_id in (v_case.reporter_user_id, v_case.subject_user_id)
    or not private.is_active_designated_investigator_internal(
      p_actor_user_id, p_organization_id, v_case.conversation_unit_id
    ) then
    raise exception 'moderation claim is not permitted' using errcode = '42501';
  end if;
  update private.message_reports report
  set status = 'assigned',
      assigned_investigator_user_id = p_actor_user_id,
      assigned_by_user_id = p_actor_user_id,
      assigned_at = now(),
      assignment_reason = btrim(p_reason),
      record_version = report.record_version + 1,
      updated_at = clock_timestamp()
  where report.organization_id = p_organization_id and report.id = p_case_id
  returning * into v_case;
  insert into private.moderation_case_history (
    organization_id, case_id, actor_user_id, event_type,
    from_status, to_status, reason, evidence_metadata
  ) values (
    p_organization_id, p_case_id, p_actor_user_id, 'claimed',
    'open', 'assigned', btrim(p_reason), '{}'::jsonb
  );
  perform private.notify_moderation_viewers_internal(
    p_organization_id, p_case_id, 'assigned', 'case_assigned', v_case.record_version
  );
  v_response := jsonb_build_object(
    'case_id', p_case_id,
    'status', 'assigned',
    'record_version', v_case.record_version,
    'assigned_at', v_case.assigned_at,
    'assigned_investigator_user_id', p_actor_user_id,
    'reporter_identity_included', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/moderation/cases/:id/claim',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_transition_moderation_case_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_status text,
  p_expected_version integer,
  p_reason text,
  p_evidence_metadata jsonb,
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
  v_case private.message_reports%rowtype;
  v_from_status text;
  v_event text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'moderation.case.transition', true, 300, '/v2/moderation/cases/:id/transition',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version < 1
    or p_status not in ('in_review', 'resolved', 'dismissed')
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 2000
    or not private.valid_moderation_evidence_metadata(coalesce(p_evidence_metadata, '{}'::jsonb))
    or (p_status in ('resolved', 'dismissed')
      and coalesce(p_evidence_metadata, '{}'::jsonb) = '{}'::jsonb) then
    raise exception 'valid moderation transition evidence required' using errcode = '22023';
  end if;
  select * into v_case
  from private.message_reports report
  where report.organization_id = p_organization_id and report.id = p_case_id
  for update;
  if not found then raise exception 'moderation case not found' using errcode = 'P0002'; end if;
  if v_case.record_version <> p_expected_version then
    raise exception 'moderation case version conflict' using errcode = '40001';
  end if;
  if v_case.assigned_investigator_user_id <> p_actor_user_id
    or p_actor_user_id in (v_case.reporter_user_id, v_case.subject_user_id)
    or not private.is_active_designated_investigator_internal(
      p_actor_user_id, p_organization_id, v_case.conversation_unit_id
    )
    or not (
      (v_case.status = 'assigned' and p_status = 'in_review')
      or (v_case.status = 'in_review' and p_status in ('resolved', 'dismissed'))
    ) then
    raise exception 'moderation transition is not permitted' using errcode = '42501';
  end if;
  v_from_status := v_case.status;
  v_event := case p_status
    when 'in_review' then 'review_started'
    when 'resolved' then 'resolved'
    else 'dismissed'
  end;
  update private.message_reports report
  set status = p_status,
      closed_by_user_id = case when p_status in ('resolved', 'dismissed')
        then p_actor_user_id else null end,
      closed_at = case when p_status in ('resolved', 'dismissed') then now() else null end,
      resolution_reason = case when p_status in ('resolved', 'dismissed')
        then btrim(p_reason) else null end,
      resolution_evidence_metadata = case when p_status in ('resolved', 'dismissed')
        then coalesce(p_evidence_metadata, '{}'::jsonb) else null end,
      record_version = report.record_version + 1,
      updated_at = clock_timestamp()
  where report.organization_id = p_organization_id and report.id = p_case_id
  returning * into v_case;
  insert into private.moderation_case_history (
    organization_id, case_id, actor_user_id, event_type,
    from_status, to_status, reason, evidence_metadata
  ) values (
    p_organization_id, p_case_id, p_actor_user_id, v_event,
    v_from_status, p_status, btrim(p_reason), coalesce(p_evidence_metadata, '{}'::jsonb)
  );
  perform private.notify_moderation_viewers_internal(
    p_organization_id, p_case_id, p_status, 'case_status_changed', v_case.record_version
  );
  perform private.enqueue_moderation_invalidation_internal(
    p_organization_id, p_case_id, v_case.reporter_user_id, p_status,
    'case_status_changed', v_case.record_version
  );
  v_response := jsonb_build_object(
    'case_id', p_case_id,
    'status', p_status,
    'record_version', v_case.record_version,
    'updated_at', v_case.updated_at,
    'read_only', p_status in ('resolved', 'dismissed'),
    'reporter_identity_included', false,
    'notification_payload_content_included', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/moderation/cases/:id/transition',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

alter table private.message_reports
  add constraint message_reports_resolution_metadata_valid
  check (
    resolution_evidence_metadata is null
    or private.valid_moderation_evidence_metadata(resolution_evidence_metadata)
  );

-- Ordinary workspace bootstrap runs at AAL1 and must not project case IDs,
-- conversation IDs, message IDs, or content. The dedicated case API below is
-- recent-AAL2 and assignment scoped.
create or replace function private.bff_bootstrap_messaging_state_v3_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_set(
    private.bff_bootstrap_messaging_state_v2_impl(
      p_actor_user_id, p_organization_id, p_session_id,
      p_selected_conversation_id, p_before_message_id,
      p_conversation_limit, p_timeline_limit
    ),
    '{moderation_reports}',
    '[]'::jsonb,
    true
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
  select private.bff_bootstrap_messaging_state_v3_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  )
$$;

create or replace function public.bff_report_message_v2(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
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
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_report_message_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_message_id, p_category, p_details,
    p_consent_to_share, p_context_before, p_context_after, p_notice_version,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_query_moderation_cases(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_statuses text[],
  p_before_updated_at timestamptz default null,
  p_before_case_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_query_moderation_cases_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_statuses, p_before_updated_at, p_before_case_id, p_limit
  )
$$;

create or replace function public.bff_read_moderation_case(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_read_moderation_case_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_case_id
  )
$$;

create or replace function public.bff_assign_moderation_case(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_investigator_user_id uuid,
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
  select private.bff_assign_moderation_case_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_case_id, p_investigator_user_id, p_expected_version, p_reason,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_claim_moderation_case(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
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
  select private.bff_claim_moderation_case_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_case_id, p_expected_version, p_reason,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_transition_moderation_case(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_case_id uuid,
  p_status text,
  p_expected_version integer,
  p_reason text,
  p_evidence_metadata jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_transition_moderation_case_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_case_id, p_status, p_expected_version, p_reason, p_evidence_metadata,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke all on table private.message_reports,
  private.moderation_case_evidence,
  private.moderation_case_history
from public, anon, authenticated, service_role;
revoke execute on function
  private.prevent_moderation_evidence_mutation(),
  private.enforce_moderation_case_lifecycle(),
  private.valid_moderation_evidence_metadata(jsonb),
  private.is_active_designated_investigator_internal(uuid, uuid, uuid),
  private.enqueue_moderation_invalidation_internal(uuid, uuid, uuid, text, text, integer),
  private.notify_moderation_viewers_internal(uuid, uuid, text, text, integer),
  private.bff_report_message_v2_impl(uuid, uuid, uuid, uuid, bigint, text, text, boolean, integer, integer, text, text, text),
  private.bff_query_moderation_cases_impl(uuid, uuid, uuid, text[], timestamptz, uuid, integer),
  private.bff_read_moderation_case_impl(uuid, uuid, uuid, uuid),
  private.bff_assign_moderation_case_impl(uuid, uuid, uuid, uuid, uuid, integer, text, text, text),
  private.bff_claim_moderation_case_impl(uuid, uuid, uuid, uuid, integer, text, text, text),
  private.bff_transition_moderation_case_impl(uuid, uuid, uuid, uuid, text, integer, text, jsonb, text, text),
  private.bff_bootstrap_messaging_state_v3_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
from public, anon, authenticated, service_role;
revoke execute on function
  private.bff_report_message_impl(uuid, uuid, uuid, uuid, bigint, text, text, text, text),
  public.bff_report_message(uuid, uuid, uuid, uuid, bigint, text, text, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_report_message_v2_impl(uuid, uuid, uuid, uuid, bigint, text, text, boolean, integer, integer, text, text, text),
  private.bff_query_moderation_cases_impl(uuid, uuid, uuid, text[], timestamptz, uuid, integer),
  private.bff_read_moderation_case_impl(uuid, uuid, uuid, uuid),
  private.bff_assign_moderation_case_impl(uuid, uuid, uuid, uuid, uuid, integer, text, text, text),
  private.bff_claim_moderation_case_impl(uuid, uuid, uuid, uuid, integer, text, text, text),
  private.bff_transition_moderation_case_impl(uuid, uuid, uuid, uuid, text, integer, text, jsonb, text, text),
  private.bff_bootstrap_messaging_state_v3_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
to service_role;

revoke execute on function
  public.bff_report_message_v2(uuid, uuid, uuid, uuid, bigint, text, text, boolean, integer, integer, text, text, text),
  public.bff_query_moderation_cases(uuid, uuid, uuid, text[], timestamptz, uuid, integer),
  public.bff_read_moderation_case(uuid, uuid, uuid, uuid),
  public.bff_assign_moderation_case(uuid, uuid, uuid, uuid, uuid, integer, text, text, text),
  public.bff_claim_moderation_case(uuid, uuid, uuid, uuid, integer, text, text, text),
  public.bff_transition_moderation_case(uuid, uuid, uuid, uuid, text, integer, text, jsonb, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.bff_report_message_v2(uuid, uuid, uuid, uuid, bigint, text, text, boolean, integer, integer, text, text, text),
  public.bff_query_moderation_cases(uuid, uuid, uuid, text[], timestamptz, uuid, integer),
  public.bff_read_moderation_case(uuid, uuid, uuid, uuid),
  public.bff_assign_moderation_case(uuid, uuid, uuid, uuid, uuid, integer, text, text, text),
  public.bff_claim_moderation_case(uuid, uuid, uuid, uuid, integer, text, text, text),
  public.bff_transition_moderation_case(uuid, uuid, uuid, uuid, text, integer, text, jsonb, text, text)
to service_role;

comment on table private.message_reports is
  'Private moderation cases. Reporter identity never appears in investigator list/detail DTOs.';
comment on table private.moderation_case_evidence is
  'Immutable report-time snapshot of only the reported item and the explicitly consented bounded context.';
comment on table private.moderation_case_history is
  'Append-only assignment, access, and lifecycle evidence. Reporter actor identity is redacted from investigator DTOs.';

commit;
