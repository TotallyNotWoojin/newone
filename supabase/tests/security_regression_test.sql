begin;
select plan(77);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('41000000-0000-4000-8000-000000000001', 'security-owner@example.test'),
  ('41000000-0000-4000-8000-000000000002', 'security-admin@example.test'),
  ('41000000-0000-4000-8000-000000000003', 'security-member@example.test'),
  ('41000000-0000-4000-8000-000000000004', 'security-accomplice@example.test');

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('41100000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('41100000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('41100000-0000-4000-8000-000000000003', '41000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('41100000-0000-4000-8000-000000000004', '41000000-0000-4000-8000-000000000004', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('41100000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', '48100000-0000-4000-8000-000000000001', 'web', decode(repeat('11', 32), 'hex'), 'desktop'),
  ('41100000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000002', '48200000-0000-4000-8000-000000000002', 'web', decode(repeat('22', 32), 'hex'), 'desktop'),
  ('41100000-0000-4000-8000-000000000003', '41000000-0000-4000-8000-000000000003', '48000000-0000-4000-8000-000000000001', 'ios', decode(repeat('33', 32), 'hex'), 'iphone'),
  ('41100000-0000-4000-8000-000000000004', '41000000-0000-4000-8000-000000000004', '48400000-0000-4000-8000-000000000004', 'web', decode(repeat('44', 32), 'hex'), 'desktop');

insert into public.organizations (
  id, slug, name, require_mfa_for_admins, created_by_user_id
) values (
  '42000000-0000-4000-8000-000000000001',
  'security-regression',
  'Security Regression',
  true,
  '41000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (
  organization_id, user_id, role
) values
  ('42000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 'owner'),
  ('42000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000002', 'admin'),
  ('42000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000003', 'member'),
  ('42000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000004', 'member');

insert into public.conversations (
  id, organization_id, kind, name, posting_mode, join_policy,
  created_by_user_id
) values
  ('43000000-0000-4000-8000-000000000001', '42000000-0000-4000-8000-000000000001', 'group', 'Security room', 'all_members', 'inherit', '41000000-0000-4000-8000-000000000001'),
  ('43000000-0000-4000-8000-000000000002', '42000000-0000-4000-8000-000000000001', 'announcement', 'Security notices', 'admins_only', 'invite_only', '41000000-0000-4000-8000-000000000001');

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000001', 'owner', '41000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000002', 'admin', '41000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000003', 'member', '41000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000001', 'owner', '41000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000002', '41000000-0000-4000-8000-000000000003', 'member', '41000000-0000-4000-8000-000000000001');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"41000000-0000-4000-8000-000000000003","session_id":"41100000-0000-4000-8000-000000000003","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values
  ('42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000003', '44000000-0000-4000-8000-000000000001', 'text', 'Original Korean source', 'ko'),
  ('42000000-0000-4000-8000-000000000001', '43000000-0000-4000-8000-000000000001', '41000000-0000-4000-8000-000000000003', '44000000-0000-4000-8000-000000000002', 'attachment', null, null);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"41000000-0000-4000-8000-000000000001","session_id":"41100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body,
  language_code
) values (
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000002',
  '41000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000003',
  'text', 'Acknowledge this notice', 'en'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language, target_language,
  status, translated_body, provider, model
) values (
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000001'),
  'ko', 'es', 'completed', 'Texto anterior', 'test-provider', 'test-model'
);

insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  storage_path, file_name, mime_type, detected_mime_type, byte_size, scan_status,
  scan_completed_at, scanner_name, scanner_version
) values (
  '45000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000002'),
  '41000000-0000-4000-8000-000000000003',
  '42000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001/41000000-0000-4000-8000-000000000003/45000000-0000-4000-8000-000000000001/report.pdf',
  'report.pdf', 'application/pdf', 'application/pdf', 128, 'clean',
  now(), 'fixture-scanner', '1.0'
);

