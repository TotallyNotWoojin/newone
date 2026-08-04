begin;

-- Critical Updates use one server-owned mapping. A client cannot label a
-- routine item as critical (or suppress an emergency as routine) while still
-- supplying a syntactically valid payload.
create or replace function private.notification_class_for_priority(p_priority text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case p_priority
    when 'normal' then 'routine'
    when 'important' then 'urgent'
    when 'emergency' then 'critical'
    else null
  end
$$;

alter table public.announcements
  add constraint announcements_priority_notification_class_match
  check (notification_class = private.notification_class_for_priority(priority))
  not valid;
alter table public.announcements
  validate constraint announcements_priority_notification_class_match;

alter table public.announcement_versions
  add constraint announcement_versions_priority_notification_class_match
  check (notification_class = private.notification_class_for_priority(priority))
  not valid;
alter table public.announcement_versions
  validate constraint announcement_versions_priority_notification_class_match;

-- Persist a non-secret installation/session fingerprint with every new
-- acknowledgement. The Auth session FK may later be cleared by Auth cleanup;
-- this immutable snapshot remains available as evidence without retaining a
-- raw token, IP address, user agent, or push token.
alter table public.announcement_acknowledgements
  add column installation_id uuid,
  add column platform text,
  add column client_family text,
  add column session_evidence_hash bytea;

alter table public.announcement_acknowledgements
  add constraint announcement_acknowledgements_platform_allowed
    check (platform is null or platform in ('ios', 'android', 'web')),
  add constraint announcement_acknowledgements_client_family_allowed
    check (client_family is null or client_family in (
      'iphone', 'ipad', 'android', 'mobile', 'desktop', 'unknown'
    )),
  add constraint announcement_acknowledgements_evidence_hash_length
    check (session_evidence_hash is null or octet_length(session_evidence_hash) = 32),
  add constraint announcement_acknowledgements_evidence_snapshot_consistent
    check (
      (installation_id is null and platform is null and client_family is null
        and session_evidence_hash is null)
      or (installation_id is not null and platform is not null
        and client_family is not null and session_evidence_hash is not null)
    );

create or replace function private.bind_announcement_acknowledgement_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_claim_session_id uuid := nullif((select auth.jwt() ->> 'session_id'), '')::uuid;
  v_schema jsonb;
  v_installation_id uuid;
  v_platform text;
  v_client_family text;
begin
  if v_actor_id is null or v_claim_session_id is null
    or new.user_id is distinct from v_actor_id
    or (new.session_id is not null and new.session_id is distinct from v_claim_session_id) then
    raise exception 'current attributable session required for acknowledgement'
      using errcode = '42501';
  end if;

  select binding.installation_id, binding.platform, binding.user_agent_family
    into v_installation_id, v_platform, v_client_family
  from private.session_installations binding
  join auth.sessions session
    on session.id = binding.session_id
   and session.user_id = binding.user_id
  where binding.session_id = v_claim_session_id
    and binding.user_id = new.user_id
    and binding.revoked_at is null
    and (session.not_after is null or session.not_after > now());
  if not found then
    raise exception 'current attributable session required for acknowledgement'
      using errcode = '42501';
  end if;

  select version.acknowledgement_schema into v_schema
  from public.announcement_versions version
  join public.announcements announcement
    on announcement.organization_id = version.organization_id
   and announcement.id = version.announcement_id
  where version.organization_id = new.organization_id
    and version.announcement_id = new.announcement_id
    and version.id = new.announcement_version_id
    and version.requires_acknowledgement
    and announcement.status in ('published', 'archived')
    and not exists (
      select 1 from public.announcement_versions newer
      where newer.organization_id = version.organization_id
        and newer.announcement_id = version.announcement_id
        and newer.version_number > version.version_number
    )
    and exists (
      select 1 from public.announcement_recipients recipient
      where recipient.organization_id = version.organization_id
        and recipient.announcement_id = version.announcement_id
        and recipient.user_id = new.user_id
    );
  if not found or not private.attestation_satisfies_schema(
      v_schema, coalesce(new.attestation, '{}'::jsonb)
    ) then
    raise exception 'latest notice version and valid attestation required'
      using errcode = '42501';
  end if;

  if new.device_id is not null and not exists (
    select 1
    from public.device_registrations device
    where device.organization_id = new.organization_id
      and device.id = new.device_id
      and device.user_id = new.user_id
      and device.session_id = v_claim_session_id
      and device.installation_id = v_installation_id
      and device.platform = v_platform
      and device.revoked_at is null
  ) then
    raise exception 'acknowledgement device is not bound to the current session'
      using errcode = '42501';
  end if;

  new.session_id := v_claim_session_id;
  new.installation_id := v_installation_id;
  new.platform := v_platform;
  new.client_family := v_client_family;
  new.session_evidence_hash := extensions.digest(
    convert_to(
      new.organization_id::text || ':' || new.user_id::text || ':'
        || v_claim_session_id::text || ':' || v_installation_id::text || ':' || v_platform,
      'UTF8'
    ),
    'sha256'
  );
  select membership.role into new.role_snapshot
  from public.organization_memberships membership
  where membership.organization_id = new.organization_id
    and membership.user_id = new.user_id
    and membership.status = 'active';
  if not found then
    raise exception 'active announcement recipient required' using errcode = '42501';
  end if;
  new.scope_snapshot := private.effective_scopes_internal(
    new.user_id, new.organization_id
  );
  return new;
exception
  when invalid_text_representation then
    raise exception 'current attributable session required for acknowledgement'
      using errcode = '42501';
end;
$$;

create trigger announcement_acknowledgements_08_bind_evidence
before insert on public.announcement_acknowledgements
for each row execute function private.bind_announcement_acknowledgement_evidence();

-- The acknowledgement itself is immutable. Auth may eventually remove an
-- expired session through its existing ON DELETE SET NULL FK; only that
-- referential-hygiene transition is allowed, while the non-secret evidence
-- snapshot remains unchanged.
create or replace function private.prevent_announcement_acknowledgement_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and pg_trigger_depth() > 1
    and old.session_id is not null
    and new.session_id is null
    and (to_jsonb(new) - 'session_id') = (to_jsonb(old) - 'session_id') then
    return new;
  end if;
  raise exception 'announcement acknowledgements are immutable' using errcode = '22000';
end;
$$;

create trigger announcement_acknowledgements_immutable
before update or delete on public.announcement_acknowledgements
for each row execute function private.prevent_announcement_acknowledgement_mutation();

-- Each immutable version receives a bounded audit record. Urgent/critical
-- metadata proves the server-authorized quiet-hours override category and
-- reason without copying the announcement body into the audit stream.
create or replace function private.audit_announcement_version_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
begin
  begin
    v_request_id := nullif(current_setting('app.audit_request_id', true), '')::uuid;
  exception when others then
    v_request_id := null;
  end;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id,
    request_id, metadata
  ) values (
    new.organization_id,
    new.created_by_user_id,
    case when new.version_number = 1
      then 'announcement.version.created'
      else 'announcement.version.corrected'
    end,
    'announcement',
    new.announcement_id::text,
    v_request_id,
    jsonb_strip_nulls(jsonb_build_object(
      'announcement_version_id', new.id,
      'version_number', new.version_number,
      'notification_class', new.notification_class,
      'critical_category', new.critical_category,
      'quiet_hours_override_reason', new.quiet_hours_override_reason,
      'correction_of_version_id', new.correction_of_version_id,
      'correction_reason', new.correction_reason,
      'bff_operation', nullif(current_setting('app.audit_operation', true), ''),
      'result', 'committed'
    ))
  );
  return new;
