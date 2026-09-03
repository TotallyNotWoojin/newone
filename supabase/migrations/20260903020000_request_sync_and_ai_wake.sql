-- Request sync and AI wake.
--
-- Three backend defects found by real-device testing of the consumer
-- messenger:
--
-- 1. Contact-request lifecycle changes reached nobody. A message request
--    created the pending connection, the direct conversation, and the first
--    message (which the message trigger broadcasts), but acceptance and
--    decline through bff_respond_contact updated the connection row silently.
--    The requester's app therefore stayed on its stale "pending / cannot
--    post" projection until a restart. Both participants now receive the
--    same private inbox invalidation the send-message path uses: an
--    immediate realtime.send acceleration plus a durable realtime_control
--    outbox job, on request creation, acceptance, and decline.
--
-- 2. The bootstrap projection computed a direct conversation's can_post
--    under service-role claims, so the personal-realm pending arm of
--    private.direct_pair_policy_permitted (which keys on auth.uid()) always
--    evaluated false for the requester. The requester could post up to three
--    messages through the command path while the projection told the app it
--    could not. A V11 wrapper now re-projects can_post for direct
--    conversations as private.can_post_to_conversation evaluated for the
--    actor, which is the single posting authority the command path enforces.
--
-- 3. Translation latency. The AI worker ran only on the 10-second cron and
--    detection -> translation needs two passes. An AFTER INSERT trigger on
--    private.outbox_jobs now wakes the worker through pg_net for AI topics,
--    with per-topic debouncing and a strict no-op when pg_net or the Vault
--    secrets are absent (local development, pgTAP).

begin;

-- ---------------------------------------------------------------------------
-- 1. Contact connection invalidation fan-out
-- ---------------------------------------------------------------------------

