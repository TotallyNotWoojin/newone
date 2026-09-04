-- Consumer realm: any active conversation member may pin or unpin a message.
--
-- Pinning was gated on conversation admin (owner/admin role), which fits
-- policy-managed team groups but leaves consumer DMs with nobody able to pin:
-- both participants hold the member role, so the Message actions sheet offered
-- Pin and the server answered 42501 ("Your company role does not allow this
-- action." on the device). WhatsApp-style consumer threads let any participant
-- pin. Enterprise organizations keep the admin requirement unchanged.

create or replace function private.can_pin_in_conversation(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_conversation_admin(p_organization_id, p_conversation_id)
    or (
      p_organization_id = private.personal_realm_organization_id()
      and private.is_conversation_member(p_organization_id, p_conversation_id)
    )
$$;

revoke all on function private.can_pin_in_conversation(uuid, uuid) from public;

create or replace function private.bff_set_message_pin_pre_dynamic_group_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_pinned boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_pinned_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.pin.set', false, 0, '/v2/messages/:id/pin',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.can_pin_in_conversation(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_message_id
      and message.deleted_at is null
  ) then
    raise exception 'message not found' using errcode = 'P0002';
  end if;
  if p_pinned then
    insert into public.message_pins (
      organization_id, conversation_id, message_id, pinned_by_user_id
    ) values (
      p_organization_id, p_conversation_id, p_message_id, p_actor_user_id
    )
    on conflict (organization_id, conversation_id, message_id) do update
      set pinned_by_user_id = excluded.pinned_by_user_id,
          pinned_at = now()
    returning pinned_at into v_pinned_at;
  else
    delete from public.message_pins pin
    where pin.organization_id = p_organization_id
      and pin.conversation_id = p_conversation_id
      and pin.message_id = p_message_id;
  end if;
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'message_id', p_message_id,
    'pinned', p_pinned,
    'pinned_at', v_pinned_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/pin',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;