end;
$$;

create trigger audit_announcement_versions
after insert on public.announcement_versions
for each row execute function private.audit_announcement_version_insert();

-- A provider receipt is the trusted boundary for update delivery. Multiple
-- devices collapse monotonically into one recipient timestamp.
create or replace function private.reconcile_announcement_push_delivery()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_announcement_id uuid;
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    select nullif(job.payload ->> 'announcement_id', '')::uuid
      into v_announcement_id
    from private.outbox_jobs job
    where job.id = new.outbox_job_id;
    if v_announcement_id is not null then
      update public.announcement_recipients recipient
      set delivered_at = coalesce(recipient.delivered_at, new.delivered_at, now())
      where recipient.organization_id = new.organization_id
        and recipient.announcement_id = v_announcement_id
        and recipient.user_id = new.user_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger push_delivery_attempts_95_reconcile_announcement
after update of status on private.push_delivery_attempts
for each row execute function private.reconcile_announcement_push_delivery();

create or replace function private.bff_acknowledge_announcement_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_version_id uuid,
  p_device_id uuid,
  p_attestation jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_announcement_id uuid;
  v_acknowledged_at timestamptz;
  v_ack_schema jsonb;
  v_installation_id uuid;
  v_platform text;
  v_client_family text;
  v_evidence_hash bytea;
  v_evidence_session_id uuid;
  v_evidence_device_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.acknowledge', false, 0,
    '/v2/updates/:versionId/acknowledgements',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  -- Resolve and lock the parent using the same ordering as correction. The
  -- latest-version predicate below is evaluated after concurrent corrections.
  select version.announcement_id into v_announcement_id
  from public.announcement_versions version
  where version.organization_id = p_organization_id
    and version.id = p_announcement_version_id;
  if not found then
    raise exception 'announcement version was superseded or not found'
      using errcode = '40001';
  end if;
  perform 1
  from public.announcements announcement
  where announcement.organization_id = p_organization_id
    and announcement.id = v_announcement_id
  for update;
  if not found then
    raise exception 'announcement version was superseded or not found'
      using errcode = '40001';
  end if;
  select version.acknowledgement_schema into v_ack_schema
  from public.announcement_versions version
  join public.announcements announcement
    on announcement.organization_id = version.organization_id
   and announcement.id = version.announcement_id
  where version.organization_id = p_organization_id
    and version.id = p_announcement_version_id
    and version.announcement_id = v_announcement_id
    and announcement.status in ('published', 'archived')
    and version.requires_acknowledgement
    and not exists (
      select 1 from public.announcement_versions newer
      where newer.organization_id = version.organization_id
        and newer.announcement_id = version.announcement_id
        and newer.version_number > version.version_number
    )
    and exists (
      select 1 from public.announcement_recipients recipient
      where recipient.organization_id = version.organization_id
        and recipient.announcement_id = version.announcement_id
        and recipient.user_id = p_actor_user_id
    );
  if not found then
    raise exception 'announcement version was superseded or not found'
      using errcode = '40001';
  end if;
  if not private.attestation_satisfies_schema(
      v_ack_schema, coalesce(p_attestation, '{}'::jsonb)
    )
    or (p_device_id is not null and not exists (
      select 1 from public.device_registrations device
      join auth.sessions device_session
        on device_session.id = device.session_id
       and device_session.user_id = device.user_id
      join private.session_installations session_binding
        on session_binding.session_id = device_session.id
       and session_binding.user_id = device.user_id
       and session_binding.installation_id = device.installation_id
       and session_binding.platform = device.platform
       and session_binding.revoked_at is null
      where device.organization_id = p_organization_id
        and device.id = p_device_id
        and device.user_id = p_actor_user_id
        and device.session_id = p_session_id
        and device.revoked_at is null
        and (device_session.not_after is null or device_session.not_after > now())
        and not exists (
          select 1 from private.session_revocations revocation
          where revocation.organization_id = device.organization_id
            and revocation.session_id = device_session.id
        )
    )) then
    raise exception 'valid acknowledgement attestation and session evidence required'
      using errcode = '42501';
  end if;

  insert into public.announcement_acknowledgements (
    organization_id, announcement_id, announcement_version_id, user_id,
    session_id, device_id, attestation
  ) values (
    p_organization_id, v_announcement_id, p_announcement_version_id, p_actor_user_id,
    p_session_id, p_device_id, coalesce(p_attestation, '{}'::jsonb)
  )
  on conflict (organization_id, announcement_id, announcement_version_id, user_id)
    do nothing;

  select acknowledgement.acknowledged_at,
      acknowledgement.session_id, acknowledgement.device_id,
      acknowledgement.installation_id, acknowledgement.platform,
      acknowledgement.client_family, acknowledgement.session_evidence_hash
    into v_acknowledged_at, v_evidence_session_id, v_evidence_device_id,
      v_installation_id, v_platform, v_client_family, v_evidence_hash
  from public.announcement_acknowledgements acknowledgement
  where acknowledgement.organization_id = p_organization_id
    and acknowledgement.announcement_id = v_announcement_id
    and acknowledgement.announcement_version_id = p_announcement_version_id
    and acknowledgement.user_id = p_actor_user_id;
  if not found then
    raise exception 'announcement recipient not found' using errcode = '42501';
  end if;

  v_response := jsonb_build_object(
    'announcement_id', v_announcement_id,
    'announcement_version_id', p_announcement_version_id,
    'acknowledged_at', v_acknowledged_at,
    'session_id', v_evidence_session_id,
    'device_id', v_evidence_device_id,
    'installation_id', v_installation_id,
    'platform', v_platform,
    'client_family', v_client_family,
    'session_evidence_captured', v_evidence_hash is not null
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/updates/:versionId/acknowledgements',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_mark_announcement_read_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_read_at timestamptz;
  v_delivered_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.read', false, 0, '/v2/updates/:id/read',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  update public.announcement_recipients recipient
  set read_at = coalesce(recipient.read_at, now())
  where recipient.organization_id = p_organization_id
    and recipient.announcement_id = p_announcement_id
    and recipient.user_id = p_actor_user_id
    and exists (
      select 1 from public.announcements announcement
      where announcement.organization_id = recipient.organization_id
        and announcement.id = recipient.announcement_id
        and announcement.status in ('published', 'archived')
    )
  returning recipient.read_at, recipient.delivered_at
    into v_read_at, v_delivered_at;
  if not found then
    raise exception 'published announcement recipient not found' using errcode = 'P0002';
  end if;
  v_response := jsonb_build_object(
    'announcement_id', p_announcement_id,
    'read_at', v_read_at,
    'delivered_at', v_delivered_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/updates/:id/read',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_list_managed_announcements_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_items jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.manage.list', true, 300
  );
  if p_limit not between 1 and 100 then
    raise exception 'valid managed announcement limit required' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(row.payload order by row.sort_at desc, row.announcement_id), '[]'::jsonb)
    into v_items
  from (
    select announcement.id as announcement_id,
      coalesce(announcement.scheduled_at, announcement.published_at, announcement.created_at) as sort_at,
      jsonb_strip_nulls(jsonb_build_object(
        'announcement_id', announcement.id,
        'conversation_id', announcement.conversation_id,
        'conversation_title', conversation.name,
        'announcement_version_id', version.id,
        'version_number', version.version_number,
        'version_count', versions.version_count,
        'title', version.title,
        'body', message.body,
        'language_code', message.language_code,
        'priority', version.priority,
        'notification_class', version.notification_class,
        'critical_category', version.critical_category,
        'quiet_hours_override_reason', version.quiet_hours_override_reason,
        'requires_acknowledgement', version.requires_acknowledgement,
        'acknowledgement_schema', version.acknowledgement_schema,
        'reminder_policy', version.reminder_policy,
        'status', announcement.status,
        'scheduled_at', announcement.scheduled_at,
        'published_at', announcement.published_at,
        'expires_at', version.expires_at,
        'cancelled_at', announcement.cancelled_at,
        'cancellation_reason', announcement.cancellation_reason,
        'correction_of_version_id', version.correction_of_version_id,
        'correction_reason', version.correction_reason,
        'audience_snapshotted', announcement.status in ('published', 'archived'),
        'recipient_count', stats.recipient_count,
        'delivered_count', stats.delivered_count,
        'read_count', stats.read_count,
        'acknowledged_count', stats.acknowledged_count,
        'non_acknowledged_count', stats.non_acknowledged_count,
        'overdue_count', stats.overdue_count,
        'unreachable_count', stats.unreachable_count,
        'versions', versions.items
      )) as payload
    from public.announcements announcement
    join public.conversations conversation
      on conversation.organization_id = announcement.organization_id
     and conversation.id = announcement.conversation_id
    join lateral (
      select candidate.*
      from public.announcement_versions candidate
      where candidate.organization_id = announcement.organization_id
        and candidate.announcement_id = announcement.id
      order by candidate.version_number desc
      limit 1
    ) version on true
    join public.messages message
      on message.organization_id = version.organization_id
     and message.conversation_id = version.conversation_id
     and message.id = version.message_id
    join lateral (
      select (
          select count(*)::integer
          from public.announcement_versions total
          where total.organization_id = announcement.organization_id
            and total.announcement_id = announcement.id
        ) as version_count,
        coalesce(jsonb_agg(history.payload order by history.version_number desc), '[]'::jsonb) as items
      from (
        select candidate.version_number,
          jsonb_strip_nulls(jsonb_build_object(
            'announcement_version_id', candidate.id,
            'version_number', candidate.version_number,
            'title', candidate.title,
            'body', candidate_message.body,
            'published_at', candidate.published_at,
            'correction_of_version_id', candidate.correction_of_version_id,
            'correction_reason', candidate.correction_reason,
            'created_by_user_id', candidate.created_by_user_id,
            'created_by_display_name', candidate_creator.display_name
          )) as payload
        from public.announcement_versions candidate
        join public.messages candidate_message
          on candidate_message.organization_id = candidate.organization_id
         and candidate_message.conversation_id = candidate.conversation_id
         and candidate_message.id = candidate.message_id
        join public.profiles candidate_creator
          on candidate_creator.user_id = candidate.created_by_user_id
        where candidate.organization_id = announcement.organization_id
          and candidate.announcement_id = announcement.id
        order by candidate.version_number desc
        limit 20
      ) history
    ) versions on true
    join lateral (
      select count(*)::integer as recipient_count,
        count(*) filter (where recipient.delivered_at is not null)::integer as delivered_count,
        count(*) filter (where recipient.read_at is not null)::integer as read_count,
        count(*) filter (where exists (
          select 1 from public.announcement_acknowledgements acknowledgement
          where acknowledgement.organization_id = recipient.organization_id
            and acknowledgement.announcement_id = recipient.announcement_id
            and acknowledgement.announcement_version_id = version.id
            and acknowledgement.user_id = recipient.user_id
        ))::integer as acknowledged_count,
        count(*) filter (where version.requires_acknowledgement and not exists (
          select 1 from public.announcement_acknowledgements acknowledgement
          where acknowledgement.organization_id = recipient.organization_id
            and acknowledgement.announcement_id = recipient.announcement_id
            and acknowledgement.announcement_version_id = version.id
            and acknowledgement.user_id = recipient.user_id
        ))::integer as non_acknowledged_count,
        count(*) filter (
          where version.requires_acknowledgement
            and (version.reminder_policy ->> 'enabled')::boolean
            and (version.reminder_policy ->> 'deadline_at')::timestamptz <= now()
            and not exists (
              select 1 from public.announcement_acknowledgements acknowledgement
              where acknowledgement.organization_id = recipient.organization_id
                and acknowledgement.announcement_id = recipient.announcement_id
                and acknowledgement.announcement_version_id = version.id
                and acknowledgement.user_id = recipient.user_id
            )
        )::integer as overdue_count,
        count(*) filter (where not exists (
          select 1
          from public.device_registrations device
          join auth.sessions device_session
            on device_session.id = device.session_id
           and device_session.user_id = device.user_id
          join private.session_installations binding
            on binding.session_id = device_session.id
           and binding.user_id = device.user_id
           and binding.installation_id = device.installation_id
           and binding.platform = device.platform
           and binding.revoked_at is null
          where device.organization_id = recipient.organization_id
            and device.user_id = recipient.user_id
            and device.revoked_at is null
            and (device_session.not_after is null or device_session.not_after > now())
            and not exists (
              select 1 from private.session_revocations revocation
              where revocation.organization_id = device.organization_id
                and revocation.session_id = device_session.id
            )
        ))::integer as unreachable_count
      from public.announcement_recipients recipient
      where recipient.organization_id = announcement.organization_id
        and recipient.announcement_id = announcement.id
    ) stats on true
    where announcement.organization_id = p_organization_id
      and private.actor_has_permission(
        p_actor_user_id, p_organization_id, 'communications.publish', conversation.unit_id
      )
    order by coalesce(
      announcement.scheduled_at, announcement.published_at, announcement.created_at
    ) desc, announcement.id
    limit p_limit
  ) row;

  return jsonb_build_object(
    'updates', v_items,
    'generated_at', now(),
    'sms_fallback_available', false
  );
