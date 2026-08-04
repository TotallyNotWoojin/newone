begin;
create extension if not exists dblink with schema extensions;
select plan(63);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('51000000-0000-4000-8000-000000000001', 'contract-owner@example.test', now()),
  ('51000000-0000-4000-8000-000000000002', 'contract-member@example.test', now()),
  ('51000000-0000-4000-8000-000000000003', 'manual-hire@example.test', now()),
  ('51000000-0000-4000-8000-000000000004', 'cascade-user@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('51100000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('51100000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('51100000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('51100000-0000-4000-8000-000000000004', '51000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('51100000-0000-4000-8000-000000000005', '51000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('51100000-0000-4000-8000-000000000006', '51000000-0000-4000-8000-000000000004', now(), now(), 'aal1');

insert into public.organizations (
  id, slug, name, require_mfa_for_admins, created_by_user_id
) values (
  '52000000-0000-4000-8000-000000000001',
  'security-contracts-v2', 'Security Contracts V2', true,
  '51000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'owner'),
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', 'member'),
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000004', 'member');

-- 1-8: every data-plane session is attributable to one immutable web/native
-- installation before organization authorization can succeed.
select is(
  (public.bff_authorize_request(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    'contracts.binding.missing', false, 0
  ) ->> 'allowed')::boolean,
  false,
  'an otherwise-live Auth session is denied until an installation is bound'
);

select lives_ok(
  $$select public.bff_bind_session_installation(
    '51000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    '51200000-0000-4000-8000-000000000001',
    'web', '1.0.0', 'en-US', repeat('1', 64), 'desktop'
  )$$,
  'the trusted Auth service can bind a web session without a push token'
);

select is(
  (public.bff_authorize_request(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    'contracts.binding.current', false, 0
  ) ->> 'allowed')::boolean,
  true,
  'a current non-revoked web binding authorizes the data plane'
);

select lives_ok(
  $$select public.bff_bind_session_installation(
    '51000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000002',
    '51200000-0000-4000-8000-000000000002',
    'web', '1.0.1', 'en-US', repeat('2', 64), 'desktop'
  )$$,
  'a second web session receives its own installation attribution'
);

select ok(
  (select jsonb_array_length(session_list -> 'sessions') = 2
      and not exists (
        select 1
        from jsonb_array_elements(session_list -> 'sessions') session_row
        where session_row ->> 'platform' <> 'web'
          or session_row -> 'device' ->> 'installation_id' is null
          or session_row -> 'signal' ->> 'client_family' <> 'desktop'
      )
   from (select public.bff_list_sessions(
     '51000000-0000-4000-8000-000000000001',
     '52000000-0000-4000-8000-000000000001',
     '51100000-0000-4000-8000-000000000001'
   ) session_list) listed),
  'session inventory contains attributable non-null web device metadata'
);

select throws_ok(
  $$select public.bff_bind_session_installation(
    '51000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    '51200000-0000-4000-8000-000000000099',
    'web', '1.0.0', 'en-US', repeat('1', 64), 'desktop'
  )$$,
  '42501',
  'session installation binding conflict',
  'an existing session cannot be rebound to a different installation'
);

select throws_ok(
  $$insert into private.session_installations (
    session_id, user_id, installation_id, platform,
    user_agent_hash, user_agent_family
  ) values (
    null, '51000000-0000-4000-8000-000000000001',
    '51200000-0000-4000-8000-000000000098', 'web',
    decode(repeat('98', 32), 'hex'), 'desktop'
  )$$,
  '23514',
  'active session does not belong to installation user',
  'an unrevoked installation binding cannot be inserted without a session'
);

select lives_ok(
  $sql$do $block$
  begin
    perform public.bff_bind_session_installation(
      '51000000-0000-4000-8000-000000000002',
      '51100000-0000-4000-8000-000000000003',
      '51200000-0000-4000-8000-000000000003',
      'ios', '1.0.0', 'en-US', repeat('3', 64), 'iphone'
    );
    perform public.bff_bind_session_installation(
      '51000000-0000-4000-8000-000000000002',
      '51100000-0000-4000-8000-000000000004',
      '51200000-0000-4000-8000-000000000004',
      'ios', '1.0.0', 'en-US', repeat('4', 64), 'iphone'
    );
  end
  $block$$sql$,
  'native sessions are bound through the same trusted attribution contract'
);

-- Bind the invitee before redemption and the cascade fixture before its
-- ordinary Auth sign-out. Neither binding depends on organization membership.
select public.bff_bind_session_installation(
  '51000000-0000-4000-8000-000000000003',
  '51100000-0000-4000-8000-000000000005',
  '51200000-0000-4000-8000-000000000005',
  'web', '1.0.0', 'en-US', repeat('5', 64), 'desktop'
);
select public.bff_bind_session_installation(
  '51000000-0000-4000-8000-000000000004',
  '51100000-0000-4000-8000-000000000006',
  '51200000-0000-4000-8000-000000000006',
  'android', '1.0.0', 'en-US', repeat('6', 64), 'android'
);

insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform,
  push_token_ciphertext, push_token_type, push_project_id, push_environment
) values
  (
    '51300000-0000-4000-8000-000000000003',
    '52000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    '51100000-0000-4000-8000-000000000003',
    '51200000-0000-4000-8000-000000000003',
    'ios', 'vault:contract-native-token-0003', 'expo',
    '51400000-0000-4000-8000-000000000003', 'development'
  ),
  (
    '51300000-0000-4000-8000-000000000004',
    '52000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000002',
    '51100000-0000-4000-8000-000000000004',
    '51200000-0000-4000-8000-000000000004',
    'ios', 'vault:contract-native-token-0004', 'expo',
    '51400000-0000-4000-8000-000000000004', 'development'
  ),
  (
    '51300000-0000-4000-8000-000000000006',
    '52000000-0000-4000-8000-000000000001',
    '51000000-0000-4000-8000-000000000004',
    '51100000-0000-4000-8000-000000000006',
    '51200000-0000-4000-8000-000000000006',
    'android', 'vault:contract-native-token-0006', 'expo',
    '51400000-0000-4000-8000-000000000006', 'development'
  );

-- 9-16: manual employee-code enrollment uses the separately delivered invite
-- token, generic eligibility, independent request/verify budgets, and one-use
-- hash-only redemption.
insert into public.organization_invites (
  id, organization_id, email, destination_type, destination,
  invited_user_id, employee_code_hash, activation_mode, token_hash,
  role, expires_at, created_by_user_id
) values (
  '51500000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  'manual-hire@example.test', 'email', 'manual-hire@example.test',
  '51000000-0000-4000-8000-000000000003',
  extensions.digest(convert_to('EMP-123', 'UTF8'), 'sha256'), 'manual',
  extensions.digest(convert_to(repeat('a', 64), 'UTF8'), 'sha256'),
  'member', now() + interval '1 day',
  '51000000-0000-4000-8000-000000000001'
);

select is(
  (public.bff_authorize_invite_otp(
    repeat('a', 64), 'email', 'manual-hire@example.test', 'BAD-999',
    repeat('b', 64), repeat('c', 64), 'request'
  ) ->> 'allowed')::boolean,
  false,
  'manual invite authorization rejects a mismatched employee code generically'
);

select is(
  (public.bff_authorize_invite_otp(
    repeat('a', 64), 'email', 'manual-hire@example.test', 'EMP-123',
    repeat('b', 64), repeat('c', 64), 'request'
  ) ->> 'allowed')::boolean,
  true,
  'manual employee-code plus separately delivered token can authorize email OTP'
);

do $block$
begin
  for i in 1..3 loop
    perform public.bff_authorize_invite_otp(
      repeat('a', 64), 'email', 'manual-hire@example.test', 'EMP-123',
      repeat('b', 64), repeat('c', 64), 'request'
    );
  end loop;
end
$block$;

select is(
  (public.bff_authorize_invite_otp(
    repeat('a', 64), 'email', 'manual-hire@example.test', 'EMP-123',
    repeat('b', 64), repeat('c', 64), 'request'
  ) ->> 'allowed')::boolean,
  false,
  'the bounded request/resend budget closes after five attempts'
);

select is(
  (public.bff_authorize_invite_otp(
    repeat('a', 64), 'email', 'manual-hire@example.test', 'EMP-123',
    repeat('b', 64), repeat('c', 64), 'verify'
  ) ->> 'allowed')::boolean,
  true,
  'verification has an independent budget after request attempts are exhausted'
);

select throws_ok(
  $$select public.bff_authorize_invite_otp(
    repeat('a', 64), 'email', 'manual-hire@example.test', 'EMP-123',
    repeat('b', 64), repeat('c', 64), 'unknown'
  )$$,
  '22023',
  'invalid OTP authorization purpose',
  'OTP authorization rejects an unbounded or unknown purpose'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"51100000-0000-4000-8000-000000000005"}',
  true
);
select lives_ok(
  $$select public.redeem_organization_invite(repeat('a', 64), 'EMP-123')$$,
  'the verified manual invite principal redeems exactly once'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select use_count = 1
      and accepted_by_user_id = '51000000-0000-4000-8000-000000000003'
      and token_hash = extensions.digest(convert_to(repeat('a', 64), 'UTF8'), 'sha256')
      and employee_code_hash = extensions.digest(convert_to('EMP-123', 'UTF8'), 'sha256')
   from public.organization_invites
   where id = '51500000-0000-4000-8000-000000000001')
  and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organization_invites'
      and column_name in ('token', 'employee_code')
  ),
  'manual enrollment is single-use and stores only token/code hashes'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"51100000-0000-4000-8000-000000000005"}',
  true
);
select throws_ok(
  $$select public.redeem_organization_invite(repeat('a', 64), 'EMP-123')$$,
  '42501',
  'invitation is invalid or expired',
  'a consumed manual invitation cannot be redeemed again'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Shared messaging fixtures for attestation, receipts, history gates, and push.
insert into public.conversations (
  id, organization_id, kind, name, history_policy, posting_mode, join_policy,
  created_by_user_id
) values
  ('53000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001', 'group', 'Contract group', 'all', 'all_members', 'inherit', '51000000-0000-4000-8000-000000000001'),
  ('53000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000001', 'announcement', 'Contract notices', 'all', 'admins_only', 'invite_only', '51000000-0000-4000-8000-000000000001'),
  ('53000000-0000-4000-8000-000000000003', '52000000-0000-4000-8000-000000000001', 'group', 'Since join', 'since_join', 'all_members', 'inherit', '51000000-0000-4000-8000-000000000001');

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'owner', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', 'member', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000001', 'owner', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 'member', '51000000-0000-4000-8000-000000000001'),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000001', 'owner', '51000000-0000-4000-8000-000000000001');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"51000000-0000-4000-8000-000000000001","session_id":"51100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, available_at
) values
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000001', 'text', 'Receipt contract', now()),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002', 'text', 'Future message', now() + interval '1 day'),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000003', 'text', 'Hidden message', now()),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000004', 'text', 'Attested notice', now()),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000005', 'text', 'Pre-join history', now());
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id,
  history_visible_from
) values (
  '52000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000003',
  '51000000-0000-4000-8000-000000000002', 'member',
  '51000000-0000-4000-8000-000000000001', now() + interval '1 second'
);

