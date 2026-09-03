begin;
select plan(32);

-- Desync audit (20260903030000): every write path that changes what another
-- device should see must enqueue a realtime_control inbox invalidation for
-- every affected user. This file exercises the row triggers (1a) and
-- command paths (1b) the migration adds, plus the contact lifecycle
-- reasons (decline/cancel/remove/block) that were wired to the generic
-- helper but not yet asserted by pgTAP. Message send/edit/delete, read
-- receipts, language detection, group roster changes, departures, and
-- conversation controls already broadcast (unchanged by this migration) and
-- are covered by their own existing suites, not repeated here.

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Fixtures: six personal-realm consumer accounts.
--   Alice -- Bob:    accepted (workhorse pair/group)
--   Alice -- Carol:  accepted (third group member)
--   Alice -- Dave:   pending, declined by Dave
--   Alice -- Eve:    pending, cancelled by Alice
--   Alice -- Frank:  accepted, then blocked/unblocked/removed by Alice
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('db000000-0000-4000-8000-000000000001', 'da-alice@example.test', now()),
  ('db000000-0000-4000-8000-000000000002', 'da-bob@example.test', now()),
  ('db000000-0000-4000-8000-000000000003', 'da-carol@example.test', now()),
  ('db000000-0000-4000-8000-000000000004', 'da-dave@example.test', now()),
  ('db000000-0000-4000-8000-000000000005', 'da-eve@example.test', now()),
  ('db000000-0000-4000-8000-000000000006', 'da-frank@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id
    when 'db000000-0000-4000-8000-000000000001' then 'da_alice'
    when 'db000000-0000-4000-8000-000000000002' then 'da_bob'
    when 'db000000-0000-4000-8000-000000000003' then 'da_carol'
    when 'db000000-0000-4000-8000-000000000004' then 'da_dave'
    when 'db000000-0000-4000-8000-000000000005' then 'da_eve'
    else 'da_frank'
  end,
  display_name = case user_id
    when 'db000000-0000-4000-8000-000000000001' then 'Desync Alice'
    when 'db000000-0000-4000-8000-000000000002' then 'Desync Bob'
    when 'db000000-0000-4000-8000-000000000003' then 'Desync Carol'
    when 'db000000-0000-4000-8000-000000000004' then 'Desync Dave'
    when 'db000000-0000-4000-8000-000000000005' then 'Desync Eve'
    else 'Desync Frank'
  end
where user_id in (
  'db000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002',
  'db000000-0000-4000-8000-000000000003', 'db000000-0000-4000-8000-000000000004',
  'db000000-0000-4000-8000-000000000005', 'db000000-0000-4000-8000-000000000006'
);
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('db100000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('db100000-0000-4000-8000-000000000003', 'db000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('db100000-0000-4000-8000-000000000004', 'db000000-0000-4000-8000-000000000004', now(), now(), 'aal1'),
  ('db100000-0000-4000-8000-000000000005', 'db000000-0000-4000-8000-000000000005', now(), now(), 'aal1'),
  ('db100000-0000-4000-8000-000000000006', 'db000000-0000-4000-8000-000000000006', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000001', 'db200000-0000-4000-8000-000000000001', 'ios', decode(repeat('c1', 32), 'hex'), 'iphone'),
  ('db100000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000002', 'db200000-0000-4000-8000-000000000002', 'ios', decode(repeat('c2', 32), 'hex'), 'iphone'),
  ('db100000-0000-4000-8000-000000000003', 'db000000-0000-4000-8000-000000000003', 'db200000-0000-4000-8000-000000000003', 'android', decode(repeat('c3', 32), 'hex'), 'android'),
  ('db100000-0000-4000-8000-000000000004', 'db000000-0000-4000-8000-000000000004', 'db200000-0000-4000-8000-000000000004', 'ios', decode(repeat('c4', 32), 'hex'), 'iphone'),
  ('db100000-0000-4000-8000-000000000005', 'db000000-0000-4000-8000-000000000005', 'db200000-0000-4000-8000-000000000005', 'ios', decode(repeat('c5', 32), 'hex'), 'iphone'),
  ('db100000-0000-4000-8000-000000000006', 'db000000-0000-4000-8000-000000000006', 'db200000-0000-4000-8000-000000000006', 'ios', decode(repeat('c6', 32), 'hex'), 'iphone');

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, 'db000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array[
  'db000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002',
  'db000000-0000-4000-8000-000000000003', 'db000000-0000-4000-8000-000000000004',
  'db000000-0000-4000-8000-000000000005', 'db000000-0000-4000-8000-000000000006'
]::uuid[]) member_id;

-- Alice -- Bob and Alice -- Carol: accepted friends (used for the group).
select public.bff_request_contact(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002',
  'da-req-alice-bob', repeat('1', 64)
);
select public.bff_respond_contact(
  'db000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000002', 'db000000-0000-4000-8000-000000000001',
  'accepted', 'da-acc-alice-bob', repeat('2', 64)
);
select public.bff_request_contact(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000003',
  'da-req-alice-carol', repeat('3', 64)
);
select public.bff_respond_contact(
  'db000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000003', 'db000000-0000-4000-8000-000000000001',
  'accepted', 'da-acc-alice-carol', repeat('4', 64)
);

-- Alice -- Frank: accepted (used later for block/unblock/remove).
select public.bff_request_contact(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000006',
  'da-req-alice-frank', repeat('5', 64)
);
select public.bff_respond_contact(
  'db000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000006', 'db000000-0000-4000-8000-000000000001',
  'accepted', 'da-acc-alice-frank', repeat('6', 64)
);

-- The workhorse group: Alice (owner), Bob, Carol -- all accepted friends of
-- the creator, so the friends-only rule (part 2) already permits this.
create temporary table da_group on commit drop as
select public.bff_create_group_conversation_v2(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001',
  'Desync trio', null,
  '[{"user_id":"db000000-0000-4000-8000-000000000002","role":"member"},{"user_id":"db000000-0000-4000-8000-000000000003","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'da-create-group', repeat('7', 64)
) as receipt;

select ok(
  (select receipt ->> 'conversation_id' from da_group) is not null,
  'the workhorse group is created with all three friends as members'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"db000000-0000-4000-8000-000000000001","session_id":"db100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  'db000000-0000-4000-8000-000000000001', 'db400000-0000-4000-8000-000000000001',
  'text', 'Hello trio!', 'en'
);
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table da_message on commit drop as
select id from public.messages where client_nonce = 'db400000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Reactions: every current member re-projects the message.
-- ---------------------------------------------------------------------------
insert into public.message_reactions (organization_id, conversation_id, message_id, user_id, emoji)
values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  (select id from da_message), 'db000000-0000-4000-8000-000000000002', '👍'
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'reaction_added'
     and job.payload ->> 'entity_id' = (select id from da_message)::text),
  3,
  'a reaction fans out to all three group members'
);
select is(
  (select job.payload ->> 'entity_type' from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'reaction_added'
     and job.payload ->> 'user_id' = 'db000000-0000-4000-8000-000000000003'),
  'reaction',
  'the reaction invalidation reaches a member other than the reactor'
);

