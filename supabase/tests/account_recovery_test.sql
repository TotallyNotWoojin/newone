begin;
select plan(42);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (
  id, email, email_confirmed_at, created_at, updated_at
) values
  ('51000000-0000-4000-8000-000000000001', 'recovery-member@example.test', now(), now(), now()),
  ('51000000-0000-4000-8000-000000000002', 'recovery-owner@example.test', now(), now(), now()),
  ('51000000-0000-4000-8000-000000000003', 'recovery-verifier@example.test', now(), now(), now()),
  ('51000000-0000-4000-8000-000000000004', 'recovery-approver@example.test', now(), now(), now()),
  ('51000000-0000-4000-8000-000000000005', 'recovery-privileged@example.test', now(), now(), now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('51100000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('51100000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('51100000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('51100000-0000-4000-8000-000000000004', '51000000-0000-4000-8000-000000000003', now(), now(), 'aal2'),
  ('51100000-0000-4000-8000-000000000005', '51000000-0000-4000-8000-000000000004', now(), now(), 'aal2'),
  ('51100000-0000-4000-8000-000000000006', '51000000-0000-4000-8000-000000000005', now(), now(), 'aal1'),
  ('51100000-0000-4000-8000-000000000007', '51000000-0000-4000-8000-000000000005', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values
  ('51100000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'ios', decode(repeat('11', 32), 'hex'), 'iphone'),
  ('51100000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000002', 'ios', decode(repeat('12', 32), 'hex'), 'iphone'),
  ('51100000-0000-4000-8000-000000000003', '51000000-0000-4000-8000-000000000002', '51200000-0000-4000-8000-000000000003', 'web', decode(repeat('13', 32), 'hex'), 'desktop'),
  ('51100000-0000-4000-8000-000000000004', '51000000-0000-4000-8000-000000000003', '51200000-0000-4000-8000-000000000004', 'web', decode(repeat('14', 32), 'hex'), 'desktop'),
  ('51100000-0000-4000-8000-000000000005', '51000000-0000-4000-8000-000000000004', '51200000-0000-4000-8000-000000000005', 'web', decode(repeat('15', 32), 'hex'), 'desktop'),
  ('51100000-0000-4000-8000-000000000006', '51000000-0000-4000-8000-000000000005', '51200000-0000-4000-8000-000000000006', 'android', decode(repeat('16', 32), 'hex'), 'android'),
  ('51100000-0000-4000-8000-000000000007', '51000000-0000-4000-8000-000000000005', '51200000-0000-4000-8000-000000000007', 'android', decode(repeat('17', 32), 'hex'), 'android');

insert into public.organizations (
  id, slug, name, require_mfa_for_admins, created_by_user_id
) values (
  '52000000-0000-4000-8000-000000000001',
  'account-recovery-test',
  'Account Recovery Test',
  true,
  '51000000-0000-4000-8000-000000000002'
);

insert into public.organization_memberships (
  organization_id, user_id, role
) values
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 'member'),
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', 'owner'),
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000003', 'admin'),
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000004', 'admin'),
  ('52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000005', 'admin');

insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform,
  push_token_ciphertext, push_token_type, push_project_id, push_environment
) values
  ('53000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '51100000-0000-4000-8000-000000000001', '51200000-0000-4000-8000-000000000001', 'ios', 'vault:recovery-current-push-token', 'expo', '53900000-0000-4000-8000-000000000001', 'development'),
  ('53000000-0000-4000-8000-000000000002', '52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', '51100000-0000-4000-8000-000000000002', '51200000-0000-4000-8000-000000000002', 'ios', 'vault:recovery-other-push-token', 'expo', '53900000-0000-4000-8000-000000000001', 'development'),
  ('53000000-0000-4000-8000-000000000003', '52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000005', '51100000-0000-4000-8000-000000000006', '51200000-0000-4000-8000-000000000006', 'android', 'vault:recovery-privileged-push-token-one', 'expo', '53900000-0000-4000-8000-000000000001', 'development'),
  ('53000000-0000-4000-8000-000000000004', '52000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000005', '51100000-0000-4000-8000-000000000007', '51200000-0000-4000-8000-000000000007', 'android', 'vault:recovery-privileged-push-token-two', 'expo', '53900000-0000-4000-8000-000000000001', 'development');

-- 1-3: exact capability and RPC boundary.
select ok(
  exists (
    select 1 from public.organization_role_permissions permission
    where permission.role_name = 'security_admin'
      and permission.permission = 'recovery.manage'
  ),
  'security_admin carries the explicit recovery.manage capability'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_finalize_account_recovery_execution(uuid,uuid,uuid,uuid,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_finalize_account_recovery_execution(uuid,uuid,uuid,uuid,uuid)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'private.assert_recovery_manager_internal(uuid,uuid,uuid,text)',
    'execute'
  )
  and not has_function_privilege(
    'service_role',
    'private.expire_account_recovery_case_internal(private.account_recovery_cases)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.bff_authorize_account_recovery_otp(text,text,text,text,text)',
    'execute'
  ),
  'recovery RPCs are service-role-only'
);
select ok(
  not has_table_privilege('service_role', 'private.account_recovery_cases', 'select')
  and not has_table_privilege('authenticated', 'private.account_recovery_cases', 'select')
  and not has_table_privilege('anon', 'private.account_security_events', 'select'),
  'no Data API role receives raw recovery evidence table access'
);

-- These read-only grants exist only inside this rolled-back pgTAP transaction.
-- They let assertions resolve fixture case IDs while the service role invokes
-- the public RPC boundary; the production migration intentionally grants none.
grant select on
  private.account_recovery_cases,
  private.account_recovery_case_approvals,
  private.account_recovery_execution_sessions
to service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 4-9: request and verify budgets are distinct and all three dimensions are consumed.
select ok(
  (public.bff_authorize_account_recovery_otp(
    'email', 'recovery-member@example.test', repeat('a', 64), repeat('b', 64), 'request'
  ) ->> 'allowed')::boolean,
  'first eligible recovery request is authorized internally'
);
select ok(
  (public.bff_authorize_account_recovery_otp(
    'email', 'recovery-member@example.test', repeat('a', 64), repeat('b', 64), 'request'
  ) ->> 'allowed')::boolean
  and (public.bff_authorize_account_recovery_otp(
    'email', 'recovery-member@example.test', repeat('a', 64), repeat('b', 64), 'request'
  ) ->> 'allowed')::boolean,
  'three account recovery requests fit the documented identity budget'
);
select is(
  (public.bff_authorize_account_recovery_otp(
    'email', 'recovery-member@example.test', repeat('a', 64), repeat('b', 64), 'request'
  ) ->> 'allowed')::boolean,
  false,
  'the fourth recovery request is denied without revealing why'
);
select ok(
  (public.bff_authorize_account_recovery_otp(
    'email', 'recovery-member@example.test', repeat('a', 64), repeat('b', 64), 'verify'
  ) ->> 'allowed')::boolean,
  'verification has an independent budget after request exhaustion'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::bigint from private.rate_limit_buckets bucket
   where bucket.scope in (
     'recovery_request_identity_1h', 'recovery_request_ip_1h',
     'recovery_request_installation_1h'
   )),
  3::bigint,
  'request authorization consumes identity, IP, and installation buckets'
);
select is(
  (select count(*)::bigint from private.rate_limit_buckets bucket
   where bucket.scope in (
     'recovery_verify_identity_15m', 'recovery_verify_ip_15m',
     'recovery_verify_installation_15m'
   )),
  3::bigint,
  'verification authorization consumes a separate three-dimensional budget'
);

-- 10-16: self-service OTP recovery preserves only the newly verified session.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (public.bff_complete_account_recovery(
    '51000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001'
  ) ->> 'current_session_preserved')::boolean,
  'OTP recovery atomically reports preservation of the newly verified session'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::bigint from auth.sessions session
   where session.user_id = '51000000-0000-4000-8000-000000000001'),
  1::bigint,
  'every other Auth session is deleted'
);
select ok(
  exists (
    select 1 from private.session_installations binding
    where binding.session_id = '51100000-0000-4000-8000-000000000001'
      and binding.revoked_at is null
  ),
  'the new session installation remains active'
);
select ok(
  exists (
    select 1 from private.session_installations binding
    where binding.user_id = '51000000-0000-4000-8000-000000000001'
      and binding.installation_id = '51200000-0000-4000-8000-000000000002'
      and binding.revoked_at is not null
  ),
  'the other installation binding is revoked even after its Auth FK is cleared'
);
select ok(
  (select revoked_at is null from public.device_registrations
   where id = '53000000-0000-4000-8000-000000000001')
  and (select revoked_at is not null from public.device_registrations
   where id = '53000000-0000-4000-8000-000000000002'),
  'only the current push destination survives self-service recovery'
);
select is(
  (select count(*)::bigint from private.account_security_events event
   where event.user_id = '51000000-0000-4000-8000-000000000001'
     and event.event_type = 'otp_recovery_completed'),
  1::bigint,
  'self-service recovery writes one durable security event'
);
select is(
  (select count(*)::bigint from private.account_security_notices notice
   where notice.user_id = '51000000-0000-4000-8000-000000000001'
     and notice.delivery_state = 'pending_external_delivery'),
  1::bigint,
  'self-service recovery queues a truthful external security notice'
);

-- 17-19: a privileged target creates one idempotent, externally verified case.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (public.bff_create_account_recovery_case(
    '51000000-0000-4000-8000-000000000005',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000006',
    '54000000-0000-4000-8000-000000000001',
    'totp', 'verified',
    'The company authenticator device is permanently unavailable.',
    'recovery-case-create-01', repeat('1', 64)
  ) ->> 'privileged_target')::boolean,
  'owner/admin targets are snapshotted as privileged'
);
select is(
  (public.bff_create_account_recovery_case(
    '51000000-0000-4000-8000-000000000005',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000006',
    '54000000-0000-4000-8000-000000000001',
    'totp', 'verified',
    'The company authenticator device is permanently unavailable.',
    'recovery-case-create-01', repeat('1', 64)
  ) ->> 'required_approvals')::integer,
  2,
  'idempotent replay preserves the privileged two-approver requirement'
);
select is(
  (select count(*)::bigint from private.account_recovery_cases recovery_case
   where recovery_case.target_user_id = '51000000-0000-4000-8000-000000000005'),
  1::bigint,
  'idempotent case creation does not duplicate active cases'
);