insert into public.announcements (
  id, organization_id, conversation_id, message_id, title, requires_acknowledgement,
  created_by_user_id
) values (
  '46000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000002',
  (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000003'),
  'Security notice', true, '41000000-0000-4000-8000-000000000001'
);

insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform, push_token_ciphertext,
  push_token_type, push_project_id, push_environment
) values (
  '47000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000003',
  '41100000-0000-4000-8000-000000000003',
  '48000000-0000-4000-8000-000000000001',
  'ios', 'vault:security-regression-push-token', 'expo',
  '49000000-0000-4000-8000-000000000099', 'development'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"41100000-0000-4000-8000-000000000001"}',
  true
);
insert into public.contact_connections (
  organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
) values (
  '42000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000003',
  '41000000-0000-4000-8000-000000000001'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1-2: only the checked RPC surface is writable by authenticated clients.
select ok(
  not has_function_privilege('anon', 'public.bff_create_direct_conversation(uuid,uuid,uuid,uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.bff_create_direct_conversation(uuid,uuid,uuid,uuid,text,text)', 'execute')
  and has_function_privilege('service_role', 'public.bff_create_direct_conversation(uuid,uuid,uuid,uuid,text,text)', 'execute'),
  'BFF mutation RPCs are service-role-only'
);
select ok(
  not has_table_privilege('authenticated', 'public.conversations', 'insert')
  and not has_table_privilege('authenticated', 'public.direct_conversation_pairs', 'insert')
  and not has_table_privilege('authenticated', 'public.conversation_members', 'insert')
  and not has_table_privilege('authenticated', 'public.messages', 'insert'),
  'authenticated clients cannot bypass checked creation RPCs with raw inserts'
);

-- From this point onward the suite intentionally probes RLS as authenticated.
-- These transaction-local grants are rolled back and do not alter the
-- production RPC-only privilege boundary asserted above.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function private.normalize_search_text(text) to authenticated, service_role;
grant execute on function private.current_session_active_for_org(uuid)
  to authenticated;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 3: an existing conversation admin cannot create an owner membership.
select throws_ok(
  $$select public.bff_add_conversation_member(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000004',
    'owner',
    'security-owner-escalation',
    repeat('1', 64)
  )$$,
  '42501',
  'only conversation owners may add another owner',
  'conversation admins cannot bypass owner-only promotion'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000001"}',
  true
);

-- 4-5: MFA-required admin paths fail closed at AAL1.
select is(
  (select private.is_org_admin('42000000-0000-4000-8000-000000000001')),
  false,
  'AAL1 does not satisfy an MFA-required admin check'
);
update public.organizations set name = 'AAL1 should not update'
where id = '42000000-0000-4000-8000-000000000001';
select is(
  (select name from public.organizations where id = '42000000-0000-4000-8000-000000000001'),
  'Security Regression',
  'AAL1 cannot update an MFA-protected organization'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"41100000-0000-4000-8000-000000000001"}',
  true
);

