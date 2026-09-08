-- A photo or a file as the newest message left the Chats row saying "No
-- messages yet", because the row preview is the message body and an
-- attachment without a caption has none (owner, Sep 8 2026). The preview now
-- carries the attachment's file name and type, so the row can say Photo, Video
-- or the file's own name.
--
-- A wrapper rather than an edit: the consumer bootstrap is a long function and
-- this is a post-pass over its result, so nothing about how conversations are
-- selected, ordered or authorized moves.

create or replace function private.bff_bootstrap_messaging_state_v14_impl(
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
  v_result := private.bff_bootstrap_messaging_state_v13_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if jsonb_typeof(v_result -> 'conversations') <> 'array' then
    return v_result;
  end if;

  select coalesce(jsonb_agg(
    case
      when entry.value -> 'preview' ->> 'message_id' is null
        or entry.value -> 'preview' ->> 'body' is not null
      then entry.value
      else jsonb_set(
        entry.value,
        '{preview,attachment}',
        coalesce((
          select jsonb_build_object(
            'file_name', attachment.file_name,
            'mime_type', attachment.mime_type
          )
          from public.message_attachments attachment
          where attachment.message_id
            = (entry.value -> 'preview' ->> 'message_id')::bigint
            and attachment.organization_id = p_organization_id
          order by attachment.created_at, attachment.id
          limit 1
        ), 'null'::jsonb),
        true
      )
    end order by entry.ordinality), '[]'::jsonb)
    into v_conversations
  from jsonb_array_elements(v_result -> 'conversations')
    with ordinality entry(value, ordinality);

  return jsonb_set(v_result, '{conversations}', v_conversations, true);
end;
$function$;

revoke all on function private.bff_bootstrap_messaging_state_v14_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer) from public;
grant execute on function private.bff_bootstrap_messaging_state_v14_impl(
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
    then private.bff_bootstrap_messaging_state_v14_impl(
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
