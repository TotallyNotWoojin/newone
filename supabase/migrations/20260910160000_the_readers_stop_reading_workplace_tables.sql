-- Everything that reads the workplace tables stops reading them.
--
-- Everything that read them has been dealt with first. 36 functions were
-- rewritten to stop reading tables that have been empty for months -- an
-- aggregate over an empty table is null, an EXISTS over one is false, and a
-- branch guarded by such an EXISTS never ran -- so none of this changes what
-- the database returns. The rest only ever served the workplace product and
-- go with the tables.
--
-- Measured on the live project before writing this: every one of these tables
-- holds zero rows, every organization_memberships row is a plain 'member',
-- there are no role assignments, no dynamic-group policies, and the single
-- organization is not shift-authoritative.
--
-- organization_ai_policies stays. It is one row, it gates translation and
-- summaries through private.ai_use_case_approved, and it is the only remaining
-- way to turn AI off. It is infrastructure rather than workplace product.

set local check_function_bodies = off;
-- 1. The rewrites.

CREATE OR REPLACE FUNCTION private.actor_can_manage_conversation(p_actor_user_id uuid, p_organization_id uuid, p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.conversations conversation
    join public.organization_memberships actor
      on actor.organization_id = conversation.organization_id
     and actor.user_id = p_actor_user_id
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind <> 'direct'
      and actor.membership_type <> 'guest'
      and private.organization_membership_access_current(
        actor.organization_id, actor.user_id, now()
      )
      and (
        private.actor_is_current_conversation_admin(
          p_actor_user_id, p_organization_id, p_conversation_id
        )
        or (
          -- Organization-wide announcements are mandatory communication
          -- surfaces, not delegated chat-administration targets. Their actual
          -- current owner/admin authority remains intact.
          not (
            conversation.kind = 'announcement'
            and conversation.unit_id is null
          )
          and private.actor_has_permission(
            p_actor_user_id,
            p_organization_id,
            'conversation.manage',
            conversation.unit_id
          )
        )
      )
  )
$function$;

CREATE OR REPLACE FUNCTION private.actor_has_permission(p_actor_user_id uuid, p_organization_id uuid, p_permission text, p_unit_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if v_legacy_role in ('owner', 'admin') then return true; end if;
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION private.announcement_audience_candidates(p_organization_id uuid, p_conversation_id uuid, p_spec jsonb, p_evaluated_at timestamp with time zone)
 RETURNS TABLE(user_id uuid, display_name text, preferred_language text, membership_role text, unit_ids uuid[], current_shift_assignment_ids uuid[], audience_snapshot jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_spec jsonb := private.normalize_announcement_audience_spec(p_spec);
  v_spec_hash text := encode(extensions.digest(
    convert_to(private.normalize_announcement_audience_spec(p_spec)::text, 'UTF8'), 'sha256'
  ), 'hex');
begin
  if p_evaluated_at is null or not isfinite(p_evaluated_at) then
    raise exception 'finite audience evaluation time required' using errcode = '22023';
  end if;
  return query
  select membership.user_id,
    profile.display_name,
    lower(coalesce(preference.message_language, profile.preferred_language)) as preferred_language,
    membership.role,
    coalesce(member_units.ids, '{}'::uuid[]),
    coalesce(current_shifts.ids, '{}'::uuid[]),
    jsonb_build_object(
      'schema_version', 1,
      'evaluated_at', p_evaluated_at,
      'audience_spec_sha256', v_spec_hash,
      'membership_role', membership.role,
      'job_title', membership.job_title,
      'configured_role_names', to_jsonb(coalesce(configured_roles.names, '{}'::text[])),
      'preferred_language', lower(coalesce(
        preference.message_language, profile.preferred_language
      )),
      'unit_ids', to_jsonb(coalesce(member_units.ids, '{}'::uuid[])),
      'current_shift_assignment_ids', to_jsonb(coalesce(current_shifts.ids, '{}'::uuid[]))
    )
  from public.organization_memberships membership
  join public.profiles profile on profile.user_id = membership.user_id
  left join public.organization_user_preferences preference
    on preference.organization_id = membership.organization_id
   and preference.user_id = membership.user_id
  left join lateral null member_units on true
  left join lateral null current_shifts on true
  left join lateral null configured_roles on true
  where membership.organization_id = p_organization_id
    and membership.status = 'active'
    and (
      (v_spec ->> 'company')::boolean
      or ((v_spec ->> 'conversation_members')::boolean and exists (
        select 1 from public.conversation_members conversation_member
        where conversation_member.organization_id = membership.organization_id
          and conversation_member.conversation_id = p_conversation_id
          and conversation_member.user_id = membership.user_id
          and conversation_member.status = 'active'
      ))
      or false
    )
    and (jsonb_array_length(v_spec -> 'membership_roles') = 0 or exists (
      select 1
      from jsonb_array_elements_text(v_spec -> 'membership_roles') selected(role_name)
      where selected.role_name = membership.role
    ))
    and (jsonb_array_length(v_spec -> 'roles') = 0 or exists (
      select 1
      from jsonb_array_elements_text(v_spec -> 'roles') selected(role_name)
      where selected.role_name = lower(btrim(coalesce(membership.job_title, '')))
        or selected.role_name = any(coalesce(configured_roles.names, '{}'::text[]))
    ))
    and (jsonb_array_length(v_spec -> 'languages') = 0 or exists (
      select 1 from jsonb_array_elements_text(v_spec -> 'languages') selected(language)
      where selected.language = lower(coalesce(
        preference.message_language, profile.preferred_language
      ))
    ))
    and (not (v_spec ->> 'current_shift_only')::boolean
      or cardinality(coalesce(current_shifts.ids, '{}'::uuid[])) > 0)
  order by profile.display_name, membership.user_id;
end;
$function$;

CREATE OR REPLACE FUNCTION private.announcement_audience_spec_is_live(p_organization_id uuid, p_spec jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_spec jsonb;
begin
  v_spec := private.normalize_announcement_audience_spec(p_spec);
  if (v_spec ->> 'current_shift_only')::boolean and not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.shift_schedule_authoritative
  ) then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'site_ids') selected(id)
    where not false
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'department_ids') selected(id)
    where not false
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'team_ids') selected(id)
    where not false
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'unit_ids') selected(id)
    where not false
  ) or exists (
    select 1
    from jsonb_array_elements_text(v_spec -> 'roles') selected(role_name)
    where not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.status = 'active'
        and lower(btrim(coalesce(membership.job_title, ''))) = selected.role_name
    ) and not false
  ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v10_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_directory jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v9_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if p_organization_id <> private.personal_realm_organization_id() then
    return v_result;
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'user_id', visible.user_id,
    'username', visible.username,
    'display_name', visible.display_name,
    'avatar_path', visible.avatar_path,
    'status_message', visible.status_message,
    'preferred_language', visible.preferred_language,
    'time_zone', visible.time_zone,
    'membership_role', visible.membership_role,
    'membership_type', visible.membership_type,
    'membership_status', visible.membership_status,
    'access_expires_at', visible.access_expires_at,
    'job_title', visible.job_title,
    'directory_visibility', visible.directory_visibility,
    'unit_ids', visible.unit_ids,
    'is_saved_contact', visible.is_saved_contact,
    'is_blocked', visible.is_blocked,
    'connection', visible.connection
  )) order by visible.display_name, visible.user_id), '[]'::jsonb)
  into v_directory
  from (
    select membership.user_id, profile.username::text as username,
      profile.display_name, profile.avatar_path,
      profile.status_message, profile.preferred_language, profile.time_zone,
      membership.role as membership_role,
      membership.membership_type, membership.status as membership_status,
      membership.access_expires_at, membership.job_title,
      membership.directory_visibility,
      '[]'::jsonb as unit_ids,
      exists (
        select 1 from public.saved_contacts saved
        where saved.organization_id = membership.organization_id
          and saved.owner_user_id = p_actor_user_id
          and saved.contact_user_id = membership.user_id
      ) as is_saved_contact,
      exists (
        select 1 from public.member_blocks block
        where block.organization_id = membership.organization_id
          and block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = membership.user_id
      ) as is_blocked,
      (
        select jsonb_build_object(
          'status', connection.status,
          'requested_by_user_id', connection.requested_by_user_id,
          'created_at', connection.created_at,
          'responded_at', connection.responded_at,
          'updated_at', connection.updated_at
        )
        from public.contact_connections connection
        where connection.organization_id = membership.organization_id
          and p_actor_user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
          and membership.user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
          and membership.user_id <> p_actor_user_id
      ) as connection
    from (
      select relevant.user_id
      from (
        select case when connection.member_low_user_id = p_actor_user_id
            then connection.member_high_user_id
            else connection.member_low_user_id end as user_id
        from public.contact_connections connection
        where connection.organization_id = p_organization_id
          and p_actor_user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
        union
        select co_member.user_id
        from public.conversation_members actor_member
        join public.conversation_members co_member
          on co_member.organization_id = actor_member.organization_id
         and co_member.conversation_id = actor_member.conversation_id
         and co_member.user_id <> p_actor_user_id
         and co_member.status = 'active'
        where actor_member.organization_id = p_organization_id
          and actor_member.user_id = p_actor_user_id
          and actor_member.status = 'active'
      ) relevant
    ) scoped
    join public.organization_memberships membership
      on membership.organization_id = p_organization_id
     and membership.user_id = scoped.user_id
    join public.profiles profile on profile.user_id = membership.user_id
    order by profile.display_name, membership.user_id
    limit 500
  ) visible;

  v_result := jsonb_set(
    v_result, '{current_user}',
    coalesce(v_result -> 'current_user', '{}'::jsonb) ||
      coalesce((
        select jsonb_strip_nulls(jsonb_build_object('username', profile.username::text))
        from public.profiles profile
        where profile.user_id = p_actor_user_id
      ), '{}'::jsonb), true
  );
  return jsonb_set(v_result, '{directory}', v_directory, true);
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v2_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_base jsonb;
  v_organization jsonb;
  v_current_user jsonb;
  v_capabilities jsonb;
  v_scopes jsonb;
  v_units jsonb;
  v_directory jsonb;
  v_connections jsonb;
  v_conversations jsonb;
  v_updates jsonb;
  v_handoffs jsonb;
  v_summaries jsonb;
  v_actions jsonb;
  v_moderation_reports jsonb := '[]'::jsonb;
  v_audit_events jsonb := '[]'::jsonb;
  v_selected uuid;
