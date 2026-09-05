-- The chats list preview showed the last message in whatever language it was
-- written in. The viewer's message language is known, and a completed, fresh
-- translation usually exists within seconds, so the preview now prefers it.
-- Implemented as a v12 layer over v11 so the deep bootstrap chain is untouched.

create or replace function private.bff_bootstrap_messaging_state_v12_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_selected_conversation_id uuid, p_before_message_id bigint,
  p_conversation_limit integer, p_timeline_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_language text;
  v_conversations jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v11_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if jsonb_typeof(v_result -> 'conversations') <> 'array' then
    return v_result;
  end if;

  select lower(coalesce(preference.message_language, profile.preferred_language, 'en'))
    into v_language
  from public.profiles profile
  left join public.organization_user_preferences preference
    on preference.organization_id = p_organization_id
   and preference.user_id = profile.user_id
  where profile.user_id = p_actor_user_id;

  select coalesce(jsonb_agg(
    case
      when conversation -> 'preview' is null or jsonb_typeof(conversation -> 'preview') <> 'object'
        then conversation
      else jsonb_set(
        conversation, '{preview}',
        (conversation -> 'preview') || coalesce((
          select jsonb_build_object(
            'body', translation.translated_body,
            'original_body', conversation -> 'preview' -> 'body',
            'translated_to', translation.target_language
          )
          from public.messages message
          join public.message_translations translation
            on translation.organization_id = message.organization_id
           and translation.conversation_id = message.conversation_id
           and translation.message_id = message.id
          where message.organization_id = p_organization_id
            and message.id = nullif(conversation -> 'preview' ->> 'message_id', '')::bigint
            and message.body is not null
            and translation.status = 'completed'
            and translation.translated_body is not null
            and lower(translation.target_language) = v_language
            and translation.source_body_sha256 = extensions.digest(convert_to(message.body, 'UTF8'), 'sha256')
          limit 1
        ), '{}'::jsonb),
        true
      )
    end
    order by ordinality
  ), '[]'::jsonb)
  into v_conversations
  from jsonb_array_elements(v_result -> 'conversations') with ordinality as entries(conversation, ordinality);

  return jsonb_set(v_result, '{conversations}', v_conversations, true);
end;
$function$;

grant execute on function private.bff_bootstrap_messaging_state_v12_impl(uuid, uuid, uuid, uuid, bigint, integer, integer) to service_role;

-- Repoint the public entry to the v12 layer.
CREATE OR REPLACE FUNCTION public.bff_bootstrap_messaging_state(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid DEFAULT NULL::uuid, p_before_message_id bigint DEFAULT NULL::bigint, p_conversation_limit integer DEFAULT 100, p_timeline_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select case
    when p_organization_id = private.personal_realm_organization_id()
    then private.bff_bootstrap_messaging_state_v12_impl(
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
$function$
;
