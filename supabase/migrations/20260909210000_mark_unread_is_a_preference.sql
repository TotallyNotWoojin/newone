-- Marking a chat unread lived only in the screen's own state, so it did not
-- survive a relaunch and never reached the reader's other devices. It is a
-- per-reader preference like pinning and archiving, and belongs beside them.
--
-- Stored as a time rather than a flag so the bootstrap can tell a mark that is
-- still standing from one the reader has since overtaken by opening the chat:
-- reading clears it, and a mark made before the newest message is not a claim
-- about messages that arrived afterwards.

alter table public.conversation_preferences
  add column if not exists manually_unread_at timestamptz;

CREATE OR REPLACE FUNCTION private.bff_update_conversation_preferences_pre_translation_backfill_im(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_patch jsonb, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_preference public.conversation_preferences%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.preferences.update', false, 0,
    '/v2/conversations/:id/preferences', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id) then
    raise exception 'conversation membership required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb
    or exists (
      select 1 from jsonb_object_keys(p_patch) key
      where key not in (
        'is_favorite', 'is_pinned', 'is_hidden', 'is_archived', 'manually_unread', 'notification_level',
        'muted_until', 'translation_mode'
      )
    )
    or exists (
      select 1 from (values ('is_favorite'), ('is_pinned'), ('is_hidden'), ('is_archived'), ('manually_unread')) boolean_key(name)
      where p_patch ? boolean_key.name
        and jsonb_typeof(p_patch -> boolean_key.name) <> 'boolean'
    )
    or (
      p_patch ? 'notification_level'
      and p_patch ->> 'notification_level' not in ('all', 'mentions', 'none')
    )
    or (
      p_patch ? 'translation_mode'
      and p_patch ->> 'translation_mode' not in ('automatic', 'off')
    ) then
    raise exception 'invalid conversation preference patch' using errcode = '22023';
  end if;

  insert into public.conversation_preferences (
    organization_id, conversation_id, user_id, is_favorite, is_pinned,
    is_hidden, is_archived, manually_unread_at, notification_level, muted_until, translation_mode
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id,
    case when p_patch ? 'is_favorite' then (p_patch ->> 'is_favorite')::boolean else false end,
    case when p_patch ? 'is_pinned' then (p_patch ->> 'is_pinned')::boolean else false end,
    case when p_patch ? 'is_hidden' then (p_patch ->> 'is_hidden')::boolean else false end,
    case when p_patch ? 'is_archived' then (p_patch ->> 'is_archived')::boolean else false end,
    case when (p_patch ->> 'manually_unread')::boolean then now() else null end,
    case when p_patch ? 'notification_level' then p_patch ->> 'notification_level' else 'all' end,
    case when p_patch ? 'muted_until' and p_patch -> 'muted_until' <> 'null'::jsonb
      then (p_patch ->> 'muted_until')::timestamptz else null end,
    case when p_patch ? 'translation_mode' then p_patch ->> 'translation_mode' else 'automatic' end
  )
  on conflict (organization_id, conversation_id, user_id) do update
  set is_favorite = case when p_patch ? 'is_favorite'
        then (p_patch ->> 'is_favorite')::boolean else public.conversation_preferences.is_favorite end,
      is_pinned = case when p_patch ? 'is_pinned'
        then (p_patch ->> 'is_pinned')::boolean else public.conversation_preferences.is_pinned end,
      is_hidden = case when p_patch ? 'is_hidden'
        then (p_patch ->> 'is_hidden')::boolean else public.conversation_preferences.is_hidden end,
      is_archived = case when p_patch ? 'is_archived'
        then (p_patch ->> 'is_archived')::boolean else public.conversation_preferences.is_archived end,
      manually_unread_at = case
        when not (p_patch ? 'manually_unread') then public.conversation_preferences.manually_unread_at
        when (p_patch ->> 'manually_unread')::boolean then now()
        else null end,
      notification_level = case when p_patch ? 'notification_level'
        then p_patch ->> 'notification_level' else public.conversation_preferences.notification_level end,
      muted_until = case when p_patch ? 'muted_until'
        then case when p_patch -> 'muted_until' = 'null'::jsonb then null
          else (p_patch ->> 'muted_until')::timestamptz end
        else public.conversation_preferences.muted_until end,
      translation_mode = case when p_patch ? 'translation_mode'
        then p_patch ->> 'translation_mode' else public.conversation_preferences.translation_mode end,
      updated_at = now()
  returning * into v_preference;
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'is_favorite', v_preference.is_favorite,
    'is_pinned', v_preference.is_pinned,
    'is_hidden', v_preference.is_hidden,
    'is_archived', v_preference.is_archived,
    'manually_unread', v_preference.manually_unread_at is not null,
    'notification_level', v_preference.notification_level,
    'muted_until', v_preference.muted_until,
    'translation_mode', v_preference.translation_mode,
    'updated_at', v_preference.updated_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/preferences',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v15_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_conversations jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v14_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if jsonb_typeof(v_result -> 'conversations') <> 'array' then
    return v_result;
  end if;

  -- Both are this reader's own choices about their own list, read from the
  -- same row. manually_unread stands only until they overtake it: a mark made
  -- before the newest message says nothing about the messages that arrived
  -- after it, and opening the chat clears it outright.
  select coalesce(jsonb_agg(
      jsonb_set(
        jsonb_set(
          entry.value,
          '{preferences,is_archived}',
          to_jsonb(coalesce(preference.is_archived, false)),
          true
        ),
        '{preferences,manually_unread}',
        to_jsonb(
          preference.manually_unread_at is not null
          and (
            entry.value -> 'preview' ->> 'created_at' is null
            or preference.manually_unread_at
              >= (entry.value -> 'preview' ->> 'created_at')::timestamptz
          )
        ),
        true
      ) order by entry.ordinality), '[]'::jsonb)
    into v_conversations
  from jsonb_array_elements(v_result -> 'conversations')
    with ordinality entry(value, ordinality)
  left join public.conversation_preferences preference
    on preference.organization_id = p_organization_id
   and preference.user_id = p_actor_user_id
   and preference.conversation_id = coalesce(
     nullif(entry.value ->> 'conversation_id', ''),
     nullif(entry.value ->> 'id', '')
   )::uuid;

  return jsonb_set(v_result, '{conversations}', v_conversations, true);