insert into public.message_user_visibility (
  organization_id, conversation_id, message_id, user_id
) values (
  '52000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000003'),
  '51000000-0000-4000-8000-000000000002'
);

insert into public.announcements (
  id, organization_id, conversation_id, message_id, title,
  requires_acknowledgement, acknowledgement_schema, created_by_user_id
) values (
  '55000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000002',
  (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000004'),
  'Attested notice', true,
  '{"schema_version":1,"attestation_required":true,"attestation_prompt":"I confirm","required_keys":["confirmed"],"carry_forward_on_correction":false}'::jsonb,
  '51000000-0000-4000-8000-000000000001'
);

-- 17-21: acknowledgement attestation requires the actor's current,
-- attributable Auth session. A push registration is optional evidence because
-- web and push-disabled native clients still have a bound installation.
select lives_ok(
  $$select public.bff_acknowledge_announcement(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    (select id from public.announcement_versions
     where announcement_id = '55000000-0000-4000-8000-000000000001'),
    null, '{"confirmed":true}'::jsonb,
    'contracts-attestation-null', repeat('1', 64)
  )$$,
  'a current attributable session can attest without a push registration'
);

select throws_ok(
  $$select public.bff_acknowledge_announcement(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    (select id from public.announcement_versions
     where announcement_id = '55000000-0000-4000-8000-000000000001'),
    '51300000-0000-4000-8000-000000000004',
    '{"confirmed":true}'::jsonb,
    'contracts-attestation-wrong-session', repeat('2', 64)
  )$$,
  '42501',
  'valid acknowledgement attestation and session evidence required',
  'an active device from another session cannot attest'
);

update public.device_registrations
set revoked_at = now()
where id = '51300000-0000-4000-8000-000000000004';

select throws_ok(
  $$select public.bff_acknowledge_announcement(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000004',
    (select id from public.announcement_versions
     where announcement_id = '55000000-0000-4000-8000-000000000001'),
    '51300000-0000-4000-8000-000000000004',
    '{"confirmed":true}'::jsonb,
    'contracts-attestation-revoked', repeat('3', 64)
  )$$,
  '42501',
  'valid acknowledgement attestation and session evidence required',
  'a revoked device cannot attest even for its original session'
);

select lives_ok(
  $$select public.bff_acknowledge_announcement(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    (select id from public.announcement_versions
     where announcement_id = '55000000-0000-4000-8000-000000000001'),
    '51300000-0000-4000-8000-000000000003',
    '{"confirmed":true}'::jsonb,
    'contracts-attestation-current', repeat('4', 64)
  )$$,
  'the current bound non-revoked device can record required attestation'
);

select ok(
  (select session_id = '51100000-0000-4000-8000-000000000003'
      and device_id is null
      and installation_id = '51200000-0000-4000-8000-000000000003'
      and platform = 'ios'
      and client_family = 'iphone'
      and octet_length(session_evidence_hash) = 32
      and attestation = '{"confirmed":true}'::jsonb
   from public.announcement_acknowledgements
   where announcement_id = '55000000-0000-4000-8000-000000000001'
     and user_id = '51000000-0000-4000-8000-000000000002'),
  'acknowledgement provenance preserves the first verified session, installation, and schema payload'
);

-- 22-28: recipients see only self state; senders see privacy-safe aggregate
-- counts with no identity or per-recipient detail channel.
insert into public.organization_user_preferences (
  organization_id, user_id, read_visibility
) values (
  '52000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002', 'nobody'
);

select lives_ok(
  $$select public.bff_mark_message_receipt(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'),
    'read', 'contracts-receipt-read', repeat('5', 64)
  )$$,
  'a recipient can advance their own delivered/read state monotonically'
);

select ok(
  (select receipt ->> 'scope' = 'aggregate'
      and (receipt ->> 'delivered')::boolean
      and not (receipt ->> 'read')::boolean
      and (receipt ->> 'recipient_count')::integer = 1
      and (receipt ->> 'delivered_count')::integer = 1
      and (receipt ->> 'visible_read_eligible_count')::integer = 0
      and (receipt ->> 'visible_read_count')::integer = 0
      and not (receipt ?| array['user_id', 'recipient_id', 'recipients', 'details'])
   from (
     select message_row -> 'receipt' as receipt
     from jsonb_array_elements(
       public.bff_bootstrap_messaging_state(
         '51000000-0000-4000-8000-000000000001',
         '52000000-0000-4000-8000-000000000001',
         '51100000-0000-4000-8000-000000000001',
         '53000000-0000-4000-8000-000000000001', null, 20, 20
       ) -> 'timeline' -> 'messages'
     ) message_row
     where (message_row ->> 'message_id')::bigint = (
       select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'
     )
   ) projection),
  'sender DTO counts delivery while suppressing hidden reads and every recipient identity'
);

select ok(
  (select receipt ->> 'scope' = 'self'
      and (receipt ->> 'delivered')::boolean
      and (receipt ->> 'read')::boolean
   from (
     select message_row -> 'receipt' as receipt
     from jsonb_array_elements(
       public.bff_bootstrap_messaging_state(
         '51000000-0000-4000-8000-000000000002',
         '52000000-0000-4000-8000-000000000001',
         '51100000-0000-4000-8000-000000000003',
         '53000000-0000-4000-8000-000000000001', null, 20, 20
       ) -> 'timeline' -> 'messages'
     ) message_row
     where (message_row ->> 'message_id')::bigint = (
       select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'
     )
   ) projection),
  'recipient DTO always reconciles only their own receipt state'
);

update public.organization_user_preferences
set read_visibility = 'contacts'
where organization_id = '52000000-0000-4000-8000-000000000001'
  and user_id = '51000000-0000-4000-8000-000000000002';

select ok(
  (select not (message_row -> 'receipt' ->> 'read')::boolean
      and (message_row -> 'receipt' ->> 'recipient_count')::integer = 1
      and (message_row -> 'receipt' ->> 'delivered_count')::integer = 1
      and (message_row -> 'receipt' ->> 'visible_read_eligible_count')::integer = 0
      and (message_row -> 'receipt' ->> 'visible_read_count')::integer = 0
   from jsonb_array_elements(
     public.bff_bootstrap_messaging_state(
       '51000000-0000-4000-8000-000000000001',
       '52000000-0000-4000-8000-000000000001',
       '51100000-0000-4000-8000-000000000001',
       '53000000-0000-4000-8000-000000000001', null, 20, 20
     ) -> 'timeline' -> 'messages'
   ) message_row
   where (message_row ->> 'message_id')::bigint = (
     select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'
   )),
  'contacts-only visibility hides read state before a connection is accepted'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2","session_id":"51100000-0000-4000-8000-000000000001"}',
  true
);

insert into public.contact_connections (
  organization_id, member_low_user_id, member_high_user_id,
  requested_by_user_id, status, responded_at
) values (
  '52000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002',
  '51000000-0000-4000-8000-000000000001', 'pending', null
);
select set_config(
  'request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal1","session_id":"51100000-0000-4000-8000-000000000003"}',
  true
);
update public.contact_connections
set status = 'accepted'
where organization_id = '52000000-0000-4000-8000-000000000001'
  and member_low_user_id = '51000000-0000-4000-8000-000000000001'
  and member_high_user_id = '51000000-0000-4000-8000-000000000002';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select (message_row -> 'receipt' ->> 'read')::boolean
      and (message_row -> 'receipt' ->> 'recipient_count')::integer = 1
      and (message_row -> 'receipt' ->> 'delivered_count')::integer = 1
      and (message_row -> 'receipt' ->> 'visible_read_eligible_count')::integer = 1
      and (message_row -> 'receipt' ->> 'visible_read_count')::integer = 1
   from jsonb_array_elements(
     public.bff_bootstrap_messaging_state(
       '51000000-0000-4000-8000-000000000001',
       '52000000-0000-4000-8000-000000000001',
       '51100000-0000-4000-8000-000000000001',
       '53000000-0000-4000-8000-000000000001', null, 20, 20
     ) -> 'timeline' -> 'messages'
   ) message_row
   where (message_row ->> 'message_id')::bigint = (
     select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'
   )),
  'contacts-only visibility reveals aggregate read state after acceptance'
);

