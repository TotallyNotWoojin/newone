begin;

-- A later lifecycle-hardening migration replaced these shared RLS predicates
-- and accidentally dropped the published dynamic-policy eligibility check.
-- Cached conversation membership is not authoritative for a policy-managed
-- group: an off-shift or otherwise ineligible user must lose current access
-- immediately, even if reconciliation has not removed the cached row yet.
create or replace function private.is_conversation_member(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_active_for_org(p_organization_id)
    and exists (
      select 1
      from public.conversation_members member
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.user_id = (select auth.uid())
        and member.status = 'active'
        and private.organization_membership_access_current(
          member.organization_id, member.user_id, now()
        )
        and (
          not private.dynamic_group_policy_conversation(
            member.organization_id, member.conversation_id
          )
          or private.dynamic_group_user_currently_eligible(
            member.organization_id, member.conversation_id, member.user_id, now()
          )
        )
    )
$$;

create or replace function private.is_conversation_admin(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.current_session_active_for_org(p_organization_id)
    and exists (
      select 1
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.user_id = (select auth.uid())
        and member.status = 'active'
        and member.role in ('owner', 'admin')
        and organization_member.membership_type <> 'guest'
        and private.organization_membership_access_current(
          organization_member.organization_id,
          organization_member.user_id,
          now()
        )
        and (
          not private.dynamic_group_policy_conversation(
            member.organization_id, member.conversation_id
          )
          or private.dynamic_group_user_currently_eligible(
            member.organization_id, member.conversation_id, member.user_id, now()
          )
        )
    )
$$;

comment on function private.is_conversation_member(uuid, uuid) is
  'Current conversation membership; policy-managed groups additionally require current authoritative eligibility.';
comment on function private.is_conversation_admin(uuid, uuid) is
  'Current non-guest conversation administration; policy-managed groups additionally require current authoritative eligibility.';

commit;
