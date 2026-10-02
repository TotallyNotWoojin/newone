-- The bootstrap's summary check, one query instead of one call per cited
-- message (Oct 2 2026).
--
-- bff_bootstrap_messaging_state is most of the database's work: 23,398 s of
-- 26,800 s spent in API calls, 104,699 calls at 223 ms on average. Inside it
-- the v7 layer hid each saved summary unless every message it cites is still
-- there for the reader, asking dynamic_group_message_access_allowed_for_user
-- once per cited message. Those helpers pin search_path, so Postgres never
-- inlines them: Kyle's 11 summaries cite 304 messages, and the check took
-- 77 ms of his 142 ms bootstrap. It grows with every summary saved.
--
-- The conditions are unchanged and now run as one query: the message is in
-- that conversation, not deleted, available, not hidden for the reader, and
-- the reader is an active member who may see history from that time. The
-- reader's active organization membership, which the helper asked for every
-- message, is asked once per summary by dynamic_group_timestamp_access_allowed
-- as before. Proven before applying, inside a rolled-back transaction: the
-- old and new layers returned identical JSON for all 995 accounts active in
-- the last 30 days (215 with summaries, 289 summaries), and Kyle's layer fell
-- from 106-130 ms to 27-40 ms.
--
-- Only this one function changes; it is replaced in place, so its grants and
-- volatility stay as they are.

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v7_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_conversations jsonb;
  v_messages jsonb;
  v_updates jsonb;
  v_handoffs jsonb;
  v_summaries jsonb;
  v_actions jsonb;
  v_reports jsonb;
  v_discoverable jsonb;
  v_selected uuid;
