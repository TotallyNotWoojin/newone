-- Undetermined language falls back to the sender's own language.
--
-- Short texts with codes ("Unread probe 1cn5") come back from the detector
-- as undetermined, which blocked every translation of the message with
-- `language_ambiguous` (hosted, Sep 4 2026). The sender's language setting
-- is a strong prior for a personal conversation: when detection is
-- undetermined and the sender's language is a supported code, the message
-- is completed as that language (method suffixed `:sender-language`) and
-- translations proceed as usual. A genuinely undetermined message from a
-- sender without a language stays ambiguous.

alter function private.bff_complete_language_detection_job_impl(
  uuid, bigint, text, text, text, text, numeric
) rename to bff_complete_language_detection_job_pre_sender_fallback_impl;

create or replace function private.bff_complete_language_detection_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_detection_state text,
  p_detected_language text,
  p_method text,
  p_confidence numeric
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_sender_language text;
begin
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
      return private.bff_complete_language_detection_job_pre_sender_fallback_impl(
        p_worker_id, p_job_id, p_source_sha256, 'completed', v_sender_language,
        left(coalesce(p_method, 'detector') || ':sender-language', 120),
        p_confidence
      );
    end if;
  end if;
  return private.bff_complete_language_detection_job_pre_sender_fallback_impl(
    p_worker_id, p_job_id, p_source_sha256, p_detection_state, p_detected_language,
    p_method, p_confidence
  );
end;
$$;

revoke all on function private.bff_complete_language_detection_job_impl(
  uuid, bigint, text, text, text, text, numeric
) from public;
grant execute on function private.bff_complete_language_detection_job_impl(
  uuid, bigint, text, text, text, text, numeric
) to service_role;
revoke all on function private.bff_complete_language_detection_job_pre_sender_fallback_impl(
  uuid, bigint, text, text, text, text, numeric
) from public;
grant execute on function private.bff_complete_language_detection_job_pre_sender_fallback_impl(
  uuid, bigint, text, text, text, text, numeric
) to service_role;
