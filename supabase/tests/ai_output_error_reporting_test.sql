begin;
create extension if not exists pgtap with schema extensions;
select plan(34);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('e1000000-0000-4000-8000-000000000001', 'quality-owner@example.test', now()),
  ('e1000000-0000-4000-8000-000000000002', 'quality-reporter@example.test', now()),
  ('e1000000-0000-4000-8000-000000000003', 'quality-reviewer-one@example.test', now()),
  ('e1000000-0000-4000-8000-000000000004', 'quality-reviewer-two@example.test', now()),
  ('e1000000-0000-4000-8000-000000000005', 'quality-unscoped@example.test', now()),
  ('e1000000-0000-4000-8000-000000000006', 'quality-other-tenant@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('e1100000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('e1100000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', now(), now(), 'aal2'),
  ('e1100000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', now(), now(), 'aal2'),
  ('e1100000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000005', now(), now(), 'aal2'),
  ('e1100000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-000000000006', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000001', 'web', decode(repeat('11',32),'hex'), 'desktop'),
  ('e1100000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000002', 'web', decode(repeat('12',32),'hex'), 'desktop'),
  ('e1100000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000003', 'web', decode(repeat('13',32),'hex'), 'desktop'),
  ('e1100000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', 'e1200000-0000-4000-8000-000000000004', 'web', decode(repeat('14',32),'hex'), 'desktop'),
  ('e1100000-0000-4000-8000-000000000005', 'e1000000-0000-4000-8000-000000000005', 'e1200000-0000-4000-8000-000000000005', 'web', decode(repeat('15',32),'hex'), 'desktop'),
  ('e1100000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-000000000006', 'e1200000-0000-4000-8000-000000000006', 'web', decode(repeat('16',32),'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values
  ('e2000000-0000-4000-8000-000000000001', 'quality-primary', 'Quality primary', 'e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000002', 'quality-other', 'Quality other', 'e1000000-0000-4000-8000-000000000006');
insert into public.organization_memberships (organization_id, user_id, role) values
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','owner'),
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002','member'),
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003','member'),
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004','member'),
  ('e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000005','member'),
  ('e2000000-0000-4000-8000-000000000002','e1000000-0000-4000-8000-000000000006','owner');

insert into public.organization_units (id, organization_id, kind, name, created_by_user_id) values
  ('e2100000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','team','Quality unit','e1000000-0000-4000-8000-000000000001');
insert into public.organization_role_assignments (
  id, organization_id, user_id, role_name, scope_type, unit_id,
  granted_by_user_id, grant_reason
) values
  ('e2200000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003','language_reviewer','unit','e2100000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','First bilingual quality reviewer'),
  ('e2200000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004','language_reviewer','unit','e2100000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','Second bilingual quality reviewer');

insert into public.conversations (
  id, organization_id, kind, name, unit_id, created_by_user_id
) values (
  'e3000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001',
  'group','Quality review room','e2100000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','owner','e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002','member','e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000003','admin','e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000004','admin','e1000000-0000-4000-8000-000000000001'),
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000005','member','e1000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}',true);
select set_config('app.bff_service_context','on',true);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000001','text','Valve 7 must remain closed.','en'),
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000001','e4000000-0000-4000-8000-000000000002','text','Shift handoff source remains canonical.','en');

insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language, target_language,
  status, translated_body, provider, model, confidence
) values
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',(select id from public.messages where client_nonce='e4000000-0000-4000-8000-000000000001'),'en','ko','completed','밸브 7을 열어야 합니다.','openrouter','qwen/pinned',0.81),
  ('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',(select id from public.messages where client_nonce='e4000000-0000-4000-8000-000000000001'),'en','es','completed','La válvula 7 debe permanecer cerrada.','openrouter','qwen/pinned',0.98);

with source as (
  select message.id, extensions.digest(convert_to('summary-source-v1','UTF8'),'sha256') fingerprint
  from public.messages message where message.client_nonce='e4000000-0000-4000-8000-000000000002'
)
insert into public.conversation_summaries (
  id, organization_id, conversation_id, version_number,
  source_message_ids, source_first_message_id, source_last_message_id,
  source_fingerprint, output_fingerprint, requested_by_user_id, request_mode,
  language_code, status, primary_topic, summary_body, key_topics,
  decisions, action_items, ambiguities, processor_type, provider, model,
  processor_provenance
)
select 'e5000000-0000-4000-8000-000000000001','e2000000-0000-4000-8000-000000000001',
  'e3000000-0000-4000-8000-000000000001',1,array[source.id],source.id,source.id,
  source.fingerprint,extensions.digest(convert_to('summary-output-v1','UTF8'),'sha256'),
  'e1000000-0000-4000-8000-000000000002','manual','en','draft','Shift status',
  'Everything is on track.',array['operations'],'[]'::jsonb,'[]'::jsonb,array[]::text[],
  'ai','openrouter','qwen/pinned','{"route":"zdr"}'::jsonb
from source;

insert into public.conversation_preferences (
  organization_id, conversation_id, user_id, translation_mode
) values (
  'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000002','off'
);

select ok(
  has_function_privilege('service_role','public.bff_report_ai_output_error(uuid,uuid,uuid,text,bigint,uuid,text,text,boolean,boolean,text,text,text)','execute')
  and not has_function_privilege('authenticated','public.bff_report_ai_output_error(uuid,uuid,uuid,text,bigint,uuid,text,text,boolean,boolean,text,text,text)','execute')
  and has_function_privilege('service_role','public.bff_list_my_ai_output_error_reports(uuid,uuid,uuid,integer)','execute')
  and has_function_privilege('service_role','public.bff_list_ai_output_error_reports_for_review(uuid,uuid,uuid,integer)','execute')
  and has_function_privilege('service_role','public.bff_read_ai_output_error_report(uuid,uuid,uuid,uuid)','execute')
  and not has_function_privilege('authenticated','public.bff_read_ai_output_error_report(uuid,uuid,uuid,uuid)','execute')
  and has_function_privilege('service_role','public.bff_review_ai_output_error_report(uuid,uuid,uuid,uuid,integer,text,text,text,text)','execute')
  and has_function_privilege('service_role','public.bff_propose_ai_regression_example(uuid,uuid,uuid,uuid,integer,text,text,text,text,boolean,text,text,text)','execute')
  and has_function_privilege('service_role','public.bff_decide_ai_regression_example(uuid,uuid,uuid,uuid,integer,text,text,text,text)','execute')
  and has_function_privilege('service_role','public.bff_claim_ai_regression_examples(bytea,integer)','execute')
  and not has_function_privilege('authenticated','public.bff_claim_ai_regression_examples(bytea,integer)','execute'),
  'report and export workflows are service-only BFF contracts'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.ai_output_error_reports'::regclass)
  and not has_table_privilege('service_role','private.ai_output_error_reports','select'),
  'quality evidence is forced-RLS and has no direct service-role table access'
);

set local role service_role;
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}',true);
select throws_ok(
  $$select public.bff_report_ai_output_error('e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001','translation',(select id from public.message_translations where target_language='ko'),null,'unsafe_wording','Meaning is reversed',false,true,'quality-consent-v1','quality-pref-off',repeat('1',64))$$,
  '42501',null,'translation-off preference blocks access to the derived projection'
);
select throws_ok(
  $$select public.bff_report_ai_output_error('e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000002','e1100000-0000-4000-8000-000000000001','translation',(select id from public.message_translations where target_language='ko'),null,'unsafe_wording','Cross tenant attempt',true,true,'quality-consent-v1','quality-cross-tenant',repeat('2',64))$$,
  '42501',null,'tenant binding rejects cross-organization target guessing'
);

reset role;
select set_config('app.bff_service_context','on',true);
update public.conversation_preferences set translation_mode='automatic'
where organization_id='e2000000-0000-4000-8000-000000000001'
  and conversation_id='e3000000-0000-4000-8000-000000000001'
  and user_id='e1000000-0000-4000-8000-000000000002';
set local role service_role;
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}',true);
create temporary table quality_receipts (name text primary key, payload jsonb);
insert into quality_receipts values (
  'translation-report', public.bff_report_ai_output_error(
    'e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001',
    'translation',(select id from public.message_translations where target_language='ko'),null,
    'unsafe_wording','Meaning is reversed',false,true,'quality-consent-v1',
    'quality-translation-report',repeat('3',64)
  )
);
select ok(
  (select payload->>'status'='open' and (payload->>'high_consequence')::boolean
    and payload#>>'{target_snapshot,translated_body}'='밸브 7을 열어야 합니다.'
    and payload#>>'{target_snapshot,output_fingerprint}'=payload->>'target_output_fingerprint'
    from quality_receipts where name='translation-report'),
  'translation intake freezes the exact output and cannot downgrade unsafe wording'
);
select is(
  public.bff_report_ai_output_error(
    'e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001',
    'translation',(select id from public.message_translations where target_language='ko'),null,
    'incorrect_meaning','Different duplicate details',true,true,'quality-consent-v1',
    'quality-translation-duplicate',repeat('4',64)
  )->>'report_id',
  (select payload->>'report_id' from quality_receipts where name='translation-report'),
  'different idempotency key deterministically returns the active target report'
);
insert into quality_receipts values (
  'summary-report', public.bff_report_ai_output_error(
    'e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001',
    'summary',null,'e5000000-0000-4000-8000-000000000001','unsupported_claim',
    'The source does not support this conclusion',false,false,'quality-consent-v1',
    'quality-summary-report',repeat('5',64)
  )
);
select ok(
  (select payload#>>'{target_snapshot,summary_body}'='Everything is on track.'
    and jsonb_array_length(payload#>'{target_snapshot,source_message_ids}')=1
    from quality_receipts where name='summary-report'),
  'summary intake freezes the exact structured output and source identifiers'
);
select is(
  jsonb_array_length(public.bff_list_my_ai_output_error_reports(
    'e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001',50
  )->'reports'),2,'reporter list returns both currently authorized exact snapshots'
);
select throws_ok(
  $$select public.bff_list_my_ai_output_error_reports('e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001',101)$$,
  '22023',null,'report lists enforce their configured bound'
);

reset role;
insert into public.message_user_visibility (
  organization_id, conversation_id, message_id, user_id
) values (
  'e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce='e4000000-0000-4000-8000-000000000001'),
  'e1000000-0000-4000-8000-000000000002'
);
set local role service_role;
select is(
  jsonb_array_length(public.bff_list_my_ai_output_error_reports(
    'e1000000-0000-4000-8000-000000000002','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001',50
  )->'reports'),1,'self list rechecks current dynamic message visibility before releasing a snapshot'
);

select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal1"}',true);
select throws_ok(
  $$select public.bff_list_ai_output_error_reports_for_review('e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000002',50)$$,
  '42501',null,'review queue requires a recent AAL2 session'
);
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000005","role":"service_role","aal":"aal2"}',true);
select is(
  jsonb_array_length(public.bff_list_ai_output_error_reports_for_review(
    'e1000000-0000-4000-8000-000000000005','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000005',50
  )->'reports'),0,'unscoped member receives no reviewer queue content'
);
select throws_ok(
  $$select public.bff_review_ai_output_error_report('e1000000-0000-4000-8000-000000000005','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000005',(select (payload->>'report_id')::uuid from quality_receipts where name='translation-report'),1,'confirmed_error','Unauthorized review','quality-review-unscoped',repeat('6',64))$$,
  '42501',null,'unscoped member cannot review a report'
);

select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal2"}',true);
select is(
  jsonb_array_length(public.bff_list_ai_output_error_reports_for_review(
    'e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',50
  )->'reports'),2,'scoped AAL2 language reviewer receives the exact queue'
);
select ok(
  (select detail->'report'->>'report_id' = (select payload->>'report_id' from quality_receipts where name='translation-report')
      and detail->'report'#>>'{target_snapshot,translated_body}' = '밸브 7을 열어야 합니다.'
      and detail->'regression_example' = 'null'::jsonb
    from (select public.bff_read_ai_output_error_report(
      'e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001',
      'e1100000-0000-4000-8000-000000000003',
      (select (payload->>'report_id')::uuid from quality_receipts where name='translation-report')
    ) detail) row),
  'scoped AAL2 detail returns the preserved exact output without a fabricated example'
);
insert into quality_receipts values (
  'translation-reviewed', public.bff_review_ai_output_error_report(
    'e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',
    (select (payload->>'report_id')::uuid from quality_receipts where name='translation-report'),1,
    'confirmed_error','Verified safety reversal','quality-review-translation',repeat('7',64)
  )
);
select is((select payload->>'version' from quality_receipts where name='translation-reviewed'),'2','review transition increments the exact CAS version');
select throws_ok(
  $$select public.bff_review_ai_output_error_report('e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',(select (payload->>'report_id')::uuid from quality_receipts where name='translation-report'),1,'confirmed_error','Stale replay','quality-review-stale',repeat('8',64))$$,
  '40001',null,'stale report review version is rejected'
);
insert into quality_receipts values (
  'summary-reviewed', public.bff_review_ai_output_error_report(
    'e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',
    (select (payload->>'report_id')::uuid from quality_receipts where name='summary-report'),1,
    'confirmed_error','Unsupported summary claim confirmed','quality-review-summary',repeat('9',64)
  )
);
select throws_ok(
  $$select public.bff_propose_ai_regression_example('e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',(select (payload->>'report_id')::uuid from quality_receipts where name='summary-report'),2,'en','Deidentified source','Observed unsupported claim','Correct expected account',true,'deidentification-v1','quality-proposal-no-consent',repeat('a',64))$$,
  '42501',null,'regression proposal requires the reporter explicit quality-use consent'
);

select is(
  public.bff_review_conversation_summary(
    'e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',
    'e5000000-0000-4000-8000-000000000001','reject','Unsupported conclusion',
    'quality-summary-reject',repeat('b',64)
  )->>'status','failed','authorized reviewer can reject the exact summary draft'
);
reset role;
select ok(
  (select status='failed' and failure_code='human_rejected'
      and reviewed_by_user_id='e1000000-0000-4000-8000-000000000003'
      and reviewed_at is not null and review_note='Unsupported conclusion'
      and summary_body is null and output_fingerprint is null
   from public.conversation_summaries where id='e5000000-0000-4000-8000-000000000001')
  and (select count(*)=1 and bool_and(octet_length(source_fingerprint)=32 and octet_length(output_fingerprint)=32)
    from private.conversation_summary_review_records where summary_id='e5000000-0000-4000-8000-000000000001'),
  'rejection clears the projection but durably retains reviewer and exact fingerprints'
);

set local role service_role;
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal2"}',true);
select throws_ok(
  $$select public.bff_propose_ai_regression_example('e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',(select (payload->>'report_id')::uuid from quality_receipts where name='translation-report'),2,'en','Valve state instruction','Open the valve','Keep the valve closed',false,'deidentification-v1','quality-proposal-no-attest',repeat('c',64))$$,
  '22023',null,'proposal requires an explicit human deidentification attestation'
);
insert into quality_receipts values (
  'regression-proposal', public.bff_propose_ai_regression_example(
    'e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',
    (select (payload->>'report_id')::uuid from quality_receipts where name='translation-report'),2,
    'en','Valve state instruction','Open the valve','Keep the valve closed',true,
    'deidentification-v1','quality-proposal-valid',repeat('d',64)
  )
);
select is((select payload->>'consequence_level' from quality_receipts where name='regression-proposal'),'high_consequence','high-consequence classification is derived and preserved');
select throws_ok(
  $$select public.bff_decide_ai_regression_example('e1000000-0000-4000-8000-000000000003','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000003',(select (payload->>'example_id')::uuid from quality_receipts where name='regression-proposal'),1,'approved','Self approval attempt','quality-self-approve',repeat('e',64))$$,
  '42501',null,'proposal author cannot act as the required second reviewer'
);
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000004","role":"service_role","aal":"aal2"}',true);
insert into quality_receipts values (
  'regression-approved', public.bff_decide_ai_regression_example(
    'e1000000-0000-4000-8000-000000000004','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000004',
    (select (payload->>'example_id')::uuid from quality_receipts where name='regression-proposal'),1,
    'approved','Independent bilingual approval','quality-second-approve',repeat('f',64)
  )
);
select ok(
  (select payload->>'status'='approved' and payload->>'version'='2'
    and payload->>'decided_by_user_id'='e1000000-0000-4000-8000-000000000004'
    from quality_receipts where name='regression-approved'),
  'distinct scoped AAL2 second reviewer approves the exact proposal version'
);
select throws_ok(
  $$select public.bff_decide_ai_regression_example('e1000000-0000-4000-8000-000000000004','e2000000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000004',(select (payload->>'example_id')::uuid from quality_receipts where name='regression-proposal'),1,'approved','Stale second approval','quality-second-stale',repeat('0',64))$$,
  '40001',null,'stale regression decision version is rejected'
);

select set_config('request.jwt.claims','{"role":"service_role"}',true);
create temporary table quality_export as
select public.bff_claim_ai_regression_examples(decode(repeat('ab',32),'hex'),20) payload;
select ok(
  (select (payload->>'claimed_count')::integer=1 and jsonb_array_length(payload->'examples')=1
      and payload#>>'{examples,0,consequence_level}'='high_consequence'
      and payload::text !~ '(organization_id|user_id|report_id|summary_id|translation_id|message_id|example_id|e[12345]000000-0000-4000-8000-00000000000)'
   from quality_export),
  'service claim returns only deidentified evaluation content without tenant, actor, or target identifiers'
);
reset role;
select ok(
  (select status='exported' and version=3 and exported_at is not null
      and octet_length(export_worker_hash)=32
   from private.ai_regression_examples
   where id=(select (payload->>'example_id')::uuid from quality_receipts where name='regression-proposal')),
  'successful claim durably records one exported terminal version'
);
select set_config('request.jwt.claims','{"sub":"e1000000-0000-4000-8000-000000000004","role":"service_role","aal":"aal2"}',true);
select set_config('app.bff_service_context','on',true);
select throws_ok(
  $$update private.ai_output_error_reports set target_snapshot='{}'::jsonb where id=(select (payload->>'report_id')::uuid from quality_receipts where name='translation-report')$$,
  '40001',null,'exact report snapshots cannot be rewritten'
);
select throws_ok(
  $$update private.ai_regression_examples set deidentified_expected_output='Changed after export' where id=(select (payload->>'example_id')::uuid from quality_receipts where name='regression-proposal')$$,
  '40001',null,'exported regression content cannot be rewritten'
);
select throws_ok(
  $$update private.ai_output_error_report_events set metadata='{}'::jsonb where report_id=(select (payload->>'report_id')::uuid from quality_receipts where name='translation-report')$$,
  '55000',null,'quality lifecycle events are append-only'
);
select throws_ok(
  $$delete from private.ai_output_error_reports where id=(select (payload->>'report_id')::uuid from quality_receipts where name='translation-report')$$,
  '55000',null,'quality report evidence cannot be deleted'
);
select is((select count(*)::bigint from private.ai_output_error_reports),2::bigint,'duplicates and failed attempts leave exactly two durable reports');
select ok(
  (select count(*)>=6 from private.ai_output_error_report_events)
  and (select count(*)>=6 from public.audit_events where organization_id='e2000000-0000-4000-8000-000000000001' and event_type like 'ai_output.%'),
  'accepted lifecycle changes append content-free private and audit evidence'
);
select is(
  (select body from public.messages where client_nonce='e4000000-0000-4000-8000-000000000001'),
  'Valve 7 must remain closed.','quality workflows never alter the canonical original message'
);

select * from finish();
rollback;