grant select on public.message_receipts to authenticated;
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2","session_id":"51100000-0000-4000-8000-000000000001"}',
  true
);
select is(
  (select count(*)::bigint from public.message_receipts),
  0::bigint,
  'sender cannot bypass the DTO to enumerate raw recipient receipt rows'
);
select set_config(
  'request.jwt.claims',
  '{"sub":"51000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1","session_id":"51100000-0000-4000-8000-000000000003"}',
  true
);
select is(
  (select count(*)::bigint from public.message_receipts),
  1::bigint,
  'recipient RLS exposes exactly their own raw receipt row'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"51000000-0000-4000-8000-000000000001","session_id":"51100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000010', 'text', 'Range read first'),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000011', 'text', 'Range read target');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$select public.bff_mark_message_receipt(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000011'),
    'read', 'contracts-receipt-range', repeat('a', 64)
  )$$,
  'read acknowledgement atomically covers the readable incoming range through its target'
);

select is(
  (select count(*)::bigint
   from public.message_receipts receipt
   join public.messages message
     on message.organization_id = receipt.organization_id
    and message.conversation_id = receipt.conversation_id
    and message.id = receipt.message_id
   where receipt.user_id = '51000000-0000-4000-8000-000000000002'
     and message.client_nonce in (
       '54000000-0000-4000-8000-000000000010',
       '54000000-0000-4000-8000-000000000011'
     )
     and receipt.delivered_at is not null
     and receipt.read_at is not null),
  2::bigint,
  'every readable incoming message after the prior cursor is delivered and read'
);

