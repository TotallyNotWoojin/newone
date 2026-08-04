begin;

-- TR-03 / SUM-02: derived-output errors are a distinct quality workflow, not
-- an ordinary people-safety report. The exact derived output is preserved for
-- a scoped reviewer while original messages remain canonical and unchanged.
alter table public.message_translations
  add constraint message_translations_organization_id_id_unique
  unique (organization_id, id);
alter table public.conversation_summaries
  add constraint conversation_summaries_organization_conversation_id_unique
  unique (organization_id, conversation_id, id);

create table private.ai_output_error_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  reporter_user_id uuid not null,
  output_kind text not null,
  translation_id bigint,
  summary_id uuid,
  category text not null,
  details text not null,
  high_consequence boolean not null default false,
  quality_use_consent boolean not null default false,
  consent_version text not null,
  target_source_sha256 bytea not null,
  target_output_sha256 bytea not null,
  target_language text not null,
  target_snapshot jsonb not null,
  status text not null default 'open',
  outcome text,
  version integer not null default 1,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, reporter_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, reviewed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, translation_id)
    references public.message_translations (organization_id, id) on delete restrict,
  foreign key (organization_id, summary_id)
    references public.conversation_summaries (organization_id, id) on delete restrict,
  constraint ai_output_error_reports_kind_allowed check (
    output_kind in ('translation', 'summary')
  ),
  constraint ai_output_error_reports_target_shape check (
    (output_kind = 'translation' and translation_id is not null and summary_id is null)
    or (output_kind = 'summary' and summary_id is not null and translation_id is null)
  ),
  constraint ai_output_error_reports_category_allowed check (
    (output_kind = 'translation' and category in (
      'incorrect_meaning', 'omitted_context', 'terminology', 'unsafe_wording',
      'wrong_language', 'other'
    ))
    or (output_kind = 'summary' and category in (
      'unsupported_claim', 'missing_source', 'incorrect_action',
      'omitted_context', 'unsafe_wording', 'other'
    ))
  ),
  constraint ai_output_error_reports_details_bounded check (
    char_length(btrim(details)) between 3 and 4000
  ),
  constraint ai_output_error_reports_consent_version_bounded check (
    char_length(consent_version) between 3 and 80
  ),
  constraint ai_output_error_reports_hashes check (
    octet_length(target_source_sha256) = 32
    and octet_length(target_output_sha256) = 32
  ),
  constraint ai_output_error_reports_language_bounded check (
    char_length(target_language) between 2 and 35
  ),
  constraint ai_output_error_reports_snapshot_bounded check (
    jsonb_typeof(target_snapshot) = 'object'
    and octet_length(target_snapshot::text) <= 65536
  ),
  constraint ai_output_error_reports_status_allowed check (
    status in ('open', 'reviewing', 'resolved', 'dismissed')
  ),
  constraint ai_output_error_reports_outcome_allowed check (
    outcome is null or outcome in ('confirmed_error', 'not_an_error', 'needs_context')
  ),
  constraint ai_output_error_reports_version_positive check (version > 0),
  constraint ai_output_error_reports_review_note_bounded check (
    review_note is null or char_length(btrim(review_note)) between 3 and 4000
  ),
  constraint ai_output_error_reports_times_finite check (
    isfinite(created_at) and isfinite(updated_at)
    and (reviewed_at is null or isfinite(reviewed_at))
  ),
  constraint ai_output_error_reports_state_consistent check (
    (status = 'open' and outcome is null and reviewed_by_user_id is null
      and reviewed_at is null and review_note is null)
    or (status = 'reviewing' and outcome = 'needs_context'
      and reviewed_by_user_id is not null and reviewed_at is not null
      and review_note is not null)
    or (status = 'resolved' and outcome = 'confirmed_error'
      and reviewed_by_user_id is not null and reviewed_at is not null
      and review_note is not null)
    or (status = 'dismissed' and outcome = 'not_an_error'
      and reviewed_by_user_id is not null and reviewed_at is not null
      and review_note is not null)
  )
);

create unique index ai_output_error_reports_active_translation_idx
  on private.ai_output_error_reports (
    organization_id, reporter_user_id, translation_id
  ) where output_kind = 'translation' and status in ('open', 'reviewing');
create unique index ai_output_error_reports_active_summary_idx
  on private.ai_output_error_reports (
    organization_id, reporter_user_id, summary_id
  ) where output_kind = 'summary' and status in ('open', 'reviewing');
create index ai_output_error_reports_reviewer_queue_idx
  on private.ai_output_error_reports (
    organization_id, status, high_consequence desc, created_at desc, id desc
  );
create index ai_output_error_reports_reporter_idx
  on private.ai_output_error_reports (
    organization_id, reporter_user_id, created_at desc, id desc
  );

create table private.ai_output_error_report_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  report_id uuid not null,
  report_version integer not null,
  actor_user_id uuid,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (organization_id, report_id)
    references private.ai_output_error_reports (organization_id, id) on delete restrict,
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint ai_output_error_report_events_version_positive check (report_version > 0),
  constraint ai_output_error_report_events_type_allowed check (
    event_type in (
      'reported', 'reviewed', 'regression_proposed',
      'regression_approved', 'regression_rejected', 'regression_exported'
    )
  ),
  constraint ai_output_error_report_events_metadata_bounded check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8192
  ),
  constraint ai_output_error_report_events_created_finite check (isfinite(created_at))
);

