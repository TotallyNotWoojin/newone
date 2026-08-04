begin;
select plan(16);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('61000000-0000-4000-8000-000000000001', 'ai-owner@example.test', now()),
  ('61000000-0000-4000-8000-000000000002', 'ai-reviewer@example.test', now()),
  ('61000000-0000-4000-8000-000000000003', 'ai-member@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('61100000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('61100000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('61100000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000003', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values
  ('61100000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', '61200000-0000-4000-8000-000000000001', 'web', decode(repeat('11', 32), 'hex'), 'desktop'),
  ('61100000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', '61200000-0000-4000-8000-000000000002', 'web', decode(repeat('22', 32), 'hex'), 'desktop'),
  ('61100000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000003', '61200000-0000-4000-8000-000000000003', 'ios', decode(repeat('33', 32), 'hex'), 'iphone');

insert into public.organizations (
  id, slug, name, require_mfa_for_admins, created_by_user_id
) values (
  '62000000-0000-4000-8000-000000000001',
  'ai-projection-retry', 'AI Projection Retry', true,
  '61000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (
  organization_id, user_id, role
) values
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 'owner'),
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', 'member'),
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000003', 'member');

insert into public.organization_units (
  id, organization_id, kind, name, created_by_user_id
) values
  (
    '62100000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    'team', 'AI review unit',
    '61000000-0000-4000-8000-000000000001'
  ),
  (
    '62100000-0000-4000-8000-000000000002',
    '62000000-0000-4000-8000-000000000001',
    'team', 'Out-of-scope unit',
    '61000000-0000-4000-8000-000000000001'
  );

insert into public.organization_role_assignments (
  id, organization_id, user_id, role_name, scope_type, unit_id,
  granted_by_user_id, grant_reason
) values (
  '62200000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000002',
  'language_reviewer', 'unit',
  '62100000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  'Review translations for this unit'
);

insert into public.conversations (
  id, organization_id, kind, name, unit_id, created_by_user_id
) values
  (
    '63000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    'group', 'AI contract room',
    '62100000-0000-4000-8000-000000000001',
    '61000000-0000-4000-8000-000000000001'
  ),
  (
    '63000000-0000-4000-8000-000000000002',
    '62000000-0000-4000-8000-000000000001',
    'group', 'Out-of-scope AI room',
    '62100000-0000-4000-8000-000000000002',
    '61000000-0000-4000-8000-000000000001'
  );

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 'owner', '61000000-0000-4000-8000-000000000001'),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', 'member', '61000000-0000-4000-8000-000000000001'),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000003', 'member', '61000000-0000-4000-8000-000000000001'),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000001', 'owner', '61000000-0000-4000-8000-000000000001'),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', 'admin', '61000000-0000-4000-8000-000000000001');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"61000000-0000-4000-8000-000000000001","session_id":"61100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, language_code
) values
  (
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    '61000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000001',
    'text', 'Operational source text', 'ko'
  ),
  (
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000002',
    '61000000-0000-4000-8000-000000000001',
    '64000000-0000-4000-8000-000000000002',
    'text', 'Out-of-scope source text', 'ko'
  );
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select set_config('app.language_detection_context', 'on', true);
update public.messages
set detected_language = 'ko',
    language_detection_state = 'completed',
    language_detection_method = 'fixture-detector-v1',
    language_detection_confidence = 0.9876,
    language_detected_at = now()
where client_nonce in (
  '64000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000002'
);
select set_config('app.language_detection_context', 'off', true);

insert into public.organization_ai_policies (
  organization_id, enabled, policy_version, approved_use_cases,
  provider_allowlist, route_policy, approved_by_user_id, approved_at
) values (
  '62000000-0000-4000-8000-000000000001', true, 1,
  array['translation', 'summary']::text[], array['openrouter']::text[],
  'approved_zero_retention', '61000000-0000-4000-8000-000000000001', now()
);

insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language,
  target_language, status, translated_body, provider, model, confidence
) values
  (
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
    'ko', 'fr', 'completed', 'Texte operationnel', 'openrouter', 'qwen/test-pinned', 0.91
  ),
  (
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
    'ko', 'de', 'failed', null, null, null, null
  ),
  (
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
    'ko', 'it', 'blocked', null, null, null, null
  ),
  (
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000002',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000002'),
    'ko', 'fr', 'completed', 'Texte hors perimetre', 'openrouter', 'qwen/test-pinned', 0.90
  );

update public.message_translations
set failure_code = case target_language
  when 'de' then 'provider_terminal_error'
  when 'it' then 'tenant_ai_policy_changed'
  else failure_code
end
where organization_id = '62000000-0000-4000-8000-000000000001'
  and target_language in ('de', 'it');

insert into private.outbox_jobs (
  organization_id, topic, dedupe_key, payload, status, attempts,
  available_at, completed_at, last_error_code
)
select
  translation.organization_id,
  'translation',
  'translation:' || translation.id::text,
  jsonb_build_object(
    'organization_id', translation.organization_id,
    'conversation_id', translation.conversation_id,
    'message_id', translation.message_id,
    'target_language', translation.target_language,
    'requested_by_user_id', '61000000-0000-4000-8000-000000000002',
    'resolved_provider', 'openrouter',
    'ai_policy_version', 1,
    'generation_secret', 'must-not-survive-retry'
  ),
  case translation.target_language
    when 'fr' then 'completed'
    when 'de' then 'dead_letter'
    else 'completed'
  end,
  case when translation.target_language = 'de' then 7 else 1 end,
  now() - interval '1 minute',
  case when translation.target_language in ('fr', 'it') then now() else null end,
  case when translation.target_language = 'de' then 'provider_terminal_error' else null end
from public.message_translations translation
where translation.organization_id = '62000000-0000-4000-8000-000000000001';

insert into public.translation_corrections (
  id, organization_id, conversation_id, message_id, target_language,
  corrected_body, rationale, proposed_by_user_id, status,
  reviewed_by_user_id, reviewed_at, review_note, created_at, updated_at
) values
  (
    '65000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
    'fr', 'Texte corrige approuve', 'Approved terminology',
    '61000000-0000-4000-8000-000000000003', 'approved',
    '61000000-0000-4000-8000-000000000002', now() - interval '1 minute',
    'Internal reviewer note', now() - interval '2 minutes', now() - interval '1 minute'
  ),
  (
    '65000000-0000-4000-8000-000000000002',
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
    'fr', 'Texte propose en attente', 'Pending terminology',
    '61000000-0000-4000-8000-000000000003', 'pending',
    null, null, null, now(), now()
  ),
  (
    '65000000-0000-4000-8000-000000000003',
    '62000000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000002',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000002'),
    'fr', 'Correction hors perimetre', 'Out-of-scope proposal',
    '61000000-0000-4000-8000-000000000001', 'pending',
    null, null, null, now(), now()
  );

with source as (
  select message.id,
    extensions.digest(convert_to(
      message.id::text || ':' || encode(extensions.digest(convert_to(
        coalesce(message.body, '') || ':' || message.metadata::text || ':'
        || coalesce(message.edited_at::text, ''), 'UTF8'
      ), 'sha256'), 'hex'),
      'UTF8'
    ), 'sha256') as fingerprint
  from public.messages message
  where message.client_nonce = '64000000-0000-4000-8000-000000000001'
)
insert into public.conversation_summaries (
  id, organization_id, conversation_id, version_number,
  source_message_ids, source_first_message_id, source_last_message_id,
  source_fingerprint, output_fingerprint, requested_by_user_id,
  request_mode, language_code, status, primary_topic, summary_body,
  key_topics, decisions, action_items, ambiguities,
  reviewed_by_user_id, reviewed_at, review_note,
  processor_type, provider, model, processor_provenance
)
select
  '66000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001', 1,
  array[source.id], source.id, source.id, source.fingerprint,
  extensions.digest(convert_to('summary-output-v1', 'UTF8'), 'sha256'),
  '61000000-0000-4000-8000-000000000002',
  'manual', 'en', 'approved', 'Operational status', 'Everything is on track.',
  array['operations'], '[]'::jsonb, '[]'::jsonb, array[]::text[],
  '61000000-0000-4000-8000-000000000002', now(), 'Approved fixture summary',
  'ai', 'openrouter', 'qwen/test-pinned',
  jsonb_build_object(
    'organizationAiPolicyVersion', 1,
    'routePolicyVersion', 'route-v1',
    'providerRoute', 'openrouter-zdr',
    'generationId', 'private-generation-id',
    'promptTokens', 999,
    'completionTokens', 111,
    'sourceMap', jsonb_build_object('private', true)
  )