-- 6-8: an AAL2 owner can administer and is the only actor who can change MFA policy.
select is(
  (select private.is_org_admin('42000000-0000-4000-8000-000000000001')),
  true,
  'AAL2 satisfies an MFA-required owner check'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_update_organization_policy(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    (select message_retention_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select allow_member_direct_messages from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select dm_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    false,
    (select shift_schedule_authoritative from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select group_creation_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select allow_external_guests from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select external_guest_max_access_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select organization_policy_version from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    'Disable administrator MFA for the regression policy check',
    'security-policy-disable-mfa', repeat('7', 64)
  )$$,
  'AAL2 owner can disable the admin MFA policy through the protected workflow'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_update_organization_policy(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    (select message_retention_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select allow_member_direct_messages from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select dm_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    true,
    (select shift_schedule_authoritative from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select group_creation_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select allow_external_guests from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select external_guest_max_access_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select organization_policy_version from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    'Restore administrator MFA after the regression policy check',
    'security-policy-restore-mfa', repeat('8', 64)
  )$$,
  'AAL2 owner can restore the admin MFA policy through the protected workflow'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_update_organization_policy(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000002',
    (select message_retention_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select allow_member_direct_messages from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select dm_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    false,
    (select shift_schedule_authoritative from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select group_creation_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select allow_external_guests from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select external_guest_max_access_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select organization_policy_version from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    'Administrator must not weaken owner security policy',
    'security-policy-admin-denied', repeat('9', 64)
  )$$,
  '42501',
  'organization owner permission required',
  'AAL2 admins still cannot weaken the owner-controlled MFA policy'
);

reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 10-12: the organization DM switch cannot be bypassed through RPC or raw tables.
select lives_ok(
  $$select public.bff_update_organization_policy(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    (select message_retention_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    false,
    (select dm_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select require_mfa_for_admins from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select shift_schedule_authoritative from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select group_creation_policy from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select allow_external_guests from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select external_guest_max_access_days from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    (select organization_policy_version from public.organizations
      where id = '42000000-0000-4000-8000-000000000001'),
    'Disable member direct messages for the regression policy check',
    'security-policy-disable-dm', repeat('a', 64)
  )$$,
  'AAL2 owner can disable member direct messages through the protected workflow'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_create_direct_conversation(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000003',
    'security-disabled-dm',
    repeat('2', 64)
  )$$,
  '42501',
  'direct messages are disabled for this organization',
  'checked DM creation honors the organization switch'
);
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"41100000-0000-4000-8000-000000000001"}',
  true
);
select throws_ok(
  $$insert into public.conversations (
    organization_id, kind, visibility, member_limit, created_by_user_id
  ) values (
    '42000000-0000-4000-8000-000000000001', 'direct', 'invite_only', 2,
    '41000000-0000-4000-8000-000000000001'
  )$$,
  '42501',
  null,
  'raw direct-conversation insertion is unavailable'
);

-- 13-16: message creation is rate-limited and idempotent inside the database.
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $sql$do $block$
  begin
    for i in 1..10 loop
      perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
      perform public.bff_send_message(
        '41000000-0000-4000-8000-000000000001',
        '42000000-0000-4000-8000-000000000001',
        '41100000-0000-4000-8000-000000000001',
        '43000000-0000-4000-8000-000000000001',
        ('49000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
        'text',
        'rate message ' || i,
        'en', null, null, '{}'::jsonb,
        'security-message-' || lpad(i::text, 2, '0'),
        lpad(to_hex(i), 64, '0')
      );
    end loop;
  end
  $block$$sql$,
  'the first ten messages in a ten-second window are accepted'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_send_message(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000011',
    'text', 'rate message 11', 'en', null, null, '{}'::jsonb,
    'security-message-11', repeat('b', 64)
  )$$,
  'P0001',
  'message rate limit exceeded',
  'the eleventh burst message is rejected'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_send_message(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '49000000-0000-4000-8000-000000000001',
    'text', 'rate message 1', 'en', null, null, '{}'::jsonb,
    'security-message-01', lpad(to_hex(1), 64, '0')
  )$$,
  'an idempotent retry returns before consuming another rate-limit slot'
);
select is(
  (select count(*)::bigint from public.messages where client_nonce::text like '49000000-0000-4000-8000-%'),
  10::bigint,
  'idempotent retries do not duplicate messages'
);

-- 17-18: group creation uses the authoritative five-per-day starter limit.
select lives_ok(
  $sql$do $block$
  begin
    for i in 1..5 loop
      perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
      perform public.bff_create_group_conversation(
        '41000000-0000-4000-8000-000000000001',
        '42000000-0000-4000-8000-000000000001',
        '41100000-0000-4000-8000-000000000001',
        'Rate group ' || i,
        array[]::uuid[],
        'group',
        null,
        'security-group-' || lpad(i::text, 2, '0'),
        lpad(to_hex(100 + i), 64, '0')
      );
    end loop;
  end
  $block$$sql$,
  'the first five groups in a day are accepted'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_create_group_conversation(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    'Rate group 6', array[]::uuid[], 'group', null,
    'security-group-06', repeat('c', 64)
  )$$,
  'P0001',
  'group-conversation rate limit exceeded',
  'the sixth daily group is rejected'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000003"}',
  true
);

-- 19-21: edits invalidate translated copies of the previous plaintext.
select is(
  (select count(*)::bigint from public.message_translations where translated_body = 'Texto anterior'),
  1::bigint,
  'the current source translation is visible before editing'
);
select lives_ok(
  $$update public.messages set body = 'Edited Korean source'
    where client_nonce = '44000000-0000-4000-8000-000000000001'$$,
  'the source author can edit inside the edit window'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::bigint from public.message_translations where translated_body = 'Texto anterior'),
  0::bigint,
  'editing deletes stale translated plaintext'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000003"}',
  true
);

-- 22-24: deleting an attachment message closes metadata and file access.
select lives_ok(
  $$update public.messages set deleted_at = now()
    where client_nonce = '44000000-0000-4000-8000-000000000002'$$,
  'the source author can delete an attachment message'
);
select is(
  (select count(*)::bigint from public.message_attachments where id = '45000000-0000-4000-8000-000000000001'),
  0::bigint,
  'deleted attachment metadata is hidden from conversation members'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select scan_status from public.message_attachments where id = '45000000-0000-4000-8000-000000000001'),
  'quarantined',
  'deletion quarantines the attachment pending trusted object purge'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000003"}',
  true
);

-- 25-29: compliance timestamps are server-assigned, not client claims.
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_acknowledge_announcement(
    '41000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000003',
    (select id from public.announcement_versions
     where announcement_id = '46000000-0000-4000-8000-000000000001'
     order by version_number desc limit 1),
    'security-announcement-ack',
    repeat('d', 64)
  )$$,
  'a valid recipient can acknowledge a notice'
);
select ok(
  (select acknowledged_at > now() - interval '10 seconds'
   from public.announcement_acknowledgements
   where announcement_id = '46000000-0000-4000-8000-000000000001'
     and user_id = '41000000-0000-4000-8000-000000000003'),
  'the database replaces a forged acknowledgement timestamp'
);
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000003"}',
  true
);
select throws_ok(
  $$update public.announcement_recipients
    set delivered_at = '2000-01-01T00:00:00Z'
    where announcement_id = '46000000-0000-4000-8000-000000000001'
      and user_id = '41000000-0000-4000-8000-000000000003'$$,
  '42501',
  'delivery timestamps are assigned by the trusted delivery service',
  'recipients cannot forge delivery time'
);
select lives_ok(
  $$update public.announcement_recipients
    set read_at = '2000-01-01T00:00:00Z'
    where announcement_id = '46000000-0000-4000-8000-000000000001'
      and user_id = '41000000-0000-4000-8000-000000000003'$$,
  'recipients can mark their own notice read'
);
select ok(
  (select read_at > now() - interval '10 seconds' and delivered_at = read_at
   from public.announcement_recipients
   where announcement_id = '46000000-0000-4000-8000-000000000001'
     and user_id = '41000000-0000-4000-8000-000000000003'),
  'the database assigns monotonic read and delivered timestamps'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"41100000-0000-4000-8000-000000000001"}',
  true
);

-- 30-37: offboarding atomically revokes push state and all tenant access predicates.
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_suspend_member(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000003',
    'Security regression offboarding',
    'security-suspend-member',
    repeat('e', 64)
  )$$,
  'an AAL2 owner can offboard a member'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (select revoked_at is not null from public.device_registrations
   where id = '47000000-0000-4000-8000-000000000001'),
  'offboarding revokes the member push registration in the same transaction'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000003"}',
  true
);
select is(
  (select count(*)::bigint from public.messages where organization_id = '42000000-0000-4000-8000-000000000001'),
  0::bigint,
  'offboarded members cannot read organization messages'
);
select is(
  (select count(*)::bigint from public.device_registrations where organization_id = '42000000-0000-4000-8000-000000000001'),
  0::bigint,
  'offboarded members cannot read device registrations'
);
select is(
  (select count(*)::bigint from public.contact_connections where organization_id = '42000000-0000-4000-8000-000000000001'),
  0::bigint,
  'offboarded members cannot read contact relationships'
);
select throws_ok(
  $$insert into public.announcement_acknowledgements (
    organization_id, announcement_id, user_id
  ) values (
    '42000000-0000-4000-8000-000000000001',
    '46000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000003'
  )$$,
  '42501',
  null,
  'offboarded members cannot acknowledge notices'
);
select is(
  (select private.realtime_topic_authorized(
    'org:42000000-0000-4000-8000-000000000001:conversation:43000000-0000-4000-8000-000000000001'
  )),
  false,
  'offboarded members cannot authorize a new Realtime channel'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 38: Realtime invalidations contain identifiers and state only, never OLD/NEW plaintext rows.
select ok(
  pg_get_functiondef('private.broadcast_message_change()'::regprocedure) not like '%broadcast_changes%'
  and pg_get_functiondef('private.broadcast_message_change()'::regprocedure) not like '%''body''%'
  and pg_get_functiondef('private.broadcast_message_change()'::regprocedure) not like '% old,%',
  'message broadcasts do not publish body fields or complete OLD/NEW records'
);

-- 38-42: the BFF boundary allowlists the isolated Auth hook and validates
-- Auth sessions/AAL.
select ok(
  (
    select count(*) = 1
      and count(*) filter (
        where proc.oid =
          'public.hook_newone_custom_access_token(jsonb)'::regprocedure::oid
      ) = 1
    from pg_proc proc
    join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.prosecdef
  )
  and has_function_privilege(
    'supabase_auth_admin',
    'public.hook_newone_custom_access_token(jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  )
  and not has_function_privilege(
    'service_role', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  ),
  'the only public SECURITY DEFINER is the isolated Auth lifecycle hook'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bff_send_message(uuid,uuid,uuid,uuid,uuid,text,text,text,bigint,bigint,jsonb,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.bff_send_message(uuid,uuid,uuid,uuid,uuid,text,text,text,bigint,bigint,jsonb,text,text)',
    'execute'
  ),
  'message command is executable only by the service role'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_authorize_request(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000009999',
    'security.invalid-session', false, 0
  ) ->> 'allowed')::boolean,
  false,
  'BFF authorization rejects an unknown Auth session'
);
select is(
  (public.bff_authorize_request(
    '41000000-0000-4000-8000-000000000004',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000004',
    'security.aal2', true, 900
  ) ->> 'allowed')::boolean,
  false,
  'BFF authorization rejects AAL1 for an AAL2 command'
);
select is(
  (public.bff_authorize_request(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    'security.aal2', true, 900
  ) ->> 'allowed')::boolean,
  true,
  'BFF authorization accepts a recent AAL2 owner session'
);

-- 43-44: status/revocation fields are server-owned even for an AAL2 owner.
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"41100000-0000-4000-8000-000000000001"}',
  true
);
select throws_ok(
  $$update public.organization_memberships
    set status = 'suspended', status_change_reason = 'raw bypass'
    where organization_id = '42000000-0000-4000-8000-000000000001'
      and user_id = '41000000-0000-4000-8000-000000000004'$$,
  '42501',
  'membership security state requires the trusted BFF workflow',
  'raw admin updates cannot suspend a membership'
);
select throws_ok(
  $$update public.organization_memberships
    set revocation_generation = 999
    where organization_id = '42000000-0000-4000-8000-000000000001'
      and user_id = '41000000-0000-4000-8000-000000000004'$$,
  '42501',
  'membership security state requires the trusted BFF workflow',
  'raw admin updates cannot forge revocation state'
);