select is(
  (select cursor.last_read_message_id
   from public.conversation_read_cursors cursor
   where cursor.organization_id = '52000000-0000-4000-8000-000000000001'
     and cursor.conversation_id = '53000000-0000-4000-8000-000000000001'
     and cursor.user_id = '51000000-0000-4000-8000-000000000002'),
  (select id from public.messages
   where client_nonce = '54000000-0000-4000-8000-000000000011'),
  'read cursor advances to the acknowledged range endpoint'
);

select lives_ok(
  $$select public.bff_mark_message_receipt(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'),
    'read', 'contracts-receipt-older-retry', repeat('b', 64)
  )$$,
  'an older read retry is idempotent instead of failing or regressing state'
);

select is(
  (select cursor.last_read_message_id
   from public.conversation_read_cursors cursor
   where cursor.organization_id = '52000000-0000-4000-8000-000000000001'
     and cursor.conversation_id = '53000000-0000-4000-8000-000000000001'
     and cursor.user_id = '51000000-0000-4000-8000-000000000002'),
  (select id from public.messages
   where client_nonce = '54000000-0000-4000-8000-000000000011'),
  'an older retry leaves the monotonic cursor at its newer endpoint'
);

select ok(
  (select count(*) >= 2
      and bool_and(not (message.payload ?| array[
        'user_id', 'recipient_user_id', 'receipt_user_id', 'read_at', 'delivered_at'
      ]))
   from realtime.messages message
   where message.extension = 'broadcast'
     and message.private
     and message.event = 'workspace.invalidated'
     and message.payload ->> 'entity_type' = 'receipt'
     and message.payload ->> 'entity_id' = (
       select id::text from public.messages
       where client_nonce = '54000000-0000-4000-8000-000000000011'
     )),
  'receipt commits fan out content-free invalidations to current member inboxes'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"51000000-0000-4000-8000-000000000001","session_id":"51100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000012', 'text', 'Delivered prior'),
  ('52000000-0000-4000-8000-000000000001', '53000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000013', 'text', 'Delivered target');
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$select public.bff_mark_message_receipt(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000013'),
    'delivered', 'contracts-receipt-delivered-target', repeat('c', 64)
  )$$,
  'delivered acknowledgement remains a target-only transition'
);

