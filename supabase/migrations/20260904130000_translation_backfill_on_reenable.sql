-- Turning translation back to Automatic translates what arrived while it was
-- off.
--
-- Device suite (translation, run 2 and run-2026-09-04T07-12-12): a message
-- received while a member had translation Off stayed untranslated after the
-- member switched back to Automatic; only new messages were translated, and
-- the reader had to ask per message. On re-enable, the twenty most recent
-- text messages from other members whose detected language differs from the
-- reader's language and that have no translation row yet are queued through
-- the same rows and jobs the automatic path uses. Messages whose detection
-- has not completed are left to the per-message Request button.

create or replace function private.backfill_conversation_translations_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid,
  p_limit integer default 20
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_target_language text;
  v_message record;
  v_translation_id bigint;
  v_queued integer := 0;
begin
  if p_limit not between 1 and 100 then
    raise exception 'invalid backfill limit' using errcode = '22023';
  end if;
  if not private.ai_use_case_approved(p_organization_id, 'translation', null) then
    return 0;
  end if;
  select lower(coalesce(preference.message_language, profile.preferred_language))
    into v_target_language
  from public.profiles profile
  left join public.organization_user_preferences preference
    on preference.organization_id = p_organization_id
   and preference.user_id = profile.user_id
  where profile.user_id = p_actor_user_id;
  if v_target_language is null or v_target_language = 'und'
    or v_target_language !~ '^[a-z]{2,3}([_-][a-z0-9]{2,8})*$' then
    return 0;
  end if;
  for v_message in
    select message.id, message.body, message.detected_language
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.sender_user_id <> p_actor_user_id
      and message.kind = 'text'
      and message.deleted_at is null
      and message.body is not null
      and message.language_detection_state = 'completed'
      and message.detected_language is not null
      and lower(message.detected_language) <> v_target_language
      and not exists (
        select 1 from public.message_translations translation
        where translation.organization_id = message.organization_id
          and translation.conversation_id = message.conversation_id
          and translation.message_id = message.id
          and translation.target_language = v_target_language
      )
    order by message.id desc
    limit p_limit
  loop
    insert into public.message_translations (
      organization_id, conversation_id, message_id, source_language,
      target_language, source_body_sha256
    ) values (
      p_organization_id, p_conversation_id, v_message.id, v_message.detected_language,
      v_target_language, extensions.digest(convert_to(v_message.body, 'UTF8'), 'sha256')
    )
    on conflict (organization_id, conversation_id, message_id, target_language) do nothing
    returning id into v_translation_id;
    if v_translation_id is null then continue; end if;
    perform private.enqueue_outbox_job_internal(
      p_organization_id,
      'translation',
      'translation:' || v_translation_id::text,
      jsonb_build_object(
        'organization_id', p_organization_id,
        'conversation_id', p_conversation_id,
        'message_id', v_message.id,
        'target_language', v_target_language,
        'requested_by_user_id', p_actor_user_id
      )
    );
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end;
$$;

revoke all on function private.backfill_conversation_translations_internal(uuid, uuid, uuid, integer) from public;

alter function private.bff_update_conversation_preferences_impl(
  uuid, uuid, uuid, uuid, jsonb, text, text
) rename to bff_update_conversation_preferences_pre_translation_backfill_impl;

create or replace function private.bff_update_conversation_preferences_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_patch jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_previous_mode text;
  v_response jsonb;
begin
  select preference.translation_mode into v_previous_mode
  from public.conversation_preferences preference
  where preference.organization_id = p_organization_id
    and preference.conversation_id = p_conversation_id
    and preference.user_id = p_actor_user_id;
  v_response := private.bff_update_conversation_preferences_pre_translation_backfill_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_patch, p_idempotency_key, p_request_sha256
  );
  if jsonb_typeof(p_patch) = 'object'
    and p_patch ->> 'translation_mode' = 'automatic'
    and coalesce(v_previous_mode, 'automatic') <> 'automatic'
    and v_response ->> 'translation_mode' = 'automatic' then
    perform private.backfill_conversation_translations_internal(
      p_actor_user_id, p_organization_id, p_conversation_id, 20
    );
  end if;
  return v_response;
end;
$$;

revoke all on function private.bff_update_conversation_preferences_impl(
  uuid, uuid, uuid, uuid, jsonb, text, text
) from public;
revoke all on function private.bff_update_conversation_preferences_pre_translation_backfill_impl(
  uuid, uuid, uuid, uuid, jsonb, text, text
) from public;
