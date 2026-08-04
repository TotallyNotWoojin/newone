begin;
select plan(41);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('71000000-0000-4000-8000-000000000001', 'critical-owner@example.test', now()),
  ('71000000-0000-4000-8000-000000000002', 'critical-member@example.test', now()),
  ('71000000-0000-4000-8000-000000000003', 'critical-third@example.test', now());

update public.profiles set display_name = 'Owner', preferred_language = 'en'
where user_id = '71000000-0000-4000-8000-000000000001';
update public.profiles set display_name = 'Member', preferred_language = 'ko'
where user_id = '71000000-0000-4000-8000-000000000002';
update public.profiles set display_name = 'Third', preferred_language = 'es'
where user_id = '71000000-0000-4000-8000-000000000003';

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('71100000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000002', '71000000-0000-4000-8000-000000000001', now() - interval '20 minutes', now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000003', '71000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('71100000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000003', now(), now(), 'aal2');

do $block$
begin
  perform public.bff_bind_session_installation(
    '71000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    '71200000-0000-4000-8000-000000000001',
    'web', '1.0.0', 'en-US', repeat('1', 64), 'desktop'
  );
  perform public.bff_bind_session_installation(
    '71000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002',
    '71200000-0000-4000-8000-000000000002',
    'web', '1.0.0', 'en-US', repeat('2', 64), 'desktop'
  );
  perform public.bff_bind_session_installation(
    '71000000-0000-4000-8000-000000000002',
    '71100000-0000-4000-8000-000000000003',
    '71200000-0000-4000-8000-000000000003',
    'ios', '1.0.0', 'ko-KR', repeat('3', 64), 'iphone'
  );
  perform public.bff_bind_session_installation(
    '71000000-0000-4000-8000-000000000003',
    '71100000-0000-4000-8000-000000000004',
    '71200000-0000-4000-8000-000000000004',
    'android', '1.0.0', 'es-ES', repeat('4', 64), 'android'
  );
end
$block$;

insert into public.organizations (
  id, slug, name, require_mfa_for_admins, created_by_user_id
) values (
  '72000000-0000-4000-8000-000000000001',
  'critical-updates-contract', 'Critical Updates Contract', true,
  '71000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'owner'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'member'),
  ('72000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000003', 'member');

insert into public.conversations (
  id, organization_id, kind, name, history_policy, posting_mode, join_policy,
  created_by_user_id
) values (
  '73000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000001',
  'announcement', 'Critical updates', 'all', 'admins_only', 'invite_only',
  '71000000-0000-4000-8000-000000000001'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', 'owner', '71000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000002', 'member', '71000000-0000-4000-8000-000000000001'),
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000003', 'member', '71000000-0000-4000-8000-000000000001');

insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform,
  push_token_ciphertext, push_token_type, push_project_id, push_environment
) values (
  '71300000-0000-4000-8000-000000000003',
  '72000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000002',
  '71100000-0000-4000-8000-000000000003',
  '71200000-0000-4000-8000-000000000003',
  'ios', 'vault:critical-update-token-0003', 'expo',
  '71400000-0000-4000-8000-000000000003', 'development'
);

-- 1-4: priority is the sole authority for the notification class.
select is(private.notification_class_for_priority('normal'), 'routine', 'normal maps to routine');
select is(private.notification_class_for_priority('important'), 'urgent', 'important maps to urgent');
select is(private.notification_class_for_priority('emergency'), 'critical', 'emergency maps to critical');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"71000000-0000-4000-8000-000000000001","session_id":"71100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, language_code, available_at
) values
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000001', 'text', 'Evacuate through the east exit.', 'en', now()),
  ('72000000-0000-4000-8000-000000000001', '73000000-0000-4000-8000-000000000001', '71000000-0000-4000-8000-000000000001', '74000000-0000-4000-8000-000000000002', 'text', 'Spoofed class.', 'en', now());
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$insert into public.announcements (
      organization_id, conversation_id, message_id, title, priority,
      notification_class, critical_category, quiet_hours_override_reason,
      created_by_user_id
    ) values (
      '72000000-0000-4000-8000-000000000001',
      '73000000-0000-4000-8000-000000000001',
      (select id from public.messages where client_nonce = '74000000-0000-4000-8000-000000000002'),
      'Spoofed', 'normal', 'critical', 'security', 'Attempted class spoof',
      '71000000-0000-4000-8000-000000000001'
    )$$,
  '23514',
  'new row for relation "announcements" violates check constraint "announcements_priority_notification_class_match"',
  'the database rejects a client-spoofed notification class'
);

