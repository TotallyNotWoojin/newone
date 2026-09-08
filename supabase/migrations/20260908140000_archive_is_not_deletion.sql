-- Archiving a chat hid it from this device altogether (owner, Sep 8 2026):
-- "isArchived" was written to conversation_preferences.is_hidden, the flag the
-- bootstrap uses to drop a conversation from the snapshot, which is also what
-- "delete for me" sets. So an archived chat did not move somewhere quieter, it
-- vanished, with no archive to open and no way back -- and opening that person
-- again landed on an empty pane with nothing on it, because the conversation
-- the route named was no longer in the snapshot.
--
-- Archive becomes its own per-user flag. is_hidden keeps its one meaning,
-- "this person deleted this chat for themselves", and creating or reopening a
-- direct chat clears it, because asking to open a chat is the opposite of
-- having deleted it.

alter table public.conversation_preferences
  add column if not exists is_archived boolean not null default false;

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
        'is_favorite', 'is_pinned', 'is_hidden', 'is_archived', 'notification_level',
        'muted_until', 'translation_mode'
      )
    )
    or exists (
      select 1 from (values ('is_favorite'), ('is_pinned'), ('is_hidden'), ('is_archived')) boolean_key(name)
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
    is_hidden, is_archived, notification_level, muted_until, translation_mode
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id,
    case when p_patch ? 'is_favorite' then (p_patch ->> 'is_favorite')::boolean else false end,
    case when p_patch ? 'is_pinned' then (p_patch ->> 'is_pinned')::boolean else false end,
    case when p_patch ? 'is_hidden' then (p_patch ->> 'is_hidden')::boolean else false end,
    case when p_patch ? 'is_archived' then (p_patch ->> 'is_archived')::boolean else false end,
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

-- Opening a chat with somebody undoes having deleted it. The impl is
-- idempotent and returns the existing conversation, so this is the moment the
-- hidden flag has to go: without it the app navigated to a conversation the
-- next bootstrap would not return, and the screen had nothing on it.
create or replace function private.bff_create_direct_conversation_v2_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_other_user_id uuid, p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_conversation_id uuid;
begin
  perform private.require_service_role();
  v_result := private.bff_create_direct_conversation_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_other_user_id,
    p_idempotency_key, p_request_sha256
  );
  v_conversation_id := nullif(v_result ->> 'conversation_id', '')::uuid;
  if v_conversation_id is not null then
    update public.conversation_preferences preference
    set is_hidden = false, updated_at = now()
    where preference.organization_id = p_organization_id
      and preference.conversation_id = v_conversation_id
      and preference.user_id = p_actor_user_id
      and preference.is_hidden;
  end if;
  return v_result;
end;
$function$;

revoke all on function private.bff_create_direct_conversation_v2_impl(uuid, uuid, uuid, uuid, text, text) from public;
grant execute on function private.bff_create_direct_conversation_v2_impl(uuid, uuid, uuid, uuid, text, text) to service_role;

create or replace function public.bff_create_direct_conversation(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_other_user_id uuid, p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language sql
set search_path = ''
as $function$
  select private.bff_create_direct_conversation_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_other_user_id,
    p_idempotency_key, p_request_sha256
  )
$function$;

-- The snapshot has to say which chats are archived, so the list can gather
-- them behind one row instead of showing them among everything else.
create or replace function private.bff_bootstrap_messaging_state_v15_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_selected_conversation_id uuid, p_before_message_id bigint,
  p_conversation_limit integer, p_timeline_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
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

  select coalesce(jsonb_agg(
      jsonb_set(
        entry.value,
        '{preferences,is_archived}',
        to_jsonb(coalesce((
          select preference.is_archived
          from public.conversation_preferences preference
          where preference.organization_id = p_organization_id
            and preference.user_id = p_actor_user_id
            and preference.conversation_id
              = nullif(entry.value ->> 'id', '')::uuid
        ), false)),
        true
      ) order by entry.ordinality), '[]'::jsonb)
    into v_conversations
  from jsonb_array_elements(v_result -> 'conversations')
    with ordinality entry(value, ordinality);

  return jsonb_set(v_result, '{conversations}', v_conversations, true);
end;
$function$;

revoke all on function private.bff_bootstrap_messaging_state_v15_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer) from public;
grant execute on function private.bff_bootstrap_messaging_state_v15_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer) to service_role;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_selected_conversation_id uuid default null::uuid,
  p_before_message_id bigint default null::bigint,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb
language sql
set search_path = ''
as $function$
  select case
    when p_organization_id = private.personal_realm_organization_id()
    then private.bff_bootstrap_messaging_state_v15_impl(
      p_actor_user_id, p_organization_id, p_session_id,
      p_selected_conversation_id, p_before_message_id,
      p_conversation_limit, p_timeline_limit
    )
    else private.bff_bootstrap_messaging_state_v9_impl(
      p_actor_user_id, p_organization_id, p_session_id,
      p_selected_conversation_id, p_before_message_id,
      p_conversation_limit, p_timeline_limit
    )
  end
$function$;