from source;

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2","session_id":"61100000-0000-4000-8000-000000000002"}',
  true
);

do $translation_gateway_budget$
declare
  v_result jsonb;
begin
  for v_attempt in 1..30 loop
    v_result := public.bff_consume_rate_limit(
      '61000000-0000-4000-8000-000000000002',
      '62000000-0000-4000-8000-000000000001',
      '61100000-0000-4000-8000-000000000002',
      'message.translate', null
    );
    if not (v_result ->> 'allowed')::boolean then
      raise exception 'translation gateway budget rejected attempt %', v_attempt;
    end if;
  end loop;
end;
$translation_gateway_budget$;
select ok(
  (with limited as (
    select public.bff_consume_rate_limit(
      '61000000-0000-4000-8000-000000000002',
      '62000000-0000-4000-8000-000000000001',
      '61100000-0000-4000-8000-000000000002',
      'message.translate', null
    ) response
  )
  select not (response ->> 'allowed')::boolean
    and (response ->> 'retry_after_seconds')::integer between 1 and 60
  from limited),
  'the public translation route enforces 30 jobs per minute with anchored Retry-After'
);

select ok(
  (select response ->> 'status' = 'queued'
      and (response ->> 'retried')::boolean
   from (select public.bff_enqueue_translation(
     '61000000-0000-4000-8000-000000000002',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000002',
     '63000000-0000-4000-8000-000000000001',
     (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
     'de', 'ai-retry-terminal-de', repeat('a', 64)
   ) response) retried),
  'an approved explicit retry returns queued with retried provenance'
);

reset role;
select ok(
  (select status = 'queued' and translated_body is null
      and provider is null and model is null and confidence is null
      and reviewed_by_user_id is null and reviewed_at is null
      and failure_code is null
   from public.message_translations
   where organization_id = '62000000-0000-4000-8000-000000000001'
     and target_language = 'de')
  and (select job.status = 'pending' and job.attempts = 0
      and job.claimed_by is null and job.claimed_until is null
      and job.completed_at is null and job.last_error_code is null
      and (select count(*) from jsonb_object_keys(job.payload)) = 5
      and not (job.payload ?| array[
        'resolved_provider', 'ai_policy_version', 'generation_secret'
      ])
   from private.outbox_jobs job
   join public.message_translations translation
     on job.dedupe_key = 'translation:' || translation.id::text
   where translation.organization_id = '62000000-0000-4000-8000-000000000001'
     and translation.target_language = 'de'),
  'terminal retry atomically clears derived output and resets only the exact durable job'
);

create temporary table active_translation_job_snapshot on commit drop as
select
  job.id, job.status, job.attempts, job.available_at, job.claimed_by,
  job.claimed_until, job.completed_at, job.last_error_code, job.payload,
  job.updated_at
from private.outbox_jobs job
join public.message_translations translation
  on job.dedupe_key = 'translation:' || translation.id::text
where translation.organization_id = '62000000-0000-4000-8000-000000000001'
  and translation.conversation_id = '63000000-0000-4000-8000-000000000001'
  and translation.target_language = 'de';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2","session_id":"61100000-0000-4000-8000-000000000002"}',
  true
);
select ok(
  (select response ->> 'status' = 'queued'
      and not (response ->> 'retried')::boolean
   from (select public.bff_enqueue_translation(
     '61000000-0000-4000-8000-000000000002',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000002',
     '63000000-0000-4000-8000-000000000001',
     (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
     'de', 'ai-active-duplicate-de', repeat('d', 64)
   ) response) duplicate_enqueue),
  'an active duplicate enqueue returns existing queued state without retrying'
);
reset role;
select ok(
  (select row(
      job.status, job.attempts, job.available_at, job.claimed_by,
      job.claimed_until, job.completed_at, job.last_error_code, job.payload,
      job.updated_at
    ) is not distinct from row(
      snapshot.status, snapshot.attempts, snapshot.available_at,
      snapshot.claimed_by, snapshot.claimed_until, snapshot.completed_at,
      snapshot.last_error_code, snapshot.payload, snapshot.updated_at
    )
   from private.outbox_jobs job
   join active_translation_job_snapshot snapshot on snapshot.id = job.id),
  'an active duplicate leaves the worker-owned durable job byte-for-byte unchanged'
);

update public.organization_ai_policies
set enabled = false
where organization_id = '62000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2","session_id":"61100000-0000-4000-8000-000000000002"}',
  true
);
select throws_ok(
  $$select public.bff_enqueue_translation(
    '61000000-0000-4000-8000-000000000002',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000002',
    '63000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
    'it', 'ai-retry-policy-denied', repeat('b', 64)
  )$$,
  '42501',
  'tenant-approved translation policy required for retry',
  'a terminal retry reauthorizes current tenant AI policy before state changes'
);
reset role;
select ok(
  (select status = 'blocked' and failure_code = 'tenant_ai_policy_changed'
   from public.message_translations
   where organization_id = '62000000-0000-4000-8000-000000000001'
     and target_language = 'it')
  and (select job.status = 'completed' and job.completed_at is not null
   from private.outbox_jobs job
   join public.message_translations translation
     on job.dedupe_key = 'translation:' || translation.id::text
   where translation.organization_id = '62000000-0000-4000-8000-000000000001'
     and translation.target_language = 'it'),
  'a policy-denied retry leaves both terminal records unchanged'
);
update public.organization_ai_policies
set enabled = true
where organization_id = '62000000-0000-4000-8000-000000000001';