select ok(
  exists (
    select 1
    from public.message_receipts receipt
    join public.messages message
      on message.organization_id = receipt.organization_id
     and message.conversation_id = receipt.conversation_id
     and message.id = receipt.message_id
    where receipt.user_id = '51000000-0000-4000-8000-000000000002'
      and message.client_nonce = '54000000-0000-4000-8000-000000000013'
      and receipt.delivered_at is not null
      and receipt.read_at is null
  ) and not exists (
    select 1
    from public.message_receipts receipt
    join public.messages message
      on message.organization_id = receipt.organization_id
     and message.conversation_id = receipt.conversation_id
     and message.id = receipt.message_id
    where receipt.user_id = '51000000-0000-4000-8000-000000000002'
      and message.client_nonce = '54000000-0000-4000-8000-000000000012'
  ),
  'delivered acknowledgement does not imply an unread range transition'
);

-- 29-32: receipt/cursor writes cannot cross history, schedule, or delete-for-me
-- visibility boundaries.
select throws_ok(
  $$select public.bff_mark_message_receipt(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000003',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000005'),
    'read', 'contracts-receipt-history', repeat('6', 64)
  )$$,
  '42501', 'readable message not found',
  'a since-join member cannot write a receipt for pre-join history'
);

select throws_ok(
  $$select public.bff_mark_message_receipt(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000002'),
    'read', 'contracts-receipt-future', repeat('7', 64)
  )$$,
  '42501', 'readable message not found',
  'a recipient cannot mark a scheduled future message read'
);

select throws_ok(
  $$select public.bff_mark_message_receipt(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    '53000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000003'),
    'read', 'contracts-receipt-hidden', repeat('8', 64)
  )$$,
  '42501', 'readable message not found',
  'delete-for-me state prevents later receipt forgery for the hidden message'
);

select throws_ok(
  $$insert into public.conversation_read_cursors (
    organization_id, conversation_id, user_id, last_read_message_id
  ) values (
    '52000000-0000-4000-8000-000000000001',
    '53000000-0000-4000-8000-000000000003',
    '51000000-0000-4000-8000-000000000002',
    (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000005')
  )$$,
  '42501', 'read cursor target is not readable',
  'read cursor trigger independently enforces the history boundary'
);

-- 33-45: push fan-out enforces personal conversation preferences before
-- dispatch, excludes the sender, and still closes revoked session delivery.
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-active',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001')
  )
);
do $block$
begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000001', array['push']::text[], 10, 60
  );