begin
  perform private.require_service_role();
  v_base := private.bff_bootstrap_messaging_state_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  v_selected := nullif(v_base ->> 'selected_conversation_id', '')::uuid;
  v_capabilities := private.effective_capabilities_internal(
    p_actor_user_id, p_organization_id
  );
  v_scopes := private.effective_scopes_internal(
    p_actor_user_id, p_organization_id
  );

  select jsonb_build_object(
    'organization_id', organization.id,
    'slug', organization.slug,
    'name', organization.name,
    'default_language', organization.default_language,
    'message_retention_days', organization.message_retention_days,
    'allow_member_direct_messages', organization.allow_member_direct_messages,
    'dm_policy', organization.dm_policy,
    'require_mfa_for_admins', organization.require_mfa_for_admins
  ) into v_organization
  from public.organizations organization where organization.id = p_organization_id;

  select jsonb_strip_nulls(jsonb_build_object(
    'user_id', profile.user_id,
    'display_name', profile.display_name,
    'avatar_path', profile.avatar_path,
    'status_message', profile.status_message,
    'preferred_language', profile.preferred_language,
    'time_zone', profile.time_zone,
    'membership_role', membership.role,
    'job_title', membership.job_title,
    'directory_visibility', membership.directory_visibility,
    'revocation_generation', membership.revocation_generation
  )) into v_current_user
  from public.organization_memberships membership
  join public.profiles profile on profile.user_id = membership.user_id
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';

  -- Consumers have no org chart, so this is always empty.
  v_units := '[]'::jsonb;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'user_id', visible.user_id,
    'display_name', visible.display_name,
    'avatar_path', visible.avatar_path,
    'status_message', visible.status_message,
    'preferred_language', visible.preferred_language,
    'time_zone', visible.time_zone,
    'membership_role', visible.membership_role,
    'job_title', visible.job_title,
    'directory_visibility', visible.directory_visibility,
    'unit_ids', visible.unit_ids,
    'is_saved_contact', visible.is_saved_contact,
    'is_blocked', visible.is_blocked,
    'connection', visible.connection
  )) order by visible.display_name, visible.user_id), '[]'::jsonb)
  into v_directory
  from (
    select membership.user_id, profile.display_name, profile.avatar_path,
      profile.status_message, profile.preferred_language, profile.time_zone,
      membership.role as membership_role, membership.job_title,
      membership.directory_visibility,
      '[]'::jsonb as unit_ids,
      exists (
        select 1 from public.saved_contacts saved
        where saved.organization_id = membership.organization_id
          and saved.owner_user_id = p_actor_user_id
          and saved.contact_user_id = membership.user_id
      ) as is_saved_contact,
      exists (
        select 1 from public.member_blocks block
        where block.organization_id = membership.organization_id
          and block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = membership.user_id
      ) as is_blocked,
      (select jsonb_build_object(
        'status', connection.status,
        'requested_by_user_id', connection.requested_by_user_id,
        'created_at', connection.created_at,
        'responded_at', connection.responded_at,
        'updated_at', connection.updated_at
      ) from public.contact_connections connection
      where connection.organization_id = membership.organization_id
        and p_actor_user_id in (connection.member_low_user_id, connection.member_high_user_id)
        and membership.user_id in (connection.member_low_user_id, connection.member_high_user_id)
        and membership.user_id <> p_actor_user_id) as connection
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and (
        membership.user_id = p_actor_user_id
        or (
          membership.directory_visibility <> 'private'
          and not exists (
            select 1 from public.member_blocks block
            where block.organization_id = membership.organization_id
              and (
                (block.blocker_user_id = p_actor_user_id and block.blocked_user_id = membership.user_id)
                or (block.blocker_user_id = membership.user_id and block.blocked_user_id = p_actor_user_id)
              )
          )
          and (
            membership.directory_visibility = 'organization'
          )
        )
      )
    order by profile.display_name, membership.user_id
    limit 500
  ) visible;

  select coalesce(jsonb_agg(jsonb_build_object(
    'counterpart_user_id', connection.counterpart_user_id,
    'status', connection.status,
    'requested_by_user_id', connection.requested_by_user_id,
    'created_at', connection.created_at,
    'responded_at', connection.responded_at,
    'updated_at', connection.updated_at
  ) order by connection.updated_at desc, connection.counterpart_user_id), '[]'::jsonb)
  into v_connections
  from (
    select case when raw.member_low_user_id = p_actor_user_id
        then raw.member_high_user_id else raw.member_low_user_id end as counterpart_user_id,
      raw.status, raw.requested_by_user_id, raw.created_at, raw.responded_at, raw.updated_at
    from public.contact_connections raw
    where raw.organization_id = p_organization_id
      and p_actor_user_id in (raw.member_low_user_id, raw.member_high_user_id)
    order by raw.updated_at desc
    limit 500
  ) connection;

  select coalesce(jsonb_agg(enriched.item order by enriched.ordinality), '[]'::jsonb)
  into v_conversations
  from (
    select item.ordinality,
      item.value || jsonb_build_object(
        'direct_counterpart_user_id', case when item.value ->> 'kind' = 'direct' then (
          select case when pair.member_low_user_id = p_actor_user_id
            then pair.member_high_user_id else pair.member_low_user_id end
          from public.direct_conversation_pairs pair
          where pair.organization_id = p_organization_id
            and pair.conversation_id = (item.value ->> 'conversation_id')::uuid
            and p_actor_user_id in (pair.member_low_user_id, pair.member_high_user_id)
        ) else null end,
        'member_count', (
          select count(*) from public.conversation_members member
          join public.organization_memberships organization_member
            on organization_member.organization_id = member.organization_id
           and organization_member.user_id = member.user_id
           and organization_member.status = 'active'
          where member.organization_id = p_organization_id
            and member.conversation_id = (item.value ->> 'conversation_id')::uuid
            and member.status = 'active'
        ),
        -- Who is in this conversation, as bare ids, for every conversation and
        -- not only the selected one. The full member objects below are heavy
        -- (names, avatars, roles, notification state) and stay where they
        -- were; the ids are what tells a reader that a group holds two people
        -- they named in the Chats search, and the client had no way to know it
        -- for any chat the server had not been asked about.
        'member_ids', (
          select coalesce(jsonb_agg(to_jsonb(listed_id.user_id) order by listed_id.user_id), '[]'::jsonb)
          from (
            select member.user_id
            from public.conversation_members member
            join public.organization_memberships organization_member
              on organization_member.organization_id = member.organization_id
             and organization_member.user_id = member.user_id
             and organization_member.status = 'active'
            where member.organization_id = p_organization_id
              and member.conversation_id = (item.value ->> 'conversation_id')::uuid
              and member.status = 'active'
            order by member.user_id
            limit 500
          ) listed_id
        ),
        'members', case
          when (item.value ->> 'conversation_id')::uuid = v_selected
            or item.value ->> 'kind' = 'direct'
          then (
            select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'user_id', listed.user_id,
              'display_name', listed.display_name,
              'avatar_path', listed.avatar_path,
              'role', listed.role,
              'can_post', listed.can_post,
              'notification_level', listed.notification_level,
              'muted_until', listed.muted_until
            )) order by listed.display_name, listed.user_id), '[]'::jsonb)
            from (
              select member.user_id, profile.display_name, profile.avatar_path,
                member.role, member.can_post, member.notification_level, member.muted_until
              from public.conversation_members member
              join public.organization_memberships organization_member
                on organization_member.organization_id = member.organization_id
               and organization_member.user_id = member.user_id
               and organization_member.status = 'active'
              join public.profiles profile on profile.user_id = member.user_id
              where member.organization_id = p_organization_id
                and member.conversation_id = (item.value ->> 'conversation_id')::uuid
                and member.status = 'active'
              order by profile.display_name, member.user_id
              limit 500
            ) listed
          ) else '[]'::jsonb end
      ) as item
    from jsonb_array_elements(coalesce(v_base -> 'conversations', '[]'::jsonb))
      with ordinality as item(value, ordinality)
  ) enriched;

  -- The workplace update workflow is gone, so this is always empty.
  v_updates := '[]'::jsonb;

  -- The shift-handoff workflow is gone, so this is always empty.
  v_handoffs := '[]'::jsonb;

  select coalesce(jsonb_agg(row.payload order by row.created_at desc, row.summary_id), '[]'::jsonb)
  into v_summaries
  from (
    select summary.id as summary_id, summary.created_at,
      jsonb_build_object(
        'summary_id', summary.id,
        'version_number', summary.version_number,
        'conversation_id', summary.conversation_id,
        'correction_of_summary_id', summary.correction_of_summary_id,
        'status', summary.status,
        'primary_topic', summary.primary_topic,
        'summary_body', summary.summary_body,
        'key_topics', summary.key_topics,
        'decisions', summary.decisions,
        'action_items', summary.action_items,
        'ambiguities', summary.ambiguities,
        'language_code', summary.language_code,
        'source_message_ids', summary.source_message_ids,
        'source_first_message_id', summary.source_first_message_id,
        'source_last_message_id', summary.source_last_message_id,
        'source_fingerprint', encode(summary.source_fingerprint, 'hex'),
        'source_fingerprint_hex', encode(summary.source_fingerprint, 'hex'),
        'output_fingerprint', case when summary.output_fingerprint is null
          then null else encode(summary.output_fingerprint, 'hex') end,
        'requested_by_user_id', summary.requested_by_user_id,
        'scope_kind', summary.scope_kind,
        'scope_subject', summary.scope_subject,
        'source_message_count', cardinality(summary.source_message_ids),
        'request_mode', summary.request_mode,
        'processor_type', summary.processor_type,
        'provider', summary.provider,
        'model', summary.model,
        -- Never return prompts, token counts, generation identifiers, or the
        -- detailed source map stored for audit. Clients receive only routing
        -- policy provenance required to explain whether an output is current.
        'processor_provenance', jsonb_strip_nulls(jsonb_build_object(
          'organization_ai_policy_version', coalesce(
            summary.processor_provenance -> 'organizationAiPolicyVersion',
            summary.processor_provenance -> 'organization_ai_policy_version'
          ),
          'route_policy_version', coalesce(
            summary.processor_provenance -> 'routePolicyVersion',
            summary.processor_provenance -> 'route_policy_version'
          ),
          'provider_route', coalesce(
            summary.processor_provenance -> 'providerRoute',
            summary.processor_provenance -> 'provider_route'
          )
        )),
        'failure_code', summary.failure_code,
        'reviewed_by_user_id', summary.reviewed_by_user_id,
        'reviewed_at', summary.reviewed_at,
        'review_note', summary.review_note,
        'source_state', case
          when summary.status = 'stale'
            or not private.summary_source_is_current_internal(
              summary.organization_id,
              summary.conversation_id,
              summary.source_message_ids,
              summary.source_fingerprint
            ) then 'stale'
          else 'current'
        end,
        'policy_state', case
          when summary.processor_type is distinct from 'ai' then 'not_applicable'
          when ai_policy.organization_id is not null
            and ai_policy.enabled
            and ai_policy.revoked_at is null
            and ai_policy.route_policy = 'approved_zero_retention'
            and 'summary' = any(ai_policy.approved_use_cases)
            and summary.provider = any(ai_policy.provider_allowlist)
            and coalesce(
              summary.processor_provenance ->> 'organizationAiPolicyVersion',
              summary.processor_provenance ->> 'organization_ai_policy_version'
            ) = ai_policy.policy_version::text then 'current'
          else 'stale'
        end,
        'created_at', summary.created_at,
        'updated_at', summary.updated_at
      ) as payload
    from public.conversation_summaries summary
    join public.conversation_members member
      on member.organization_id = summary.organization_id
     and member.conversation_id = summary.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    left join public.organization_ai_policies ai_policy
      on ai_policy.organization_id = summary.organization_id
    where summary.organization_id = p_organization_id
      and not exists (
        select 1 from unnest(summary.source_message_ids) source_id
        join public.messages source_message
          on source_message.organization_id = summary.organization_id
         and source_message.conversation_id = summary.conversation_id
         and source_message.id = source_id
        where source_message.deleted_at is not null
          or source_message.available_at > now()
          or (member.history_visible_from is not null
            and source_message.created_at < member.history_visible_from)
      )
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = summary.organization_id
          and visibility.conversation_id = summary.conversation_id
          and visibility.message_id = any(summary.source_message_ids)
          and visibility.user_id = p_actor_user_id
      )
    order by summary.created_at desc, summary.id
    limit 100
  ) row;

  -- The operational-action workflow is gone, so this is always empty.
  v_actions := '[]'::jsonb;

  if private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'reports.investigate', null
  ) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'report_id', report.id,
      'conversation_id', report.conversation_id,
      'message_id', report.message_id,
      'category', report.category,
      'status', report.status,
      'created_at', report.created_at
    ) order by report.created_at desc, report.id), '[]'::jsonb)
    into v_moderation_reports
    from (
      select * from private.message_reports report
      where report.organization_id = p_organization_id
      order by report.created_at desc, report.id
      limit 100
    ) report;
  end if;
  if private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'audit.read', null
  ) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'audit_event_id', event.id,
      'actor_user_id', event.actor_user_id,
      'event_type', event.event_type,
      'target_type', event.target_type,
      'target_id', event.target_id,
      'request_id', event.request_id,
      'metadata', event.metadata,
      'occurred_at', event.occurred_at
    ) order by event.occurred_at desc, event.id desc), '[]'::jsonb)
    into v_audit_events
    from (
      select * from public.audit_events event
      where event.organization_id = p_organization_id
      order by event.occurred_at desc, event.id desc
      limit 100
    ) event;
  end if;

  return v_base || jsonb_build_object(
    'schema_version', 1,
    'organization', v_organization,
    'current_user', v_current_user,
    'capabilities', v_capabilities,
    'scopes', v_scopes,
    'realtime', jsonb_build_object(
      'inbox_topic', 'org:' || p_organization_id::text || ':user:'
        || p_actor_user_id::text || ':inbox',
      'control_topic', 'org:' || p_organization_id::text || ':user:'
        || p_actor_user_id::text || ':control'
    ),
    'units', v_units,
    'directory', v_directory,
    'connections', v_connections,
    'conversations', v_conversations,
    'updates', v_updates,
    'handoffs', v_handoffs,
    'summaries', v_summaries,
    'actions', v_actions,
    'moderation_reports', v_moderation_reports,
    'audit_events', v_audit_events,
    'reconcile_after', now()
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v7_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_conversations jsonb;
  v_messages jsonb;
  v_updates jsonb;
  v_handoffs jsonb;
  v_summaries jsonb;
  v_actions jsonb;
  v_reports jsonb;
  v_discoverable jsonb;
  v_selected uuid;
begin
  v_result := private.bff_bootstrap_messaging_state_v7_pre_dynamic_group_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  select coalesce(jsonb_agg(
    private.dynamic_group_conversation_list_item_for_user(
      p_organization_id, p_actor_user_id, item.value, now()
    ) order by item.ordinality
  ), '[]'::jsonb) into v_conversations
  from jsonb_array_elements(coalesce(v_result -> 'conversations', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          item.value,
          '{reply}',
          case when item.value #>> '{reply,message_id}' is null
            or private.dynamic_group_message_access_allowed_for_user(
              p_organization_id, (item.value ->> 'conversation_id')::uuid,
              (item.value #>> '{reply,message_id}')::bigint,
              p_actor_user_id, now()
            ) then coalesce(item.value -> 'reply', 'null'::jsonb)
            else 'null'::jsonb end,
          true
        ),
        '{receipt}',
        case when private.dynamic_group_policy_conversation(
          p_organization_id, (item.value ->> 'conversation_id')::uuid
        ) then coalesce(private.dynamic_group_receipt_payload_for_user(
          p_organization_id, (item.value ->> 'conversation_id')::uuid,
          (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
        ), 'null'::jsonb)
        else coalesce(item.value -> 'receipt', 'null'::jsonb) end,
        true
      ),
      '{forward}',
      case when item.value #>> '{forward,source_message_id}' is null
        or private.dynamic_group_message_access_allowed_for_user(
          p_organization_id,
          (item.value #>> '{forward,source_conversation_id}')::uuid,
          (item.value #>> '{forward,source_message_id}')::bigint,
          p_actor_user_id, now()
        ) then coalesce(item.value -> 'forward', 'null'::jsonb)
        else '{"forwarded":true}'::jsonb end,
      true
    ) order by item.ordinality
  ), '[]'::jsonb)
    into v_messages
  from jsonb_array_elements(coalesce(v_result #> '{timeline,messages}', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id,
    (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint,
    p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_updates
  from jsonb_array_elements(coalesce(v_result -> 'updates', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_handoffs
  from jsonb_array_elements(coalesce(v_result -> 'handoffs', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where not exists (
    select 1 from jsonb_array_elements_text(
      coalesce(item.value -> 'source_message_ids', '[]'::jsonb)
    ) source_id(value)
    where not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      source_id.value::bigint, p_actor_user_id, now()
    )
  ) and private.dynamic_group_timestamp_access_allowed(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id,
    null::timestamptz, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_summaries
  from jsonb_array_elements(coalesce(v_result -> 'summaries', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where not exists (
    select 1 from jsonb_array_elements_text(
      coalesce(item.value -> 'source_message_ids', '[]'::jsonb)
    ) source_id(value)
    where not private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      source_id.value::bigint, p_actor_user_id, now()
    )
  ) and private.dynamic_group_timestamp_access_allowed(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    p_actor_user_id, (item.value ->> 'created_at')::timestamptz, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_actions
  from jsonb_array_elements(coalesce(v_result -> 'actions', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where case when item.value ->> 'source_message_id' is null
    then private.dynamic_group_timestamp_access_allowed(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      p_actor_user_id, (item.value ->> 'created_at')::timestamptz, now()
    ) else private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (item.value ->> 'conversation_id')::uuid,
      (item.value ->> 'source_message_id')::bigint, p_actor_user_id, now()
    ) end;

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_reports
  from jsonb_array_elements(coalesce(v_result -> 'moderation_reports', '[]'::jsonb))
    with ordinality item(value, ordinality)
  where private.dynamic_group_message_access_allowed_for_user(
    p_organization_id, (item.value ->> 'conversation_id')::uuid,
    (item.value ->> 'message_id')::bigint, p_actor_user_id, now()
  );

  select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
    into v_discoverable
  from jsonb_array_elements(coalesce(
    v_result -> 'discoverable_conversations', '[]'::jsonb
  )) with ordinality item(value, ordinality)
  where not private.dynamic_group_policy_conversation(
    p_organization_id, (item.value ->> 'conversation_id')::uuid
  );

  v_selected := nullif(v_result ->> 'selected_conversation_id', '')::uuid;
  if v_selected is not null and not private.dynamic_group_conversation_access_allowed_for_user(
    p_organization_id, v_selected, p_actor_user_id, now()
  ) then
    v_selected := null;
    v_messages := '[]'::jsonb;
  end if;
  v_result := jsonb_set(v_result, '{conversations}', v_conversations, true);
  v_result := jsonb_set(v_result, '{timeline,messages}', v_messages, true);
  v_result := jsonb_set(v_result, '{updates}', v_updates, true);
  v_result := jsonb_set(v_result, '{handoffs}', v_handoffs, true);
  v_result := jsonb_set(v_result, '{summaries}', v_summaries, true);
  v_result := jsonb_set(v_result, '{actions}', v_actions, true);
  v_result := jsonb_set(v_result, '{moderation_reports}', v_reports, true);
  v_result := jsonb_set(
    v_result, '{discoverable_conversations}', v_discoverable, true
  );
  v_result := jsonb_set(
    v_result, '{selected_conversation_id}',
    coalesce(to_jsonb(v_selected), 'null'::jsonb), true
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_v8_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_directory jsonb;
  v_connections jsonb;
  v_saved_contacts jsonb;
  v_member_blocks jsonb;
  v_viewer_type text;
  v_viewer_expiry timestamptz;
  v_viewer_sponsor uuid;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v7_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  select membership.membership_type, membership.access_expires_at,
      membership.guest_sponsor_user_id
    into v_viewer_type, v_viewer_expiry, v_viewer_sponsor
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );
  if not found then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;

  -- In the personal realm every account is a member of the one organization,
  -- so this asks can_view_org_member_for_actor about every user of the app and
  -- builds a full row for each - and then V10 discards the answer and rebuilds
  -- the directory from the people this reader actually has a connection or a
  -- conversation with. Measured on the live stack: 210 people built here, 3
  -- kept, and the cost grew with the size of the whole user base. Skip it and
  -- let V10 be the one that answers.
  if p_organization_id = private.personal_realm_organization_id() then
    v_directory := '[]'::jsonb;
  else
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'user_id', visible.user_id,
      'display_name', visible.display_name,
      'avatar_path', visible.avatar_path,
      'status_message', visible.status_message,
      'preferred_language', visible.preferred_language,
      'time_zone', visible.time_zone,
      'membership_role', visible.membership_role,
      'membership_type', visible.membership_type,
      'membership_status', visible.membership_status,
      'access_expires_at', visible.access_expires_at,
      'job_title', visible.job_title,
      'directory_visibility', visible.directory_visibility,
      'unit_ids', visible.unit_ids,
      'is_saved_contact', visible.is_saved_contact,
      'is_blocked', visible.is_blocked,
      'connection', visible.connection
    )) order by visible.display_name, visible.user_id), '[]'::jsonb)
    into v_directory
    from (
      select membership.user_id, profile.display_name, profile.avatar_path,
        profile.status_message, profile.preferred_language, profile.time_zone,
        membership.role as membership_role,
        membership.membership_type, membership.status as membership_status,
        membership.access_expires_at, membership.job_title,
        membership.directory_visibility,
        '[]'::jsonb as unit_ids,
        exists (
          select 1 from public.saved_contacts saved
          where saved.organization_id = membership.organization_id
            and saved.owner_user_id = p_actor_user_id
            and saved.contact_user_id = membership.user_id
        ) as is_saved_contact,
        exists (
          select 1 from public.member_blocks block
          where block.organization_id = membership.organization_id
            and block.blocker_user_id = p_actor_user_id
            and block.blocked_user_id = membership.user_id
        ) as is_blocked,
        (
          select jsonb_build_object(
            'status', connection.status,
            'requested_by_user_id', connection.requested_by_user_id,
            'created_at', connection.created_at,
            'responded_at', connection.responded_at,
            'updated_at', connection.updated_at
          )
          from public.contact_connections connection
          where connection.organization_id = membership.organization_id
            and p_actor_user_id in (
              connection.member_low_user_id, connection.member_high_user_id
            )
            and membership.user_id in (
              connection.member_low_user_id, connection.member_high_user_id
            )
            and membership.user_id <> p_actor_user_id
        ) as connection
      from public.organization_memberships membership
      join public.profiles profile on profile.user_id = membership.user_id
      where membership.organization_id = p_organization_id
        and private.can_view_org_member_for_actor(
          p_organization_id, p_actor_user_id, membership.user_id, now()
        )
      order by profile.display_name, membership.user_id
      limit 500
    ) visible;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'counterpart_user_id', visible.counterpart_user_id,
    'status', visible.status,
    'requested_by_user_id', visible.requested_by_user_id,
    'created_at', visible.created_at,
    'responded_at', visible.responded_at,
    'updated_at', visible.updated_at
  ) order by visible.updated_at desc, visible.counterpart_user_id), '[]'::jsonb)
  into v_connections
  from (
    select case when connection.member_low_user_id = p_actor_user_id
        then connection.member_high_user_id else connection.member_low_user_id end
        as counterpart_user_id,
      connection.status, connection.requested_by_user_id,
      connection.created_at, connection.responded_at, connection.updated_at
    from public.contact_connections connection
    where connection.organization_id = p_organization_id
      and p_actor_user_id in (
        connection.member_low_user_id, connection.member_high_user_id
      )
      and private.can_view_org_member_for_actor(
        p_organization_id, p_actor_user_id,
        case when connection.member_low_user_id = p_actor_user_id
          then connection.member_high_user_id else connection.member_low_user_id end,
        now()
      )
    order by connection.updated_at desc
    limit 500
  ) visible;

  select coalesce(jsonb_agg(jsonb_build_object(
    'contact_user_id', contact.contact_user_id,
    'alias', contact.alias,
    'is_favorite', contact.is_favorite,
    'updated_at', contact.updated_at
  ) order by contact.is_favorite desc, contact.updated_at desc,
      contact.contact_user_id), '[]'::jsonb)
  into v_saved_contacts
  from public.saved_contacts contact
  where contact.organization_id = p_organization_id
    and contact.owner_user_id = p_actor_user_id
    and private.can_view_org_member_for_actor(
      p_organization_id, p_actor_user_id, contact.contact_user_id, now()
    );

  select coalesce(jsonb_agg(jsonb_build_object(
    'blocked_user_id', block.blocked_user_id,
    'blocked_at', block.created_at
  ) order by block.created_at desc, block.blocked_user_id), '[]'::jsonb)
  into v_member_blocks
  from public.member_blocks block
  where block.organization_id = p_organization_id
    and block.blocker_user_id = p_actor_user_id
    and private.can_view_org_member_for_actor(
      p_organization_id, p_actor_user_id, block.blocked_user_id, now()
    );

  v_result := jsonb_set(v_result, '{directory}', v_directory, true);
  v_result := jsonb_set(v_result, '{connections}', v_connections, true);
  v_result := jsonb_set(v_result, '{saved_contacts}', v_saved_contacts, true);
  v_result := jsonb_set(v_result, '{member_blocks}', v_member_blocks, true);
  if v_viewer_type = 'guest' then
    v_result := jsonb_set(v_result, '{units}', '[]'::jsonb, true);
  end if;
  v_result := jsonb_set(
    v_result, '{current_user}',
    coalesce(v_result -> 'current_user', '{}'::jsonb) ||
      jsonb_strip_nulls(jsonb_build_object(
        'membership_type', v_viewer_type,
        'access_expires_at', v_viewer_expiry,
        'guest_sponsor_user_id', v_viewer_sponsor
      )), true
  );
  v_result := jsonb_set(
    v_result, '{organization}',
    coalesce(v_result -> 'organization', '{}'::jsonb) || coalesce((
      select jsonb_build_object(
        'group_creation_policy', organization.group_creation_policy,
        'allow_external_guests', organization.allow_external_guests,
        'external_guest_max_access_days', organization.external_guest_max_access_days,
        'shift_schedule_authoritative', organization.shift_schedule_authoritative,
        'organization_policy_version', organization.organization_policy_version
      )
      from public.organizations organization
      where organization.id = p_organization_id
    ), '{}'::jsonb), true
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_create_account_recovery_case_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_factor_id uuid, p_factor_type text, p_factor_status text, p_reason text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_case_id uuid;
  v_privileged boolean;
  v_required_approvals smallint;
  v_security_event_id bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    'recovery.case.create',
    false,
    0,
    '/v2/auth/recovery/cases',
    p_idempotency_key,
    p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  if p_factor_id is null or p_factor_type <> 'totp' or p_factor_status <> 'verified'
    or char_length(btrim(coalesce(p_reason, ''))) not between 10 and 1000 then
    raise exception 'verified TOTP recovery request required' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
  ) then
    raise exception 'active target membership required' using errcode = '42501';
  end if;

  select membership.role in ('owner', 'admin') or false into v_privileged
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  v_required_approvals := case when v_privileged then 2 else 1 end;

  begin
    insert into private.account_recovery_cases (
      organization_id, target_user_id, requested_by_user_id,
      target_factor_id, target_factor_type, request_reason,
      privileged_target, required_approvals
    ) values (
      p_organization_id, p_actor_user_id, p_actor_user_id,
      p_factor_id, p_factor_type, btrim(p_reason),
      v_privileged, v_required_approvals
    ) returning id into v_case_id;
  exception when unique_violation then
    raise exception 'an active recovery case already exists for this member'
      using errcode = '23505';
  end;

  insert into private.account_recovery_case_events (
    recovery_case_id, organization_id, actor_user_id, event_type, metadata
  ) values (
    v_case_id, p_organization_id, p_actor_user_id, 'requested',
    jsonb_build_object(
      'privileged_target', v_privileged,
      'required_approvals', v_required_approvals,
      'human_verification', 'external_required'
    )
  );

  insert into private.account_security_events (
    user_id, organization_id, actor_user_id, event_type, recovery_case_id,
    metadata
  ) values (
    p_actor_user_id, p_organization_id, p_actor_user_id,
    'factor_reset_requested', v_case_id,
    jsonb_build_object(
      'privileged_target', v_privileged,
      'required_approvals', v_required_approvals
    )
  ) returning id into v_security_event_id;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'account.factor_reset.requested',
    'account_recovery_case', v_case_id::text,
    jsonb_build_object(
      'security_event_id', v_security_event_id,
      'target_user_id', p_actor_user_id,
      'privileged_target', v_privileged,
      'required_approvals', v_required_approvals,
      'human_verification', 'external_required'
    )
  );

  v_response := jsonb_build_object(
    'case_id', v_case_id,
    'status', 'awaiting_external_verification',
    'privileged_target', v_privileged,
    'required_approvals', v_required_approvals,
    'approvals_recorded', 0,
    'human_verification', jsonb_build_object(
      'performed_by_newone', false,
      'external_policy_required', true,
      'evidence_reference_stored_as_hash', true
    ),
    'expires_at', (
      select recovery_case.expires_at
      from private.account_recovery_cases recovery_case
      where recovery_case.id = v_case_id
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/auth/recovery/cases',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_create_group_conversation_v2_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_name text, p_description text, p_member_assignments jsonb, p_kind text, p_unit_id uuid, p_history_policy text, p_posting_mode text, p_join_policy text, p_incident_severity text, p_incident_classification text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_organization public.organizations%rowtype;
  v_conversation_id uuid := gen_random_uuid();
  v_effective_join_policy text;
  v_visibility text;
  v_member_count integer;
  v_history_visible_from timestamptz := case
    when p_history_policy = 'since_join' then statement_timestamp() else null end;
  v_assignment record;
  v_member_user_ids uuid[];
  v_existing_conversation_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.group.create', p_kind = 'incident',
    case when p_kind = 'incident' then 900 else 0 end,
    '/v2/conversations/group', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  select * into v_organization
  from public.organizations organization
  where organization.id = p_organization_id
  for share;
  if not found or not private.actor_can_create_group(
    p_actor_user_id, p_organization_id, p_unit_id
  ) then
    raise exception 'group creation is not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('group', 'team', 'shift', 'incident')
    or char_length(btrim(coalesce(p_name, ''))) not between 1 and 160
    or (p_description is not null
      and char_length(btrim(p_description)) not between 1 and 2000)
    or p_history_policy is null
    or p_history_policy not in ('all', 'since_join')
    or p_posting_mode is null
    or p_posting_mode not in ('all_members', 'admins_only')
    or p_join_policy is null
    or p_join_policy not in ('inherit', 'invite_only', 'approval_required')
    or (p_kind in ('shift', 'incident') and p_join_policy <> 'invite_only')
    or (
      p_kind = 'incident' and (
        p_incident_severity is null
        or p_incident_severity not in ('low', 'medium', 'high', 'critical')
        or char_length(btrim(coalesce(p_incident_classification, '')))
          not between 1 and 120
      )
    )
    or (
      p_kind <> 'incident'
      and (p_incident_severity is not null
        or p_incident_classification is not null)
    ) then
    raise exception 'invalid group creation policy' using errcode = '22023';
  end if;
  if p_kind = 'incident' and not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'conversation.manage', p_unit_id
  ) then
    raise exception 'incident creation requires administrator permission'
      using errcode = '42501';
  end if;
  if p_unit_id is not null and not false then
    raise exception 'active organization unit required' using errcode = '22023';
  end if;
  if p_unit_id is not null and not (
    false
    or private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'conversation.manage', null
    )
  ) then
    raise exception 'group creator is not authorized for organization unit'
      using errcode = '42501';
  end if;

  if p_member_assignments is null
    or jsonb_typeof(p_member_assignments) <> 'array'
    or jsonb_array_length(p_member_assignments) < 1
    or jsonb_array_length(p_member_assignments) >= v_organization.default_group_member_limit
    or octet_length(p_member_assignments::text) > 262144
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or not (item.value ? 'user_id' and item.value ? 'role')
        or exists (
          select 1 from jsonb_object_keys(item.value) supplied(key)
          where supplied.key not in ('user_id', 'role')
        )
        or jsonb_typeof(item.value -> 'user_id') <> 'string'
        or jsonb_typeof(item.value -> 'role') <> 'string'
        or item.value ->> 'role' not in ('owner', 'admin', 'member')
        or coalesce(item.value ->> 'user_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      where (item.value ->> 'user_id')::uuid = p_actor_user_id
    )
    or (
      select count(*) <> count(distinct item.value ->> 'user_id')
      from jsonb_array_elements(p_member_assignments) item(value)
    ) then
    raise exception 'invalid initial group member assignments' using errcode = '22023';
  end if;

  select jsonb_array_length(p_member_assignments) + 1 into v_member_count;

  -- A group is three people or more: you and at least two others. The rule is
  -- checked only here, at creation. A group that later drops to two because
  -- somebody left keeps working exactly as it did.
  if p_organization_id = private.personal_realm_organization_id()
    and v_member_count < 3 then
    raise exception 'a group needs at least three people' using errcode = '22023';
  end if;

  -- One group per set of people. The set always includes the creator, so a
  -- group they left has a different set (a new group is right) and a group
  -- they were added to matches (they belong in the one that exists).
  if p_organization_id = private.personal_realm_organization_id()
    and p_kind = 'group' then
    select array[p_actor_user_id] || coalesce(
        array_agg((item.value ->> 'user_id')::uuid), array[]::uuid[]
      )
      into v_member_user_ids
    from jsonb_array_elements(p_member_assignments) item(value);
    v_existing_conversation_id := private.existing_group_with_member_set_internal(
      p_organization_id, p_actor_user_id, v_member_user_ids
    );
    if v_existing_conversation_id is not null then
      return private.finish_bff_command_internal(
        p_actor_user_id, p_organization_id, '/v2/conversations/group',
        p_idempotency_key, p_request_sha256,
        jsonb_build_object(
          'already_exists', true,
          'conversation_id', v_existing_conversation_id
        ),
        200
      );
    end if;
  end if;
  if v_member_count > v_organization.default_group_member_limit
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      left join public.organization_memberships membership
        on membership.organization_id = p_organization_id
       and membership.user_id = (item.value ->> 'user_id')::uuid
      where membership.user_id is null
        or not private.organization_membership_access_current(
          p_organization_id, (item.value ->> 'user_id')::uuid, now()
        )
        or not private.can_view_org_member_for_actor(
          p_organization_id, p_actor_user_id,
          (item.value ->> 'user_id')::uuid, now()
        )
        or not private.group_member_candidate_permitted(
          p_organization_id, p_actor_user_id, (item.value ->> 'user_id')::uuid
        )
        or (membership.membership_type = 'guest' and (
          not v_organization.allow_external_guests
          or item.value ->> 'role' <> 'member'
        ))
    ) then
    raise exception 'initial group membership is not permitted' using errcode = '42501';
  end if;

  v_effective_join_policy := case when p_join_policy = 'inherit'
    then v_organization.default_group_join_policy else p_join_policy end;
  v_visibility := case
    when p_unit_id is not null then 'unit'
    when v_effective_join_policy = 'approval_required' then 'organization'
    else 'invite_only'
  end;

  insert into public.conversations (
    id, organization_id, kind, name, description, visibility, unit_id,
    history_policy, incident_severity, incident_classification,
    member_limit, posting_mode, join_policy, created_by_user_id
  ) values (
    v_conversation_id, p_organization_id, p_kind, btrim(p_name),
    case when p_description is null then null else btrim(p_description) end,
    v_visibility, p_unit_id, p_history_policy, p_incident_severity,
    case when p_incident_classification is null then null
      else btrim(p_incident_classification) end,
    v_organization.default_group_member_limit, p_posting_mode, p_join_policy,
    p_actor_user_id
  );

  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id, v_conversation_id, p_actor_user_id, 'owner',
    p_actor_user_id, v_history_visible_from
  );
  for v_assignment in
    select (item.value ->> 'user_id')::uuid as user_id,
      item.value ->> 'role' as role
    from jsonb_array_elements(p_member_assignments)
      with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    insert into public.conversation_members (
      organization_id, conversation_id, user_id, role, joined_by_user_id,
      history_visible_from
    ) values (
      p_organization_id, v_conversation_id, v_assignment.user_id,
      v_assignment.role, p_actor_user_id, v_history_visible_from
    );
  end loop;

  perform private.insert_conversation_system_event_internal(
    p_organization_id, v_conversation_id, p_actor_user_id,
    'conversation.created', null
  );
  for v_assignment in
    select (item.value ->> 'user_id')::uuid as user_id
    from jsonb_array_elements(p_member_assignments) item(value)
  loop
    perform private.insert_conversation_system_event_internal(
      p_organization_id, v_conversation_id, p_actor_user_id,
      'conversation.member.added', v_assignment.user_id
    );
  end loop;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.group.created',
    'conversation', v_conversation_id::text,
    jsonb_build_object(
      'kind', p_kind, 'member_count', v_member_count,
      'history_policy', p_history_policy, 'posting_mode', p_posting_mode,
      'join_policy', v_effective_join_policy,
      'guest_count', (
        select count(*)
        from jsonb_array_elements(p_member_assignments) item(value)
        join public.organization_memberships membership
          on membership.organization_id = p_organization_id
         and membership.user_id = (item.value ->> 'user_id')::uuid
        where membership.membership_type = 'guest'
      )
    )
  );

  v_response := jsonb_build_object(
    'conversation_id', v_conversation_id, 'kind', p_kind,
    'name', btrim(p_name),
    'description', case when p_description is null then null else btrim(p_description) end,
    'history_policy', p_history_policy,
    'history_disclosure', jsonb_build_object(
      'policy', p_history_policy, 'visible_from', v_history_visible_from,
      'label_key', case when p_history_policy = 'all'
        then 'conversation.history.all' else 'conversation.history.since_join' end
    ),
    'posting_mode', p_posting_mode,
    'join_policy', v_effective_join_policy,
    'configured_join_policy', p_join_policy,
    'visibility', v_visibility, 'member_count', v_member_count,
    'member_limit', v_organization.default_group_member_limit,
    'is_read_only', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/group',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
exception when invalid_text_representation then
  raise exception 'invalid initial group member assignments' using errcode = '22023';
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_leave_conversation_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_conversation_id uuid, p_replacement_owner_user_id uuid, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_kind text;
  v_visibility text;
  v_actor_role text;
  v_actor_managed_by_policy_id uuid;
  v_other_owner_count integer;
  v_left_at timestamptz := now();
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    'conversation.leave',
    false,
    0,
    '/v2/conversations/:id/leave',
    p_idempotency_key,
    p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then
    return v_command -> 'response';
  end if;

  -- Conversation first, then every active membership in UUID order. The same
  -- ordering is used by every invocation, so concurrent transfer/departure
  -- attempts cannot observe a partially transferred owner set.
  select conversation.kind, conversation.visibility, member.role,
    member.managed_by_policy_id
    into v_kind, v_visibility, v_actor_role, v_actor_managed_by_policy_id
  from public.conversations conversation
  join public.conversation_members member
    on member.organization_id = conversation.organization_id
   and member.conversation_id = conversation.id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  for update of conversation;

  if not found then
    raise exception 'conversation is not eligible for self-leave' using errcode = '42501';
  end if;

  perform member.user_id
  from public.conversation_members member
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.status = 'active'
  order by member.user_id
  for update;

  if v_kind <> 'group'
    or v_visibility <> 'invite_only'
    or v_actor_managed_by_policy_id is not null
    or false then
    raise exception 'conversation is not eligible for self-leave' using errcode = '42501';
  end if;

  select count(*)::integer into v_other_owner_count
  from public.conversation_members owner_member
  join public.organization_memberships organization_member
    on organization_member.organization_id = owner_member.organization_id
   and organization_member.user_id = owner_member.user_id
   and organization_member.status = 'active'
  where owner_member.organization_id = p_organization_id
    and owner_member.conversation_id = p_conversation_id
    and owner_member.user_id <> p_actor_user_id
    and owner_member.status = 'active'
    and owner_member.role = 'owner';

  if v_actor_role = 'owner' and v_other_owner_count = 0 then
    if p_replacement_owner_user_id is null
      or p_replacement_owner_user_id = p_actor_user_id
      or not exists (
        select 1
        from public.conversation_members replacement
        join public.organization_memberships replacement_organization_member
          on replacement_organization_member.organization_id = replacement.organization_id
         and replacement_organization_member.user_id = replacement.user_id
         and replacement_organization_member.status = 'active'
        where replacement.organization_id = p_organization_id
          and replacement.conversation_id = p_conversation_id
          and replacement.user_id = p_replacement_owner_user_id
          and replacement.status = 'active'
      ) then
      raise exception 'an active replacement owner is required' using errcode = '42501';
    end if;

    update public.conversation_members replacement
    set role = 'owner'
    where replacement.organization_id = p_organization_id
      and replacement.conversation_id = p_conversation_id
      and replacement.user_id = p_replacement_owner_user_id
      and replacement.status = 'active';
  elsif p_replacement_owner_user_id is not null then
    -- Reject ambiguous intent instead of silently promoting an unnecessary
    -- owner or using the replacement field as a membership oracle.
    raise exception 'replacement owner is not accepted for this departure'
      using errcode = '42501';
  end if;

  update public.conversation_members departing
  set status = 'left', left_at = v_left_at
  where departing.organization_id = p_organization_id
    and departing.conversation_id = p_conversation_id
    and departing.user_id = p_actor_user_id
    and departing.status = 'active';
  if not found then
    raise exception 'conversation is not eligible for self-leave' using errcode = '42501';
  end if;

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    event_type,
    target_type,
    target_id,
    metadata
  ) values (
    p_organization_id,
    p_actor_user_id,
    'conversation.member.left',
    'conversation',
    p_conversation_id::text,
    jsonb_build_object(
      'history_preserved', true,
      'future_access_revoked', true,
      'ownership_transferred',
        v_actor_role = 'owner' and v_other_owner_count = 0
    )
  );

  perform private.broadcast_conversation_departure_internal(
    p_organization_id,
    p_conversation_id,
    p_actor_user_id
  );

  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'left', true,
    'role_at_departure', v_actor_role,
    'ownership_transferred',
      v_actor_role = 'owner' and v_other_owner_count = 0,
    'history_preserved', true,
    'future_access_revoked', true,
    'left_at', v_left_at
  );

  return private.finish_bff_command_internal(
    p_actor_user_id,
    p_organization_id,
    '/v2/conversations/:id/leave',
    p_idempotency_key,
    p_request_sha256,
    v_response
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_list_discoverable_conversations_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_items jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.discover.read', false, 0
  );
  if p_limit not between 1 and 100 then
    raise exception 'invalid discoverable conversation limit' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row.payload order by row.name, row.conversation_id), '[]'::jsonb)
    into v_items
  from (
    select conversation.id as conversation_id, conversation.name,
      jsonb_strip_nulls(jsonb_build_object(
        'conversation_id', conversation.id,
        'kind', conversation.kind,
        'name', conversation.name,
        'description', conversation.description,
        'avatar_path', conversation.avatar_path,
        'visibility', conversation.visibility,
        'posting_mode', conversation.posting_mode,
        'join_policy', private.effective_conversation_join_policy(
          conversation.organization_id, conversation.id
        ),
        'member_count', (
          select count(*) from public.conversation_members member
          join public.organization_memberships organization_member
            on organization_member.organization_id = member.organization_id
           and organization_member.user_id = member.user_id
           and organization_member.status = 'active'
          where member.organization_id = conversation.organization_id
            and member.conversation_id = conversation.id
            and member.status = 'active'
        ),
        'history_disclosure', jsonb_build_object(
          'policy', conversation.history_policy,
          'visible_from', case when conversation.history_policy = 'since_join' then now() else null end,
          'label_key', case when conversation.history_policy = 'all'
            then 'conversation.history.all' else 'conversation.history.since_join' end
        ),
        'my_join_request', case when latest_request.id is null then null else jsonb_build_object(
          'request_id', latest_request.id,
          'status', case when latest_request.status = 'pending'
            and latest_request.expires_at <= clock_timestamp() then 'expired' else latest_request.status end,
          'version', latest_request.version,
          'requested_at', latest_request.requested_at,
          'expires_at', latest_request.expires_at,
          'decided_at', latest_request.decided_at
        ) end
      )) as payload
    from public.conversations conversation
    left join lateral null latest_request on true
    where conversation.organization_id = p_organization_id
      and private.conversation_join_request_eligible(
        p_actor_user_id, p_organization_id, conversation.id
      )
    order by conversation.name, conversation.id
    limit p_limit
  ) row;
  return jsonb_build_object('conversations', v_items);
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_list_group_creation_candidates_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_query text, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_candidates jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.group.candidates.read', false, 0
  );
  if p_limit not between 1 and 100
    or char_length(btrim(coalesce(p_query, ''))) > 120 then
    raise exception 'invalid group candidate query' using errcode = '22023';
  end if;
  if not private.actor_can_create_group(
      p_actor_user_id, p_organization_id, null
    ) and not false then
    raise exception 'group creation is not permitted' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', candidate.user_id,
    'display_name', candidate.display_name,
    'username', candidate.username,
    'avatar_path', candidate.avatar_path,
    'job_title', candidate.job_title,
    'membership_role', candidate.membership_role,
    'membership_type', candidate.membership_type,
    'access_expires_at', candidate.access_expires_at
  ) order by candidate.display_name, candidate.user_id), '[]'::jsonb)
  into v_candidates
  from (
    select membership.user_id, profile.display_name, profile.username::text as username, profile.avatar_path,
      membership.job_title, membership.role as membership_role,
      membership.membership_type, membership.access_expires_at
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id <> p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and private.can_view_org_member_for_actor(
        p_organization_id, p_actor_user_id, membership.user_id, now()
      )
      and private.group_member_candidate_permitted(
        p_organization_id, p_actor_user_id, membership.user_id
      )
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or private.normalize_search_text(profile.display_name) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'
        or private.normalize_search_text(coalesce(membership.job_title, '')) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'

        or lower(profile.username::text) like
          '%' || ltrim(lower(btrim(p_query)), '@') || '%'
      )
    order by profile.display_name, membership.user_id
    limit p_limit
  ) candidate;
  return jsonb_build_object('candidates', v_candidates, 'limit', p_limit);
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_report_target_v3_pre_dynamic_group_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_target_type text, p_conversation_id uuid, p_message_id bigint, p_subject_user_id uuid, p_category text, p_details text, p_consent_to_share boolean, p_context_before integer, p_context_after integer, p_notice_version text, p_idempotency_key text, p_request_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_command jsonb;
  v_route text;
  v_operation text;
  v_report_id uuid;
  v_existing private.message_reports%rowtype;
  v_target_identity bytea;
  v_target_label text;
  v_subject_user_id uuid;
  v_unit_id uuid;
  v_history_visible_from timestamptz;
  v_consent_at timestamptz;
  v_context_max_message_id bigint;
  v_response jsonb;