end;
$function$
;

CREATE OR REPLACE FUNCTION private.bff_mark_message_receipt_pre_dynamic_group_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_message_id bigint, p_state text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_receipt public.message_receipts%rowtype;
  v_target_created_at timestamptz;
  v_previous_read_message_id bigint;
  v_previous_read_created_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.receipt.mark', false, 0, '/v2/messages/:id/receipt',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_state not in ('delivered', 'read') then
    raise exception 'invalid receipt state' using errcode = '22023';
  end if;
  select message.created_at into v_target_created_at
  from public.messages message
  join public.conversation_members member
    on member.organization_id = message.organization_id
   and member.conversation_id = message.conversation_id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
    and message.sender_user_id <> p_actor_user_id
    and message.deleted_at is null
    and message.available_at <= now()
    and (member.history_visible_from is null
      or message.created_at >= member.history_visible_from)
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = message.organization_id
        and visibility.conversation_id = message.conversation_id
        and visibility.message_id = message.id
        and visibility.user_id = p_actor_user_id
    );
  if not found then
    raise exception 'readable message not found' using errcode = '42501';
  end if;

  if p_state = 'read' then
    -- Serialize against the existing cursor when present. A read transition
    -- covers every still-readable incoming message after that boundary through
    -- the target, so earlier sender aggregates cannot remain stale merely
    -- because the client acknowledged only the visible range endpoint.
    select cursor.last_read_message_id, previous_message.created_at
      into v_previous_read_message_id, v_previous_read_created_at
    from public.conversation_read_cursors cursor
    join public.messages previous_message
      on previous_message.organization_id = cursor.organization_id
     and previous_message.conversation_id = cursor.conversation_id
     and previous_message.id = cursor.last_read_message_id
    where cursor.organization_id = p_organization_id
      and cursor.conversation_id = p_conversation_id
      and cursor.user_id = p_actor_user_id
    for update of cursor;

    insert into public.message_receipts (
      organization_id, conversation_id, message_id, user_id,
      delivered_at, read_at
    )
    select p_organization_id, p_conversation_id, message.id, p_actor_user_id,
      now(), now()
    from public.messages message
    join public.conversation_members member
      on member.organization_id = message.organization_id
     and member.conversation_id = message.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.sender_user_id <> p_actor_user_id
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and (
        v_previous_read_message_id is null
        or (message.created_at, message.id)
          > (v_previous_read_created_at, v_previous_read_message_id)
      )
      and (message.created_at, message.id)
        <= (v_target_created_at, p_message_id)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
    on conflict (organization_id, conversation_id, message_id, user_id) do update
    set delivered_at = coalesce(
          public.message_receipts.delivered_at, excluded.delivered_at
        ),
        read_at = coalesce(public.message_receipts.read_at, excluded.read_at),
        updated_at = now();

    insert into public.conversation_read_cursors (
      organization_id, conversation_id, user_id, last_read_message_id
    ) values (
      p_organization_id, p_conversation_id, p_actor_user_id, p_message_id
    )
    on conflict (organization_id, conversation_id, user_id) do update
    set last_read_message_id = greatest(
          public.conversation_read_cursors.last_read_message_id,
          excluded.last_read_message_id
        ),
        last_read_at = now()
    where public.conversation_read_cursors.last_read_message_id is null
      or excluded.last_read_message_id
        > public.conversation_read_cursors.last_read_message_id;

    -- Reading the chat is what takes back "mark as unread". Left standing it
    -- would keep announcing an unread chat the reader is looking at.
    update public.conversation_preferences preference
    set manually_unread_at = null, updated_at = now()
    where preference.organization_id = p_organization_id
      and preference.conversation_id = p_conversation_id
      and preference.user_id = p_actor_user_id
      and preference.manually_unread_at is not null;
  else
    -- Delivered is intentionally target-only: clients emit it for each loaded
    -- message, while read acknowledges a contiguous visible range.
    insert into public.message_receipts (
      organization_id, conversation_id, message_id, user_id,
      delivered_at, read_at
    ) values (
      p_organization_id, p_conversation_id, p_message_id, p_actor_user_id,
      now(), null
    )
    on conflict (organization_id, conversation_id, message_id, user_id) do update
    set delivered_at = coalesce(
          public.message_receipts.delivered_at, excluded.delivered_at
        ),
        updated_at = now();
  end if;

  select receipt.* into v_receipt
  from public.message_receipts receipt
  where receipt.organization_id = p_organization_id
    and receipt.conversation_id = p_conversation_id
    and receipt.message_id = p_message_id
    and receipt.user_id = p_actor_user_id;

  perform private.broadcast_receipt_invalidation_internal(
    p_organization_id, p_conversation_id, p_message_id
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'message_id', p_message_id,
    'scope', 'self',
    'delivered_at', v_receipt.delivered_at,
    'read_at', v_receipt.read_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/receipt',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$
;
