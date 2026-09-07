-- Blocking hides a person's messages on every path that hands the reader
-- messages, not only the first screenful: paging back through a group must not
-- bring them back. The page reader wraps the existing one and drops the same
-- senders the bootstrap timeline drops. Paging itself is untouched: has_more
-- and the cursor still come from the underlying page.
create or replace function private.bff_read_conversation_page_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_before_message_id bigint,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_page jsonb;
  v_messages jsonb;
begin
  perform private.require_service_role();
  v_page := private.bff_read_conversation_page_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_before_message_id, p_limit
  );
  if p_organization_id <> private.personal_realm_organization_id()
    or jsonb_typeof(v_page -> 'messages') <> 'array' then
    return v_page;
  end if;

  select coalesce(jsonb_agg(entry.message order by entry.ordinality), '[]'::jsonb)
    into v_messages
  from jsonb_array_elements(v_page -> 'messages')
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

  return jsonb_set(v_page, '{messages}', v_messages, true);
end;
$function$;

revoke execute on function private.bff_read_conversation_page_v2_impl(
  uuid, uuid, uuid, uuid, bigint, integer
) from public, anon, authenticated;
grant execute on function private.bff_read_conversation_page_v2_impl(
  uuid, uuid, uuid, uuid, bigint, integer
) to service_role;

create or replace function public.bff_read_conversation_page(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_before_message_id bigint default null,
  p_limit integer default 50
)
returns jsonb
language sql
set search_path = ''
as $function$ select private.bff_read_conversation_page_v2_impl(
  p_actor_user_id, p_organization_id, p_session_id,
  p_conversation_id, p_before_message_id, p_limit
) $function$;
