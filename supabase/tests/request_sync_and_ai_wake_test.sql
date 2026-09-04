begin;
select plan(30);

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
  '99700000-0000-4000-8000-000000000003'
]::uuid[]) member_id;

-- 1: the V11 bootstrap wrapper is service-only like the rest of the chain.
select ok(
  has_function_privilege('service_role',
    'private.bff_bootstrap_messaging_state_v11_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)', 'execute')
  and not has_function_privilege('authenticated',
    'private.bff_bootstrap_messaging_state_v11_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)', 'execute')
  and not has_function_privilege('anon',
    'private.bff_bootstrap_messaging_state_v11_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)', 'execute')
  and not has_function_privilege('authenticated',
    'private.enqueue_contact_connection_invalidation_internal(uuid,uuid,uuid,text)', 'execute'),
  'the V11 bootstrap and the contact invalidation helper are not reachable by end-user roles'
);

-- ---------------------------------------------------------------------------
-- Message request: both participants are invalidated on creation.
-- ---------------------------------------------------------------------------
create temporary table bob_request on commit drop as
select public.bff_send_message_request(
  '99700000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000001',
  '99700000-0000-4000-8000-000000000002',
  'Hi Bob! Alice here.'
) as response;

-- 2-4: one realtime_control job per participant, shaped like the moderation
-- inbox invalidation the outbox worker already dispatches, plus the direct
-- conversation the request opened.
select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control'
     and job.payload ->> 'reason' = 'contact_request_created'
     and job.payload ->> 'conversation_id' = (select response ->> 'conversation_id' from bob_request)),
  2,
  'a message request queues an inbox invalidation for both participants'
);

select is(
  (select job.payload - 'event_id' - 'occurred_at'
   from private.outbox_jobs job
   where job.topic = 'realtime_control'
     and job.payload ->> 'reason' = 'contact_request_created'
     and job.payload ->> 'user_id' = '99700000-0000-4000-8000-000000000002'),
  jsonb_build_object(
    'schema_version', 1,
    'event', 'workspace.invalidated',
    'control_topic', 'org:11111111-1111-4111-8111-111111111111:user:99700000-0000-4000-8000-000000000002:inbox',
    'organization_id', '11111111-1111-4111-8111-111111111111',
    'user_id', '99700000-0000-4000-8000-000000000002',
    'entity_type', 'contact_connection',
    'entity_id', '99700000-0000-4000-8000-000000000001',
    'conversation_id', (select response ->> 'conversation_id' from bob_request),
    'reason', 'contact_request_created'
  ),
  'the recipient invalidation targets the recipient inbox topic and names the requester and conversation'
);

select ok(
  (select bool_and(
      job.status = 'pending'
      and job.dedupe_key like 'contact:11111111-1111-4111-8111-111111111111:%'
      and (job.payload ->> 'event_id')
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and (job.payload ->> 'occurred_at')::timestamptz is not null
      and job.payload ->> 'control_topic'
        = 'org:11111111-1111-4111-8111-111111111111:user:' || (job.payload ->> 'user_id') || ':inbox'
    )
   from private.outbox_jobs job
   where job.topic = 'realtime_control'
     and job.payload ->> 'entity_type' = 'contact_connection'),
  'contact invalidation jobs are pending, carry an event id and timestamp, and target only the addressed inbox'
);

-- 5: the immediate acceleration mirrors the message-change broadcast shape.
select is(
  (select count(*)::integer from realtime.messages message
   where message.event = 'workspace.invalidated'
     and message.payload ->> 'reason' = 'contact_request_created'
     and message.payload ->> 'entity_type' = 'contact_connection'
     and message.payload ->> 'conversation_id' = (select response ->> 'conversation_id' from bob_request)
     and message.topic in (
       'org:11111111-1111-4111-8111-111111111111:user:99700000-0000-4000-8000-000000000001:inbox',
       'org:11111111-1111-4111-8111-111111111111:user:99700000-0000-4000-8000-000000000002:inbox'
     )),
  2,
  'a message request also broadcasts the invalidation to both private inbox topics immediately'
);