end
$block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000001',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-active'),
    null, 100
  ) -> 'deliveries')),
  1,
  'push fan-out includes the one active native registration and excludes web sessions'
);

insert into public.conversation_preferences (
  organization_id, conversation_id, user_id, notification_level, muted_until
) values (
  '52000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002', 'none', null
)
on conflict (organization_id, conversation_id, user_id) do update
set notification_level = excluded.notification_level,
    muted_until = excluded.muted_until;
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-muted',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001')
  )
);
do $block$ begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000011', array['push']::text[], 10, 60
  );
end $block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000011',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-muted'),
    null, 100
  ) -> 'deliveries')),
  0,
  'an indefinite conversation mute suppresses routine push fan-out'
);

update public.conversation_preferences
set notification_level = 'mentions', muted_until = null
where organization_id = '52000000-0000-4000-8000-000000000001'
  and conversation_id = '53000000-0000-4000-8000-000000000001'
  and user_id = '51000000-0000-4000-8000-000000000002';
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-unmentioned',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001')
  )
);
do $block$ begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000012', array['push']::text[], 10, 60
  );
end $block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000012',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-unmentioned'),
    null, 100
  ) -> 'deliveries')),
  0,
  'mentions-only suppresses an unmentioned group message'
);

insert into public.message_mentions (
  organization_id, conversation_id, message_id, mentioned_user_id
) values (
  '52000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'),
  '51000000-0000-4000-8000-000000000002'
);
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-mentioned',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001')
  )
);
do $block$ begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000013', array['push']::text[], 10, 60
  );
end $block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000013',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-mentioned'),
    null, 100
  ) -> 'deliveries')),
  1,
  'mentions-only delivers a group message that names the recipient'
);

update public.conversation_preferences
set muted_until = now() + interval '1 hour'
where organization_id = '52000000-0000-4000-8000-000000000001'
  and conversation_id = '53000000-0000-4000-8000-000000000001'
  and user_id = '51000000-0000-4000-8000-000000000002';
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-timed-muted',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001')
  )
);
do $block$ begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000014', array['push']::text[], 10, 60
  );
end $block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000014',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-timed-muted'),
    null, 100
  ) -> 'deliveries')),
  0,
  'an active timed mute suppresses even a mentioned routine message'
);

select ok(
  exists (
    select 1
    from jsonb_array_elements((public.bff_bootstrap_messaging_state(
      '51000000-0000-4000-8000-000000000002',
      '52000000-0000-4000-8000-000000000001',
      '51100000-0000-4000-8000-000000000003',
      '53000000-0000-4000-8000-000000000001', null, 20, 20
    ) -> 'conversations')) conversation
    where conversation ->> 'conversation_id' = '53000000-0000-4000-8000-000000000001'
      and conversation -> 'preferences' ->> 'notification_level' = 'mentions'
      and (conversation -> 'preferences' ->> 'muted_until')::timestamptz > now()
  ),
  'messaging bootstrap returns the personal timed mute rather than stale member defaults'
);

update public.conversation_preferences
set muted_until = now() - interval '1 minute'
where organization_id = '52000000-0000-4000-8000-000000000001'
  and conversation_id = '53000000-0000-4000-8000-000000000001'
  and user_id = '51000000-0000-4000-8000-000000000002';
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-mute-expired',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001')
  )
);
do $block$ begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000015', array['push']::text[], 10, 60
  );
end $block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000015',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-mute-expired'),
    null, 100
  ) -> 'deliveries')),
  1,
  'an expired timed mute no longer suppresses a mentioned message'
);

update public.conversation_preferences
set notification_level = 'none', muted_until = null
where organization_id = '52000000-0000-4000-8000-000000000001'
  and conversation_id = '53000000-0000-4000-8000-000000000001'
  and user_id = '51000000-0000-4000-8000-000000000002';
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-forged-critical',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'),
    'notification_class', 'critical',
    'critical_category', 'safety',
    'quiet_hours_override_reason', 'Synthetic payload is not an authorized announcement'
  )
);
do $block$ begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000016', array['push']::text[], 10, 60
  );
end $block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000016',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-forged-critical'),
    null, 100
  ) -> 'deliveries')),
  0,
  'critical override cannot be forged without an authoritative announcement version'
);

update public.conversation_preferences
set notification_level = 'all', muted_until = null
where organization_id = '52000000-0000-4000-8000-000000000001'
  and conversation_id = '53000000-0000-4000-8000-000000000001'
  and user_id = '51000000-0000-4000-8000-000000000002';
insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-forged-critical-visible',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001'),
    'notification_class', 'critical',
    'critical_category', 'safety',
    'quiet_hours_override_reason', 'Synthetic payload is not an authorized announcement'
  )
);
do $block$ begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000017', array['push']::text[], 10, 60
  );
end $block$;
select ok(
  exists (
    select 1
    from jsonb_array_elements((public.bff_resolve_push_job(
      '51600000-0000-4000-8000-000000000017',
      (select id from private.outbox_jobs where dedupe_key = 'contracts-push-forged-critical-visible'),
      null, 100
    ) -> 'deliveries')) delivery
    where delivery ->> 'notification_class' = 'routine'
      and (delivery ->> 'quiet_hours_override')::boolean is false
      and delivery ->> 'critical_category' is null
  ),
  'an untrusted critical-shaped payload is normalized to routine delivery metadata'
);

