begin;
select plan(49);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1-3: the raw evidence plane and every mutation remain behind the BFF.
select ok(
  exists (
    select 1 from public.organization_role_permissions permission
    where permission.role_name = 'security_admin'
      and permission.permission = 'reports.assign'
  ),
  'security administration has an explicit case-assignment capability'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_query_moderation_cases(uuid,uuid,uuid,text[],timestamptz,uuid,integer)',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.bff_transition_moderation_case(uuid,uuid,uuid,uuid,text,integer,text,jsonb,text,text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_read_moderation_case(uuid,uuid,uuid,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'public.bff_report_message(uuid,uuid,uuid,uuid,bigint,text,text,text,text)',
    'execute'
  ),
  'only current scoped moderation RPCs are service-role executable'
);
select ok(
  not has_table_privilege('service_role', 'private.message_reports', 'select')
  and not has_table_privilege('service_role', 'private.moderation_case_evidence', 'select')
  and not has_table_privilege('authenticated', 'private.moderation_case_history', 'select')
  and (select relforcerowsecurity from pg_class where oid = 'private.message_reports'::regclass)
  and (select relforcerowsecurity from pg_class where oid = 'private.moderation_case_evidence'::regclass)
  and (select relforcerowsecurity from pg_class where oid = 'private.moderation_case_history'::regclass),
  'private case tables expose no raw reads and force RLS'
);

insert into auth.users (id, email, email_confirmed_at, created_at, updated_at) values
  ('71000000-0000-4000-8000-000000000001', 'moderation-manager@example.test', now(), now(), now()),
  ('71000000-0000-4000-8000-000000000002', 'moderation-reporter@example.test', now(), now(), now()),
  ('71000000-0000-4000-8000-000000000003', 'moderation-subject@example.test', now(), now(), now()),
  ('71000000-0000-4000-8000-000000000004', 'moderation-investigator-a@example.test', now(), now(), now()),
  ('71000000-0000-4000-8000-000000000005', 'moderation-investigator-b@example.test', now(), now(), now()),
  ('71000000-0000-4000-8000-000000000006', 'moderation-outscope@example.test', now(), now(), now());

update public.profiles set display_name = case user_id
  when '71000000-0000-4000-8000-000000000001' then 'Case Manager'
  when '71000000-0000-4000-8000-000000000002' then 'Moderation Reporter'
  when '71000000-0000-4000-8000-000000000003' then 'Reported Participant'
  when '71000000-0000-4000-8000-000000000004' then 'Investigator A'
  when '71000000-0000-4000-8000-000000000005' then 'Investigator B'
  when '71000000-0000-4000-8000-000000000006' then 'Out-of-scope Investigator'
  else display_name end
where user_id::text like '71000000-0000-4000-8000-%';

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('71100000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000003', now(), now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000004', now(), now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000005', '71000000-0000-4000-8000-000000000005', now(), now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000006', '71000000-0000-4000-8000-000000000006', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('71100000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '71200000-0000-4000-8000-000000000001', 'web', decode(repeat('71', 32), 'hex'), 'desktop'),
  ('71100000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000002', '71200000-0000-4000-8000-000000000002', 'web', decode(repeat('72', 32), 'hex'), 'desktop'),
  ('71100000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000003', '71200000-0000-4000-8000-000000000003', 'web', decode(repeat('73', 32), 'hex'), 'desktop'),
  ('71100000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000004', '71200000-0000-4000-8000-000000000004', 'web', decode(repeat('74', 32), 'hex'), 'desktop'),
  ('71100000-0000-4000-8000-000000000005', '71000000-0000-4000-8000-000000000005', '71200000-0000-4000-8000-000000000005', 'web', decode(repeat('75', 32), 'hex'), 'desktop'),
  ('71100000-0000-4000-8000-000000000006', '71000000-0000-4000-8000-000000000006', '71200000-0000-4000-8000-000000000006', 'web', decode(repeat('76', 32), 'hex'), 'desktop');

insert into public.organizations (
  id, slug, name, require_mfa_for_admins, created_by_user_id
) values (
  '72000000-0000-4000-8000-000000000001',
  'moderation-lifecycle-test', 'Moderation Lifecycle Test', true,
  '71000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'owner'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'member'),
  -- Make the reported person a legacy administrator to prove case-specific
  -- separation overrides otherwise broad organization authority.
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000003', 'admin'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000004', 'member'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000005', 'member'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000006', 'member');

