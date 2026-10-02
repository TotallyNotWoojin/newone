begin;
select plan(11);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: the personal realm with four accounts. Alice, Bob and Carol share
-- a group chat; Carol joined late, so her history starts after every message
-- here. Xavier is in the realm but not in the chat. Summaries are approved
-- for the realm so Alice can ask for one.
insert into auth.users (id, email, email_confirmed_at) values
  ('e1000000-0000-4000-8000-000000000001', 'projects-alice@example.test', now()),
  ('e1000000-0000-4000-8000-000000000002', 'projects-bob@example.test', now()),
  ('e1000000-0000-4000-8000-000000000003', 'projects-carol@example.test', now()),
  ('e1000000-0000-4000-8000-000000000004', 'projects-xavier@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set display_name = case user_id
    when 'e1000000-0000-4000-8000-000000000001' then 'Alice'
    when 'e1000000-0000-4000-8000-000000000002' then 'Bob'
    when 'e1000000-0000-4000-8000-000000000003' then 'Carol'
    else 'Xavier'
  end
where user_id::text like 'e1000000-%';
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('e1100000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('e1100000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('e1100000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', now(), now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001', 'web', decode(repeat('e1', 32), 'hex'), 'desktop'),
  ('e1100000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000002', 'ios', decode(repeat('e2', 32), 'hex'), 'iphone'),
  ('e1100000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000003', 'android', decode(repeat('e3', 32), 'hex'), 'android'),
  ('e1100000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', 'e1200000-0000-4000-8000-000000000004', 'web', decode(repeat('e4', 32), 'hex'), 'desktop');

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Gist', 'en',
  true, 'request_first', true, 'e1000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (organization_id, user_id, role, status, directory_visibility)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array[
  'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000004'
]::uuid[]) member_id;
insert into public.organization_ai_policies (
  organization_id, enabled, approved_use_cases, provider_allowlist, route_policy,
  approved_by_user_id, approved_at
) values (
  '11111111-1111-4111-8111-111111111111', true, array['summary', 'translation'],
  array['openrouter'], 'approved_zero_retention', 'e1000000-0000-4000-8000-000000000001', now()
);

insert into public.conversations (id, organization_id, kind, name, visibility, created_by_user_id)
values (
  'e1300000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'group', 'Projects room', 'invite_only', 'e1000000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id, history_visible_from
) values
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'owner', 'e1000000-0000-4000-8000-000000000001', null),
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'member', 'e1000000-0000-4000-8000-000000000001', null),
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'member', 'e1000000-0000-4000-8000-000000000001', now() + interval '1 second');

create temporary table ids (name text primary key, value text) on commit drop;
grant all on ids to public;

create function pg_temp.command(
  p_actor text, p_action text, p_project uuid, p_item uuid, p_name text, p_target jsonb, p_key text
) returns jsonb language sql as $$
  select public.bff_conversation_project_command(
    ('e1000000-0000-4000-8000-00000000000' || p_actor)::uuid,
    '11111111-1111-4111-8111-111111111111',
    ('e1100000-0000-4000-8000-00000000000' || p_actor)::uuid,
    'e1300000-0000-4000-8000-000000000001',
    p_action, p_project, p_item, p_name, p_target, p_key, repeat('a', 64)
  )
$$;
create function pg_temp.projects(p_actor text) returns jsonb language sql as $$
  select public.bff_read_conversation_projects(
    ('e1000000-0000-4000-8000-00000000000' || p_actor)::uuid,
    '11111111-1111-4111-8111-111111111111',
    ('e1100000-0000-4000-8000-00000000000' || p_actor)::uuid,
    'e1300000-0000-4000-8000-000000000001'
  )
$$;
create function pg_temp.id(p_name text) returns uuid language sql as $$
  select value::uuid from ids where name = p_name
$$;
create function pg_temp.act_as(p_actor text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"role":"service_role","sub":"e1000000-0000-4000-8000-00000000000' || p_actor
      || '","session_id":"e1100000-0000-4000-8000-00000000000' || p_actor || '","aal":"aal1"}',
    true
  );
$$;
create function pg_temp.send(p_actor text, p_nonce text, p_body text) returns bigint language plpgsql as $$
declare v_id bigint;
begin
  perform pg_temp.act_as(p_actor);
  perform set_config('app.bff_service_context', 'on', true);
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
  ) values (
    '11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001',
    ('e1000000-0000-4000-8000-00000000000' || p_actor)::uuid,
    ('e1400000-0000-4000-8000-0000000000' || p_nonce)::uuid,
    case when p_body is null then 'attachment' else 'text' end, p_body, 'en'
  ) returning id into v_id;
  perform set_config('app.bff_service_context', 'off', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- A translation outlasts a provider outage (20261001020000).
-- ---------------------------------------------------------------------------
insert into ids values ('outage_message', pg_temp.send('2', '90', 'La reunión de calidad se puede tener cuando lo indique.'));
select set_config('app.bff_service_context', 'on', true);
insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language, target_language,
  source_body_sha256, status
) values (
  '11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001',
  (select value::bigint from ids where name = 'outage_message'), 'und', 'ko',
  extensions.digest(convert_to('La reunión de calidad se puede tener cuando lo indique.', 'UTF8'), 'sha256'),
  'queued'
)
on conflict (organization_id, conversation_id, message_id, target_language) do nothing;
select set_config('app.bff_service_context', 'off', true);