begin
  v_result := private.bff_bootstrap_messaging_state_v7_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  select coalesce(jsonb_agg(
    private.dynamic_group_conversation_list_item_for_user(
      p_organization_id, p_actor_user_id, item.value, now()
    ) order by item.ordinality
  ), '[]'::jsonb) into v_conversations
  from jsonb_array_elements(coalesce(v_result -> 'conversations', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          item.value,
          '{reply}',
          case when item.value #>> '{reply,message_id}' is null
            or private.dynamic_group_message_access_allowed_for_user(
              p_organization_id, (item.value ->> 'conversation_id')::uuid,
              (item.value #>> '{reply,message_id}')::bigint,
              p_actor_user_id, now()
            ) then coalesce(item.value -> 'reply', 'null'::jsonb)
            else 'null'::jsonb end,
          true
        ),
        '{receipt}',
        case when private.dynamic_group_policy_conversation(
          p_organization_id, (item.value ->> 'conversation_id')::uuid
        ) then coalesce(private.dynamic_group_receipt_payload_for_user(
          p_organization_id, (item.value ->> 'conversation_id')::uuid,
          (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
        ), 'null'::jsonb)
        else coalesce(item.value -> 'receipt', 'null'::jsonb) end,
        true
      ),
      '{forward}',
      case when item.value #>> '{forward,source_message_id}' is null
        or private.dynamic_group_message_access_allowed_for_user(
          p_organization_id,
          (item.value #>> '{forward,source_conversation_id}')::uuid,
          (item.value #>> '{forward,source_message_id}')::bigint,
          p_actor_user_id, now()
        ) then coalesce(item.value -> 'forward', 'null'::jsonb)
        else '{"forwarded":true}'::jsonb end,
      true
    ) order by item.ordinality
  ), '[]'::jsonb)
    into v_messages
  from jsonb_array_elements(coalesce(v_result #> '{timeline,messages}', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id,
    (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint,
    p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_updates
  from jsonb_array_elements(coalesce(v_result -> 'updates', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_handoffs
  from jsonb_array_elements(coalesce(v_result -> 'handoffs', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where not exists (
    select 1 from jsonb_array_elements_text(
      coalesce(item.value -> 'source_message_ids', '[]'::jsonb)
    ) source_id(value)
    where not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      source_id.value::bigint, p_actor_user_id, now()
    )
  ) and private.dynamic_group_timestamp_access_allowed(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id,
    null::timestamptz, now()
  );

  -- A summary shows only while every message it cites is still there for
  -- this reader. That used to be one call of
  -- dynamic_group_message_access_allowed_for_user per cited message, and the
  -- helpers pin search_path, so none of them is inlined: Kyle's 11 summaries
  -- cite 304 messages and the check alone took 77 ms of a 142 ms bootstrap
  -- (Oct 2 2026). The same conditions now run as one query. The reader's
  -- active organization membership, which that helper also asked for every
  -- message, is the same for all of them and is asked once per summary by
  -- dynamic_group_timestamp_access_allowed below.
  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_summaries
  from jsonb_array_elements(coalesce(v_result -> 'summaries', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where not exists (
    select 1 from jsonb_array_elements_text(
      coalesce(item.value -> 'source_message_ids', '[]'::jsonb)
    ) source_id(value)
    where not exists (
      select 1
      from public.messages message
      join public.conversation_members member
        on member.organization_id = message.organization_id
       and member.conversation_id = message.conversation_id
       and member.user_id = p_actor_user_id
       and member.status = 'active'
       and (member.history_visible_from is null
         or message.created_at >= member.history_visible_from)
      where message.organization_id = p_organization_id
        and message.conversation_id = (item.value ->> 'conversation_id')::uuid
        and message.id = source_id.value::bigint
        and message.deleted_at is null
        and message.available_at <= now()
        and message.created_at is not null
        and not exists (
          select 1 from public.message_user_visibility visibility
          where visibility.organization_id = message.organization_id
            and visibility.conversation_id = message.conversation_id
            and visibility.message_id = message.id
            and visibility.user_id = p_actor_user_id
        )
    )
  ) and private.dynamic_group_timestamp_access_allowed(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id, (item.value ->> 'created_at')::timestamptz, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_actions
  from jsonb_array_elements(coalesce(v_result -> 'actions', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where case when item.value ->> 'source_message_id' is null
    then private.dynamic_group_timestamp_access_allowed(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      p_actor_user_id, (item.value ->> 'created_at')::timestamptz, now()
    ) else private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      (item.value ->> 'source_message_id')::bigint, p_actor_user_id, now()
    ) end;

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_reports
  from jsonb_array_elements(coalesce(v_result -> 'moderation_reports', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_discoverable
  from jsonb_array_elements(coalesce(
    v_result -> 'discoverable_conversations', '[]'::jsonb
  )) with ordinality item(value, ordinality)
  where not private.dynamic_group_policy_conversation(
    p_organization_id, (item.value ->> 'conversation_id')::uuid
  );

  v_selected := nullif(v_result ->> 'selected_conversation_id', '')::uuid;
  if v_selected is not null and not private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, v_selected, p_actor_user_id, now()
  ) then
    v_selected := null;
    v_messages := '[]'::jsonb;
  end if;
  v_result := jsonb_set(v_result, '{conversations}', v_conversations, true);
  v_result := jsonb_set(v_result, '{timeline,messages}', v_messages, true);
  v_result := jsonb_set(v_result, '{updates}', v_updates, true);
  v_result := jsonb_set(v_result, '{handoffs}', v_handoffs, true);
  v_result := jsonb_set(v_result, '{summaries}', v_summaries, true);
  v_result := jsonb_set(v_result, '{actions}', v_actions, true);
  v_result := jsonb_set(v_result, '{moderation_reports}', v_reports, true);
  v_result := jsonb_set(
    v_result, '{discoverable_conversations}', v_discoverable, true
  );
  v_result := jsonb_set(
    v_result, '{selected_conversation_id}',
    coalesce(to_jsonb(v_selected), 'null'::jsonb), true
  );
  return v_result;
end;
$function$
;
