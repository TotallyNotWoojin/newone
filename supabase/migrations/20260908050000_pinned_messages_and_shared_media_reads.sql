-- Pinning has worked since v2 but nothing ever read the pins back, and every
-- attachment a chat has ever carried was reachable only by scrolling to the
-- message that carried it. Two bounded reads fix both: one lists the pins of a
-- chat (or of every chat the reader is in), the other pages a chat's
-- attachments newest first. Both are read-only and reuse the visibility rules
-- the timeline already applies: active membership, the history window, hidden
-- messages, deleted messages, blocked senders, and dynamic-group access.

create or replace function private.bff_read_pinned_messages_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_pins jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'pins.read', false, 0
  );
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid pinned message bound' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(entry.payload order by entry.pinned_at desc, entry.message_id desc), '[]'::jsonb)
    into v_pins
  from (
    select
      pin.pinned_at,
      message.id as message_id,
      jsonb_build_object(
        'conversation_id', pin.conversation_id,
        'message_id', message.id::text,
        'sender_user_id', message.sender_user_id,
        'sender_display_name', sender.display_name,
        'body', left(coalesce(message.body, ''), 240),
        'attachment_kind', attachment.kind,
        'sent_at', message.created_at,
        'pinned_at', pin.pinned_at,
        'can_unpin', (
          p_organization_id = private.personal_realm_organization_id()
          or member.role in ('owner', 'admin')
        )
      ) as payload
    from public.message_pins pin
    join public.messages message
      on message.organization_id = pin.organization_id
     and message.conversation_id = pin.conversation_id
     and message.id = pin.message_id
    join public.conversation_members member
      on member.organization_id = pin.organization_id
     and member.conversation_id = pin.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.profiles sender on sender.user_id = message.sender_user_id
    left join lateral (
      select case
        when file.mime_type like 'image/%' then 'image'
        when file.mime_type like 'video/%' then 'video'
        when file.mime_type like 'audio/%' then 'voice'
        else 'file'
      end as kind
      from public.message_attachments file
      where file.organization_id = message.organization_id
        and file.conversation_id = message.conversation_id
        and file.message_id = message.id
      order by file.created_at, file.id
      limit 1
    ) attachment on true
    where pin.organization_id = p_organization_id
      and (p_conversation_id is null or pin.conversation_id = p_conversation_id)
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility hidden
        where hidden.organization_id = message.organization_id
          and hidden.conversation_id = message.conversation_id
          and hidden.message_id = message.id
          and hidden.user_id = p_actor_user_id
      )
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = message.sender_user_id
      )
      and private.dynamic_group_conversation_access_allowed_for_user(
        p_organization_id, pin.conversation_id, p_actor_user_id, now()
      )
      and private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, pin.conversation_id, message.id, p_actor_user_id, now()
      )
    order by pin.pinned_at desc, message.id desc
    limit p_limit
  ) entry;

  return jsonb_build_object(
    'schema_version', 1,
    'conversation_id', p_conversation_id,
    'pins', v_pins
  );
end;
$function$;

