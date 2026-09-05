-- Defect Y: a device registration revoked by sign-out (or by signing into a
-- second account on the same phone) could never be restored: the upsert refused
-- rows with revoked_at set and the client swallowed the error, so that phone
-- silently stopped receiving notifications for good. The caller must still hold
-- a live session binding for the installation, which is checked first.

CREATE OR REPLACE FUNCTION private.bff_register_device_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_installation_id uuid, p_platform text, p_push_token_ciphertext text, p_push_token_type text, p_push_project_id uuid, p_push_environment text, p_app_version text, p_locale text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_device_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'device.register', false, 0, '/v2/devices',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_platform not in ('ios', 'android')
    or p_push_token_type <> 'expo'
    or p_push_project_id is null
    or p_push_environment not in ('development', 'preview', 'production')
    or char_length(coalesce(p_push_token_ciphertext, '')) not between 20 and 8192
    or p_push_token_ciphertext !~ '^(kms|vault|ciphertext):' then
    raise exception 'invalid protected push registration' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.session_installations binding
    where binding.session_id = p_session_id
      and binding.user_id = p_actor_user_id
      and binding.installation_id = p_installation_id
      and binding.platform = p_platform
      and binding.revoked_at is null
  ) then
    raise exception 'active session installation binding required' using errcode = '42501';
  end if;

  insert into public.device_registrations (
    organization_id, user_id, session_id, installation_id, platform,
    push_token_ciphertext, push_token_type, push_project_id, push_environment,
    app_version, locale
  ) values (
    p_organization_id, p_actor_user_id, p_session_id, p_installation_id, p_platform,
    p_push_token_ciphertext, p_push_token_type, p_push_project_id, p_push_environment,
    p_app_version, p_locale
  )
  on conflict (organization_id, user_id, installation_id)
  do update set
    -- A registration revoked by sign-out or by signing into another account on
    -- the same phone is restored here: the live session binding for the caller
    -- was verified above, so the device is legitimately back.
    revoked_at = null,
    session_id = excluded.session_id,
    platform = excluded.platform,
    push_token_ciphertext = excluded.push_token_ciphertext,
    push_token_type = excluded.push_token_type,
    push_project_id = excluded.push_project_id,
    push_environment = excluded.push_environment,
    app_version = excluded.app_version,
    locale = excluded.locale
  returning id into v_device_id;
  if v_device_id is null then
    raise exception 'device registration failed' using errcode = '42501';
  end if;
  v_response := jsonb_build_object(
    'device_id', v_device_id,
    'installation_id', p_installation_id,
    'platform', p_platform,
    'push_token_type', p_push_token_type,
    'push_project_id', p_push_project_id,
    'push_environment', p_push_environment,
    'registered', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/devices',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$
;
