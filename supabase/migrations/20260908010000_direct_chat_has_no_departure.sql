-- A one-to-one chat has nothing to leave, so it carries no departure options at
-- all: the service stops describing a departure for direct conversations and
-- the app renders no leave section for them. Groups are unchanged.
create or replace function private.conversation_departure_options_internal(p_actor_user_id uuid, p_organization_id uuid, p_conversation_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_kind text;
  v_visibility text;
  v_role text;
  v_restriction text;
  v_active_owner_count integer;
  v_policy_managed boolean;
begin
  select conversation.kind, conversation.visibility, member.role,
    exists (
      select 1
      from public.dynamic_group_policies policy
      where policy.organization_id = conversation.organization_id
        and policy.conversation_id = conversation.id
    ) or member.managed_by_policy_id is not null
    into v_kind, v_visibility, v_role, v_policy_managed
  from public.conversations conversation
  join public.conversation_members member
    on member.organization_id = conversation.organization_id
   and member.conversation_id = conversation.id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;

  -- A missing row is intentionally indistinguishable from an unauthorized row.
  if not found then
    return null;
  end if;

  -- Nobody leaves a one-to-one chat, so there is nothing to describe.
  if v_kind = 'direct' then
    return null;
  end if;

  v_restriction := case
    when v_kind = 'announcement' then 'announcement_mandatory'
    when v_kind = 'team' then 'team_mandatory'
    when v_kind = 'shift' then 'shift_mandatory'
    when v_kind = 'incident' then 'incident_mandatory'
    when v_kind = 'group' and v_policy_managed then 'policy_managed'
    when v_kind = 'group' and v_visibility <> 'invite_only' then 'audience_mandatory'
    when v_kind = 'group' then null
    else 'mandatory_audience'
  end;

  select count(*)::integer into v_active_owner_count
  from public.conversation_members owner_member
  join public.organization_memberships owner_organization_member
    on owner_organization_member.organization_id = owner_member.organization_id
   and owner_organization_member.user_id = owner_member.user_id
   and owner_organization_member.status = 'active'
  where owner_member.organization_id = p_organization_id
    and owner_member.conversation_id = p_conversation_id
    and owner_member.status = 'active'
    and owner_member.role = 'owner';

  return jsonb_build_object(
    'eligible', v_restriction is null,
    'restriction', v_restriction,
    'requires_ownership_transfer',
      v_restriction is null and v_role = 'owner' and v_active_owner_count = 1,
    'history_preserved', true,
    'future_access_revoked', true
  );
end;
$function$;
