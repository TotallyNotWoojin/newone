-- Defect N (groups-20, run-2026-09-04T14-58-38; owner: "group photos don't
-- work"): the app polls /v2/attachments/:id/state before activating a group
-- photo. The state lookup required message visibility even for the uploader,
-- and a conversation-avatar upload lives on a message that is never visible
-- (available_at = infinity), so the answer was {found: false} and the app
-- stopped before activation. The uploader may always read the state of an
-- upload they created; everyone else still needs a clean, visible message.

create or replace function private.bff_get_attachment_state_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_attachment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.state.read', false, 0
  );
  select jsonb_build_object(
    'attachment_id', attachment.id,
    'message_id', attachment.message_id,
    'scan_status', attachment.scan_status,
    'byte_size', attachment.byte_size,
    'mime_type', attachment.mime_type,
    'created_at', attachment.created_at,
    'purge_requested_at', attachment.purge_requested_at
  ) into v_result
  from public.message_attachments attachment
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
    and (
      attachment.created_by_user_id = p_actor_user_id
      or (
        attachment.scan_status = 'clean'
        and private.dynamic_group_message_access_allowed_for_user(
          attachment.organization_id, attachment.conversation_id,
          attachment.message_id, p_actor_user_id, now()
        )
      )
    );
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'attachment', v_result);
end;
$$;

revoke all on function private.bff_get_attachment_state_impl(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function private.bff_get_attachment_state_impl(uuid, uuid, uuid, uuid) to service_role;