end;
$$;

create or replace function private.bff_list_announcement_non_acknowledgers_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_id uuid,
  p_after_user_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_version_number integer;
  v_unit_id uuid;
  v_deadline timestamptz;
  v_people jsonb;
  v_has_more boolean;
  v_next_user_id uuid;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.non_acknowledgers.list', true, 300
  );
  if p_limit not between 1 and 100 then
    raise exception 'valid non-acknowledger page size required' using errcode = '22023';
  end if;

  select version.id, version.version_number, conversation.unit_id,
      nullif(version.reminder_policy ->> 'deadline_at', '')::timestamptz
    into v_version_id, v_version_number, v_unit_id, v_deadline
  from public.announcements announcement
  join public.conversations conversation
    on conversation.organization_id = announcement.organization_id
   and conversation.id = announcement.conversation_id
  join lateral (
    select candidate.*
    from public.announcement_versions candidate
    where candidate.organization_id = announcement.organization_id
      and candidate.announcement_id = announcement.id
    order by candidate.version_number desc
    limit 1
  ) version on version.requires_acknowledgement
  where announcement.organization_id = p_organization_id
    and announcement.id = p_announcement_id
    and announcement.status in ('published', 'archived');
  if not found or not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'communications.publish', v_unit_id
    ) then
    raise exception 'announcement response details are not permitted' using errcode = '42501';
  end if;

  with candidate as (
    select recipient.user_id, profile.display_name,
      lower(coalesce(preference.message_language, profile.preferred_language)) as preferred_language,
      membership.status as membership_status,
      recipient.delivered_at, recipient.read_at, recipient.reminder_count,
      recipient.last_reminded_at, recipient.escalated_at,
      case
        when recipient.delivered_at is not null then 'delivered'
        when exists (
          select 1
          from public.device_registrations device
          join auth.sessions device_session
            on device_session.id = device.session_id
           and device_session.user_id = device.user_id
          join private.session_installations binding
            on binding.session_id = device_session.id
           and binding.user_id = device.user_id
           and binding.installation_id = device.installation_id
           and binding.platform = device.platform
           and binding.revoked_at is null
          where device.organization_id = recipient.organization_id
            and device.user_id = recipient.user_id
            and device.revoked_at is null
            and (device_session.not_after is null or device_session.not_after > now())
            and not exists (
              select 1 from private.session_revocations revocation
              where revocation.organization_id = device.organization_id
                and revocation.session_id = device_session.id
            )
        ) then 'pending'
        else 'unreachable'
      end as reachability
    from public.announcement_recipients recipient
    join public.organization_memberships membership
      on membership.organization_id = recipient.organization_id
     and membership.user_id = recipient.user_id
    join public.profiles profile on profile.user_id = recipient.user_id
    left join public.organization_user_preferences preference
      on preference.organization_id = recipient.organization_id
     and preference.user_id = recipient.user_id
    where recipient.organization_id = p_organization_id
      and recipient.announcement_id = p_announcement_id
      and (p_after_user_id is null or recipient.user_id > p_after_user_id)
      and not exists (
        select 1 from public.announcement_acknowledgements acknowledgement
        where acknowledgement.organization_id = recipient.organization_id
          and acknowledgement.announcement_id = recipient.announcement_id
          and acknowledgement.announcement_version_id = v_version_id
          and acknowledgement.user_id = recipient.user_id
      )
    order by recipient.user_id
    limit p_limit + 1
  ), numbered as (
    select candidate.*, row_number() over (order by candidate.user_id) as row_number
    from candidate
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'user_id', numbered.user_id,
      'display_name', numbered.display_name,
      'preferred_language', numbered.preferred_language,
      'membership_status', numbered.membership_status,
      'delivered_at', numbered.delivered_at,
      'read_at', numbered.read_at,
      'reminder_count', numbered.reminder_count,
      'last_reminded_at', numbered.last_reminded_at,
      'escalated_at', numbered.escalated_at,
      'reachability', numbered.reachability,
      'overdue', v_deadline is not null and v_deadline <= now()
    )) order by numbered.user_id) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    (array_agg(numbered.user_id order by numbered.user_id)
      filter (where numbered.row_number = p_limit))[1]
    into v_people, v_has_more, v_next_user_id
  from numbered;

  return jsonb_build_object(
    'announcement_id', p_announcement_id,
    'announcement_version_id', v_version_id,
    'version_number', v_version_number,
    'deadline_at', v_deadline,
    'people', v_people,
    'has_more', coalesce(v_has_more, false),
    'next_after_user_id', case when v_has_more then v_next_user_id else null end,
    'privacy_scope', 'notice_response_state_only'
  );
