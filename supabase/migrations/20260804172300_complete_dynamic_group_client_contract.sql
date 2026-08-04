begin;

create or replace function private.bff_list_dynamic_group_policies_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_after_policy_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_policy record;
  v_items jsonb := '[]'::jsonb;
  v_seen integer := 0;
  v_next_after_policy_id uuid;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    'dynamic_group.policy.read',
    true,
    900
  );
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'dynamic-group policy list limit must be between 1 and 100'
      using errcode = '22023';
  end if;

  for v_policy in
    select
      policy.id,
      policy.conversation_id,
      conversation.name as conversation_name,
      conversation.kind as conversation_kind,
      conversation.unit_id as conversation_unit_id,
      policy.status,
      policy.version,
      policy.draft_state,
      private.normalize_dynamic_group_policy_spec(policy.policy_spec) as policy_spec,
      policy.maximum_members,
      policy.selector_fingerprint,
      policy.published_version_id,
      policy.last_preview_fingerprint,
      policy.last_previewed_at,
      policy.last_synced_at,
      policy.next_evaluation_at,
      policy.source_changed_at,
      policy.created_at,
      policy.updated_at
    from public.dynamic_group_policies policy
    join public.conversations conversation
      on conversation.organization_id = policy.organization_id
     and conversation.id = policy.conversation_id
    where policy.organization_id = p_organization_id
      and (p_after_policy_id is null or policy.id > p_after_policy_id)
      and conversation.kind in ('group', 'team', 'shift')
      and private.actor_has_permission(
        p_actor_user_id,
        p_organization_id,
        'unit.manage',
        conversation.unit_id
      )
      and (
        jsonb_array_length(policy.policy_spec -> 'site_ids')
        + jsonb_array_length(policy.policy_spec -> 'department_ids')
        + jsonb_array_length(policy.policy_spec -> 'team_ids')
        + jsonb_array_length(policy.policy_spec -> 'line_ids')
        + jsonb_array_length(policy.policy_spec -> 'unit_ids') > 0
        or private.actor_has_permission(
          p_actor_user_id,
          p_organization_id,
          'unit.manage',
          null
        )
      )
      and not exists (
        select 1
        from (
          select value::uuid as unit_id
          from jsonb_array_elements_text(policy.policy_spec -> 'site_ids') item(value)
          union
          select value::uuid
          from jsonb_array_elements_text(policy.policy_spec -> 'department_ids') item(value)
          union
          select value::uuid
          from jsonb_array_elements_text(policy.policy_spec -> 'team_ids') item(value)
          union
          select value::uuid
          from jsonb_array_elements_text(policy.policy_spec -> 'line_ids') item(value)
          union
          select value::uuid
          from jsonb_array_elements_text(policy.policy_spec -> 'unit_ids') item(value)
        ) selected
        where not private.actor_has_permission(
          p_actor_user_id,
          p_organization_id,
          'unit.manage',
          selected.unit_id
        )
      )
    order by policy.id
    limit p_limit + 1
  loop
    v_seen := v_seen + 1;
    if v_seen <= p_limit then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'policy_id', v_policy.id,
        'conversation_id', v_policy.conversation_id,
        'conversation_name', v_policy.conversation_name,
        'conversation_kind', v_policy.conversation_kind,
        'conversation_unit_id', v_policy.conversation_unit_id,
        'status', v_policy.status,
        'version', v_policy.version,
        'draft_state', v_policy.draft_state,
        'policy_spec', v_policy.policy_spec,
        'maximum_members', v_policy.maximum_members,
        'selector_fingerprint', v_policy.selector_fingerprint,
        'published_version_id', v_policy.published_version_id,
        'last_preview_fingerprint', v_policy.last_preview_fingerprint,
        'last_previewed_at', v_policy.last_previewed_at,
        'last_synced_at', v_policy.last_synced_at,
        'next_evaluation_at', v_policy.next_evaluation_at,
        'source_changed_at', v_policy.source_changed_at,
        'created_at', v_policy.created_at,
        'updated_at', v_policy.updated_at
      ));
      v_next_after_policy_id := v_policy.id;
    end if;
  end loop;

  return jsonb_build_object(
    'policies', v_items,
    'limit', p_limit,
    'next_after_policy_id', case when v_seen > p_limit
      then v_next_after_policy_id else null end
  );
end;
$$;

create or replace function public.bff_list_dynamic_group_policies(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_after_policy_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_list_dynamic_group_policies_impl(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_after_policy_id,
    p_limit
  )
$$;

revoke all on function private.bff_list_dynamic_group_policies_impl(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function private.bff_list_dynamic_group_policies_impl(
  uuid, uuid, uuid, uuid, integer
) to service_role;

revoke all on function public.bff_list_dynamic_group_policies(
  uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.bff_list_dynamic_group_policies(
  uuid, uuid, uuid, uuid, integer
) to service_role;

comment on function public.bff_list_dynamic_group_policies(
  uuid, uuid, uuid, uuid, integer
) is 'Recent-AAL2 bounded CAS policy administration list filtered to exact unit.manage scope.';

commit;
