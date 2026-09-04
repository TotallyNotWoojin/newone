-- Defect O (chat-15/15b, runs 12-44-46 and 15-47-18): deleting a message for
-- everyone (and editing one) changed the row but enqueued no realtime
-- invalidation, so other members kept the old bubble until their next
-- unrelated refresh (B still showed "Delete me everywhere" 120 s later).
-- Both mutations now fan out a workspace invalidation to the conversation's
-- members, the same path reactions and pins already use.

create or replace function private.workspace_invalidation_reason_allowed(p_entity_type text, p_reason text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_entity_type, p_reason) in (
    ('contact_connection', 'contact_request_created'),
    ('contact_connection', 'contact_accepted'),
    ('contact_connection', 'contact_declined'),
    ('contact_connection', 'contact_cancelled'),
    ('contact_connection', 'contact_removed'),
    ('member_block', 'member_blocked'),
    ('member_block', 'member_unblocked'),
    ('reaction', 'reaction_added'),
    ('reaction', 'reaction_removed'),
    ('pin', 'message_pinned'),
    ('pin', 'message_unpinned'),
    ('message', 'message_deleted'),
    ('message', 'message_edited'),
    ('message_visibility', 'message_hidden_for_user'),
    ('attachment', 'attachment_uploaded'),
    ('attachment', 'attachment_scan_clean'),
    ('attachment', 'attachment_scan_quarantined'),
    ('attachment', 'attachment_scan_failed'),
    ('translation', 'translation_completed'),
    ('translation', 'translation_failed'),
    ('translation', 'translation_blocked'),
    ('summary', 'summary_queued'),
    ('summary', 'summary_draft'),
    ('summary', 'summary_failed'),
    ('summary', 'summary_stale'),
    ('summary', 'summary_approved'),
    ('conversation', 'conversation_updated'),
    ('conversation_preference', 'conversation_preferences_updated'),
    ('profile', 'profile_updated'),
    ('profile', 'account_deleted')
  )
$$;

create or replace function private.bff_delete_message_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id) and (
    not private.dynamic_group_user_currently_eligible(p_organization_id, p_conversation_id, p_actor_user_id, now())
    or not private.dynamic_group_message_access_allowed_for_user(p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now())
  ) then
    raise exception 'message mutation requires current policy access' using errcode = '42501';
  end if;
  v_response := private.bff_delete_message_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_idempotency_key, p_request_sha256
  );
  perform private.enqueue_conversation_invalidation_internal(
    p_organization_id, p_conversation_id, 'message', p_message_id::text, 'message_deleted', array[]::uuid[]
  );
  return v_response;
end;
$$;

create or replace function private.bff_edit_message_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_body text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
begin
  if private.dynamic_group_policy_conversation(p_organization_id, p_conversation_id) and (
    not private.dynamic_group_user_currently_eligible(p_organization_id, p_conversation_id, p_actor_user_id, now())
    or not private.dynamic_group_message_access_allowed_for_user(p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, now())
  ) then
    raise exception 'message mutation requires current policy access' using errcode = '42501';
  end if;
  v_response := private.bff_edit_message_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_body, p_idempotency_key, p_request_sha256
  );
  perform private.enqueue_conversation_invalidation_internal(
    p_organization_id, p_conversation_id, 'message', p_message_id::text, 'message_edited', array[]::uuid[]
  );
  return v_response;
end;
$$;

revoke all on function private.bff_delete_message_impl(uuid, uuid, uuid, uuid, bigint, text, text) from public, anon, authenticated;
grant execute on function private.bff_delete_message_impl(uuid, uuid, uuid, uuid, bigint, text, text) to service_role;
revoke all on function private.bff_edit_message_impl(uuid, uuid, uuid, uuid, bigint, text, text, text) from public, anon, authenticated;
grant execute on function private.bff_edit_message_impl(uuid, uuid, uuid, uuid, bigint, text, text, text) to service_role;
