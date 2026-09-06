-- Summaries v3.1: the reader defines each summary's scope (backlog 11, 15-18).
--
-- The "since last summary" boundary is gone. A request names a range
-- (unread, today, yesterday, last 7 days, everything) and an optional
-- subject; the server picks the messages itself, so the client's loaded
-- window no longer limits coverage. Long ranges (up to 2,000 messages) are
-- summarized in slices by the AI worker, which also receives sender display
-- names so the prose can say "Diego agreed" instead of "participant 1".
--
-- Existing functions below are the live definitions with minimal edits:
--   summary_source_snapshot_internal            cap 500 -> 2000
--   validate_conversation_summary_update        scope columns immutable
--   bff_resolve_summary_job_sources_pre_dynamic_group_impl
--                                               sender names + scope to the worker
--   bff_bootstrap_messaging_state_v2_impl       scope fields in the summaries payload

alter table public.conversation_summaries
  add column if not exists scope_kind text,
  add column if not exists scope_subject text;

alter table public.conversation_summaries
  drop constraint if exists conversation_summaries_scope_kind_allowed;
alter table public.conversation_summaries
  add constraint conversation_summaries_scope_kind_allowed
  check (scope_kind is null or scope_kind in ('unread', 'today', 'yesterday', 'last_7_days', 'everything'));

alter table public.conversation_summaries
  drop constraint if exists conversation_summaries_scope_subject_length;
alter table public.conversation_summaries
  add constraint conversation_summaries_scope_subject_length
  check (scope_subject is null or char_length(btrim(scope_subject)) between 1 and 200);

alter table public.conversation_summaries
  drop constraint if exists conversation_summaries_source_count;
alter table public.conversation_summaries
  add constraint conversation_summaries_source_count
  check (cardinality(source_message_ids) >= 1 and cardinality(source_message_ids) <= 2000);


