begin;
select plan(3);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixture: an English sender (profile preferred_language en) whose message
-- has no language_code; a pending detection job claimed by a worker.
insert into auth.users (id, email, email_confirmed_at) values
  ('df000000-0000-4000-8000-000000000001', 'fb-alice@example.test', now()),
  ('df000000-0000-4000-8000-000000000002', 'fb-bob@example.test', now());
select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id when 'df000000-0000-4000-8000-000000000001' then 'fb_alice' else 'fb_bob' end,
    display_name = case user_id when 'df000000-0000-4000-8000-000000000001' then 'Fallback Alice' else 'Fallback Bob' end,
    preferred_language = case user_id when 'df000000-0000-4000-8000-000000000001' then 'en' else 'es' end
where user_id in ('df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000002');
select set_config('app.bff_service_context', 'off', true);
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('df100000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('df100000-0000-4000-8000-000000000002', 'df000000-0000-4000-8000-000000000002', now(), now(), 'aal1');
insert into private.session_installations (session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family) values
  ('df100000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000001', 'df200000-0000-4000-8000-000000000001', 'ios', decode(repeat('a1', 32), 'hex'), 'iphone'),
  ('df100000-0000-4000-8000-000000000002', 'df000000-0000-4000-8000-000000000002', 'df200000-0000-4000-8000-000000000002', 'ios', decode(repeat('a2', 32), 'hex'), 'iphone');
insert into public.organizations (id, slug, name, default_language, allow_member_direct_messages, dm_policy, require_mfa_for_admins, created_by_user_id)
values ('11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en', true, 'request_first', true, 'df000000-0000-4000-8000-000000000001');
insert into public.organization_memberships (organization_id, user_id, role, status, directory_visibility)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array['df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000002']::uuid[]) member_id;
select private.ensure_personal_realm_ai_policy();

create temporary table fb_request on commit drop as
select public.bff_send_message_request(
  'df000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'df100000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000002',
  'Unread probe 1cn5'
) as receipt;
create temporary table fb_message on commit drop as
select id, body from public.messages
where conversation_id = (select (receipt ->> 'conversation_id')::uuid from fb_request)
order by id desc limit 1;
create temporary table fb_job on commit drop as
select id from private.outbox_jobs
where topic = 'language_detection' and (payload ->> 'message_id')::bigint = (select id from fb_message);

-- A worker claims the job and reports an undetermined language.
create temporary table fb_claim on commit drop as
select public.bff_claim_language_detection_jobs('dfa00000-0000-4000-8000-000000000001', 1, 60) as claimed;
select public.bff_complete_language_detection_job(
  'dfa00000-0000-4000-8000-000000000001', (select id from fb_job),
  encode(extensions.digest(convert_to((select body from fb_message), 'UTF8'), 'sha256'), 'hex'),
  'ambiguous', 'und', 'openrouter:structured-v1', 0.9
);

select is(
  (select language_detection_state from public.messages where id = (select id from fb_message)),
  'completed',
  'an undetermined detection completes as the sender language'
);
select is(
  (select detected_language || ' / ' || language_detection_method from public.messages where id = (select id from fb_message)),
  'en / openrouter:structured-v1:sender-language',
  'the fallback records the sender language and marks the method'
);
select is(
  (select status from public.message_translations where message_id = (select id from fb_message) and target_language = 'es'),
  'queued',
  'the Spanish translation proceeds instead of being blocked as language_ambiguous'
);

select * from finish();
rollback;