delete from public.message_reactions
where organization_id = '11111111-1111-4111-8111-111111111111'
  and message_id = (select id from da_message)
  and user_id = 'db000000-0000-4000-8000-000000000002' and emoji = '👍';
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'reaction_removed'
     and job.payload ->> 'entity_id' = (select id from da_message)::text),
  3,
  'removing a reaction fans out to all three group members'
);

-- ---------------------------------------------------------------------------
-- Pins.
-- ---------------------------------------------------------------------------
insert into public.message_pins (organization_id, conversation_id, message_id, pinned_by_user_id)
values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  (select id from da_message), 'db000000-0000-4000-8000-000000000001'
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'message_pinned'
     and job.payload ->> 'entity_id' = (select id from da_message)::text),
  3,
  'pinning a message fans out to all three group members'
);

delete from public.message_pins
where organization_id = '11111111-1111-4111-8111-111111111111'
  and conversation_id = (select (receipt ->> 'conversation_id')::uuid from da_group)
  and message_id = (select id from da_message);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'message_unpinned'
     and job.payload ->> 'entity_id' = (select id from da_message)::text),
  3,
  'unpinning a message fans out to all three group members'
);

-- ---------------------------------------------------------------------------
-- Hide-for-me: private to the acting user's other devices only.
-- ---------------------------------------------------------------------------
insert into public.message_user_visibility (organization_id, conversation_id, message_id, user_id)
values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  (select id from da_message), 'db000000-0000-4000-8000-000000000003'
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'message_hidden_for_user'),
  1,
  'hide-for-me queues exactly one invalidation'
);
select is(
  (select job.payload ->> 'user_id' from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'message_hidden_for_user'),
  'db000000-0000-4000-8000-000000000003',
  'hide-for-me targets only the acting user, not the rest of the group'
);

