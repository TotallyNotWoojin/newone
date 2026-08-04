begin;
select plan(29);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('91000000-0000-4000-8000-000000000001', 'audience-owner@example.test', now()),
  ('91000000-0000-4000-8000-000000000002', 'audience-operator@example.test', now()),
  ('91000000-0000-4000-8000-000000000003', 'audience-supervisor@example.test', now()),
  ('91000000-0000-4000-8000-000000000004', 'audience-outsider@example.test', now()),
  ('91000000-0000-4000-8000-000000000005', 'audience-leaver@example.test', now());

update public.profiles set display_name = 'Audience Owner', preferred_language = 'en'
where user_id = '91000000-0000-4000-8000-000000000001';
update public.profiles set display_name = 'Line Operator', preferred_language = 'ko'
where user_id = '91000000-0000-4000-8000-000000000002';
update public.profiles set display_name = 'Shift Supervisor', preferred_language = 'es'
where user_id = '91000000-0000-4000-8000-000000000003';
update public.profiles set display_name = 'Outside Site', preferred_language = 'en'
where user_id = '91000000-0000-4000-8000-000000000004';
update public.profiles set display_name = 'Seasonal Electrician', preferred_language = 'en'
where user_id = '91000000-0000-4000-8000-000000000005';

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('91100000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('91100000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000003', now(), now(), 'aal2');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('91100000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', '91200000-0000-4000-8000-000000000001', 'web', decode(repeat('91', 32), 'hex'), 'desktop'),
  ('91100000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000003', '91200000-0000-4000-8000-000000000003', 'ios', decode(repeat('93', 32), 'hex'), 'iphone');

insert into public.organizations (
  id, slug, name, shift_schedule_authoritative, created_by_user_id
) values (
  '92000000-0000-4000-8000-000000000001',
  'targeted-update-audiences', 'Targeted Update Audiences', false,
  '91000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (
  organization_id, user_id, role, job_title
) values
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'owner', 'Plant Director'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 'member', 'Line Operator'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', 'member', 'Shift Lead'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000004', 'member', 'Accountant'),
  ('92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000005', 'member', 'Electrician');