create table private.ai_regression_examples (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  report_id uuid not null,
  output_kind text not null,
  source_language text not null,
  target_language text not null,
  deidentified_source_text text not null,
  deidentified_observed_output text not null,
  deidentified_expected_output text not null,
  error_category text not null,
  consequence_level text not null,
  attestation_version text not null,
  proposed_by_user_id uuid not null,
  proposed_at timestamptz not null default now(),
  status text not null default 'pending',
  version integer not null default 1,
  decided_by_user_id uuid,
  decided_at timestamptz,
  decision_note text,
  exported_at timestamptz,
  export_worker_hash bytea,
  unique (organization_id, id),
  foreign key (organization_id, report_id)
    references private.ai_output_error_reports (organization_id, id) on delete restrict,
  foreign key (organization_id, proposed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, decided_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint ai_regression_examples_kind_allowed check (
    output_kind in ('translation', 'summary')
  ),
  constraint ai_regression_examples_language_format check (
    source_language ~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
    and target_language ~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
  ),
  constraint ai_regression_examples_text_bounded check (
    char_length(btrim(deidentified_source_text)) between 1 and 20000
    and char_length(btrim(deidentified_observed_output)) between 1 and 30000
    and char_length(btrim(deidentified_expected_output)) between 1 and 30000
    and btrim(deidentified_observed_output) <> btrim(deidentified_expected_output)
  ),
  constraint ai_regression_examples_category_bounded check (
    char_length(error_category) between 3 and 80
  ),
  constraint ai_regression_examples_consequence_allowed check (
    consequence_level in ('standard', 'high_consequence')
  ),
  constraint ai_regression_examples_attestation_bounded check (
    char_length(attestation_version) between 3 and 80
  ),
  constraint ai_regression_examples_status_allowed check (
    status in ('pending', 'approved', 'rejected', 'exported')
  ),
  constraint ai_regression_examples_version_positive check (version > 0),
  constraint ai_regression_examples_decision_note_bounded check (
    decision_note is null or char_length(btrim(decision_note)) between 3 and 4000
  ),
  constraint ai_regression_examples_actor_separation check (
    decided_by_user_id is null or decided_by_user_id <> proposed_by_user_id
  ),
  constraint ai_regression_examples_worker_hash check (
    export_worker_hash is null or octet_length(export_worker_hash) = 32
  ),
  constraint ai_regression_examples_times_finite check (
    isfinite(proposed_at)
    and (decided_at is null or isfinite(decided_at))
    and (exported_at is null or isfinite(exported_at))
  ),
  constraint ai_regression_examples_state_consistent check (
    (status = 'pending' and decided_by_user_id is null and decided_at is null
      and decision_note is null and exported_at is null and export_worker_hash is null)
    or (status in ('approved', 'rejected') and decided_by_user_id is not null
      and decided_at is not null and decision_note is not null
      and exported_at is null and export_worker_hash is null)
    or (status = 'exported' and decided_by_user_id is not null
      and decided_at is not null and decision_note is not null
      and exported_at is not null and export_worker_hash is not null)
  )
);

create unique index ai_regression_examples_one_active_report_idx
  on private.ai_regression_examples (organization_id, report_id)
  where status in ('pending', 'approved', 'exported');
create index ai_regression_examples_export_queue_idx
  on private.ai_regression_examples (status, decided_at, id)
  where status = 'approved';

-- Rejection used to erase the reviewer from the summary projection. Preserve
-- the reviewer on the immutable rejected version and also append an exact
-- review record for both decisions.
alter table public.conversation_summaries
  drop constraint conversation_summaries_review_consistent;
alter table public.conversation_summaries
  add constraint conversation_summaries_review_consistent check (
    (status = 'approved' and reviewed_by_user_id is not null and reviewed_at is not null)
    or (status = 'failed' and failure_code = 'human_rejected'
      and reviewed_by_user_id is not null and reviewed_at is not null
      and review_note is not null)
    or (not (status = 'approved' or (status = 'failed' and failure_code = 'human_rejected'))
      and reviewed_by_user_id is null and reviewed_at is null)
  );

create table private.conversation_summary_review_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  summary_id uuid not null,
  summary_version integer not null,
  reviewer_user_id uuid not null,
  reviewer_conversation_role text not null,
  decision text not null,
  note text,
  source_fingerprint bytea not null,
  output_fingerprint bytea not null,
  audit_correlation_id uuid not null default gen_random_uuid(),
  reviewed_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, conversation_id, summary_id)
    references public.conversation_summaries (organization_id, conversation_id, id)
    on delete restrict,
  foreign key (organization_id, conversation_id, reviewer_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id)
    on delete restrict,
  constraint conversation_summary_review_records_version_positive check (
    summary_version > 0
  ),
  constraint conversation_summary_review_records_role_allowed check (
    reviewer_conversation_role in ('owner', 'admin')
  ),
  constraint conversation_summary_review_records_decision_allowed check (
    decision in ('approve', 'reject')
  ),
  constraint conversation_summary_review_records_note_bounded check (
    note is null or char_length(btrim(note)) between 1 and 4000
  ),
  constraint conversation_summary_review_records_hashes check (
    octet_length(source_fingerprint) = 32 and octet_length(output_fingerprint) = 32
  ),
  constraint conversation_summary_review_records_reviewed_finite check (
    isfinite(reviewed_at)
  )
);

create index conversation_summary_review_records_summary_idx
  on private.conversation_summary_review_records (
    organization_id, summary_id, reviewed_at desc, id desc
  );

alter table private.ai_output_error_reports enable row level security;
alter table private.ai_output_error_reports force row level security;
alter table private.ai_output_error_report_events enable row level security;
alter table private.ai_output_error_report_events force row level security;
alter table private.ai_regression_examples enable row level security;
alter table private.ai_regression_examples force row level security;
alter table private.conversation_summary_review_records enable row level security;
alter table private.conversation_summary_review_records force row level security;
revoke all on table private.ai_output_error_reports from public, anon, authenticated, service_role;
revoke all on table private.ai_output_error_report_events from public, anon, authenticated, service_role;
revoke all on table private.ai_regression_examples from public, anon, authenticated, service_role;
revoke all on table private.conversation_summary_review_records from public, anon, authenticated, service_role;

create or replace function private.prevent_ai_quality_record_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception 'AI quality evidence is immutable' using errcode = '55000';
end;
$$;


create or replace function private.ai_output_report_reviewer_allowed(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid,
  p_output_kind text
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
    join public.organization_memberships membership
      on membership.organization_id = conversation.organization_id
     and membership.user_id = p_actor_user_id
     and membership.status = 'active'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and (
        private.actor_has_permission(
          p_actor_user_id, p_organization_id, 'language.review', conversation.unit_id
        )
        or (
          p_output_kind = 'summary'
          and exists (
            select 1 from public.conversation_members member
            where member.organization_id = conversation.organization_id
              and member.conversation_id = conversation.id
              and member.user_id = p_actor_user_id
              and member.status = 'active'
              and member.role in ('owner', 'admin')
          )
        )
      )
  )
$$;

create or replace function private.ai_output_error_report_response_internal(
  p_report private.ai_output_error_reports,
  p_include_reviewer_fields boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'report_id', p_report.id,
    'output_kind', p_report.output_kind,
    'translation_id', p_report.translation_id,
    'summary_id', p_report.summary_id,
    'conversation_id', p_report.conversation_id,
    'category', p_report.category,
    'details', p_report.details,
    'high_consequence', p_report.high_consequence,
    'quality_use_consent', p_report.quality_use_consent,
    'consent_version', p_report.consent_version,
    'target_source_fingerprint', encode(p_report.target_source_sha256, 'hex'),
    'target_output_fingerprint', encode(p_report.target_output_sha256, 'hex'),
    'target_language', p_report.target_language,
    'target_snapshot', p_report.target_snapshot,
    'status', p_report.status,
    'outcome', p_report.outcome,
    'version', p_report.version,
    'reviewed_by_user_id', case when p_include_reviewer_fields
      then p_report.reviewed_by_user_id else null end,
    'reviewed_at', p_report.reviewed_at,
    'review_note', p_report.review_note,
    'created_at', p_report.created_at,
    'updated_at', p_report.updated_at
  ))