CREATE OR REPLACE FUNCTION private.summary_source_snapshot_internal(p_organization_id uuid, p_conversation_id uuid, p_actor_user_id uuid, p_source_message_ids bigint[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ids bigint[];
  v_fingerprint bytea;
begin
  if cardinality(p_source_message_ids) not between 1 and 2000 then
    raise exception 'authorized summary sources required' using errcode = '42501';
  end if;
  select array_agg(message.id order by message.id),
    extensions.digest(convert_to(string_agg(
      message.id::text || ':' || encode(extensions.digest(convert_to(
        coalesce(message.body, '') || ':' || message.metadata::text || ':'
          || coalesce(message.edited_at::text, ''), 'UTF8'
      ), 'sha256'), 'hex'), ',' order by message.id
    ), 'UTF8'), 'sha256')
    into v_ids, v_fingerprint
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = any(p_source_message_ids)
    and private.dynamic_group_message_access_allowed_for_user(
      message.organization_id, message.conversation_id,
      message.id, p_actor_user_id, now()
    );
  if cardinality(v_ids) is distinct from cardinality(p_source_message_ids)
    or cardinality(v_ids) is distinct from cardinality(array(
      select distinct source_id from unnest(p_source_message_ids) source_id
    )) then
    raise exception 'summary source is missing, duplicated, deleted, or unauthorized'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'source_message_ids', to_jsonb(v_ids),
    'source_first_message_id', v_ids[1],
    'source_last_message_id', v_ids[cardinality(v_ids)],
    'source_fingerprint', encode(v_fingerprint, 'hex')
  );
end;
$function$;

CREATE OR REPLACE FUNCTION private.validate_conversation_summary_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.version_number is distinct from old.version_number
    or new.correction_of_summary_id is distinct from old.correction_of_summary_id
    or new.source_message_ids is distinct from old.source_message_ids
    or new.source_first_message_id is distinct from old.source_first_message_id
    or new.source_last_message_id is distinct from old.source_last_message_id
    or new.source_fingerprint is distinct from old.source_fingerprint
    or new.requested_by_user_id is distinct from old.requested_by_user_id
    or new.request_mode is distinct from old.request_mode
    or new.language_code is distinct from old.language_code
    or new.scope_kind is distinct from old.scope_kind
    or new.scope_subject is distinct from old.scope_subject
    or new.created_at is distinct from old.created_at then
    raise exception 'summary version identity and sources are immutable' using errcode = '22000';
  end if;
  if coalesce(current_setting('app.summary_stale_context', true), 'off') = 'on'
    and new.status = 'stale'
    and new.primary_topic is null and new.summary_body is null
    and new.output_fingerprint is null
    and new.failure_code in (
      'source_deleted', 'source_changed', 'source_stale_or_deleted',
      'requester_or_source_unauthorized', 'tenant_ai_policy_denied'
    ) then
    new.updated_at := now();
    return new;
  end if;
  if old.status in ('approved', 'failed', 'stale') then
    raise exception 'terminal summary versions are immutable' using errcode = '22000';
  end if;
  if old.status in ('queued', 'processing')
    and v_jwt_role <> 'service_role' then
    raise exception 'summary processing state is worker-owned' using errcode = '42501';
  end if;
  if old.status = 'draft'
    and coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'summary review requires checked BFF context' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.bff_resolve_summary_job_sources_pre_dynamic_group_impl(p_worker_id uuid, p_job_id bigint, p_provider text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job private.outbox_jobs%rowtype; v_summary public.conversation_summaries%rowtype;
  v_messages jsonb; v_count integer; v_fingerprint bytea; v_invalid boolean;
  v_policy_version integer; v_route_policy text;
begin
  perform private.require_service_role();
  if coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$' then
    raise exception 'valid summary provider required' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'summary'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now() for update;
  if not found then raise exception 'active summary lease required' using errcode = '55000'; end if;
  select * into v_summary from public.conversation_summaries summary
  where summary.organization_id = v_job.organization_id
    and summary.id = (v_job.payload ->> 'summary_id')::uuid
    and summary.status in ('queued', 'processing') for update;
  if not found then raise exception 'queued summary version not found' using errcode = '55000'; end if;
  select
    count(*),
    coalesce(bool_or(
      message.deleted_at is not null
      or message.available_at > now()
      or visibility.user_id is not null
      or exists (
        select 1 from public.conversation_members requester_membership
        where requester_membership.organization_id = message.organization_id
          and requester_membership.conversation_id = message.conversation_id
          and requester_membership.user_id = v_summary.requested_by_user_id
          and requester_membership.history_visible_from is not null
          and message.created_at < requester_membership.history_visible_from
      )
    ), true),
    extensions.digest(convert_to(string_agg(
      message.id::text || ':' || encode(extensions.digest(convert_to(
        coalesce(message.body, '') || ':' || message.metadata::text || ':'
        || coalesce(message.edited_at::text, ''), 'UTF8'
      ), 'sha256'), 'hex'), ',' order by message.id
    ), 'UTF8'), 'sha256'),
    coalesce(jsonb_agg(jsonb_build_object(
      'message_id', message.id,
      'sender_user_id', message.sender_user_id,
      'sender_display_name', sender_profile.display_name,
      'body', message.body,
      'detected_language', message.detected_language,
      'created_at', message.created_at,
      'edited_at', message.edited_at
    ) order by message.id), '[]'::jsonb)
  into v_count, v_invalid, v_fingerprint, v_messages
  from public.messages message
  left join public.message_user_visibility visibility
    on visibility.organization_id = message.organization_id
   and visibility.conversation_id = message.conversation_id
   and visibility.message_id = message.id
   and visibility.user_id = v_summary.requested_by_user_id
  left join public.profiles sender_profile
    on sender_profile.user_id = message.sender_user_id
  where message.organization_id = v_summary.organization_id
    and message.conversation_id = v_summary.conversation_id
    and message.id = any(v_summary.source_message_ids);
  if not exists (
      select 1 from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      where member.organization_id = v_summary.organization_id
        and member.conversation_id = v_summary.conversation_id
        and member.user_id = v_summary.requested_by_user_id
        and member.status = 'active'
    )
    or v_count <> cardinality(v_summary.source_message_ids)
    or v_invalid
    or v_fingerprint <> v_summary.source_fingerprint
    or not private.ai_use_case_approved(v_summary.organization_id, 'summary', lower(p_provider)) then
    perform set_config('app.summary_stale_context', 'on', true);
    update public.conversation_summaries summary
    set status = 'stale', primary_topic = null, summary_body = null,
        key_topics = null, decisions = null, action_items = null, ambiguities = null,
        output_fingerprint = null, processor_type = null, provider = null, model = null,
        processor_provenance = '{}'::jsonb,
        failure_code = case when not private.ai_use_case_approved(
          v_summary.organization_id, 'summary', lower(p_provider)
        ) then 'tenant_ai_policy_denied' else 'requester_or_source_unauthorized' end,
        reviewed_by_user_id = null, reviewed_at = null, review_note = null,
        updated_at = now()
    where summary.id = v_summary.id;
    perform set_config('app.summary_stale_context', 'off', true);
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'authorized', false, 'summary_id', v_summary.id,
      'reason', case when not private.ai_use_case_approved(
        v_summary.organization_id, 'summary', lower(p_provider)
      ) then 'tenant_ai_policy_denied' else 'requester_or_source_unauthorized' end,
      'provider_egress_allowed', false
    );
  end if;
  select policy.policy_version, policy.route_policy
    into v_policy_version, v_route_policy
  from public.organization_ai_policies policy
  where policy.organization_id = v_summary.organization_id
    and policy.enabled and policy.revoked_at is null;
  update private.outbox_jobs job
  set payload = job.payload || jsonb_build_object(
        'resolved_provider', lower(p_provider),
        'ai_policy_version', v_policy_version,
        'source_resolved_at', now()
      ),
      updated_at = now()
  where job.id = p_job_id;
  return jsonb_build_object(
    'authorized', true,
    'summary_id', v_summary.id,
    'organization_id', v_summary.organization_id,
    'conversation_id', v_summary.conversation_id,
    'requested_by_user_id', v_summary.requested_by_user_id,
    'language_code', v_summary.language_code,
    'scope_kind', v_summary.scope_kind,
    'scope_subject', v_summary.scope_subject,
    'source_fingerprint', encode(v_summary.source_fingerprint, 'hex'),
    'messages', v_messages,
    'provider_egress_allowed', true,
    'processor_id', lower(p_provider),
    'ai_policy_version', v_policy_version,
    'route_policy', v_route_policy,
    'provider_route_policy', 'zero_retention_only',
    'required_output', jsonb_build_object(
      'primary_topic', 'text <= 240 chars',
      'summary_body', 'text <= 30000 chars',
      'key_topics', 'text[] <= 50',
      'decisions', 'json array <= 100',
      'action_items', 'json array <= 100',
      'ambiguities', 'text[] <= 50'
    )
  );
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
$function$;

create or replace function private.bff_request_conversation_summary_scope_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_scope_kind text, p_scope_subject text,
  p_from_message_id bigint, p_utc_offset_minutes integer, p_language_code text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command jsonb; v_source jsonb; v_summary_id uuid; v_version integer;
  v_job_id bigint; v_status text; v_created boolean := false; v_response jsonb;
  v_subject text; v_offset integer; v_midnight timestamptz; v_after_id bigint;
  v_ids bigint[]; v_history_visible_from timestamptz; v_member_found boolean;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'summary.request', false, 0, '/v2/conversations/:id/summaries',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if coalesce(p_language_code, '') !~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
    or not private.ai_use_case_approved(p_organization_id, 'summary', null) then
    raise exception 'valid tenant-approved summary request required' using errcode = '42501';
  end if;
  if coalesce(p_scope_kind, '') not in ('unread', 'today', 'yesterday', 'last_7_days', 'everything')
    or coalesce(p_utc_offset_minutes, 0) not between -900 and 900
    or (p_from_message_id is not null and p_from_message_id < 1) then
    raise exception 'invalid summary scope' using errcode = '22023';
  end if;
  v_subject := nullif(btrim(regexp_replace(coalesce(p_scope_subject, ''), '\s+', ' ', 'g')), '');
  if char_length(coalesce(v_subject, '')) > 200 then
    raise exception 'invalid summary scope' using errcode = '22023';
  end if;
  select true, member.history_visible_from into v_member_found, v_history_visible_from
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.user_id = p_actor_user_id
    and member.status = 'active';
  if coalesce(v_member_found, false) is false then
    raise exception 'active conversation membership required' using errcode = '42501';
  end if;
  -- "Today" and "Yesterday" follow the reader's clock: the client sends its
  -- UTC offset, the server turns it into that day's midnight.
  v_offset := coalesce(p_utc_offset_minutes, 0);
  v_midnight := (date_trunc('day', (now() + make_interval(mins => v_offset)) at time zone 'UTC')
    at time zone 'UTC') - make_interval(mins => v_offset);
  if p_scope_kind = 'unread' then
    -- The app marks a chat read the moment it opens, so the client names the
    -- first message it showed as unread; without that hint the read cursor
    -- is the boundary.
    if p_from_message_id is not null then
      v_after_id := p_from_message_id - 1;
    else
      select cursor_row.last_read_message_id into v_after_id
      from public.conversation_read_cursors cursor_row
      where cursor_row.organization_id = p_organization_id
        and cursor_row.conversation_id = p_conversation_id
        and cursor_row.user_id = p_actor_user_id;
      v_after_id := coalesce(v_after_id, 0);
    end if;
  end if;
  -- The server picks the messages, so the client's loaded window never
  -- limits what a summary covers. Only messages with text count; the worker
  -- has nothing to say about attachments or system events.
  select array_agg(candidate.id order by candidate.id) into v_ids
  from (
    select message.id
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.deleted_at is null
      and message.available_at <= now()
      and message.kind <> 'system'
      and coalesce(btrim(message.body), '') <> ''
      and (v_history_visible_from is null or message.created_at >= v_history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
      and case p_scope_kind
        when 'unread' then message.id > v_after_id
        when 'today' then message.created_at >= v_midnight
        when 'yesterday' then message.created_at >= v_midnight - interval '1 day'
          and message.created_at < v_midnight
        when 'last_7_days' then message.created_at >= v_midnight - interval '6 days'
        else true
      end
      and private.dynamic_group_message_access_allowed_for_user(
        message.organization_id, message.conversation_id, message.id, p_actor_user_id, now()
      )
    order by message.id
    limit 2001
  ) candidate;
  if v_ids is null then
    raise exception 'summary_range_empty' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 2000 then
    raise exception 'summary_range_too_long' using errcode = '42501';
  end if;
  v_source := private.summary_source_snapshot_internal(
    p_organization_id, p_conversation_id, p_actor_user_id, v_ids
  );
  perform 1 from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  for update;
  -- The same reader asking for the same messages with the same subject and
  -- language gets the version that is queued or already readable; nothing
  -- else is ever excluded because an earlier summary covered it.
  select summary.id, summary.version_number, summary.status
    into v_summary_id, v_version, v_status
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id
    and summary.conversation_id = p_conversation_id
    and summary.requested_by_user_id = p_actor_user_id
    and summary.source_fingerprint = decode(v_source ->> 'source_fingerprint', 'hex')
    and summary.language_code = lower(p_language_code)
    and summary.correction_of_summary_id is null
    and summary.scope_kind = p_scope_kind
    and summary.scope_subject is not distinct from v_subject
    and summary.status in ('queued', 'processing', 'draft', 'approved')
  order by summary.version_number desc
  limit 1;
  if v_summary_id is not null then
    select job.id into v_job_id from private.outbox_jobs job
    where job.topic = 'summary' and job.dedupe_key = 'summary:' || v_summary_id::text;
  else
    if not private.consume_rate_limit(
        'summary-handoff-conversation-hour',
        p_organization_id::text || ':' || p_conversation_id::text,
        8, 3600
      )
      or not private.consume_rate_limit(
        'summary-handoff-actor-day',
        p_organization_id::text || ':' || p_actor_user_id::text,
        30, 86400
      ) then
      raise exception 'summary/handoff draft rate limit exceeded'
        using errcode = 'P0001';
    end if;
    select coalesce(max(summary.version_number), 0) + 1 into v_version
    from public.conversation_summaries summary
    where summary.organization_id = p_organization_id
      and summary.conversation_id = p_conversation_id;
    insert into public.conversation_summaries (
      organization_id, conversation_id, version_number, source_message_ids,
      source_first_message_id, source_last_message_id, source_fingerprint,
      requested_by_user_id, request_mode, language_code, scope_kind, scope_subject
    ) values (
      p_organization_id, p_conversation_id, v_version, v_ids,
      v_ids[1], v_ids[cardinality(v_ids)],
      decode(v_source ->> 'source_fingerprint', 'hex'), p_actor_user_id,
      'manual', lower(p_language_code), p_scope_kind, v_subject
    ) returning id, status into v_summary_id, v_status;
    v_created := true;
    -- The job names the version; the worker reads the source ids from the
    -- row (2,000 ids would not fit the job payload).
    v_job_id := private.enqueue_outbox_job_internal(
      p_organization_id, 'summary', 'summary:' || v_summary_id::text,
      jsonb_build_object(
        'summary_id', v_summary_id,
        'organization_id', p_organization_id,
        'conversation_id', p_conversation_id,
        'source_message_count', cardinality(v_ids),
        'source_fingerprint', v_source ->> 'source_fingerprint',
        'language_code', lower(p_language_code),
        'scope_kind', p_scope_kind,
        'request_mode', 'manual',
        'human_review_required', true
      )
    );
  end if;
  v_response := jsonb_build_object(
    'summary_id', v_summary_id, 'version_number', v_version,
    'status', coalesce(v_status, 'queued'), 'summary_job_id', v_job_id,
    'source_fingerprint', v_source ->> 'source_fingerprint',
    'source_message_count', cardinality(v_ids),
    'scope_kind', p_scope_kind, 'scope_subject', v_subject,
    'deduplicated', not v_created,
    'human_review_required', true, 'originals_unaffected', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/summaries',
    p_idempotency_key, p_request_sha256, v_response, 202
  );
end;
$$;

revoke all on function private.bff_request_conversation_summary_scope_impl(uuid, uuid, uuid, uuid, text, text, bigint, integer, text, text, text) from public;
grant execute on function private.bff_request_conversation_summary_scope_impl(uuid, uuid, uuid, uuid, text, text, bigint, integer, text, text, text) to service_role;

create or replace function public.bff_request_conversation_summary_scope(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_scope_kind text, p_scope_subject text,
  p_from_message_id bigint, p_utc_offset_minutes integer, p_language_code text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_request_conversation_summary_scope_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_scope_kind, p_scope_subject, p_from_message_id, p_utc_offset_minutes,
  p_language_code, p_idempotency_key, p_request_sha256
) $$;

revoke all on function public.bff_request_conversation_summary_scope(uuid, uuid, uuid, uuid, text, text, bigint, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.bff_request_conversation_summary_scope(uuid, uuid, uuid, uuid, text, text, bigint, integer, text, text, text) to service_role;

