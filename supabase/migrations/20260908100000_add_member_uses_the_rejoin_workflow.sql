-- Adding somebody back to a group still failed.
--
-- 20260908070000 taught the insert to revive a departed membership row, and
-- 20260908090000 made the picker offer that person again, but the membership
-- validator only lets a departed row become active through its own
-- reactivation path, gated on a context flag that the join-request approval
-- sets and this function did not. The service refused the write with
-- 'left or removed members require a service workflow to rejoin' (403), and
-- the group never took the person back.

begin;

CREATE OR REPLACE FUNCTION private.bff_add_conversation_member_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_target_user_id uuid, p_role text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_history_policy text;
  v_history_visible_from timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.add', false, 0, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256
  );
  if not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;
  if p_target_user_id = p_actor_user_id
    and not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) then
    raise exception 'delegated managers cannot add themselves to conversations'
      using errcode = '42501';
  end if;
  -- Serialize member-limit validation with join approval and concurrent adds.
  -- The locked row also makes kind/lifecycle and dynamic-policy checks below
  -- describe one authoritative conversation state.
  perform 1
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift', 'incident')
    and not conversation.is_archived
    and conversation.closed_at is null
  for update;
  if not found then
    raise exception 'open named group required' using errcode = '42501';
  end if;
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) and private.dynamic_group_policy_conversation(
      p_organization_id, p_conversation_id
    ) then
    raise exception 'delegated managers cannot override policy-managed membership'
      using errcode = '42501';
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_role is null or p_role not in ('owner', 'admin', 'member') then
    raise exception 'invalid conversation role' using errcode = '22023';
  end if;
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    )
    and p_role <> 'member' then
    raise exception 'delegated managers may add conversation members only'
      using errcode = '42501';
  end if;
  if not private.organization_membership_access_current(
    p_organization_id, p_target_user_id, now()
  ) or not private.can_view_org_member_for_actor(
    p_organization_id, p_actor_user_id, p_target_user_id, now()
  ) then
    raise exception 'current organization member required' using errcode = '42501';
  end if;
  if not private.group_member_candidate_permitted(
    p_organization_id, p_actor_user_id, p_target_user_id
  ) then
    raise exception 'group members must be accepted contacts' using errcode = '42501';
  end if;
  perform set_config('app.delegated_conversation_management_context', 'on', true);
  perform set_config('app.conversation_join_reactivation_context', 'on', true);
  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id, p_conversation_id, p_target_user_id, p_role,
    p_actor_user_id,
    case when exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.history_policy = 'since_join'
    ) then now() else null end
  )
  -- Leaving or being removed keeps the membership row and marks it, so a plain
  -- insert collided with the primary key and nobody could be added back
  -- (found Sep 7 2026). The row is revived as an ordinary member, which is the
  -- shape the membership validator already allows for a rejoin; the identity
  -- columns it holds immutable (joined_by_user_id, joined_at) are left alone.
  -- Reviving a departed membership is the validator's reactivation path, and it
  -- is gated on this context exactly as the join-request approval gates it.
  -- Without it the upsert below is refused with 'left or removed members
  -- require a service workflow to rejoin' (Sep 7 2026).
  on conflict (organization_id, conversation_id, user_id) do update
    set role = 'member',
        status = 'active',
        can_post = true,
        left_at = null,
        history_visible_from = excluded.history_visible_from
    where public.conversation_members.status <> 'active';
  perform set_config('app.conversation_join_reactivation_context', 'off', true);
  if not found then
    -- The person is already an active member; the caller sees the same
    -- conflict the primary key used to raise.
    raise exception 'conversation member already active' using errcode = '23505';
  end if;
  perform set_config('app.delegated_conversation_management_context', 'off', true);
  select conversation.history_policy, membership.history_visible_from
    into v_history_policy, v_history_visible_from
  from public.conversations conversation
  join public.conversation_members membership
    on membership.organization_id = conversation.organization_id
   and membership.conversation_id = conversation.id
   and membership.user_id = p_target_user_id
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  if exists (
    select 1 from public.conversation_members actor_member
    where actor_member.organization_id = p_organization_id
      and actor_member.conversation_id = p_conversation_id
      and actor_member.user_id = p_actor_user_id
      and actor_member.status = 'active'
  ) then
    perform private.insert_conversation_system_event_internal(
      p_organization_id, p_conversation_id, p_actor_user_id,
      'conversation.member.added', p_target_user_id
    );
  end if;
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, p_target_user_id, 'member_added'
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'role', p_role,
    'history_policy', v_history_policy,
    'history_visible_from', v_history_visible_from,
    'history_disclosure', jsonb_build_object(
      'policy', v_history_policy,
      'visible_from', v_history_visible_from,
      'label_key', case when v_history_policy = 'all'
        then 'conversation.history.all' else 'conversation.history.since_join' end
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$function$
;

commit;
