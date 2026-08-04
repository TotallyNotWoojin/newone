begin;
select plan(23);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('8a000000-0000-4000-8000-000000000001', 'notification-recipient@example.test', now()),
  ('8a000000-0000-4000-8000-000000000002', 'notification-sender@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('8a100000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('8a100000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('8a100000-0000-4000-8000-000000000003', '8a000000-0000-4000-8000-000000000002', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values
  ('8a100000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', '8a200000-0000-4000-8000-000000000001', 'ios', decode(repeat('8a', 32), 'hex'), 'iphone'),
  ('8a100000-0000-4000-8000-000000000002', '8a000000-0000-4000-8000-000000000001', '8a200000-0000-4000-8000-000000000002', 'android', decode(repeat('8b', 32), 'hex'), 'android'),
  ('8a100000-0000-4000-8000-000000000003', '8a000000-0000-4000-8000-000000000002', '8a200000-0000-4000-8000-000000000003', 'web', decode(repeat('8c', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '8a300000-0000-4000-8000-000000000001',
  'device-notification-preferences', 'Device notification preferences',
  '8a000000-0000-4000-8000-000000000002'
);
insert into public.organization_memberships (organization_id, user_id, role) values
  ('8a300000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', 'member'),
  ('8a300000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000002', 'owner');

insert into public.organization_user_preferences (
  organization_id, user_id, notification_preview,
  sound_enabled, vibration_enabled
) values (
  '8a300000-0000-4000-8000-000000000001',
  '8a000000-0000-4000-8000-000000000001',
  'generic', true, true
);

insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform,
  push_token_ciphertext, push_token_type, push_project_id, push_environment
) values
  ('8a400000-0000-4000-8000-000000000001', '8a300000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', '8a100000-0000-4000-8000-000000000001', '8a200000-0000-4000-8000-000000000001', 'ios', 'vault:notification-token-ios-0001', 'expo', '8a500000-0000-4000-8000-000000000001', 'development'),
  ('8a400000-0000-4000-8000-000000000002', '8a300000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', '8a100000-0000-4000-8000-000000000002', '8a200000-0000-4000-8000-000000000002', 'android', 'vault:notification-token-android-0002', 'expo', '8a500000-0000-4000-8000-000000000002', 'development');

insert into public.conversations (
  id, organization_id, kind, name, posting_mode, join_policy,
  created_by_user_id
) values (
  '8a600000-0000-4000-8000-000000000001',
  '8a300000-0000-4000-8000-000000000001',
  'announcement', 'Notification test updates',
  'admins_only', 'invite_only',
  '8a000000-0000-4000-8000-000000000002'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('8a300000-0000-4000-8000-000000000001', '8a600000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000001', 'member', '8a000000-0000-4000-8000-000000000002'),
  ('8a300000-0000-4000-8000-000000000001', '8a600000-0000-4000-8000-000000000001', '8a000000-0000-4000-8000-000000000002', 'owner', '8a000000-0000-4000-8000-000000000002');

select has_column(
  'public', 'device_registrations', 'notification_preview_override',
  'device registrations persist an explicit preview override'
);
select has_column(
  'public', 'device_registrations', 'notification_preferences_version',
  'device notification preferences carry a CAS version'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_update_device_notification_preferences(uuid,uuid,uuid,uuid,integer,jsonb,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_update_device_notification_preferences(uuid,uuid,uuid,uuid,integer,jsonb,text,text)',
    'execute'
  ),
  'device preference mutation is service-only behind the BFF'
);

select is(
  public.bff_get_device_notification_preferences(
    '8a000000-0000-4000-8000-000000000001',
    '8a300000-0000-4000-8000-000000000001',
    '8a100000-0000-4000-8000-000000000001',
    '8a200000-0000-4000-8000-000000000001'
  ) #>> '{effective,notification_preview}',
  'generic',
  'a device initially inherits the account preview policy'
);

create temporary table first_device_update on commit drop as
select public.bff_update_device_notification_preferences(
  '8a000000-0000-4000-8000-000000000001',
  '8a300000-0000-4000-8000-000000000001',
  '8a100000-0000-4000-8000-000000000001',
  '8a200000-0000-4000-8000-000000000001',
  1,
  '{"notification_preview":"hidden","sound_enabled":false}'::jsonb,
  'device-preference-update-0001', repeat('1', 64)
) as receipt;

select is(
  (select (receipt ->> 'preference_version')::integer from first_device_update),
  2,
  'the first current-device update advances the version exactly once'
);
select is(
  (select receipt #>> '{effective,notification_preview}' from first_device_update),
  'hidden',
  'the current device resolves its explicit preview override'
);
select is(
  (select (receipt #>> '{effective,sound_enabled}')::boolean from first_device_update),
  false,
  'the current device resolves its explicit sound override'
);
select is(
  (select (receipt #>> '{effective,vibration_enabled}')::boolean from first_device_update),
  true,
  'an untouched field continues to inherit the account value'
);
select is(
  (public.bff_update_device_notification_preferences(
    '8a000000-0000-4000-8000-000000000001',
    '8a300000-0000-4000-8000-000000000001',
    '8a100000-0000-4000-8000-000000000001',
    '8a200000-0000-4000-8000-000000000001',
    1,
    '{"notification_preview":"hidden","sound_enabled":false}'::jsonb,
    'device-preference-update-0001', repeat('1', 64)
  ) ->> 'preference_version')::integer,
  2,
  'an exact idempotent replay returns the committed receipt without a second mutation'
);
select throws_ok(
  $$select public.bff_update_device_notification_preferences(
    '8a000000-0000-4000-8000-000000000001',
    '8a300000-0000-4000-8000-000000000001',
    '8a100000-0000-4000-8000-000000000001',
    '8a200000-0000-4000-8000-000000000001',
    1, '{"sound_enabled":true}'::jsonb,
    'device-preference-stale-0002', repeat('2', 64)
  )$$,
  '40001', 'device notification preference version conflict',
  'a stale version cannot overwrite current device settings'
);
select throws_ok(
  $$select public.bff_update_device_notification_preferences(
    '8a000000-0000-4000-8000-000000000001',
    '8a300000-0000-4000-8000-000000000001',
    '8a100000-0000-4000-8000-000000000002',
    '8a200000-0000-4000-8000-000000000001',
    2, '{"sound_enabled":true}'::jsonb,
    'device-preference-wrong-session', repeat('3', 64)
  )$$,
  '42501', 'current registered installation required',
  'another session for the same account cannot mutate this installation'
);
select throws_ok(
  $$select public.bff_update_device_notification_preferences(
    '8a000000-0000-4000-8000-000000000002',
    '8a300000-0000-4000-8000-000000000001',
    '8a100000-0000-4000-8000-000000000003',
    '8a200000-0000-4000-8000-000000000001',
    2, '{"sound_enabled":true}'::jsonb,
    'device-preference-other-user', repeat('4', 64)
  )$$,
  '42501', 'current registered installation required',
  'another organization member cannot mutate a guessed installation identifier'
);
select throws_ok(
  $$select public.bff_update_device_notification_preferences(
    '8a000000-0000-4000-8000-000000000001',
    '8a300000-0000-4000-8000-000000000001',
    '8a100000-0000-4000-8000-000000000001',
    '8a200000-0000-4000-8000-000000000001',
    2, '{"unknown":true}'::jsonb,
    'device-preference-unknown-key', repeat('5', 64)
  )$$,
  '22023', 'invalid device notification preference patch',
  'unknown device preference fields fail closed'
);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"8a000000-0000-4000-8000-000000000001","session_id":"8a100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
select throws_ok(
  $$update public.device_registrations
    set sound_enabled_override = true,
        notification_preferences_version = notification_preferences_version + 1,
        notification_preferences_updated_at = clock_timestamp()
    where id = '8a400000-0000-4000-8000-000000000001'$$,
  '42501', 'device notification preferences require the current installation workflow',
  'direct table updates cannot bypass the versioned BFF workflow'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  exists (
    select 1 from public.audit_events event
    where event.organization_id = '8a300000-0000-4000-8000-000000000001'
      and event.event_type = 'device.notification_preferences.updated'
      and event.target_id = '8a400000-0000-4000-8000-000000000001'
      and event.metadata ? 'changed_keys'
      and event.metadata ? 'preference_version'
      and not (event.metadata ? 'values')
  ),
  'device preference changes produce content-free audit correlation'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"8a000000-0000-4000-8000-000000000002"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, language_code
) values (
  '8a300000-0000-4000-8000-000000000001',
  '8a600000-0000-4000-8000-000000000001',
  '8a000000-0000-4000-8000-000000000002',
  '8a700000-0000-4000-8000-000000000001',
  'text', 'Per-device notification preferences', 'en'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '8a300000-0000-4000-8000-000000000001', 'push',
  'device-notification-preferences-push',
  jsonb_build_object(
    'organization_id', '8a300000-0000-4000-8000-000000000001',
    'conversation_id', '8a600000-0000-4000-8000-000000000001',
    'message_id', (
      select id from public.messages
      where client_nonce = '8a700000-0000-4000-8000-000000000001'
    )
  )
);
do $block$
begin
  perform public.bff_claim_outbox_topics(
    '8a800000-0000-4000-8000-000000000001', array['push']::text[], 100, 60
  );
end
$block$;
create temporary table device_push_resolution on commit drop as
select public.bff_resolve_push_job(
  '8a800000-0000-4000-8000-000000000001',
  (select id from private.outbox_jobs
   where dedupe_key = 'device-notification-preferences-push'),
  null, 100
) as receipt;

select is(
  jsonb_array_length((select receipt -> 'deliveries' from device_push_resolution)),
  2,
  'push fanout preserves one independently resolved delivery per active device'
);
select ok(
  (select delivery #>> '{preferences,notification_preview}' = 'hidden'
      and (delivery #>> '{preferences,sound_enabled}')::boolean = false
      and (delivery #>> '{preferences,vibration_enabled}')::boolean = true
   from device_push_resolution,
     lateral jsonb_array_elements(receipt -> 'deliveries') delivery
   where delivery ->> 'installation_id' = '8a200000-0000-4000-8000-000000000001'),
  'the iOS push delivery uses its preview/sound overrides and inherited vibration'
);
select ok(
  (select delivery #>> '{preferences,notification_preview}' = 'generic'
      and (delivery #>> '{preferences,sound_enabled}')::boolean = true
      and (delivery #>> '{preferences,vibration_enabled}')::boolean = true
   from device_push_resolution,
     lateral jsonb_array_elements(receipt -> 'deliveries') delivery
   where delivery ->> 'installation_id' = '8a200000-0000-4000-8000-000000000002'),
  'the Android push delivery independently inherits the account defaults'
);

-- Give the publisher an otherwise valid active device before resolving a
-- deliberately targeted update. This catches a privacy regression where the
-- generic conversation-member fanout branch widened an announcement's
-- immutable audience snapshot to everybody in the channel.
insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform,
  push_token_ciphertext, push_token_type, push_project_id, push_environment
) values (
  '8a400000-0000-4000-8000-000000000003',
  '8a300000-0000-4000-8000-000000000001',
  '8a000000-0000-4000-8000-000000000002',
  '8a100000-0000-4000-8000-000000000003',
  '8a200000-0000-4000-8000-000000000003',
  'web', 'vault:notification-token-web-0003', 'expo',
  '8a500000-0000-4000-8000-000000000003', 'development'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"8a000000-0000-4000-8000-000000000002"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, language_code
) values (
  '8a300000-0000-4000-8000-000000000001',
  '8a600000-0000-4000-8000-000000000001',
  '8a000000-0000-4000-8000-000000000002',
  '8a700000-0000-4000-8000-000000000002',
  'text', 'Only members receive this targeted update', 'en'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.announcements (
  id, organization_id, conversation_id, message_id, title,
  created_by_user_id, audience_spec
) values (
  '8a900000-0000-4000-8000-000000000001',
  '8a300000-0000-4000-8000-000000000001',
  '8a600000-0000-4000-8000-000000000001',
  (select id from public.messages
   where client_nonce = '8a700000-0000-4000-8000-000000000002'),
  'Targeted member update',
  '8a000000-0000-4000-8000-000000000002',
  '{"company":true,"membership_roles":["member"]}'::jsonb
);

select is(
  (select count(*)::integer
   from public.announcement_recipients recipient
   where recipient.organization_id = '8a300000-0000-4000-8000-000000000001'
     and recipient.announcement_id = '8a900000-0000-4000-8000-000000000001'),
  1,
  'the immutable targeted-update snapshot contains only the selected member role'
);

insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
select
  '8a300000-0000-4000-8000-000000000001', 'push',
  'device-notification-preferences-targeted-push',
  jsonb_build_object(
    'organization_id', announcement.organization_id,
    'conversation_id', announcement.conversation_id,
    'message_id', announcement.message_id,
    'announcement_id', announcement.id,
    'announcement_version_id', version.id,
    'state', 'published',
    'notification_class', version.notification_class
  )
from public.announcements announcement
join public.announcement_versions version
  on version.organization_id = announcement.organization_id
 and version.announcement_id = announcement.id
 and version.version_number = 1
where announcement.id = '8a900000-0000-4000-8000-000000000001';

do $block$
begin
  perform public.bff_claim_outbox_topics(
    '8a800000-0000-4000-8000-000000000001', array['push']::text[], 100, 60
  );
end
$block$;
create temporary table targeted_push_resolution on commit drop as
select public.bff_resolve_push_job(
  '8a800000-0000-4000-8000-000000000001',
  (select id from private.outbox_jobs
   where dedupe_key = 'device-notification-preferences-targeted-push'),
  null, 100
) as receipt;

select is(
  jsonb_array_length((select receipt -> 'deliveries' from targeted_push_resolution)),
  2,
  'targeted announcement fanout reaches both devices of the one snapshotted recipient'
);
select ok(
  not exists (
    select 1
    from targeted_push_resolution,
      lateral jsonb_array_elements(receipt -> 'deliveries') delivery
    where delivery ->> 'installation_id' =
      '8a200000-0000-4000-8000-000000000003'
  ),
  'an active publisher device outside the audience snapshot receives no targeted update'
);

create temporary table restored_device_update on commit drop as
select public.bff_update_device_notification_preferences(
  '8a000000-0000-4000-8000-000000000001',
  '8a300000-0000-4000-8000-000000000001',
  '8a100000-0000-4000-8000-000000000001',
  '8a200000-0000-4000-8000-000000000001',
  2,
  '{"notification_preview":null,"sound_enabled":null}'::jsonb,
  'device-preference-restore-inherit', repeat('6', 64)
) as receipt;
select ok(
  (select receipt #>> '{overrides,notification_preview}' is null
      and receipt #>> '{overrides,sound_enabled}' is null
      and receipt #>> '{effective,notification_preview}' = 'generic'
      and (receipt #>> '{effective,sound_enabled}')::boolean = true
   from restored_device_update),
  'explicit null restores account inheritance without erasing another device state'
);

update public.device_registrations
set revoked_at = now()
where id = '8a400000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.bff_get_device_notification_preferences(
    '8a000000-0000-4000-8000-000000000001',
    '8a300000-0000-4000-8000-000000000001',
    '8a100000-0000-4000-8000-000000000001',
    '8a200000-0000-4000-8000-000000000001'
  )$$,
  '42501', 'current registered installation required',
  'a revoked installation cannot read or mutate current-device preferences'
);

select * from finish();
rollback;