$$;

create or replace function private.ai_regression_example_response_internal(
  p_example private.ai_regression_examples
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'example_id', p_example.id,
    'report_id', p_example.report_id,
    'output_kind', p_example.output_kind,
    'source_language', p_example.source_language,
    'target_language', p_example.target_language,
    'deidentified_source_text', p_example.deidentified_source_text,
    'deidentified_observed_output', p_example.deidentified_observed_output,
    'deidentified_expected_output', p_example.deidentified_expected_output,
    'error_category', p_example.error_category,
    'consequence_level', p_example.consequence_level,
    'attestation_version', p_example.attestation_version,
    'proposed_by_user_id', p_example.proposed_by_user_id,
    'proposed_at', p_example.proposed_at,
    'status', p_example.status,
    'version', p_example.version,
    'decided_by_user_id', p_example.decided_by_user_id,
    'decided_at', p_example.decided_at,
    'decision_note', p_example.decision_note,
    'exported_at', p_example.exported_at
  ))
$$;

create or replace function private.bff_list_my_ai_output_error_reports_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reports jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai_output.error_reports.read_self', false, 0
  );
  if p_limit not between 1 and 100 then
    raise exception 'invalid AI output error report limit' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row.payload order by row.created_at desc, row.report_id desc), '[]'::jsonb)
    into v_reports
  from (
    select report.id as report_id, report.created_at,
      private.ai_output_error_report_response_internal(report, false) as payload
    from private.ai_output_error_reports report
    where report.organization_id = p_organization_id
      and report.reporter_user_id = p_actor_user_id
      and (
        (
          report.output_kind = 'translation'
          and private.translation_mode_for_user_internal(
            p_organization_id, report.conversation_id, p_actor_user_id
          ) = 'automatic'
          and exists (
            select 1 from public.message_translations translation
            where translation.organization_id = report.organization_id
              and translation.id = report.translation_id
              and private.dynamic_group_message_access_allowed_for_user(
                report.organization_id, report.conversation_id,
                translation.message_id, p_actor_user_id, statement_timestamp()
              )
          )
        )
        or (
          report.output_kind = 'summary'
          and exists (
            select 1 from public.conversation_summaries summary
            where summary.organization_id = report.organization_id
              and summary.id = report.summary_id
              and not exists (
                select 1 from unnest(summary.source_message_ids) source_id
                where not private.dynamic_group_message_access_allowed_for_user(
                  report.organization_id, report.conversation_id,
                  source_id, p_actor_user_id, statement_timestamp()
                )
              )
          )
        )
      )
    order by report.created_at desc, report.id desc
    limit p_limit
  ) row;
  return jsonb_build_object('reports', v_reports);
end;
$$;

create or replace function private.bff_list_ai_output_error_reports_for_review_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_reports jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai_output.error_reports.review_queue', true, 300
  );
  if p_limit not between 1 and 100 then
    raise exception 'invalid AI output review queue limit' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row.payload order by row.high_consequence desc, row.created_at, row.report_id), '[]'::jsonb)
    into v_reports
  from (
    select report.id as report_id, report.high_consequence, report.created_at,
      private.ai_output_error_report_response_internal(report, true) as payload
    from private.ai_output_error_reports report
    where report.organization_id = p_organization_id
      and report.status in ('open', 'reviewing')
      and private.ai_output_report_reviewer_allowed(
        p_actor_user_id, p_organization_id, report.conversation_id, report.output_kind
      )
    order by report.high_consequence desc, report.created_at, report.id
    limit p_limit
  ) row;
  return jsonb_build_object('reports', v_reports);
end;
$$;

create or replace function private.bff_read_ai_output_error_report_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_report_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_report private.ai_output_error_reports%rowtype;
  v_example private.ai_regression_examples%rowtype;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai_output.error_report.read', true, 300
  );
  select report.* into v_report
  from private.ai_output_error_reports report
  where report.organization_id = p_organization_id and report.id = p_report_id;
  if not found or not private.ai_output_report_reviewer_allowed(
    p_actor_user_id, p_organization_id, v_report.conversation_id, v_report.output_kind
  ) then
    raise exception 'AI output error report unavailable' using errcode = '42501';
  end if;
  select example.* into v_example
  from private.ai_regression_examples example
  where example.organization_id = p_organization_id and example.report_id = p_report_id
  order by example.proposed_at desc, example.id desc limit 1;
  return jsonb_build_object(
    'report', private.ai_output_error_report_response_internal(v_report, true),
    'regression_example', case when v_example.id is null then null
      else private.ai_regression_example_response_internal(v_example) end
  );
end;
$$;