-- 20-26: verifier, approver, and target are separated; privileged targets need two approvers.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_record_account_recovery_verification(
    '51000000-0000-4000-8000-000000000005',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000006',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'in_person', repeat('2', 64),
    'recovery-self-verify-01', repeat('2', 64)
  )$$,
  '42501',
  null,
  'the target cannot verify their own recovery case'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_record_account_recovery_verification(
    '51000000-0000-4000-8000-000000000003',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000004',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'manager_callback', repeat('3', 64),
    'recovery-verify-0001', repeat('3', 64)
  ) ->> 'status'),
  'awaiting_approval',
  'a recent-AAL2 recovery manager can record hashed external evidence'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_approve_account_recovery_case(
    '51000000-0000-4000-8000-000000000003',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000004',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'recovery-verifier-approve-01', repeat('4', 64)
  )$$,
  '42501',
  null,
  'the external verifier cannot also approve the case'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_approve_account_recovery_case(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'recovery-approve-owner-01', repeat('5', 64)
  ) ->> 'status'),
  'awaiting_approval',
  'one approval is insufficient for a privileged target'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_approve_account_recovery_case(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'recovery-approve-owner-02', repeat('6', 64)
  ) ->> 'approvals_recorded')::integer,
  1,
  'the same actor cannot create a second approval with a new idempotency key'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_approve_account_recovery_case(
    '51000000-0000-4000-8000-000000000004',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000005',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'recovery-approve-admin-01', repeat('7', 64)
  ) ->> 'status'),
  'approved',
  'a second distinct recovery manager approves a privileged target'
);
select is(
  (select count(*)::bigint from private.account_recovery_case_approvals approval
   where approval.recovery_case_id = (
     select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'
   )),
  2::bigint,
  'exactly two append-only approvals exist'
);

