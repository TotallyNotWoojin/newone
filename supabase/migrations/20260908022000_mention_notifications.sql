-- Backlog 47(f): naming somebody in a group notifies them.
--
-- Mentions were already parsed and stored in public.message_mentions, and the
-- push resolver already used them one way: somebody who had set a chat to
-- "mentions only" heard about a message that named them. Nothing else happened.
-- A muted chat swallowed a mention, and a notification that named you looked
-- exactly like one that did not.
--
-- Two changes, both to the resolver, both read with pg_get_functiondef and
-- edited in place:
--
--   * the audience layer lets a mention through a temporary mute. Muting a busy
--     group for the afternoon should not mean missing the message that asks you
--     something directly. Switching a chat off entirely (notification_level
--     'none') is a different decision and is left alone.
--   * the content layer puts an "@" in front of the title for the people the
--     message names, which reads the same in English, Korean and Spanish and
--     needs no new copy anywhere.
--
-- No new key appears on a delivery, so the outbox worker's strict key list is
-- untouched and this migration can ship before or after the workers.

CREATE OR REPLACE FUNCTION private.bff_resolve_push_job_impl(p_worker_id uuid, p_job_id bigint, p_after_device_id uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job private.outbox_jobs%rowtype;
  v_deliveries jsonb;
  v_has_more boolean;
  v_next_device_id uuid;
  v_event jsonb;
  v_quiet_hours_override boolean := false;
begin
  perform private.require_service_role();
  if p_limit not between 1 and 1000 then
    raise exception 'invalid push delivery page size' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'push'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now();
  if not found then raise exception 'active push lease required' using errcode = '42501'; end if;
  if v_job.payload ? 'announcement_id' and v_job.payload ? 'announcement_version_id' then
    select exists (
      select 1
      from public.announcements announcement
      join public.announcement_versions version
        on version.organization_id = announcement.organization_id
       and version.announcement_id = announcement.id
      where announcement.organization_id = v_job.organization_id
        and announcement.id = nullif(v_job.payload ->> 'announcement_id', '')::uuid
        and announcement.status in ('published', 'archived')
        and version.id = nullif(v_job.payload ->> 'announcement_version_id', '')::uuid
        and version.notification_class in ('urgent', 'critical')
        and version.critical_category
          in ('safety', 'security', 'operations', 'weather', 'business_continuity')
        and char_length(btrim(coalesce(version.quiet_hours_override_reason, '')))
          between 3 and 500
        and v_job.payload ->> 'notification_class' = version.notification_class
        and v_job.payload ->> 'critical_category' = version.critical_category
        and v_job.payload ->> 'quiet_hours_override_reason' =
          version.quiet_hours_override_reason
        and not exists (
          select 1
          from public.announcement_versions newer
          where newer.organization_id = version.organization_id
            and newer.announcement_id = version.announcement_id
            and newer.version_number > version.version_number
        )
    ) into v_quiet_hours_override;
  end if;
  v_event := jsonb_strip_nulls(jsonb_build_object(
    'event_type', case
      when v_job.payload ? 'announcement_id' then 'announcement.changed'
      when v_job.payload ? 'handoff_id' then 'handoff.changed'
      when v_job.payload ? 'message_id' then 'message.changed'
      when v_job.payload ? 'conversation_id' then 'conversation.changed'
      else 'organization.changed'
    end,
    'organization_id', v_job.organization_id,
    'conversation_id', v_job.payload -> 'conversation_id',
    'message_id', v_job.payload -> 'message_id',
    'announcement_id', v_job.payload -> 'announcement_id',
    'announcement_version_id', v_job.payload -> 'announcement_version_id',
    'handoff_id', v_job.payload -> 'handoff_id',
    'state', v_job.payload -> 'state'
  ));
  with eligible_users as (
    select member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = v_job.organization_id
      and member.status = 'active'
      and member.conversation_id = nullif(v_job.payload ->> 'conversation_id', '')::uuid
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
      -- Announcement and handoff fanout have their own authoritative audience
      -- branches below. Letting the generic conversation branch participate
      -- would widen a targeted announcement to every cached member.
      and not (v_job.payload ? 'announcement_id')
      and not (v_job.payload ? 'handoff_id')
      and (
        not private.dynamic_group_policy_conversation(
          member.organization_id, member.conversation_id
        )
        or (
          private.dynamic_group_user_currently_eligible(
            member.organization_id, member.conversation_id, member.user_id, now()
          )
          and (
            not (v_job.payload ? 'message_id')
            or private.dynamic_group_message_access_allowed_for_user(
              member.organization_id, member.conversation_id,
              nullif(v_job.payload ->> 'message_id', '')::bigint,
              member.user_id, now()
            )
          )
        )
      )
    union
    select recipient.user_id
    from public.announcement_recipients recipient
    join public.organization_memberships organization_member
      on organization_member.organization_id = recipient.organization_id
     and organization_member.user_id = recipient.user_id
     and organization_member.status = 'active'
    where recipient.organization_id = v_job.organization_id
      and recipient.announcement_id = nullif(v_job.payload ->> 'announcement_id', '')::uuid
      and private.organization_membership_access_current(
        recipient.organization_id, recipient.user_id, now()
      )
      and (
        not (v_job.payload ? 'target_user_id')
        or recipient.user_id = nullif(v_job.payload ->> 'target_user_id', '')::uuid
      )
    union
    select member.user_id
    from public.shift_handoffs handoff
    join public.conversation_members member
      on member.organization_id = handoff.organization_id
     and member.conversation_id = handoff.conversation_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where handoff.organization_id = v_job.organization_id
      and handoff.id = nullif(v_job.payload ->> 'handoff_id', '')::uuid
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
  ), candidate_devices as (
    select device.*,
      coalesce(
        device.notification_preview_override, preference.notification_preview
      ) as notification_preview,
      coalesce(
        device.sound_enabled_override, preference.sound_enabled
      ) as sound_enabled,
      coalesce(
        device.vibration_enabled_override, preference.vibration_enabled
      ) as vibration_enabled,
      preference.shift_aware_suppression,
      preference.time_zone, preference.quiet_hours_start,
      preference.quiet_hours_end, preference.quiet_days
    from public.device_registrations device
    join eligible_users eligible on eligible.user_id = device.user_id
    join auth.sessions device_session
      on device_session.id = device.session_id
     and device_session.user_id = device.user_id
    join auth.users device_user on device_user.id = device_session.user_id
    join private.session_installations session_binding
      on session_binding.session_id = device_session.id
     and session_binding.user_id = device.user_id
     and session_binding.installation_id = device.installation_id
     and session_binding.platform = device.platform
     and session_binding.revoked_at is null
    left join private.push_delivery_attempts existing_attempt
      on existing_attempt.outbox_job_id = p_job_id
     and existing_attempt.device_id = device.id
    left join private.session_revocations session_revocation
      on session_revocation.organization_id = device.organization_id
     and session_revocation.session_id = device_session.id
    left join public.organization_user_preferences preference
      on preference.organization_id = device.organization_id
     and preference.user_id = device.user_id
    where device.organization_id = v_job.organization_id
      and device.revoked_at is null
      and private.organization_membership_access_current(
        device.organization_id, device.user_id, now()
      )
      and session_revocation.session_id is null
      and (device_session.not_after is null or device_session.not_after > now())
      and (device_user.banned_until is null or device_user.banned_until <= now())
      -- The later device-preference resolver must retain the dynamic-group
      -- security boundary. Exact message access prevents a delayed job from
      -- notifying somebody about content created during an eligibility gap.
      and (
        nullif(v_job.payload ->> 'conversation_id', '') is null
        or not private.dynamic_group_policy_conversation(
          v_job.organization_id,
          nullif(v_job.payload ->> 'conversation_id', '')::uuid
        )
        or case
          when v_job.payload ? 'message_id' then
            private.dynamic_group_message_access_allowed_for_user(
              v_job.organization_id,
              nullif(v_job.payload ->> 'conversation_id', '')::uuid,
              nullif(v_job.payload ->> 'message_id', '')::bigint,
              device.user_id, now()
            )
          when v_job.payload ? 'handoff_id' then
            private.dynamic_group_user_currently_eligible(
              v_job.organization_id,
              nullif(v_job.payload ->> 'conversation_id', '')::uuid,
              device.user_id, now()
            ) and exists (
              select 1
              from public.handoff_versions handoff_version
              where handoff_version.organization_id = v_job.organization_id
                and handoff_version.handoff_id =
                  nullif(v_job.payload ->> 'handoff_id', '')::uuid
                and not exists (
                  select 1 from public.handoff_versions newer
                  where newer.organization_id = handoff_version.organization_id
                    and newer.handoff_id = handoff_version.handoff_id
                    and newer.version_number > handoff_version.version_number
                )
                and private.dynamic_group_timestamp_access_allowed(
                  handoff_version.organization_id,
                  handoff_version.conversation_id,
                  device.user_id, handoff_version.created_at, now()
                )
                and not exists (
                  select 1 from unnest(handoff_version.source_message_ids) source_id
                  where not private.dynamic_group_message_access_allowed_for_user(
                    handoff_version.organization_id,
                    handoff_version.conversation_id,
                    source_id, device.user_id, now()
                  )
                )
            )
          else private.dynamic_group_user_currently_eligible(
            v_job.organization_id,
            nullif(v_job.payload ->> 'conversation_id', '')::uuid,
            device.user_id, now()
          )
        end
      )
      and (
        nullif(v_job.payload ->> 'conversation_id', '') is null
        or v_quiet_hours_override
        or exists (
          select 1
          from public.conversation_members notification_member
          join public.conversations notification_conversation
            on notification_conversation.organization_id = notification_member.organization_id
           and notification_conversation.id = notification_member.conversation_id
          left join public.conversation_preferences notification_preference
            on notification_preference.organization_id = notification_member.organization_id
           and notification_preference.conversation_id = notification_member.conversation_id
           and notification_preference.user_id = notification_member.user_id
          where notification_member.organization_id = v_job.organization_id
            and notification_member.conversation_id =
              nullif(v_job.payload ->> 'conversation_id', '')::uuid
            and notification_member.user_id = device.user_id
            and notification_member.status = 'active'
            and coalesce(
              notification_preference.notification_level,
              notification_member.notification_level,
              'all'
            ) <> 'none'
            and (
              case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end is null
              or case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end <= now()
              -- Being named cuts through a chat you have muted for a while:
              -- naming somebody is how you reach them when the room is noisy.
              -- Turning the chat off outright (notification_level 'none') is a
              -- different decision and still means off.
              or (
                v_job.payload ? 'message_id'
                and not (v_job.payload ? 'announcement_id')
                and not (v_job.payload ? 'handoff_id')
                and exists (
                  select 1
                  from public.message_mentions mention
                  where mention.organization_id = v_job.organization_id
                    and mention.conversation_id = notification_member.conversation_id
                    and mention.message_id = (v_job.payload ->> 'message_id')::bigint
                    and mention.mentioned_user_id = device.user_id
                )
              )
            )
            and (
              coalesce(
                notification_preference.notification_level,
                notification_member.notification_level,
                'all'
              ) <> 'mentions'
              or (
                v_job.payload ? 'message_id'
                and not (v_job.payload ? 'announcement_id')
                and not (v_job.payload ? 'handoff_id')
                and (
                  notification_conversation.kind = 'direct'
                  or exists (
                    select 1
                    from public.message_mentions mention
                    where mention.organization_id = v_job.organization_id
                      and mention.conversation_id = notification_member.conversation_id
                      and mention.message_id = (v_job.payload ->> 'message_id')::bigint
                      and mention.mentioned_user_id = device.user_id
                  )
                )
              )
            )
            and (
              not (v_job.payload ? 'message_id')
              or v_job.payload ? 'announcement_id'
              or v_job.payload ? 'handoff_id'
              or exists (
                select 1
                from public.messages pushed_message
                where pushed_message.organization_id = v_job.organization_id
                  and pushed_message.conversation_id = notification_member.conversation_id
                  and pushed_message.id = (v_job.payload ->> 'message_id')::bigint
                  and pushed_message.sender_user_id <> device.user_id
              )
            )
        )
      )
      and (
        existing_attempt.id is null
        or existing_attempt.status = 'pending'
        or (
          existing_attempt.status = 'retry_wait'
          and existing_attempt.next_attempt_at <= now()
        )
      )
      and (p_after_device_id is null or device.id > p_after_device_id)
    order by device.id
    limit p_limit + 1
  ), inserted_attempts as (
    insert into private.push_delivery_attempts (
      organization_id, outbox_job_id, device_id, user_id
    )
    select v_job.organization_id, p_job_id, candidate.id, candidate.user_id
    from candidate_devices candidate
    on conflict (outbox_job_id, device_id) do nothing
    returning id, device_id, status, next_attempt_at
  ), attempt_rows as (
    select inserted.id, inserted.device_id, inserted.status, inserted.next_attempt_at
    from inserted_attempts inserted
    union all
    select attempt.id, attempt.device_id, attempt.status, attempt.next_attempt_at
    from private.push_delivery_attempts attempt
    join candidate_devices candidate on candidate.id = attempt.device_id
    where attempt.outbox_job_id = p_job_id
      and not exists (
        select 1 from inserted_attempts inserted where inserted.device_id = attempt.device_id
      )
  ), page as (
    select candidate.*, attempt.id as attempt_id, attempt.status as dispatch_status,
      attempt.next_attempt_at
    from candidate_devices candidate
    join attempt_rows attempt on attempt.device_id = candidate.id
  ), numbered as (
    select page.*, row_number() over (order by page.id) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'device_id', numbered.id,
      'attempt_id', numbered.attempt_id,
      'dispatch_status', numbered.dispatch_status,
      'dispatchable', true,
      'next_attempt_at', numbered.next_attempt_at,
      'user_id', numbered.user_id,
      'installation_id', numbered.installation_id,
      'platform', numbered.platform,
      'push_token_ciphertext', numbered.push_token_ciphertext,
      'push_token_type', numbered.push_token_type,
      'push_project_id', numbered.push_project_id,
      'push_environment', numbered.push_environment,
      'locale', numbered.locale,
      'app_version', numbered.app_version,
      'currently_off_shift', private.currently_off_shift_internal(
        v_job.organization_id, numbered.user_id, now()
      ),
      'notification_class', case when v_quiet_hours_override
        then v_job.payload ->> 'notification_class' else 'routine' end,
      'critical_category', case when v_quiet_hours_override
        then v_job.payload ->> 'critical_category' else null end,
      'quiet_hours_override', v_quiet_hours_override,
      'quiet_hours_override_reason', case
        when v_quiet_hours_override
          then v_job.payload ->> 'quiet_hours_override_reason'
        else null
      end,
      'preferences', jsonb_build_object(
        'notification_preview', coalesce(numbered.notification_preview, 'generic'),
        'sound_enabled', coalesce(numbered.sound_enabled, true),
        'vibration_enabled', coalesce(numbered.vibration_enabled, true),
        'shift_aware_suppression', coalesce(numbered.shift_aware_suppression, false),
        'time_zone', coalesce(numbered.time_zone, 'UTC'),
        'quiet_hours_start', numbered.quiet_hours_start,
        'quiet_hours_end', numbered.quiet_hours_end,
        'quiet_days', coalesce(to_jsonb(numbered.quiet_days), '[0,1,2,3,4,5,6]'::jsonb)
      )
    ) order by numbered.id) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    (array_agg(numbered.id order by numbered.id)
      filter (where numbered.row_number = p_limit))[1]
  into v_deliveries, v_has_more, v_next_device_id
  from numbered;
  if not v_has_more then
    update private.outbox_jobs job
    set payload = job.payload || jsonb_build_object(
          'fanout_resolved', true,
          'fanout_count', (
            select count(*) from private.push_delivery_attempts attempt
            where attempt.outbox_job_id = p_job_id
          )
        ),
        updated_at = now()
    where job.id = p_job_id
      and job.claimed_by = p_worker_id
      and job.status = 'processing';
  end if;
  return jsonb_build_object(
    'job_id', p_job_id,
    'event', v_event,
    'deliveries', v_deliveries,
    'has_more', v_has_more,
    'next_device_id', case when v_has_more then v_next_device_id else null end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_resolve_push_job_v2_impl(p_worker_id uuid, p_job_id bigint, p_after_device_id uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
            -- A leading @ says "this one names you" in every language the app
            -- speaks, without a phrase to translate.
            case when recipient.mentioned then '@ ' else '' end
            || case when v_conversation.kind = 'direct' or nullif(btrim(coalesce(v_conversation.name, '')), '') is null
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
        exists (
          select 1
          from public.message_mentions mention
          where mention.organization_id = v_message.organization_id
            and mention.conversation_id = v_message.conversation_id
            and mention.message_id = v_message.id
            and mention.mentioned_user_id = profile.user_id
        ) as mentioned,
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

grant execute on function private.bff_resolve_push_job_impl(uuid, bigint, uuid, integer) to service_role;
grant execute on function private.bff_resolve_push_job_v2_impl(uuid, bigint, uuid, integer) to service_role;