-- 6-9: while pending, the bootstrap projection agrees with the posting
-- predicate evaluated for each actor: requester true, recipient false.
create temporary table pending_alice on commit drop as
select item.value as conversation
from public.bff_bootstrap_messaging_state(
  '99700000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000001'
) state,
  jsonb_array_elements(state -> 'conversations') item(value)
where item.value ->> 'conversation_id' = (select response ->> 'conversation_id' from bob_request);

create temporary table pending_bob on commit drop as
select item.value as conversation
from public.bff_bootstrap_messaging_state(
  '99700000-0000-4000-8000-000000000002',
  '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000002'
) state,
  jsonb_array_elements(state -> 'conversations') item(value)
where item.value ->> 'conversation_id' = (select response ->> 'conversation_id' from bob_request);

select is(
  (select conversation -> 'can_post' from pending_alice),
  'true'::jsonb,
  'the pending requester bootstrap projects can_post = true'
);

select is(
  (select conversation -> 'can_post' from pending_bob),
  'false'::jsonb,
  'the pending recipient bootstrap projects can_post = false'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99700000-0000-4000-8000-000000000001","session_id":"99710000-0000-4000-8000-000000000001","aal":"aal1"}',
  true);
select is(
  (select conversation -> 'can_post' from pending_alice),
  to_jsonb(private.can_post_to_conversation(
    '11111111-1111-4111-8111-111111111111',
    (select (response ->> 'conversation_id')::uuid from bob_request)
  )),
  'the requester projection equals can_post_to_conversation evaluated as the requester'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99700000-0000-4000-8000-000000000002","session_id":"99710000-0000-4000-8000-000000000002","aal":"aal1"}',
  true);
select is(
  (select conversation -> 'can_post' from pending_bob),
  to_jsonb(private.can_post_to_conversation(
    '11111111-1111-4111-8111-111111111111',
    (select (response ->> 'conversation_id')::uuid from bob_request)
  )),
  'the recipient projection equals can_post_to_conversation evaluated as the recipient'
);

-- 10: the bootstrap read restores the caller's session settings.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('app.bff_service_context', 'off', true);
select ok(
  (select public.bff_bootstrap_messaging_state(
    '99700000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '99710000-0000-4000-8000-000000000001'
  ) is not null)
  and current_setting('request.jwt.claims', true) = '{"role":"service_role"}'
  and current_setting('app.bff_service_context', true) = 'off',
  'the bootstrap leaves service-role claims and the service context exactly as it found them'
);

-- ---------------------------------------------------------------------------
-- Acceptance: the counterpart (requester) is invalidated.
-- ---------------------------------------------------------------------------
select is(
  (public.bff_respond_contact(
    '99700000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    '99710000-0000-4000-8000-000000000002',
    '99700000-0000-4000-8000-000000000001',
    'accepted', 'sync-bob-accept', repeat('1', 64)
  )) ->> 'status',
  'accepted',
  'the recipient accepts through the existing contact response'
);

-- 12-14: the accepted job for the requester's inbox has the worker shape.
select is(
  (select job.payload - 'event_id' - 'occurred_at'
   from private.outbox_jobs job
   where job.topic = 'realtime_control'
     and job.payload ->> 'reason' = 'contact_accepted'
     and job.payload ->> 'user_id' = '99700000-0000-4000-8000-000000000001'),
  jsonb_build_object(
    'schema_version', 1,
    'event', 'workspace.invalidated',
    'control_topic', 'org:11111111-1111-4111-8111-111111111111:user:99700000-0000-4000-8000-000000000001:inbox',
    'organization_id', '11111111-1111-4111-8111-111111111111',
    'user_id', '99700000-0000-4000-8000-000000000001',
    'entity_type', 'contact_connection',
    'entity_id', '99700000-0000-4000-8000-000000000002',
    'conversation_id', (select response ->> 'conversation_id' from bob_request),
    'reason', 'contact_accepted'
  ),
  'acceptance queues an inbox invalidation targeting the requester (counterpart) inbox topic'
);