revoke execute on function private.bff_read_pinned_messages_impl(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function private.bff_read_pinned_messages_impl(
  uuid, uuid, uuid, uuid, integer
) to service_role;

create or replace function public.bff_read_pinned_messages(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language sql
set search_path = ''
as $function$ select private.bff_read_pinned_messages_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id, p_limit
) $function$;

-- The grid pages on (created_at, id) descending, so a page never repeats or
-- skips a file when someone sends another one while the sheet is open. The
-- bucket and path leave the database only so the gateway can sign a preview;
-- it strips both before answering the device.
create or replace function private.bff_read_conversation_media_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_before_created_at timestamptz default null,
  p_before_attachment_id uuid default null,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_rows jsonb;
  v_count integer;
  v_items jsonb;
  v_last jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'media.read', false, 0
  );
  if p_limit is null or p_limit not between 1 and 60
    or (p_before_created_at is null) <> (p_before_attachment_id is null) then
    raise exception 'invalid shared media bound' using errcode = '22023';
  end if;
  if not private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, p_conversation_id, p_actor_user_id, now()
  ) then
    raise exception 'shared media unavailable' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(entry.payload order by entry.created_at desc, entry.attachment_id desc), '[]'::jsonb)
    into v_rows
  from (
    select
      file.created_at,
      file.id as attachment_id,
      jsonb_build_object(
        'attachment_id', file.id,
        'message_id', message.id::text,
        'file_name', file.file_name,
        'mime_type', file.mime_type,
        'byte_size', file.byte_size,
        'created_at', file.created_at,
        'sender_user_id', message.sender_user_id,
        'sender_display_name', sender.display_name,
        'kind', case
          when file.mime_type like 'image/%' then 'image'
          when file.mime_type like 'video/%' then 'video'
          when file.mime_type like 'audio/%' then 'voice'
          else 'file'
        end,
        'bucket_id', file.bucket_id,
        'storage_path', file.storage_path
      ) as payload
    from public.message_attachments file
    join public.messages message
      on message.organization_id = file.organization_id
     and message.conversation_id = file.conversation_id
     and message.id = file.message_id
    join public.conversation_members member
      on member.organization_id = file.organization_id
     and member.conversation_id = file.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.profiles sender on sender.user_id = message.sender_user_id
    where file.organization_id = p_organization_id
      and file.conversation_id = p_conversation_id
      and file.scan_status = 'clean'
      and file.purge_requested_at is null
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility hidden
        where hidden.organization_id = message.organization_id
          and hidden.conversation_id = message.conversation_id
          and hidden.message_id = message.id
          and hidden.user_id = p_actor_user_id
      )
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = message.sender_user_id
      )
      and private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, file.conversation_id, message.id, p_actor_user_id, now()
      )
      and (
        p_before_created_at is null
        or (file.created_at, file.id) < (p_before_created_at, p_before_attachment_id)
      )
    order by file.created_at desc, file.id desc
    limit p_limit + 1
  ) entry;

  v_count := jsonb_array_length(v_rows);
  if v_count > p_limit then
    v_items := (
      select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
      from jsonb_array_elements(v_rows) with ordinality item(value, ordinality)
      where item.ordinality <= p_limit
    );
  else
    v_items := v_rows;
  end if;
  v_last := case when jsonb_array_length(v_items) = 0
    then null
    else v_items -> (jsonb_array_length(v_items) - 1) end;

  return jsonb_build_object(
    'schema_version', 1,
    'conversation_id', p_conversation_id,
    'items', v_items,
    'has_more', v_count > p_limit,
    'next_before_created_at', case when v_count > p_limit
      then v_last -> 'created_at' else 'null'::jsonb end,
    'next_before_attachment_id', case when v_count > p_limit
      then v_last -> 'attachment_id' else 'null'::jsonb end
  );
end;
$function$;

revoke execute on function private.bff_read_conversation_media_impl(
  uuid, uuid, uuid, uuid, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function private.bff_read_conversation_media_impl(
  uuid, uuid, uuid, uuid, timestamptz, uuid, integer
) to service_role;

create or replace function public.bff_read_conversation_media(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_before_created_at timestamptz default null,
  p_before_attachment_id uuid default null,
  p_limit integer default 30
)
returns jsonb
language sql
set search_path = ''
as $function$ select private.bff_read_conversation_media_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_before_created_at, p_before_attachment_id, p_limit
) $function$;

-- The pin list reads by pinned_at inside a chat, and by pinned_at across every
-- chat a reader belongs to; neither order had an index.
create index if not exists message_pins_organization_pinned_at_idx
  on public.message_pins (organization_id, pinned_at desc, message_id desc);
create index if not exists message_pins_conversation_pinned_at_idx
  on public.message_pins (organization_id, conversation_id, pinned_at desc, message_id desc);
create index if not exists message_attachments_conversation_created_at_idx
  on public.message_attachments (organization_id, conversation_id, created_at desc, id desc);