begin
  v_route := case p_target_type
    when 'message' then '/v2/messages/:id/report'
    when 'group' then '/v2/conversations/:id/report'
    when 'member' then '/v2/people/:id/report'
    else null
  end;
  v_operation := case p_target_type
    when 'message' then 'message.report'
    when 'group' then 'conversation.report'
    when 'member' then 'member.report'
    else null
  end;
  if v_route is null then
    raise exception 'valid moderation report target required' using errcode = '22023';
  end if;

  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    v_operation, false, 0, v_route,
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  if p_consent_to_share is not true
    or not (
      p_notice_version = 'moderation-report-v2'
      or (p_target_type = 'message' and p_notice_version = 'moderation-share-v1')
    )
    or p_category not in ('harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other')
    or p_context_before not between 0 and 2
    or p_context_after not between 0 and 2
    or (p_target_type <> 'message' and (p_context_before <> 0 or p_context_after <> 0))
    or (p_details is not null and (
      char_length(btrim(p_details)) > 2000
      or regexp_replace(p_details, E'[\\t\\n\\r]', '', 'g') ~ '[[:cntrl:]]'
    ))
    or not (
      (p_target_type = 'message' and p_conversation_id is not null
        and p_message_id is not null and p_subject_user_id is null)
      or (p_target_type = 'group' and p_conversation_id is not null
        and p_message_id is null and p_subject_user_id is null)
      or (p_target_type = 'member' and p_conversation_id is null
        and p_message_id is null and p_subject_user_id is not null)
    ) then
    raise exception 'valid report consent and bounded target scope required' using errcode = '22023';
  end if;

  if not private.consume_rate_limit(
    'moderation-report-hour',
    p_organization_id::text || ':' || p_actor_user_id::text,
    10, 3600
  ) then
    raise exception 'moderation report rate limit exceeded' using errcode = 'P0001';
  end if;

  v_consent_at := clock_timestamp();

  if p_target_type = 'message' then
    select message.sender_user_id, conversation.unit_id, member.history_visible_from,
      coalesce(
        nullif(left(regexp_replace(btrim(profile.display_name), '[[:cntrl:]]', ' ', 'g'), 160), ''),
        'Conversation participant'
      ),
      (
        select max(boundary.id)
        from public.messages boundary
        where boundary.organization_id = message.organization_id
          and boundary.conversation_id = message.conversation_id
          and boundary.available_at <= v_consent_at
      )
      into v_subject_user_id, v_unit_id, v_history_visible_from,
        v_target_label, v_context_max_message_id
    from public.messages message
    join public.conversations conversation
      on conversation.organization_id = message.organization_id
     and conversation.id = message.conversation_id
    join public.conversation_members member
      on member.organization_id = message.organization_id
     and member.conversation_id = message.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    join public.profiles profile on profile.user_id = message.sender_user_id
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_message_id
      and message.deleted_at is null
      and message.available_at <= v_consent_at
      and message.created_at <= v_consent_at
      and (member.history_visible_from is null or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
    for share of message;
    if not found then
      raise exception 'message is not available' using errcode = '42501';
    end if;
    if v_subject_user_id = p_actor_user_id then
      raise exception 'a reporter cannot report their own message' using errcode = '22023';
    end if;
    v_target_identity := extensions.digest(
      convert_to(
        'organization:' || p_organization_id::text
          || ':message:' || p_conversation_id::text || ':' || p_message_id::text,
        'UTF8'
      ),
      'sha256'
    );
  elsif p_target_type = 'group' then
    select conversation.unit_id,
      coalesce(
        nullif(left(regexp_replace(btrim(conversation.name), '[[:cntrl:]]', ' ', 'g'), 160), ''),
        'Unnamed group'
      )
      into v_unit_id, v_target_label
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
      and conversation.id = p_conversation_id
      and conversation.kind in ('group', 'team', 'shift', 'announcement', 'incident')
    for share of conversation;
    if not found then
      raise exception 'group is not available' using errcode = '42501';
    end if;
    v_target_identity := extensions.digest(
      convert_to(
        'organization:' || p_organization_id::text || ':group:' || p_conversation_id::text,
        'UTF8'
      ),
      'sha256'
    );
  else
    if p_subject_user_id = p_actor_user_id then
      raise exception 'a reporter cannot report themselves' using errcode = '22023';
    end if;
    select coalesce(
      nullif(left(regexp_replace(btrim(profile.display_name), '[[:cntrl:]]', ' ', 'g'), 160), ''),
      'Organization member'
    ) into v_target_label
    from public.organization_memberships target
    join public.organization_memberships viewer
      on viewer.organization_id = target.organization_id
     and viewer.user_id = p_actor_user_id
     and viewer.status = 'active'
    join public.profiles profile on profile.user_id = target.user_id
    where target.organization_id = p_organization_id
      and target.user_id = p_subject_user_id
      and (
        (
          target.status = 'active'
          and
          target.directory_visibility <> 'private'
          and not exists (
            select 1 from public.member_blocks block
            where block.organization_id = target.organization_id
              and (
                (block.blocker_user_id = p_actor_user_id
                  and block.blocked_user_id = target.user_id)
                or (block.blocker_user_id = target.user_id
                  and block.blocked_user_id = p_actor_user_id)
              )
          )
          and (
            target.directory_visibility = 'organization'
            or false
          )
        )
        -- Blocking and offboarding remove directory discovery and
        -- communication, but must not erase a safety-report route for a person
        -- the reporter already knew. These relationship branches deliberately
        -- accept suspended/deactivated targets while the viewer must remain an
        -- active member of the same tenant.
        or exists (
          select 1 from public.contact_connections connection
          where connection.organization_id = target.organization_id
            and connection.status = 'accepted'
            and p_actor_user_id in (
              connection.member_low_user_id, connection.member_high_user_id
            )
            and target.user_id in (
              connection.member_low_user_id, connection.member_high_user_id
            )
            and target.user_id <> p_actor_user_id
        )
        or exists (
          select 1
          from public.conversation_members viewer_conversation
          join public.conversation_members target_conversation
            on target_conversation.organization_id = viewer_conversation.organization_id
           and target_conversation.conversation_id = viewer_conversation.conversation_id
           and target_conversation.user_id = target.user_id
          where viewer_conversation.organization_id = p_organization_id
            and viewer_conversation.user_id = p_actor_user_id
            and viewer_conversation.joined_at
              <= coalesce(target_conversation.left_at, 'infinity'::timestamptz)
            and target_conversation.joined_at
              <= coalesce(viewer_conversation.left_at, 'infinity'::timestamptz)
        )
      )
    for share of target;
    if not found then
      raise exception 'member is not available' using errcode = '42501';
    end if;
    v_subject_user_id := p_subject_user_id;
    v_unit_id := null;
    v_target_identity := extensions.digest(
      convert_to(
        'organization:' || p_organization_id::text || ':member:' || p_subject_user_id::text,
        'UTF8'
      ),
      'sha256'
    );
  end if;

  select * into v_existing
  from private.message_reports report
  where report.organization_id = p_organization_id
    and report.reporter_user_id = p_actor_user_id
    and report.target_identity_sha256 = v_target_identity
    and report.status in ('open', 'assigned', 'in_review');
  if found then
    v_response := jsonb_build_object(
      'report_id', v_existing.id,
      'status', v_existing.status,
      'target_type', v_existing.target_type,
      'created', false,
      'reporter_identity_protected', true,
      'target_not_notified', true,
      'notice_version', v_existing.reporter_notice_version,
      'context_before', v_existing.context_before_count,
      'context_after', v_existing.context_after_count
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, v_route,
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;

  insert into private.message_reports (
    organization_id, target_type, target_label_snapshot, target_identity_sha256,
    conversation_id, message_id, reporter_user_id, subject_user_id,
    conversation_unit_id, category, details, status,
    reporter_notice_version, reporter_consent_at,
    context_before_count, context_after_count
  ) values (
    p_organization_id, p_target_type, v_target_label, v_target_identity,
    p_conversation_id, p_message_id, p_actor_user_id, v_subject_user_id,
    v_unit_id, p_category, nullif(btrim(p_details), ''), 'open',
    p_notice_version, v_consent_at, p_context_before, p_context_after
  )
  on conflict (organization_id, reporter_user_id, target_identity_sha256)
    where status in ('open', 'assigned', 'in_review')
  do nothing
  returning id into v_report_id;

  if v_report_id is null then
    select * into v_existing
    from private.message_reports report
    where report.organization_id = p_organization_id
      and report.reporter_user_id = p_actor_user_id
      and report.target_identity_sha256 = v_target_identity
      and report.status in ('open', 'assigned', 'in_review');
    if not found then
      raise exception 'report creation conflict' using errcode = '55000';
    end if;
    v_response := jsonb_build_object(
      'report_id', v_existing.id,
      'status', v_existing.status,
      'target_type', v_existing.target_type,
      'created', false,
      'reporter_identity_protected', true,
      'target_not_notified', true,
      'notice_version', v_existing.reporter_notice_version,
      'context_before', v_existing.context_before_count,
      'context_after', v_existing.context_after_count
    );
    return private.finish_bff_command_internal(
      p_actor_user_id, p_organization_id, v_route,
      p_idempotency_key, p_request_sha256, v_response, 200
    );
  end if;

  if p_target_type = 'message' then
    with visible as (
      select message.id, message.sender_user_id, message.kind, message.body, message.created_at
      from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.deleted_at is null
        and message.available_at <= v_consent_at
        and message.created_at <= v_consent_at
        and message.id <= v_context_max_message_id
        and (v_history_visible_from is null or message.created_at >= v_history_visible_from)
        and not exists (
          select 1 from public.message_user_visibility visibility
          where visibility.organization_id = message.organization_id
            and visibility.conversation_id = message.conversation_id
            and visibility.message_id = message.id
            and visibility.user_id = p_actor_user_id
        )
    ), before_rows as (
      select selected.*,
        -row_number() over (order by selected.id desc)::integer as relative_position
      from (
        select * from visible where id < p_message_id order by id desc limit p_context_before
      ) selected
    ), after_rows as (
      select selected.*, row_number() over (order by selected.id)::integer as relative_position
      from (
        select * from visible where id > p_message_id order by id limit p_context_after
      ) selected
    ), evidence as (
      select reported.id, reported.sender_user_id, reported.kind, reported.body,
        reported.created_at, 'reported'::text as relationship, 0 as relative_position
      from visible reported where reported.id = p_message_id
      union all
      select before_rows.id, before_rows.sender_user_id, before_rows.kind, before_rows.body,
        before_rows.created_at, 'context_before'::text, before_rows.relative_position
      from before_rows
      union all
      select after_rows.id, after_rows.sender_user_id, after_rows.kind, after_rows.body,
        after_rows.created_at, 'context_after'::text, after_rows.relative_position
      from after_rows
    )
    insert into private.moderation_case_evidence (
      organization_id, case_id, conversation_id, message_id, relationship,
      relative_position, sender_user_id, message_kind, message_body,
      message_created_at, body_sha256
    )
    select p_organization_id, v_report_id, p_conversation_id, evidence.id,
      evidence.relationship, evidence.relative_position, evidence.sender_user_id,
      evidence.kind, evidence.body, evidence.created_at,
      extensions.digest(convert_to(coalesce(evidence.body, ''), 'UTF8'), 'sha256')
    from evidence;
  end if;

  insert into private.moderation_case_history (
    organization_id, case_id, actor_user_id, event_type,
    from_status, to_status, reason, evidence_metadata
  ) values (
    p_organization_id, v_report_id, p_actor_user_id, 'reported',
    null, 'open', null,
    jsonb_build_object(
      'target_type', p_target_type,
      'notice_version', p_notice_version,
      'context_before', p_context_before,
      'context_after', p_context_after
    )
  );

  perform private.notify_moderation_viewers_internal(
    p_organization_id, v_report_id, 'open', 'case_available', 1
  );

  v_response := jsonb_build_object(
    'report_id', v_report_id,
    'status', 'open',
    'target_type', p_target_type,
    'created', true,
    'reporter_identity_protected', true,
    'target_not_notified', true,
    'notice_version', p_notice_version,
    'context_before', p_context_before,
    'context_after', p_context_after
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, v_route,
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_resolve_push_job_impl(p_worker_id uuid, p_job_id bigint, p_after_device_id uuid, p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job private.outbox_jobs%rowtype;
  v_deliveries jsonb;
  v_has_more boolean;
  v_next_device_id uuid;
  v_event jsonb;
  v_quiet_hours_override boolean := false;
begin
  perform private.require_service_role();
  if p_limit not between 1 and 1000 then
    raise exception 'invalid push delivery page size' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'push'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now();
  if not found then raise exception 'active push lease required' using errcode = '42501'; end if;
  if v_job.payload ? 'announcement_id' and v_job.payload ? 'announcement_version_id' then
    select false into v_quiet_hours_override;
  end if;
  v_event := jsonb_strip_nulls(jsonb_build_object(
    'event_type', case
      when v_job.payload ? 'announcement_id' then 'announcement.changed'
      when v_job.payload ? 'handoff_id' then 'handoff.changed'
      when v_job.payload ? 'message_id' then 'message.changed'
      when v_job.payload ? 'conversation_id' then 'conversation.changed'
      else 'organization.changed'
    end,
    'organization_id', v_job.organization_id,
    'conversation_id', v_job.payload -> 'conversation_id',
    'message_id', v_job.payload -> 'message_id',
    'announcement_id', v_job.payload -> 'announcement_id',
    'announcement_version_id', v_job.payload -> 'announcement_version_id',
    'handoff_id', v_job.payload -> 'handoff_id',
    'state', v_job.payload -> 'state'
  ));
  with eligible_users as null, candidate_devices as (
    select device.*,
      coalesce(
        device.notification_preview_override, preference.notification_preview
      ) as notification_preview,
      coalesce(
        device.sound_enabled_override, preference.sound_enabled
      ) as sound_enabled,
      coalesce(
        device.vibration_enabled_override, preference.vibration_enabled
      ) as vibration_enabled,
      preference.shift_aware_suppression,
      preference.time_zone, preference.quiet_hours_start,
      preference.quiet_hours_end, preference.quiet_days
    from public.device_registrations device
    join eligible_users eligible on eligible.user_id = device.user_id
    join auth.sessions device_session
      on device_session.id = device.session_id
     and device_session.user_id = device.user_id
    join auth.users device_user on device_user.id = device_session.user_id
    join private.session_installations session_binding
      on session_binding.session_id = device_session.id
     and session_binding.user_id = device.user_id
     and session_binding.installation_id = device.installation_id
     and session_binding.platform = device.platform
     and session_binding.revoked_at is null
    left join private.push_delivery_attempts existing_attempt
      on existing_attempt.outbox_job_id = p_job_id
     and existing_attempt.device_id = device.id
    left join private.session_revocations session_revocation
      on session_revocation.organization_id = device.organization_id
     and session_revocation.session_id = device_session.id
    left join public.organization_user_preferences preference
      on preference.organization_id = device.organization_id
     and preference.user_id = device.user_id
    where device.organization_id = v_job.organization_id
      and device.revoked_at is null
      and private.organization_membership_access_current(
        device.organization_id, device.user_id, now()
      )
      and session_revocation.session_id is null
      and (device_session.not_after is null or device_session.not_after > now())
      and (device_user.banned_until is null or device_user.banned_until <= now())
      -- The later device-preference resolver must retain the dynamic-group
      -- security boundary. Exact message access prevents a delayed job from
      -- notifying somebody about content created during an eligibility gap.
      and (
        nullif(v_job.payload ->> 'conversation_id', '') is null
        or not private.dynamic_group_policy_conversation(
          v_job.organization_id,
          nullif(v_job.payload ->> 'conversation_id', '')::uuid
        )
        or case
          when v_job.payload ? 'message_id' then
            private.dynamic_group_message_access_allowed_for_user(
              v_job.organization_id,
              nullif(v_job.payload ->> 'conversation_id', '')::uuid,
              nullif(v_job.payload ->> 'message_id', '')::bigint,
              device.user_id, now()
            )
          when v_job.payload ? 'handoff_id' then
            private.dynamic_group_user_currently_eligible(
              v_job.organization_id,
              nullif(v_job.payload ->> 'conversation_id', '')::uuid,
              device.user_id, now()
            ) and false
          else private.dynamic_group_user_currently_eligible(
            v_job.organization_id,
            nullif(v_job.payload ->> 'conversation_id', '')::uuid,
            device.user_id, now()
          )
        end
      )
      and (
        nullif(v_job.payload ->> 'conversation_id', '') is null
        or v_quiet_hours_override
        or exists (
          select 1
          from public.conversation_members notification_member
          join public.conversations notification_conversation
            on notification_conversation.organization_id = notification_member.organization_id
           and notification_conversation.id = notification_member.conversation_id
          left join public.conversation_preferences notification_preference
            on notification_preference.organization_id = notification_member.organization_id
           and notification_preference.conversation_id = notification_member.conversation_id
           and notification_preference.user_id = notification_member.user_id
          where notification_member.organization_id = v_job.organization_id
            and notification_member.conversation_id =
              nullif(v_job.payload ->> 'conversation_id', '')::uuid
            and notification_member.user_id = device.user_id
            and notification_member.status = 'active'
            and coalesce(
              notification_preference.notification_level,
              notification_member.notification_level,
              'all'
            ) <> 'none'
            and (
              case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end is null
              or case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end <= now()
              -- Being named cuts through a chat you have muted for a while:
              -- naming somebody is how you reach them when the room is noisy.
              -- Turning the chat off outright (notification_level 'none') is a
              -- different decision and still means off.
              or (
                v_job.payload ? 'message_id'
                and not (v_job.payload ? 'announcement_id')
                and not (v_job.payload ? 'handoff_id')
                and exists (
                  select 1
                  from public.message_mentions mention
                  where mention.organization_id = v_job.organization_id
                    and mention.conversation_id = notification_member.conversation_id
                    and mention.message_id = (v_job.payload ->> 'message_id')::bigint
                    and mention.mentioned_user_id = device.user_id
                )
              )
            )
            and (
              coalesce(
                notification_preference.notification_level,
                notification_member.notification_level,
                'all'
              ) <> 'mentions'
              or (
                v_job.payload ? 'message_id'
                and not (v_job.payload ? 'announcement_id')
                and not (v_job.payload ? 'handoff_id')
                and (
                  notification_conversation.kind = 'direct'
                  or exists (
                    select 1
                    from public.message_mentions mention
                    where mention.organization_id = v_job.organization_id
                      and mention.conversation_id = notification_member.conversation_id
                      and mention.message_id = (v_job.payload ->> 'message_id')::bigint
                      and mention.mentioned_user_id = device.user_id
                  )
                )
              )
            )
            and (
              not (v_job.payload ? 'message_id')
              or v_job.payload ? 'announcement_id'
              or v_job.payload ? 'handoff_id'
              or exists (
                select 1
                from public.messages pushed_message
                where pushed_message.organization_id = v_job.organization_id
                  and pushed_message.conversation_id = notification_member.conversation_id
                  and pushed_message.id = (v_job.payload ->> 'message_id')::bigint
                  and pushed_message.sender_user_id <> device.user_id
              )
            )
        )
      )
      and (
        existing_attempt.id is null
        or existing_attempt.status = 'pending'
        or (
          existing_attempt.status = 'retry_wait'
          and existing_attempt.next_attempt_at <= now()
        )
      )
      and (p_after_device_id is null or device.id > p_after_device_id)
    order by device.id
    limit p_limit + 1
  ), inserted_attempts as (
    insert into private.push_delivery_attempts (
      organization_id, outbox_job_id, device_id, user_id
    )
    select v_job.organization_id, p_job_id, candidate.id, candidate.user_id
    from candidate_devices candidate
    on conflict (outbox_job_id, device_id) do nothing
    returning id, device_id, status, next_attempt_at
  ), attempt_rows as (
    select inserted.id, inserted.device_id, inserted.status, inserted.next_attempt_at
    from inserted_attempts inserted
    union all
    select attempt.id, attempt.device_id, attempt.status, attempt.next_attempt_at
    from private.push_delivery_attempts attempt
    join candidate_devices candidate on candidate.id = attempt.device_id
    where attempt.outbox_job_id = p_job_id
      and not exists (
        select 1 from inserted_attempts inserted where inserted.device_id = attempt.device_id
      )
  ), page as (
    select candidate.*, attempt.id as attempt_id, attempt.status as dispatch_status,
      attempt.next_attempt_at
    from candidate_devices candidate
    join attempt_rows attempt on attempt.device_id = candidate.id
  ), numbered as (
    select page.*, row_number() over (order by page.id) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'device_id', numbered.id,
      'attempt_id', numbered.attempt_id,
      'dispatch_status', numbered.dispatch_status,
      'dispatchable', true,
      'next_attempt_at', numbered.next_attempt_at,
      'user_id', numbered.user_id,
      'installation_id', numbered.installation_id,
      'platform', numbered.platform,
      'push_token_ciphertext', numbered.push_token_ciphertext,
      'push_token_type', numbered.push_token_type,
      'push_project_id', numbered.push_project_id,
      'push_environment', numbered.push_environment,
      'locale', numbered.locale,
      'app_version', numbered.app_version,
      'currently_off_shift', private.currently_off_shift_internal(
        v_job.organization_id, numbered.user_id, now()
      ),
      'notification_class', case when v_quiet_hours_override
        then v_job.payload ->> 'notification_class' else 'routine' end,
      'critical_category', case when v_quiet_hours_override
        then v_job.payload ->> 'critical_category' else null end,
      'quiet_hours_override', v_quiet_hours_override,
      'quiet_hours_override_reason', case
        when v_quiet_hours_override
          then v_job.payload ->> 'quiet_hours_override_reason'
        else null
      end,
      'preferences', jsonb_build_object(
        'notification_preview', coalesce(numbered.notification_preview, 'generic'),
        'sound_enabled', coalesce(numbered.sound_enabled, true),
        'vibration_enabled', coalesce(numbered.vibration_enabled, true),
        'shift_aware_suppression', coalesce(numbered.shift_aware_suppression, false),
        'time_zone', coalesce(numbered.time_zone, 'UTC'),
        'quiet_hours_start', numbered.quiet_hours_start,
        'quiet_hours_end', numbered.quiet_hours_end,
        'quiet_days', coalesce(to_jsonb(numbered.quiet_days), '[0,1,2,3,4,5,6]'::jsonb)
      )
    ) order by numbered.id) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    (array_agg(numbered.id order by numbered.id)
      filter (where numbered.row_number = p_limit))[1]
  into v_deliveries, v_has_more, v_next_device_id
  from numbered;
  if not v_has_more then
    update private.outbox_jobs job
    set payload = job.payload || jsonb_build_object(
          'fanout_resolved', true,
          'fanout_count', (
            select count(*) from private.push_delivery_attempts attempt
            where attempt.outbox_job_id = p_job_id
          )
        ),
        updated_at = now()
    where job.id = p_job_id
      and job.claimed_by = p_worker_id
      and job.status = 'processing';
  end if;
  return jsonb_build_object(
    'job_id', p_job_id,
    'event', v_event,
    'deliveries', v_deliveries,
    'has_more', v_has_more,
    'next_device_id', case when v_has_more then v_next_device_id else null end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_search_v3_pre_dynamic_group_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_query text, p_types text[], p_cursor text, p_limit integer, p_sender_user_id uuid DEFAULT NULL::uuid, p_date_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_date_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_match_sources text[] DEFAULT NULL::text[], p_conversation_id uuid DEFAULT NULL::uuid, p_language text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_types text[];
  v_match_sources text[];
  v_query tsquery;
  v_query_hash text;
  v_types_hash text;
  v_filters_hash text;
  v_cursor_json jsonb;
  v_cursor_at timestamptz;
  v_cursor_type text;
  v_cursor_id text;
  v_results jsonb;
  v_has_more boolean;
  v_last_at timestamptz;
  v_last_type text;
  v_last_id text;
  v_next_cursor text;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'search.read', false, 0
  );
  if char_length(btrim(coalesce(p_query, ''))) not between 2 and 200
    or p_limit not between 1 and 50
    or (p_date_from is not null and not isfinite(p_date_from))
    or (p_date_to is not null and not isfinite(p_date_to))
    or (p_date_from is not null and p_date_to is not null and (
      p_date_to < p_date_from or p_date_to - p_date_from > interval '10 years'
    )) then
    raise exception 'invalid search request' using errcode = '22023';
  end if;
  if p_language is not null
    and p_language not in ('ko', 'es', 'en', 'mixed', 'und') then
    raise exception 'invalid search language filter' using errcode = '22023';
  end if;
  if p_conversation_id is not null and not exists (
    select 1
    from public.conversation_members filtered_member
    where filtered_member.organization_id = p_organization_id
      and filtered_member.conversation_id = p_conversation_id
      and filtered_member.user_id = p_actor_user_id
      and filtered_member.status = 'active'
  ) then
    raise exception 'conversation search filter denied' using errcode = '42501';
  end if;

  select array_agg(distinct requested_type order by requested_type)
    into v_types
  from unnest(coalesce(
    p_types,
    array['people', 'conversations', 'messages', 'announcements', 'handoffs']::text[]
  )) requested_type;
  if coalesce(cardinality(v_types), 0) not between 1 and 5
    or not (v_types <@ array[
      'people', 'conversations', 'messages', 'announcements', 'handoffs'
    ]::text[]) then
    raise exception 'invalid search entity types' using errcode = '22023';
  end if;

  select array_agg(distinct requested_source order by requested_source)
    into v_match_sources
  from unnest(coalesce(
    p_match_sources,
    array['original', 'translation', 'sender', 'attachment_filename']::text[]
  )) requested_source;
  if coalesce(cardinality(v_match_sources), 0) not between 1 and 4
    or not (v_match_sources <@ array[
      'original', 'translation', 'sender', 'attachment_filename'
    ]::text[])
    or (p_match_sources is not null and v_types <> array['messages']::text[])
    or (p_sender_user_id is not null and v_types <> array['messages']::text[]) then
    raise exception 'invalid search message filters' using errcode = '22023';
  end if;

  v_query := websearch_to_tsquery(
    'simple',
    regexp_replace(
      lower(extensions.unaccent(btrim(p_query))),
      '[^[:alnum:][:space:]"]+', ' ', 'g'
    )
  );
  if numnode(v_query) = 0 then
    raise exception 'search query has no searchable terms' using errcode = '22023';
  end if;
  v_query_hash := encode(
    extensions.digest(convert_to(lower(btrim(p_query)), 'UTF8'), 'sha256'), 'hex'
  );
  v_types_hash := encode(
    extensions.digest(convert_to(array_to_string(v_types, ','), 'UTF8'), 'sha256'), 'hex'
  );
  v_filters_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'sender_user_id', p_sender_user_id,
    'date_from', p_date_from,
    'date_to', p_date_to,
    'match_sources', case when p_match_sources is null then null else v_match_sources end,
    'conversation_id', p_conversation_id,
    'language', p_language
  )::text, 'UTF8'), 'sha256'), 'hex');

  if p_cursor is not null then
    begin
      if char_length(p_cursor) > 1536 or p_cursor !~ '^[A-Za-z0-9+/]+={0,2}$' then
        raise exception 'malformed cursor';
      end if;
      v_cursor_json := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      if jsonb_typeof(v_cursor_json) <> 'object'
        or (select count(*) from pg_catalog.jsonb_object_keys(v_cursor_json)) <> 7
        or not (v_cursor_json ?& array[
          'version', 'at', 'type', 'id', 'query_hash', 'types_hash', 'filters_hash'
        ])
        or v_cursor_json -> 'version' <> '1'::jsonb
        or coalesce(v_cursor_json ->> 'query_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(v_cursor_json ->> 'types_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(v_cursor_json ->> 'filters_hash', '') !~ '^[0-9a-f]{64}$' then
        raise exception 'malformed cursor payload';
      end if;
      v_cursor_at := (v_cursor_json ->> 'at')::timestamptz;
      v_cursor_type := v_cursor_json ->> 'type';
      v_cursor_id := v_cursor_json ->> 'id';
      if not isfinite(v_cursor_at)
        or not (v_cursor_type = any(v_types))
        or (v_cursor_type = 'messages' and v_cursor_id !~ '^[1-9][0-9]{0,18}$')
        or (v_cursor_type <> 'messages' and v_cursor_id !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        or v_cursor_json ->> 'query_hash' <> v_query_hash
        or v_cursor_json ->> 'types_hash' <> v_types_hash
        or v_cursor_json ->> 'filters_hash' <> v_filters_hash then
        raise exception 'cursor binding mismatch';
      end if;
    exception when others then
      raise exception 'invalid search cursor' using errcode = '22023';
    end;
  end if;

  with searchable as (
    select
      'people'::text as entity_type,
      membership.user_id::text as entity_id,
      profile.display_name as title,
      left(coalesce(membership.job_title, profile.status_message, ''), 240) as snippet,
      'profile'::text as matched_source,
      profile.preferred_language as matched_language,
      null::uuid as conversation_id,
      membership.updated_at as occurred_at
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where 'people' = any(v_types)
      and p_match_sources is null
      and p_sender_user_id is null
      and membership.organization_id = p_organization_id
      and membership.status = 'active'
      and (
        to_tsvector('simple', private.normalize_search_text(
          coalesce(profile.display_name, '') || ' ' || coalesce(profile.status_message, '')
        )) @@ v_query
        or to_tsvector('simple', private.normalize_search_text(
          coalesce(membership.job_title, '') || ' ' || coalesce(membership.employee_code, '')
        )) @@ v_query
      )
      and (
        membership.user_id = p_actor_user_id
        or exists (
          select 1 from public.organization_memberships viewer
          where viewer.organization_id = p_organization_id
            and viewer.user_id = p_actor_user_id
            and viewer.status = 'active'
            and viewer.role in ('owner', 'admin')
        )
        or (
          membership.directory_visibility <> 'private'
          and not exists (
            select 1 from public.member_blocks block
            where block.organization_id = p_organization_id
              and (
                (block.blocker_user_id = p_actor_user_id and block.blocked_user_id = membership.user_id)
                or (block.blocker_user_id = membership.user_id and block.blocked_user_id = p_actor_user_id)
              )
          )
          and (
            membership.directory_visibility = 'organization'
            or false
          )
        )
      )

    union all

    select
      'conversations', conversation.id::text,
      coalesce(conversation.name, 'Direct conversation'),
      left(coalesce(conversation.description, ''), 240),
      'conversation', null::text,
      conversation.id, conversation.updated_at
    from public.conversations conversation
    join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where 'conversations' = any(v_types)
      and (p_conversation_id is null or conversation.id = p_conversation_id)
      and p_match_sources is null
      and p_sender_user_id is null
      and conversation.organization_id = p_organization_id
      and to_tsvector('simple', private.normalize_search_text(
        coalesce(conversation.name, '') || ' ' || coalesce(conversation.description, '')
      )) @@ v_query

    union all

    select
      'messages', message.id::text, sender.display_name,
      left(case
        when 'original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query
          then message.body
        when matched_translation.effective_body is not null
          then matched_translation.effective_body
        when matched_attachment.file_name is not null then matched_attachment.file_name
        else sender.display_name
      end, 240),
      case
        when 'original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query
          then 'original'
        when matched_translation.effective_body is not null then 'translation'
        when matched_attachment.file_name is not null then 'attachment_filename'
        else 'sender'
      end,
      case
        when 'original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query
          then message.detected_language
        when matched_translation.effective_body is not null
          then matched_translation.target_language
        else null
      end,
      message.conversation_id, message.created_at
    from public.messages message
    join public.conversation_members member
      on member.organization_id = message.organization_id
     and member.conversation_id = message.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.profiles sender on sender.user_id = message.sender_user_id
    left join lateral (
      select
        coalesce(approved_correction.corrected_body, translation.translated_body) as effective_body,
        translation.target_language
      from public.message_translations translation
      left join lateral (
        select correction.corrected_body
        from public.translation_corrections correction
        where correction.organization_id = translation.organization_id
          and correction.conversation_id = translation.conversation_id
          and correction.message_id = translation.message_id
          and correction.target_language = translation.target_language
          and correction.status = 'approved'
        order by correction.reviewed_at desc nulls last, correction.created_at desc, correction.id desc
        limit 1
      ) approved_correction on true
      where 'translation' = any(v_match_sources)
        and (p_language is null or translation.target_language = p_language)
        and translation.organization_id = message.organization_id
        and translation.conversation_id = message.conversation_id
        and translation.message_id = message.id
        and translation.status = 'completed'
        and translation.source_body_sha256 = extensions.digest(
          convert_to(message.body, 'UTF8'), 'sha256'
        )
        and to_tsvector('simple', private.normalize_search_text(
          coalesce(approved_correction.corrected_body, translation.translated_body)
        )) @@ v_query
      order by translation.target_language, translation.id
      limit 1
    ) matched_translation on true
    left join lateral (
      select attachment.file_name
      from public.message_attachments attachment
      where 'attachment_filename' = any(v_match_sources)
        and attachment.organization_id = message.organization_id
        and attachment.conversation_id = message.conversation_id
        and attachment.message_id = message.id
        and attachment.scan_status = 'clean'
        and attachment.file_name_search @@ v_query
      order by attachment.id
      limit 1
    ) matched_attachment on true
    where 'messages' = any(v_types)
      and message.organization_id = p_organization_id
      and (p_conversation_id is null or message.conversation_id = p_conversation_id)
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and (p_sender_user_id is null or message.sender_user_id = p_sender_user_id)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
      and (
        ('original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query)
        or ('sender' = any(v_match_sources) and to_tsvector(
          'simple', private.normalize_search_text(sender.display_name)
        ) @@ v_query)
        or matched_translation.effective_body is not null
        or matched_attachment.file_name is not null
      )

  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'type', numbered.entity_type,
        'id', numbered.entity_id,
        'title', numbered.title,
        'snippet', numbered.snippet,
        'matched_source', numbered.matched_source,
        'matched_language', numbered.matched_language,
        'conversation_id', numbered.conversation_id,
        'occurred_at', numbered.occurred_at
      ) order by numbered.occurred_at desc, numbered.entity_type desc, numbered.entity_id desc
    ) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    max(numbered.occurred_at) filter (where numbered.row_number = p_limit),
    max(numbered.entity_type) filter (where numbered.row_number = p_limit),
    max(numbered.entity_id) filter (where numbered.row_number = p_limit)
  into v_results, v_has_more, v_last_at, v_last_type, v_last_id
  from numbered;

  if v_has_more then
    v_next_cursor := replace(encode(convert_to(jsonb_build_object(
      'version', 1,
      'at', v_last_at,
      'type', v_last_type,
      'id', v_last_id,
      'query_hash', v_query_hash,
      'types_hash', v_types_hash,
      'filters_hash', v_filters_hash
    )::text, 'UTF8'), 'base64'), E'\n', '');
  end if;
  return jsonb_build_object(
    'results', v_results,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more
  );
end;
$function$;

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
      and not false
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
  return v_target.directory_visibility = 'unit' and false;
end;
$function$;

CREATE OR REPLACE FUNCTION private.conversation_departure_options_internal(p_actor_user_id uuid, p_organization_id uuid, p_conversation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_kind text;
  v_visibility text;
  v_role text;
  v_restriction text;
  v_active_owner_count integer;
  v_policy_managed boolean;
begin
  select conversation.kind, conversation.visibility, member.role,
    false or member.managed_by_policy_id is not null
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

CREATE OR REPLACE FUNCTION private.conversation_join_request_eligible(p_actor_user_id uuid, p_organization_id uuid, p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.conversations conversation
    join public.organizations organization
      on organization.id = conversation.organization_id
    join public.organization_memberships requester
      on requester.organization_id = conversation.organization_id
     and requester.user_id = p_actor_user_id
     and requester.membership_type <> 'guest'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and private.organization_membership_access_current(
        requester.organization_id, requester.user_id, now()
      )
      and conversation.kind in ('group', 'team')
      and conversation.visibility in ('organization', 'unit')
      and not conversation.is_archived
      and conversation.closed_at is null
      and case when conversation.visibility = 'invite_only' then 'invite_only'
        when conversation.join_policy = 'inherit'
        then organization.default_group_join_policy else conversation.join_policy end
        = 'approval_required'
      and (
        conversation.visibility = 'organization'
        or false
      )
      and not false
      and not exists (
        select 1 from public.conversation_members member
        where member.organization_id = conversation.organization_id
          and member.conversation_id = conversation.id
          and member.user_id = p_actor_user_id
          and member.status = 'active'
      )
  )
$function$;

CREATE OR REPLACE FUNCTION private.currently_off_shift_internal(p_organization_id uuid, p_user_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case
    when not coalesce((
      select organization.shift_schedule_authoritative
      from public.organizations organization
      where organization.id = p_organization_id
    ), false) then null::boolean
    else not false
  end
$function$;

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
        when 'scoped_unit' then false
        else false
      end
  )
$function$;

CREATE OR REPLACE FUNCTION private.dynamic_group_conversation_access_allowed_for_user(p_organization_id uuid, p_conversation_id uuid, p_user_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1 from public.organization_memberships organization_member
    where organization_member.organization_id = p_organization_id
      and organization_member.user_id = p_user_id
      and organization_member.status = 'active'
  ) and (exists (
      select 1 from public.conversation_members member
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.user_id = p_user_id and member.status = 'active'
    ))
$function$;

CREATE OR REPLACE FUNCTION private.dynamic_group_policy_conversation(p_organization_id uuid, p_conversation_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION private.dynamic_group_policy_spec_is_live(p_organization_id uuid, p_spec jsonb, p_evaluated_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_spec jsonb;
  v_shift_mode text;
begin
  if p_organization_id is null or p_evaluated_at is null
    or not isfinite(p_evaluated_at) then
    return false;
  end if;
  v_spec := private.normalize_dynamic_group_policy_spec(p_spec);
  v_shift_mode := v_spec ->> 'shift_mode';

  if not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
  ) or (v_shift_mode <> 'none' and not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.shift_schedule_authoritative
  )) then
    return false;
  end if;

  if v_shift_mode = 'scheduled' and not (
    p_evaluated_at >= (v_spec ->> 'scheduled_shift_starts_at')::timestamptz
    and p_evaluated_at < (v_spec ->> 'scheduled_shift_ends_at')::timestamptz
  ) then
    return false;
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'site_ids') selected(id)
    where not false
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'department_ids') selected(id)
    where not false
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'team_ids') selected(id)
    where not false
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'line_ids') selected(id)
    where not false
  ) or exists (
    select 1 from jsonb_array_elements_text(v_spec -> 'unit_ids') selected(id)
    where not false
  ) then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$function$;

