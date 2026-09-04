-- Language detection completion never notified any device: the sender only saw
-- the detected language (and the "Translate for me" action) after the next
-- periodic reconcile. Emit a content-free ('message', 'language_detected')
-- invalidation to the conversation members when a detection job completes.

create or replace function private.workspace_invalidation_reason_allowed(p_entity_type text, p_reason text)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select (p_entity_type, p_reason) in (
    ('contact_connection', 'contact_request_created'),
    ('contact_connection', 'contact_accepted'),
    ('contact_connection', 'contact_declined'),
    ('contact_connection', 'contact_cancelled'),
    ('contact_connection', 'contact_removed'),
    ('member_block', 'member_blocked'),
    ('member_block', 'member_unblocked'),
    ('reaction', 'reaction_added'),
    ('reaction', 'reaction_removed'),
    ('pin', 'message_pinned'),
    ('pin', 'message_unpinned'),
    ('message', 'message_deleted'),
    ('message', 'message_edited'),
    ('message', 'language_detected'),
    ('message_visibility', 'message_hidden_for_user'),
    ('attachment', 'attachment_uploaded'),
    ('attachment', 'attachment_scan_clean'),
    ('attachment', 'attachment_scan_quarantined'),
    ('attachment', 'attachment_scan_failed'),
    ('translation', 'translation_completed'),
    ('translation', 'translation_failed'),
    ('translation', 'translation_blocked'),
    ('summary', 'summary_queued'),
    ('summary', 'summary_draft'),
    ('summary', 'summary_failed'),
    ('summary', 'summary_stale'),
    ('summary', 'summary_approved'),
    ('conversation', 'conversation_updated'),
    ('conversation_preference', 'conversation_preferences_updated'),
    ('profile', 'profile_updated'),
    ('profile', 'account_deleted')
  )
$function$;

create or replace function private.bff_complete_language_detection_job_impl(
  p_worker_id uuid, p_job_id bigint, p_source_sha256 text, p_detection_state text,
  p_detected_language text, p_method text, p_confidence numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_sender_language text;
  v_job record;
  v_result jsonb;
begin
  select job.organization_id,
         (job.payload ->> 'conversation_id')::uuid as conversation_id,
         (job.payload ->> 'message_id')::bigint as message_id
    into v_job
  from private.outbox_jobs job
  where job.id = p_job_id;

  if p_detection_state = 'ambiguous' then
    select lower(coalesce(
        nullif(message.language_code, ''),
        preference.message_language,
        profile.preferred_language
      ))
      into v_sender_language
    from private.outbox_jobs job
    join public.messages message
      on message.organization_id = job.organization_id
     and message.id = (job.payload ->> 'message_id')::bigint
    join public.profiles profile on profile.user_id = message.sender_user_id
    left join public.organization_user_preferences preference
      on preference.organization_id = message.organization_id
     and preference.user_id = message.sender_user_id
    where job.id = p_job_id;
    if v_sender_language is not null
      and v_sender_language <> 'und'
      and v_sender_language ~ '^[a-z]{2,3}([_-][a-z0-9]{2,8})*$' then
      v_result := private.bff_complete_language_detection_job_pre_sender_fallback_impl(
        p_worker_id, p_job_id, p_source_sha256, 'completed', v_sender_language,
        left(coalesce(p_method, 'detector') || ':sender-language', 120),
        p_confidence
      );
      if v_job.message_id is not null then
        perform private.enqueue_conversation_invalidation_internal(
          v_job.organization_id, v_job.conversation_id, 'message', v_job.message_id::text,
          'language_detected', array[]::uuid[]
        );
      end if;
      return v_result;
    end if;
  end if;
  v_result := private.bff_complete_language_detection_job_pre_sender_fallback_impl(
    p_worker_id, p_job_id, p_source_sha256, p_detection_state, p_detected_language,
    p_method, p_confidence
  );
  if v_job.message_id is not null then
    perform private.enqueue_conversation_invalidation_internal(
      v_job.organization_id, v_job.conversation_id, 'message', v_job.message_id::text,
      'language_detected', array[]::uuid[]
    );
  end if;
  return v_result;
end;
$function$;

grant execute on function private.bff_complete_language_detection_job_impl(uuid, bigint, text, text, text, text, numeric) to service_role;