insert into public.organization_units (
  id, organization_id, kind, name, created_by_user_id
) values
  ('72100000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'team', 'Case Unit', '71000000-0000-4000-8000-000000000001'),
  ('72100000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000001', 'team', 'Other Unit', '71000000-0000-4000-8000-000000000001');

insert into public.organization_role_assignments (
  id, organization_id, user_id, role_name, scope_type, unit_id,
  granted_by_user_id, grant_reason
) values
  ('72200000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'designated_investigator', 'organization', null, '71000000-0000-4000-8000-000000000001', 'Reporter conflict-of-interest fixture'),
  ('72200000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000004', 'designated_investigator', 'organization', null, '71000000-0000-4000-8000-000000000001', 'Organization investigator fixture'),
  ('72200000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000005', 'designated_investigator', 'unit', '72100000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'Unit investigator fixture'),
  ('72200000-0000-4000-8000-000000000004', '72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000006', 'designated_investigator', 'unit', '72100000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', 'Out-of-scope investigator fixture');

insert into public.conversations (
  id, organization_id, unit_id, kind, name, history_policy, created_by_user_id
) values (
  '73000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000001',
  '72100000-0000-4000-8000-000000000001',
  'group', 'Reported conversation', 'all',
  '71000000-0000-4000-8000-000000000001'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'member', '71000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000003', 'member', '71000000-0000-4000-8000-000000000001');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"71000000-0000-4000-8000-000000000002"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body
) values (
  '72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', '74000000-0000-4000-8000-000000000001', 'text', 'Reporter-authored consented context'
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"71000000-0000-4000-8000-000000000003"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body
) values
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000003', '74000000-0000-4000-8000-000000000002', 'text', 'Reported message evidence'),
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000003', '74000000-0000-4000-8000-000000000003', 'text', 'Consented context after report');

-- Transaction-local inspection grants; production grants remain revoked.
grant select, update, delete on
  private.message_reports,
  private.moderation_case_evidence,
  private.moderation_case_history
to service_role;
grant select on private.outbox_jobs to service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 4-11: reporting requires exact consent and snapshots only bounded evidence.
select throws_ok(
  $$select public.bff_report_message_v2(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002',
    '73000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '74000000-0000-4000-8000-000000000002'),
    'privacy', 'No consent', false, 1, 1, 'moderation-share-v1',
    'moderation-no-consent', repeat('1', 64)
  )$$,
  '22023',
  'valid report consent and bounded target scope required',
  'a report cannot be created without explicit consent'
);
select ok(
  (public.bff_report_message_v2(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002',
    '73000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '74000000-0000-4000-8000-000000000002'),
    'privacy', E'Operational detail\nwith a permitted line break.',
    true, 1, 1, 'moderation-share-v1',
    'moderation-report-create', repeat('2', 64)
  ) ->> 'created')::boolean,
  'an explicitly consented report is created'
);
select is(
  (public.bff_report_message_v2(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002',
    '73000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '74000000-0000-4000-8000-000000000002'),
    'privacy', 'A duplicate cannot widen evidence.',
    true, 2, 2, 'moderation-share-v1',
    'moderation-report-duplicate', repeat('3', 64)
  ) ->> 'created')::boolean,
  false,
  'a duplicate report is safely deduplicated without widening consent'
);
select is(
  (select count(*)::bigint from private.moderation_case_evidence),
  3::bigint,
  'the reported item and one explicitly selected message on each side are snapshotted once'
);
select is(
  (select array_agg(relationship order by relative_position)
   from private.moderation_case_evidence),
  array['context_before', 'reported', 'context_after']::text[],
  'evidence relationships preserve their exact bounded ordering'
);
select ok(
  (select reporter_notice_version = 'moderation-share-v1'
      and context_before_count = 1 and context_after_count = 1
      and reporter_user_id <> subject_user_id
   from private.message_reports limit 1),
  'the case stores immutable disclosure scope and distinct reporter/subject parties'
);

create temporary table moderation_initial_fanout as
with envelope as (
  select public.bff_claim_outbox_topics(
    '75000000-0000-4000-8000-000000000001',
    array['moderation']::text[], 10, 300
  ) result
), claimed as (
  select (job.value ->> 'id')::bigint job_id
  from envelope
  cross join lateral jsonb_array_elements(envelope.result -> 'jobs') job(value)
)
select claimed.job_id,
  public.bff_expand_moderation_fanout(
    '75000000-0000-4000-8000-000000000001', claimed.job_id
  ) expansion
from claimed;
select public.bff_complete_outbox_job(
  '75000000-0000-4000-8000-000000000001', job_id
)
from moderation_initial_fanout;
select is(
  (select count(*)::bigint from private.outbox_jobs job
   where job.topic = 'realtime_control'
     and job.payload ->> 'reason' = 'case_available'),
  3::bigint,
  'only the case manager and two in-scope investigators receive availability invalidations'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'realtime_control'
      and (
        job.payload ? 'reporter_user_id'
        or job.payload ? 'message_body'
        or job.payload ? 'conversation_id'
        or job.payload ->> 'user_id' = '71000000-0000-4000-8000-000000000003'
      )
  ),
  'availability notifications omit reporter/content/conversation data and exclude the reported person'
);

-- 12-17: queue metadata is redacted and case conflicts override broad roles.
select ok(
  (select jsonb_array_length(result -> 'cases') = 1
      and (result ->> 'content_included')::boolean = false
      and (result ->> 'reporter_identity_included')::boolean = false
      and not ((result -> 'cases' -> 0) ? 'conversation_id')
      and not ((result -> 'cases' -> 0) ? 'message_id')
      and not ((result -> 'cases' -> 0) ? 'details')
   from (select public.bff_query_moderation_cases(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001',
     array['open']::text[], null, null, 50
   ) result) listed),
  'case managers receive redacted queue metadata only'
);
select ok(
  (select jsonb_array_length(result -> 'cases') = 1
      and (result #>> '{cases,0,can_claim}')::boolean
      and not (result #>> '{cases,0,can_view_evidence}')::boolean
   from (select public.bff_query_moderation_cases(
     '71000000-0000-4000-8000-000000000004',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000004',
     array['open']::text[], null, null, 50
   ) result) listed),
  'an in-scope investigator may claim but cannot read an unassigned case'
);
select is(
  jsonb_array_length(public.bff_query_moderation_cases(
    '71000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003',
    array['open']::text[], null, null, 50
  ) -> 'cases'),
  0,
  'the reported person sees no case even with legacy administrator authority'
);
select is(
  jsonb_array_length(public.bff_query_moderation_cases(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002',
    array['open']::text[], null, null, 50
  ) -> 'cases'),
  0,
  'the reporter cannot investigate their own case despite an investigator grant'
);
select is(
  jsonb_array_length(public.bff_query_moderation_cases(
    '71000000-0000-4000-8000-000000000006',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000006',
    array['open']::text[], null, null, 50
  ) -> 'cases'),
  0,
  'a designated investigator outside the conversation unit scope sees no case'
);
select is(
  jsonb_array_length(public.bff_bootstrap_messaging_state(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    null, null, 100, 50
  ) -> 'moderation_reports'),
  0,
  'ordinary AAL1-compatible workspace bootstrap contains no moderation case identifiers'
);

-- 18-26: assignment is explicit, idempotent, and grants evidence to one actor.
select is(
  (public.bff_assign_moderation_case(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    (select id from private.message_reports limit 1),
    '71000000-0000-4000-8000-000000000004', 1,
    'Independent assignment approved by the case manager.',
    'moderation-assign-a', repeat('4', 64)
  ) ->> 'record_version')::integer,
  2,
  'an authorized manager explicitly assigns the case at the expected version'
);
select is(
  (public.bff_assign_moderation_case(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    (select id from private.message_reports limit 1),
    '71000000-0000-4000-8000-000000000004', 1,
    'Independent assignment approved by the case manager.',
    'moderation-assign-a', repeat('4', 64)
  ) ->> 'record_version')::integer,
  2,
  'an exact idempotent assignment replay returns the original receipt'
);
select is(
  (select count(*)::bigint from private.moderation_case_history where event_type = 'assigned'),
  1::bigint,
  'assignment replay does not duplicate immutable history'
);
select throws_ok(
  $$select public.bff_read_moderation_case(
    '71000000-0000-4000-8000-000000000005',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000005',
    (select id from private.message_reports limit 1)
  )$$,
  'P0002',
  'assigned moderation case not found',
  'an eligible but unassigned investigator cannot read evidence'
);
select ok(
  (select jsonb_array_length(result #> '{case,evidence}') = 3
      and (result #>> '{scope,reported_item_and_consented_context_only}')::boolean
      and not (result #>> '{scope,reporter_identity_included}')::boolean
      and not (result #>> '{scope,other_conversations_included}')::boolean
   from (select public.bff_read_moderation_case(
     '71000000-0000-4000-8000-000000000004',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000004',
     (select id from private.message_reports limit 1)
   ) result) detailed),
  'only the assigned investigator receives the immutable scoped evidence snapshot'
);
select is(
  (select result #>> '{case,evidence,0,sender_label}'
   from (select public.bff_read_moderation_case(
     '71000000-0000-4000-8000-000000000004',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000004',
     (select id from private.message_reports limit 1)
   ) result) detailed),
  'Protected reporter',
  'reporter-authored context redacts the reporter display name'
);
select ok(
  (select position('reporter_user_id' in result::text) = 0
      and position('Moderation Reporter' in result::text) = 0
      and position('conversation_id' in result::text) = 0
      and position('message_id' in result::text) = 0
   from (select public.bff_read_moderation_case(
     '71000000-0000-4000-8000-000000000004',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000004',
     (select id from private.message_reports limit 1)
   ) result) detailed),
  'assigned detail contains no raw reporter, conversation, or source-message identifiers'
);
select throws_ok(
  $$select public.bff_assign_moderation_case(
    '71000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003',
    (select id from private.message_reports limit 1),
    '71000000-0000-4000-8000-000000000005', 2,
    'The reported person must not control assignment.',
    'moderation-subject-assign', repeat('5', 64)
  )$$,
  '42501',
  'moderation assignment is not permitted',
  'the reported person cannot assign the case despite broad administrator authority'
);
select throws_ok(
  $$select public.bff_claim_moderation_case(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002',
    (select id from private.message_reports limit 1), 2,
    'A reporter cannot claim their own case.',
    'moderation-reporter-claim', repeat('6', 64)
  )$$,
  '42501',
  'moderation claim is not permitted',
  'the reporter cannot claim their own case'
);
select is(
  (select count(*)::bigint from private.moderation_case_history where event_type = 'accessed'),
  3::bigint,
  'each successful evidence access is recorded immutably'
);

-- 27-36: review, stale-write rejection, operational reassignment, and closure.
select is(
  (public.bff_transition_moderation_case(
    '71000000-0000-4000-8000-000000000004',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000004',
    (select id from private.message_reports limit 1),
    'in_review', 2, 'Review of the immutable snapshot started.', '{}'::jsonb,
    'moderation-review-a', repeat('7', 64)
  ) ->> 'record_version')::integer,
  3,
  'the assigned investigator starts review at the expected version'
);
select throws_ok(
  $$select public.bff_transition_moderation_case(
    '71000000-0000-4000-8000-000000000004',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000004',
    (select id from private.message_reports limit 1),
    'resolved', 2, 'Stale decision must fail.', '{"policy_code":"AUP.1"}'::jsonb,
    'moderation-stale-resolve', repeat('8', 64)
  )$$,
  '40001',
  'moderation case version conflict',
  'a stale concurrent decision is rejected before mutation'
);
select is(
  (public.bff_assign_moderation_case(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    (select id from private.message_reports limit 1),
    '71000000-0000-4000-8000-000000000005', 3,
    'Reassigned because the first investigator became unavailable.',
    'moderation-reassign-b', repeat('9', 64)
  ) ->> 'record_version')::integer,
  4,
  'a manager can recover an in-review case through explicit reassignment'
);
select throws_ok(
  $$select public.bff_read_moderation_case(
    '71000000-0000-4000-8000-000000000004',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000004',
    (select id from private.message_reports limit 1)
  )$$,
  'P0002',
  'assigned moderation case not found',
  'the previous investigator immediately loses evidence access'
);
select is(
  (public.bff_read_moderation_case(
    '71000000-0000-4000-8000-000000000005',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000005',
    (select id from private.message_reports limit 1)
  ) #>> '{case,status}'),
  'assigned',
  'the newly assigned in-scope investigator can read the case'
);
select is(
  (public.bff_transition_moderation_case(
    '71000000-0000-4000-8000-000000000005',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000005',
    (select id from private.message_reports limit 1),
    'in_review', 4, 'Replacement investigator began review.', '{}'::jsonb,
    'moderation-review-b', repeat('a', 64)
  ) ->> 'record_version')::integer,
  5,
  'the replacement investigator restarts review explicitly'
);
select ok(
  (select (receipt ->> 'read_only')::boolean
      and receipt ->> 'status' = 'resolved'
      and not (receipt ->> 'notification_payload_content_included')::boolean
   from (select public.bff_transition_moderation_case(
     '71000000-0000-4000-8000-000000000005',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000005',
     (select id from private.message_reports limit 1),
     'resolved', 5, 'Policy review supports resolution.',
     '{"policy_code":"AUP.4.2","severity":"high","reference_ids":["CASE-42"]}'::jsonb,
     'moderation-resolve', repeat('b', 64)
   ) receipt) closed),
  'resolution returns a content-free receipt and locks the record read-only'
);
select ok(
  (select status = 'resolved' and record_version = 6
      and closed_at is not null and closed_by_user_id = assigned_investigator_user_id
      and resolution_reason = 'Policy review supports resolution.'
      and resolution_evidence_metadata ->> 'policy_code' = 'AUP.4.2'
   from private.message_reports limit 1),
  'the closed case stores bounded reason and structured evidence metadata'
);
select throws_ok(
  $$select public.bff_transition_moderation_case(
    '71000000-0000-4000-8000-000000000005',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000005',
    (select id from private.message_reports limit 1),
    'dismissed', 6, 'Closed means closed.', '{"severity":"low"}'::jsonb,
    'moderation-after-close', repeat('c', 64)
  )$$,
  '42501',
  'moderation transition is not permitted',
  'a closed record cannot transition again'
);
select throws_ok(
  $$update private.message_reports set details = 'tampered'$$,
  '55000',
  'closed moderation case records are read-only',
  'the closed source record cannot be edited directly'
);
select is(
  (select from_status || '>' || to_status from private.moderation_case_history
   where event_type = 'reassigned' limit 1),
  'in_review>assigned',
  'reassignment history preserves the actual prior review state'
);

-- 37-49: append-only evidence/history, audits, notifications, and recent auth.
select throws_ok(
  $$update private.moderation_case_evidence set message_body = 'tampered'$$,
  '55000',
  'moderation evidence and case history are append-only',
  'captured evidence cannot be edited'
);
select throws_ok(
  $$delete from private.moderation_case_history$$,
  '55000',
  'moderation evidence and case history are append-only',
  'case history cannot be deleted'
);
select ok(
  (select array['reported','assigned','accessed','review_started','reassigned','resolved']::text[]
      <@ array_agg(distinct event_type)
   from private.moderation_case_history),
  'immutable history includes report, assignment, access, review, reassignment, and closure events'
);
select ok(
  (select count(*) > 0 from public.audit_events event
   where event.organization_id = '72000000-0000-4000-8000-000000000001'
     and event.event_type = 'moderation_case_event.insert'
     and event.target_type = 'moderation_case_event'),
  'every committed moderation history append produces a correlated audit event'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'realtime_control'
      and (
        job.payload ? 'reporter_user_id'
        or job.payload ? 'message_body'
        or job.payload ? 'details'
        or job.payload ? 'conversation_id'
        or job.payload ? 'message_id'
      )
  ),
  'all moderation invalidations remain content-free across the lifecycle'
);
select is(
  (select count(*)::bigint from private.outbox_jobs job
   where job.topic = 'realtime_control'
     and job.payload ->> 'user_id' = '71000000-0000-4000-8000-000000000002'
     and job.payload ->> 'reason' = 'case_status_changed'),
  3::bigint,
  'the reporter receives only content-free review-state and closure invalidations'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'realtime_control'
      and job.payload ->> 'user_id' = '71000000-0000-4000-8000-000000000003'
  ),
  'the reported person never receives a case invalidation'
);
select is(
  (select count(*)::bigint from private.moderation_case_evidence
   where relationship = 'reported'),
  1::bigint,
  'exactly one reported item remains in the immutable evidence set'
);
select is(
  (select count(*)::bigint from private.message_reports),
  1::bigint,
  'the full lifecycle retains one immutable case record without duplication'
);
select ok(
  (select jsonb_array_length(result -> 'cases') = 1
      and (result #>> '{cases,0,read_only}')::boolean
      and result #>> '{cases,0,status}' = 'resolved'
   from (select public.bff_query_moderation_cases(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001',
     array['resolved']::text[], null, null, 50
   ) result) listed),
  'authorized case managers can list closed metadata as read-only'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update auth.sessions
set created_at = now() - interval '6 minutes'
where id = '71100000-0000-4000-8000-000000000005';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_query_moderation_cases(
    '71000000-0000-4000-8000-000000000005',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000005',
    array['resolved']::text[], null, null, 50
  )$$,
  '42501',
  'request authorization denied',
  'case access fails closed when the recent AAL2 window expires'
);

select * from finish();
rollback;