-- Both participants of a contact-connection change receive one private
-- inbox invalidation. The immediate realtime.send mirrors the message-change
-- trigger; the realtime_control outbox job mirrors the moderation fan-out so
-- a disconnected app still reconciles through the worker.
create or replace function private.enqueue_contact_connection_invalidation_internal(
  p_organization_id uuid,
  p_first_user_id uuid,
  p_second_user_id uuid,
  p_reason text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_low uuid := least(p_first_user_id, p_second_user_id);
  v_high uuid := greatest(p_first_user_id, p_second_user_id);
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
  v_conversation_id uuid;
  v_recipient record;
  v_count integer := 0;
begin
  if p_reason not in (
    'contact_request_created', 'contact_accepted', 'contact_declined'
  ) then
    raise exception 'invalid contact invalidation reason' using errcode = '22023';
  end if;
  if p_first_user_id is null or p_second_user_id is null
    or p_first_user_id = p_second_user_id then
    raise exception 'contact invalidation requires two distinct members'
      using errcode = '22023';
  end if;

  select pair.conversation_id into v_conversation_id
  from public.direct_conversation_pairs pair
  where pair.organization_id = p_organization_id
    and pair.member_low_user_id = v_low
    and pair.member_high_user_id = v_high;

  for v_recipient in
    select participant.user_id,
      case when participant.user_id = v_low then v_high else v_low end
        as other_user_id
    from unnest(array[v_low, v_high]) as participant(user_id)
    join public.organization_memberships membership
      on membership.organization_id = p_organization_id
     and membership.user_id = participant.user_id
     and membership.status = 'active'
    where private.organization_membership_access_current(
      p_organization_id, participant.user_id, now()
    )
    order by participant.user_id
  loop
    perform realtime.send(
      jsonb_build_object(
        'schema_version', 1, 'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'organization_id', p_organization_id,
        'occurred_at', v_occurred_at,
        'conversation_id', v_conversation_id,
        'entity_type', 'contact_connection',
        'entity_id', v_recipient.other_user_id::text,
        'version_id', null, 'reason', p_reason
      ),
      'workspace.invalidated',
      'org:' || p_organization_id::text || ':user:'
        || v_recipient.user_id::text || ':inbox',
      true
    );
    perform private.enqueue_outbox_job_internal(
      p_organization_id,
      'realtime_control',
      'contact:' || p_organization_id::text || ':' || v_low::text || ':'
        || v_high::text || ':' || v_recipient.user_id::text || ':' || p_reason
        || ':' || v_event_id::text,
      jsonb_build_object(
        'schema_version', 1,
        'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'control_topic', 'org:' || p_organization_id::text || ':user:'
          || v_recipient.user_id::text || ':inbox',
        'organization_id', p_organization_id,
        'occurred_at', v_occurred_at,
        'user_id', v_recipient.user_id,
        'entity_type', 'contact_connection',
        'entity_id', v_recipient.other_user_id,
        'reason', p_reason
      ) || case
        when v_conversation_id is null then '{}'::jsonb
        else jsonb_build_object('conversation_id', v_conversation_id)
      end
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.enqueue_contact_connection_invalidation_internal(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;

-- Full recreate of the contact response command. The only change is the
-- invalidation fan-out after the pending row transitions; replay, validation,
-- and the response shape are unchanged.
create or replace function private.bff_respond_contact_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_other_user_id uuid,
  p_status text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_low uuid := least(p_actor_user_id, p_other_user_id);
  v_high uuid := greatest(p_actor_user_id, p_other_user_id);
  v_responded_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'contact.respond', false, 0, '/v2/contacts/:id/respond',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_status not in ('accepted', 'declined') then
    raise exception 'invalid contact response' using errcode = '22023';
  end if;
  update public.contact_connections connection
  set status = p_status
  where connection.organization_id = p_organization_id
    and connection.member_low_user_id = v_low
    and connection.member_high_user_id = v_high
    and connection.status = 'pending'
  returning connection.responded_at into v_responded_at;
  if not found then raise exception 'pending contact request not found' using errcode = 'P0002'; end if;

  -- Both apps must re-project: the requester's posting window opens or
  -- closes and the responder's conversation becomes writable or stays shut.
  perform private.enqueue_contact_connection_invalidation_internal(
    p_organization_id, p_actor_user_id, p_other_user_id,
    case p_status when 'accepted' then 'contact_accepted' else 'contact_declined' end
  );

  v_response := jsonb_build_object(
    'member_low_user_id', v_low,
    'member_high_user_id', v_high,
    'status', p_status,
    'responded_at', v_responded_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/contacts/:id/respond',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

-- Full recreate of the atomic message request. The only change is the
-- invalidation fan-out after the first message is delivered, so the
-- recipient's app surfaces the request and the requester's app re-projects
-- the new pending conversation without waiting for a restart.
create or replace function private.bff_send_message_request_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
  p_body text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_low uuid;
  v_high uuid;
  v_conversation_id uuid;
  v_message_id bigint;
  v_target_language text;
  v_translation_id bigint;
  v_translation_targets text[] := array[]::text[];
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'contact.message_request', false, 0
  );

  if p_organization_id <> private.personal_realm_organization_id() then
    raise exception 'message requests are a personal-realm capability'
      using errcode = '22023';
  end if;
  if p_target_user_id is null or p_target_user_id = p_actor_user_id then
    raise exception 'message request target must be another member'
      using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 20000 then
    raise exception 'message request body is required' using errcode = '22023';
  end if;

  -- Same daily budget as bff_request_contact_impl: a message request is a
  -- contact request with a first message attached.
  if not private.consume_rate_limit(
    'contact-request-day',
    p_organization_id::text || ':' || p_actor_user_id::text,
    20, 86400
  ) then
    raise exception 'contact request rate limit exceeded' using errcode = 'P0001';
  end if;

  -- The relationship triggers, the DM policy predicate, and send_message all
  -- authorize with the end-user identity, exactly as in every other BFF
  -- command path.
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal',
    'contact.message_request'
  );

  -- Canonical-pair insert with the 7-day cooldown upsert, mirroring
  -- private.bff_request_contact_impl.
  v_low := least(p_actor_user_id, p_target_user_id);
  v_high := greatest(p_actor_user_id, p_target_user_id);
  insert into public.contact_connections (
    organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
  ) values (
    p_organization_id, v_low, v_high, p_actor_user_id
  )
  on conflict (organization_id, member_low_user_id, member_high_user_id) do update
    set status = 'pending', responded_at = null, updated_at = now()
    where public.contact_connections.requested_by_user_id = p_actor_user_id
      and public.contact_connections.status in ('declined', 'cancelled')
      and public.contact_connections.responded_at <= now() - interval '7 days';
  if not found then
    raise exception 'contact request is pending, accepted, or in cooldown'
      using errcode = 'P0001';
  end if;

  -- Idempotent per pair; permitted under the new pending arm of the policy
  -- predicate because the actor is now the pending requester.
  v_conversation_id := private.create_direct_conversation(
    p_organization_id, p_target_user_id
  );

  -- The first message travels the same trusted path bff_send_message_impl
  -- uses, including the translation fan-out and push wakeup.
  v_message_id := private.send_message(
    p_organization_id, v_conversation_id, gen_random_uuid(), 'text',
    p_body, null, null, null, '{}'::jsonb
  );

  for v_target_language in
    select distinct lower(coalesce(preference.message_language, profile.preferred_language))
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    join public.profiles profile on profile.user_id = member.user_id
    left join public.organization_user_preferences preference
      on preference.organization_id = member.organization_id
     and preference.user_id = member.user_id
    left join public.conversation_preferences conversation_preference
      on conversation_preference.organization_id = member.organization_id
     and conversation_preference.conversation_id = member.conversation_id
     and conversation_preference.user_id = member.user_id
    where member.organization_id = p_organization_id
      and member.conversation_id = v_conversation_id
      and member.status = 'active'
      and member.user_id <> p_actor_user_id
      and coalesce(conversation_preference.translation_mode, 'automatic') = 'automatic'
      and coalesce(preference.message_language, profile.preferred_language) is not null
      and lower(coalesce(preference.message_language, profile.preferred_language)) <> 'und'
      and coalesce(preference.message_language, profile.preferred_language)
        ~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
    order by 1
  loop
    v_translation_id := null;
    insert into public.message_translations (
      organization_id, conversation_id, message_id, source_language,
      target_language, source_body_sha256
    ) values (
      p_organization_id, v_conversation_id, v_message_id,
      'und', v_target_language,
      extensions.digest(convert_to(p_body, 'UTF8'), 'sha256')
    )
    on conflict (organization_id, conversation_id, message_id, target_language) do nothing
    returning id into v_translation_id;
    if v_translation_id is null then
      select translation.id into v_translation_id
      from public.message_translations translation
      where translation.organization_id = p_organization_id
        and translation.conversation_id = v_conversation_id
        and translation.message_id = v_message_id
        and translation.target_language = v_target_language;
    end if;
    v_translation_targets := array_append(v_translation_targets, v_target_language);
  end loop;
  if private.ai_use_case_approved(p_organization_id, 'language_detection', null) then
    perform private.enqueue_outbox_job_internal(
      p_organization_id,
      'language_detection',
      'language-detection:' || p_organization_id::text || ':' || v_message_id::text || ':'
        || encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex'),
      jsonb_build_object(
        'organization_id', p_organization_id,
        'conversation_id', v_conversation_id,
        'message_id', v_message_id,
        'source_sha256', encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex'),
        'client_language_hint', null,
        'required_target_languages', to_jsonb(v_translation_targets),
        'use_case', 'language_detection'
      )
    );
  else
    perform set_config('app.language_detection_context', 'on', true);
    update public.messages message
    set language_detection_state = 'failed', detected_language = null,
        language_detection_method = 'tenant-policy-disabled',
        language_detection_confidence = null, language_detected_at = now()
    where message.organization_id = p_organization_id
      and message.conversation_id = v_conversation_id and message.id = v_message_id;
    update public.message_translations translation
    set status = 'blocked', failure_code = 'tenant_ai_policy_disabled'
    where translation.organization_id = p_organization_id
      and translation.conversation_id = v_conversation_id
      and translation.message_id = v_message_id and translation.status = 'queued';
    perform set_config('app.language_detection_context', 'off', true);
  end if;

  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'push',
    'message:' || p_organization_id::text || ':' || v_conversation_id::text || ':' || v_message_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', v_conversation_id,
      'message_id', v_message_id
    )
  );

  -- The message trigger already broadcast the first message; this carries
  -- the connection-state change itself so both apps re-project the pending
  -- request (requester: posting window, recipient: request surfaced).
  perform private.enqueue_contact_connection_invalidation_internal(
    p_organization_id, p_actor_user_id, p_target_user_id,
    'contact_request_created'
  );

  perform private.clear_bff_actor_context_internal();
  return jsonb_build_object(
    'connection_status', 'pending',
    'conversation_id', v_conversation_id,
    'message_id', v_message_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Bootstrap: direct-conversation can_post is the actor's posting predicate
-- ---------------------------------------------------------------------------

-- V11 composes on V10 for the personal realm and re-projects can_post for
-- direct conversations only; workspace organizations keep delegating to the
-- untouched V9 chain exactly as before. The inherited V7 expression
-- evaluated private.direct_pair_policy_permitted under service-role claims,
-- where auth.uid() is null, so the personal-realm pending arm never matched
-- the requester. Evaluating private.can_post_to_conversation with the actor
-- context installed makes the projection agree with what the send-message
-- command path enforces. The prior session settings are restored afterwards
-- so a read never leaks an actor context into its caller.
create or replace function private.bff_bootstrap_messaging_state_v11_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_conversations jsonb;
  v_authorization jsonb;
  v_prior_claims text;
  v_prior_service_context text;
  v_prior_audit_request_id text;
  v_prior_audit_operation text;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v10_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if p_organization_id <> private.personal_realm_organization_id() then
    return v_result;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_result -> 'conversations', '[]'::jsonb)) item(value)
    where item.value ->> 'kind' = 'direct'
      and not coalesce((item.value ->> 'management_only')::boolean, false)
  ) then
    return v_result;
  end if;

  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'messaging.bootstrap.read', false, 0
  );
  v_prior_claims := current_setting('request.jwt.claims', true);
  v_prior_service_context := current_setting('app.bff_service_context', true);
  v_prior_audit_request_id := current_setting('app.audit_request_id', true);
  v_prior_audit_operation := current_setting('app.audit_operation', true);
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal',
    'messaging.bootstrap.read'
  );

  select coalesce(jsonb_agg(
    case
      when item.value ->> 'kind' = 'direct'
        and not coalesce((item.value ->> 'management_only')::boolean, false)
      then item.value || jsonb_build_object(
        'can_post', private.can_post_to_conversation(
          p_organization_id, (item.value ->> 'conversation_id')::uuid
        )
      )
      else item.value
    end
    order by item.ordinality
  ), '[]'::jsonb)
  into v_conversations
  from jsonb_array_elements(coalesce(v_result -> 'conversations', '[]'::jsonb))
    with ordinality as item(value, ordinality);

  perform set_config(
    'request.jwt.claims', coalesce(v_prior_claims, '{"role":"service_role"}'), true
  );
  perform set_config(
    'app.bff_service_context', coalesce(v_prior_service_context, 'off'), true
  );
  perform set_config('app.audit_request_id', coalesce(v_prior_audit_request_id, ''), true);
  perform set_config('app.audit_operation', coalesce(v_prior_audit_operation, ''), true);

  return jsonb_set(v_result, '{conversations}', v_conversations, true);