-- 27-33: execution is claimed, target-locked, finalized atomically, and retryable.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_prepare_account_recovery_execution(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'recovery-execute-prepare-01', repeat('8', 64)
  ) ->> 'status'),
  'executing',
  'a recent-AAL2 independent manager claims approved execution'
);
select ok(
  (select count(*)::bigint from private.account_recovery_execution_sessions execution_session
   where execution_session.recovery_case_id = (
     select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'
   )) = 2
  and (public.bff_prepare_account_recovery_execution(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    'recovery-execute-prepare-01', repeat('8', 64)
  ) ->> 'resumed')::boolean,
  'execution snapshots sessions and same-key retry resumes the current claim safely'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_finalize_account_recovery_execution(
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    '54900000-0000-4000-8000-000000000099',
    '51000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000005',
    '54000000-0000-4000-8000-000000000001'
  )$$,
  '42501',
  null,
  'a stale execution version cannot finalize factor deletion'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (public.bff_finalize_account_recovery_execution(
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    (select execution_version from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    '51000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000005',
    '54000000-0000-4000-8000-000000000001'
  ) ->> 'all_sessions_revoked')::boolean,
  'finalization atomically revokes the target session, binding, device, and push state'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select count(*)::bigint from auth.sessions session
   where session.user_id = '51000000-0000-4000-8000-000000000005'),
  0::bigint,
  'helpdesk factor reset leaves no Auth session active'
);
select is(
  (select count(*)::bigint from private.session_installations binding
   where binding.user_id = '51000000-0000-4000-8000-000000000005'
     and binding.revoked_at is null),
  0::bigint,
  'helpdesk factor reset leaves no installation binding active'
);
select is(
  (select count(*)::bigint from public.device_registrations device
   where device.user_id = '51000000-0000-4000-8000-000000000005'
     and device.revoked_at is null),
  0::bigint,
  'helpdesk factor reset leaves no push destination active'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (public.bff_finalize_account_recovery_execution(
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    (select execution_version from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000005'),
    '51000000-0000-4000-8000-000000000002',
    '51000000-0000-4000-8000-000000000005',
    '54000000-0000-4000-8000-000000000001'
  ) ->> 'already_completed')::boolean,
  'finalization is idempotent after the external factor side effect'
);

-- 34-36: immutable evidence and truthful external-policy status survive completion.
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$update private.account_recovery_case_events
    set metadata = '{"tampered":true}'::jsonb
    where recovery_case_id = (
      select id from private.account_recovery_cases
      where target_user_id = '51000000-0000-4000-8000-000000000005'
    )$$,
  '55000',
  'account recovery evidence is append-only',
  'case transition evidence cannot be rewritten'
);
select is(
  (select delivery_state from private.account_security_notices notice
   where notice.user_id = '51000000-0000-4000-8000-000000000005'
   order by notice.id desc limit 1),
  'pending_external_delivery',
  'factor reset never claims external notification delivery before a provider confirms it'
);
select ok(
  exists (
    select 1 from public.audit_events event
    where event.organization_id = '52000000-0000-4000-8000-000000000001'
      and event.event_type = 'account.factor_reset.completed'
      and event.target_id = (
        select id::text from private.account_recovery_cases
        where target_user_id = '51000000-0000-4000-8000-000000000005'
      )
  ),
  'completed factor reset is represented in the organization audit trail'
);

