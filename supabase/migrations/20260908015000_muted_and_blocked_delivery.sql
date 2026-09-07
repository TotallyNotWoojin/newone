-- What mute and block actually do, on the two paths that carry a person's
-- words to somebody else.
--
-- Mute: no notification from that person, one-to-one or in a group. The
-- delivery is marked the way a muted registration already is, so the outbox
-- worker settles it as skipped without a provider submission -- no new worker
-- key, no worker change.
--
-- Block: their messages are hidden from the blocker inside a group, and the
-- group carries on unchanged for everyone else. One-to-one contact was already
-- refused by direct_pair_policy_permitted, which can_post_to_conversation
-- checks on every post, so blocking already stops a direct chat being started
-- or continued.
create or replace function private.bff_resolve_push_job_v4_impl(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid, p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_job private.outbox_jobs%rowtype;
  v_sender_user_id uuid;
  v_deliveries jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_resolve_push_job_v3_impl(
    p_worker_id, p_job_id, p_after_device_id, p_limit
  );
  if jsonb_typeof(v_result -> 'deliveries') <> 'array'
     or jsonb_array_length(v_result -> 'deliveries') = 0 then
    return v_result;
  end if;

  select * into v_job from private.outbox_jobs job where job.id = p_job_id;
  if not found or not (v_job.payload ? 'message_id') then
    return v_result;
  end if;
  select message.sender_user_id into v_sender_user_id
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.id = nullif(v_job.payload ->> 'message_id', '')::bigint;
  if v_sender_user_id is null then
    return v_result;
  end if;

  select coalesce(jsonb_agg(
      case when exists (
          select 1 from public.person_mutes mute
          where mute.organization_id = v_job.organization_id
            and mute.muter_user_id = nullif(entry.delivery ->> 'user_id', '')::uuid
            and mute.muted_user_id = v_sender_user_id
        ) or exists (
          select 1 from public.member_blocks block
          where block.organization_id = v_job.organization_id
            and block.blocker_user_id = nullif(entry.delivery ->> 'user_id', '')::uuid
            and block.blocked_user_id = v_sender_user_id
        )
        then jsonb_set(entry.delivery, '{notifications_muted}', 'true'::jsonb, true)
        else entry.delivery
      end
      order by entry.ordinality), '[]'::jsonb)
    into v_deliveries
  from jsonb_array_elements(v_result -> 'deliveries')
    with ordinality as entry(delivery, ordinality);

  return jsonb_set(v_result, '{deliveries}', v_deliveries, true);
end;
$function$;

revoke execute on function private.bff_resolve_push_job_v4_impl(uuid, bigint, uuid, integer)
from public, anon, authenticated;
grant execute on function private.bff_resolve_push_job_v4_impl(uuid, bigint, uuid, integer)
to service_role;

create or replace function public.bff_resolve_push_job(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid default null,
  p_limit integer default 500
)
returns jsonb
language sql
set search_path = ''
as $function$ select private.bff_resolve_push_job_v4_impl(
  p_worker_id, p_job_id, p_after_device_id, p_limit
) $function$;

-- Consumer read layer: a blocked person's messages leave the reader's timeline
-- and their chats-list preview, and the directory says who the reader muted.
create or replace function private.bff_bootstrap_messaging_state_v13_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_directory jsonb;
  v_conversations jsonb;
  v_messages jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v12_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if p_organization_id <> private.personal_realm_organization_id() then
    return v_result;
  end if;

  if jsonb_typeof(v_result -> 'directory') = 'array' then
    select coalesce(jsonb_agg(
        entry.person || jsonb_build_object('is_muted', exists (
          select 1 from public.person_mutes mute
          where mute.organization_id = p_organization_id
            and mute.muter_user_id = p_actor_user_id
            and mute.muted_user_id = nullif(entry.person ->> 'user_id', '')::uuid
        ))
        order by entry.ordinality), '[]'::jsonb)
      into v_directory
    from jsonb_array_elements(v_result -> 'directory')
      with ordinality as entry(person, ordinality);
    v_result := jsonb_set(v_result, '{directory}', v_directory, true);
  end if;

  if jsonb_typeof(v_result -> 'conversations') = 'array' then
    select coalesce(jsonb_agg(
        case when jsonb_typeof(entry.conversation -> 'preview') = 'object'
          and exists (
            select 1 from public.member_blocks block
            where block.organization_id = p_organization_id
              and block.blocker_user_id = p_actor_user_id
              and block.blocked_user_id
                = nullif(entry.conversation -> 'preview' ->> 'sender_user_id', '')::uuid
          )
          then jsonb_set(entry.conversation, '{preview}', 'null'::jsonb, true)
          else entry.conversation
        end
        order by entry.ordinality), '[]'::jsonb)
      into v_conversations
    from jsonb_array_elements(v_result -> 'conversations')
      with ordinality as entry(conversation, ordinality);
    v_result := jsonb_set(v_result, '{conversations}', v_conversations, true);
  end if;

  if jsonb_typeof(v_result -> 'timeline' -> 'messages') = 'array' then
    select coalesce(jsonb_agg(entry.message order by entry.ordinality), '[]'::jsonb)
      into v_messages
    from jsonb_array_elements(v_result -> 'timeline' -> 'messages')
      with ordinality as entry(message, ordinality)
    where not exists (
      select 1 from public.member_blocks block
      where block.organization_id = p_organization_id
        and block.blocker_user_id = p_actor_user_id
        and block.blocked_user_id = coalesce(
          nullif(entry.message -> 'sender' ->> 'user_id', ''),
          nullif(entry.message ->> 'sender_user_id', '')
        )::uuid
    );
    v_result := jsonb_set(v_result, '{timeline,messages}', v_messages, true);
  end if;

  return v_result;
end;
$function$;

revoke execute on function private.bff_bootstrap_messaging_state_v13_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function private.bff_bootstrap_messaging_state_v13_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid default null,
  p_before_message_id bigint default null,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb
language sql
set search_path = ''
as $function$
  select case
    when p_organization_id = private.personal_realm_organization_id()
    then private.bff_bootstrap_messaging_state_v13_impl(
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
