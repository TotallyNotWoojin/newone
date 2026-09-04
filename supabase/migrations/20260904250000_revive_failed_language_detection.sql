-- Language detection jobs that failed with provider_unavailable are retried by the
-- revive cron once the outage has had time to clear (message 445 stayed pending).

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
    and job.last_error_code = 'provider_unavailable'
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
$function$
;