create or replace function private.bff_review_ai_output_error_report_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_report_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_review_note text,
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
  v_report private.ai_output_error_reports%rowtype;
  v_status text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai_output.error_report.review', true, 300,
    '/v2/ai-output-error-reports/:id/review', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version is null or p_expected_version < 1
    or p_outcome not in ('confirmed_error', 'not_an_error', 'needs_context')
    or char_length(btrim(coalesce(p_review_note, ''))) not between 3 and 4000 then
    raise exception 'valid AI output error review required' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'ai-output-error-review-hour',
    p_organization_id::text || ':' || p_actor_user_id::text, 100, 3600
  ) then
    raise exception 'AI output error review limit exceeded' using errcode = 'P0001';
  end if;

  select report.* into v_report
  from private.ai_output_error_reports report
  where report.organization_id = p_organization_id and report.id = p_report_id
  for update;
  if not found
    or v_report.version <> p_expected_version
    or v_report.status not in ('open', 'reviewing') then
    raise exception 'AI output error report version conflict' using errcode = '40001';
  end if;
  if not private.ai_output_report_reviewer_allowed(
    p_actor_user_id, p_organization_id, v_report.conversation_id, v_report.output_kind
  ) then
    raise exception 'AI output error reviewer scope required' using errcode = '42501';
  end if;

  v_status := case p_outcome
    when 'confirmed_error' then 'resolved'
    when 'not_an_error' then 'dismissed'
    else 'reviewing'
  end;
  update private.ai_output_error_reports report
  set status = v_status,
      outcome = p_outcome,
      version = report.version + 1,
      reviewed_by_user_id = p_actor_user_id,
      reviewed_at = clock_timestamp(),
      review_note = btrim(p_review_note)
  where report.organization_id = p_organization_id and report.id = p_report_id
  returning report.* into v_report;

  insert into private.ai_output_error_report_events (
    organization_id, report_id, report_version, actor_user_id, event_type, metadata
  ) values (
    p_organization_id, v_report.id, v_report.version, p_actor_user_id, 'reviewed',
    jsonb_build_object(
      'outcome', p_outcome, 'status', v_status,
      'high_consequence', v_report.high_consequence
    )
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'ai_output.error.reviewed',
    'ai_output_error_report', v_report.id::text,
    jsonb_build_object(
      'outcome', p_outcome, 'report_version', v_report.version,
      'high_consequence', v_report.high_consequence
    )
  );
  v_response := private.ai_output_error_report_response_internal(v_report, true)
    || jsonb_build_object('originals_unchanged', true);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/ai-output-error-reports/:id/review',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_propose_ai_regression_example_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_report_id uuid,
  p_expected_report_version integer,
  p_source_language text,
  p_deidentified_source_text text,
  p_deidentified_observed_output text,
  p_deidentified_expected_output text,
  p_deidentification_attested boolean,
  p_attestation_version text,
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
  v_report private.ai_output_error_reports%rowtype;
  v_example private.ai_regression_examples%rowtype;
  v_consequence text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai_output.regression.propose', true, 300,
    '/v2/ai-output-error-reports/:id/regression-examples',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_report_version is null or p_expected_report_version < 1
    or p_deidentification_attested is distinct from true
    or p_source_language !~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
    or char_length(btrim(coalesce(p_deidentified_source_text, ''))) not between 1 and 20000
    or char_length(btrim(coalesce(p_deidentified_observed_output, ''))) not between 1 and 30000
    or char_length(btrim(coalesce(p_deidentified_expected_output, ''))) not between 1 and 30000
    or btrim(p_deidentified_observed_output) = btrim(p_deidentified_expected_output)
    or char_length(coalesce(p_attestation_version, '')) not between 3 and 80 then
    raise exception 'valid deidentified regression proposal and attestation required'
      using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'ai-regression-proposal-hour',
    p_organization_id::text || ':' || p_actor_user_id::text, 20, 3600
  ) then
    raise exception 'AI regression proposal limit exceeded' using errcode = 'P0001';
  end if;

  select report.* into v_report
  from private.ai_output_error_reports report
  where report.organization_id = p_organization_id and report.id = p_report_id
  for update;
  if not found or v_report.version <> p_expected_report_version
    or v_report.status <> 'resolved' or v_report.outcome <> 'confirmed_error' then
    raise exception 'confirmed AI output error version required' using errcode = '40001';
  end if;
  if not v_report.quality_use_consent then
    raise exception 'quality-use consent is required for regression proposal'
      using errcode = '42501';
  end if;
  if not private.ai_output_report_reviewer_allowed(
    p_actor_user_id, p_organization_id, v_report.conversation_id, v_report.output_kind
  ) then
    raise exception 'AI output reviewer scope required' using errcode = '42501';
  end if;
  if v_report.high_consequence and not exists (
    select 1 from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = v_report.conversation_id
      and private.actor_has_permission(
        p_actor_user_id, p_organization_id, 'language.review', conversation.unit_id
      )
  ) then
    raise exception 'high-consequence regression requires a language reviewer'
      using errcode = '42501';
  end if;

  select example.* into v_example
  from private.ai_regression_examples example
  where example.organization_id = p_organization_id
    and example.report_id = p_report_id
    and example.status in ('pending', 'approved', 'exported')
  order by example.proposed_at desc, example.id desc limit 1;
  if found then
    v_response := private.ai_regression_example_response_internal(v_example)
      || jsonb_build_object('deduplicated', true);
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id,
      '/v2/ai-output-error-reports/:id/regression-examples',
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;

  v_consequence := case when v_report.high_consequence
    then 'high_consequence' else 'standard' end;
  insert into private.ai_regression_examples (
    organization_id, report_id, output_kind, source_language, target_language,
    deidentified_source_text, deidentified_observed_output,
    deidentified_expected_output, error_category, consequence_level,
    attestation_version, proposed_by_user_id
  ) values (
    p_organization_id, p_report_id, v_report.output_kind, lower(p_source_language),
    lower(v_report.target_language), btrim(p_deidentified_source_text),
    btrim(p_deidentified_observed_output), btrim(p_deidentified_expected_output),
    v_report.category, v_consequence, p_attestation_version, p_actor_user_id
  ) returning * into v_example;
  insert into private.ai_output_error_report_events (
    organization_id, report_id, report_version, actor_user_id, event_type, metadata
  ) values (
    p_organization_id, p_report_id, v_report.version, p_actor_user_id,
    'regression_proposed', jsonb_build_object(
      'consequence_level', v_consequence,
      'attestation_version', p_attestation_version,
      'deidentification_attested', true,
      'consent_version', v_report.consent_version
    )
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'ai_output.regression.proposed',
    'ai_output_error_report', p_report_id::text,
    jsonb_build_object(
      'consequence_level', v_consequence,
      'deidentification_attested', true,
      'consent_version', v_report.consent_version
    )
  );
  v_response := private.ai_regression_example_response_internal(v_example)
    || jsonb_build_object('deduplicated', false);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/ai-output-error-reports/:id/regression-examples',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_decide_ai_regression_example_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_example_id uuid,
  p_expected_version integer,
  p_decision text,
  p_decision_note text,
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
  v_example private.ai_regression_examples%rowtype;
  v_report private.ai_output_error_reports%rowtype;
  v_event_type text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai_output.regression.decide', true, 300,
    '/v2/ai-regression-examples/:id/decision',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_expected_version is null or p_expected_version < 1
    or p_decision not in ('approved', 'rejected')
    or char_length(btrim(coalesce(p_decision_note, ''))) not between 3 and 4000 then
    raise exception 'valid AI regression decision required' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'ai-regression-decision-hour',
    p_organization_id::text || ':' || p_actor_user_id::text, 50, 3600
  ) then
    raise exception 'AI regression decision limit exceeded' using errcode = 'P0001';
  end if;

  select example.* into v_example
  from private.ai_regression_examples example
  where example.organization_id = p_organization_id and example.id = p_example_id
  for update;
  if not found or v_example.version <> p_expected_version
    or v_example.status <> 'pending' then
    raise exception 'AI regression example version conflict' using errcode = '40001';
  end if;
  if v_example.proposed_by_user_id = p_actor_user_id then
    raise exception 'a distinct second reviewer is required' using errcode = '42501';
  end if;
  select report.* into v_report
  from private.ai_output_error_reports report
  where report.organization_id = p_organization_id and report.id = v_example.report_id;
  if not found or not private.ai_output_report_reviewer_allowed(
    p_actor_user_id, p_organization_id, v_report.conversation_id, v_report.output_kind
  ) then
    raise exception 'AI output reviewer scope required' using errcode = '42501';
  end if;
  if v_example.consequence_level = 'high_consequence' and not exists (
    select 1 from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = v_report.conversation_id
      and private.actor_has_permission(
        p_actor_user_id, p_organization_id, 'language.review', conversation.unit_id
      )
  ) then
    raise exception 'high-consequence regression requires a language reviewer'
      using errcode = '42501';
  end if;

  update private.ai_regression_examples example
  set status = p_decision,
      version = example.version + 1,
      decided_by_user_id = p_actor_user_id,
      decided_at = clock_timestamp(),
      decision_note = btrim(p_decision_note)
  where example.organization_id = p_organization_id and example.id = p_example_id
  returning example.* into v_example;
  v_event_type := case when p_decision = 'approved'
    then 'regression_approved' else 'regression_rejected' end;
  insert into private.ai_output_error_report_events (
    organization_id, report_id, report_version, actor_user_id, event_type, metadata
  ) values (
    p_organization_id, v_report.id, v_report.version, p_actor_user_id,
    v_event_type, jsonb_build_object(
      'example_version', v_example.version,
      'consequence_level', v_example.consequence_level
    )
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id,
    'ai_output.regression.' || p_decision,
    'ai_output_error_report', v_report.id::text,
    jsonb_build_object(
      'example_version', v_example.version,
      'consequence_level', v_example.consequence_level
    )
  );
  v_response := private.ai_regression_example_response_internal(v_example);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/ai-regression-examples/:id/decision',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_claim_ai_regression_examples_impl(
  p_worker_hash bytea,
  p_limit integer default 20
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_examples jsonb := '[]'::jsonb;
  v_claimed integer := 0;
