-- Mixed-language messages can be translated for a reader who shares the
-- sender's language.
--
-- A message whose detection was undetermined completes as the sender's
-- language (20260904150000). Readers with another language get it
-- translated automatically; a reader with the same language could not even
-- ask, because the request route refused a source equal to the target. For
-- such messages (method suffixed `:sender-language`) a request into the
-- reader's own language is now accepted: the translation row carries the
-- source 'und' (mixed or unknown) and the translator renders every part in
-- the target language. Owner request, Sep 4 2026.

alter function private.bff_enqueue_translation_impl(
  uuid, uuid, uuid, uuid, bigint, text, text, text
) rename to bff_enqueue_translation_pre_mixed_impl;

create or replace function private.bff_enqueue_translation_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_target_language text,
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
  v_detection_state text;
  v_detected_language text;
  v_method text;
  v_source_body text;
  v_current_hash bytea;
  v_translation_id bigint;
  v_translation_status text;
  v_job_id bigint;
  v_job_status text;
begin
  select message.language_detection_state, message.detected_language,
      message.language_detection_method, message.body
    into v_detection_state, v_detected_language, v_method, v_source_body
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
    and message.deleted_at is null
    and message.body is not null;

  if found
    and v_detection_state = 'completed'
    and coalesce(v_method, '') like '%:sender-language'
    and lower(coalesce(v_detected_language, '')) = lower(p_target_language) then
    v_command := private.prepare_bff_command_internal(
      p_actor_user_id, p_organization_id, p_session_id,
      'translation.enqueue', false, 0, '/v2/messages/:id/translations',
      p_idempotency_key, p_request_sha256
    );
    if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
    if not private.is_conversation_member(p_organization_id, p_conversation_id) then
      raise exception 'conversation membership required' using errcode = '42501';
    end if;
    if not private.ai_use_case_approved(p_organization_id, 'translation', null) then
      raise exception 'tenant-approved translation policy required' using errcode = '42501';
    end if;
    if not private.consume_rate_limit(
      'translation-minute', p_organization_id::text || ':' || p_actor_user_id::text, 30, 60
    ) then
      raise exception 'translation rate limit exceeded' using errcode = 'P0001';
    end if;
    v_current_hash := extensions.digest(convert_to(v_source_body, 'UTF8'), 'sha256');
    insert into public.message_translations (
      organization_id, conversation_id, message_id, source_language,
      target_language, source_body_sha256
    ) values (
      p_organization_id, p_conversation_id, p_message_id, 'und',
      lower(p_target_language), v_current_hash
    )
    on conflict (organization_id, conversation_id, message_id, target_language) do nothing
    returning id, status into v_translation_id, v_translation_status;
    if v_translation_id is null then
      select translation.id, translation.status into v_translation_id, v_translation_status
      from public.message_translations translation
      where translation.organization_id = p_organization_id
        and translation.message_id = p_message_id
        and translation.target_language = lower(p_target_language);
      if v_translation_status in ('failed', 'blocked') then
        update public.message_translations
        set status = 'queued', source_language = 'und', translated_body = null, provider = null,
            model = null, confidence = null, reviewed_by_user_id = null, reviewed_at = null,
            failure_code = null, source_body_sha256 = v_current_hash
        where id = v_translation_id;
        v_translation_status := 'queued';
      end if;
    end if;
    select job.id, job.status into v_job_id, v_job_status
    from private.outbox_jobs job
    where job.topic = 'translation'
      and job.dedupe_key = 'translation:' || v_translation_id::text
      and job.organization_id = p_organization_id;
    if v_job_id is null then
      perform private.enqueue_outbox_job_internal(
        p_organization_id, 'translation', 'translation:' || v_translation_id::text,
        jsonb_build_object(
          'organization_id', p_organization_id,
          'conversation_id', p_conversation_id,
          'message_id', p_message_id,
          'target_language', lower(p_target_language),
          'requested_by_user_id', p_actor_user_id
        )
      );
    elsif v_job_status in ('completed', 'failed', 'dead_letter') and v_translation_status = 'queued' then
      update private.outbox_jobs job
      set payload = jsonb_build_object(
            'organization_id', p_organization_id,
            'conversation_id', p_conversation_id,
            'message_id', p_message_id,
            'target_language', lower(p_target_language),
            'requested_by_user_id', p_actor_user_id
          ),
          status = 'pending', attempts = 0, available_at = now(), claimed_by = null,
          claimed_until = null, completed_at = null, last_error_code = null, updated_at = now()
      where job.id = v_job_id;
    end if;
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, '/v2/messages/:id/translations',
      p_idempotency_key, p_request_sha256,
      jsonb_build_object('translation_id', v_translation_id, 'status', coalesce(v_translation_status, 'queued'), 'mixed', true),
      202
    );
  end if;

  return private.bff_enqueue_translation_pre_mixed_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_target_language, p_idempotency_key, p_request_sha256
  );
end;
$$;

revoke all on function private.bff_enqueue_translation_impl(uuid, uuid, uuid, uuid, bigint, text, text, text) from public;
grant execute on function private.bff_enqueue_translation_impl(uuid, uuid, uuid, uuid, bigint, text, text, text) to service_role;
revoke all on function private.bff_enqueue_translation_pre_mixed_impl(uuid, uuid, uuid, uuid, bigint, text, text, text) from public;
grant execute on function private.bff_enqueue_translation_pre_mixed_impl(uuid, uuid, uuid, uuid, bigint, text, text, text) to service_role;
