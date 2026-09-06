-- Server-side "mute all notifications" (backlog 13). The Settings switch used
-- to reflect only the OS permission and deep-link to the system settings, so
-- turning it off never stopped the server from sending. Each device
-- registration now carries notifications_muted; the switch writes it through
-- two current-installation RPCs, and the push resolver stamps the flag on every
-- delivery so the outbox worker settles muted deliveries as skipped instead of
-- submitting them to Expo.

alter table public.device_registrations
  add column if not exists notifications_muted boolean not null default false;

-- The caller's current registration: same binding as the device preference
-- RPCs (the session's installation, still bound, not revoked).
create or replace function private.device_notifications_muted_response_internal(
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
    'notifications_muted', device.notifications_muted,
    'updated_at', device.updated_at
  )
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
$$;

-- Read: an installation without a live registration answers registered=false
-- (nothing is muted because nothing can be sent) instead of an error, so the
-- Settings screen can load it alongside the device preferences.
create or replace function private.bff_get_device_notifications_muted_impl(
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
  v_response := private.device_notifications_muted_response_internal(
    p_organization_id, p_actor_user_id, p_session_id, p_installation_id
  );
  return coalesce(v_response, jsonb_build_object(
    'registered', false,
    'device_id', null,
    'installation_id', p_installation_id,
    'notifications_muted', false,
    'updated_at', null
  ));
end;
$$;

-- Write: mute or unmute the caller's current registration. Idempotent on the
-- flag itself (setting the same value again changes nothing) and replay-safe
-- through the standard BFF command envelope.
create or replace function private.bff_set_device_notifications_muted_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_muted boolean,
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
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'device.preferences.update', false, 0,
    '/v2/devices/:installationId/mute',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then
    return v_command -> 'response';
  end if;
  if p_muted is null then
    raise exception 'invalid device mute request' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'device-notifications-muted-hour',
    p_organization_id::text || ':' || p_actor_user_id::text || ':'
      || p_installation_id::text,
    60, 3600
  ) then
    raise exception 'device notification mute limit exceeded' using errcode = 'P0001';
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

  if v_device.notifications_muted is distinct from p_muted then
    update public.device_registrations device
    set notifications_muted = p_muted,
        updated_at = clock_timestamp()
    where device.organization_id = p_organization_id
      and device.id = v_device.id;
    insert into public.audit_events (
      organization_id, actor_user_id, event_type, target_type, target_id, metadata
    ) values (
      p_organization_id, p_actor_user_id,
      'device.notifications_muted.updated', 'device', v_device.id::text,
      jsonb_build_object('notifications_muted', p_muted)
    );
  end if;

  v_response := private.device_notifications_muted_response_internal(
    p_organization_id, p_actor_user_id, p_session_id, p_installation_id
  );
  if v_response is null then
    raise exception 'current registered installation required' using errcode = '42501';
  end if;
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/devices/:installationId/mute',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function public.bff_get_device_notifications_muted(
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
  select private.bff_get_device_notifications_muted_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_installation_id
  )
$$;

create or replace function public.bff_set_device_notifications_muted(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_muted boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_set_device_notifications_muted_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_installation_id,
    p_muted, p_idempotency_key, p_request_sha256
  )
$$;

revoke execute on function
  private.device_notifications_muted_response_internal(uuid, uuid, uuid, uuid),
  private.bff_get_device_notifications_muted_impl(uuid, uuid, uuid, uuid),
  private.bff_set_device_notifications_muted_impl(uuid, uuid, uuid, uuid, boolean, text, text),
  public.bff_get_device_notifications_muted(uuid, uuid, uuid, uuid),
  public.bff_set_device_notifications_muted(uuid, uuid, uuid, uuid, boolean, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_get_device_notifications_muted_impl(uuid, uuid, uuid, uuid),
  private.bff_set_device_notifications_muted_impl(uuid, uuid, uuid, uuid, boolean, text, text),
  public.bff_get_device_notifications_muted(uuid, uuid, uuid, uuid),
  public.bff_set_device_notifications_muted(uuid, uuid, uuid, uuid, boolean, text, text)
to service_role;

-- Push resolution, layer 3: every delivery of every job type carries the
-- registration's notifications_muted so the outbox worker can settle muted
-- deliveries as skipped without a provider submission. Layers 1 and 2 (the
-- audience, quiet hours, conversation mutes, and the message content) are
-- unchanged. Deploy order: the outbox worker that accepts the key must be live
-- before this migration runs, because the worker rejects unknown delivery keys.
create or replace function private.bff_resolve_push_job_v3_impl(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid, p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_deliveries jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_resolve_push_job_v2_impl(p_worker_id, p_job_id, p_after_device_id, p_limit);
  if jsonb_typeof(v_result -> 'deliveries') <> 'array'
     or jsonb_array_length(v_result -> 'deliveries') = 0 then
    return v_result;
  end if;

  select coalesce(jsonb_agg(
      entry.delivery || jsonb_build_object(
        'notifications_muted', coalesce(device.notifications_muted, false)
      )
      order by entry.ordinality), '[]'::jsonb)
    into v_deliveries
  from jsonb_array_elements(v_result -> 'deliveries') with ordinality as entry(delivery, ordinality)
  left join public.device_registrations device
    on device.id = nullif(entry.delivery ->> 'device_id', '')::uuid;

  return jsonb_set(v_result, '{deliveries}', v_deliveries, true);
end;
$function$;

revoke execute on function private.bff_resolve_push_job_v3_impl(uuid, bigint, uuid, integer)
from public, anon, authenticated;
grant execute on function private.bff_resolve_push_job_v3_impl(uuid, bigint, uuid, integer) to service_role;

create or replace function public.bff_resolve_push_job(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid default null, p_limit integer default 500
)
returns jsonb
language sql
set search_path = ''
as $function$ select private.bff_resolve_push_job_v3_impl(
  p_worker_id, p_job_id, p_after_device_id, p_limit
) $function$;