begin
  perform private.require_service_role();
  if octet_length(p_worker_hash) <> 32 or p_limit not between 1 and 100 then
    raise exception 'valid regression export worker and bound required' using errcode = '22023';
  end if;
  perform set_config('app.ai_regression_export_context', 'on', true);
  for v_row in
    select example.*, report.version as report_version
    from private.ai_regression_examples example
    join private.ai_output_error_reports report
      on report.organization_id = example.organization_id
     and report.id = example.report_id
    where example.status = 'approved'
    order by example.decided_at, example.id
    for update of example skip locked
    limit p_limit
  loop
    update private.ai_regression_examples example
    set status = 'exported',
        version = example.version + 1,
        exported_at = clock_timestamp(),
        export_worker_hash = p_worker_hash
    where example.organization_id = v_row.organization_id and example.id = v_row.id;
    insert into private.ai_output_error_report_events (
      organization_id, report_id, report_version, actor_user_id, event_type, metadata
    ) values (
      v_row.organization_id, v_row.report_id, v_row.report_version, null,
      'regression_exported', jsonb_build_object(
        'consequence_level', v_row.consequence_level,
        'worker_fingerprint', encode(p_worker_hash, 'hex')
      )
    );
    v_examples := v_examples || jsonb_build_array(jsonb_build_object(
      'schema_version', 1,
      'output_kind', v_row.output_kind,
      'source_language', v_row.source_language,
      'target_language', v_row.target_language,
      'source_text', v_row.deidentified_source_text,
      'observed_output', v_row.deidentified_observed_output,
      'expected_output', v_row.deidentified_expected_output,
      'error_category', v_row.error_category,
      'consequence_level', v_row.consequence_level,
      'attestation_version', v_row.attestation_version
    ));
    v_claimed := v_claimed + 1;
  end loop;
  perform set_config('app.ai_regression_export_context', 'off', true);
  return jsonb_build_object(
    'schema_version', 1,
    'claimed_count', v_claimed,
    'examples', v_examples
  );
end;
$$;

