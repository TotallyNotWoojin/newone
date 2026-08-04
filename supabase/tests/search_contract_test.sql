begin;
select plan(40);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('61000000-0000-4000-8000-000000000001', 'search-owner@example.test', now()),
  ('61000000-0000-4000-8000-000000000002', 'search-sender@example.test', now()),
  ('61000000-0000-4000-8000-000000000003', 'search-suspended@example.test', now());

update public.profiles set display_name = case user_id
  when '61000000-0000-4000-8000-000000000001' then 'Search Owner'
  when '61000000-0000-4000-8000-000000000002' then 'Daniel "Danny" Sender'
  when '61000000-0000-4000-8000-000000000003' then 'Disabled Directory Needle'
  else display_name end
where user_id in (
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000002',
  '61000000-0000-4000-8000-000000000003'
);

update public.profiles
set preferred_language = 'es'
where user_id = '61000000-0000-4000-8000-000000000002';

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values (
  '61100000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001', now(), now(), 'aal2'
), (
  '61100000-0000-4000-8000-000000000002',
  '61000000-0000-4000-8000-000000000003', now(), now(), 'aal1'
), (
  '61100000-0000-4000-8000-000000000003',
  '61000000-0000-4000-8000-000000000002', now(), now(), 'aal1'
);

insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values (
  '61100000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  '61200000-0000-4000-8000-000000000001',
  'web', decode(repeat('61', 32), 'hex'), 'desktop'
), (
  '61100000-0000-4000-8000-000000000002',
  '61000000-0000-4000-8000-000000000003',
  '61200000-0000-4000-8000-000000000002',
  'web', decode(repeat('62', 32), 'hex'), 'desktop'
), (
  '61100000-0000-4000-8000-000000000003',
  '61000000-0000-4000-8000-000000000002',
  '61200000-0000-4000-8000-000000000003',
  'web', decode(repeat('63', 32), 'hex'), 'desktop'
);

insert into public.organizations (
  id, slug, name, created_by_user_id
) values (
  '62000000-0000-4000-8000-000000000001',
  'search-contract', 'Search Contract',
  '61000000-0000-4000-8000-000000000001'
), (
  '62000000-0000-4000-8000-000000000002',
  'other-search-contract', 'Other Search Contract',
  '61000000-0000-4000-8000-000000000002'
);

insert into public.organization_memberships (
  organization_id, user_id, role, status,
  security_changed_at, security_changed_by_user_id, status_change_reason
) values
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 'owner', 'active', null, null, null),
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', 'member', 'active', null, null, null),
  ('62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000003', 'member', 'suspended', now(), '61000000-0000-4000-8000-000000000001', 'Disabled for search authorization proof'),
  ('62000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', 'owner', 'active', null, null, null);

insert into public.conversations (
  id, organization_id, kind, name, history_policy, created_by_user_id
) values
  ('63000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001', 'group', 'Search room', 'all', '61000000-0000-4000-8000-000000000001'),
  ('63000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001', 'group', 'Restricted history', 'since_join', '61000000-0000-4000-8000-000000000002'),
  ('63000000-0000-4000-8000-000000000003', '62000000-0000-4000-8000-000000000001', 'group', 'Sender only room', 'all', '61000000-0000-4000-8000-000000000002');

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id,
  history_visible_from
) values
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001', 'owner', '61000000-0000-4000-8000-000000000001', null),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', 'member', '61000000-0000-4000-8000-000000000001', null),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', 'owner', '61000000-0000-4000-8000-000000000002', null),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000002', 'owner', '61000000-0000-4000-8000-000000000002', null);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"61000000-0000-4000-8000-000000000001","session_id":"61100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, created_at, available_at
) values (
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000001',
  '64000000-0000-4000-8000-000000000002',
  'text', 'Cafe protocol archived', now(), now()
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"61000000-0000-4000-8000-000000000002","session_id":"61100000-0000-4000-8000-000000000003","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, created_at, available_at
) values
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000001', 'text', 'Café protocol current', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000003', 'text', '기본 소스', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000004', 'text', '오래된 소스', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000005', 'attachment', null, now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000006', 'attachment', null, now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000007', 'text', 'hiddenneedle confidential', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000008', 'text', 'futureneedle embargoed', now(), now() + interval '1 day'),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000009', 'text', 'historyneedle restricted', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000010', 'text', 'cursorprobe first', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000011', 'text', 'cursorprobe second', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000012', 'text', 'cursorprobe third', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000013', 'text', 'unauthorizedroomneedle private', now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000014', 'text', 'expiredretentionneedle old', now(), now());
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

