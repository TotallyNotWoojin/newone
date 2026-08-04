begin;

-- A moderation case can now identify one of three immutable targets while the
-- evidence boundary remains unchanged: only message reports snapshot content.
alter table private.message_reports
  add column target_type text not null default 'message',
  add column target_label_snapshot text,
  add column target_identity_sha256 bytea;

alter table private.message_reports disable trigger moderation_case_lifecycle_guard;

update private.message_reports report
set target_label_snapshot = coalesce(
      nullif(left(regexp_replace(btrim(profile.display_name), '[[:cntrl:]]', ' ', 'g'), 160), ''),
      'Conversation participant'
    ),
    target_identity_sha256 = extensions.digest(
      convert_to(
        'organization:' || report.organization_id::text
          || ':message:' || report.conversation_id::text || ':' || report.message_id::text,
        'UTF8'
      ),
      'sha256'
    )
from public.profiles profile
where profile.user_id = report.subject_user_id;

alter table private.message_reports enable trigger moderation_case_lifecycle_guard;

alter table private.message_reports
  alter column conversation_id drop not null,
  alter column message_id drop not null,
  alter column subject_user_id drop not null,
  alter column target_label_snapshot set not null,
  alter column target_identity_sha256 set not null,
  drop constraint message_reports_case_separation,
  add constraint message_reports_target_type_allowed
    check (target_type in ('message', 'group', 'member')),
  add constraint message_reports_target_shape check (
    (target_type = 'message'
      and conversation_id is not null
      and message_id is not null
      and subject_user_id is not null)
    or (target_type = 'group'
      and conversation_id is not null
      and message_id is null
      and subject_user_id is null)
    or (target_type = 'member'
      and conversation_id is null
      and message_id is null
      and subject_user_id is not null)
  ),
  add constraint message_reports_target_label_valid check (
    char_length(btrim(target_label_snapshot)) between 1 and 160
    and target_label_snapshot !~ '[[:cntrl:]]'
  ),
  add constraint message_reports_target_identity_sha256_length
    check (octet_length(target_identity_sha256) = 32),
  add constraint message_reports_target_context_shape check (
    target_type = 'message'
    or (context_before_count = 0 and context_after_count = 0)
  ),
  add constraint message_reports_conversation_fkey
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  add constraint message_reports_case_separation check (
    (subject_user_id is null or reporter_user_id <> subject_user_id)
    and (assigned_investigator_user_id is null or (
      assigned_investigator_user_id <> reporter_user_id
      and (subject_user_id is null or assigned_investigator_user_id <> subject_user_id)
    ))
    and (assigned_by_user_id is null or (
      assigned_by_user_id <> reporter_user_id
      and (subject_user_id is null or assigned_by_user_id <> subject_user_id)
    ))
    and (closed_by_user_id is null or (
      closed_by_user_id <> reporter_user_id
      and (subject_user_id is null or closed_by_user_id <> subject_user_id)
    ))
  );

-- Replace the foundation's lifetime message duplicate constraint. A reporter
-- may submit a genuinely later incident after the earlier case is closed, but
-- concurrent or repeated intake still converges on one active case.
do $$
declare
  v_constraint_name text;
begin
  select constraint_row.conname into v_constraint_name
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.conrelid = 'private.message_reports'::regclass
    and constraint_row.contype = 'u'
    and (
      select array_agg(attribute.attname order by key_column.ordinality)
      from unnest(constraint_row.conkey) with ordinality key_column(attnum, ordinality)
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = constraint_row.conrelid
       and attribute.attnum = key_column.attnum
    ) = array['organization_id', 'conversation_id', 'message_id', 'reporter_user_id']::name[];
  if v_constraint_name is not null then
    execute format(
      'alter table private.message_reports drop constraint %I',
      v_constraint_name
    );
  end if;
end;
$$;

