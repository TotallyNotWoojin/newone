-- Sending a batch of photos hit the app's own limits: the photo picker takes
-- 20 at a time, each photo is its own message, and the 11th message inside
-- 10 seconds or the 11th upload inside a minute was refused (owner, Sep 23
-- 2026: "you can up rate limiting"). Raised, with the hourly caps unchanged
-- (1000 messages, 250 MB of uploads):
--   message burst        10 -> 40 per 10 s     (send_message_pre_request_cap_code)
--   messages per minute  60 -> 150             (send_message_pre_request_cap_code)
--   BFF message.send     60 -> 150 per minute  (bff_consume_rate_limit_impl)
--   upload grants        10 -> 60 per minute   (bff_create_attachment_upload_pre_dynamic_group_impl,
--                                              and BFF attachment.upload.create)
-- Each function below is the hosted definition (pg_get_functiondef, md5 of
-- the source checked before writing this) with only those numbers changed.
-- create or replace keeps ownership and grants.

CREATE OR REPLACE FUNCTION private.bff_consume_rate_limit_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_operation text, p_ip_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_authorization jsonb;
  v_limit integer;
  v_window_seconds integer;
  v_retry_at timestamptz;
  v_user_allowed boolean;
  v_session_allowed boolean;
  v_network_allowed boolean := true;
  v_allowed boolean;
begin
  perform private.require_service_role();
  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, p_operation, false, 0
  );
  if not coalesce((v_authorization ->> 'allowed')::boolean, false) then
    return jsonb_build_object(
      'allowed', false, 'retry_after_seconds', 0, 'reason', 'unauthorized'
    );
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid IP hash' using errcode = '22023';
  end if;

  select limits.request_limit, limits.window_seconds
    into v_limit, v_window_seconds
  from (values
    ('message.send', 150, 60),
    ('conversation.direct.create', 10, 3600),
    ('conversation.group.create', 5, 86400),
    ('attachment.upload.create', 60, 60),
    ('message.translate', 30, 60),
    ('translation.enqueue', 30, 60),
    ('message.report', 10, 3600),
    ('conversation.report', 10, 3600),
    ('member.report', 10, 3600),
    ('invite.issue', 20, 3600),
    ('member.suspend', 20, 3600)
  ) as limits(operation, request_limit, window_seconds)
  where limits.operation = p_operation;
  v_limit := coalesce(v_limit, 120);
  v_window_seconds := coalesce(v_window_seconds, 60);

  v_user_allowed := private.consume_rate_limit(
    'bff-user:' || left(p_operation, 71),
    p_organization_id::text || ':' || p_actor_user_id::text,
    v_limit, v_window_seconds
  );
  v_session_allowed := private.consume_rate_limit(
    'bff-session:' || left(p_operation, 68),
    p_organization_id::text || ':' || p_actor_user_id::text || ':' || p_session_id::text,
    v_limit, v_window_seconds
  );
  if p_ip_hash is not null then
    v_network_allowed := private.consume_rate_limit(
      'bff-network:' || left(p_operation, 68),
      p_organization_id::text || ':' || p_ip_hash,
      least(v_limit * 10, 10000), v_window_seconds
    );
  end if;
  v_allowed := v_user_allowed and v_session_allowed and v_network_allowed;

  if not v_allowed then
    select max(
      bucket.window_started_at + make_interval(secs => v_window_seconds)
    ) into v_retry_at
    from private.rate_limit_buckets bucket
    where bucket.window_started_at
        > clock_timestamp() - make_interval(secs => v_window_seconds)
      and (
        (
          bucket.scope = 'bff-user:' || left(p_operation, 71)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_actor_user_id::text, 'sha256'
          )
          and bucket.request_count > v_limit
        )
        or (
          bucket.scope = 'bff-session:' || left(p_operation, 68)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_actor_user_id::text || ':'
              || p_session_id::text,
            'sha256'
          )
          and bucket.request_count > v_limit
        )
        or (
          p_ip_hash is not null
          and bucket.scope = 'bff-network:' || left(p_operation, 68)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_ip_hash, 'sha256'
          )
          and bucket.request_count > least(v_limit * 10, 10000)
        )
      );
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'retry_after_seconds', case when v_allowed then 0 else greatest(1, ceil(
      extract(epoch from (
        coalesce(v_retry_at, clock_timestamp() + make_interval(secs => v_window_seconds))
        - clock_timestamp()
      ))
    )::integer) end,
    'user_bucket_allowed', v_user_allowed,
    'session_bucket_allowed', v_session_allowed,
    'network_bucket_allowed', v_network_allowed
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.send_message_pre_request_cap_code(p_organization_id uuid, p_conversation_id uuid, p_client_nonce uuid, p_kind text DEFAULT 'text'::text, p_body text DEFAULT NULL::text, p_language_code text DEFAULT NULL::text, p_reply_to_message_id bigint DEFAULT NULL::bigint, p_thread_root_message_id bigint DEFAULT NULL::bigint, p_metadata jsonb DEFAULT '{}'::jsonb, p_available_at timestamp with time zone DEFAULT now())
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid := (select auth.uid());
  v_message_id bigint;
  v_rate_key text;
  v_expected_thread_root bigint;