select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'realtime_control'
     and job.payload ->> 'reason' = 'contact_accepted'
     and job.payload ->> 'user_id' in (
       '99700000-0000-4000-8000-000000000001',
       '99700000-0000-4000-8000-000000000002'
     )),
  2,
  'acceptance invalidates the responder as well as the requester'
);

select is(
  (select count(*)::integer from realtime.messages message
   where message.event = 'workspace.invalidated'
     and message.payload ->> 'reason' = 'contact_accepted'
     and message.topic in (
       'org:11111111-1111-4111-8111-111111111111:user:99700000-0000-4000-8000-000000000001:inbox',
       'org:11111111-1111-4111-8111-111111111111:user:99700000-0000-4000-8000-000000000002:inbox'
     )),
  2,
  'acceptance broadcasts the invalidation to both private inbox topics immediately'
);

-- 15-16: after acceptance both projections are writable.
select is(
  (select item.value -> 'can_post'
   from public.bff_bootstrap_messaging_state(
     '99700000-0000-4000-8000-000000000001',
     '11111111-1111-4111-8111-111111111111',
     '99710000-0000-4000-8000-000000000001'
   ) state,
     jsonb_array_elements(state -> 'conversations') item(value)
   where item.value ->> 'conversation_id' = (select response ->> 'conversation_id' from bob_request)),
  'true'::jsonb,
  'after acceptance the requester bootstrap projects can_post = true'
);

select is(
  (select item.value -> 'can_post'
   from public.bff_bootstrap_messaging_state(
     '99700000-0000-4000-8000-000000000002',
     '11111111-1111-4111-8111-111111111111',
     '99710000-0000-4000-8000-000000000002'
   ) state,
     jsonb_array_elements(state -> 'conversations') item(value)
   where item.value ->> 'conversation_id' = (select response ->> 'conversation_id' from bob_request)),
  'true'::jsonb,
  'after acceptance the recipient bootstrap projects can_post = true'
);

-- 17: an idempotent replay of the response does not fan out again.
select ok(
  (public.bff_respond_contact(
    '99700000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    '99710000-0000-4000-8000-000000000002',
    '99700000-0000-4000-8000-000000000001',
    'accepted', 'sync-bob-accept', repeat('1', 64)
  )) ->> 'status' = 'accepted'
  and (select count(*) from private.outbox_jobs job
       where job.topic = 'realtime_control'
         and job.payload ->> 'reason' = 'contact_accepted') = 2,
  'replaying the accepted response returns the stored result without queueing more invalidations'
);

-- ---------------------------------------------------------------------------
-- Decline: the requester learns the window closed.
-- ---------------------------------------------------------------------------
create temporary table carol_request on commit drop as
select public.bff_send_message_request(
  '99700000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99710000-0000-4000-8000-000000000001',
  '99700000-0000-4000-8000-000000000003',
  'Hi Carol!'
) as response;

select is(
  (public.bff_respond_contact(
    '99700000-0000-4000-8000-000000000003',
    '11111111-1111-4111-8111-111111111111',
    '99710000-0000-4000-8000-000000000003',
    '99700000-0000-4000-8000-000000000001',
    'declined', 'sync-carol-decline', repeat('2', 64)
  )) ->> 'status',
  'declined',
  'the recipient declines through the existing contact response'
);