end;
$$;

create or replace function public.bff_mark_announcement_read(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_mark_announcement_read_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_announcement_id,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_list_managed_announcements(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_list_managed_announcements_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_limit
  )
$$;

create or replace function public.bff_list_announcement_non_acknowledgers(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_id uuid,
  p_after_user_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_list_announcement_non_acknowledgers_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_announcement_id,
    p_after_user_id, p_limit
  )
$$;

revoke all on function public.bff_mark_announcement_read(
  uuid, uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.bff_mark_announcement_read(
  uuid, uuid, uuid, uuid, text, text
) to service_role;

revoke all on function public.bff_list_managed_announcements(
  uuid, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.bff_list_managed_announcements(
  uuid, uuid, uuid, integer
) to service_role;

revoke all on function public.bff_list_announcement_non_acknowledgers(
  uuid, uuid, uuid, uuid, uuid, integer
) from public, anon, authenticated;
grant execute on function public.bff_list_announcement_non_acknowledgers(
  uuid, uuid, uuid, uuid, uuid, integer
) to service_role;

comment on function public.bff_list_managed_announcements(uuid, uuid, uuid, integer) is
  'Service-only AAL2 publisher read model with bounded aggregate delivery and acknowledgement state.';
comment on function public.bff_list_announcement_non_acknowledgers(uuid, uuid, uuid, uuid, uuid, integer) is
  'Service-only AAL2 notice-scoped non-acknowledger page; returns no unrelated activity.';

commit;
