begin;

-- NOTIF-01: account preferences remain the default, while each registered
-- installation may deliberately override preview, sound, and vibration. The
-- nullable overrides make "inherit from my account" an explicit state.
alter table public.device_registrations
  add column notification_preview_override text,
  add column sound_enabled_override boolean,
  add column vibration_enabled_override boolean,
  add column notification_preferences_version integer not null default 1,
  add column notification_preferences_updated_at timestamptz not null default now(),
  add constraint device_registrations_notification_preview_override_allowed
    check (notification_preview_override is null
      or notification_preview_override in ('generic', 'hidden')),
  add constraint device_registrations_notification_preferences_version_positive
    check (notification_preferences_version > 0),
  add constraint device_registrations_notification_preferences_updated_finite
    check (isfinite(notification_preferences_updated_at));

create or replace function private.validate_device_notification_preferences_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_session_id uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
begin
  if new.notification_preview_override is not distinct from old.notification_preview_override
    and new.sound_enabled_override is not distinct from old.sound_enabled_override
    and new.vibration_enabled_override is not distinct from old.vibration_enabled_override
    and new.notification_preferences_version = old.notification_preferences_version
    and new.notification_preferences_updated_at = old.notification_preferences_updated_at then
    return new;
  end if;

  if coalesce(
      current_setting('app.device_notification_preferences_context', true), 'off'
    ) <> 'on'
    or v_actor_user_id is null
    or v_actor_user_id <> old.user_id
    or v_session_id is null
    or v_session_id <> old.session_id
    or old.revoked_at is not null
    or new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.installation_id is distinct from old.installation_id
    or new.session_id is distinct from old.session_id
    or new.notification_preferences_version <> old.notification_preferences_version + 1
    or new.notification_preferences_updated_at <= old.notification_preferences_updated_at then
    raise exception 'device notification preferences require the current installation workflow'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger device_registrations_05_validate_notification_preferences
before update on public.device_registrations
for each row execute function private.validate_device_notification_preferences_update();

create or replace function private.device_notification_preferences_response_internal(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_session_id uuid,
  p_installation_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'registered', true,
    'device_id', device.id,
    'installation_id', device.installation_id,
    'platform', device.platform,
    'preference_version', device.notification_preferences_version,
    'overrides', jsonb_build_object(
      'notification_preview', device.notification_preview_override,
      'sound_enabled', device.sound_enabled_override,
      'vibration_enabled', device.vibration_enabled_override
    ),
    'effective', jsonb_build_object(
      'notification_preview', coalesce(
        device.notification_preview_override,
        account_preference.notification_preview,
        'generic'
      ),
      'sound_enabled', coalesce(
        device.sound_enabled_override,
        account_preference.sound_enabled,
        true
      ),
      'vibration_enabled', coalesce(
        device.vibration_enabled_override,
        account_preference.vibration_enabled,
        true
      )
    ),
    'updated_at', device.notification_preferences_updated_at
  )
  from public.device_registrations device
  join private.session_installations binding
    on binding.session_id = p_session_id
   and binding.user_id = p_actor_user_id
   and binding.installation_id = p_installation_id
   and binding.platform = device.platform
   and binding.revoked_at is null
  left join public.organization_user_preferences account_preference
    on account_preference.organization_id = device.organization_id
   and account_preference.user_id = device.user_id
  where device.organization_id = p_organization_id
    and device.user_id = p_actor_user_id
    and device.session_id = p_session_id
    and device.installation_id = p_installation_id
    and device.revoked_at is null
$$;

create or replace function private.bff_get_device_notification_preferences_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'device.preferences.read', false, 0
  );
  v_response := private.device_notification_preferences_response_internal(
    p_organization_id, p_actor_user_id, p_session_id, p_installation_id
  );
  if v_response is null then
    raise exception 'current registered installation required' using errcode = '42501';
  end if;
  return v_response;
end;
$$;