select ok(
  exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'realtime_control'
      and job.payload ->> 'reason' = 'contact_declined'
      and job.payload ->> 'user_id' = '99700000-0000-4000-8000-000000000001'
      and job.payload ->> 'entity_id' = '99700000-0000-4000-8000-000000000003'
      and job.payload ->> 'control_topic'
        = 'org:11111111-1111-4111-8111-111111111111:user:99700000-0000-4000-8000-000000000001:inbox'
      and job.payload ->> 'conversation_id' = (select response ->> 'conversation_id' from carol_request)
  ),
  'decline queues an inbox invalidation targeting the requester inbox topic'
);

select is(
  (select item.value -> 'can_post'
   from public.bff_bootstrap_messaging_state(
     '99700000-0000-4000-8000-000000000001',
     '11111111-1111-4111-8111-111111111111',
     '99710000-0000-4000-8000-000000000001'
   ) state,
     jsonb_array_elements(state -> 'conversations') item(value)
   where item.value ->> 'conversation_id' = (select response ->> 'conversation_id' from carol_request)),
  'false'::jsonb,
  'after a decline the requester bootstrap projects can_post = false'
);

-- ---------------------------------------------------------------------------
-- AI worker wake-on-enqueue.
-- ---------------------------------------------------------------------------

-- 21-23: the trigger, its function, and the debounce index exist.
select ok(
  exists (
    select 1 from pg_trigger trigger_row
    where trigger_row.tgrelid = 'private.outbox_jobs'::regclass
      and trigger_row.tgname = 'outbox_jobs_90_wake_ai_worker'
      and trigger_row.tgfoid = 'private.wake_ai_worker_on_enqueue()'::regprocedure
      and not trigger_row.tgisinternal
      and trigger_row.tgenabled <> 'D'
      -- AFTER (bit 2 clear) INSERT (bit 3) ROW (bit 1) trigger.
      and (trigger_row.tgtype & 2) = 0
      and (trigger_row.tgtype & 4) = 4
      and (trigger_row.tgtype & 1) = 1
  ),
  'an enabled AFTER INSERT row trigger wakes the AI worker from private.outbox_jobs'
);

select ok(
  (select routine.prosecdef and routine.proconfig @> array['search_path=""']
   from pg_proc routine
   where routine.oid = 'private.wake_ai_worker_on_enqueue()'::regprocedure)
  and not has_function_privilege('authenticated',
    'private.wake_ai_worker_on_enqueue()', 'execute')
  and not has_function_privilege('authenticated',
    'private.ai_worker_wake_debounced(text,bigint)', 'execute'),
  'the wake trigger function is security definer with an empty search_path and is not callable by end-user roles'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'private'
      and tablename = 'outbox_jobs'
      and indexname = 'outbox_jobs_ai_wake_idx'
  ),
  'the per-topic debounce is backed by a partial index on AI topics'
);

-- 24: without Vault secrets the wake is a silent no-op.
create temporary table net_baseline on commit drop as
select count(*) as requests from net.http_request_queue;

create temporary table detection_job on commit drop as
select private.enqueue_outbox_job_internal(
  '11111111-1111-4111-8111-111111111111',
  'language_detection',
  'language-detection:sync-wake-1',
  jsonb_build_object(
    'organization_id', '11111111-1111-4111-8111-111111111111',
    'conversation_id', (select response ->> 'conversation_id' from bob_request),
    'message_id', (select response ->> 'message_id' from bob_request),
    'use_case', 'language_detection'
  )
) as job_id;

select is(
  (select count(*) from net.http_request_queue),
  (select requests from net_baseline),
  'enqueueing an AI job without Vault secrets posts nothing and does not error'
);

-- 25: since 20260904040000 nothing is debounced: every AI job wakes the worker
-- (the worker drains its queue in one pass and claims are atomic).
select ok(
  not private.ai_worker_wake_debounced('language_detection', (select job_id from detection_job))
  and not private.ai_worker_wake_debounced('translation', (select job_id from detection_job) + 1)
  and not private.ai_worker_wake_debounced('language_detection', (select job_id from detection_job) + 1),
  'no AI job is debounced: a second job of the same topic within two seconds still wakes the worker'
);

