-- Every bootstrap paid for a workplace projection the consumer app can never
-- use. Opening a chat, sending a message and receiving one all run this, and
-- the layer cost about 600ms of a 875ms call: the base query is 72ms.
--
-- The expensive part scans every conversation in the organization - not the
-- reader's, the whole app's - and runs actor_can_manage_conversation,
-- actor_can_manage_dynamic_group_conversation and
-- dynamic_group_conversation_access_allowed_for_user on each one, to build the
-- management shells an administrator sees for conversations they cannot read.
-- That is a workplace idea resting on organization units and published
-- dynamic-group policies. The personal realm has no units and no policies, so
-- the scan has never produced a row, and its cost grew with every conversation
-- anyone created.
--
-- Measured on the live stack before this change: 238 personal-realm
-- memberships, 29 with can_manage (kept, it drives the group controls), 0 with
-- can_manage_dynamic_group, 0 policy-managed, 0 management-only.

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v9_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_personal boolean := p_organization_id = private.personal_realm_organization_id();
  v_base_selected_conversation_id uuid := p_selected_conversation_id;
  v_result jsonb;
  v_conversations jsonb;
  v_management_shells jsonb;
  v_selected_management_only boolean := false;
begin
  perform private.require_service_role();

  -- The legacy bootstrap correctly rejects arbitrary nonmember selections. A
  -- canonical management target is the one deliberate exception, and V9 later
  -- replaces the inherited default timeline with an empty page.
  -- A management shell is an administrator's view of a conversation whose
  -- content they cannot read: a workplace idea, resting on units and published
  -- dynamic-group policies. The personal realm has neither, so case short-
  -- circuits the two probes rather than paying for an answer that is always no.
  v_selected_management_only := case when v_personal then false else (
    p_selected_conversation_id is not null
    and not private.dynamic_group_conversation_access_allowed_for_user(
      p_organization_id,
      p_selected_conversation_id,
      p_actor_user_id,
      now()
    )
    and (
      private.actor_can_manage_conversation(
        p_actor_user_id, p_organization_id, p_selected_conversation_id
      )
      or private.actor_can_manage_dynamic_group_conversation(
        p_actor_user_id, p_organization_id, p_selected_conversation_id
      )
    )
  ) end;
  if v_selected_management_only then
    v_base_selected_conversation_id := null;
  end if;

  v_result := private.bff_bootstrap_messaging_state_v8_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    v_base_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );

  select coalesce(jsonb_agg(
    item.value || jsonb_build_object(
      -- can_manage remains the narrow owner/admin authority consumed by
      -- avatar, role, summary, incident, and content-adjacent UI.
      'can_manage', private.actor_is_current_conversation_admin(
        p_actor_user_id,
        p_organization_id,
        (item.value ->> 'conversation_id')::uuid
      ),
      -- Delegated metadata, access-control, roster, and join-request workflows
      -- consume this separate capability.
      'can_manage_conversation', private.actor_can_manage_conversation(
        p_actor_user_id,
        p_organization_id,
        (item.value ->> 'conversation_id')::uuid
      ),
      'can_manage_dynamic_group', case when v_personal then false else
        private.actor_can_manage_dynamic_group_conversation(
          p_actor_user_id,
          p_organization_id,
          (item.value ->> 'conversation_id')::uuid
        ) end,
      'policy_managed', case when v_personal then false else
        private.dynamic_group_policy_conversation(
          p_organization_id,
          (item.value ->> 'conversation_id')::uuid
        ) end
    ) order by item.ordinality
  ), '[]'::jsonb)
  into v_conversations
  from jsonb_array_elements(coalesce(v_result -> 'conversations', '[]'::jsonb))
    with ordinality as item(value, ordinality);

  -- A selected management-only target receives one slot without allowing the
  -- combined collection to exceed the caller's existing conversation bound.
  if v_selected_management_only
    and jsonb_array_length(v_conversations) >= p_conversation_limit then
    select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
      into v_conversations
    from jsonb_array_elements(v_conversations)
      with ordinality as item(value, ordinality)
    where item.ordinality < p_conversation_limit;
  end if;

  if v_personal then
    -- Everything below reads every conversation in the organization, not just
    -- this reader's, and asks three access questions about each. In the
    -- personal realm the answer is always the empty list, and the work grew
    -- with the size of the whole app.
    return jsonb_set(v_result, '{conversations}', v_conversations, true);
  end if;

  select coalesce(jsonb_agg(candidate.payload order by
    candidate.is_selected desc, candidate.updated_at desc,
    candidate.conversation_id
  ), '[]'::jsonb)
  into v_management_shells
  from (
    select conversation.id as conversation_id,
      conversation.updated_at,
      conversation.id = p_selected_conversation_id as is_selected,
      jsonb_strip_nulls(jsonb_build_object(
        'conversation_id', conversation.id,
        'kind', conversation.kind,
        'name', conversation.name,
        'description', conversation.description,
        'is_archived', conversation.is_archived,
        'is_read_only', conversation.closed_at is not null,
        'updated_at', conversation.updated_at,
        'preferences', jsonb_build_object(
          'is_favorite', false,
          'is_pinned', false,
          'notification_level', 'all',
          'muted_until', null,
          'translation_mode', 'automatic'
        ),
        'last_read_message_id', null,
        'unread_count', 0,
        'preview', null,
        'member_count', (
          select count(*)
          from public.conversation_members counted_member
          join public.organization_memberships counted_organization_member
            on counted_organization_member.organization_id = counted_member.organization_id
           and counted_organization_member.user_id = counted_member.user_id
          where counted_member.organization_id = conversation.organization_id
            and counted_member.conversation_id = conversation.id
            and counted_member.status = 'active'
            and private.organization_membership_access_current(
              counted_organization_member.organization_id,
              counted_organization_member.user_id,
              now()
            )
            and (
              not private.dynamic_group_policy_conversation(
                counted_member.organization_id, counted_member.conversation_id
              )
              or private.dynamic_group_user_currently_eligible(
                counted_member.organization_id,
                counted_member.conversation_id,
                counted_member.user_id,
                now()
              )
            )
        ),
        -- A roster is necessary only when the selected shell is authorized for
        -- conversation membership controls. Dynamic-group-only shells need no
        -- member identities.
        'members', case when conversation.id = p_selected_conversation_id
          and private.actor_can_manage_conversation(
            p_actor_user_id, p_organization_id, conversation.id
          ) then (
            select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'user_id', listed.user_id,
              'display_name', listed.display_name,
              'avatar_path', listed.avatar_path,
              'role', listed.role,
              'can_post', listed.can_post
            )) order by listed.display_name, listed.user_id), '[]'::jsonb)
            from (
              select member.user_id, profile.display_name, profile.avatar_path,
                member.role, member.can_post
              from public.conversation_members member
              join public.organization_memberships organization_member
                on organization_member.organization_id = member.organization_id
               and organization_member.user_id = member.user_id
              join public.profiles profile on profile.user_id = member.user_id
              where member.organization_id = conversation.organization_id
                and member.conversation_id = conversation.id
                and member.status = 'active'
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
                    member.organization_id,
                    member.conversation_id,
                    member.user_id,
                    now()
                  )
                )
              order by profile.display_name, member.user_id
              limit 500
            ) listed
          ) else '[]'::jsonb end,
        'posting_mode', conversation.posting_mode,
        'configured_join_policy', conversation.join_policy,
        'join_policy', private.effective_conversation_join_policy(
          conversation.organization_id, conversation.id
        ),
        'visibility', conversation.visibility,
        'can_post', false,
        'can_manage', false,
        'can_manage_conversation', private.actor_can_manage_conversation(
          p_actor_user_id, p_organization_id, conversation.id
        ),
        'can_manage_dynamic_group',
          private.actor_can_manage_dynamic_group_conversation(
            p_actor_user_id, p_organization_id, conversation.id
          ),
        'policy_managed', private.dynamic_group_policy_conversation(
          p_organization_id, conversation.id
        ),
        'management_only', true
      )) as payload
    from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and (
        private.actor_can_manage_conversation(
          p_actor_user_id, p_organization_id, conversation.id
        )
        or private.actor_can_manage_dynamic_group_conversation(
          p_actor_user_id, p_organization_id, conversation.id
        )
      )
      -- Shells are exclusively for actors without current or retained-history
      -- content access. Published policies deliberately leave some ineligible
      -- administrators as active physical rows with can_post=false, so raw
      -- membership status is not an authorization discriminator here.
      and not private.dynamic_group_conversation_access_allowed_for_user(
        conversation.organization_id,
        conversation.id,
        p_actor_user_id,
        now()
      )
      and not exists (
        select 1
        from jsonb_array_elements(v_conversations) existing(value)
        where existing.value ->> 'conversation_id' = conversation.id::text
      )
    order by conversation.id = p_selected_conversation_id desc,
      conversation.updated_at desc, conversation.id
    limit greatest(
      p_conversation_limit - jsonb_array_length(v_conversations),
      0
    )
  ) candidate;

  v_conversations := v_conversations || v_management_shells;
  v_result := jsonb_set(v_result, '{conversations}', v_conversations, true);

  -- A management target is not also a join/discovery target. Keep this
  -- defense server-side so every client receives one unambiguous projection.
  v_result := jsonb_set(
    v_result,
    '{discoverable_conversations}',
    coalesce((
      select jsonb_agg(discoverable.value order by discoverable.ordinality)
      from jsonb_array_elements(
        coalesce(v_result -> 'discoverable_conversations', '[]'::jsonb)
      ) with ordinality as discoverable(value, ordinality)
      where not exists (
        select 1
        from jsonb_array_elements(coalesce(v_management_shells, '[]'::jsonb)) shell(value)
        where shell.value ->> 'conversation_id'
          = discoverable.value ->> 'conversation_id'
      )
    ), '[]'::jsonb),
    true
  );

  v_selected_management_only := p_selected_conversation_id is not null
    and exists (
      select 1
      from jsonb_array_elements(coalesce(v_management_shells, '[]'::jsonb)) shell(value)
      where shell.value ->> 'conversation_id' = p_selected_conversation_id::text
    );

  if v_selected_management_only then
    v_result := jsonb_set(
      v_result,
      '{selected_conversation_id}',
      to_jsonb(p_selected_conversation_id),
      true
    );
    v_result := jsonb_set(
      v_result,
      '{timeline}',
      jsonb_build_object(
        'messages', '[]'::jsonb,
        'has_more', false,
        'next_before_message_id', null
      ),
      true
    );
  end if;
  return v_result;
end;
$function$
;
