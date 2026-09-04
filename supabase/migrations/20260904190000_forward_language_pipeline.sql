-- Defect K (owner data, Sep 4 2026): a forwarded message is inserted by
-- private.bff_forward_message_impl through private.send_message and only a
-- push job is enqueued. The send path additionally creates the recipients'
-- translation rows and the language_detection job; the forward path never
-- did, so every forwarded copy sat in language_detection_state = 'pending'
-- with no translation (messages 190 and 292 on hosted). The shared block now
-- lives in one helper used by the forward path.

create or replace function private.queue_message_language_pipeline_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_body text,
  p_language_code text
)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_language text;
  v_translation_id bigint;
  v_translation_targets text[] := array[]::text[];
begin
  if p_body is null then return v_translation_targets; end if;
  -- Only active recipients that explicitly remain in automatic mode contribute
  -- their server-owned language (same rule as the send path).
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
      and member.conversation_id = p_conversation_id
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
      p_organization_id, p_conversation_id, p_message_id,
      'und', v_target_language,
      extensions.digest(convert_to(p_body, 'UTF8'), 'sha256')
    )
    on conflict (organization_id, conversation_id, message_id, target_language) do nothing
    returning id into v_translation_id;
    v_translation_targets := array_append(v_translation_targets, v_target_language);
  end loop;
  if private.ai_use_case_approved(p_organization_id, 'language_detection', null) then
    perform private.enqueue_outbox_job_internal(
      p_organization_id,
      'language_detection',
      'language-detection:' || p_organization_id::text || ':' || p_message_id::text || ':'
        || encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex'),
      jsonb_build_object(
        'organization_id', p_organization_id,
        'conversation_id', p_conversation_id,
        'message_id', p_message_id,
        'source_sha256', encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex'),
        'client_language_hint', p_language_code,
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
      and message.conversation_id = p_conversation_id and message.id = p_message_id;
    update public.message_translations translation
    set status = 'blocked', failure_code = 'tenant_ai_policy_disabled'
    where translation.organization_id = p_organization_id
      and translation.conversation_id = p_conversation_id
      and translation.message_id = p_message_id and translation.status = 'queued';
    perform set_config('app.language_detection_context', 'off', true);
  end if;
  return v_translation_targets;
end;
$$;

revoke all on function private.queue_message_language_pipeline_internal(uuid, uuid, uuid, bigint, text, text) from public;
grant execute on function private.queue_message_language_pipeline_internal(uuid, uuid, uuid, bigint, text, text) to service_role;

create or replace function private.bff_forward_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_source_conversation_id uuid,
  p_source_message_id bigint,
  p_target_conversation_id uuid,
  p_client_nonce uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_source public.messages%rowtype;
  v_target_message_id bigint;
  v_translation_targets text[];
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.forward', false, 0, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select message.* into v_source
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_source_conversation_id
    and message.id = p_source_message_id
    and message.kind = 'text' and message.body is not null
    and private.dynamic_group_message_access_allowed_for_user(
      message.organization_id, message.conversation_id,
      message.id, p_actor_user_id, now()
    )
    and not exists (
      select 1 from public.message_attachments attachment
      where attachment.organization_id = message.organization_id
        and attachment.conversation_id = message.conversation_id
        and attachment.message_id = message.id
    );
  if not found then
    raise exception 'readable forwardable text message not found' using errcode = '42501';
  end if;
  v_target_message_id := private.send_message(
    p_organization_id, p_target_conversation_id, p_client_nonce, 'text',
    v_source.body, v_source.language_code, null, null, '{}'::jsonb
  );
  insert into public.message_forward_provenance (
    organization_id, target_conversation_id, target_message_id,
    source_conversation_id, source_message_id, forwarded_by_user_id
  ) values (
    p_organization_id, p_target_conversation_id, v_target_message_id,
    p_source_conversation_id, p_source_message_id, p_actor_user_id
  ) on conflict (organization_id, target_conversation_id, target_message_id) do nothing;
  -- The forwarded copy is a new message for its recipients: detection and
  -- translations exactly as for a typed message.
  v_translation_targets := private.queue_message_language_pipeline_internal(
    p_actor_user_id, p_organization_id, p_target_conversation_id,
    v_target_message_id, v_source.body, v_source.language_code
  );
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'push',
    'message:' || p_organization_id::text || ':' || p_target_conversation_id::text
      || ':' || v_target_message_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', p_target_conversation_id,
      'message_id', v_target_message_id
    )
  );
  v_response := jsonb_build_object(
    'message_id', v_target_message_id,
    'client_nonce', p_client_nonce,
    'forwarded', true,
    'translation_targets', to_jsonb(v_translation_targets),
    'language_detection_queued', private.ai_use_case_approved(p_organization_id, 'language_detection', null),
    'source', jsonb_build_object(
      'conversation_id', p_source_conversation_id,
      'message_id', p_source_message_id
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

revoke all on function private.bff_forward_message_impl(uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, text) from public;
grant execute on function private.bff_forward_message_impl(uuid, uuid, uuid, uuid, bigint, uuid, uuid, text, text) to service_role;