CREATE OR REPLACE FUNCTION private.dynamic_group_search_item_allowed_for_user(p_organization_id uuid, p_actor_user_id uuid, p_item jsonb, p_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select case p_item ->> 'type'
    when 'people' then private.can_view_org_member_for_actor(
      p_organization_id, p_actor_user_id,
      (p_item ->> 'id')::uuid, p_at
    )
    when 'messages' then private.dynamic_group_message_access_allowed_for_user(
      p_organization_id, (p_item ->> 'conversation_id')::uuid,
      (p_item ->> 'id')::bigint, p_actor_user_id, p_at
    )
    when 'announcements' then false
    when 'handoffs' then false
    when 'conversations' then private.dynamic_group_conversation_access_allowed_for_user(
      p_organization_id, (p_item ->> 'id')::uuid, p_actor_user_id, p_at
    )
    else true
  end
$function$;

CREATE OR REPLACE FUNCTION private.dynamic_group_timestamp_access_allowed(p_organization_id uuid, p_conversation_id uuid, p_user_id uuid, p_occurred_at timestamp with time zone, p_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select p_occurred_at is not null
    and exists (
      select 1 from public.organization_memberships organization_member
      where organization_member.organization_id = p_organization_id
        and organization_member.user_id = p_user_id
        and organization_member.status = 'active'
    )
    and (exists (
        select 1
        from public.conversation_members member
        where member.organization_id = p_organization_id
          and member.conversation_id = p_conversation_id
          and member.user_id = p_user_id
          and member.status = 'active'
          and (member.history_visible_from is null
            or p_occurred_at >= member.history_visible_from)
      ))
$function$;

CREATE OR REPLACE FUNCTION private.dynamic_group_user_currently_eligible(p_organization_id uuid, p_conversation_id uuid, p_user_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION private.effective_capabilities_internal(p_actor_user_id uuid, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with membership as (
    select member.role, member.membership_type
    from public.organization_memberships member
    where member.organization_id = p_organization_id
      and member.user_id = p_actor_user_id
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
  ), effective(capability) as (
    select capability from (values
      ('messaging.read'), ('message.send'), ('contacts.manage'),
      ('summary.request'), ('actions.propose'), ('attachments.upload')
    ) base(capability)
    where exists (select 1 from membership)
    union
    select 'conversation.direct.create'
    from public.organizations organization
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
      and exists (
        select 1 from membership where membership_type <> 'guest'
      )
    union
    -- The permission catalogue, inlined: the table that held it is gone and
    -- these are the capabilities an owner or admin always had.
    select catalogue.capability
    from unnest(array[
      'actions.confirm',
      'ai.policy.manage',
      'audit.read',
      'communications.publish',
      'conversation.manage',
      'directory.manage',
      'directory.read',
      'employee.use',
      'handoff.manage',
      'invites.manage',
      'language.review',
      'members.security',
      'message.preservation.manage',
      'recovery.manage',
      'reports.assign',
      'reports.investigate',
      'roles.manage',
      'roles.read',
      'sessions.revoke',
      'unit.manage'
    ]) as catalogue(capability)
    where exists (
      select 1 from membership
      where membership_type <> 'guest' and role in ('owner', 'admin')
    )
  )
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb)
  from (select distinct capability from effective) deduplicated
$function$;

CREATE OR REPLACE FUNCTION private.effective_scopes_internal(p_actor_user_id uuid, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with membership as (
    select member.role, member.membership_type
    from public.organization_memberships member
    where member.organization_id = p_organization_id
      and member.user_id = p_actor_user_id
      and private.organization_membership_access_current(
        member.organization_id, member.user_id, now()
      )
  ), assigned as (
    -- No role has ever been granted, so this arm is empty. It keeps its
    -- column types so the union below still resolves.
    select null::uuid as assignment_id, null::text as role_name,
      null::text as scope_type, null::uuid as unit_id,
      null::timestamptz as expires_at, '[]'::jsonb as permissions
    where false
  ), scopes as (
    select jsonb_build_object(
      'assignment_id', assigned.assignment_id,
      'role_name', assigned.role_name,
      'scope_type', assigned.scope_type,
      'unit_id', assigned.unit_id,
      'permissions', assigned.permissions,
      'expires_at', assigned.expires_at
    ) as scope, assigned.role_name, assigned.assignment_id
    from assigned
    union all
    select jsonb_build_object(
      'assignment_id', null,
      'role_name', 'legacy_' || membership.role,
      'scope_type', 'organization',
      'unit_id', null,
      'permissions', jsonb_build_array(
          'actions.confirm',
          'ai.policy.manage',
          'audit.read',
          'communications.publish',
          'conversation.manage',
          'directory.manage',
          'directory.read',
          'employee.use',
          'handoff.manage',
          'invites.manage',
          'language.review',
          'members.security',
          'message.preservation.manage',
          'recovery.manage',
          'reports.assign',
          'reports.investigate',
          'roles.manage',
          'roles.read',
          'sessions.revoke',
          'unit.manage'
        ),
      'expires_at', null
    ), 'legacy_' || membership.role, null::uuid
    from membership
    where membership.membership_type <> 'guest'
      and membership.role in ('owner', 'admin')
  )
  select coalesce(jsonb_agg(scope order by role_name,
    assignment_id nulls first), '[]'::jsonb)
  from scopes
$function$;

CREATE OR REPLACE FUNCTION public.hook_newone_custom_access_token(event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_user_id uuid;
  v_claims jsonb;
  v_allowed boolean := false;
begin
  if event is null
    or jsonb_typeof(event) <> 'object'
    or jsonb_typeof(event -> 'claims') <> 'object'
    or coalesce(event ->> 'user_id', '') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Authentication is not available for this account.'
      )
    );
  end if;

  v_user_id := (event ->> 'user_id')::uuid;
  v_claims := event -> 'claims';

  select exists (
    select 1
    from auth.users auth_user
    where auth_user.id = v_user_id
      and auth_user.deleted_at is null
      and (auth_user.banned_until is null or auth_user.banned_until <= now())
      and (
        exists (
          select 1
          from public.organization_memberships membership
          where membership.user_id = auth_user.id
            and private.organization_membership_access_current(
              membership.organization_id, membership.user_id, now()
            )
        )
        or exists (
          select 1
          from private.signup_reservations reservation
          where reservation.destination_type = 'email'
            and reservation.destination = lower(coalesce(auth_user.email, ''))
            and reservation.expires_at > now()
        )
      )
  ) into v_allowed;

  if not v_allowed then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Authentication is not available for this account.'
      )
    );
  end if;

  -- Preserve the complete GoTrue claim set. Workspace authorization remains
  -- server-derived on every BFF/data request; no tenant role is trusted from a
  -- client-visible JWT claim.
  return jsonb_build_object('claims', v_claims);
end;
$function$;

CREATE OR REPLACE FUNCTION private.is_active_designated_investigator_internal(p_user_id uuid, p_organization_id uuid, p_unit_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select false
$function$;

CREATE OR REPLACE FUNCTION private.lock_policy_managed_conversation_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_organization_id uuid := case when tg_op = 'DELETE'
    then old.organization_id else new.organization_id end;
  v_conversation_id uuid := case when tg_op = 'DELETE'
    then old.conversation_id else new.conversation_id end;
  v_service boolean := coalesce((select auth.jwt() ->> 'role'), '') = 'service_role'
    or session_user in ('postgres', 'service_role');
begin
  if tg_op = 'UPDATE'
    and new.organization_id is not distinct from old.organization_id
    and new.conversation_id is not distinct from old.conversation_id
    and new.user_id is not distinct from old.user_id
    and new.role is not distinct from old.role
    and new.status is not distinct from old.status
    and new.can_post is not distinct from old.can_post
    and new.joined_by_user_id is not distinct from old.joined_by_user_id
    and new.joined_at is not distinct from old.joined_at
    and new.history_visible_from is not distinct from old.history_visible_from
    and new.left_at is not distinct from old.left_at
    and new.managed_by_policy_id is not distinct from old.managed_by_policy_id then
    -- Per-user notification preferences are not membership governance.
    return new;
  end if;
  if false and not (
    v_service and coalesce(
      current_setting('app.dynamic_group_reconcile_context', true), 'off'
    ) = 'on'
  ) and not (
    v_service
    and coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.member_offboarding_context', true), 'off') = 'on'
  ) then
    raise exception 'manual membership is locked by the published dynamic policy'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

CREATE OR REPLACE FUNCTION private.reconcile_announcement_push_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_announcement_id uuid;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    select nullif(job.payload ->> 'announcement_id', '')::uuid
      into v_announcement_id
    from private.outbox_jobs job
    where job.id = new.outbox_job_id;
  -- No outbox job carries an announcement any more, so there is nothing
  -- to reconcile here.
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.serialize_message_posting_access()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_kind text;
  v_posting_mode text;
  v_is_archived boolean;
  v_closed_at timestamptz;
  v_member_role text;
  v_organization_role text;
  v_can_post boolean;
  v_pair_low_user_id uuid;
  v_pair_high_user_id uuid;
  v_policy_id uuid;
begin
  if new.kind = 'system'
    and coalesce(current_setting('app.bff_service_context', true), 'off') = 'on' then
    return new;
  end if;
  if v_actor_user_id is null or new.sender_user_id <> v_actor_user_id then
    raise exception 'active conversation membership with posting access is required'
      using errcode = '42501';
  end if;
  select conversation.kind, conversation.posting_mode,
    conversation.is_archived, conversation.closed_at
    into v_kind, v_posting_mode, v_is_archived, v_closed_at
  from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id
  for share;
  if not found then
    raise exception 'active conversation membership with posting access is required'
      using errcode = '42501';
  end if;

  -- No conversation is policy-managed, so there is no policy row to lock.
  v_policy_id := null;

  select coalesce(member.role, 'member'), organization_member.role,
    coalesce(member.can_post, false)
    into v_member_role, v_organization_role, v_can_post
  from public.organization_memberships organization_member
  left join public.conversation_members member
    on member.organization_id = organization_member.organization_id
   and member.conversation_id = new.conversation_id
   and member.user_id = organization_member.user_id
  where organization_member.organization_id = new.organization_id
    and organization_member.user_id = v_actor_user_id
    and organization_member.status = 'active';

  if not found or v_is_archived or v_closed_at is not null
    or (v_policy_id is null and not v_can_post)
    or (v_policy_id is not null and not private.dynamic_group_user_currently_eligible(
      new.organization_id, new.conversation_id, v_actor_user_id, now()
    ))
    or (v_posting_mode = 'admins_only' and v_member_role not in ('owner', 'admin'))
    or (v_kind = 'announcement' and v_member_role not in ('owner', 'admin')
      and v_organization_role not in ('owner', 'admin')) then
    raise exception 'active conversation membership with posting access is required'
      using errcode = '42501';
  end if;
  if v_kind = 'direct' then
    select pair.member_low_user_id, pair.member_high_user_id
      into v_pair_low_user_id, v_pair_high_user_id
    from public.direct_conversation_pairs pair
    where pair.organization_id = new.organization_id
      and pair.conversation_id = new.conversation_id;
    if not found then
      raise exception 'active conversation membership with posting access is required'
        using errcode = '42501';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      new.organization_id::text || ':' || v_pair_low_user_id::text || ':'
        || v_pair_high_user_id::text, 0
    ));
    if not private.direct_pair_policy_permitted(
      new.organization_id, v_pair_low_user_id, v_pair_high_user_id
    ) then
      raise exception 'active conversation membership with posting access is required'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.validate_conversation_controls_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_delegated_workflow boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(
      current_setting('app.delegated_conversation_management_context', true),
      'off'
    ) = 'on';
