-- Message requests: the fourth message in a pending request fails with a
-- specific error code instead of a generic permission failure.
--
-- private.direct_pair_policy_permitted lets a requester post at most three
-- messages while the request is pending. The send path saw can_post = false
-- and raised the generic 42501, which the API turned into "forbidden" and the
-- device showed as "Not sent · forbidden" (device suite, run
-- 2026-09-04T04-57-19, neg-07). The consumer copy for this case already
-- exists on the client ('This request already holds its 3 messages…'); the
-- server now names the case so the API can pass it through.

create or replace function private.message_request_cap_reached(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.direct_conversation_pairs pair
    join public.contact_connections connection
      on connection.organization_id = pair.organization_id
     and connection.member_low_user_id = pair.member_low_user_id
     and connection.member_high_user_id = pair.member_high_user_id
    where pair.organization_id = p_organization_id
      and pair.conversation_id = p_conversation_id
      and connection.status = 'pending'
      and connection.requested_by_user_id = (select auth.uid())
      and (
        select count(*)
        from public.messages message
        where message.organization_id = pair.organization_id
          and message.conversation_id = pair.conversation_id
          and message.sender_user_id = (select auth.uid())
          and message.kind <> 'system'
          and message.deleted_at is null
      ) >= 3
  )
$$;

revoke all on function private.message_request_cap_reached(uuid, uuid) from public;

alter function private.send_message(
  uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb, timestamptz
) rename to send_message_pre_request_cap_code;

create or replace function private.send_message(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_kind text default 'text',
  p_body text default null,
  p_language_code text default null,
  p_reply_to_message_id bigint default null,
  p_thread_root_message_id bigint default null,
  p_metadata jsonb default '{}'::jsonb,
  p_available_at timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
    and private.message_request_cap_reached(p_organization_id, p_conversation_id) then
    raise exception 'message_request_cap' using errcode = '42501';
  end if;
  return private.send_message_pre_request_cap_code(
    p_organization_id, p_conversation_id, p_client_nonce, p_kind, p_body,
    p_language_code, p_reply_to_message_id, p_thread_root_message_id,
    p_metadata, p_available_at
  );
end;
$$;

revoke all on function private.send_message(
  uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb, timestamptz
) from public;
revoke all on function private.send_message_pre_request_cap_code(
  uuid, uuid, uuid, text, text, text, bigint, bigint, jsonb, timestamptz
) from public;
