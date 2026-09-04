begin;
select plan(4);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: Alice (en) and Bob (es) in the personal realm, connected, with a
-- direct conversation holding one English message from Alice whose
-- detection completed. Bob has no translation row for it (translation was
-- off when it arrived).
insert into auth.users (id, email, email_confirmed_at) values
  ('de000000-0000-4000-8000-000000000001', 'bf-alice@example.test', now()),
  ('de000000-0000-4000-8000-000000000002', 'bf-bob@example.test', now());
select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id when 'de000000-0000-4000-8000-000000000001' then 'bf_alice' else 'bf_bob' end,
    display_name = case user_id when 'de000000-0000-4000-8000-000000000001' then 'Backfill Alice' else 'Backfill Bob' end,
    preferred_language = case user_id when 'de000000-0000-4000-8000-000000000001' then 'en' else 'es' end
where user_id in ('de000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000002');
select set_config('app.bff_service_context', 'off', true);
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('de100000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('de100000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000002', now(), now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('de100000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000001', 'de200000-0000-4000-8000-000000000001', 'ios', decode(repeat('f1', 32), 'hex'), 'iphone'),
  ('de100000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000002', 'de200000-0000-4000-8000-000000000002', 'ios', decode(repeat('f2', 32), 'hex'), 'iphone');
insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, 'de000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (organization_id, user_id, role, status, directory_visibility)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array['de000000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000002']::uuid[]) member_id;
select private.ensure_personal_realm_ai_policy();

create temporary table bf_request on commit drop as
select public.bff_send_message_request(
  'de000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'de100000-0000-4000-8000-000000000001', 'de000000-0000-4000-8000-000000000002',
  'Hello Bob, first message.', 'bf-req', repeat('1', 64)
) as receipt;
select public.bff_respond_contact(
  'de000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'de100000-0000-4000-8000-000000000002', 'de000000-0000-4000-8000-000000000001',
  'accepted', 'bf-acc', repeat('2', 64)
);

-- Bob turns translation off, then Alice's message lands and is detected as English.
select public.bff_update_conversation_preferences(
  'de000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'de100000-0000-4000-8000-000000000002',
  (select (receipt ->> 'conversation_id')::uuid from bf_request),
  '{"translation_mode":"off"}'::jsonb, 'bf-off', repeat('3', 64)
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"de000000-0000-4000-8000-000000000001","session_id":"de100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
select set_config('app.language_detection_context', 'on', true);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code,
  language_detection_state, detected_language, language_detection_method, language_detection_confidence, language_detected_at
) values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from bf_request),
  'de000000-0000-4000-8000-000000000001', 'de400000-0000-4000-8000-000000000001',
  'text', 'The delivery is confirmed for Tuesday afternoon.', 'en',
  'completed', 'en', 'newone-detector-v1', 0.97, now()
);
select set_config('app.language_detection_context', 'off', true);
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table bf_message on commit drop as
select id from public.messages where client_nonce = 'de400000-0000-4000-8000-000000000001';

select is(
  (select count(*)::integer from public.message_translations where message_id = (select id from bf_message)),
  0,
  'no translation row exists while Bob has translation off'
);

-- Bob switches back to Automatic: the message is queued for Spanish.
select public.bff_update_conversation_preferences(
  'de000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'de100000-0000-4000-8000-000000000002',
  (select (receipt ->> 'conversation_id')::uuid from bf_request),
  '{"translation_mode":"automatic"}'::jsonb, 'bf-on', repeat('4', 64)
);
select is(
  (select status from public.message_translations
   where message_id = (select id from bf_message) and target_language = 'es'),
  'queued',
  'the message received while off is queued for Spanish after re-enabling'
);
select is(
  (select source_language from public.message_translations
   where message_id = (select id from bf_message) and target_language = 'es'),
  'en',
  'the backfilled row carries the detected source language'
);
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'translation'
     and job.dedupe_key = 'translation:' || (
       select id::text from public.message_translations
       where message_id = (select id from bf_message) and target_language = 'es'
     )
     and job.status = 'pending'),
  1,
  'one pending translation job was enqueued for the backfilled row'
);

select * from finish();
rollback;