insert into public.announcements (
  id, organization_id, conversation_id, message_id, title, priority,
  status, requires_acknowledgement, acknowledgement_schema,
  notification_class, critical_category, quiet_hours_override_reason,
  reminder_policy, published_at, expires_at, created_by_user_id
) values (
  '75000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000001',
  '73000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '74000000-0000-4000-8000-000000000001'),
  'Evacuate now', 'emergency', 'published', true,
  '{"schema_version":1,"attestation_required":true,"attestation_prompt":"I confirm I read this","required_keys":["confirmed"],"carry_forward_on_correction":false}'::jsonb,
  'critical', 'safety', 'Life-safety evacuation instruction',
  jsonb_build_object(
    'enabled', true,
    'deadline_at', now() - interval '1 hour',
    'interval_seconds', 300,
    'maximum_reminders', 2,
    'escalate_after_seconds', 900,
    'sms_fallback', false
  ),
  now() - interval '2 hours', now() + interval '1 day',
  '71000000-0000-4000-8000-000000000001'
);

-- 5-6: publication snapshots the audience and emits a body-free version audit.
select is(
  (select count(*)::integer from public.announcement_recipients
   where announcement_id = '75000000-0000-4000-8000-000000000001'),
  3,
  'publication snapshots all active conversation members exactly once'
);
select ok(
  (select count(*) = 1 and bool_and(
      metadata ->> 'notification_class' = 'critical'
      and metadata ->> 'critical_category' = 'safety'
      and not metadata ? 'body'
    )
   from public.audit_events
   where event_type = 'announcement.version.created'
     and target_id = '75000000-0000-4000-8000-000000000001'),
  'the immutable version audit records override authority without message content'
);

-- 7-9: delivery is provider-reconciled; opening a notice records read separately.
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload) values (
  '72000000-0000-4000-8000-000000000001', 'push',
  'critical-update-delivery',
  '{"announcement_id":"75000000-0000-4000-8000-000000000001"}'::jsonb
);
insert into private.push_delivery_attempts (
  organization_id, outbox_job_id, device_id, user_id
) values (
  '72000000-0000-4000-8000-000000000001',
  (select id from private.outbox_jobs where dedupe_key = 'critical-update-delivery'),
  '71300000-0000-4000-8000-000000000003',
  '71000000-0000-4000-8000-000000000002'
);
update private.push_delivery_attempts
set status = 'delivered', attempt_count = 1,
    provider_ticket_id = 'critical-ticket-1',
    provider_accepted_at = now() - interval '1 second',
    delivered_at = now()
where outbox_job_id = (
  select id from private.outbox_jobs where dedupe_key = 'critical-update-delivery'
);
select ok(
  (select delivered_at is not null from public.announcement_recipients
   where announcement_id = '75000000-0000-4000-8000-000000000001'
     and user_id = '71000000-0000-4000-8000-000000000002'),
  'a provider delivery receipt reconciles monotonically to the notice recipient'
);
select lives_ok(
  $$select public.bff_mark_announcement_read(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003',
    '75000000-0000-4000-8000-000000000001',
    'critical-read-member', repeat('5', 64)
  )$$,
  'a recipient can record a notice read through the BFF'
);
select ok(
  (select delivered_at is not null and read_at >= delivered_at
   from public.announcement_recipients
   where announcement_id = '75000000-0000-4000-8000-000000000001'
     and user_id = '71000000-0000-4000-8000-000000000002'),
  'read and provider delivery remain distinct monotonic timestamps'
);