-- 38-42: one-active-case uniqueness, expiry, self query, and recent-auth admin query.
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_create_account_recovery_case(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000002',
    'totp', 'verified',
    'The personal authenticator device is permanently unavailable.',
    'ordinary-recovery-case-01', repeat('9', 64)
  ) ->> 'status'),
  'awaiting_external_verification',
  'a standard member can open one self-owned factor-reset case'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_create_account_recovery_case(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    '54000000-0000-4000-8000-000000000002',
    'totp', 'verified',
    'The personal authenticator device is permanently unavailable.',
    'ordinary-recovery-case-02', repeat('a', 64)
  )$$,
  '23505',
  'an active recovery case already exists for this member',
  'the partial unique index closes concurrent duplicate active cases'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update private.account_recovery_cases recovery_case
set created_at = now() - interval '25 hours',
    expires_at = now() - interval '1 hour'
where recovery_case.target_user_id = '51000000-0000-4000-8000-000000000001';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_record_account_recovery_verification(
    '51000000-0000-4000-8000-000000000003',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000004',
    (select id from private.account_recovery_cases
     where target_user_id = '51000000-0000-4000-8000-000000000001'),
    'manager_callback', repeat('b', 64),
    'ordinary-expiry-verify-01', repeat('b', 64)
  ) ->> 'status'),
  'expired',
  'an expired case cannot advance even with valid external evidence'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_list_account_recovery_cases(
    '51000000-0000-4000-8000-000000000001',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000001',
    false
  ) ->> 'scope'),
  'self',
  'an active bound member can query only their own recovery history'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update auth.sessions
set created_at = now() - interval '6 minutes'
where id = '51100000-0000-4000-8000-000000000003';
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_list_account_recovery_cases(
    '51000000-0000-4000-8000-000000000002',
    '52000000-0000-4000-8000-000000000001',
    '51100000-0000-4000-8000-000000000003',
    true
  )$$,
  '42501',
  'recent AAL2 recovery manager authorization required',
  'organization-wide case query fails closed after the recent-auth window'
);

select * from finish();
rollback;