end;
$$;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid default null,
  p_before_message_id bigint default null,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select case
    when p_organization_id = private.personal_realm_organization_id()
    then private.bff_bootstrap_messaging_state_v11_impl(
      p_actor_user_id, p_organization_id, p_session_id,
      p_selected_conversation_id, p_before_message_id,
      p_conversation_limit, p_timeline_limit
    )
    else private.bff_bootstrap_messaging_state_v9_impl(
      p_actor_user_id, p_organization_id, p_session_id,
      p_selected_conversation_id, p_before_message_id,
      p_conversation_limit, p_timeline_limit
    )
  end
$$;

revoke all on function private.bff_bootstrap_messaging_state_v11_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function private.bff_bootstrap_messaging_state_v11_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

revoke all on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

comment on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) is
  'Service-only bootstrap. In the personal realm, direct conversations project can_post as the actor''s posting predicate (private.can_post_to_conversation) on top of the connection-scoped directory; workspace organizations keep the established directory chain.';

-- ---------------------------------------------------------------------------
-- 3. AI worker wake-on-enqueue
-- ---------------------------------------------------------------------------

-- The AI worker claims exactly these topics (AI_WORKLOADS in
-- newone-ai-worker/handler.ts).
create index if not exists outbox_jobs_ai_wake_idx
  on private.outbox_jobs (topic, created_at desc)
  where topic in ('language_detection', 'translation', 'summary');