begin
  if new.posting_mode is distinct from old.posting_mode
    or new.join_policy is distinct from old.join_policy
    or new.visibility is distinct from old.visibility then
    if coalesce(current_setting('app.conversation_controls_context', true), 'off') <> 'on'
      or not (
        private.is_conversation_admin(old.organization_id, old.id)
        or (
          v_delegated_workflow
          and private.actor_can_manage_conversation(
            v_actor_user_id, old.organization_id, old.id
          )
        )
      ) then
      raise exception 'conversation controls require an administrator workflow'
        using errcode = '42501';
    end if;
    if old.kind not in ('group', 'team')
      or old.is_archived
      or old.closed_at is not null
      or false then
      raise exception 'conversation controls are unavailable for this conversation'
        using errcode = '42501';
    end if;
    if new.visibility = 'invite_only' and new.join_policy = 'approval_required' then
      raise exception 'approval-required groups must be discoverable' using errcode = '22023';
    end if;
    if new.visibility <> 'unit' and new.unit_id is distinct from old.unit_id then
      raise exception 'conversation unit scope is not mutable here' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.validate_guest_conversation_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_type text;
  v_expires_at timestamptz;
  v_allow_guests boolean;
  v_kind text;
  v_name text;
  v_dynamic boolean;
begin
  select membership.membership_type, membership.access_expires_at,
      organization.allow_external_guests
    into v_type, v_expires_at, v_allow_guests
  from public.organization_memberships membership
  join public.organizations organization on organization.id = membership.organization_id
  where membership.organization_id = new.organization_id
    and membership.user_id = new.user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );
  if new.status <> 'active' then return new; end if;
  if not found then
    raise exception 'current organization membership is required'
      using errcode = '42501';
  end if;
  if v_type is distinct from 'guest' then return new; end if;
  select conversation.kind, conversation.name,
      false
    into v_kind, v_name, v_dynamic
  from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id;
  if not v_allow_guests
    or v_expires_at is null or v_expires_at <= now()
    or v_kind not in ('group', 'team', 'shift', 'incident')
    or char_length(btrim(coalesce(v_name, ''))) < 1
    or new.role <> 'member'
    or coalesce(v_dynamic, false) then
    raise exception 'external guest is not permitted in this conversation'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;


