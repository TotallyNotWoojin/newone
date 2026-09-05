-- Push notifications were content-free by design ("Open Newone to view new
-- activity") and left 5 seconds after a message, before any translation
-- existed. Consumer users asked to see what was actually sent, in their own
-- language. This layer enriches each resolved delivery with the message text:
-- the completed translation for the recipient's message language when it is
-- fresh, otherwise the original. When the recipient reads a different language
-- and the translation is not ready yet, translation_pending tells the worker to
-- hold that delivery briefly (the worker re-resolves; the hold ends after 25 s).
-- Personal-realm recipients get preview mode 'content' unless they chose
-- 'hidden'; workplace organizations keep their generic/hidden modes.

create or replace function private.bff_resolve_push_job_v2_impl(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid, p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_job private.outbox_jobs%rowtype;
  v_message public.messages%rowtype;
  v_conversation public.conversations%rowtype;
  v_sender_name text;
  v_attachment_kind text;
  v_attachment_name text;
  v_original_body text;
  v_message_language text;
  v_personal boolean;
  v_deliveries jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_resolve_push_job_impl(p_worker_id, p_job_id, p_after_device_id, p_limit);
  if jsonb_typeof(v_result -> 'deliveries') <> 'array'
     or jsonb_array_length(v_result -> 'deliveries') = 0 then
    return v_result;
  end if;

  select * into v_job from private.outbox_jobs job where job.id = p_job_id;
  if not found or not (v_job.payload ? 'message_id')
     or v_job.payload ? 'announcement_id' or v_job.payload ? 'handoff_id' then
    return v_result;
  end if;

  select * into v_message
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.id = nullif(v_job.payload ->> 'message_id', '')::bigint;
  if not found or v_message.deleted_at is not null then
    return v_result;
  end if;
  select * into v_conversation
  from public.conversations conversation
  where conversation.organization_id = v_message.organization_id
    and conversation.id = v_message.conversation_id;

  v_personal := v_job.organization_id = private.personal_realm_organization_id();
  select coalesce(nullif(btrim(profile.display_name), ''), 'Newone') into v_sender_name
  from public.profiles profile where profile.user_id = v_message.sender_user_id;
  v_sender_name := coalesce(v_sender_name, 'Newone');

  select
    case
      when attachment.mime_type like 'image/%' then 'image'
      when attachment.mime_type like 'audio/%' then 'voice'
      when attachment.mime_type like 'video/%' then 'video'
      else 'file'
    end,
    attachment.file_name
  into v_attachment_kind, v_attachment_name
  from public.message_attachments attachment
  where attachment.organization_id = v_message.organization_id
    and attachment.message_id = v_message.id
  order by attachment.created_at limit 1;

  v_original_body := nullif(btrim(coalesce(v_message.body, '')), '');
  v_message_language := lower(coalesce(v_message.detected_language, ''));
  if v_message_language in ('', 'und', 'mixed') then v_message_language := null; end if;

  select coalesce(jsonb_agg(enriched.delivery order by enriched.ordinality), '[]'::jsonb)
    into v_deliveries
  from (
    select entry.ordinality,
      jsonb_set(
        entry.delivery, '{preferences,notification_preview}',
        to_jsonb(case
          when v_personal and coalesce(entry.delivery -> 'preferences' ->> 'notification_preview', 'generic') <> 'hidden'
            then 'content'
          else coalesce(entry.delivery -> 'preferences' ->> 'notification_preview', 'generic')
        end), true)
        || jsonb_build_object(
          'content_title',
            case when v_conversation.kind = 'direct' or nullif(btrim(coalesce(v_conversation.name, '')), '') is null
              then v_sender_name
              else v_sender_name || ' · ' || btrim(v_conversation.name)
            end,
          'content_body',
            coalesce(
              recipient.translated_body,
              v_original_body,
              case
                when v_attachment_kind = 'image' then '📷 ' || coalesce(v_attachment_name, 'Photo')
                when v_attachment_kind = 'voice' then '🎤 Voice message'
                when v_attachment_kind = 'video' then '🎬 ' || coalesce(v_attachment_name, 'Video')
                when v_attachment_kind is not null then '📎 ' || coalesce(v_attachment_name, 'File')
                else null
              end
            ),
          'translation_pending',
            (
              v_original_body is not null
              and recipient.translated_body is null
              and recipient.language is not null
              and (v_message_language is null or v_message_language <> recipient.language)
              and v_message.created_at > now() - interval '25 seconds'
              -- Only hold when a translation is actually on its way.
              and exists (
                select 1 from public.message_translations pending
                where pending.organization_id = v_message.organization_id
                  and pending.message_id = v_message.id
                  and lower(pending.target_language) = recipient.language
                  and pending.status = 'queued'
              )
            )
        ) as delivery
    from jsonb_array_elements(v_result -> 'deliveries') with ordinality as entry(delivery, ordinality)
    left join lateral (
      select lower(coalesce(preference.message_language, profile.preferred_language)) as language,
        (
          select translation.translated_body
          from public.message_translations translation
          where translation.organization_id = v_message.organization_id
            and translation.conversation_id = v_message.conversation_id
            and translation.message_id = v_message.id
            and translation.status = 'completed'
            and translation.translated_body is not null
            and lower(translation.target_language)
              = lower(coalesce(preference.message_language, profile.preferred_language))
            and v_message.body is not null
            and translation.source_body_sha256
              = extensions.digest(convert_to(v_message.body, 'UTF8'), 'sha256')
          limit 1
        ) as translated_body
      from public.profiles profile
      left join public.organization_user_preferences preference
        on preference.organization_id = v_job.organization_id
       and preference.user_id = profile.user_id
      where profile.user_id = nullif(entry.delivery ->> 'user_id', '')::uuid
    ) recipient on true
  ) enriched;

  return jsonb_set(v_result, '{deliveries}', v_deliveries, true);
end;
$function$;

grant execute on function private.bff_resolve_push_job_v2_impl(uuid, bigint, uuid, integer) to service_role;

create or replace function public.bff_resolve_push_job(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid default null, p_limit integer default 500
)
returns jsonb
language sql
set search_path = ''
as $function$ select private.bff_resolve_push_job_v2_impl(
  p_worker_id, p_job_id, p_after_device_id, p_limit
) $function$;