-- 26-28: with the named Vault secrets present, the first translation job
-- posts one worker wake with the documented request shape.
select vault.create_secret('https://sync-wake.example.test/', 'newone_project_url');
select vault.create_secret('sync-wake-server-apikey', 'newone_server_apikey');
select vault.create_secret('sync-wake-worker-token-at-least-32-chars', 'newone_worker_token');

create temporary table translation_job on commit drop as
select private.enqueue_outbox_job_internal(
  '11111111-1111-4111-8111-111111111111',
  'translation',
  'translation:sync-wake-1',
  jsonb_build_object(
    'organization_id', '11111111-1111-4111-8111-111111111111',
    'conversation_id', (select response ->> 'conversation_id' from bob_request),
    'message_id', (select response ->> 'message_id' from bob_request),
    'target_language', 'ko'
  )
) as job_id;

select is(
  (select count(*) from net.http_request_queue)
    - (select requests from net_baseline),
  1::bigint,
  'the first translation job posts exactly one AI worker wake'
);

select is(
  (select jsonb_build_object(
      'method', request.method,
      'url', request.url,
      'apikey', request.headers ->> 'apikey',
      'worker_token', request.headers ->> 'X-Newone-Worker-Token',
      'content_type_headers', (
        select count(*) from jsonb_object_keys(request.headers) header_name
        where lower(header_name) = 'content-type'
      ),
      'body', convert_from(request.body, 'UTF8')::jsonb,
      'timeout_milliseconds', request.timeout_milliseconds
    )
   from net.http_request_queue request
   order by request.id desc limit 1),
  jsonb_build_object(
    'method', 'POST',
    'url', 'https://sync-wake.example.test/functions/v1/newone-ai-worker',
    'apikey', 'sync-wake-server-apikey',
    'worker_token', 'sync-wake-worker-token-at-least-32-chars',
    'content_type_headers', 1,
    'body', jsonb_build_object('limit', 5),
    'timeout_milliseconds', 8000
  ),
  'the wake POSTs the worker function with Vault credentials, a single pg_net Content-Type, a bounded limit, and an 8 second timeout'
);

select private.enqueue_outbox_job_internal(
  '11111111-1111-4111-8111-111111111111',
  'translation',
  'translation:sync-wake-2',
  jsonb_build_object(
    'organization_id', '11111111-1111-4111-8111-111111111111',
    'conversation_id', (select response ->> 'conversation_id' from bob_request),
    'message_id', (select response ->> 'message_id' from bob_request),
    'target_language', 'es'
  )
);

select is(
  (select count(*) from net.http_request_queue)
    - (select requests from net_baseline),
  2::bigint,
  'a second translation job a moment later posts its own wake (no debounce)'
);

-- 29-30: jobs that are not claimable now never wake the worker.
insert into private.outbox_jobs (
  organization_id, topic, dedupe_key, payload, status, completed_at
) values (
  '11111111-1111-4111-8111-111111111111', 'summary', 'summary:sync-wake-done',
  '{}'::jsonb, 'completed', now()
);
insert into private.outbox_jobs (
  organization_id, topic, dedupe_key, payload, available_at
) values (
  '11111111-1111-4111-8111-111111111111', 'summary', 'summary:sync-wake-later',
  '{}'::jsonb, now() + interval '5 minutes'
);

select is(
  (select count(*) from net.http_request_queue)
    - (select requests from net_baseline),
  2::bigint,
  'completed or deferred AI jobs do not post a wake'
);

select is(
  (select count(*)::integer from private.outbox_jobs job
   where job.topic = 'push'
     and job.dedupe_key like 'message:11111111-1111-4111-8111-111111111111:%'),
  2,
  'non-AI outbox topics are untouched by the wake trigger'
);

select * from finish();
rollback;
