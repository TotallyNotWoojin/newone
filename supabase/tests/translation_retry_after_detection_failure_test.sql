begin;
select plan(6);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: the personal realm and three consumer accounts provisioned the
-- way open signup provisions them (active member, private directory
-- visibility, unique lowercase username, bound session).
insert into auth.users (id, email, email_confirmed_at) values
  ('99700000-0000-4000-8000-000000000001', 'sync-alice@example.test', now()),
  ('99700000-0000-4000-8000-000000000002', 'sync-bob@example.test', now()),
  ('99700000-0000-4000-8000-000000000003', 'sync-carol@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id
    when '99700000-0000-4000-8000-000000000001' then 'sync_alice'
    when '99700000-0000-4000-8000-000000000002' then 'sync_bob'
    else 'sync_carol'
  end,
  display_name = case user_id
    when '99700000-0000-4000-8000-000000000001' then 'Sync Alice'
    when '99700000-0000-4000-8000-000000000002' then 'Sync Bob'
    else 'Sync Carol'
  end
where user_id in (
  '99700000-0000-4000-8000-000000000001',
  '99700000-0000-4000-8000-000000000002',
  '99700000-0000-4000-8000-000000000003'
);
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('99710000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('99710000-0000-4000-8000-000000000002', '99700000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('99710000-0000-4000-8000-000000000003', '99700000-0000-4000-8000-000000000003', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('99710000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', '99720000-0000-4000-8000-000000000001', 'ios', decode(repeat('b1', 32), 'hex'), 'iphone'),
  ('99710000-0000-4000-8000-000000000002', '99700000-0000-4000-8000-000000000002', '99720000-0000-4000-8000-000000000002', 'ios', decode(repeat('b2', 32), 'hex'), 'iphone'),
  ('99710000-0000-4000-8000-000000000003', '99700000-0000-4000-8000-000000000003', '99720000-0000-4000-8000-000000000003', 'android', decode(repeat('b3', 32), 'hex'), 'android');

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, '99700000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array[
  '99700000-0000-4000-8000-000000000001',
  '99700000-0000-4000-8000-000000000002',

-- ---------------------------------------------------------------------------
-- Translation retry after a failed language detection (20260904060000/070000).
-- ---------------------------------------------------------------------------
create temporary table retry_request on commit drop as
select public.bff_send_message_request(
  '99700000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000001',
  '99700000-0000-4000-8000-000000000002',
  'Retry me after detection fails.'
) as response;

-- The way a terminal provider failure leaves a message (bff_fail_language_detection_job).
create or replace function pg_temp.force_detection_failure() returns void language plpgsql as $$
begin
  perform set_config('app.bff_service_context', 'on', true);
  perform set_config('app.language_detection_context', 'on', true);
  update public.messages
  set detected_language = null, language_detection_state = 'failed',
      language_detection_method = 'newone-detector-v1', language_detection_confidence = null,
      language_detected_at = now()
  where id = (select (response ->> 'message_id')::bigint from retry_request);
  update public.message_translations
  set status = 'blocked', failure_code = 'provider_unavailable'
  where message_id = (select (response ->> 'message_id')::bigint from retry_request);
  perform set_config('app.language_detection_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);
end $$;
select pg_temp.force_detection_failure();

-- Bob (the recipient) asks for a translation through the same implementation
-- the API route calls; the command preamble establishes his actor context.

create temporary table retry_one on commit drop as
select private.bff_enqueue_translation_impl(
  '99700000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000002',
  (select (response ->> 'conversation_id')::uuid from retry_request),
  (select (response ->> 'message_id')::bigint from retry_request),
  'en', 'retry-idem-1', repeat('0', 64)
) as response;

-- 2: the request is accepted as a retry.
select is(
  (select response ->> 'status' || ':' || (response ->> 'retried') from retry_one),
  'queued:true',
  'a failed detection can be retried and reports retried=true'
);

-- 3: detection returns to pending so the worker re-runs it.
select is(
  (select language_detection_state from public.messages
   where id = (select (response ->> 'message_id')::bigint from retry_request)),
  'pending',
  'the retry resets the message to pending detection'
);

-- 4: a fresh detection job is posted under a retry dedupe key.
select ok(
  exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'language_detection' and job.status = 'pending'
      and job.dedupe_key like 'language-detection:%:'
        || (select response ->> 'message_id' from retry_request) || ':%:retry:%'
  ),
  'the retry enqueues a new language_detection job (the completed original cannot shadow it)'
);

-- 5: the translation row for the requested target is queued again.
select is(
  (select status from public.message_translations
   where message_id = (select (response ->> 'message_id')::bigint from retry_request)
     and target_language = 'en'),
  'queued',
  'blocked translation rows return to queued'
);

-- 6: the translation job for that row is pending again (a finished job under
-- the same dedupe key would otherwise shadow the detection completion's enqueue).
select ok(
  exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'translation' and job.status = 'pending'
      and job.dedupe_key = 'translation:' || (
        select translation.id::text from public.message_translations translation
        where translation.message_id = (select (response ->> 'message_id')::bigint from retry_request)
          and translation.target_language = 'en'
      )
  ),
  'the retried translation row has a pending job the worker can claim'
);

-- 7: three retries per message per hour, the fourth is refused.
select pg_temp.force_detection_failure();
select private.bff_enqueue_translation_impl(
  '99700000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000002',
  (select (response ->> 'conversation_id')::uuid from retry_request),
  (select (response ->> 'message_id')::bigint from retry_request),
  'en', 'retry-idem-2', repeat('0', 64));
select pg_temp.force_detection_failure();
select private.bff_enqueue_translation_impl(
  '99700000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000002',
  (select (response ->> 'conversation_id')::uuid from retry_request),
  (select (response ->> 'message_id')::bigint from retry_request),
  'en', 'retry-idem-3', repeat('0', 64));
select pg_temp.force_detection_failure();
select throws_ok(
  $q$ select private.bff_enqueue_translation_impl(
    '99700000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
    '99710000-0000-4000-8000-000000000002',
    (select (response ->> 'conversation_id')::uuid from retry_request),
    (select (response ->> 'message_id')::bigint from retry_request),
    'en', 'retry-idem-4', repeat('0', 64)) $q$,
  'P0001',
  'translation rate limit exceeded',
  'the fourth retry of one message within an hour is refused'
);

select * from finish();
rollback;