-- ---------------------------------------------------------------------------
-- Attachment upload completion, then scan verdict, on an available message.
-- ---------------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"db000000-0000-4000-8000-000000000002","session_id":"db100000-0000-4000-8000-000000000002","aal":"aal1"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  'db000000-0000-4000-8000-000000000002', 'db400000-0000-4000-8000-000000000002',
  'attachment', null
);
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table da_attach_message on commit drop as
select id from public.messages where client_nonce = 'db400000-0000-4000-8000-000000000002';

insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  bucket_id, storage_path, file_name, mime_type, byte_size, sha256_hex, scan_status
) values (
  'db500000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  (select id from da_attach_message), 'db000000-0000-4000-8000-000000000002',
  'message-attachments',
  '11111111-1111-4111-8111-111111111111/'
    || (select receipt ->> 'conversation_id' from da_group)
    || '/db000000-0000-4000-8000-000000000002/db500000-0000-4000-8000-000000000001/photo.png',
  'photo.png', 'image/png', 512, repeat('a', 64), 'pending'
);

select is(
  (private.bff_finalize_attachment_upload_impl(
    'db000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
    'db100000-0000-4000-8000-000000000002', 'db500000-0000-4000-8000-000000000001',
    'message-attachments',
    '11111111-1111-4111-8111-111111111111/'
      || (select receipt ->> 'conversation_id' from da_group)
      || '/db000000-0000-4000-8000-000000000002/db500000-0000-4000-8000-000000000001/photo.png',
    512, repeat('a', 64), 'da-finalize-attach', repeat('8', 64)
  )) ->> 'scan_queued',
  'true',
  'finalizing the upload queues a scan job'
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'attachment_uploaded'
     and job.payload ->> 'entity_id' = 'db500000-0000-4000-8000-000000000001'),
  3,
  'attachment upload completion (ready) fans out to all three group members'
);

update public.message_attachments
set scan_status = 'clean', scan_completed_at = now(),
  scanner_name = 'clamav', scanner_version = '1.0.0', detected_mime_type = 'image/png'
where organization_id = '11111111-1111-4111-8111-111111111111'
  and id = 'db500000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'attachment_scan_clean'
     and job.payload ->> 'entity_id' = 'db500000-0000-4000-8000-000000000001'),
  3,
  'a clean scan verdict on an available message fans out to all three group members'
);

-- Not-yet-available message (an avatar-style candidate): the scan verdict
-- concerns only the uploader.
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"db000000-0000-4000-8000-000000000001","session_id":"db100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, kind, body,
  language_detection_state, language_detection_method, language_detected_at,
  available_at, metadata
) values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  'db000000-0000-4000-8000-000000000001', 'attachment', null,
  'not_applicable', 'system', now(), 'infinity'::timestamptz,
  jsonb_build_object('purpose', 'conversation_avatar')
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table da_avatar_message on commit drop as
select id from public.messages
where organization_id = '11111111-1111-4111-8111-111111111111'
  and conversation_id = (select (receipt ->> 'conversation_id')::uuid from da_group)
  and metadata ->> 'purpose' = 'conversation_avatar';

insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  bucket_id, storage_path, file_name, mime_type, byte_size, sha256_hex, scan_status
) values (
  'db500000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  (select id from da_avatar_message), 'db000000-0000-4000-8000-000000000001',
  'message-attachments',
  '11111111-1111-4111-8111-111111111111/'
    || (select receipt ->> 'conversation_id' from da_group)
    || '/db000000-0000-4000-8000-000000000001/db500000-0000-4000-8000-000000000002/avatar.png',
  'avatar.png', 'image/png', 256, repeat('b', 64), 'pending'
);
update public.message_attachments
set scan_status = 'quarantined', scan_completed_at = now(),
  scanner_name = 'clamav', scanner_version = '1.0.0', detected_mime_type = 'image/png'
where organization_id = '11111111-1111-4111-8111-111111111111'
  and id = 'db500000-0000-4000-8000-000000000002';

select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'attachment_scan_quarantined'),
  1,
  'a scan verdict on a not-yet-available message queues exactly one invalidation'
);
select is(
  (select job.payload ->> 'user_id' from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'attachment_scan_quarantined'),
  'db000000-0000-4000-8000-000000000001',
  'a scan verdict on a not-yet-available message reaches only its uploader'
);