set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal1","session_id":"61100000-0000-4000-8000-000000000003"}',
  true
);
select ok(
  (with bootstrap as (
    select public.bff_bootstrap_messaging_state(
      '61000000-0000-4000-8000-000000000003',
      '62000000-0000-4000-8000-000000000001',
      '61100000-0000-4000-8000-000000000003',
      '63000000-0000-4000-8000-000000000001', null, 20, 20
    ) state
  ), message_projection as (
    select message_row
    from bootstrap,
      jsonb_array_elements(state -> 'timeline' -> 'messages') message_row
    where message_row ->> 'client_nonce' = '64000000-0000-4000-8000-000000000001'
  ), translation_projection as (
    select translation_row
    from message_projection,
      jsonb_array_elements(message_row -> 'translations') translation_row
    where translation_row ->> 'target_language' = 'fr'
  )
  select message_row ->> 'language_detection_method' = 'fixture-detector-v1'
    and (message_row ->> 'language_detection_confidence')::numeric = 0.9876
    and message_row ->> 'language_detected_at' is not null
    and translation_row ?& array[
      'translation_id', 'source_language', 'target_language',
      'source_body_sha256', 'translated_body', 'status', 'provider', 'model',
      'confidence', 'policy_version', 'latest_correction',
      'created_at', 'updated_at'
    ]
    and translation_row ->> 'source_language' = 'ko'
    and translation_row ->> 'source_body_sha256' ~ '^[0-9a-f]{64}$'
    and (translation_row ->> 'policy_version')::integer = 1
    and translation_row -> 'latest_correction' ->> 'status' = 'approved'
    and translation_row -> 'latest_correction' ->> 'corrected_body' = 'Texte corrige approuve'
    and not (translation_row -> 'latest_correction' ?| array[
      'proposed_by_user_id', 'reviewed_by_user_id', 'reviewed_at', 'review_note'
    ])
  from message_projection cross join translation_projection),
  'ordinary member DTO includes language/translation provenance and only approved correction content'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2","session_id":"61100000-0000-4000-8000-000000000002"}',
  true
);
select ok(
  (with bootstrap as (
    select public.bff_bootstrap_messaging_state(
      '61000000-0000-4000-8000-000000000002',
      '62000000-0000-4000-8000-000000000001',
      '61100000-0000-4000-8000-000000000002',
      '63000000-0000-4000-8000-000000000001', null, 20, 20
    ) state
  )
  select translation_row -> 'latest_correction' ->> 'status' = 'pending'
    and translation_row -> 'latest_correction' ->> 'corrected_body' = 'Texte propose en attente'
    and translation_row -> 'latest_correction' ->> 'proposed_by_user_id'
      = '61000000-0000-4000-8000-000000000003'
  from bootstrap,
    jsonb_array_elements(state -> 'timeline' -> 'messages') message_row,
    jsonb_array_elements(message_row -> 'translations') translation_row
  where message_row ->> 'client_nonce' = '64000000-0000-4000-8000-000000000001'
    and translation_row ->> 'target_language' = 'fr'),
  'language reviewers receive the latest pending correction and necessary proposal provenance'
);