-- 45-48: PATCH is presence-aware and idempotency binds request digests.
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_update_conversation(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '{"description":"Hardened operations"}'::jsonb,
    'security-conversation-patch', repeat('3', 64)
  )$$,
  'conversation PATCH command accepts an allowlisted partial object'
);
select ok(
  (select name = 'Security room' and description = 'Hardened operations'
   from public.conversations
   where id = '43000000-0000-4000-8000-000000000001'),
  'omitted conversation fields are preserved'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_update_conversation(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '{"organization_id":"00000000-0000-4000-8000-000000000000"}'::jsonb,
    'security-unknown-patch', repeat('4', 64)
  )$$,
  '22023',
  'invalid conversation patch',
  'conversation PATCH rejects unknown privileged fields'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_update_conversation(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    '{"description":"different request"}'::jsonb,
    'security-conversation-patch', repeat('5', 64)
  )$$,
  '55000',
  'idempotency key is unavailable',
  'an idempotency key cannot be replayed with a different request digest'
);

-- 49-57: message commands are transactional, scoped, and scrub derivatives.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_send_message(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000001',
    '44000000-0000-4000-8000-000000000100',
    'text', 'Admin source', 'en', null, null, '{}'::jsonb,
    'security-admin-message', repeat('6', 64)
  )$$,
  'checked message command persists an original message'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_edit_message(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000100'),
    'Edited admin source', 'security-edit-message', repeat('7', 64)
  )$$,
  'checked edit command enforces the edit trigger'
);
select ok(
  (select body = 'Edited admin source' and edited_at > now() - interval '10 seconds'
   from public.messages where client_nonce = '44000000-0000-4000-8000-000000000100'),
  'message edit body and server timestamp are persisted'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $sql$do $block$
  declare v_message_id bigint := (
    select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000100'
  );
  begin
    perform public.bff_set_message_reaction(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '41100000-0000-4000-8000-000000000001',
      '43000000-0000-4000-8000-000000000001', v_message_id, '👍',
      'security-reaction-set', repeat('8', 64)
    );
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform public.bff_remove_message_reaction(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '41100000-0000-4000-8000-000000000001',
      '43000000-0000-4000-8000-000000000001', v_message_id, '👍',
      'security-reaction-remove', repeat('9', 64)
    );
  end
  $block$$sql$,
  'checked reaction commands set and remove only the actor reaction'
);
select is(
  (select count(*)::bigint from public.message_reactions
   where message_id = (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000100')),
  0::bigint,
  'reaction removal leaves no duplicate state'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_report_message_v2(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    '43000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000100'),
    'privacy', 'Scoped report', true, 0, 0, 'moderation-share-v1',
    'security-message-report', repeat('a', 64)
  )$$,
  'message reports require explicit scoped disclosure through a checked command'
);
reset role;
select is(
  (select count(*)::bigint from private.message_reports where category = 'privacy'),
  1::bigint,
  'report stores one scoped reference without copying message plaintext'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_delete_message(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000100'),
    'security-delete-message', repeat('b', 64)
  )$$,
  'checked delete command succeeds for the sender'
);
select ok(
  (select body is null and metadata = '{}'::jsonb and language_code is null
      and deletion_reason = 'user' and deleted_by_user_id = '41000000-0000-4000-8000-000000000002'
   from public.messages where client_nonce = '44000000-0000-4000-8000-000000000100'),
  'delete scrubs message content and records a server-owned actor/reason'
);

-- 58-59: contact commands bind the participant actor across the workflow.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $sql$do $block$
  begin
    perform public.bff_request_contact(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '41100000-0000-4000-8000-000000000001',
      '41000000-0000-4000-8000-000000000004',
      'security-contact-request', repeat('c', 64)
    );
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform public.bff_respond_contact(
      '41000000-0000-4000-8000-000000000004',
      '42000000-0000-4000-8000-000000000001',
      '41100000-0000-4000-8000-000000000004',
      '41000000-0000-4000-8000-000000000001', 'accepted',
      'security-contact-respond', repeat('d', 64)
    );
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform public.bff_remove_contact(
      '41000000-0000-4000-8000-000000000001',
      '42000000-0000-4000-8000-000000000001',
      '41100000-0000-4000-8000-000000000001',
      '41000000-0000-4000-8000-000000000004',
      'security-contact-remove', repeat('e', 64)
    );
  end
  $block$$sql$,
  'request, recipient response, and participant removal succeed transactionally'
);
select is(
  (select count(*)::bigint from public.contact_connections
   where organization_id = '42000000-0000-4000-8000-000000000001'
     and member_low_user_id = '41000000-0000-4000-8000-000000000001'
     and member_high_user_id = '41000000-0000-4000-8000-000000000004'),
  0::bigint,
  'contact removal deletes only the requested participant pair'
);

