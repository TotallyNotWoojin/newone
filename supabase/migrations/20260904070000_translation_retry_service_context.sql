-- Translation retry after a failed detection: set the service context too.
--
-- 20260904060000 reset the message's detection fields under the detection
-- context alone; private.validate_message_update() only allows that when the
-- service context is also on (the worker RPCs set both). Same function, both
-- contexts set around the reset.
create or replace function private.bff_enqueue_translation_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_target_language text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_detection_state text;
  v_source_body text;
  v_current_hash bytea;
  v_translation_id bigint;
  v_targets text[];
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id)
    and (
      not private.dynamic_group_user_currently_eligible(
        p_organization_id, p_conversation_id, p_actor_user_id, now()
      ) or not private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now()
      )
    ) then
    raise exception 'translation source is not available' using errcode = '42501';
  end if;

  select message.language_detection_state, message.body
    into v_detection_state, v_source_body
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
    and message.deleted_at is null
    and message.body is not null;

  if found and v_detection_state = 'failed' then
    if not private.is_conversation_member(p_organization_id, p_conversation_id) then
      raise exception 'conversation membership required' using errcode = '42501';
    end if;
    if not private.consume_rate_limit(
      'translation-retry-detect', p_organization_id::text || ':' || p_actor_user_id::text, 5, 300
    ) or not private.consume_rate_limit(
      'translation-retry-message', p_organization_id::text || ':' || p_message_id::text, 3, 3600
    ) then
      raise exception 'translation rate limit exceeded' using errcode = 'P0001';
    end if;

    v_current_hash := extensions.digest(convert_to(v_source_body, 'UTF8'), 'sha256');

    -- Make sure the requested target has a row so the caller gets an id and
    -- the completion step has something to enqueue. Source is unknown until
    -- detection completes ('und' is what the fan-out records in that case).
    insert into public.message_translations (
      organization_id, conversation_id, message_id, source_language,
      target_language, source_body_sha256
    ) values (
      p_organization_id, p_conversation_id, p_message_id, 'und',
      p_target_language, v_current_hash
    )
    on conflict (organization_id, conversation_id, message_id, target_language) do nothing;

    update public.message_translations translation
    set status = 'queued', failure_code = null
    where translation.organization_id = p_organization_id
      and translation.message_id = p_message_id
      and translation.status in ('failed', 'blocked');

    select translation.id into v_translation_id
    from public.message_translations translation
    where translation.organization_id = p_organization_id
      and translation.message_id = p_message_id
      and translation.target_language = p_target_language;

    select coalesce(array_agg(distinct translation.target_language), array[]::text[])
      into v_targets
    from public.message_translations translation
    where translation.organization_id = p_organization_id
      and translation.message_id = p_message_id;

    -- validate_message_update() accepts detection-field changes only with
    -- both the detection and the service context on, as the worker RPCs do.
    perform set_config('app.bff_service_context', 'on', true);
    perform set_config('app.language_detection_context', 'on', true);
    update public.messages message
    set language_detection_state = 'pending',
        detected_language = null,
        language_detection_method = null,
        language_detection_confidence = null,
        language_detected_at = null
    where message.organization_id = p_organization_id
      and message.id = p_message_id;
    perform set_config('app.language_detection_context', 'off', true);
    perform set_config('app.bff_service_context', 'off', true);

    perform private.enqueue_outbox_job_internal(
      p_organization_id,
      'language_detection',
      'language-detection:' || p_organization_id::text || ':' || p_message_id::text || ':'
        || encode(v_current_hash, 'hex') || ':retry:' || floor(extract(epoch from now()))::bigint::text,
      jsonb_build_object(
        'organization_id', p_organization_id,
        'conversation_id', p_conversation_id,
        'message_id', p_message_id,
        'source_sha256', encode(v_current_hash, 'hex'),
        'client_language_hint', null,
        'required_target_languages', to_jsonb(v_targets),
        'use_case', 'language_detection'
      )
    );

    return jsonb_build_object(
      'translationId', v_translation_id::text,
      'status', 'queued',
      'retried', true
    );
  end if;

  return private.bff_enqueue_translation_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_target_language, p_idempotency_key, p_request_sha256
  );
end;
$$;

comment on function private.bff_enqueue_translation_impl(uuid, uuid, uuid, uuid, bigint, text, text, text) is
  'Translation request: retries a failed language detection (rate limited: 5 per actor per 5 minutes, 3 per message per hour), otherwise the existing enqueue/retry logic.';