alter table public.messages disable trigger messages_10_validate_update;
update public.messages
set created_at = case client_nonce
      when '64000000-0000-4000-8000-000000000001' then now() - interval '1 hour'
      when '64000000-0000-4000-8000-000000000002' then now() - interval '10 days'
      when '64000000-0000-4000-8000-000000000003' then now() - interval '50 minutes'
      when '64000000-0000-4000-8000-000000000004' then now() - interval '45 minutes'
      when '64000000-0000-4000-8000-000000000005' then now() - interval '40 minutes'
      when '64000000-0000-4000-8000-000000000006' then now() - interval '35 minutes'
      when '64000000-0000-4000-8000-000000000007' then now() - interval '30 minutes'
      when '64000000-0000-4000-8000-000000000009' then now() - interval '2 days'
      when '64000000-0000-4000-8000-000000000010' then now() - interval '3 hours'
      when '64000000-0000-4000-8000-000000000011' then now() - interval '2 hours'
      when '64000000-0000-4000-8000-000000000012' then now() - interval '90 minutes'
      when '64000000-0000-4000-8000-000000000013' then now() - interval '25 minutes'
      when '64000000-0000-4000-8000-000000000014' then now() - interval '20 days'
      else created_at
    end,
    available_at = case client_nonce
      when '64000000-0000-4000-8000-000000000001' then now() - interval '1 hour'
      when '64000000-0000-4000-8000-000000000002' then now() - interval '10 days'
      when '64000000-0000-4000-8000-000000000003' then now() - interval '50 minutes'
      when '64000000-0000-4000-8000-000000000004' then now() - interval '45 minutes'
      when '64000000-0000-4000-8000-000000000005' then now() - interval '40 minutes'
      when '64000000-0000-4000-8000-000000000006' then now() - interval '35 minutes'
      when '64000000-0000-4000-8000-000000000007' then now() - interval '30 minutes'
      when '64000000-0000-4000-8000-000000000009' then now() - interval '2 days'
      when '64000000-0000-4000-8000-000000000010' then now() - interval '3 hours'
      when '64000000-0000-4000-8000-000000000011' then now() - interval '2 hours'
      when '64000000-0000-4000-8000-000000000012' then now() - interval '90 minutes'
      when '64000000-0000-4000-8000-000000000013' then now() - interval '25 minutes'
      when '64000000-0000-4000-8000-000000000014' then now() - interval '20 days'
      else available_at
    end
where organization_id = '62000000-0000-4000-8000-000000000001';
alter table public.messages enable trigger messages_10_validate_update;

update public.messages
set body = null, deleted_at = now(), deletion_reason = 'retention'
where client_nonce = '64000000-0000-4000-8000-000000000014';

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id,
  history_visible_from
) values (
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000002',
  '61000000-0000-4000-8000-000000000001', 'member',
  '61000000-0000-4000-8000-000000000002', now() - interval '1 day'
);

insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language,
  target_language, status, translated_body, provider, model
) values
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000003'), 'ko', 'en', 'completed', 'evacuation rendezvous', 'test-provider', 'test-model'),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000004'), 'ko', 'en', 'completed', 'obsolete rendezvous', 'test-provider', 'test-model');

-- Simulate a legacy/stale derived row. Search must bind translations to the
-- current source hash even if stale data survives an interrupted cleanup.
alter table public.message_translations disable trigger message_translations_10_validate_write;
update public.message_translations
set source_body_sha256 = decode(repeat('00', 32), 'hex')
where message_id = (
  select id from public.messages
  where client_nonce = '64000000-0000-4000-8000-000000000004'
);
alter table public.message_translations enable trigger message_translations_10_validate_write;

insert into public.translation_corrections (
  organization_id, conversation_id, message_id, target_language,
  corrected_body, rationale, proposed_by_user_id, status,
  reviewed_by_user_id, reviewed_at, review_note
) values (
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000003'),
  'en', 'approved muster station', 'Synthetic search correction',
  '61000000-0000-4000-8000-000000000002', 'approved',
  '61000000-0000-4000-8000-000000000001', now(), 'Approved for synthetic contract proof'
);

insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  storage_path, file_name, mime_type, detected_mime_type, byte_size,
  scan_status, scan_completed_at, scanner_name, scanner_version,
  scan_policy_code
) values
  ('65000000-0000-4000-8000-000000000001', '62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000005'), '61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001/61000000-0000-4000-8000-000000000002/65000000-0000-4000-8000-000000000001/upload', 'quarterly-roster.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 512, 'clean', now(), 'fixture-scanner', '1.0', null),
  ('65000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000006'), '61000000-0000-4000-8000-000000000002', '62000000-0000-4000-8000-000000000001/63000000-0000-4000-8000-000000000001/61000000-0000-4000-8000-000000000002/65000000-0000-4000-8000-000000000002/upload', 'malware-rendezvous.pdf', 'application/pdf', 'application/pdf', 512, 'quarantined', now(), 'fixture-scanner', '1.0', 'malware_detected');

insert into public.message_user_visibility (
  organization_id, conversation_id, message_id, user_id
) values (
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '64000000-0000-4000-8000-000000000007'),
  '61000000-0000-4000-8000-000000000001'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"61000000-0000-4000-8000-000000000002","session_id":"61100000-0000-4000-8000-000000000003","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, language_code, detected_language, language_detection_state,
  language_detection_method, language_detection_confidence, language_detected_at,
  created_at, available_at
) values
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000016', 'text', '설비 압력 점검 완료', 'ko', 'ko', 'completed', 'fixture', 0.99, now(), now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000017', 'text', 'Válvula presión crítica', 'es', 'es', 'completed', 'fixture', 0.99, now(), now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000018', 'text', 'Inspect PUMP-204B seal before startup', 'en', 'en', 'completed', 'fixture', 0.99, now(), now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000019', 'text', 'Inspect PUMP standby 204B seal before startup', 'en', 'en', 'completed', 'fixture', 0.99, now(), now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000020', 'text', 'filterneedle first room', 'en', 'en', 'completed', 'fixture', 0.99, now(), now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000021', 'text', 'filterneedle second room', 'en', 'en', 'completed', 'fixture', 0.99, now(), now(), now()),
  ('62000000-0000-4000-8000-000000000001', '63000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000002', '64000000-0000-4000-8000-000000000022', 'text', 'spooflangneedle pending detection', 'es', null, 'pending', null, null, null, now(), now());
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select jsonb_array_length(result -> 'results') = 1
      and result #>> '{results,0,matched_language}' = 'ko'
   from (select public.bff_search(
     p_actor_user_id => '61000000-0000-4000-8000-000000000001',
     p_organization_id => '62000000-0000-4000-8000-000000000001',
     p_session_id => '61100000-0000-4000-8000-000000000001',
     p_query => '압력', p_types => array['messages']::text[], p_language => 'ko'
   ) result) searched),
  'Korean text is searchable and reports the trusted Korean match language'
);

select is(
  jsonb_array_length(public.bff_search(
    p_actor_user_id => '61000000-0000-4000-8000-000000000001',
    p_organization_id => '62000000-0000-4000-8000-000000000001',
    p_session_id => '61100000-0000-4000-8000-000000000001',
    p_query => '압력', p_types => array['messages']::text[], p_language => 'es'
  ) -> 'results'),
  0,
  'language filters cannot relabel or widen a Korean original match'
);

select is(
  jsonb_array_length(public.bff_search(
    p_actor_user_id => '61000000-0000-4000-8000-000000000001',
    p_organization_id => '62000000-0000-4000-8000-000000000001',
    p_session_id => '61100000-0000-4000-8000-000000000001',
    p_query => 'spooflangneedle', p_types => array['messages']::text[], p_language => 'es'
  ) -> 'results'),
  0,
  'language filters never trust the sender-supplied language hint while detection is pending'
);

select ok(
  (select jsonb_array_length(result -> 'results') = 1
      and result #>> '{results,0,matched_language}' = 'es'
   from (select public.bff_search(
     p_actor_user_id => '61000000-0000-4000-8000-000000000001',
     p_organization_id => '62000000-0000-4000-8000-000000000001',
     p_session_id => '61100000-0000-4000-8000-000000000001',
     p_query => 'presion', p_types => array['messages']::text[], p_language => 'es'
   ) result) searched),
  'Spanish text is accent-normalized and filterable by trusted match language'
);