-- Per-topic debounce: another job of the same AI topic inserted within the
-- last two seconds means a wake is already in flight for that pass. Keeping
-- the window per topic lets a detection completion wake the translation
-- pass immediately instead of waiting for the cron.
create or replace function private.ai_worker_wake_debounced(
  p_topic text,
  p_job_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.outbox_jobs job
    where job.topic = p_topic
      and job.topic in ('language_detection', 'translation', 'summary')
      and job.id <> p_job_id
      and job.created_at >= now() - interval '2 seconds'
  )
$$;

-- Wake the AI worker through pg_net. Credentials are read by name from
-- Vault and never appear in a migration. Every failure path is a silent
-- no-op (warning at most): a wake that cannot be posted must never fail the
-- message send that enqueued the job, and the cron remains the fallback.
create or replace function private.wake_ai_worker_on_enqueue()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_project_url text;
  v_server_apikey text;
  v_worker_token text;
begin
  if new.topic not in ('language_detection', 'translation', 'summary')
    or new.status <> 'pending'
    or new.available_at > now() then
    return null;
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
    or to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;
  if private.ai_worker_wake_debounced(new.topic, new.id) then
    return null;
  end if;

  begin
    execute $sql$
      select
        max(secret.decrypted_secret) filter (where secret.name = 'newone_project_url'),
        max(secret.decrypted_secret) filter (where secret.name = 'newone_server_apikey'),
        max(secret.decrypted_secret) filter (where secret.name = 'newone_worker_token')
      from vault.decrypted_secrets secret
      where secret.name in (
        'newone_project_url', 'newone_server_apikey', 'newone_worker_token'
      )
    $sql$ into v_project_url, v_server_apikey, v_worker_token;
    if nullif(btrim(coalesce(v_project_url, '')), '') is null
      or nullif(btrim(coalesce(v_server_apikey, '')), '') is null
      or nullif(btrim(coalesce(v_worker_token, '')), '') is null then
      return null;
    end if;
    -- pg_net adds its own Content-Type: application/json; supplying one here
    -- duplicates the header and the gateway rejects the request.
    execute 'select net.http_post($1, $2, $3, $4, $5)'
    using rtrim(btrim(v_project_url), '/') || '/functions/v1/newone-ai-worker',
      jsonb_build_object('limit', 5),
      '{}'::jsonb,
      jsonb_build_object(
        'apikey', btrim(v_server_apikey),
        'X-Newone-Worker-Token', btrim(v_worker_token)
      ),
      8000;
  exception when others then
    raise warning 'newone ai worker wake skipped (%)', sqlstate;
  end;
  return null;
end;
$$;

revoke all on function private.ai_worker_wake_debounced(text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function private.wake_ai_worker_on_enqueue()
  from public, anon, authenticated, service_role;

drop trigger if exists outbox_jobs_90_wake_ai_worker on private.outbox_jobs;
create trigger outbox_jobs_90_wake_ai_worker
  after insert on private.outbox_jobs
  for each row execute function private.wake_ai_worker_on_enqueue();

comment on function private.wake_ai_worker_on_enqueue() is
  'Wakes newone-ai-worker through pg_net when an AI outbox job is enqueued; reads newone_project_url, newone_server_apikey, and newone_worker_token from Vault by name and is a no-op when pg_net, Vault, or those secrets are absent.';

commit;
