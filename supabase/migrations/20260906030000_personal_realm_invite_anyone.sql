-- Personal realm: invite anyone.
--
-- The owner's father could not add people to a group unless they were
-- friends, and could only reach a stranger through a capped "message
-- request". In the personal realm (the consumer messenger) those gates go:
--
-- 1. Direct chats. private.direct_pair_policy_permitted treated the realm as
--    a request_first workplace, so a pair had to hold an accepted contact
--    connection (or a pending request with a three-message window). Any two
--    current members may now chat; member_blocks stay enforced in both
--    directions above the policy arm. Workplace realms are unchanged.
--
-- 2. Message request cap. With no pending window left to cap,
--    private.send_message drops the message_request_cap check and the helper
--    is removed. Legacy pending contact rows are harmless: they no longer
--    gate anything, and the bootstrap directory still lists those people.
--
-- 3. Groups. private.group_member_candidate_permitted required an accepted
--    connection in the realm; it now refuses only a block in either direction
--    there (and stays vacuously true elsewhere). private.can_view_org_member_for_actor
--    was the second gate at every group site: every realm membership is
--    directory_visibility = 'private', so it passed only through a connection
--    or a shared conversation. It gains a personal-realm arm after its block
--    check: any current member with a handle is visible, mirroring
--    validate_identity_relationship_target. Group creation, add-member, and
--    both candidate listings inherit the change without being recreated.
--
-- Rate limits (create-direct-hour 10/h, contact-request-day 20/day) are
-- untouched. The message-request route (/v2/contacts/message-requests) and the
-- contact connection routes stay in place for existing clients; the consumer
-- app no longer calls them.

-- ---------------------------------------------------------------------------
-- 1. Direct chats: anyone may chat with anyone in the personal realm.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.direct_pair_policy_permitted(p_organization_id uuid, p_first_user_id uuid, p_second_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.organizations organization
    join public.organization_memberships first_member
      on first_member.organization_id = organization.id
     and first_member.user_id = p_first_user_id
    join public.organization_memberships second_member
      on second_member.organization_id = organization.id
     and second_member.user_id = p_second_user_id
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
      and p_first_user_id <> p_second_user_id
      and first_member.status = 'active'
      and second_member.status = 'active'
      and first_member.membership_type <> 'guest'
      and second_member.membership_type <> 'guest'
      and (first_member.access_expires_at is null or first_member.access_expires_at > now())
      and (second_member.access_expires_at is null or second_member.access_expires_at > now())
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and (
            (block.blocker_user_id = p_first_user_id and block.blocked_user_id = p_second_user_id)
            or (block.blocker_user_id = p_second_user_id and block.blocked_user_id = p_first_user_id)
          )
      )
      and case organization.dm_policy
        when 'directory_open' then true
        when 'request_first' then (
          -- The personal realm is a consumer messenger: anyone may open a
          -- chat with anyone. Blocks are enforced above, in both directions.
          organization.id = private.personal_realm_organization_id()
          or exists (
            select 1 from public.contact_connections connection
            where connection.organization_id = p_organization_id
              and connection.member_low_user_id = least(p_first_user_id, p_second_user_id)
              and connection.member_high_user_id = greatest(p_first_user_id, p_second_user_id)
              and connection.status = 'accepted'
          )
        )
        when 'scoped_unit' then exists (
          select 1
          from public.organization_unit_members first_unit
          join public.organization_unit_members second_unit
            on second_unit.organization_id = first_unit.organization_id
           and second_unit.unit_id = first_unit.unit_id
           and second_unit.user_id = p_second_user_id
          where first_unit.organization_id = p_organization_id
            and first_unit.user_id = p_first_user_id
        )
        else false
      end
  )
$function$;

-- ---------------------------------------------------------------------------
-- 2. No more message-request cap.
-- ---------------------------------------------------------------------------

-- The three-message request window is gone, so the cap wrapper becomes a
-- passthrough and its helper is dropped. The signature and grants of
-- private.send_message are unchanged.
CREATE OR REPLACE FUNCTION private.send_message(p_organization_id uuid, p_conversation_id uuid, p_client_nonce uuid, p_kind text DEFAULT 'text'::text, p_body text DEFAULT NULL::text, p_language_code text DEFAULT NULL::text, p_reply_to_message_id bigint DEFAULT NULL::bigint, p_thread_root_message_id bigint DEFAULT NULL::bigint, p_metadata jsonb DEFAULT '{}'::jsonb, p_available_at timestamp with time zone DEFAULT now())
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  return private.send_message_pre_request_cap_code(
    p_organization_id, p_conversation_id, p_client_nonce, p_kind, p_body,
    p_language_code, p_reply_to_message_id, p_thread_root_message_id,
    p_metadata, p_available_at
  );
end;
$function$;

drop function if exists private.message_request_cap_reached(uuid, uuid);

-- ---------------------------------------------------------------------------
-- 3. Groups: anyone is addable in the personal realm.
-- ---------------------------------------------------------------------------