select ok(
  (select jsonb_array_length(result -> 'results') = 1
      and result #>> '{results,0,title}' = 'Daniel "Danny" Sender'
   from (select public.bff_search(
     p_actor_user_id => '61000000-0000-4000-8000-000000000001',
     p_organization_id => '62000000-0000-4000-8000-000000000001',
     p_session_id => '61100000-0000-4000-8000-000000000001',
     p_query => 'Danny', p_types => array['people']::text[], p_language => 'es'
   ) result) searched),
  'a company-approved literal directory alias is searchable with its profile language'
);

select is(
  jsonb_array_length(public.bff_search(
    p_actor_user_id => '61000000-0000-4000-8000-000000000001',
    p_organization_id => '62000000-0000-4000-8000-000000000001',
    p_session_id => '61100000-0000-4000-8000-000000000001',
    p_query => '"PUMP-204B"', p_types => array['messages']::text[], p_language => 'en'
  ) -> 'results'),
  1,
  'a quoted punctuated equipment ID matches adjacent normalized ID terms only'
);

select is(
  jsonb_array_length(public.bff_search(
    p_actor_user_id => '61000000-0000-4000-8000-000000000001',
    p_organization_id => '62000000-0000-4000-8000-000000000001',
    p_session_id => '61100000-0000-4000-8000-000000000001',
    p_query => '"before seal"', p_types => array['messages']::text[], p_language => 'en'
  ) -> 'results'),
  0,
  'quoted phrase search preserves term order instead of degrading to unordered AND'
);

select ok(
  (select jsonb_array_length(result -> 'results') = 1
      and result #>> '{results,0,conversation_id}' = '63000000-0000-4000-8000-000000000001'
   from (select public.bff_search(
     p_actor_user_id => '61000000-0000-4000-8000-000000000001',
     p_organization_id => '62000000-0000-4000-8000-000000000001',
     p_session_id => '61100000-0000-4000-8000-000000000001',
     p_query => 'filterneedle', p_types => array['messages']::text[],
     p_conversation_id => '63000000-0000-4000-8000-000000000001'
   ) result) searched),
  'conversation filter returns only results from the selected authorized conversation'
);

select ok(
  (select jsonb_array_length(result -> 'results') = 1
      and result #>> '{results,0,conversation_id}' = '63000000-0000-4000-8000-000000000002'
   from (select public.bff_search(
     p_actor_user_id => '61000000-0000-4000-8000-000000000001',
     p_organization_id => '62000000-0000-4000-8000-000000000001',
     p_session_id => '61100000-0000-4000-8000-000000000001',
     p_query => 'filterneedle', p_types => array['messages']::text[],
     p_conversation_id => '63000000-0000-4000-8000-000000000002'
   ) result) searched),
  'conversation filter preserves the selected conversation history boundary'
);

select throws_ok(
  $$select public.bff_search(
    p_actor_user_id => '61000000-0000-4000-8000-000000000001',
    p_organization_id => '62000000-0000-4000-8000-000000000001',
    p_session_id => '61100000-0000-4000-8000-000000000001',
    p_query => 'unauthorizedroomneedle', p_types => array['messages']::text[],
    p_conversation_id => '63000000-0000-4000-8000-000000000003'
  )$$,
  '42501', 'conversation search filter denied',
  'an explicit conversation filter fails closed before searching a conversation the actor has not joined'
);

select throws_ok(
  $$select public.bff_search(
    p_actor_user_id => '61000000-0000-4000-8000-000000000001',
    p_organization_id => '62000000-0000-4000-8000-000000000001',
    p_session_id => '61100000-0000-4000-8000-000000000001',
    p_query => 'pump', p_types => array['messages']::text[], p_language => 'fr'
  )$$,
  '22023', 'invalid search language filter',
  'unsupported language filters fail closed instead of silently widening results'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements(public.bff_search(
      '61000000-0000-4000-8000-000000000001',
      '62000000-0000-4000-8000-000000000001',
      '61100000-0000-4000-8000-000000000001',
      'cafe', array['messages']::text[]
    ) -> 'results') result
    where (result ->> 'id')::bigint = (
      select id from public.messages
      where client_nonce = '64000000-0000-4000-8000-000000000001'
    )
  ),
  'accent-normalized query matches the original message body'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'cafe', array['messages']::text[], null, 20,
    '61000000-0000-4000-8000-000000000002'
  ) -> 'results'),
  1,
  'sender filter binds message results to the exact sender'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'cafe', array['messages']::text[], null, 20, null,
    now() - interval '1 day', now()
  ) -> 'results'),
  1,
  'date range excludes otherwise matching archived messages'
);