-- ---------------------------------------------------------------------------
-- Translation outcomes -- completion is the reason a previous round missed.
-- ---------------------------------------------------------------------------
insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language, target_language,
  source_body_sha256, status, provider, model
) values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  (select id from da_message), 'en', 'ko',
  extensions.digest(convert_to('placeholder', 'UTF8'), 'sha256'), 'queued', 'openrouter', 'qwen/pinned'
);
create temporary table da_translation on commit drop as
select id from public.message_translations
where organization_id = '11111111-1111-4111-8111-111111111111'
  and message_id = (select id from da_message) and target_language = 'ko';

update public.message_translations
set status = 'completed', translated_body = '안녕 트리오!', confidence = 0.92
where organization_id = '11111111-1111-4111-8111-111111111111'
  and id = (select id from da_translation);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'translation_completed'
     and job.payload ->> 'entity_id' = (select id from da_translation)::text),
  3,
  'translation completion fans out to all three group members (the previously missing path)'
);

insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language, target_language,
  source_body_sha256, status, provider, model
) values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  (select id from da_message), 'en', 'es',
  extensions.digest(convert_to('placeholder', 'UTF8'), 'sha256'), 'queued', 'openrouter', 'qwen/pinned'
);
update public.message_translations
set status = 'failed', failure_code = 'provider_error'
where organization_id = '11111111-1111-4111-8111-111111111111'
  and message_id = (select id from da_message) and target_language = 'es';
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'translation_failed'),
  3,
  'translation failure also fans out to all three group members'
);

-- ---------------------------------------------------------------------------
-- Summary lifecycle.
-- ---------------------------------------------------------------------------
insert into public.conversation_summaries (
  id, organization_id, conversation_id, version_number,
  source_message_ids, source_first_message_id, source_last_message_id,
  source_fingerprint, requested_by_user_id, request_mode,
  language_code, status, processor_type, provider, model, processor_provenance
) values (
  'db600000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group), 1,
  array[(select id from da_message)], (select id from da_message), (select id from da_message),
  extensions.digest(convert_to('da-summary-source', 'UTF8'), 'sha256'),
  'db000000-0000-4000-8000-000000000001', 'manual', 'en', 'queued',
  'ai', 'openrouter', 'qwen/pinned', '{"route":"zdr"}'::jsonb
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'summary_queued'
     and job.payload ->> 'entity_id' = 'db600000-0000-4000-8000-000000000001'),
  3,
  'a queued summary request fans out to all three group members'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.conversation_summaries
set status = 'draft', primary_topic = 'Trio chat', summary_body = 'Alice said hello.',
  key_topics = array['greeting'], decisions = '[]'::jsonb, action_items = '[]'::jsonb,
  ambiguities = array[]::text[],
  output_fingerprint = extensions.digest(convert_to('da-summary-output', 'UTF8'), 'sha256')
where id = 'db600000-0000-4000-8000-000000000001';
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'summary_draft'
     and job.payload ->> 'entity_id' = 'db600000-0000-4000-8000-000000000001'),
  3,
  'a drafted summary fans out to all three group members'
);

select set_config('app.bff_service_context', 'on', true);
update public.conversation_summaries
set status = 'approved', reviewed_by_user_id = 'db000000-0000-4000-8000-000000000001',
  reviewed_at = now()
where id = 'db600000-0000-4000-8000-000000000001';
select set_config('app.bff_service_context', 'off', true);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'summary_approved'
     and job.payload ->> 'entity_id' = 'db600000-0000-4000-8000-000000000001'),
  3,
  'an approved summary fans out to all three group members'
);

-- ---------------------------------------------------------------------------
-- Conversation metadata (rename) and conversation preferences (private).
-- ---------------------------------------------------------------------------
update public.conversations
set name = 'Desync trio (renamed)'
where organization_id = '11111111-1111-4111-8111-111111111111'
  and id = (select (receipt ->> 'conversation_id')::uuid from da_group);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'conversation_updated'
     and job.payload ->> 'entity_id' = (select (receipt ->> 'conversation_id') from da_group)),
  3,
  'renaming the group fans out to all three group members'
);

insert into public.conversation_preferences (organization_id, conversation_id, user_id, translation_mode)
values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from da_group),
  'db000000-0000-4000-8000-000000000002', 'off'
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'conversation_preferences_updated'),
  1,
  'a conversation preference change queues exactly one invalidation'
);
select is(
  (select job.payload ->> 'user_id' from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'conversation_preferences_updated'),
  'db000000-0000-4000-8000-000000000002',
  'a conversation preference change reaches only the member who changed it'
);