-- Preserve the exact reviewer and source/output fingerprints even when a
-- rejected draft's derived body is cleared from the member-facing summary.
create or replace function private.bff_review_conversation_summary_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_summary_id uuid, p_decision text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_summary public.conversation_summaries%rowtype;
  v_reviewer_role text;
  v_reviewed_at timestamptz := clock_timestamp();
  v_correlation_id uuid := gen_random_uuid();
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'summary.review', false, 0, '/v2/summaries/:id/review',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select summary.* into v_summary
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id and summary.id = p_summary_id
  for update;
  if not found or v_summary.status <> 'draft'
    or p_decision not in ('approve', 'reject')
    or (p_decision = 'reject'
      and char_length(btrim(coalesce(p_note, ''))) not between 3 and 4000)
    or (p_note is not null and char_length(btrim(p_note)) not between 1 and 4000) then
    raise exception 'authorized summary review required' using errcode = '42501';
  end if;
  select member.role into v_reviewer_role
  from public.conversation_members member
  where member.organization_id = p_organization_id
    and member.conversation_id = v_summary.conversation_id
    and member.user_id = p_actor_user_id
    and member.status = 'active'
    and member.role in ('owner', 'admin');
  if not found then
    raise exception 'authorized summary review required' using errcode = '42501';
  end if;

  insert into private.conversation_summary_review_records (
    organization_id, conversation_id, summary_id, summary_version,
    reviewer_user_id, reviewer_conversation_role, decision, note,
    source_fingerprint, output_fingerprint, audit_correlation_id, reviewed_at
  ) values (
    p_organization_id, v_summary.conversation_id, v_summary.id,
    v_summary.version_number, p_actor_user_id, v_reviewer_role, p_decision,
    nullif(btrim(p_note), ''), v_summary.source_fingerprint,
    v_summary.output_fingerprint, v_correlation_id, v_reviewed_at
  );
  if p_decision = 'approve' then
    update public.conversation_summaries summary
    set status = 'approved', reviewed_by_user_id = p_actor_user_id,
        reviewed_at = v_reviewed_at, review_note = nullif(btrim(p_note), ''),
        updated_at = v_reviewed_at
    where summary.organization_id = p_organization_id and summary.id = p_summary_id;
  else
    update public.conversation_summaries summary
    set status = 'failed', primary_topic = null, summary_body = null,
        key_topics = null, decisions = null, action_items = null, ambiguities = null,
        output_fingerprint = null, processor_type = null,
        provider = null, model = null, processor_provenance = '{}'::jsonb,
        failure_code = 'human_rejected',
        reviewed_by_user_id = p_actor_user_id,
        reviewed_at = v_reviewed_at,
        review_note = btrim(p_note), updated_at = v_reviewed_at
    where summary.organization_id = p_organization_id and summary.id = p_summary_id;
  end if;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.summary.reviewed',
    'conversation_summary', p_summary_id::text,
    jsonb_build_object(
      'decision', p_decision,
      'summary_version', v_summary.version_number,
      'reviewer_conversation_role', v_reviewer_role,
      'audit_correlation_id', v_correlation_id,
      'source_fingerprint', encode(v_summary.source_fingerprint, 'hex'),
      'output_fingerprint', encode(v_summary.output_fingerprint, 'hex'),
      'originals_unchanged', true,
      'work_assignment_created', false
    )
  );
  v_response := jsonb_build_object(
    'summary_id', p_summary_id,
    'version_number', v_summary.version_number,
    'status', case when p_decision = 'approve' then 'approved' else 'failed' end,
    'human_reviewed', true,
    'reviewed_by_user_id', p_actor_user_id,
    'reviewed_at', v_reviewed_at,
    'reviewer_conversation_role', v_reviewer_role,
    'audit_correlation_id', v_correlation_id,
    'originals_unchanged', true,
    'work_assignment_created', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/summaries/:id/review',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create trigger ai_output_error_report_events_immutable
before update or delete on private.ai_output_error_report_events
for each row execute function private.prevent_ai_quality_record_mutation();
create trigger conversation_summary_review_records_immutable
before update or delete on private.conversation_summary_review_records
for each row execute function private.prevent_ai_quality_record_mutation();

create or replace function private.validate_ai_output_error_report_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if tg_op = 'DELETE' then
    raise exception 'AI output error evidence is immutable' using errcode = '55000';
  end if;
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
    or v_actor_user_id is null then
    raise exception 'AI output error review requires a trusted BFF workflow'
      using errcode = '42501';
  end if;
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.reporter_user_id is distinct from old.reporter_user_id
    or new.output_kind is distinct from old.output_kind
    or new.translation_id is distinct from old.translation_id
    or new.summary_id is distinct from old.summary_id
    or new.category is distinct from old.category
    or new.details is distinct from old.details
    or new.high_consequence is distinct from old.high_consequence
    or new.quality_use_consent is distinct from old.quality_use_consent
    or new.consent_version is distinct from old.consent_version
    or new.target_source_sha256 is distinct from old.target_source_sha256
    or new.target_output_sha256 is distinct from old.target_output_sha256
    or new.target_language is distinct from old.target_language
    or new.target_snapshot is distinct from old.target_snapshot
    or new.created_at is distinct from old.created_at
    or old.status not in ('open', 'reviewing')
    or new.version <> old.version + 1
    or new.reviewed_by_user_id is distinct from v_actor_user_id
    or new.reviewed_at is null
    or new.review_note is null then
    raise exception 'AI output error report transition conflict' using errcode = '40001';
  end if;
  if not (
    (new.status = 'reviewing' and new.outcome = 'needs_context')
    or (new.status = 'resolved' and new.outcome = 'confirmed_error')
    or (new.status = 'dismissed' and new.outcome = 'not_an_error')
  ) then
    raise exception 'invalid AI output error report transition' using errcode = '22023';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger ai_output_error_reports_validate_update
before update or delete on private.ai_output_error_reports
for each row execute function private.validate_ai_output_error_report_update();

create or replace function private.validate_ai_regression_example_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
begin
  if tg_op = 'DELETE' then
    raise exception 'AI regression evidence is immutable' using errcode = '55000';
  end if;
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.report_id is distinct from old.report_id
    or new.output_kind is distinct from old.output_kind
    or new.source_language is distinct from old.source_language
    or new.target_language is distinct from old.target_language
    or new.deidentified_source_text is distinct from old.deidentified_source_text
    or new.deidentified_observed_output is distinct from old.deidentified_observed_output
    or new.deidentified_expected_output is distinct from old.deidentified_expected_output
    or new.error_category is distinct from old.error_category
    or new.consequence_level is distinct from old.consequence_level
    or new.attestation_version is distinct from old.attestation_version
    or new.proposed_by_user_id is distinct from old.proposed_by_user_id
    or new.proposed_at is distinct from old.proposed_at
    or new.version <> old.version + 1 then
    raise exception 'AI regression example transition conflict' using errcode = '40001';
  end if;
  if old.status = 'pending' and new.status in ('approved', 'rejected') then
    if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
      or v_actor_user_id is null
      or new.decided_by_user_id is distinct from v_actor_user_id
      or new.decided_by_user_id = old.proposed_by_user_id
      or new.decided_at is null
      or new.decision_note is null
      or new.exported_at is not null
      or new.export_worker_hash is not null then
      raise exception 'AI regression decision requires a distinct trusted reviewer'
        using errcode = '42501';
    end if;
    return new;
  end if;
  if old.status = 'approved' and new.status = 'exported' then
    if coalesce(current_setting('app.ai_regression_export_context', true), 'off') <> 'on'
      or new.decided_by_user_id is distinct from old.decided_by_user_id
      or new.decided_at is distinct from old.decided_at
      or new.decision_note is distinct from old.decision_note
      or new.exported_at is null
      or new.export_worker_hash is null then
      raise exception 'AI regression export requires a trusted worker claim'
        using errcode = '42501';
    end if;
    return new;
  end if;
  raise exception 'AI regression example is immutable in this state' using errcode = '55000';
end;
$$;

create trigger ai_regression_examples_validate_update
before update or delete on private.ai_regression_examples
for each row execute function private.validate_ai_regression_example_update();

create or replace function private.bff_report_ai_output_error_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_output_kind text,
  p_translation_id bigint,
  p_summary_id uuid,
  p_category text,
  p_details text,
  p_high_consequence boolean,
  p_quality_use_consent boolean,
  p_consent_version text,
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
  v_translation public.message_translations%rowtype;
  v_summary public.conversation_summaries%rowtype;
  v_report private.ai_output_error_reports%rowtype;
  v_snapshot jsonb;
  v_source_sha256 bytea;
  v_output_sha256 bytea;
  v_conversation_id uuid;
  v_target_language text;
  v_deduplicated boolean := false;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai_output.error.report', false, 0,
    '/v2/ai-output-error-reports', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_output_kind not in ('translation', 'summary')
    or (p_output_kind = 'translation' and (p_translation_id is null or p_summary_id is not null))
    or (p_output_kind = 'summary' and (p_summary_id is null or p_translation_id is not null))
    or char_length(btrim(coalesce(p_details, ''))) not between 3 and 4000
    or char_length(coalesce(p_consent_version, '')) not between 3 and 80
    or p_high_consequence is null or p_quality_use_consent is null
    or (p_output_kind = 'translation' and p_category not in (
      'incorrect_meaning', 'omitted_context', 'terminology', 'unsafe_wording',
      'wrong_language', 'other'
    ))
    or (p_output_kind = 'summary' and p_category not in (
      'unsupported_claim', 'missing_source', 'incorrect_action',
      'omitted_context', 'unsafe_wording', 'other'
    )) then
    raise exception 'valid AI output error report required' using errcode = '22023';
  end if;

  -- Serialize one reporter/target across idempotency keys. The active unique
  -- indexes remain the final concurrent-write backstop.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_organization_id::text || ':ai-output-report:' || p_actor_user_id::text || ':'
      || p_output_kind || ':' || coalesce(p_translation_id::text, p_summary_id::text),
    0
  ));

  if p_output_kind = 'translation' then
    if private.translation_mode_for_user_internal(
      p_organization_id,
      (select translation.conversation_id from public.message_translations translation
        where translation.organization_id = p_organization_id
          and translation.id = p_translation_id),
      p_actor_user_id
    ) <> 'automatic' then
      raise exception 'reportable translation unavailable' using errcode = '42501';
    end if;
    select translation.* into v_translation
    from public.message_translations translation
    where translation.organization_id = p_organization_id
      and translation.id = p_translation_id
      and translation.status = 'completed';
    if not found or not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, v_translation.conversation_id,
      v_translation.message_id, p_actor_user_id, now()
    ) then
      raise exception 'reportable translation unavailable' using errcode = '42501';
    end if;
    v_conversation_id := v_translation.conversation_id;
    v_target_language := v_translation.target_language;
    v_source_sha256 := v_translation.source_body_sha256;
    v_output_sha256 := extensions.digest(
      convert_to(v_translation.translated_body, 'UTF8'), 'sha256'
    );
    v_snapshot := jsonb_build_object(
      'schema_version', 1,
      'translation_id', v_translation.id,
      'message_id', v_translation.message_id,
      'source_language', v_translation.source_language,
      'target_language', v_translation.target_language,
      'translated_body', v_translation.translated_body,
      'provider', v_translation.provider,
      'model', v_translation.model,
      'confidence', v_translation.confidence,
      'source_body_fingerprint', encode(v_translation.source_body_sha256, 'hex'),
      'output_fingerprint', encode(v_output_sha256, 'hex'),
      'completed_at', v_translation.updated_at
    );
  else
    select summary.* into v_summary
    from public.conversation_summaries summary
    where summary.organization_id = p_organization_id
      and summary.id = p_summary_id
      and summary.status in ('draft', 'approved')
      and summary.output_fingerprint is not null;
    if not found or exists (
      select 1 from unnest(v_summary.source_message_ids) source_id
      where not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, v_summary.conversation_id,
        source_id, p_actor_user_id, now()
      )
    ) then
      raise exception 'reportable summary unavailable' using errcode = '42501';
    end if;
    v_conversation_id := v_summary.conversation_id;
    v_target_language := v_summary.language_code;
    v_source_sha256 := v_summary.source_fingerprint;
    v_output_sha256 := v_summary.output_fingerprint;
    v_snapshot := jsonb_build_object(
      'schema_version', 1,
      'summary_id', v_summary.id,
      'version_number', v_summary.version_number,
      'source_message_ids', to_jsonb(v_summary.source_message_ids),
      'source_fingerprint', encode(v_summary.source_fingerprint, 'hex'),
      'output_fingerprint', encode(v_summary.output_fingerprint, 'hex'),
      'primary_topic', v_summary.primary_topic,
      'summary_body', v_summary.summary_body,
      'key_topics', v_summary.key_topics,
      'decisions', v_summary.decisions,
      'action_items', v_summary.action_items,
      'ambiguities', v_summary.ambiguities,
      'processor_type', v_summary.processor_type,
      'provider', v_summary.provider,
      'model', v_summary.model,
      'language_code', v_summary.language_code
    );
  end if;

  select report.* into v_report
  from private.ai_output_error_reports report
  where report.organization_id = p_organization_id
    and report.reporter_user_id = p_actor_user_id
    and report.output_kind = p_output_kind
    and ((p_output_kind = 'translation' and report.translation_id = p_translation_id)
      or (p_output_kind = 'summary' and report.summary_id = p_summary_id))
    and report.status in ('open', 'reviewing')
  order by report.created_at desc, report.id desc limit 1;
  if found then
    v_deduplicated := true;
  else
    if not private.consume_rate_limit(
      'ai-output-error-report-hour',
      p_organization_id::text || ':' || p_actor_user_id::text, 20, 3600
    ) then
      raise exception 'AI output error report limit exceeded' using errcode = 'P0001';
    end if;
    insert into private.ai_output_error_reports (
      organization_id, conversation_id, reporter_user_id, output_kind,
      translation_id, summary_id, category, details, high_consequence,
      quality_use_consent, consent_version, target_source_sha256,
      target_output_sha256, target_language, target_snapshot
    ) values (
      p_organization_id, v_conversation_id, p_actor_user_id, p_output_kind,
      p_translation_id, p_summary_id, p_category, btrim(p_details),
      (p_high_consequence or p_category in ('unsafe_wording', 'incorrect_action')),
      p_quality_use_consent, p_consent_version,
      v_source_sha256, v_output_sha256, lower(v_target_language), v_snapshot
    ) returning * into v_report;
    insert into private.ai_output_error_report_events (
      organization_id, report_id, report_version, actor_user_id, event_type,
      metadata
    ) values (
      p_organization_id, v_report.id, v_report.version, p_actor_user_id,
      'reported', jsonb_build_object(
        'output_kind', p_output_kind,
        'category', p_category,
        'high_consequence', v_report.high_consequence,
        'quality_use_consent', p_quality_use_consent,
        'consent_version', p_consent_version
      )
    );
    insert into public.audit_events (
      organization_id, actor_user_id, event_type, target_type, target_id, metadata
    ) values (
      p_organization_id, p_actor_user_id, 'ai_output.error.reported',
      'ai_output_error_report', v_report.id::text,
      jsonb_build_object(
        'output_kind', p_output_kind, 'category', p_category,
        'high_consequence', v_report.high_consequence,
        'quality_use_consent', p_quality_use_consent
      )
    );
  end if;
  v_response := private.ai_output_error_report_response_internal(v_report, false)
    || jsonb_build_object('deduplicated', v_deduplicated, 'originals_unchanged', true);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/ai-output-error-reports',
    p_idempotency_key, p_request_sha256, v_response,
    case when v_deduplicated then 200 else 201 end
  );