select is(
  (select result ->> 'matched_source'
   from jsonb_array_elements(public.bff_search(
     '61000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000001',
     'cafe', array['messages']::text[], null, 20,
     '61000000-0000-4000-8000-000000000002'
   ) -> 'results') result),
  'original',
  'message result identifies the original-body match source'
);

select ok(
  (select jsonb_array_length(search_result -> 'results') = 1
      and search_result #>> '{results,0,matched_source}' = 'translation'
      and search_result #>> '{results,0,matched_language}' = 'en'
   from (select public.bff_search(
     '61000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000001',
     'muster', array['messages']::text[]
   ) search_result) searched),
  'only an effective completed translation bound to the current source hash is searchable'
);

select ok(
  (select jsonb_array_length(search_result -> 'results') = 1
      and search_result #>> '{results,0,matched_source}' = 'attachment_filename'
   from (select public.bff_search(
     '61000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000001',
     'quarterly', array['messages']::text[]
   ) search_result) searched),
  'only a clean attachment filename contributes to search'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'malware', array['messages']::text[]
  ) -> 'results'),
  0,
  'quarantined attachment filenames are never searchable'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'hiddenneedle', array['messages']::text[]
  ) -> 'results'),
  0,
  'delete-for-me visibility suppresses matching search rows'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'futureneedle', array['messages']::text[]
  ) -> 'results'),
  0,
  'scheduled future messages are not searchable before availability'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'historyneedle', array['messages']::text[]
  ) -> 'results'),
  0,
  'since-join history boundaries apply to workspace search'
);

select ok(
  (select jsonb_array_length(search_result -> 'results') = 1
      and search_result #>> '{results,0,matched_source}' = 'translation'
      and search_result #>> '{results,0,snippet}' = 'approved muster station'
   from (select public.bff_search(
     '61000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000001',
     'muster', array['messages']::text[], null, 20, null, null, null,
     array['translation']::text[]
   ) search_result) searched),
  'approved correction text is the effective searchable translation'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'rendezvous', array['messages']::text[], null, 20, null, null, null,
    array['translation']::text[]
  ) -> 'results'),
  0,
  'an approved correction suppresses obsolete machine text and stale translations'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'cafe', array['messages']::text[], null, 20, null, null, null,
    array['original']::text[]
  ) -> 'results'),
  2,
  'original-text source filter returns only original-body matches'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'cafe', array['messages']::text[], null, 20, null, null, null,
    array['translation']::text[]
  ) -> 'results'),
  0,
  'translation source filter cannot fall back to matching original text'
);

select ok(
  (select jsonb_array_length(search_result -> 'results') = 1
      and search_result #>> '{results,0,matched_source}' = 'attachment_filename'
   from (select public.bff_search(
     '61000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000001',
     'quarterly', array['messages']::text[], null, 20, null, null, null,
     array['attachment_filename']::text[]
   ) search_result) searched),
  'clean-filename filter remains isolated from message text'
);

select ok(
  (select jsonb_array_length(search_result -> 'results') > 0
      and not exists (
        select 1 from jsonb_array_elements(search_result -> 'results') result
        where result ->> 'matched_source' <> 'sender'
      )
   from (select public.bff_search(
     '61000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000001',
     'Daniel', array['messages']::text[], null, 20, null, null, null,
     array['sender']::text[]
   ) search_result) searched),
  'sender-name source filter labels every returned message as a sender match'
);

select throws_ok(
  $$select public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'cafe', array['messages', 'people']::text[], null, 20, null, null, null,
    array['original']::text[]
  )$$,
  '22023', 'invalid search message filters',
  'message-only filters reject mixed result types instead of silently widening scope'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'unauthorizedroomneedle', array['messages']::text[]
  ) -> 'results'),
  0,
  'an active tenant member cannot search a conversation they have not joined'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'expiredretentionneedle', array['messages']::text[]
  ) -> 'results'),
  0,
  'retention-scrubbed content is absent from ordinary search'
);

select is(
  jsonb_array_length(public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'Disabled Directory Needle', array['people']::text[]
  ) -> 'results'),
  0,
  'suspended directory members are excluded from people search'
);

select throws_ok(
  $$select public.bff_search(
    '61000000-0000-4000-8000-000000000003',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000002',
    'cafe', array['messages']::text[]
  )$$,
  '42501', 'request authorization denied',
  'a disabled actor cannot invoke unified search'
);