select lives_ok(
  $$select public.bff_revoke_session(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    'Lost native device', 'contracts-revoke-native', repeat('9', 64)
  )$$,
  'an AAL2 owner can remotely revoke a member session'
);

select ok(
  (select revoked_at is not null from private.session_installations
   where session_id = '51100000-0000-4000-8000-000000000003')
  and (select revoked_at is not null from public.device_registrations
       where id = '51300000-0000-4000-8000-000000000003'),
  'session revocation synchronously revokes its binding and push registration'
);

insert into private.outbox_jobs (organization_id, topic, dedupe_key, payload)
values (
  '52000000-0000-4000-8000-000000000001', 'push', 'contracts-push-revoked',
  jsonb_build_object(
    'organization_id', '52000000-0000-4000-8000-000000000001',
    'conversation_id', '53000000-0000-4000-8000-000000000001',
    'message_id', (select id from public.messages where client_nonce = '54000000-0000-4000-8000-000000000001')
  )
);
do $block$
begin
  perform public.bff_claim_outbox_topics(
    '51600000-0000-4000-8000-000000000002', array['push']::text[], 10, 60
  );
end
$block$;
select is(
  jsonb_array_length((public.bff_resolve_push_job(
    '51600000-0000-4000-8000-000000000002',
    (select id from private.outbox_jobs where dedupe_key = 'contracts-push-revoked'),
    null, 100
  ) -> 'deliveries')),
  0,
  'a revoked session is excluded from every later push fan-out'
);

select lives_ok(
  $$select public.bff_revoke_session(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000002',
    'Remote web session', 'contracts-revoke-remote-web', repeat('d', 64)
  )$$,
  'a user can revoke another one of their attributable web sessions'
);

select ok(
  (select revoked_at is not null from private.session_installations
   where session_id = '51100000-0000-4000-8000-000000000002')
  and not (public.bff_authorize_request(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000002',
    'contracts.revoked.remote', false, 0
  ) ->> 'allowed')::boolean,
  'a remotely revoked web binding immediately loses authorization'
);

-- 39-40: ordinary Auth sign-out/delete follows both ON DELETE SET NULL paths,
-- but triggers preserve provenance while revoking binding and push.
select lives_ok(
  $$delete from auth.sessions
    where id = '51100000-0000-4000-8000-000000000006'$$,
  'ordinary Auth session deletion succeeds through both revocation cascades'
);

select ok(
  (select session_id is null and revoked_at is not null
   from private.session_installations
   where user_id = '51000000-0000-4000-8000-000000000004'
     and installation_id = '51200000-0000-4000-8000-000000000006')
  and (select session_id is null and revoked_at is not null
       from public.device_registrations
       where id = '51300000-0000-4000-8000-000000000006'),
  'Auth deletion retains attributable rows only in a revoked, non-dispatchable state'
);

-- 41-42: the same checked endpoint supports intentional current-session
-- sign-out; completion remains idempotently recorded before Auth cleanup.
select lives_ok(
  $$select public.bff_revoke_session(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    'Current session sign out', 'contracts-revoke-current', repeat('e', 64)
  )$$,
  'the checked revoke endpoint can revoke the current session intentionally'
);

select ok(
  (select revoked_at is not null from private.session_installations
   where session_id = '51100000-0000-4000-8000-000000000001')
  and not (public.bff_authorize_request(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    'contracts.revoked.current', false, 0
  ) ->> 'allowed')::boolean,
  'current-session revoke cuts authorization before asynchronous Auth deletion'
);

-- 43-45: database shape and concurrent claimants remain release-gated.
select is(
  (with foreign_keys as (
    select constraint_row.conrelid, constraint_row.conkey
    from pg_constraint constraint_row
    join pg_class relation on relation.oid = constraint_row.conrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where constraint_row.contype = 'f'
      and namespace.nspname in ('public', 'private')
  )
  select count(*)::bigint
  from foreign_keys foreign_key
  where not exists (
    select 1
    from pg_index index_row
    where index_row.indrelid = foreign_key.conrelid
      and index_row.indisvalid
      and index_row.indisready
      and index_row.indpred is null
      and index_row.indnkeyatts >= cardinality(foreign_key.conkey)
      and not exists (
        select 1
        from generate_subscripts(foreign_key.conkey, 1) position
        where (index_row.indkey::smallint[])[position - 1]
          <> foreign_key.conkey[position]
      )
  )),
  0::bigint,
  'every public/private foreign key has a valid ready non-partial left-prefix index'
);

select is(
  (select coalesce(
     array_agg(
       namespace.nspname || '.' || routine.proname
       order by namespace.nspname, routine.proname
     ),
     array[]::text[]
   )
   from pg_proc routine
   join pg_namespace namespace on namespace.oid = routine.pronamespace
   where namespace.nspname in ('public', 'private')
     and lower(routine.prosrc) like '%skip locked%'),
  array[
    'private.bff_claim_ai_regression_examples_impl',
    'private.bff_claim_outbox_topics_impl',
    'private.bff_claim_push_receipts_impl',
    'private.bff_process_announcement_obligations_impl',
    'private.bff_process_dynamic_group_boundaries_impl',
    'private.bff_process_dynamic_group_reconciliation_impl',
    'private.bff_process_overdue_handoffs_impl',
    'private.bff_promote_due_announcements_impl',
    'private.bff_scrub_retention_impl',
    'private.claim_outbox_jobs_internal',
    'private.scrub_conversation_avatar_candidates_internal'
  ]::text[],
  'the eleven known concurrent lease claimants remain explicitly inventoried'
);