select ok(
  (select response ->> 'decision' = 'approved'
   from (select public.bff_review_translation_correction(
     '61000000-0000-4000-8000-000000000002',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000002',
     '65000000-0000-4000-8000-000000000002',
     'approved', 'Scoped reviewer approval',
     'ai-review-correction-in-scope', repeat('e', 64)
   ) response) reviewed),
  'a unit-scoped language reviewer can decide a correction in that unit'
);

select throws_ok(
  $$select public.bff_review_translation_correction(
    '61000000-0000-4000-8000-000000000002',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000002',
    '65000000-0000-4000-8000-000000000003',
    'approved', 'Must remain out of scope',
    'ai-review-correction-out-of-scope', repeat('f', 64)
  )$$,
  '42501',
  'authorized correction decision required',
  'a unit-scoped language reviewer cannot decide a correction in another unit'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal1","session_id":"61100000-0000-4000-8000-000000000003"}',
  true
);
select ok(
  (with bootstrap as (
    select public.bff_bootstrap_messaging_state(
      '61000000-0000-4000-8000-000000000003',
      '62000000-0000-4000-8000-000000000001',
      '61100000-0000-4000-8000-000000000003',
      '63000000-0000-4000-8000-000000000001', null, 20, 20
    ) state
  )
  select summary_row ?& array[
      'summary_id', 'version_number', 'conversation_id',
      'correction_of_summary_id', 'source_message_ids',
      'source_first_message_id', 'source_last_message_id',
      'source_fingerprint', 'output_fingerprint', 'requested_by_user_id',
      'request_mode', 'processor_type', 'provider', 'model',
      'processor_provenance', 'failure_code', 'reviewed_by_user_id',
      'reviewed_at', 'review_note', 'source_state', 'policy_state',
      'created_at', 'updated_at'
    ]
    and summary_row ->> 'source_fingerprint' ~ '^[0-9a-f]{64}$'
    and summary_row ->> 'output_fingerprint' ~ '^[0-9a-f]{64}$'
    and summary_row ->> 'source_state' = 'current'
    and summary_row ->> 'policy_state' = 'current'
    and (select count(*) from jsonb_object_keys(
      summary_row -> 'processor_provenance'
    )) = 3
    and not (summary_row -> 'processor_provenance' ?| array[
      'generationId', 'generation_id', 'promptTokens', 'prompt_tokens',
      'completionTokens', 'completion_tokens', 'sourceMap', 'source_map'
    ])
  from bootstrap,
    jsonb_array_elements(state -> 'summaries') summary_row
  where summary_row ->> 'summary_id' = '66000000-0000-4000-8000-000000000001'),
  'summary DTO exposes explainable freshness and only privacy-safe processor provenance'
);