-- Anyone may be placed into a group in the personal realm; a block in either
-- direction still refuses. Workspace organizations keep their directory rules
-- (this predicate stays vacuously true there).
create or replace function private.group_member_candidate_permitted(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_organization_id is not null
    and p_actor_user_id is not null
    and p_target_user_id is not null
    and p_actor_user_id <> p_target_user_id
    and (
      p_organization_id <> private.personal_realm_organization_id()
      or not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and (
            (block.blocker_user_id = p_actor_user_id
              and block.blocked_user_id = p_target_user_id)
            or (block.blocker_user_id = p_target_user_id
              and block.blocked_user_id = p_actor_user_id)
          )
      )
    )
$$;

revoke all on function private.group_member_candidate_permitted(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.group_member_candidate_permitted(uuid, uuid, uuid) is
  'True when the actor may place the target into a group: always in workspace organizations; in the personal realm for anyone, unless a block exists in either direction.';

-- Full recreate of can_view_org_member_for_actor from its live definition; the
-- only change is the personal-realm arm after the block check.
CREATE OR REPLACE FUNCTION private.can_view_org_member_for_actor(p_organization_id uuid, p_actor_user_id uuid, p_target_user_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_viewer public.organization_memberships%rowtype;
  v_target public.organization_memberships%rowtype;
  v_privileged boolean := false;
  v_shared_named_conversation boolean := false;
  v_contact_scope boolean := false;
begin
  if p_organization_id is null or p_actor_user_id is null
    or p_target_user_id is null or p_at is null or not isfinite(p_at) then
    return false;
  end if;
  select membership.* into v_viewer
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, p_at
    );
  select membership.* into v_target
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_target_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, p_at
    );
  if v_viewer.user_id is null or v_target.user_id is null then return false; end if;
  if p_actor_user_id = p_target_user_id then return true; end if;

  v_privileged := v_viewer.membership_type <> 'guest' and (
    v_viewer.role in ('owner', 'admin')
    or private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'directory.read', null
    )
    or private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'conversation.manage', null
    )
  );
  select exists (
    select 1
    from public.conversation_members viewer_member
    join public.conversation_members target_member
      on target_member.organization_id = viewer_member.organization_id
     and target_member.conversation_id = viewer_member.conversation_id
     and target_member.user_id = p_target_user_id
     and target_member.status = 'active'
    join public.conversations conversation
      on conversation.organization_id = viewer_member.organization_id
     and conversation.id = viewer_member.conversation_id
    where viewer_member.organization_id = p_organization_id
      and viewer_member.user_id = p_actor_user_id
      and viewer_member.status = 'active'
      and conversation.kind in ('group', 'team', 'shift', 'incident')
      and char_length(btrim(coalesce(conversation.name, ''))) > 0
      and not conversation.is_archived
      and not exists (
        select 1 from public.dynamic_group_policies policy
        where policy.organization_id = conversation.organization_id
          and policy.conversation_id = conversation.id
      )
  ) into v_shared_named_conversation;
  select exists (
    select 1 from public.contact_connections connection
    where connection.organization_id = p_organization_id
      and connection.member_low_user_id = least(
        p_actor_user_id, p_target_user_id
      )
      and connection.member_high_user_id = greatest(
        p_actor_user_id, p_target_user_id
      )
      and connection.status in ('pending', 'accepted')
  ) into v_contact_scope;

  if v_target.membership_type = 'guest' then
    return v_viewer.membership_type <> 'guest' and (
      v_target.guest_sponsor_user_id = p_actor_user_id
      or v_privileged
      or v_shared_named_conversation
    );
  end if;
  if v_viewer.membership_type = 'guest' then
    return v_shared_named_conversation;
  end if;
  if v_privileged or v_shared_named_conversation then return true; end if;
  if exists (
    select 1 from public.member_blocks block
    where block.organization_id = p_organization_id
      and (
        (block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = p_target_user_id)
        or (block.blocker_user_id = p_target_user_id
          and block.blocked_user_id = p_actor_user_id)
      )
  ) then return false; end if;
  -- The personal realm keeps every membership directory-private, yet anyone
  -- with a handle is findable through people search and may be messaged or
  -- placed into a group. Blocks were refused just above; a member who has not
  -- finished signup (no username) stays invisible, as for relationship writes.
  if p_organization_id = private.personal_realm_organization_id() then
    return exists (
      select 1 from public.profiles profile
      where profile.user_id = p_target_user_id
        and profile.username is not null
    );
  end if;
  if v_contact_scope then return true; end if;
  if v_target.directory_visibility = 'organization' then return true; end if;
  return v_target.directory_visibility = 'unit' and exists (
    select 1
    from public.organization_unit_members viewer_unit
    join public.organization_unit_members target_unit
      on target_unit.organization_id = viewer_unit.organization_id
     and target_unit.unit_id = viewer_unit.unit_id
     and target_unit.user_id = p_target_user_id
    where viewer_unit.organization_id = p_organization_id
      and viewer_unit.user_id = p_actor_user_id
  );
end;
$function$;