select throws_ok(
  $$select public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000002',
    '61100000-0000-4000-8000-000000000001',
    'cafe', array['messages']::text[]
  )$$,
  '42501', 'request authorization denied',
  'a cursorless cross-tenant search is denied before candidate enumeration'
);

create temporary table search_page_one as
select public.bff_search(
  '61000000-0000-4000-8000-000000000001',
  '62000000-0000-4000-8000-000000000001',
  '61100000-0000-4000-8000-000000000001',
  'cursorprobe', array['messages']::text[], null, 1
) as result;

select ok(
  (select (result ->> 'has_more')::boolean
      and result ->> 'next_cursor' is not null
      and jsonb_array_length(result -> 'results') = 1
   from search_page_one),
  'bounded search emits an opaque continuation cursor'
);

select ok(
  (select jsonb_array_length(next_page.result -> 'results') = 1
      and next_page.result #>> '{results,0,id}'
        <> first.result #>> '{results,0,id}'
   from search_page_one first
   cross join lateral (select public.bff_search(
       '61000000-0000-4000-8000-000000000001',
       '62000000-0000-4000-8000-000000000001',
       '61100000-0000-4000-8000-000000000001',
       'cursorprobe', array['messages']::text[],
       first.result ->> 'next_cursor', 1
     ) as result) next_page),
  'continuation advances without repeating the boundary result'
);

select throws_ok(
  $$select public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'different query', array['messages']::text[],
    (select result ->> 'next_cursor' from search_page_one), 1
  )$$,
  '22023', 'invalid search cursor',
  'cursor cannot be replayed against a different query or filter binding'
);

select throws_ok(
  $$select public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'cursorprobe', array['messages']::text[],
    (select result ->> 'next_cursor' from search_page_one), 1,
    null, null, null, null,
    '63000000-0000-4000-8000-000000000001', null
  )$$,
  '22023', 'invalid search cursor',
  'cursor cannot be replayed with a different conversation or language filter binding'
);

select throws_ok(
  $$select public.bff_search(
    '61000000-0000-4000-8000-000000000001',
    '62000000-0000-4000-8000-000000000001',
    '61100000-0000-4000-8000-000000000001',
    'cursorprobe', array['messages']::text[],
    (select replace(encode(convert_to(
      (convert_from(decode(result ->> 'next_cursor', 'base64'), 'UTF8')::jsonb
        || jsonb_build_object('extra', true))::text,
      'UTF8'
    ), 'base64'), E'\n', '') from search_page_one),
    1
  )$$,
  '22023', 'invalid search cursor',
  'database continuation rejects extra cursor fields even behind the signed edge envelope'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"61000000-0000-4000-8000-000000000002","session_id":"61100000-0000-4000-8000-000000000003","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, created_at, available_at
) values (
  '62000000-0000-4000-8000-000000000001',
  '63000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000002',
  '64000000-0000-4000-8000-000000000015',
  'text', 'cursorprobe arrived after page one', now(), now()
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select not exists (
      select 1 from jsonb_array_elements(next_page.result -> 'results') result_row
      where result_row ->> 'id' = (
        select id::text from public.messages
        where client_nonce = '64000000-0000-4000-8000-000000000015'
      )
    )
   from search_page_one first
   cross join lateral (select public.bff_search(
     '61000000-0000-4000-8000-000000000001',
     '62000000-0000-4000-8000-000000000001',
     '61100000-0000-4000-8000-000000000001',
     'cursorprobe', array['messages']::text[],
     first.result ->> 'next_cursor', 5
   ) as result) next_page),
  'a new write above the page-one boundary never appears in or destabilizes page two'
);

select is(
  (select count(*)::bigint
   from pg_index index_row
   join pg_class index_relation on index_relation.oid = index_row.indexrelid
   join pg_class table_relation on table_relation.oid = index_row.indrelid
   join pg_namespace namespace on namespace.oid = table_relation.relnamespace
   join pg_am access_method on access_method.oid = index_relation.relam
   where namespace.nspname = 'public'
     and index_relation.relname in (
       'messages_body_search_idx',
       'message_translations_completed_search_idx',
       'message_attachments_clean_file_search_idx',
       'translation_corrections_approved_body_search_idx'
     )
     and access_method.amname = 'gin'
     and index_row.indisvalid
     and index_row.indisready),
  4::bigint,
  'original, current translation, approved correction, and clean filename paths have ready GIN indexes'
);

select * from finish();
rollback;