reset role;
do $conversation_draft_budget$
begin
  for v_attempt in 1..5 loop
    if not private.consume_rate_limit(
      'summary-handoff-conversation-hour',
      '62000000-0000-4000-8000-000000000001:63000000-0000-4000-8000-000000000001',
      5, 3600
    ) then
      raise exception 'conversation draft budget rejected attempt %', v_attempt;
    end if;
  end loop;
end;
$conversation_draft_budget$;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2","session_id":"61100000-0000-4000-8000-000000000002"}',
  true
);
select throws_ok(
  $$select public.bff_request_conversation_summary(
    '61000000-0000-4000-8000-000000000002',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000002',
    '63000000-0000-4000-8000-000000000001',
    array[(select id from public.messages
      where client_nonce = '64000000-0000-4000-8000-000000000001')],
    'en', 'ai-summary-conversation-budget', repeat('1', 64)
  )$$,
  'P0001',
  'summary/handoff draft rate limit exceeded',
  'summary and handoff drafts share the five-per-conversation hourly budget'
);

reset role;
do $actor_draft_budget$
begin
  for v_attempt in 1..20 loop
    if not private.consume_rate_limit(
      'summary-handoff-actor-day',
      '62000000-0000-4000-8000-000000000001:61000000-0000-4000-8000-000000000002',
      20, 86400
    ) then
      raise exception 'actor draft budget rejected attempt %', v_attempt;
    end if;
  end loop;
end;
$actor_draft_budget$;
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2","session_id":"61100000-0000-4000-8000-000000000002"}',
  true
);
select throws_ok(
  $$select public.bff_create_handoff(
    '61000000-0000-4000-8000-000000000002',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000002',
    '63000000-0000-4000-8000-000000000002',
    'Shift handoff', 'Operational details', 'en',
    clock_timestamp() - interval '8 hours', clock_timestamp(),
    'ai-handoff-actor-budget', repeat('2', 64)
  )$$,
  'P0001',
  'summary/handoff draft rate limit exceeded',
  'summary and handoff drafts share the twenty-per-actor daily budget'
);

reset role;
update public.organization_ai_policies
set policy_version = 2
where organization_id = '62000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal1","session_id":"61100000-0000-4000-8000-000000000003"}',
  true
);
select is(
  (select summary_row ->> 'policy_state'
   from jsonb_array_elements(
     public.bff_bootstrap_messaging_state(
       '61000000-0000-4000-8000-000000000003',
       '62000000-0000-4000-8000-000000000001',
       '61100000-0000-4000-8000-000000000003',
       '63000000-0000-4000-8000-000000000001', null, 20, 20
     ) -> 'summaries'
   ) summary_row
   where summary_row ->> 'summary_id' = '66000000-0000-4000-8000-000000000001'),
  'stale',
  'summary policy state becomes stale when tenant approval version advances'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2","session_id":"61100000-0000-4000-8000-000000000001"}',
  true
);
do $edit_source$
begin
  perform public.bff_edit_message(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    '63000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000001'),
    'Operational source text changed',
    'ai-summary-source-edit', repeat('c', 64)
  );
end;
$edit_source$;
select set_config(
  'request.jwt.claims',
  '{"sub":"61000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal1","session_id":"61100000-0000-4000-8000-000000000003"}',
  true
);
select ok(
  (select summary_row ->> 'source_state' = 'stale'
      and summary_row ->> 'status' = 'stale'
   from jsonb_array_elements(
     public.bff_bootstrap_messaging_state(
       '61000000-0000-4000-8000-000000000003',
       '62000000-0000-4000-8000-000000000001',
       '61100000-0000-4000-8000-000000000003',
       '63000000-0000-4000-8000-000000000001', null, 20, 20
     ) -> 'summaries'
   ) summary_row
   where summary_row ->> 'summary_id' = '66000000-0000-4000-8000-000000000001'),
  'an approved summary becomes stale after a source edit without exposing old content'
);

select * from finish();
rollback;