-- The way the tenth failed attempt during an outage left a message
-- (bff_fail_language_detection_job with the worker's code).
create function pg_temp.fail_detection(p_code text) returns void language plpgsql as $$
begin
  perform set_config('app.bff_service_context', 'on', true);
  perform set_config('app.language_detection_context', 'on', true);
  update public.messages
  set detected_language = null, language_detection_state = 'failed',
      language_detection_method = 'newone-detector-v1', language_detection_confidence = null,
      language_detected_at = now()
  where id = (select value::bigint from ids where name = 'outage_message');
  update public.message_translations
  set status = 'blocked', failure_code = p_code
  where message_id = (select value::bigint from ids where name = 'outage_message');
  perform set_config('app.language_detection_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);
end $$;

-- 1-5: a message failed by an outage gets another round, run the way the
-- migration runs it: as the database owner with no request claims at all.
select pg_temp.fail_detection('provider_unavailable');
select set_config('request.jwt.claims', '', true);
select is(
  private.retry_outage_failed_detection_internal(interval '3 days'),
  1,
  'one message failed only by the outage is retried'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select language_detection_state from public.messages
   where id = (select value::bigint from ids where name = 'outage_message')),
  'pending',
  'its language detection is pending again'
);
select is(
  (select array_agg(distinct status) from public.message_translations
   where message_id = (select value::bigint from ids where name = 'outage_message')),
  array['queued'],
  'its blocked translations are queued again'
);
select ok(
  exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'language_detection' and job.status = 'pending'
      and job.dedupe_key like 'language-detection:%:'
        || (select value from ids where name = 'outage_message') || ':%:outage:%'
  ),
  'a fresh detection job is waiting for the worker'
);
select pg_temp.fail_detection('language_ambiguous');
select is(
  private.retry_outage_failed_detection_internal(interval '3 days'),
  0,
  'a message that failed for any other reason is left alone'
);

-- 6-9: the queue sets language detection and translation aside after 40
-- attempts, every other topic after 10.
create function pg_temp.fail_job(p_topic text, p_attempts integer) returns text language plpgsql as $$
declare v_id bigint;
begin
  insert into private.outbox_jobs (
    organization_id, topic, dedupe_key, payload, status, attempts, claimed_by, claimed_until
  ) values (
    '11111111-1111-4111-8111-111111111111', p_topic, 'outage-test:' || p_topic || ':' || p_attempts,
    '{}'::jsonb, 'processing', p_attempts, 'e1600000-0000-4000-8000-000000000001', now() + interval '1 minute'
  ) returning id into v_id;
  perform public.bff_fail_outbox_job(
    'e1600000-0000-4000-8000-000000000001', v_id, 'provider_unavailable:provider_preflight_zdr_route', 60
  );
  return (select status from private.outbox_jobs where id = v_id);
end $$;
select is(pg_temp.fail_job('translation', 10), 'failed', 'a translation keeps retrying past its tenth attempt');
select is(pg_temp.fail_job('language_detection', 39), 'failed', 'a detection keeps retrying through its 39th attempt');
select is(pg_temp.fail_job('language_detection', 40), 'dead_letter', 'a detection is set aside at its 40th attempt');
select is(pg_temp.fail_job('push', 10), 'dead_letter', 'a push is still set aside at its tenth attempt');

-- 10-11: the revive cron recognises the labelled outage codes, and still
-- leaves a job alone that failed for another reason.
insert into private.outbox_jobs (
  organization_id, topic, dedupe_key, payload, status, attempts, last_error_code, updated_at
) values
  ('11111111-1111-4111-8111-111111111111', 'language_detection', 'outage-test:revive',
   '{}'::jsonb, 'failed', 7, 'provider_unavailable:provider_preflight_zdr_route', now() - interval '11 minutes'),
  ('11111111-1111-4111-8111-111111111111', 'language_detection', 'outage-test:other',
   '{}'::jsonb, 'failed', 7, 'ai_output_needs_review', now() - interval '11 minutes');
select private.revive_stuck_language_detection_internal();
select is(
  (select status || ':' || attempts from private.outbox_jobs where dedupe_key = 'outage-test:revive'),
  'pending:0',
  'a detection job idle after a labelled outage failure is given another round'
);
select is(
  (select status || ':' || attempts from private.outbox_jobs where dedupe_key = 'outage-test:other'),
  'failed:7',
  'a job that failed for another reason is not'
);

select * from finish();
rollback;