begin
  if v_user_id is null
    or not (select private.can_post_to_conversation(p_organization_id, p_conversation_id)) then
    raise exception 'active conversation membership with posting access is required' using errcode = '42501';
  end if;
  if p_kind not in ('text', 'attachment') then
    raise exception 'client message kind is not permitted' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(coalesce(p_metadata, '{}'::jsonb)) metadata_key
      where metadata_key <> 'mentionUserIds'
    ) then
    raise exception 'client message metadata only permits mentionUserIds' using errcode = '22023';
  end if;
  if p_reply_to_message_id is not null then
    select coalesce(message.thread_root_message_id, message.id)
      into v_expected_thread_root
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_reply_to_message_id
      and message.deleted_at is null;
    if not found then
      raise exception 'reply source is not readable in the target conversation' using errcode = '22023';
    end if;
    if p_thread_root_message_id is not null
      and p_thread_root_message_id <> v_expected_thread_root then
      raise exception 'thread root does not match reply source' using errcode = '22023';
    end if;
  end if;
  if p_thread_root_message_id is not null and not exists (
    select 1 from public.messages root_message
    where root_message.organization_id = p_organization_id
      and root_message.conversation_id = p_conversation_id
      and root_message.id = p_thread_root_message_id
      and root_message.deleted_at is null
  ) then
    raise exception 'thread root is not readable in the target conversation' using errcode = '22023';
  end if;
  if p_metadata ? 'mentionUserIds' then
    if jsonb_typeof(p_metadata -> 'mentionUserIds') <> 'array'
      or jsonb_array_length(p_metadata -> 'mentionUserIds') > 50
      or exists (
        select 1
        from jsonb_array_elements_text(p_metadata -> 'mentionUserIds') mentioned(value)
        where mentioned.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or not exists (
            select 1 from public.conversation_members member
            join public.organization_memberships organization_member
              on organization_member.organization_id = member.organization_id
             and organization_member.user_id = member.user_id
             and organization_member.status = 'active'
            where member.organization_id = p_organization_id
              and member.conversation_id = p_conversation_id
              and member.user_id = mentioned.value::uuid
              and member.status = 'active'
          )
      ) then
      raise exception 'mentions must reference active conversation members' using errcode = '22023';
    end if;
  end if;

  select message.id into v_message_id
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.sender_user_id = v_user_id
    and message.client_nonce = p_client_nonce;
  if v_message_id is not null then
    return v_message_id;
  end if;

  v_rate_key := p_organization_id::text || ':' || v_user_id::text;
  if not (select private.consume_rate_limit('message-burst-10s', v_rate_key, 40, 10))
    or not (select private.consume_rate_limit('message-minute', v_rate_key, 150, 60))
    or not (select private.consume_rate_limit('message-hour', v_rate_key, 1000, 3600)) then
    raise exception 'message rate limit exceeded' using errcode = 'P0001';
  end if;

  insert into public.messages (
    organization_id,
    conversation_id,
    sender_user_id,
    client_nonce,
    kind,
    body,
    language_code,
    language_detection_state,
    language_detected_at,
    reply_to_message_id,
    thread_root_message_id,
    metadata,
    available_at
  ) values (
    p_organization_id,
    p_conversation_id,
    v_user_id,
    p_client_nonce,
    p_kind,
    p_body,
    p_language_code,
    case when p_body is null then 'not_applicable' else 'pending' end,
    case when p_body is null then now() else null end,
    p_reply_to_message_id,
    p_thread_root_message_id,
    -- Mentions are normalized below; arbitrary client JSON never persists on
    -- the message row. Server provenance lives in dedicated version/forward
    -- tables rather than sharing this untrusted bag.
    '{}'::jsonb,
    p_available_at
  )
  on conflict (organization_id, conversation_id, sender_user_id, client_nonce)
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select message.id into v_message_id
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.sender_user_id = v_user_id
      and message.client_nonce = p_client_nonce;
  end if;

  if p_metadata ? 'mentionUserIds' then
    insert into public.message_mentions (
      organization_id, conversation_id, message_id, mentioned_user_id
    )
    select p_organization_id, p_conversation_id, v_message_id, mentioned.value::uuid
    from (
      select distinct value
      from jsonb_array_elements_text(p_metadata -> 'mentionUserIds') mention(value)
    ) mentioned
    on conflict do nothing;
  end if;

  return v_message_id;
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_create_attachment_upload_pre_dynamic_group_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_message_id bigint, p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256_hex text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_attachment_id uuid := gen_random_uuid();
  v_storage_path text;
  v_hour_bytes bigint;
  v_rate_key text;
  v_max_bytes bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.upload.create', false, 0, '/v2/attachments/grants',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_message_sender(p_organization_id, p_conversation_id, p_message_id) then
    raise exception 'attachment message sender permission required' using errcode = '42501';
  end if;
  if p_mime_type not in (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/ogg',
    'video/mp4', 'video/quicktime'
  ) then
    raise exception 'attachment MIME type is not permitted' using errcode = '22023';
  end if;
  v_max_bytes := case
    when p_mime_type in ('video/mp4', 'video/quicktime') then 104857600
    else 26214400
  end;
  if p_byte_size not between 1 and v_max_bytes
    or coalesce(p_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid attachment size or digest' using errcode = '22023';
  end if;
  v_rate_key := p_organization_id::text || ':' || p_actor_user_id::text;
  if not private.consume_rate_limit('upload-minute', v_rate_key, 60, 60) then
    raise exception 'attachment upload rate limit exceeded' using errcode = 'P0001';
  end if;
  select coalesce(sum(attachment.byte_size), 0) into v_hour_bytes
  from public.message_attachments attachment
  where attachment.organization_id = p_organization_id
    and attachment.created_by_user_id = p_actor_user_id
    and attachment.created_at >= now() - interval '1 hour';
  if v_hour_bytes + p_byte_size > 262144000 then
    raise exception 'attachment hourly byte quota exceeded' using errcode = 'P0001';
  end if;

  v_storage_path := p_organization_id::text || '/' || p_conversation_id::text || '/'
    || p_actor_user_id::text || '/' || v_attachment_id::text || '/upload';
  insert into public.message_attachments (
    id, organization_id, conversation_id, message_id, created_by_user_id,
    storage_path, file_name, mime_type, byte_size, sha256_hex
  ) values (
    v_attachment_id, p_organization_id, p_conversation_id, p_message_id,
    p_actor_user_id, v_storage_path, p_file_name, p_mime_type, p_byte_size,
    p_sha256_hex
  );
  v_response := jsonb_build_object(
    'attachment_id', v_attachment_id,
    'bucket_id', 'message-attachments',
    'storage_path', v_storage_path,
    'scan_status', 'pending'
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/attachments/grants',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$function$;