insert into public.organization_units (
  id, organization_id, parent_unit_id, kind, name, created_by_user_id
) values
  ('92100000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', null, 'site', 'Plant North', '91000000-0000-4000-8000-000000000001'),
  ('92100000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '92100000-0000-4000-8000-000000000001', 'department', 'Production', '91000000-0000-4000-8000-000000000001'),
  ('92100000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000001', '92100000-0000-4000-8000-000000000002', 'team', 'Line 7', '91000000-0000-4000-8000-000000000001'),
  ('92100000-0000-4000-8000-000000000004', '92000000-0000-4000-8000-000000000001', null, 'site', 'Head Office', '91000000-0000-4000-8000-000000000001');
insert into public.organization_unit_members (organization_id, unit_id, user_id) values
  ('92000000-0000-4000-8000-000000000001', '92100000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000002'),
  ('92000000-0000-4000-8000-000000000001', '92100000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003'),
  ('92000000-0000-4000-8000-000000000001', '92100000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000004'),
  ('92000000-0000-4000-8000-000000000001', '92100000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000005');

insert into public.organization_role_assignments (
  organization_id, user_id, role_name, scope_type, unit_id,
  granted_by_user_id, grant_reason
) values
(
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000003',
  'supervisor', 'organization', null,
  '91000000-0000-4000-8000-000000000001',
  'Operational audience contract'
),
(
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000003',
  'communications_publisher', 'unit',
  '92100000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  'Scoped update publisher'
);

insert into public.conversations (
  id, organization_id, kind, name, history_policy, posting_mode, join_policy,
  created_by_user_id
) values (
  '93000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  'announcement', 'Official updates', 'all', 'admins_only', 'invite_only',
  '91000000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000001', 'owner', '91000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', 'member', '91000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', 'member', '91000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000004', 'member', '91000000-0000-4000-8000-000000000001'),
  ('92000000-0000-4000-8000-000000000001', '93000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000005', 'member', '91000000-0000-4000-8000-000000000001');

insert into public.shift_assignments (
  id, organization_id, user_id, unit_id, starts_at, ends_at, created_by_user_id
) values
  ('92200000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000002', '92100000-0000-4000-8000-000000000003', now() - interval '1 hour', now() + interval '4 hours', '91000000-0000-4000-8000-000000000001'),
  ('92200000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000003', '92100000-0000-4000-8000-000000000002', now() - interval '8 hours', now() - interval '1 hour', '91000000-0000-4000-8000-000000000001'),
  ('92200000-0000-4000-8000-000000000005', '92000000-0000-4000-8000-000000000001', '91000000-0000-4000-8000-000000000005', '92100000-0000-4000-8000-000000000003', now() - interval '2 hours', now() + interval '4 hours', '91000000-0000-4000-8000-000000000001');

select is(
  private.normalize_announcement_audience_spec(
    '{"company":true,"roles":[" Line Operator "],"membership_roles":["member"]}'::jsonb
  ) -> 'roles' ->> 0,
  'line operator',
  'operational roles are normalized independently'
);
select is(
  private.normalize_announcement_audience_spec(
    '{"company":true,"roles":["line operator"],"membership_roles":["member"]}'::jsonb
  ) -> 'membership_roles' ->> 0,
  'member',
  'account access roles remain a separate selector'
);
select throws_ok(
  $$select private.normalize_announcement_audience_spec('{"company":true,"sql":"true"}'::jsonb)$$,
  '22023', 'invalid announcement audience selector',
  'unknown selector keys fail closed'
);
select throws_ok(
  $$select private.normalize_announcement_audience_spec('{}'::jsonb)$$,
  '22023', 'invalid announcement audience selector',
  'an audience requires an explicit base scope'
);
select ok(private.announcement_audience_spec_is_live(
  '92000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"]}'::jsonb
), 'an active site selector is live');
select ok(not private.announcement_audience_spec_is_live(
  '92000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000003"]}'::jsonb
), 'a team id cannot masquerade as a site selector');
select ok(not private.announcement_audience_spec_is_live(
  '92000000-0000-4000-8000-000000000001',
  '{"company":true,"current_shift_only":true}'::jsonb
), 'current-shift targeting fails closed without an authoritative schedule');

select public.bff_update_organization_policy(
  '91000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '91100000-0000-4000-8000-000000000001',
  (select message_retention_days from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  (select allow_member_direct_messages from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  (select dm_policy from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  (select require_mfa_for_admins from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  true,
  (select group_creation_policy from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  (select allow_external_guests from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  (select external_guest_max_access_days from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  (select organization_policy_version from public.organizations
    where id = '92000000-0000-4000-8000-000000000001'),
  'Enable authoritative shifts for the targeted audience fixture',
  'targeted-audience-shift-policy', repeat('4', 64)
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is((select count(*)::integer from private.announcement_audience_candidates(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"]}'::jsonb, now()
)), 3, 'site targeting includes people assigned only to descendant units');
select is((select user_id::text from private.announcement_audience_candidates(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"],"roles":["line operator"]}'::jsonb, now()
)), '91000000-0000-4000-8000-000000000002',
  'exact job-title targeting resolves the intended person');
select is((select user_id::text from private.announcement_audience_candidates(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"],"roles":["supervisor"]}'::jsonb, now()
)), '91000000-0000-4000-8000-000000000003',
  'configured operational-role targeting is supported without calling it an access tier');
select is((select user_id::text from private.announcement_audience_candidates(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"],"languages":["ko"]}'::jsonb, now()
)), '91000000-0000-4000-8000-000000000002',
  'preferred-language targeting is exact');
select is((select count(*)::integer from private.announcement_audience_candidates(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"],"membership_roles":["member"]}'::jsonb, now()
)), 3, 'access-tier filtering remains independently available');
select is((select count(*)::integer from private.announcement_audience_candidates(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"],"current_shift_only":true}'::jsonb, now()
)), 2,
  'current-shift targeting uses authoritative active windows');
select throws_ok(
  $$select * from private.announcement_audience_candidates(
    '92000000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000001',
    '{"company":true}'::jsonb, 'infinity'::timestamptz
  )$$,
  '22023', 'finite audience evaluation time required',
  'infinite evaluation timestamps fail closed'
);

select is((preview ->> 'total_count')::integer, 3,
  'authorized preview returns the recursive target count')
from (select public.bff_preview_announcement_audience(
  '91000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '91100000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"]}'::jsonb, 25
) preview) result;
select ok((preview ->> 'excluded_count')::integer = 2
    and preview -> 'exclusion_counts' = '{"inactive_members":0,"selector_mismatch":2}'::jsonb
    and preview -> 'notification_languages' = '["en","es","ko"]'::jsonb,
  'preview returns exclusions and notification languages without unrelated activity')
from (select public.bff_preview_announcement_audience(
  '91000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '91100000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"]}'::jsonb, 25
) preview) result;

select is((preview ->> 'total_count')::integer, 3,
  'a unit-scoped communications publisher can preview that unit and descendants')
from (select public.bff_preview_announcement_audience(
  '91000000-0000-4000-8000-000000000003',
  '92000000-0000-4000-8000-000000000001',
  '91100000-0000-4000-8000-000000000003',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"]}'::jsonb, 25
) preview) result;
select throws_ok(
  $$select public.bff_preview_announcement_audience(
    '91000000-0000-4000-8000-000000000003',
    '92000000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000003',
    '93000000-0000-4000-8000-000000000001',
    '{"site_ids":["92100000-0000-4000-8000-000000000004"]}'::jsonb, 25
  )$$,
  '42501', 'announcement audience is not permitted',
  'a unit-scoped publisher cannot preview an unrelated unit'
);

select lives_ok(
  $$select public.bff_create_announcement(
    '91000000-0000-4000-8000-000000000001',
    '92000000-0000-4000-8000-000000000001',
    '91100000-0000-4000-8000-000000000001',
    '93000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    'Line operator update', 'Inspect the line guard.', 'en', 'normal', false,
    now() + interval '1 day', null,
    '{"schema_version":1,"attestation_required":false,"attestation_prompt":null,"required_keys":[],"carry_forward_on_correction":false}'::jsonb,
    'routine', null, null,
    '{"enabled":false,"deadline_at":null,"interval_seconds":null,"maximum_reminders":0,"escalate_after_seconds":null,"sms_fallback":false}'::jsonb,
    '{"site_ids":["92100000-0000-4000-8000-000000000001"],"roles":["line operator"]}'::jsonb,
    'targeted-update-now', repeat('a', 64)
  )$$,
  'a publisher can publish to a validated dimensional audience'
);
select ok((select count(*) = 1 and bool_and(user_id = '91000000-0000-4000-8000-000000000002')
  from public.announcement_recipients recipient
  join public.announcements announcement on announcement.id = recipient.announcement_id
  join public.messages message on message.id = announcement.message_id
  where message.client_nonce = '94000000-0000-4000-8000-000000000001'),
  'immediate publication snapshots only the selected user, not all channel members');
select ok((select count(*) = 1 and bool_and(
    audience_snapshot ->> 'membership_role' = 'member'
    and audience_snapshot ->> 'preferred_language' = 'ko'
    and jsonb_array_length(audience_snapshot -> 'unit_ids') = 1
    and jsonb_array_length(audience_snapshot -> 'current_shift_assignment_ids') = 1
    and char_length(audience_snapshot ->> 'audience_spec_sha256') = 64
  )
  from public.announcement_recipients recipient
  join public.announcements announcement on announcement.id = recipient.announcement_id
  join public.messages message on message.id = announcement.message_id
  where message.client_nonce = '94000000-0000-4000-8000-000000000001'),
  'recipient rows retain an immutable publish-time user and selector snapshot');
select throws_ok(
  $$update public.announcement_recipients set audience_snapshot = '{}'::jsonb
    where announcement_id = (
      select announcement.id from public.announcements announcement
      join public.messages message on message.id = announcement.message_id
      where message.client_nonce = '94000000-0000-4000-8000-000000000001'
    )$$,
  '22000', 'announcement recipient identity and audience snapshot are immutable',
  'recipient audience evidence cannot be rewritten'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"91000000-0000-4000-8000-000000000001","session_id":"91100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, language_code, available_at
) values (
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '94000000-0000-4000-8000-000000000002',
  'text', 'Scheduled shift update', 'en', now()
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.announcements (
  id, organization_id, conversation_id, message_id, title, priority,
  status, notification_class, scheduled_at, published_at, expires_at,
  created_by_user_id, audience_spec
) values (
  '95000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '94000000-0000-4000-8000-000000000002'),
  'Scheduled shift update', 'normal', 'scheduled', 'routine',
  now() - interval '5 minutes', null, now() + interval '1 day',
  '91000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"],"current_shift_only":true}'::jsonb
);
select is((select count(*)::integer from public.announcement_recipients
  where announcement_id = '95000000-0000-4000-8000-000000000001'), 0,
  'scheduled updates do not snapshot the preview audience early');
select is((select count(*)::integer from private.announcement_audience_candidates(
  '92000000-0000-4000-8000-000000000001',
  '93000000-0000-4000-8000-000000000001',
  '{"site_ids":["92100000-0000-4000-8000-000000000001"],"current_shift_only":true}'::jsonb,
  now()
)), 2, 'the scheduled selector initially resolves the operator and seasonal worker');

update public.shift_assignments set status = 'cancelled'
where id = '92200000-0000-4000-8000-000000000001';
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"91000000-0000-4000-8000-000000000001","session_id":"91100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
update public.organization_memberships
set status = 'suspended', status_change_reason = 'Seasonal assignment ended'
where organization_id = '92000000-0000-4000-8000-000000000001'
  and user_id = '91000000-0000-4000-8000-000000000005';
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.shift_assignments (
  id, organization_id, user_id, unit_id, starts_at, ends_at, created_by_user_id
) values (
  '92200000-0000-4000-8000-000000000003',
  '92000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000003',
  '92100000-0000-4000-8000-000000000002',
  now() - interval '1 minute', now() + interval '4 hours',
  '91000000-0000-4000-8000-000000000001'
);
select is((public.bff_promote_due_announcements(
  '96000000-0000-4000-8000-000000000001', 10
) ->> 'promoted')::integer, 1,
  'the scheduler promotes the due update after reevaluating its selector');
select ok((select count(*) = 1 and bool_and(user_id = '91000000-0000-4000-8000-000000000003')
  from public.announcement_recipients
  where announcement_id = '95000000-0000-4000-8000-000000000001'),
  'scheduled publication excludes the shift mover and membership leaver without legacy broadening');
select ok((select announcement.status = 'published'
    and announcement.audience_snapshotted_at = announcement.published_at
    and version.published_at is null
    and (recipient.audience_snapshot ->> 'evaluated_at')::timestamptz = announcement.published_at
  from public.announcements announcement
  join public.announcement_versions version
    on version.organization_id = announcement.organization_id
   and version.announcement_id = announcement.id
  join public.announcement_recipients recipient
    on recipient.organization_id = announcement.organization_id
   and recipient.announcement_id = announcement.id
  where announcement.id = '95000000-0000-4000-8000-000000000001'),
  'scheduled publication keeps the authored version immutable and binds recipient evidence to publish time');
select throws_ok(
  $$update public.announcements set audience_spec = '{"company":true}'::jsonb
    where id = '95000000-0000-4000-8000-000000000001'$$,
  '22000', 'announcement audience selector is immutable',
  'published audience selectors cannot be rewritten'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_preview_announcement_audience(uuid,uuid,uuid,uuid,jsonb,integer)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_preview_announcement_audience(uuid,uuid,uuid,uuid,jsonb,integer)',
    'execute'
  ),
  'dimensional preview remains service-only'
);

select * from finish();
rollback;
