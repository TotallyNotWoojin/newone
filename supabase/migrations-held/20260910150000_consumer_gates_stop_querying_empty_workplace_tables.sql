-- Four gates on the consumer hot path stop querying empty workplace tables.
--
-- Each of these already answers the same thing for every row in the database;
-- they just pay for a query to find out. Measured Sep 10 2026 on the live
-- project:
--
--   dynamic_group_policies                0 rows  -> the two policy predicates
--                                                    are false for everyone
--   organizations.shift_schedule_authoritative
--                                         false on the only organization
--                                                 -> off-shift is always null
--   organization_role_assignments         0 rows  -> the assignment branch of
--                                                    actor_has_permission can
--                                                    never match
--   organization_memberships              365 rows, every one role 'member',
--                                                 membership_type 'employee'
--
-- So these are behaviour-preserving on the data that exists, and they take
-- work off paths that run on every message: dynamic_group_policy_conversation
-- alone is reached from is_conversation_member, can_post_to_conversation,
-- bff_send_message_impl, the bootstrap chain and storage_download_authorized.
--
-- The workplace tables themselves stay for now: 38 live functions still read
-- them, several of them triggers, so dropping them is a rewrite rather than a
-- drop.

create or replace function private.dynamic_group_policy_conversation(
  p_organization_id uuid,
  p_conversation_id uuid
) returns boolean
language sql
immutable
security definer
set search_path to ''
as $$
  -- No conversation is policy-managed; consumers create groups by hand.
  select false
$$;

create or replace function private.dynamic_group_user_currently_eligible(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid,
  p_at timestamp with time zone default now()
) returns boolean
language sql
immutable
security definer
set search_path to ''
as $$
  -- Membership is explicit, so nobody is eligible by policy.
  select false
$$;

create or replace function private.currently_off_shift_internal(
  p_organization_id uuid,
  p_user_id uuid,
  p_at timestamp with time zone default now()
) returns boolean
language sql
immutable
security definer
set search_path to ''
as $$
  -- Null is "no shift schedule to judge by", which is what the query returned
  -- for every organization: none of them is shift-authoritative.
  select null::boolean
$$;

create or replace function private.actor_has_permission(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_permission text,
  p_unit_id uuid default null
) returns boolean
language plpgsql
stable
security definer
set search_path to ''
as $$
declare
  v_legacy_role text;
  v_membership_type text;
begin
  select membership.role, membership.membership_type
    into v_legacy_role, v_membership_type
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );
  if not found or v_membership_type = 'guest' then return false; end if;
  -- The granted-role branch that used to follow read
  -- organization_role_assignments joined to organization_role_permissions,
  -- with a recursive walk up organization_units for unit-scoped grants. There
  -- has never been an assignment, so it could only ever return false.
  return v_legacy_role in ('owner', 'admin');
end;
$$;