select is(
  (select count(*)::bigint
   from pg_proc routine
   join pg_namespace namespace on namespace.oid = routine.pronamespace
   where namespace.nspname in ('public', 'private')
     and lower(routine.prosrc) like '%skip locked%'
     and (
       lower(routine.prosrc) !~ 'order[[:space:]]+by'
       or lower(routine.prosrc) !~ 'limit[[:space:]]+'
       or regexp_count(
         lower(routine.prosrc),
         'for update( of [a-z_]+)? skip locked'
       ) <> 1
     )),
  0::bigint,
  'every SKIP LOCKED claimant is bounded, deterministically ordered, and singular'
);

-- 54-55: rate-limit buckets do not reset at arbitrary wall-clock boundaries,
-- and independent consumers serialize against the same scope/key allowance.
with boundary_bucket as (
  select clock_timestamp() - interval '1 second' as started_at
)
insert into private.rate_limit_buckets (
  scope,
  key_hash,
  window_started_at,
  request_count,
  expires_at
)
select
  'pgtap-boundary-rate-limit',
  extensions.digest('shared-boundary-key', 'sha256'),
  started_at,
  1,
  started_at + interval '20 seconds'
from boundary_bucket;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  private.consume_rate_limit(
    'pgtap-boundary-rate-limit',
    'shared-boundary-key',
    1,
    10
  ),
  false,
  'an active first-request-anchored bucket cannot be bypassed at an epoch boundary'
);

create temporary table rate_limit_concurrency_results (
  allowed boolean not null
) on commit drop;

do $setup_concurrency$
begin
  perform extensions.dblink_connect(
    'rate_limit_consumer_a',
    'host=supabase_db_newone port=5432 dbname=postgres user=postgres password=postgres sslmode=disable'
  );
  perform extensions.dblink_connect(
    'rate_limit_consumer_b',
    'host=supabase_db_newone port=5432 dbname=postgres user=postgres password=postgres sslmode=disable'
  );
  perform extensions.dblink_exec(
    'rate_limit_consumer_a',
    $cleanup$delete from private.rate_limit_buckets
      where scope = 'pgtap-concurrent-rate-limit'
        and key_hash = extensions.digest('shared-concurrency-key', 'sha256')$cleanup$
  );
  perform extensions.dblink_send_query(
    'rate_limit_consumer_a',
    $query$with configured as materialized (
      select set_config('request.jwt.claims', '{"role":"service_role"}', false)
    ), delayed as materialized (
      select pg_sleep(0.25) from configured
    )
    select private.consume_rate_limit(
      'pgtap-concurrent-rate-limit', 'shared-concurrency-key', 1, 60
    ) as allowed
    from delayed$query$
  );
  perform extensions.dblink_send_query(
    'rate_limit_consumer_b',
    $query$with configured as materialized (
      select set_config('request.jwt.claims', '{"role":"service_role"}', false)
    ), delayed as materialized (
      select pg_sleep(0.25) from configured
    )
    select private.consume_rate_limit(
      'pgtap-concurrent-rate-limit', 'shared-concurrency-key', 1, 60
    ) as allowed
    from delayed$query$
  );
end;
$setup_concurrency$;

insert into rate_limit_concurrency_results (allowed)
select result.allowed
from extensions.dblink_get_result('rate_limit_consumer_a') as result(allowed boolean);

insert into rate_limit_concurrency_results (allowed)
select result.allowed
from extensions.dblink_get_result('rate_limit_consumer_b') as result(allowed boolean);

-- libpq exposes one final empty result after each asynchronous query. Drain it
-- before reusing the connections for rollback-safe fixture cleanup.
do $drain_concurrency$
begin
  perform result.allowed
  from extensions.dblink_get_result('rate_limit_consumer_a') as result(allowed boolean);
  perform result.allowed
  from extensions.dblink_get_result('rate_limit_consumer_b') as result(allowed boolean);
end;
$drain_concurrency$;

select ok(
  (select count(*) = 2
      and count(*) filter (where allowed) = 1
      and count(*) filter (where not allowed) = 1
   from rate_limit_concurrency_results),
  'simultaneous consumers atomically share one rate-limit allowance'
);

do $teardown_concurrency$
begin
  perform extensions.dblink_exec(
    'rate_limit_consumer_a',
    $cleanup$delete from private.rate_limit_buckets
      where scope = 'pgtap-concurrent-rate-limit'
        and key_hash = extensions.digest('shared-concurrency-key', 'sha256')$cleanup$
  );
  perform extensions.dblink_disconnect('rate_limit_consumer_a');
  perform extensions.dblink_disconnect('rate_limit_consumer_b');
end;
$teardown_concurrency$;

select * from finish();
rollback;