-- 60-67: invitation eligibility and redemption are single-use and token-safe.
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into auth.users (id, email, email_confirmed_at) values
  ('41000000-0000-4000-8000-000000000005', 'new-hire@example.test', now()),
  ('41000000-0000-4000-8000-000000000006', 'second-hire@example.test', null);
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('41100000-0000-4000-8000-000000000005', '41000000-0000-4000-8000-000000000005', now(), now(), 'aal1'),
  ('41100000-0000-4000-8000-000000000006', '41000000-0000-4000-8000-000000000006', now(), now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('41100000-0000-4000-8000-000000000005', '41000000-0000-4000-8000-000000000005', '48500000-0000-4000-8000-000000000005', 'web', decode(repeat('55', 32), 'hex'), 'desktop'),
  ('41100000-0000-4000-8000-000000000006', '41000000-0000-4000-8000-000000000006', '48600000-0000-4000-8000-000000000006', 'web', decode(repeat('66', 32), 'hex'), 'desktop');
insert into public.organization_invites (
  id, organization_id, email, destination_type, destination, invited_user_id,
  activation_mode, token_hash, role, expires_at, created_by_user_id
) values (
  '4a000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  'new-hire@example.test',
  'email',
  'new-hire@example.test',
  '41000000-0000-4000-8000-000000000005',
  'otp',
  extensions.digest(convert_to(repeat('f', 64), 'UTF8'), 'sha256'),
  'member', now() + interval '1 day', '41000000-0000-4000-8000-000000000001'
);
set local role service_role;
select is(
  (public.bff_authorize_invite_otp(
    repeat('f', 64), 'email', ' New-Hire@example.test ', null,
    repeat('1', 64), repeat('2', 64)
  ) ->> 'allowed')::boolean,
  true,
  'invite-bound OTP authorization accepts the normalized invited email'
);
select is(
  (public.bff_authorize_invite_otp(
    repeat('f', 64), 'email', 'wrong@example.test', null,
    repeat('1', 64), repeat('2', 64)
  ) ->> 'allowed')::boolean,
  false,
  'invite-bound OTP authorization fails generically for an email mismatch'
);
select ok(
  to_regprocedure('public.verify_organization_invite(text)') is null,
  'no public invitation-token verification oracle exists'
);
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000005"}',
  true
);
select lives_ok(
  $$select public.redeem_organization_invite(repeat('f', 64))$$,
  'verified invited user can redeem once'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (select use_count = 1 and accepted_by_user_id = '41000000-0000-4000-8000-000000000005'
   from public.organization_invites where id = '4a000000-0000-4000-8000-000000000001')
  and exists (
    select 1 from public.organization_memberships
    where organization_id = '42000000-0000-4000-8000-000000000001'
      and user_id = '41000000-0000-4000-8000-000000000005'
      and status = 'active'
  ),
  'redemption atomically consumes the token and creates membership'
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"41000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1","session_id":"41100000-0000-4000-8000-000000000005"}',
  true
);
select throws_ok(
  $$select public.redeem_organization_invite(repeat('f', 64))$$,
  '42501',
  'invitation is invalid or expired',
  'a consumed invitation cannot be redeemed again'
);
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_issue_organization_invite(
    '41000000-0000-4000-8000-000000000001',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000001',
    'email', 'second-hire@example.test',
    '41000000-0000-4000-8000-000000000006', null, 'otp',
    'member', 86400,
    'security-invite-issue', repeat('2', 64)
  )$$,
  'AAL2 owner can issue a single-use invitation'
);
reset role;
select ok(
  (select not (response_body ? 'token') and response_body ->> 'token_available' = 'false'
   from private.api_idempotency_keys
   where route = '/v2/admin/invitations'
     and idempotency_key = 'security-invite-issue'),
  'raw invitation tokens are not persisted in the idempotency response cache'
);

