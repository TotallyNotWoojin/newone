-- Follow-up to 20260908140000, found by tests/hosted/archive-smoke.mjs before
-- it shipped: the wrapper looked the conversation up by 'id', and the
-- bootstrap names that key 'conversation_id'. Every chat therefore came back
-- as not archived however it had been set, so the archive row on Chats would
-- have stayed empty and archiving would have looked like it did nothing.

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
            and preference.conversation_id = coalesce(
              nullif(entry.value ->> 'conversation_id', ''),
              nullif(entry.value ->> 'id', '')
            )::uuid
        ), false)),
        true
      ) order by entry.ordinality), '[]'::jsonb)
    into v_conversations
  from jsonb_array_elements(v_result -> 'conversations')
    with ordinality entry(value, ordinality);

  return jsonb_set(v_result, '{conversations}', v_conversations, true);
end;
$function$;
