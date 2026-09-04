-- Version-conflict preconditions raised SQLSTATE 40001 (serialization_failure).
-- The hosted request path re-executes a 40001 command until the client gives
-- up (profile-avatar smoke: a stale expectedAvatarPath DELETE ran the RPC on
-- several pool connections for 60 s and never answered), so a permanent
-- precondition failure now uses the custom code NO409, which the API maps to
-- 409 conflict without any retry. Same change for the conversation avatar
-- functions that used the same pattern.

CREATE OR REPLACE FUNCTION private.bff_activate_conversation_avatar_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_attachment_id uuid, p_expected_avatar_path text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_conversation public.conversations%rowtype;
  v_attachment public.message_attachments%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.avatar.activate', false, 0,
    '/v2/conversations/:id/avatar/:attachmentId/activate',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'group administrator permission required' using errcode = '42501';
  end if;
  select conversation.* into v_conversation
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift', 'incident')
    and not conversation.is_archived
    and conversation.closed_at is null
  for update;
  if not found then
    raise exception 'active group conversation required' using errcode = '42501';
  end if;
  if v_conversation.avatar_path is distinct from p_expected_avatar_path then
    raise exception 'conversation avatar version conflict' using errcode = 'NO409';
  end if;
  select attachment.* into v_attachment
  from public.message_attachments attachment
  join public.messages message
    on message.organization_id = attachment.organization_id
   and message.conversation_id = attachment.conversation_id
   and message.id = attachment.message_id
  where attachment.organization_id = p_organization_id
    and attachment.conversation_id = p_conversation_id
    and attachment.id = p_attachment_id
    and attachment.created_by_user_id = p_actor_user_id
    and attachment.scan_status = 'clean'
    and attachment.mime_type in ('image/jpeg', 'image/png', 'image/webp')
    and attachment.detected_mime_type = attachment.mime_type
    and message.deleted_at is null
    and message.metadata = jsonb_build_object('purpose', 'conversation_avatar')
  for update of attachment;
  if not found then
    raise exception 'clean actor-owned conversation avatar upload required'
      using errcode = '42501';
  end if;
  perform set_config('app.conversation_avatar_context', 'on', true);
  update public.conversations conversation
  set avatar_path = v_attachment.storage_path
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  perform set_config('app.conversation_avatar_context', 'off', true);
  perform private.insert_conversation_system_event_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    'conversation.avatar.changed', null
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.avatar.changed',
    'conversation', p_conversation_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'attachment_id', p_attachment_id,
      'previous_avatar_path', v_conversation.avatar_path,
      'avatar_path', v_attachment.storage_path
    ))
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'attachment_id', p_attachment_id,
    'avatar_path', v_attachment.storage_path,
    'previous_avatar_path', v_conversation.avatar_path,
    'activated', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversations/:id/avatar/:attachmentId/activate',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.bff_remove_conversation_avatar_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_expected_avatar_path text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_current_avatar_path text;
  v_is_archived boolean;
  v_closed_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.avatar.remove', false, 0,
    '/v2/conversations/:id/avatar', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'group administrator permission required' using errcode = '42501';
  end if;
  select conversation.avatar_path, conversation.is_archived,
      conversation.closed_at
    into v_current_avatar_path, v_is_archived, v_closed_at
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift', 'incident')
  for update;
  if not found then raise exception 'group conversation not found' using errcode = 'P0002'; end if;
  if v_current_avatar_path is distinct from p_expected_avatar_path
    or v_current_avatar_path is null then
    raise exception 'conversation avatar version conflict' using errcode = 'NO409';
  end if;
  -- Removal remains available after archive/closure as a deliberate
  -- data-minimization escape hatch. It is still admin-only, CAS-bound, visible
  -- to the conversation, and the audit row below records that lifecycle override.
  perform set_config('app.conversation_avatar_context', 'on', true);
  update public.conversations conversation set avatar_path = null
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  perform set_config('app.conversation_avatar_context', 'off', true);
  perform private.insert_conversation_system_event_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    'conversation.avatar.removed', null
  );
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.avatar.removed',
    'conversation', p_conversation_id::text,
    jsonb_build_object(
      'previous_avatar_path', v_current_avatar_path,
      'reason', 'data_minimization',
      'lifecycle_override', v_is_archived or v_closed_at is not null
    )
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'previous_avatar_path', v_current_avatar_path,
    'avatar_path', null,
    'removed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/avatar',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.bff_activate_profile_avatar_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_upload_id uuid, p_expected_avatar_path text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_upload public.profile_avatar_uploads%rowtype;
  v_profile public.profiles%rowtype;
  v_object_size bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'profile.avatar.activate', false, 0, '/v2/profile/avatar/:uploadId/activate',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select profile.* into v_profile from public.profiles profile where profile.user_id = p_actor_user_id for update;
  if not found then
    raise exception 'profile required' using errcode = '42501';
  end if;
  if v_profile.avatar_path is distinct from p_expected_avatar_path then
    raise exception 'profile avatar version conflict' using errcode = 'NO409';
  end if;
  select upload.* into v_upload
  from public.profile_avatar_uploads upload
  where upload.id = p_upload_id
    and upload.organization_id = p_organization_id
    and upload.user_id = p_actor_user_id
    and upload.status = 'pending'
  for update;
  if not found then
    raise exception 'pending actor-owned profile avatar upload required' using errcode = '42501';
  end if;
  -- The object must exist in the bucket with the declared size; the storage
  -- service records size and mime type in the object's metadata.
  select nullif(object.metadata ->> 'size', '')::bigint into v_object_size
  from storage.objects object
  where object.bucket_id = 'profile-avatars' and object.name = v_upload.storage_path;
  if v_object_size is null or v_object_size <> v_upload.byte_size then
    raise exception 'profile avatar object not uploaded' using errcode = '42501';
  end if;
  update public.profile_avatar_uploads upload
  set status = 'replaced'
  where upload.organization_id = p_organization_id and upload.user_id = p_actor_user_id
    and upload.status = 'active' and upload.id <> p_upload_id;
  update public.profile_avatar_uploads upload
  set status = 'active', activated_at = now()
  where upload.id = p_upload_id;
  update public.profiles profile
  set avatar_path = v_upload.storage_path
  where profile.user_id = p_actor_user_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'profile.avatar.changed', 'profile', p_actor_user_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'upload_id', p_upload_id,
      'previous_avatar_path', v_profile.avatar_path,
      'avatar_path', v_upload.storage_path
    ))
  );
  v_response := jsonb_build_object(
    'user_id', p_actor_user_id,
    'upload_id', p_upload_id,
    'avatar_path', v_upload.storage_path,
    'previous_avatar_path', v_profile.avatar_path,
    'activated', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/profile/avatar/:uploadId/activate',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.bff_remove_profile_avatar_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_expected_avatar_path text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_profile public.profiles%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'profile.avatar.remove', false, 0, '/v2/profile/avatar',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select profile.* into v_profile from public.profiles profile where profile.user_id = p_actor_user_id for update;
  if not found or v_profile.avatar_path is null then
    raise exception 'profile avatar required' using errcode = '42501';
  end if;
  if v_profile.avatar_path is distinct from p_expected_avatar_path then
    raise exception 'profile avatar version conflict' using errcode = 'NO409';
  end if;
  update public.profile_avatar_uploads upload
  set status = 'removed'
  where upload.user_id = p_actor_user_id and upload.status = 'active';
  update public.profiles profile set avatar_path = null where profile.user_id = p_actor_user_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'profile.avatar.removed', 'profile', p_actor_user_id::text,
    jsonb_build_object('previous_avatar_path', v_profile.avatar_path)
  );
  v_response := jsonb_build_object(
    'user_id', p_actor_user_id,
    'previous_avatar_path', v_profile.avatar_path,
    'avatar_path', null,
    'removed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/profile/avatar',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$
;