-- ---------------------------------------------------------------------------
-- Contact lifecycle: decline, cancel, block/unblock, remove. Request and
-- accept are already covered end-to-end by request_sync_and_ai_wake_test.
-- ---------------------------------------------------------------------------
select public.bff_request_contact(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000004',
  'da-req-alice-dave', repeat('9', 64)
);
select public.bff_respond_contact(
  'db000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000004', 'db000000-0000-4000-8000-000000000001',
  'declined', 'da-decline-dave', repeat('a', 64)
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'contact_declined'
     and job.payload ->> 'user_id' in (
       'db000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000004'
     )),
  2,
  'a decline fans out to both the requester and the decliner'
);

select public.bff_request_contact(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000005',
  'da-req-alice-eve', repeat('b', 64)
);
select public.bff_remove_contact(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000005',
  'da-cancel-eve', repeat('c', 64)
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'contact_cancelled'
     and job.payload ->> 'user_id' in (
       'db000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000005'
     )),
  2,
  'a requester-initiated cancel fans out to both participants'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"db000000-0000-4000-8000-000000000001","session_id":"db100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
values ('11111111-1111-4111-8111-111111111111', 'db000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000006');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'member_blocked'),
  2,
  'a block fans out to both the blocker and the blocked member'
);
select is(
  (select job.payload ->> 'entity_id' from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'member_blocked'
     and job.payload ->> 'user_id' = 'db000000-0000-4000-8000-000000000001'),
  'db000000-0000-4000-8000-000000000006',
  'the blocker''s invalidation names the blocked member'
);

delete from public.member_blocks
where organization_id = '11111111-1111-4111-8111-111111111111'
  and blocker_user_id = 'db000000-0000-4000-8000-000000000001'
  and blocked_user_id = 'db000000-0000-4000-8000-000000000006';
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'member_unblocked'),
  2,
  'unblocking fans out to both participants'
);

select public.bff_remove_contact(
  'db000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'db100000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000006',
  'da-remove-frank', repeat('d', 64)
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'contact_removed'
     and job.payload ->> 'user_id' in (
       'db000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000006'
     )),
  2,
  'removing an accepted connection fans out to both former contacts'
);
select ok(
  not exists (
    select 1 from public.contact_connections connection
    where connection.organization_id = '11111111-1111-4111-8111-111111111111'
      and least('db000000-0000-4000-8000-000000000001'::uuid, 'db000000-0000-4000-8000-000000000006'::uuid)
        = connection.member_low_user_id
      and greatest('db000000-0000-4000-8000-000000000001'::uuid, 'db000000-0000-4000-8000-000000000006'::uuid)
        = connection.member_high_user_id
  ),
  'Frank is no longer an accepted contact of Alice after removal'
);

-- ---------------------------------------------------------------------------
-- Profile updates: every directory that renders the profile -- own devices,
-- contacts (pending or accepted), and active conversation co-members.
-- Frank was just removed above, so he must NOT be in this fan-out.
-- ---------------------------------------------------------------------------
select set_config('app.bff_service_context', 'on', true);
update public.profiles
set display_name = 'Alice Desync (updated)'
where user_id = 'db000000-0000-4000-8000-000000000001';
select set_config('app.bff_service_context', 'off', true);

select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'profile_updated'
     and job.payload ->> 'entity_id' = 'db000000-0000-4000-8000-000000000001'),
  3,
  'a profile change reaches Alice''s own devices, her friends, and her group co-members (3: self, Bob, Carol)'
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'profile_updated'
     and job.payload ->> 'entity_id' = 'db000000-0000-4000-8000-000000000001'
     and job.payload ->> 'user_id' = 'db000000-0000-4000-8000-000000000006'),
  0,
  'a removed contact does not receive the profile change invalidation'
);

-- ---------------------------------------------------------------------------
-- Account deletion: the tombstone is reported as 'account_deleted' to every
-- counterpart while memberships are still active.
-- ---------------------------------------------------------------------------
select private.delete_account_impl('db000000-0000-4000-8000-000000000003');
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control' and job.payload ->> 'reason' = 'account_deleted'
     and job.payload ->> 'entity_id' = 'db000000-0000-4000-8000-000000000003'
     and job.payload ->> 'user_id' in (
       'db000000-0000-4000-8000-000000000001', 'db000000-0000-4000-8000-000000000002',
       'db000000-0000-4000-8000-000000000003'
     )),
  3,
  'account deletion tombstones Carol and notifies her, Alice (contact+co-member), and Bob (co-member)'
);
select is(
  (select display_name from public.profiles where user_id = 'db000000-0000-4000-8000-000000000003'),
  'Deleted account',
  'the deleted profile is tombstoned'
);

select * from finish();
rollback;