create unique index message_reports_active_reporter_target_unique_idx
  on private.message_reports (organization_id, reporter_user_id, target_identity_sha256)
  where status in ('open', 'assigned', 'in_review');

create index message_reports_target_cursor_idx
  on private.message_reports (
    organization_id, target_type, status, updated_at desc, id desc
  );
create index message_reports_group_target_idx
  on private.message_reports (organization_id, conversation_id, created_at desc)
  where target_type = 'group';
create index message_reports_member_target_idx
  on private.message_reports (organization_id, subject_user_id, created_at desc)
  where target_type = 'member';

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
    or new.target_type is distinct from old.target_type
    or new.target_label_snapshot is distinct from old.target_label_snapshot
    or new.target_identity_sha256 is distinct from old.target_identity_sha256
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
    raise exception 'moderation case target, source, and consent fields are immutable'
      using errcode = '55000';
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

-- Forward declaration for the public SQL wrapper below. The complete body is
-- installed later in this same transaction after notification helpers.
create or replace function private.bff_report_target_v3_impl(
  uuid, uuid, uuid, text, uuid, bigint, uuid, text, text,
  boolean, integer, integer, text, text, text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  raise exception 'moderation report implementation is not installed' using errcode = '55000';
end;
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

  select array_agg(distinct requested_status order by requested_status) into v_statuses
  from unnest(coalesce(p_statuses, array[]::text[])) requested_status;
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
      ) as can_assign_scope,
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
    where authorized.reporter_user_id <> p_actor_user_id
      and (authorized.subject_user_id is null or authorized.subject_user_id <> p_actor_user_id)
      and (
        authorized.can_assign_scope
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
        'target', jsonb_build_object(
          'type', visible.target_type,
          'label', visible.target_label_snapshot
        ),
        'unit_id', visible.conversation_unit_id,
        'reported_at', visible.created_at,
        'updated_at', visible.updated_at,
        'record_version', visible.record_version,
        'assigned_at', visible.assigned_at,
        'assigned_to_me', coalesce(
          visible.assigned_investigator_user_id = p_actor_user_id, false
        ) and visible.investigator_in_scope,
        'assigned_investigator_user_id', case when visible.can_assign_scope
          then visible.assigned_investigator_user_id else null end,
        'can_claim', visible.status = 'open' and visible.investigator_in_scope,
        'can_assign', visible.status in ('open', 'assigned', 'in_review')
          and visible.can_assign_scope,
        'can_view_evidence', coalesce(
          visible.assigned_investigator_user_id = p_actor_user_id, false
        ) and visible.investigator_in_scope,
        'read_only', visible.status in ('resolved', 'dismissed'),
        'reporter_label', 'protected',
        'eligible_investigator_user_ids', case when visible.can_assign_scope then (
          select coalesce(jsonb_agg(candidate.user_id order by candidate.user_id), '[]'::jsonb)
          from (
            select distinct assignment.user_id
            from public.organization_role_assignments assignment
            where assignment.organization_id = p_organization_id
              and assignment.role_name = 'designated_investigator'
              and assignment.user_id <> p_actor_user_id
              and assignment.user_id <> visible.reporter_user_id
              and (visible.subject_user_id is null
                or assignment.user_id <> visible.subject_user_id)
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
  select coalesce(
      jsonb_agg(projected.payload order by projected.updated_at desc, projected.id desc),
      '[]'::jsonb
    ),
    count(*)::integer,
    (array_agg(projected.updated_at order by projected.updated_at desc, projected.id desc))[
      count(*)::integer
    ],
    (array_agg(projected.id order by projected.updated_at desc, projected.id desc))[
      count(*)::integer
    ]
  into v_cases, v_count, v_last_updated_at, v_last_case_id
  from projected;

  perform private.clear_bff_actor_context_internal();
  return jsonb_build_object(
    'schema_version', 2,
    'cases', v_cases,
    'next_cursor', case when v_count = p_limit then jsonb_build_object(
      'before_updated_at', v_last_updated_at,
      'before_case_id', v_last_case_id
    ) else null end,
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
    and (report.subject_user_id is null or report.subject_user_id <> p_actor_user_id)
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
    'schema_version', 2,
    'case', jsonb_build_object(
      'case_id', v_case.id,
      'status', v_case.status,
      'category', v_case.category,
      'target', jsonb_build_object(
        'type', v_case.target_type,
        'label', v_case.target_label_snapshot
      ),
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
      'other_conversations_included', false,
      'target_only', true,
      'message_evidence_included', v_case.target_type = 'message'
    )
  );
end;
$$;

create or replace function public.bff_report_target_v3(
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
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_report_target_v3_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_target_type, p_conversation_id, p_message_id, p_subject_user_id,
    p_category, p_details, p_consent_to_share,
    p_context_before, p_context_after, p_notice_version,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke execute on function
  private.bff_report_target_v3_impl(
    uuid, uuid, uuid, text, uuid, bigint, uuid, text, text,
    boolean, integer, integer, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_report_target_v3_impl(
    uuid, uuid, uuid, text, uuid, bigint, uuid, text, text,
    boolean, integer, integer, text, text, text
  )
to service_role;

revoke execute on function
  public.bff_report_target_v3(
    uuid, uuid, uuid, text, uuid, bigint, uuid, text, text,
    boolean, integer, integer, text, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.bff_report_target_v3(
    uuid, uuid, uuid, text, uuid, bigint, uuid, text, text,
    boolean, integer, integer, text, text, text
  )
to service_role;

-- Replacing these functions does not change their signatures. Reassert the
-- intended server-only grants because function replacement preserves ACLs but
-- explicit privilege posture is easier to audit.
revoke execute on function
  private.enforce_moderation_case_lifecycle(),
  private.notify_moderation_viewers_internal(uuid, uuid, text, text, integer),
  private.bff_query_moderation_cases_impl(uuid, uuid, uuid, text[], timestamptz, uuid, integer),
  private.bff_read_moderation_case_impl(uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_query_moderation_cases_impl(uuid, uuid, uuid, text[], timestamptz, uuid, integer),
  private.bff_read_moderation_case_impl(uuid, uuid, uuid, uuid)
to service_role;

comment on column private.message_reports.target_identity_sha256 is
  'Immutable tenant-bound target fingerprint used for duplicate and race defense; never projected to clients.';
comment on column private.message_reports.target_label_snapshot is
  'Immutable report-time server-derived target label. Reporter-supplied labels are never accepted.';
comment on function public.bff_report_target_v3(
  uuid, uuid, uuid, text, uuid, bigint, uuid, text, text,
  boolean, integer, integer, text, text, text
) is
  'Consent-gated private report intake for a visible message, group, or member. It never notifies the target.';

-- Notifications remain private per-user invalidations. In particular, group
-- reports never publish to a conversation topic and no report notifies its
-- reporter or person target.
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
begin
  select * into v_case
  from private.message_reports report
  where report.organization_id = p_organization_id
    and report.id = p_case_id;
  if not found then
    raise exception 'moderation case not found' using errcode = 'P0002';
  end if;
  if p_state not in ('open', 'assigned', 'in_review', 'resolved', 'dismissed')
    or p_reason not in (
      'case_available', 'case_assigned', 'case_reassigned', 'case_status_changed'
    )
    or p_version < 1 then
    raise exception 'invalid moderation fanout request' using errcode = '22023';
  end if;

  -- User-facing intake/lifecycle commits stay O(1). The durable worker expands
  -- this content-free intent set-wise using authorization at processing time.
  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'moderation',
    'moderation-fanout:' || p_case_id::text || ':' || p_version::text || ':' || p_reason,
    jsonb_build_object(
      'schema_version', 1,
      'case_id', p_case_id,
      'state', p_state,
      'reason', p_reason,
      'version', p_version
    )
  );
end;
$$;

create or replace function private.bff_expand_moderation_fanout_impl(
  p_worker_id uuid,
  p_job_id bigint
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_case private.message_reports%rowtype;
  v_case_id uuid;
  v_state text;
  v_reason text;
  v_version integer;
  v_eligible_count integer;
  v_enqueued_count integer;
begin
  perform private.require_service_role();
  select * into v_job
  from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'moderation'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then
    raise exception 'claimed moderation fanout job not found' using errcode = 'P0002';
  end if;
  if jsonb_typeof(v_job.payload) <> 'object'
    or not (v_job.payload ?& array[
      'schema_version', 'case_id', 'state', 'reason', 'version'
    ])
    or exists (
      select 1 from jsonb_object_keys(v_job.payload) payload_key
      where payload_key not in ('schema_version', 'case_id', 'state', 'reason', 'version')
    )
    or v_job.payload ->> 'schema_version' <> '1' then
    raise exception 'invalid moderation fanout payload' using errcode = '22023';
  end if;
  begin
    v_case_id := (v_job.payload ->> 'case_id')::uuid;
    v_state := v_job.payload ->> 'state';
    v_reason := v_job.payload ->> 'reason';
    v_version := (v_job.payload ->> 'version')::integer;
  exception when others then
    raise exception 'invalid moderation fanout payload' using errcode = '22023';
  end;
  if v_state not in ('open', 'assigned', 'in_review', 'resolved', 'dismissed')
    or v_reason not in (
      'case_available', 'case_assigned', 'case_reassigned', 'case_status_changed'
    )
    or v_version < 1 then
    raise exception 'invalid moderation fanout payload' using errcode = '22023';
  end if;

  select * into v_case
  from private.message_reports report
  where report.organization_id = v_job.organization_id
    and report.id = v_case_id;
  if not found then
    raise exception 'moderation case not found' using errcode = 'P0002';
  end if;

  with eligible as materialized (
    select membership.user_id
    from public.organization_memberships membership
    where membership.organization_id = v_job.organization_id
      and membership.status = 'active'
      and membership.user_id <> v_case.reporter_user_id
      and (v_case.subject_user_id is null or membership.user_id <> v_case.subject_user_id)
      and (
        private.actor_has_permission(
          membership.user_id, v_job.organization_id,
          'reports.assign', v_case.conversation_unit_id
        )
        or private.is_active_designated_investigator_internal(
          membership.user_id, v_job.organization_id, v_case.conversation_unit_id
        )
      )
  ), enqueued as (
    insert into private.outbox_jobs (
      organization_id, topic, dedupe_key, payload
    )
    select v_job.organization_id,
      'realtime_control',
      'moderation:' || v_case_id::text || ':' || v_version::text || ':'
        || eligible.user_id::text || ':' || v_reason,
      jsonb_build_object(
        'schema_version', 1,
        'event_id', gen_random_uuid(),
        'event', 'workspace.invalidated',
        'control_topic', 'org:' || v_job.organization_id::text || ':user:'
          || eligible.user_id::text || ':inbox',
        'organization_id', v_job.organization_id,
        'occurred_at', now(),
        'user_id', eligible.user_id,
        'entity_type', 'moderation_case',
        'entity_id', v_case_id,
        'reason', v_reason
      )
    from eligible
    order by eligible.user_id
    on conflict (topic, dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from eligible), (select count(*) from enqueued)
    into v_eligible_count, v_enqueued_count;

  return jsonb_build_object(
    'job_id', p_job_id,
    'eligible_count', v_eligible_count,
    'enqueued_count', v_enqueued_count,
    'current_authorization_applied', true,
    'replay_safe', true
  );
end;
$$;

create or replace function public.bff_expand_moderation_fanout(
  p_worker_id uuid,
  p_job_id bigint
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_expand_moderation_fanout_impl(p_worker_id, p_job_id)
$$;

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
  v_command jsonb;
  v_route text;
  v_operation text;
  v_report_id uuid;
  v_existing private.message_reports%rowtype;
  v_target_identity bytea;
  v_target_label text;
  v_subject_user_id uuid;
  v_unit_id uuid;
  v_history_visible_from timestamptz;
  v_consent_at timestamptz;
  v_context_max_message_id bigint;
  v_response jsonb;
begin
  v_route := case p_target_type
    when 'message' then '/v2/messages/:id/report'
    when 'group' then '/v2/conversations/:id/report'
    when 'member' then '/v2/people/:id/report'
    else null
  end;
  v_operation := case p_target_type
    when 'message' then 'message.report'
    when 'group' then 'conversation.report'
    when 'member' then 'member.report'
    else null
  end;
  if v_route is null then
    raise exception 'valid moderation report target required' using errcode = '22023';
  end if;

  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    v_operation, false, 0, v_route,
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  if p_consent_to_share is not true
    or not (
      p_notice_version = 'moderation-report-v2'
      or (p_target_type = 'message' and p_notice_version = 'moderation-share-v1')
    )
    or p_category not in ('harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other')
    or p_context_before not between 0 and 2
    or p_context_after not between 0 and 2
    or (p_target_type <> 'message' and (p_context_before <> 0 or p_context_after <> 0))
    or (p_details is not null and (
      char_length(btrim(p_details)) > 2000
      or regexp_replace(p_details, E'[\\t\\n\\r]', '', 'g') ~ '[[:cntrl:]]'
    ))
    or not (
      (p_target_type = 'message' and p_conversation_id is not null
        and p_message_id is not null and p_subject_user_id is null)
      or (p_target_type = 'group' and p_conversation_id is not null
        and p_message_id is null and p_subject_user_id is null)
      or (p_target_type = 'member' and p_conversation_id is null
        and p_message_id is null and p_subject_user_id is not null)
    ) then
    raise exception 'valid report consent and bounded target scope required' using errcode = '22023';
  end if;

  if not private.consume_rate_limit(
    'moderation-report-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    10, 3600
  ) then
    raise exception 'moderation report rate limit exceeded' using errcode = 'P0001';
  end if;

  v_consent_at := clock_timestamp();

  if p_target_type = 'message' then
    select message.sender_user_id, conversation.unit_id, member.history_visible_from,
      coalesce(
        nullif(left(regexp_replace(btrim(profile.display_name), '[[:cntrl:]]', ' ', 'g'), 160), ''),
        'Conversation participant'
      ),
      (
        select max(boundary.id)
        from public.messages boundary
        where boundary.organization_id = message.organization_id
          and boundary.conversation_id = message.conversation_id
          and boundary.available_at <= v_consent_at
      )
      into v_subject_user_id, v_unit_id, v_history_visible_from,
        v_target_label, v_context_max_message_id
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
    join public.profiles profile on profile.user_id = message.sender_user_id
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_message_id
      and message.deleted_at is null
      and message.available_at <= v_consent_at
      and message.created_at <= v_consent_at
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
    v_target_identity := extensions.digest(
      convert_to(
        'organization:' || p_organization_id::text
          || ':message:' || p_conversation_id::text || ':' || p_message_id::text,
        'UTF8'
      ),
      'sha256'
    );
  elsif p_target_type = 'group' then
    select conversation.unit_id,
      coalesce(
        nullif(left(regexp_replace(btrim(conversation.name), '[[:cntrl:]]', ' ', 'g'), 160), ''),
        'Unnamed group'
      )
      into v_unit_id, v_target_label
    from public.conversations conversation
    join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind in ('group', 'team', 'shift', 'announcement', 'incident')
    for share of conversation;
    if not found then
      raise exception 'group is not available' using errcode = '42501';
    end if;
    v_target_identity := extensions.digest(
      convert_to(
        'organization:' || p_organization_id::text || ':group:' || p_conversation_id::text,
        'UTF8'
      ),
      'sha256'
    );
  else
    if p_subject_user_id = p_actor_user_id then
      raise exception 'a reporter cannot report themselves' using errcode = '22023';
    end if;
    select coalesce(
      nullif(left(regexp_replace(btrim(profile.display_name), '[[:cntrl:]]', ' ', 'g'), 160), ''),
      'Organization member'
    ) into v_target_label
    from public.organization_memberships target
    join public.organization_memberships viewer
      on viewer.organization_id = target.organization_id
     and viewer.user_id = p_actor_user_id
     and viewer.status = 'active'
    join public.profiles profile on profile.user_id = target.user_id
    where target.organization_id = p_organization_id
      and target.user_id = p_subject_user_id
      and (
        (
          target.status = 'active'
          and
          target.directory_visibility <> 'private'
          and not exists (
            select 1 from public.member_blocks block
            where block.organization_id = target.organization_id
              and (
                (block.blocker_user_id = p_actor_user_id
                  and block.blocked_user_id = target.user_id)
                or (block.blocker_user_id = target.user_id
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
               and target_unit.user_id = target.user_id
              where viewer_unit.organization_id = p_organization_id
                and viewer_unit.user_id = p_actor_user_id
            )
          )
        )
        -- Blocking and offboarding remove directory discovery and
        -- communication, but must not erase a safety-report route for a person
        -- the reporter already knew. These relationship branches deliberately
        -- accept suspended/deactivated targets while the viewer must remain an
        -- active member of the same tenant.
        or exists (
          select 1 from public.contact_connections connection
          where connection.organization_id = target.organization_id
            and connection.status = 'accepted'
            and p_actor_user_id in (
              connection.member_low_user_id, connection.member_high_user_id
            )
            and target.user_id in (
              connection.member_low_user_id, connection.member_high_user_id
            )
            and target.user_id <> p_actor_user_id
        )
        or exists (
          select 1
          from public.conversation_members viewer_conversation
          join public.conversation_members target_conversation
            on target_conversation.organization_id = viewer_conversation.organization_id
           and target_conversation.conversation_id = viewer_conversation.conversation_id
           and target_conversation.user_id = target.user_id
          where viewer_conversation.organization_id = p_organization_id
            and viewer_conversation.user_id = p_actor_user_id
            and viewer_conversation.joined_at
              <= coalesce(target_conversation.left_at, 'infinity'::timestamptz)
            and target_conversation.joined_at
              <= coalesce(viewer_conversation.left_at, 'infinity'::timestamptz)
        )
      )
    for share of target;
    if not found then
      raise exception 'member is not available' using errcode = '42501';
    end if;
    v_subject_user_id := p_subject_user_id;
    v_unit_id := null;
    v_target_identity := extensions.digest(
      convert_to(
        'organization:' || p_organization_id::text || ':member:' || p_subject_user_id::text,
        'UTF8'
      ),
      'sha256'
    );
  end if;

  select * into v_existing
  from private.message_reports report
  where report.organization_id = p_organization_id
    and report.reporter_user_id = p_actor_user_id
    and report.target_identity_sha256 = v_target_identity
    and report.status in ('open', 'assigned', 'in_review');
  if found then
    v_response := jsonb_build_object(
      'report_id', v_existing.id,
      'status', v_existing.status,
      'target_type', v_existing.target_type,
      'created', false,
      'reporter_identity_protected', true,
      'target_not_notified', true,
      'notice_version', v_existing.reporter_notice_version,
      'context_before', v_existing.context_before_count,
      'context_after', v_existing.context_after_count
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, v_route,
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;

  insert into private.message_reports (
    organization_id, target_type, target_label_snapshot, target_identity_sha256,
    conversation_id, message_id, reporter_user_id, subject_user_id,
    conversation_unit_id, category, details, status,
    reporter_notice_version, reporter_consent_at,
    context_before_count, context_after_count
  ) values (
    p_organization_id, p_target_type, v_target_label, v_target_identity,
    p_conversation_id, p_message_id, p_actor_user_id, v_subject_user_id,
    v_unit_id, p_category, nullif(btrim(p_details), ''), 'open',
    p_notice_version, v_consent_at, p_context_before, p_context_after
  )
  on conflict (organization_id, reporter_user_id, target_identity_sha256)
    where status in ('open', 'assigned', 'in_review')
  do nothing
  returning id into v_report_id;

  if v_report_id is null then
    select * into v_existing
    from private.message_reports report
    where report.organization_id = p_organization_id
      and report.reporter_user_id = p_actor_user_id
      and report.target_identity_sha256 = v_target_identity
      and report.status in ('open', 'assigned', 'in_review');
    if not found then
      raise exception 'report creation conflict' using errcode = '55000';
    end if;
    v_response := jsonb_build_object(
      'report_id', v_existing.id,
      'status', v_existing.status,
      'target_type', v_existing.target_type,
      'created', false,
      'reporter_identity_protected', true,
      'target_not_notified', true,
      'notice_version', v_existing.reporter_notice_version,
      'context_before', v_existing.context_before_count,
      'context_after', v_existing.context_after_count
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, v_route,
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;

  if p_target_type = 'message' then
    with visible as (
      select message.id, message.sender_user_id, message.kind, message.body, message.created_at
      from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.deleted_at is null
        and message.available_at <= v_consent_at
        and message.created_at <= v_consent_at
        and message.id <= v_context_max_message_id
        and (v_history_visible_from is null or message.created_at >= v_history_visible_from)
        and not exists (
          select 1 from public.message_user_visibility visibility
          where visibility.organization_id = message.organization_id
            and visibility.conversation_id = message.conversation_id
            and visibility.message_id = message.id
            and visibility.user_id = p_actor_user_id
        )
    ), before_rows as (
      select selected.*,
        -row_number() over (order by selected.id desc)::integer as relative_position
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
  end if;

  insert into private.moderation_case_history (
    organization_id, case_id, actor_user_id, event_type,
    from_status, to_status, reason, evidence_metadata
  ) values (
    p_organization_id, v_report_id, p_actor_user_id, 'reported',
    null, 'open', null,
    jsonb_build_object(
      'target_type', p_target_type,
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
    'target_type', p_target_type,
    'created', true,
    'reporter_identity_protected', true,
    'target_not_notified', true,
    'notice_version', p_notice_version,
    'context_before', p_context_before,
    'context_after', p_context_after
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, v_route,
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

-- Compatibility entry point for already released clients. It inherits all v3
-- target authorization, immutable identity, active-duplicate, and evidence
-- boundary protections while retaining the versioned v1 disclosure receipt.
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
language sql
volatile
security definer
set search_path = ''
as $$
  select private.bff_report_target_v3_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    'message', p_conversation_id, p_message_id, null,
    p_category, p_details, p_consent_to_share,
    p_context_before, p_context_after, p_notice_version,
    p_idempotency_key, p_request_sha256
  )
$$;

-- Gateway aliases use the same strict budget as message reporting. Keeping the
-- three operation names distinct improves audit evidence without falling back
-- to the generic 120/minute policy.
create or replace function private.bff_consume_rate_limit_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_ip_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_limit integer;
  v_window_seconds integer;
  v_retry_at timestamptz;
  v_user_allowed boolean;
  v_session_allowed boolean;
  v_network_allowed boolean := true;
  v_allowed boolean;
begin
  perform private.require_service_role();
  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, p_operation, false, 0
  );
  if not coalesce((v_authorization ->> 'allowed')::boolean, false) then
    return jsonb_build_object(
      'allowed', false, 'retry_after_seconds', 0, 'reason', 'unauthorized'
    );
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid IP hash' using errcode = '22023';
  end if;

  select limits.request_limit, limits.window_seconds
    into v_limit, v_window_seconds
  from (values
    ('message.send', 60, 60),
    ('conversation.direct.create', 10, 3600),
    ('conversation.group.create', 5, 86400),
    ('attachment.upload.create', 10, 60),
    ('message.translate', 30, 60),
    ('translation.enqueue', 30, 60),
    ('message.report', 10, 3600),
    ('conversation.report', 10, 3600),
    ('member.report', 10, 3600),
    ('invite.issue', 20, 3600),
    ('member.suspend', 20, 3600)
  ) as limits(operation, request_limit, window_seconds)
  where limits.operation = p_operation;
  v_limit := coalesce(v_limit, 120);
  v_window_seconds := coalesce(v_window_seconds, 60);

  v_user_allowed := private.consume_rate_limit(
    'bff-user:' || left(p_operation, 71),
    p_organization_id::text || ':' || p_actor_user_id::text,
    v_limit, v_window_seconds
  );
  v_session_allowed := private.consume_rate_limit(
    'bff-session:' || left(p_operation, 68),
    p_organization_id::text || ':' || p_actor_user_id::text || ':' || p_session_id::text,
    v_limit, v_window_seconds
  );
  if p_ip_hash is not null then
    v_network_allowed := private.consume_rate_limit(
      'bff-network:' || left(p_operation, 68),
      p_organization_id::text || ':' || p_ip_hash,
      least(v_limit * 10, 10000), v_window_seconds
    );
  end if;
  v_allowed := v_user_allowed and v_session_allowed and v_network_allowed;

  if not v_allowed then
    select max(
      bucket.window_started_at + make_interval(secs => v_window_seconds)
    ) into v_retry_at
    from private.rate_limit_buckets bucket
    where bucket.window_started_at
        > clock_timestamp() - make_interval(secs => v_window_seconds)
      and (
        (
          bucket.scope = 'bff-user:' || left(p_operation, 71)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_actor_user_id::text, 'sha256'
          )
          and bucket.request_count > v_limit
        )
        or (
          bucket.scope = 'bff-session:' || left(p_operation, 68)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_actor_user_id::text || ':'
              || p_session_id::text,
            'sha256'
          )
          and bucket.request_count > v_limit
        )
        or (
          p_ip_hash is not null
          and bucket.scope = 'bff-network:' || left(p_operation, 68)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_ip_hash, 'sha256'
          )
          and bucket.request_count > least(v_limit * 10, 10000)
        )
      );
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'retry_after_seconds', case when v_allowed then 0 else greatest(1, ceil(
      extract(epoch from (
        coalesce(v_retry_at, clock_timestamp() + make_interval(secs => v_window_seconds))
        - clock_timestamp()
      ))
    )::integer) end,
    'user_bucket_allowed', v_user_allowed,
    'session_bucket_allowed', v_session_allowed,
    'network_bucket_allowed', v_network_allowed
  );
end;
$$;

revoke execute on function
  private.bff_consume_rate_limit_impl(uuid, uuid, uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_consume_rate_limit_impl(uuid, uuid, uuid, text, text)
to service_role;

-- Moderation fanout is a leased worker operation, never a client RPC. The
-- implementation verifies service role, topic, claimant, and lease again so a
-- leaked job id cannot be used to enumerate current investigators.
revoke execute on function
  private.bff_expand_moderation_fanout_impl(uuid, bigint),
  public.bff_expand_moderation_fanout(uuid, bigint)
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_expand_moderation_fanout_impl(uuid, bigint),
  public.bff_expand_moderation_fanout(uuid, bigint)
to service_role;

comment on function public.bff_expand_moderation_fanout(uuid, bigint) is
  'Service-only leased outbox expansion. Resolves current authorized moderation viewers set-wise and enqueues content-free per-user invalidations idempotently.';

commit;
