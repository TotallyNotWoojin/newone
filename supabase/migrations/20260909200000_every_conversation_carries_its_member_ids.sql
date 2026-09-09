-- Searching the Chats list by two people only found the group holding them
-- both when that group happened to be the conversation the server had been
-- asked about: members are sent for the selected conversation and no other,
-- and the match is made against member ids. On a cold launch the client sends
-- no selection at all, so the server picks the default - which used to be
-- whichever row had been touched last, and is now the one with the newest
-- message. The feature was resting on that coincidence.
--
-- Send the ids for every conversation. They are small next to the member
-- objects, which carry names, avatars, roles and notification state and stay
-- exactly where they were.

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

  select coalesce(jsonb_agg(jsonb_build_object(
    'unit_id', visible.id,
    'parent_unit_id', visible.parent_unit_id,
    'kind', visible.kind,
    'name', visible.name,
    'is_lead', visible.is_lead
  ) order by visible.kind, visible.name, visible.id), '[]'::jsonb)
  into v_units
  from (
    select unit.id, unit.parent_unit_id, unit.kind, unit.name,
      coalesce(bool_or(unit_member.user_id = p_actor_user_id and unit_member.is_lead), false) as is_lead
    from public.organization_units unit
    left join public.organization_unit_members unit_member
      on unit_member.organization_id = unit.organization_id
     and unit_member.unit_id = unit.id
    where unit.organization_id = p_organization_id
      and unit.is_active
      and (
        private.actor_has_permission(p_actor_user_id, p_organization_id, 'directory.read', unit.id)
        or exists (
          select 1 from public.organization_unit_members viewer_unit
          where viewer_unit.organization_id = unit.organization_id
            and viewer_unit.unit_id = unit.id
            and viewer_unit.user_id = p_actor_user_id
        )
      )
    group by unit.id, unit.parent_unit_id, unit.kind, unit.name
    order by unit.kind, unit.name, unit.id
    limit 500
  ) visible;

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
      (select coalesce(jsonb_agg(unit_member.unit_id order by unit_member.unit_id), '[]'::jsonb)
       from public.organization_unit_members unit_member
       where unit_member.organization_id = membership.organization_id
         and unit_member.user_id = membership.user_id) as unit_ids,
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
            or exists (
              select 1
              from public.organization_unit_members viewer_unit
              join public.organization_unit_members target_unit
                on target_unit.organization_id = viewer_unit.organization_id
               and target_unit.unit_id = viewer_unit.unit_id
               and target_unit.user_id = membership.user_id
              where viewer_unit.organization_id = p_organization_id
                and viewer_unit.user_id = p_actor_user_id
            )
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

  select coalesce(jsonb_agg(row.payload order by row.published_at desc, row.announcement_id), '[]'::jsonb)
  into v_updates
  from (
    select announcement.id as announcement_id, version.published_at,
      jsonb_strip_nulls(jsonb_build_object(
        'announcement_id', announcement.id,
        'announcement_version_id', version.id,
        'version_number', version.version_number,
        'conversation_id', version.conversation_id,
        'message_id', version.message_id,
        'title', version.title,
        'priority', version.priority,
        'requires_acknowledgement', version.requires_acknowledgement,
        'acknowledgement_schema', version.acknowledgement_schema,
        'notification_class', version.notification_class,
        'critical_category', version.critical_category,
        'quiet_hours_override_reason', version.quiet_hours_override_reason,
        'reminder_policy', version.reminder_policy,
        'status', announcement.status,
        'scheduled_at', version.scheduled_at,
        'published_at', version.published_at,
        'expires_at', version.expires_at,
        'body', message.body,
        'client_language_hint', message.language_code,
        'detected_language', message.detected_language,
        'language_detection_state', message.language_detection_state,
        'translations', (select coalesce(jsonb_agg(jsonb_build_object(
          'target_language', translation.target_language,
          'translated_body', translation.translated_body,
          'status', translation.status,
          'confidence', translation.confidence
        ) order by translation.target_language), '[]'::jsonb)
        from public.message_translations translation
        where translation.organization_id = version.organization_id
          and translation.conversation_id = version.conversation_id
          and translation.message_id = version.message_id
          and translation.source_body_sha256 = extensions.digest(
            convert_to(message.body, 'UTF8'), 'sha256'
          )),
        'delivered_at', recipient.delivered_at,
        'read_at', recipient.read_at,
        'reminder_count', recipient.reminder_count,
        'last_reminded_at', recipient.last_reminded_at,
        'escalated_at', recipient.escalated_at,
        'acknowledged_at', acknowledgement.acknowledged_at,
        'acknowledgement_device_id', acknowledgement.device_id,
        'acknowledgement_role_snapshot', acknowledgement.role_snapshot,
        'acknowledgement_scope_snapshot', acknowledgement.scope_snapshot
      )) as payload
    from public.announcements announcement
    join lateral (
      select candidate.* from public.announcement_versions candidate
      where candidate.organization_id = announcement.organization_id
        and candidate.announcement_id = announcement.id
      order by candidate.version_number desc limit 1
    ) version on true
    join public.messages message
      on message.organization_id = version.organization_id
     and message.conversation_id = version.conversation_id
     and message.id = version.message_id
     and message.deleted_at is null
     and message.available_at <= now()
    join public.announcement_recipients recipient
      on recipient.organization_id = announcement.organization_id
     and recipient.announcement_id = announcement.id
     and recipient.user_id = p_actor_user_id
    join public.conversation_members member
      on member.organization_id = version.organization_id
     and member.conversation_id = version.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    left join public.announcement_acknowledgements acknowledgement
      on acknowledgement.organization_id = version.organization_id
     and acknowledgement.announcement_id = version.announcement_id
     and acknowledgement.announcement_version_id = version.id
     and acknowledgement.user_id = p_actor_user_id
    where announcement.organization_id = p_organization_id
      and announcement.status = 'published'
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
    order by version.published_at desc, announcement.id
    limit 200
  ) row;

  select coalesce(jsonb_agg(row.payload order by row.created_at desc, row.handoff_id), '[]'::jsonb)
  into v_handoffs
  from (
    select handoff.id as handoff_id, version.created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'handoff_id', handoff.id,
        'handoff_version_id', version.id,
        'version_number', version.version_number,
        'conversation_id', version.conversation_id,
        'title', version.title,
        'details', version.details,
        'source_language', version.source_language,
        'translations', '[]'::jsonb,
        'status', handoff.status,
        'shift_started_at', version.shift_started_at,
        'shift_ended_at', version.shift_ended_at,
        'submitted_at', handoff.submitted_at,
        'acknowledgement_due_at', version.acknowledgement_due_at,
        'overdue', handoff.status = 'submitted'
          and version.acknowledgement_due_at is not null
          and version.acknowledgement_due_at <= now()
          and acknowledgement.acknowledged_at is null,
        'reminder_state', case
          when handoff.status <> 'submitted' or version.acknowledgement_due_at is null
            or version.acknowledgement_due_at > now() then 'not_due'
          when handoff.reminder_count >= 3 then 'exhausted'
          when handoff.reminder_count > 0 then 'sent'
          else 'due'
        end,
        'reminder_count', handoff.reminder_count,
        'last_reminded_at', handoff.last_reminded_at,
        'escalation_state', case
          when handoff.escalated_at is not null then 'escalated'
          when handoff.status = 'submitted' and version.acknowledgement_due_at is not null
            and now() >= version.acknowledgement_due_at + interval '60 minutes' then 'due'
          else 'not_due'
        end,
        'escalated_at', handoff.escalated_at,
        'sms_fallback_available', false,
        'source_message_ids', to_jsonb(version.source_message_ids),
        'source_fingerprint', encode(version.source_fingerprint, 'hex'),
        'source_state', case when private.handoff_source_is_current_internal(
          version.organization_id, version.conversation_id,
          version.source_message_ids, version.source_fingerprint
        ) then 'current' else 'stale' end,
        'stale_reason', case when private.handoff_source_is_current_internal(
          version.organization_id, version.conversation_id,
          version.source_message_ids, version.source_fingerprint
        ) then null else 'source_edited_or_deleted' end,
        'author_user_id', handoff.author_user_id,
        'signed_session_id', handoff.signed_session_id,
        'signed_device_id', handoff.signed_device_id,
        'signed_role_snapshot', handoff.signed_role_snapshot,
        'signed_scope_snapshot', handoff.signed_scope_snapshot,
        'is_submitted_version', handoff.submitted_version_id = version.id,
        'acknowledged_at', acknowledgement.acknowledged_at,
        'acknowledgement_session_id', acknowledgement.session_id,
        'acknowledgement_device_id', acknowledgement.device_id,
        'acknowledgement_role_snapshot', acknowledgement.role_snapshot,
        'acknowledgement_scope_snapshot', acknowledgement.scope_snapshot,
        'note', acknowledgement.note
      )) as payload
    from public.shift_handoffs handoff
    join lateral (
      select candidate.* from public.handoff_versions candidate
      where candidate.organization_id = handoff.organization_id
        and candidate.handoff_id = handoff.id
      order by candidate.version_number desc limit 1
    ) version on true
    join public.conversation_members member
      on member.organization_id = handoff.organization_id
     and member.conversation_id = handoff.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    left join public.handoff_acknowledgements acknowledgement
      on acknowledgement.organization_id = version.organization_id
     and acknowledgement.handoff_id = version.handoff_id
     and acknowledgement.handoff_version_id = version.id
     and acknowledgement.user_id = p_actor_user_id
    where handoff.organization_id = p_organization_id
      and (member.history_visible_from is null
        or version.created_at >= member.history_visible_from)
      and (handoff.status <> 'draft' or handoff.author_user_id = p_actor_user_id
        or private.actor_has_permission(p_actor_user_id, p_organization_id, 'handoff.manage', null))
    order by version.created_at desc, handoff.id
    limit 200
  ) row;

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

  select coalesce(jsonb_agg(row.payload order by row.created_at desc, row.action_id), '[]'::jsonb)
  into v_actions
  from (
    select action.id as action_id, action.created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'action_id', action.id,
        'conversation_id', action.conversation_id,
        'source_message_id', action.source_message_id,
        'title', action.title,
        'details', action.details,
        'status', action.status,
        'proposed_by_user_id', action.proposed_by_user_id,
        'confirmed_by_user_id', action.confirmed_by_user_id,
        'assignee_user_id', action.assignee_user_id,
        'due_at', action.due_at,
        'completed_at', action.completed_at,
        'created_at', action.created_at,
        'updated_at', action.updated_at
      )) as payload
    from public.operational_actions action
    join public.conversation_members member
      on member.organization_id = action.organization_id
     and member.conversation_id = action.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where action.organization_id = p_organization_id
      and (action.source_message_id is null or not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = action.organization_id
          and visibility.conversation_id = action.conversation_id
          and visibility.message_id = action.source_message_id
          and visibility.user_id = p_actor_user_id
      ))
    order by action.created_at desc, action.id
    limit 200
  ) row;

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
$function$
;