-- 68-73: translation jobs are content-free, topic-filtered, and completed atomically.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('app.language_detection_context', 'on', true);
update public.messages
set detected_language = 'ko',
    language_detection_state = 'completed',
    language_detection_method = 'fixture',
    language_detection_confidence = 1,
    language_detected_at = now()
where client_nonce = '44000000-0000-4000-8000-000000000001';
select set_config('app.language_detection_context', 'off', true);
select public.bff_set_organization_ai_policy_v2(
  '41000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '41100000-0000-4000-8000-000000000001',
  true, array['translation']::text[], array['openrouter']::text[],
  'approved_zero_retention', 0,
  'Enable the reviewed translation route for the security regression fixture',
  'security-ai-policy-enable', repeat('6', 64)
);
select lives_ok(
  $$select public.bff_enqueue_translation(
    '41000000-0000-4000-8000-000000000002',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000002',
    '43000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000001'),
    'fr', 'security-translation-enqueue', repeat('3', 64)
  )$$,
  'authorized member can enqueue translation without sending plaintext to outbox'
);
reset role;
select ok(
  (select (select count(*) from jsonb_object_keys(payload)) = 5
      and payload ?& array[
        'organization_id', 'conversation_id', 'message_id', 'target_language',
        'requested_by_user_id'
      ]
      and not (payload ? 'body')
   from private.outbox_jobs
   where topic = 'translation' and payload ->> 'target_language' = 'fr'),
  'translation outbox payload contains identifiers and target language only'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_claim_translation_jobs(
    '4b000000-0000-4000-8000-000000000001', 10, 60
  )$$,
  'translation worker can claim only the translation queue'
);
reset role;
select is(
  (select count(*)::bigint from private.outbox_jobs
   where status = 'processing'
     and claimed_by = '4b000000-0000-4000-8000-000000000001'
     and topic = 'translation'),
  1::bigint,
  'specialized worker claim leases exactly the eligible translation job'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $sql$do $block$
    declare v_job_id bigint := (
      select id from private.outbox_jobs
      where claimed_by = '4b000000-0000-4000-8000-000000000001'
        and topic = 'translation'
    );
    begin
      perform public.bff_resolve_translation_job_for_egress(
        '4b000000-0000-4000-8000-000000000001', v_job_id, 'openrouter'
      );
      perform public.bff_complete_translation_job(
        '4b000000-0000-4000-8000-000000000001', v_job_id,
        (select encode(extensions.digest(convert_to(body, 'UTF8'), 'sha256'), 'hex')
         from public.messages where client_nonce = '44000000-0000-4000-8000-000000000001'),
        'Texte traduit', 'openrouter', 'qwen/test-pinned', 0.9000
      );
    end
  $block$$sql$,
  'worker atomically validates source hash, stores provenance, and completes the lease'
);
select ok(
  exists (
    select 1 from public.message_translations translation
    join public.messages message
      on message.organization_id = translation.organization_id
     and message.conversation_id = translation.conversation_id
     and message.id = translation.message_id
    where message.client_nonce = '44000000-0000-4000-8000-000000000001'
      and translation.target_language = 'fr'
      and translation.status = 'completed'
      and translation.translated_body = 'Texte traduit'
      and translation.provider = 'openrouter'
      and translation.model = 'qwen/test-pinned'
  ) and exists (
    select 1 from private.outbox_jobs
    where topic = 'translation' and payload ->> 'target_language' = 'fr'
      and status = 'completed'
  ),
  'completed translation and outbox state commit together'
);

