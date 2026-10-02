-- Translations outlast a provider outage (owner's father, Oct 1 2026: "since
-- last week the translation time has gotten extremely long").
--
-- On Oct 1 2026 every AI job failed in the worker's own pre-send check for 42
-- minutes (18:26-19:08 UTC); a Spanish message sent at 11:54 Pacific was
-- translated 19 minutes later and one sent at 11:26 never was: its language
-- detection used its tenth and last attempt during the outage, the message
-- was marked failed and its translation blocked for good. The worker no
-- longer lets the pinned endpoint's uptime grade block a request, labels
-- every refusal in that check, and retries within a minute for the first
-- quarter hour. Here, the database half:
--
-- 1. bff_fail_outbox_job_impl sets language detection and translation jobs
--    aside after 40 attempts instead of 10, matching the worker, so an outage
--    of up to about two hours and twenty minutes delays a translation instead
--    of failing it. Every other topic keeps 10.
-- 2. revive_stuck_language_detection_internal also recognises the labelled
--    failure codes the worker now records ('provider_unavailable:<check>').
-- 3. retry_outage_failed_detection_internal gives a message whose detection
--    failed only because of an outage another round, the way the reader's own
--    "Retry translation" does (bff_enqueue_translation_impl, 20260904090000),
--    without the reader's rate limits; it runs once below for the last three
--    days (the 11:26 message).
--
-- Both replaced functions are their hosted definitions (pg_get_functiondef,
-- md5 of the source checked against the local stack before writing this)
-- with only the lines above changed. create or replace keeps ownership and
-- grants.

CREATE OR REPLACE FUNCTION private.bff_fail_outbox_job_impl(p_worker_id uuid, p_job_id bigint, p_error_code text, p_retry_seconds integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_service_role();
  if char_length(coalesce(p_error_code, '')) not between 1 and 120
    or p_retry_seconds not between 1 and 86400 then
    raise exception 'invalid outbox failure parameters' using errcode = '22023';
  end if;
  update private.outbox_jobs job
  set status = case
        when job.attempts >= case when job.topic in ('language_detection', 'translation') then 40 else 10 end
          then 'dead_letter'
        else 'failed'
      end,
      available_at = now() + make_interval(secs => p_retry_seconds),
      claimed_by = null,
      claimed_until = null,
      last_error_code = p_error_code,
      updated_at = now()
  where job.id = p_job_id
    and job.status = 'processing'
    and job.claimed_by = p_worker_id;
  if not found then
    raise exception 'outbox lease not found' using errcode = '55000';
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION private.revive_stuck_language_detection_internal()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_message record;
  v_count integer := 0;
  v_sha text;
  v_targets jsonb;
begin
  -- A provider outage exhausts the job's attempts while the message stays
  -- 'pending'. Give such jobs another round once the outage has had time to
  -- clear; permanent failures carry other error codes and are left alone.
  update private.outbox_jobs job
  set status = 'pending', attempts = 0, available_at = now(), last_error_code = null,
      claimed_by = null, claimed_until = null, updated_at = now()
  where job.topic = 'language_detection'
    and job.status = 'failed'
    and (job.last_error_code = 'provider_unavailable' or job.last_error_code like 'provider\_unavailable:%')
    and job.updated_at < now() - interval '10 minutes'
    and job.updated_at > now() - interval '7 days';

  for v_message in
    select message.id, message.organization_id, message.conversation_id, message.body, message.language_code
    from public.messages message
    where message.kind = 'text'
      and message.body is not null
      and message.deleted_at is null
      and message.language_detection_state = 'pending'
      and message.created_at < now() - interval '2 minutes'
      and message.created_at > now() - interval '7 days'
      and private.ai_use_case_approved(message.organization_id, 'language_detection', null)
      and not exists (
        select 1 from private.outbox_jobs job
        where job.topic = 'language_detection'
          and job.organization_id = message.organization_id
          and (job.payload ->> 'message_id')::bigint = message.id
      )
    order by message.id
    limit 200
  loop
    v_sha := encode(extensions.digest(convert_to(v_message.body, 'UTF8'), 'sha256'), 'hex');
    select coalesce(jsonb_agg(translation.target_language order by translation.target_language), '[]'::jsonb)
    into v_targets
    from public.message_translations translation
    where translation.organization_id = v_message.organization_id
      and translation.message_id = v_message.id
      and translation.status = 'queued';
    perform private.enqueue_outbox_job_internal(
      v_message.organization_id,
      'language_detection',
      'language-detection:' || v_message.organization_id::text || ':' || v_message.id::text || ':' || v_sha,
      jsonb_build_object(
        'organization_id', v_message.organization_id,
        'conversation_id', v_message.conversation_id,
        'message_id', v_message.id,
        'source_sha256', v_sha,
        'client_language_hint', v_message.language_code,
        'required_target_languages', v_targets,
        'use_case', 'language_detection',
        'revived', true
      )
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

create or replace function private.retry_outage_failed_detection_internal(p_since interval)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_message record;
  v_hash bytea;
  v_targets text[];
  v_count integer := 0;
begin
  -- Called by an operator or a migration, like the revive cron: grants keep
  -- it to the service role and the database owner.
  if p_since is null or p_since <= interval '0' or p_since > interval '7 days' then
    raise exception 'invalid outage window' using errcode = '22023';
  end if;
  for v_message in
    select message.id, message.organization_id, message.conversation_id, message.body
    from public.messages message
    where message.language_detection_state = 'failed'
      and message.deleted_at is null
      and message.body is not null
      and message.created_at > now() - p_since
      and exists (
        select 1 from public.message_translations translation
        where translation.organization_id = message.organization_id
          and translation.message_id = message.id
          and translation.status in ('failed', 'blocked')
          and (translation.failure_code = 'provider_unavailable'
            or translation.failure_code like 'provider\_unavailable:%')
      )
    order by message.id
    limit 500
  loop
    v_hash := extensions.digest(convert_to(v_message.body, 'UTF8'), 'sha256');

    update public.message_translations translation
    set status = 'queued', failure_code = null
    where translation.organization_id = v_message.organization_id
      and translation.message_id = v_message.id
      and translation.status in ('failed', 'blocked');

    update private.outbox_jobs job
    set status = 'pending',
        attempts = 0,
        available_at = now(),
        claimed_by = null,
        claimed_until = null,
        completed_at = null,
        last_error_code = null
    where job.topic = 'translation'
      and job.status in ('completed', 'failed', 'dead_letter')
      and job.dedupe_key in (
        select 'translation:' || translation.id::text
        from public.message_translations translation
        where translation.organization_id = v_message.organization_id
          and translation.message_id = v_message.id
      );

    select coalesce(array_agg(distinct translation.target_language), array[]::text[])
      into v_targets
    from public.message_translations translation
    where translation.organization_id = v_message.organization_id
      and translation.message_id = v_message.id;

    perform set_config('app.bff_service_context', 'on', true);
    perform set_config('app.language_detection_context', 'on', true);
    update public.messages message
    set language_detection_state = 'pending',
        detected_language = null,
        language_detection_method = null,
        language_detection_confidence = null,
        language_detected_at = null
    where message.organization_id = v_message.organization_id
      and message.id = v_message.id;
    perform set_config('app.language_detection_context', 'off', true);
    perform set_config('app.bff_service_context', 'off', true);

    perform private.enqueue_outbox_job_internal(
      v_message.organization_id,
      'language_detection',
      'language-detection:' || v_message.organization_id::text || ':' || v_message.id::text || ':'
        || encode(v_hash, 'hex') || ':outage:' || floor(extract(epoch from now()))::bigint::text,
      jsonb_build_object(
        'organization_id', v_message.organization_id,
        'conversation_id', v_message.conversation_id,
        'message_id', v_message.id,
        'source_sha256', encode(v_hash, 'hex'),
        'client_language_hint', null,
        'required_target_languages', to_jsonb(v_targets),
        'use_case', 'language_detection'
      )
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

revoke all on function private.retry_outage_failed_detection_internal(interval) from public, anon, authenticated;
grant execute on function private.retry_outage_failed_detection_internal(interval) to service_role;

select private.retry_outage_failed_detection_internal(interval '3 days');