-- 10-14: acknowledgements bind exact versions to attributable session evidence.
select throws_ok(
  $$select public.bff_acknowledge_announcement(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003',
    (select id from public.announcement_versions
     where announcement_id = '75000000-0000-4000-8000-000000000001'),
    null, '{}'::jsonb, 'critical-ack-invalid', repeat('6', 64)
  )$$,
  '42501',
  'valid acknowledgement attestation and session evidence required',
  'a required attestation cannot be omitted'
);
select lives_ok(
  $$select public.bff_acknowledge_announcement(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003',
    (select id from public.announcement_versions
     where announcement_id = '75000000-0000-4000-8000-000000000001'),
    null, '{"confirmed":true}'::jsonb,
    'critical-ack-member-v1', repeat('7', 64)
  )$$,
  'an attributable session can attest even without supplying a push device'
);
select ok(
  (select session_id = '71100000-0000-4000-8000-000000000003'
      and device_id is null
      and installation_id = '71200000-0000-4000-8000-000000000003'
      and platform = 'ios'
      and client_family = 'iphone'
      and octet_length(session_evidence_hash) = 32
      and attestation = '{"confirmed":true}'::jsonb
   from public.announcement_acknowledgements
   where announcement_id = '75000000-0000-4000-8000-000000000001'
     and user_id = '71000000-0000-4000-8000-000000000002'),
  'the acknowledgement stores bounded session and installation evidence'
);
select ok(
  (select array_agg(key order by key) = array[
      'acknowledged_at', 'announcement_id', 'announcement_version_id',
      'client_family', 'device_id', 'installation_id', 'platform',
      'session_evidence_captured', 'session_id'
    ]::text[]
   from jsonb_object_keys(public.bff_acknowledge_announcement(
     '71000000-0000-4000-8000-000000000002',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000003',
     (select id from public.announcement_versions
      where announcement_id = '75000000-0000-4000-8000-000000000001'),
     null, '{"confirmed":true}'::jsonb,
     'critical-ack-member-v1', repeat('7', 64)
   )) key),
  'the acknowledgement receipt exposes only the bounded evidence contract'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"71000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2","session_id":"71100000-0000-4000-8000-000000000003"}',
  true
);
select throws_ok(
  $$insert into public.announcement_acknowledgements (
      organization_id, announcement_id, announcement_version_id, user_id,
      session_id, attestation
    ) values (
      '72000000-0000-4000-8000-000000000001',
      '75000000-0000-4000-8000-000000000001',
      (select id from public.announcement_versions
       where announcement_id = '75000000-0000-4000-8000-000000000001'),
      '71000000-0000-4000-8000-000000000003',
      '71100000-0000-4000-8000-000000000003',
      '{"confirmed":true}'::jsonb
    )$$,
  '42501',
  'current attributable session required for acknowledgement',
  'a direct write cannot forge another recipient or session'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 15-20: corrections append immutable versions and invalidate old-version ack.
select lives_ok(
  $$select public.bff_correct_announcement(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    '75000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000003',
    'Evacuate now - corrected', 'Use the north exit instead.',
    'emergency', true, now() + interval '1 day',
    'The east exit is blocked', 'critical-correction-v2', repeat('8', 64)
  )$$,
  'an authorized publisher can append a reasoned correction'
);
select ok(
  (select count(*) = 2
      and max(version_number) = 2
      and bool_or(version_number = 2
        and correction_of_version_id is not null
        and correction_reason = 'The east exit is blocked')
   from public.announcement_versions
   where announcement_id = '75000000-0000-4000-8000-000000000001'),
  'the correction preserves an immutable two-version chain and reason'
);
select ok(
  (select count(*) = 1 and bool_and(
      metadata ->> 'correction_reason' = 'The east exit is blocked'
      and metadata ->> 'notification_class' = 'critical'
      and not metadata ? 'body'
    )
   from public.audit_events
   where event_type = 'announcement.version.corrected'
     and target_id = '75000000-0000-4000-8000-000000000001'),
  'the correction audit records the reason and override class without content'
);
select ok(
  (select payload ->> 'notification_class' = 'critical'
      and payload ->> 'critical_category' = 'safety'
      and payload ->> 'quiet_hours_override_reason' = 'Life-safety evacuation instruction'
      and not payload ? 'body'
   from private.outbox_jobs
   where dedupe_key like 'announcement-version:%'
     and payload ->> 'announcement_id' = '75000000-0000-4000-8000-000000000001'),
  'the correction push job carries the server-authorized class and no body'
);
select throws_ok(
  $$select public.bff_acknowledge_announcement(
    '71000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000004',
    (select id from public.announcement_versions
     where announcement_id = '75000000-0000-4000-8000-000000000001'
       and version_number = 1),
    null, '{"confirmed":true}'::jsonb,
    'critical-old-version', repeat('9', 64)
  )$$,
  '40001',
  'announcement version was superseded or not found',
  'a recipient cannot acknowledge a superseded version'
);
select lives_ok(
  $$select public.bff_acknowledge_announcement(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    (select id from public.announcement_versions
     where announcement_id = '75000000-0000-4000-8000-000000000001'
     order by version_number desc limit 1),
    null, '{"confirmed":true}'::jsonb,
    'critical-owner-v2', repeat('a', 64)
  )$$,
  'the publisher can acknowledge the exact corrected version as a recipient'
);

-- 21-30: publisher reporting is AAL2/recent-auth gated and privacy scoped.
select throws_ok(
  $$select public.bff_list_managed_announcements(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002', 50
  )$$,
  '42501', 'request authorization denied',
  'publisher reporting rejects an AAL2 session outside the recent-auth window'
);
select is(
  jsonb_array_length(public.bff_list_managed_announcements(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003', 50
  ) -> 'updates'),
  0,
  'an ordinary member receives no managed-update records'
);
select ok(
  (select array_agg(key order by key) = array[
      'generated_at', 'sms_fallback_available', 'updates'
    ]::text[]
   from jsonb_object_keys(public.bff_list_managed_announcements(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001', 50
   )) key),
  'the publisher aggregate response has a strict top-level contract'
);
select ok(
  (select (item ->> 'recipient_count')::integer = 3
      and (item ->> 'delivered_count')::integer = 1
      and (item ->> 'read_count')::integer = 1
      and (item ->> 'acknowledged_count')::integer = 1
      and (item ->> 'non_acknowledged_count')::integer = 2
      and (item ->> 'overdue_count')::integer = 2
      and (item ->> 'unreachable_count')::integer = 2
      and (item ->> 'audience_snapshotted')::boolean
   from jsonb_array_elements(public.bff_list_managed_announcements(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001', 50
   ) -> 'updates') item
   where item ->> 'announcement_id' = '75000000-0000-4000-8000-000000000001'),
  'publisher aggregates distinguish recipient, delivery, read, latest ack, overdue, and reachability state'
);
select ok(
  (select (item ->> 'version_count')::integer = 2
      and jsonb_array_length(item -> 'versions') = 2
      and item -> 'versions' -> 0 ->> 'version_number' = '2'
      and item -> 'versions' -> 1 ->> 'version_number' = '1'
   from jsonb_array_elements(public.bff_list_managed_announcements(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001', 50
   ) -> 'updates') item
   where item ->> 'announcement_id' = '75000000-0000-4000-8000-000000000001'),
  'publisher reporting returns the exact immutable version count and newest-first history'
);
select throws_ok(
  $$select public.bff_list_announcement_non_acknowledgers(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003',
    '75000000-0000-4000-8000-000000000001', null, 1
  )$$,
  '42501', 'announcement response details are not permitted',
  'an ordinary member cannot enumerate non-acknowledgers'
);
select ok(
  (select page ->> 'privacy_scope' = 'notice_response_state_only'
      and (page ->> 'has_more')::boolean
      and page ->> 'next_after_user_id' = '71000000-0000-4000-8000-000000000002'
      and jsonb_array_length(page -> 'people') = 1
      and page -> 'people' -> 0 ->> 'user_id' = '71000000-0000-4000-8000-000000000002'
      and page -> 'people' -> 0 ->> 'preferred_language' = 'ko'
      and page -> 'people' -> 0 ->> 'reachability' = 'delivered'
      and page::text !~ 'email|session_id|scope_snapshot|job_title'
   from (select public.bff_list_announcement_non_acknowledgers(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001',
     '75000000-0000-4000-8000-000000000001', null, 1
   ) page) listed),
  'the first non-ack page is stable, bounded, reachable-state-only, and privacy scoped'
);
select ok(
  (select not (page ->> 'has_more')::boolean
      and page ->> 'next_after_user_id' is null
      and jsonb_array_length(page -> 'people') = 1
      and page -> 'people' -> 0 ->> 'user_id' = '71000000-0000-4000-8000-000000000003'
      and page -> 'people' -> 0 ->> 'preferred_language' = 'es'
      and page -> 'people' -> 0 ->> 'reachability' = 'unreachable'
   from (select public.bff_list_announcement_non_acknowledgers(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001',
     '75000000-0000-4000-8000-000000000001',
     '71000000-0000-4000-8000-000000000002', 1
   ) page) listed),
  'the cursor returns the next exact non-acknowledger without overlap'
);
select lives_ok(
  $$select public.bff_acknowledge_announcement(
    '71000000-0000-4000-8000-000000000002',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000003',
    (select id from public.announcement_versions
     where announcement_id = '75000000-0000-4000-8000-000000000001'
     order by version_number desc limit 1),
    '71300000-0000-4000-8000-000000000003',
    '{"confirmed":true}'::jsonb,
    'critical-member-v2', repeat('b', 64)
  )$$,
  'the member can acknowledge the latest version with matching push-device evidence'
);
select ok(
  (select (item ->> 'acknowledged_count')::integer = 2
      and (item ->> 'non_acknowledged_count')::integer = 1
      and (item ->> 'overdue_count')::integer = 1
   from jsonb_array_elements(public.bff_list_managed_announcements(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001', 50
   ) -> 'updates') item
   where item ->> 'announcement_id' = '75000000-0000-4000-8000-000000000001'),
  'publisher aggregates reconcile against acknowledgements of only the latest version'
);

-- 31-35: acknowledgement evidence is immutable but survives Auth FK cleanup.
select throws_ok(
  $$update public.announcement_acknowledgements
    set attestation = '{"confirmed":false}'::jsonb
    where announcement_id = '75000000-0000-4000-8000-000000000001'
      and user_id = '71000000-0000-4000-8000-000000000002'
      and announcement_version_id = (
        select id from public.announcement_versions
        where announcement_id = '75000000-0000-4000-8000-000000000001'
        order by version_number desc limit 1
      )$$,
  '22000', 'announcement acknowledgements are immutable',
  'acknowledgement evidence cannot be updated'
);
select throws_ok(
  $$delete from public.announcement_acknowledgements
    where announcement_id = '75000000-0000-4000-8000-000000000001'
      and user_id = '71000000-0000-4000-8000-000000000002'
      and announcement_version_id = (
        select id from public.announcement_versions
        where announcement_id = '75000000-0000-4000-8000-000000000001'
        order by version_number desc limit 1
      )$$,
  '22000', 'announcement acknowledgements are immutable',
  'acknowledgement evidence cannot be deleted'
);
select throws_ok(
  $$update public.announcement_acknowledgements
    set session_id = null
    where announcement_id = '75000000-0000-4000-8000-000000000001'
      and user_id = '71000000-0000-4000-8000-000000000002'$$,
  '22000', 'announcement acknowledgements are immutable',
  'a caller cannot imitate Auth referential cleanup'
);
update private.session_installations
set revoked_at = now()
where session_id = '71100000-0000-4000-8000-000000000003';
select lives_ok(
  $$delete from auth.sessions
    where id = '71100000-0000-4000-8000-000000000003'$$,
  'Auth session cleanup may null the FK without rewriting evidence'
);
select ok(
  (select count(*) = 2 and bool_and(
      session_id is null
      and installation_id = '71200000-0000-4000-8000-000000000003'
      and platform = 'ios'
      and client_family = 'iphone'
      and octet_length(session_evidence_hash) = 32
    )
   from public.announcement_acknowledgements
   where announcement_id = '75000000-0000-4000-8000-000000000001'
     and user_id = '71000000-0000-4000-8000-000000000002'),
  'the bounded installation evidence persists after the Auth session is removed'
);

-- 36-41: audience preview and schedule/cancel controls honor recent AAL2.
select throws_ok(
  $$select public.bff_preview_announcement_audience(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000002',
    '73000000-0000-4000-8000-000000000001', 25
  )$$,
  '42501', 'request authorization denied',
  'audience preview rejects stale AAL2'
);
select ok(
  (select (preview ->> 'total_count')::integer = 3
      and (preview ->> 'excluded_count')::integer = 0
      and jsonb_array_length(preview -> 'preview') = 3
      and preview -> 'notification_languages' = '["en","es","ko"]'::jsonb
   from (select public.bff_preview_announcement_audience(
     '71000000-0000-4000-8000-000000000001',
     '72000000-0000-4000-8000-000000000001',
     '71100000-0000-4000-8000-000000000001',
     '73000000-0000-4000-8000-000000000001', 25
   ) preview) listed),
  'fresh AAL2 preview returns the exact audience, exclusions, sample, and languages'
);
select lives_ok(
  $$select public.bff_create_announcement(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    '73000000-0000-4000-8000-000000000001',
    '74000000-0000-4000-8000-000000000004',
    'Scheduled maintenance', 'Maintenance begins in one hour.', 'en',
    'normal', false, now() + interval '2 hours', now() + interval '1 hour',
    '{"schema_version":1,"attestation_required":false,"attestation_prompt":null,"required_keys":[],"carry_forward_on_correction":false}'::jsonb,
    'routine', null, null,
    '{"enabled":false,"deadline_at":null,"interval_seconds":null,"maximum_reminders":0,"escalate_after_seconds":null,"sms_fallback":false}'::jsonb,
    'critical-scheduled-create', repeat('c', 64)
  )$$,
  'a publisher can schedule a routine update after preview'
);
select ok(
  (select announcement.status = 'scheduled'
      and announcement.scheduled_at > now()
      and announcement.published_at is null
      and announcement.notification_class = 'routine'
      and not exists (
        select 1 from public.announcement_recipients recipient
        where recipient.announcement_id = announcement.id
      )
   from public.announcements announcement
   join public.messages message on message.id = announcement.message_id
   where message.client_nonce = '74000000-0000-4000-8000-000000000004'),
  'scheduled state is explicit and does not snapshot recipients before publication'
);
select lives_ok(
  $$select public.bff_cancel_scheduled_announcement(
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000001',
    '71100000-0000-4000-8000-000000000001',
    (select announcement.id
     from public.announcements announcement
     join public.messages message on message.id = announcement.message_id
     where message.client_nonce = '74000000-0000-4000-8000-000000000004'),
    'Maintenance window changed', 'critical-scheduled-cancel', repeat('d', 64)
  )$$,
  'a publisher can cancel a future scheduled update with a reason'
);
select ok(
  (select announcement.status = 'cancelled'
      and announcement.cancelled_at is not null
      and announcement.cancelled_by_user_id = '71000000-0000-4000-8000-000000000001'
      and announcement.cancellation_reason = 'Maintenance window changed'
      and message.deleted_at is not null
   from public.announcements announcement
   join public.messages message on message.id = announcement.message_id
   where message.client_nonce = '74000000-0000-4000-8000-000000000004'),
  'cancellation preserves the reason and withdraws the future message'
);

select * from finish();
rollback;