-- 74-77: retention scrubs primary/derived content and offboarding state is durable.
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"41000000-0000-4000-8000-000000000001","session_id":"41100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body,
  language_code, metadata
) values (
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  '41000000-0000-4000-8000-000000000001',
  '44000000-0000-4000-8000-000000000200',
  'attachment', 'Retention secret', 'ko', '{"sensitive":"value"}'::jsonb
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language, target_language,
  status, translated_body, provider, model
) values (
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000200'),
  'ko', 'es', 'completed', 'Secreto retenido', 'test-provider', 'test-model'
);
insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  storage_path, file_name, mime_type, byte_size, sha256_hex, scan_status,
  detected_mime_type, scan_completed_at, scanner_name, scanner_version
) values (
  '45000000-0000-4000-8000-000000000200',
  '42000000-0000-4000-8000-000000000001',
  '43000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '44000000-0000-4000-8000-000000000200'),
  '41000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001/43000000-0000-4000-8000-000000000001/41000000-0000-4000-8000-000000000001/45000000-0000-4000-8000-000000000200/upload',
  'retention.pdf', 'application/pdf', 256, repeat('a', 64), 'clean',
  'application/pdf',
  now(), 'fixture-scanner', '1.0'
);
alter table public.messages disable trigger messages_10_validate_update;
update public.messages set created_at = now() - interval '2 days'
where client_nonce = '44000000-0000-4000-8000-000000000200';
alter table public.messages enable trigger messages_10_validate_update;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.bff_update_organization_policy(
  '41000000-0000-4000-8000-000000000001',
  '42000000-0000-4000-8000-000000000001',
  '41100000-0000-4000-8000-000000000001',
  1,
  (select allow_member_direct_messages from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  (select dm_policy from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  (select require_mfa_for_admins from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  (select shift_schedule_authoritative from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  (select group_creation_policy from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  (select allow_external_guests from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  (select external_guest_max_access_days from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  (select organization_policy_version from public.organizations
    where id = '42000000-0000-4000-8000-000000000001'),
  'Set the one-day retention window for the regression fixture',
  'security-policy-retention', repeat('5', 64)
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_scrub_retention(500)$$,
  'retention worker scrubs expired messages in a bounded batch'
);
reset role;
select ok(
  (select body is null and metadata = '{}'::jsonb and language_code is null
      and deleted_at is not null and deleted_by_user_id is null
      and deletion_reason = 'retention'
   from public.messages where client_nonce = '44000000-0000-4000-8000-000000000200'),
  'retention deletion scrubs primary content without forging a user actor'
);
select ok(
  not exists (
    select 1 from public.message_translations translation
    join public.messages message
      on message.organization_id = translation.organization_id
     and message.conversation_id = translation.conversation_id
     and message.id = translation.message_id
    where message.client_nonce = '44000000-0000-4000-8000-000000000200'
  ) and (
    select scan_status = 'quarantined' and purge_requested_at is not null
    from public.message_attachments where id = '45000000-0000-4000-8000-000000000200'
  ) and exists (
    select 1 from private.outbox_jobs
    where topic = 'storage_purge'
      and payload ->> 'attachment_id' = '45000000-0000-4000-8000-000000000200'
  ),
  'retention deletes translations, revokes file visibility, and queues object purge'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs
    where payload::text ~* '(Original Korean source|Edited Korean source|Retention secret|"body")'
  )
  and (select revocation_generation = 1 and security_changed_at is not null
       from public.organization_memberships
       where organization_id = '42000000-0000-4000-8000-000000000001'
         and user_id = '41000000-0000-4000-8000-000000000003')
  and exists (
    select 1 from private.session_revocations
    where organization_id = '42000000-0000-4000-8000-000000000001'
      and session_id = '41100000-0000-4000-8000-000000000003'
  )
  and not (public.bff_authorize_request(
    '41000000-0000-4000-8000-000000000003',
    '42000000-0000-4000-8000-000000000001',
    '41100000-0000-4000-8000-000000000003',
    'security.offboarded', false, 0
  ) ->> 'allowed')::boolean,
  'outbox payloads are content-free and suspended sessions remain revoked'
);

select * from finish();
rollback;