end;
$$;

create or replace function public.bff_report_ai_output_error(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_output_kind text, p_translation_id bigint, p_summary_id uuid,
  p_category text, p_details text, p_high_consequence boolean,
  p_quality_use_consent boolean, p_consent_version text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_report_ai_output_error_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_output_kind,
  p_translation_id, p_summary_id, p_category, p_details,
  p_high_consequence, p_quality_use_consent, p_consent_version,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_list_my_ai_output_error_reports(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_limit integer default 50
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_list_my_ai_output_error_reports_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_limit
) $$;

create or replace function public.bff_list_ai_output_error_reports_for_review(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_limit integer default 50
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_list_ai_output_error_reports_for_review_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_limit
) $$;

create or replace function public.bff_read_ai_output_error_report(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_report_id uuid
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_read_ai_output_error_report_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_report_id
) $$;

create or replace function public.bff_review_ai_output_error_report(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_report_id uuid, p_expected_version integer, p_outcome text,
  p_review_note text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_review_ai_output_error_report_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_report_id,
  p_expected_version, p_outcome, p_review_note,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_propose_ai_regression_example(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_report_id uuid, p_expected_report_version integer,
  p_source_language text, p_deidentified_source_text text,
  p_deidentified_observed_output text, p_deidentified_expected_output text,
  p_deidentification_attested boolean, p_attestation_version text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_propose_ai_regression_example_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_report_id,
  p_expected_report_version, p_source_language, p_deidentified_source_text,
  p_deidentified_observed_output, p_deidentified_expected_output,
  p_deidentification_attested, p_attestation_version,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_decide_ai_regression_example(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_example_id uuid, p_expected_version integer, p_decision text,
  p_decision_note text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_decide_ai_regression_example_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_example_id,
  p_expected_version, p_decision, p_decision_note,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_claim_ai_regression_examples(
  p_worker_hash bytea, p_limit integer default 20
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_claim_ai_regression_examples_impl(
  p_worker_hash, p_limit
) $$;

revoke execute on function
  private.prevent_ai_quality_record_mutation(),
  private.validate_ai_output_error_report_update(),
  private.validate_ai_regression_example_update(),
  private.ai_output_report_reviewer_allowed(uuid, uuid, uuid, text),
  private.ai_output_error_report_response_internal(private.ai_output_error_reports, boolean),
  private.ai_regression_example_response_internal(private.ai_regression_examples),
  private.bff_report_ai_output_error_impl(
    uuid, uuid, uuid, text, bigint, uuid, text, text, boolean, boolean, text, text, text
  ),
  private.bff_list_my_ai_output_error_reports_impl(uuid, uuid, uuid, integer),
  private.bff_list_ai_output_error_reports_for_review_impl(uuid, uuid, uuid, integer),
  private.bff_read_ai_output_error_report_impl(uuid, uuid, uuid, uuid),
  private.bff_review_ai_output_error_report_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  private.bff_propose_ai_regression_example_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text, boolean, text, text, text
  ),
  private.bff_decide_ai_regression_example_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  private.bff_claim_ai_regression_examples_impl(bytea, integer),
  private.bff_review_conversation_summary_impl(
    uuid, uuid, uuid, uuid, text, text, text, text
  )
from public, anon, authenticated, service_role;

grant execute on function
  private.bff_report_ai_output_error_impl(
    uuid, uuid, uuid, text, bigint, uuid, text, text, boolean, boolean, text, text, text
  ),
  private.bff_list_my_ai_output_error_reports_impl(uuid, uuid, uuid, integer),
  private.bff_list_ai_output_error_reports_for_review_impl(uuid, uuid, uuid, integer),
  private.bff_read_ai_output_error_report_impl(uuid, uuid, uuid, uuid),
  private.bff_review_ai_output_error_report_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  private.bff_propose_ai_regression_example_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text, boolean, text, text, text
  ),
  private.bff_decide_ai_regression_example_impl(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  private.bff_claim_ai_regression_examples_impl(bytea, integer),
  private.bff_review_conversation_summary_impl(
    uuid, uuid, uuid, uuid, text, text, text, text
  )
to service_role;

revoke execute on function
  public.bff_report_ai_output_error(
    uuid, uuid, uuid, text, bigint, uuid, text, text, boolean, boolean, text, text, text
  ),
  public.bff_list_my_ai_output_error_reports(uuid, uuid, uuid, integer),
  public.bff_list_ai_output_error_reports_for_review(uuid, uuid, uuid, integer),
  public.bff_read_ai_output_error_report(uuid, uuid, uuid, uuid),
  public.bff_review_ai_output_error_report(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  public.bff_propose_ai_regression_example(
    uuid, uuid, uuid, uuid, integer, text, text, text, text, boolean, text, text, text
  ),
  public.bff_decide_ai_regression_example(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  public.bff_claim_ai_regression_examples(bytea, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.bff_report_ai_output_error(
    uuid, uuid, uuid, text, bigint, uuid, text, text, boolean, boolean, text, text, text
  ),
  public.bff_list_my_ai_output_error_reports(uuid, uuid, uuid, integer),
  public.bff_list_ai_output_error_reports_for_review(uuid, uuid, uuid, integer),
  public.bff_read_ai_output_error_report(uuid, uuid, uuid, uuid),
  public.bff_review_ai_output_error_report(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  public.bff_propose_ai_regression_example(
    uuid, uuid, uuid, uuid, integer, text, text, text, text, boolean, text, text, text
  ),
  public.bff_decide_ai_regression_example(
    uuid, uuid, uuid, uuid, integer, text, text, text, text
  ),
  public.bff_claim_ai_regression_examples(bytea, integer)
to service_role;

comment on table private.ai_output_error_reports is
  'Forced-RLS, RPC-only exact derived-output snapshots for tenant-scoped quality review; original messages remain canonical.';
comment on table private.ai_regression_examples is
  'Human-deidentified, consent-bound regression proposals requiring a distinct recent-AAL2 second reviewer before service-only export.';
comment on function public.bff_claim_ai_regression_examples(bytea, integer) is
  'Service-only claim that returns deidentified evaluation content without organization, user, report, summary, translation, message, or example identifiers.';
comment on table private.conversation_summary_review_records is
  'Append-only exact summary review provenance retained for approvals and human rejections.';

commit;