create or replace function private.bff_update_device_notification_preferences_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_expected_version integer,
  p_patch jsonb,
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
  v_device public.device_registrations%rowtype;
  v_response jsonb;
  v_changed_keys jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'device.preferences.update', false, 0,
    '/v2/devices/:installationId/preferences',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then
    return v_command -> 'response';
  end if;

  if p_expected_version < 1
    or p_patch is null
    or jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb
    or exists (
      select 1 from jsonb_object_keys(p_patch) patch_key
      where patch_key not in (
        'notification_preview', 'sound_enabled', 'vibration_enabled'
      )
    )
    or (
      p_patch ? 'notification_preview'
      and p_patch -> 'notification_preview' <> 'null'::jsonb
      and (
        jsonb_typeof(p_patch -> 'notification_preview') <> 'string'
        or p_patch ->> 'notification_preview' not in ('generic', 'hidden')
      )
    )
    or exists (
      select 1
      from (values ('sound_enabled'), ('vibration_enabled')) boolean_key(name)
      where p_patch ? boolean_key.name
        and p_patch -> boolean_key.name <> 'null'::jsonb
        and jsonb_typeof(p_patch -> boolean_key.name) <> 'boolean'
    ) then
    raise exception 'invalid device notification preference patch' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'device-notification-preferences-hour',
    p_organization_id::text || ':' || p_actor_user_id::text || ':'
      || p_installation_id::text,
    30, 3600
  ) then
    raise exception 'device notification preference limit exceeded' using errcode = 'P0001';
  end if;

  select device.* into v_device
  from public.device_registrations device
  join private.session_installations binding
    on binding.session_id = p_session_id
   and binding.user_id = p_actor_user_id
   and binding.installation_id = p_installation_id
   and binding.platform = device.platform
   and binding.revoked_at is null
  where device.organization_id = p_organization_id
    and device.user_id = p_actor_user_id
    and device.session_id = p_session_id
    and device.installation_id = p_installation_id
    and device.revoked_at is null
  for update of device;
  if not found then
    raise exception 'current registered installation required' using errcode = '42501';
  end if;
  if v_device.notification_preferences_version <> p_expected_version then
    raise exception 'device notification preference version conflict' using errcode = '40001';
  end if;

  perform set_config('app.device_notification_preferences_context', 'on', true);
  update public.device_registrations device
  set notification_preview_override = case
        when p_patch ? 'notification_preview'
          then case when p_patch -> 'notification_preview' = 'null'::jsonb
            then null else p_patch ->> 'notification_preview' end
        else device.notification_preview_override
      end,
      sound_enabled_override = case
        when p_patch ? 'sound_enabled'
          then case when p_patch -> 'sound_enabled' = 'null'::jsonb
            then null else (p_patch ->> 'sound_enabled')::boolean end
        else device.sound_enabled_override
      end,
      vibration_enabled_override = case
        when p_patch ? 'vibration_enabled'
          then case when p_patch -> 'vibration_enabled' = 'null'::jsonb
            then null else (p_patch ->> 'vibration_enabled')::boolean end
        else device.vibration_enabled_override
      end,
      notification_preferences_version = device.notification_preferences_version + 1,
      notification_preferences_updated_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where device.organization_id = p_organization_id
    and device.id = v_device.id;
  perform set_config('app.device_notification_preferences_context', 'off', true);

  select coalesce(jsonb_agg(key order by key), '[]'::jsonb)
    into v_changed_keys
  from jsonb_object_keys(p_patch) key;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id,
    'device.notification_preferences.updated', 'device', v_device.id::text,
    jsonb_build_object(
      'changed_keys', v_changed_keys,
      'preference_version', p_expected_version + 1
    )
  );

  v_response := private.device_notification_preferences_response_internal(
    p_organization_id, p_actor_user_id, p_session_id, p_installation_id
  );
  if v_response is null then
    raise exception 'current registered installation required' using errcode = '42501';
  end if;
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/devices/:installationId/preferences',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function public.bff_get_device_notification_preferences(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_get_device_notification_preferences_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_installation_id
  )
$$;

create or replace function public.bff_update_device_notification_preferences(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_update_device_notification_preferences_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_installation_id,
    p_expected_version, p_patch, p_idempotency_key, p_request_sha256
  )
$$;

revoke execute on function
  private.validate_device_notification_preferences_update(),
  private.device_notification_preferences_response_internal(uuid, uuid, uuid, uuid),
  private.bff_get_device_notification_preferences_impl(uuid, uuid, uuid, uuid),
  private.bff_update_device_notification_preferences_impl(
    uuid, uuid, uuid, uuid, integer, jsonb, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_get_device_notification_preferences_impl(uuid, uuid, uuid, uuid),
  private.bff_update_device_notification_preferences_impl(
    uuid, uuid, uuid, uuid, integer, jsonb, text, text
  )
to service_role;

revoke execute on function
  public.bff_get_device_notification_preferences(uuid, uuid, uuid, uuid),
  public.bff_update_device_notification_preferences(
    uuid, uuid, uuid, uuid, integer, jsonb, text, text
  )
from public, anon, authenticated, service_role;
grant execute on function
  public.bff_get_device_notification_preferences(uuid, uuid, uuid, uuid),
  public.bff_update_device_notification_preferences(
    uuid, uuid, uuid, uuid, integer, jsonb, text, text
  )
to service_role;

-- Resolve every push against the current installation override first, then
-- the user's account default. The rest of the resolver is preserved so quiet
-- hours, conversation mutes, current authorization, leases, and receipt
-- idempotency retain the foundation contract.
create or replace function private.bff_resolve_push_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_after_device_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
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
$$;

comment on column public.device_registrations.notification_preview_override is
  'Nullable current-installation override; null inherits the organization-user preference.';
comment on function public.bff_update_device_notification_preferences(
  uuid, uuid, uuid, uuid, integer, jsonb, text, text
) is
  'CAS-protected current-installation notification overrides. Null patch values restore account inheritance.';

commit;
