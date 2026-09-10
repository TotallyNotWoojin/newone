-- Restore the push recipient list. Push has been dead since the table drop.
--
-- The reduction that replaced subqueries over dropped tables with null does
-- not know a CTE body from a scalar subquery. bff_resolve_push_job_impl opens
-- with "with eligible_users as ( select member.user_id from
-- conversation_members ... union <announcement recipients> union <handoff
-- members> )", and because two of its three arms read dropped tables, the
-- whole CTE -- including the conversation-members arm that is the entire
-- consumer recipient list -- became "with eligible_users as null". That is not
-- valid SQL, so every push job failed: 9 failed and 44 dead-lettered in the
-- hour after the drop, against a clean hour before it.
--
-- Rebuilt from the original by splitting eligible_users on top-level union and
-- keeping the conversation-members arm, with checks that the function's CTE
-- list is unchanged (eligible_users, candidate_devices, inserted_attempts,
-- attempt_rows, page, numbered) and that no CTE or join was replaced by null.

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
    select false into v_quiet_hours_override;
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
            ) and false
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
$function$
;
