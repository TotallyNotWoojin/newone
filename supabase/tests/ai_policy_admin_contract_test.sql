begin;
select plan(48);
select set_config('TimeZone', 'UTC', true);

select set_config('request.jwt.claims', '{"role":"service_role","aal":"aal2"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('c1000000-0000-4000-8000-000000000001', 'ai-policy-owner@example.test', now()),
  ('c1000000-0000-4000-8000-000000000002', 'ai-policy-admin@example.test', now());
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('c1100000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('c1100000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', now(), now(), 'aal2');
insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values
  (
    'c1100000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'c1150000-0000-4000-8000-000000000001',
    'web', decode(repeat('c1', 32), 'hex'), 'desktop'
  ),
  (
    'c1100000-0000-4000-8000-000000000002',
    'c1000000-0000-4000-8000-000000000002',
    'c1150000-0000-4000-8000-000000000002',
    'web', decode(repeat('c2', 32), 'hex'), 'desktop'
  );
insert into public.organizations (id, slug, name, created_by_user_id) values
  (
    'c1200000-0000-4000-8000-000000000001',
    'ai-policy-admin-contract', 'AI policy admin contract',
    'c1000000-0000-4000-8000-000000000001'
  ),
  (
    'c1200000-0000-4000-8000-000000000002',
    'ai-policy-legacy-enabled', 'Legacy enabled AI policy',
    'c1000000-0000-4000-8000-000000000001'
  ),
  (
    'c1200000-0000-4000-8000-000000000003',
    'ai-policy-legacy-revoked', 'Legacy revoked AI policy',
    'c1000000-0000-4000-8000-000000000001'
  );
insert into public.organization_memberships (organization_id, user_id, role) values
  ('c1200000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'owner'),
  ('c1200000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'member'),
  ('c1200000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'owner'),
  ('c1200000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'owner');
insert into public.organization_role_assignments (
  id, organization_id, user_id, role_name, scope_type,
  granted_by_user_id, grant_reason
) values (
  'c1300000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000002',
  'security_admin', 'organization',
  'c1000000-0000-4000-8000-000000000001',
  'Delegate AI policy administration for replay authorization testing.'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"c1000000-0000-4000-8000-000000000001","session_id":"c1100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_set_organization_ai_policy_v2(uuid,uuid,uuid,boolean,text[],text[],text,integer,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_set_organization_ai_policy_v2(uuid,uuid,uuid,boolean,text[],text[],text,integer,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'service_role',
    'public.bff_set_organization_ai_policy(uuid,uuid,uuid,boolean,text[],text[],text,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'service_role',
    'private.bff_set_organization_ai_policy_impl(uuid,uuid,uuid,boolean,text[],text[],text,text,text,text)',
    'execute'
  ),
  'only the CAS setter is callable by the BFF service role'
);
select ok(
  not has_table_privilege('authenticated', 'public.organization_ai_policies', 'select')
  and has_table_privilege('service_role', 'public.organization_ai_policies', 'select')
  and not has_table_privilege('service_role', 'public.organization_ai_policies', 'insert')
  and not has_table_privilege('service_role', 'public.organization_ai_policies', 'update')
  and not has_table_privilege('service_role', 'public.organization_ai_policies', 'delete')
  and not has_table_privilege('service_role', 'public.organization_ai_policies', 'truncate')
  and not has_table_privilege('authenticated', 'public.organization_ai_policies', 'insert')
  and not has_table_privilege('authenticated', 'public.organization_ai_policies', 'update')
  and not has_table_privilege('authenticated', 'public.organization_ai_policies', 'delete')
  and not has_table_privilege('authenticated', 'public.organization_ai_policies', 'truncate')
  and not has_table_privilege('anon', 'public.organization_ai_policies', 'insert')
  and not has_table_privilege('anon', 'public.organization_ai_policies', 'update')
  and not has_table_privilege('anon', 'public.organization_ai_policies', 'delete')
  and not has_table_privilege('anon', 'public.organization_ai_policies', 'truncate'),
  'AI policy rows are readable only for the service BFF and cannot be mutated directly by API roles'
);
select ok(
  not has_table_privilege('authenticated', 'public.organization_ai_policy_versions', 'select')
  and not has_table_privilege('service_role', 'public.organization_ai_policy_versions', 'select')
  and not has_table_privilege('service_role', 'public.organization_ai_policy_versions', 'insert')
  and not has_table_privilege('service_role', 'public.organization_ai_policy_versions', 'update')
  and not has_table_privilege('service_role', 'public.organization_ai_policy_versions', 'delete')
  and (
    select class.relrowsecurity and class.relforcerowsecurity
    from pg_catalog.pg_class class
    join pg_catalog.pg_namespace namespace on namespace.oid = class.relnamespace
    where namespace.nspname = 'public'
      and class.relname = 'organization_ai_policy_versions'
  ),
  'immutable AI policy history has forced RLS and no direct client or service access'
);
select ok(
  not has_function_privilege(
    'service_role',
    'private.backfill_organization_ai_policy_history()',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'private.backfill_organization_ai_policy_history()',
    'execute'
  ),
  'the one-time history backfill helper is not an application execution surface'
);

insert into public.organization_ai_policies (
  organization_id, enabled, policy_version, approved_use_cases,
  provider_allowlist, route_policy, approved_by_user_id, approved_at,
  revoked_by_user_id, revoked_at, revocation_reason, updated_at
) values
  (
    'c1200000-0000-4000-8000-000000000002', true, 7,
    array['summary', 'translation'], array['google-vertex/us-south1'],
    'approved_zero_retention', 'c1000000-0000-4000-8000-000000000001',
    '2026-07-31 12:34:56+00', null, null, null, '2026-08-01 01:02:03+00'
  ),
  (
    'c1200000-0000-4000-8000-000000000003', false, 4,
    array[]::text[], array[]::text[], 'deny', null, null,
    'c1000000-0000-4000-8000-000000000001', '2026-07-30 09:08:07+00',
    'Legacy revocation reason retained exactly.', '2026-07-30 10:11:12+00'
  );

set local role service_role;
select throws_ok(
  $$update public.organization_ai_policies
    set enabled = false
    where organization_id = 'c1200000-0000-4000-8000-000000000002'$$,
  '42501', 'permission denied for table organization_ai_policies',
  'service role direct AI-policy DML is denied instead of bypassing the CAS command'
);
reset role;

select is(
  private.backfill_organization_ai_policy_history(),
  2,
  'the legacy backfill records each current policy missing immutable history'
);
select ok(
  exists (
    select 1
    from public.organization_ai_policy_versions history
    where history.organization_id = 'c1200000-0000-4000-8000-000000000002'
      and history.policy_version = 7
      and history.enabled
      and history.approved_use_cases = array['summary', 'translation']::text[]
      and history.provider_allowlist = array['google-vertex/us-south1']::text[]
      and history.route_policy = 'approved_zero_retention'
      and history.changed_by_user_id = 'c1000000-0000-4000-8000-000000000001'
      and history.changed_at = '2026-07-31 12:34:56+00'::timestamptz
      and history.change_reason =
        'Legacy current-policy snapshot backfilled; original approval reason was not retained.'
  ),
  'enabled legacy history is an exact current-policy snapshot with honest missing-reason disclosure'
);
select ok(
  exists (
    select 1
    from public.organization_ai_policy_versions history
    where history.organization_id = 'c1200000-0000-4000-8000-000000000003'
      and history.policy_version = 4
      and not history.enabled
      and history.approved_use_cases = array[]::text[]
      and history.provider_allowlist = array[]::text[]
      and history.route_policy = 'deny'
      and history.changed_by_user_id = 'c1000000-0000-4000-8000-000000000001'
      and history.changed_at = '2026-07-30 09:08:07+00'::timestamptz
      and history.change_reason =
        'Legacy current-policy snapshot backfilled: Legacy revocation reason retained exactly.'
  ),
  'revoked legacy history preserves the exact deny snapshot, actor, timestamp, and reason'
);
select ok(
  exists (
    select 1
    from public.organization_ai_policy_versions history
    where history.organization_id = 'c1200000-0000-4000-8000-000000000002'
      and history.provenance @> jsonb_build_object(
        'source', 'legacy_current_policy_backfill',
        'migration', '20260804173100_harden_ai_policy_authority_history',
        'request_sha256_semantics', 'canonical_current_policy_snapshot_sha256_v1',
        'original_request_sha256_available', false,
        'current_policy_updated_at', '2026-08-01 01:02:03+00'::timestamptz,
        'original_approved_by_user_id', 'c1000000-0000-4000-8000-000000000001'::uuid,
        'original_approved_at', '2026-07-31 12:34:56+00'::timestamptz
      )
      and not history.provenance ? 'original_revoked_by_user_id'
  )
  and exists (
    select 1
    from public.organization_ai_policy_versions history
    where history.organization_id = 'c1200000-0000-4000-8000-000000000003'
      and history.provenance @> jsonb_build_object(
        'source', 'legacy_current_policy_backfill',
        'request_sha256_semantics', 'canonical_current_policy_snapshot_sha256_v1',
        'original_request_sha256_available', false,
        'original_revoked_by_user_id', 'c1000000-0000-4000-8000-000000000001'::uuid,
        'original_revoked_at', '2026-07-30 09:08:07+00'::timestamptz,
        'original_revocation_reason', 'Legacy revocation reason retained exactly.'
      )
      and not history.provenance ? 'original_approved_by_user_id'
  ),
  'backfilled rows explicitly distinguish recovered legacy provenance from command receipts'
);
select ok(
  not exists (
    select 1
    from public.organization_ai_policies policy
    join public.organization_ai_policy_versions history
      on history.organization_id = policy.organization_id
     and history.policy_version = policy.policy_version
    where policy.organization_id in (
      'c1200000-0000-4000-8000-000000000002',
      'c1200000-0000-4000-8000-000000000003'
    )
      and history.request_sha256 <> encode(extensions.digest(convert_to(jsonb_build_object(
        'format', 'newone_ai_policy_current_snapshot_v1',
        'organization_id', policy.organization_id,
        'policy_version', policy.policy_version,
        'enabled', policy.enabled,
        'approved_use_cases', to_jsonb(policy.approved_use_cases),
        'provider_allowlist', to_jsonb(policy.provider_allowlist),
        'route_policy', policy.route_policy,
        'approved_by_user_id', policy.approved_by_user_id,
        'approved_at', policy.approved_at,
        'revoked_by_user_id', policy.revoked_by_user_id,
        'revoked_at', policy.revoked_at,
        'revocation_reason', policy.revocation_reason,
        'updated_at', policy.updated_at
      )::text, 'UTF8'), 'sha256'), 'hex')
  ),
  'legacy request-hash fields are deterministic fingerprints of the exact recovered current rows'
);
select ok(
  private.backfill_organization_ai_policy_history() = 0
  and (
    select count(*) = 2
    from public.organization_ai_policy_versions history
    where history.organization_id in (
      'c1200000-0000-4000-8000-000000000002',
      'c1200000-0000-4000-8000-000000000003'
    )
  ),
  're-running the backfill is idempotent and cannot duplicate immutable snapshots'
);

select is(
  public.bff_get_organization_ai_policy(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001'
  ) ->> 'policy_version',
  '0',
  'an organization without a policy reads as version zero and denied'
);

create temporary table first_ai_policy on commit drop as
select public.bff_set_organization_ai_policy_v2(
  'c1000000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-000000000001',
  'c1100000-0000-4000-8000-000000000001',
  true,
  array['translation', 'summary'],
  array['google-vertex/us-south1'],
  'approved_zero_retention',
  0,
  'Approve the reviewed zero-retention route.',
  'ai-policy-create-0001', repeat('1', 64)
) as receipt;

select is(
  (select (receipt ->> 'policy_version')::integer from first_ai_policy),
  1,
  'the initial approval advances exactly from version zero to one'
);
select is(
  (select receipt -> 'provider_allowlist' from first_ai_policy),
  '["google-vertex/us-south1"]'::jsonb,
  'the pinned slash-delimited provider route is accepted exactly'
);
select is(
  (public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',
    true, array['translation', 'summary'], array['google-vertex/us-south1'],
    'approved_zero_retention', 0, 'Approve the reviewed zero-retention route.',
    'ai-policy-create-0001', repeat('1', 64)
  ) ->> 'policy_version')::integer,
  1,
  'an exact idempotent replay returns the original version'
);
select is(
  (
    select jsonb_build_object(
      'version', policy_version,
      'enabled', enabled,
      'use_cases', to_jsonb(approved_use_cases),
      'providers', to_jsonb(provider_allowlist),
      'route', route_policy,
      'actor', changed_by_user_id,
      'reason', change_reason,
      'request_sha256', request_sha256,
      'provenance', provenance
    )
    from public.organization_ai_policy_versions
    where organization_id = 'c1200000-0000-4000-8000-000000000001'
      and policy_version = 1
  ),
  jsonb_build_object(
    'version', 1,
    'enabled', true,
    'use_cases', '["summary", "translation"]'::jsonb,
    'providers', '["google-vertex/us-south1"]'::jsonb,
    'route', 'approved_zero_retention',
    'actor', 'c1000000-0000-4000-8000-000000000001'::uuid,
    'reason', 'Approve the reviewed zero-retention route.',
    'request_sha256', repeat('1', 64),
    'provenance', jsonb_build_object(
      'source', 'bff_v2_command',
      'request_sha256_semantics', 'client_request_body_sha256'
    )
  ),
  'the initial policy history row preserves the exact normalized decision, reason, actor, and request hash'
);
select is(
  (select count(*)::integer from public.organization_ai_policy_versions
   where organization_id = 'c1200000-0000-4000-8000-000000000001'),
  1,
  'an idempotent replay cannot append a duplicate policy-history version'
);

select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],
    array['google-vertex/us-south1'],'approved_zero_retention',0,'Stale approval.',
    'ai-policy-stale-0002',repeat('2',64))$$,
  '40001', 'organization AI policy version conflict',
  'a stale expected version cannot overwrite the current policy'
);

select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,null,
    array['google-vertex/us-south1'],'approved_zero_retention',1,'Null use cases.',
    'ai-policy-null-use-cases',repeat('3',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'enabled policy rejects a NULL use-case array'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],null,
    'approved_zero_retention',1,'Null providers.',
    'ai-policy-null-providers',repeat('4',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'enabled policy rejects a NULL provider array'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],
    array['google-vertex/us-south1'],null,1,'Null route.',
    'ai-policy-null-route',repeat('5',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'enabled policy rejects a NULL route policy'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array[null]::text[],
    array['google-vertex/us-south1'],'approved_zero_retention',1,'Null use-case item.',
    'ai-policy-null-use-case-item',repeat('b',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'enabled policy rejects a NULL use-case element'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],
    array[null]::text[],'approved_zero_retention',1,'Null provider item.',
    'ai-policy-null-provider-item',repeat('c',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'enabled policy rejects a NULL provider element'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',null,array['translation'],
    array['google-vertex/us-south1'],'approved_zero_retention',1,'Null enabled flag.',
    'ai-policy-null-enabled',repeat('d',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'policy mutation rejects a NULL enabled flag'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],
    array['Google-Vertex/us-south1'],'approved_zero_retention',1,'Uppercase route.',
    'ai-policy-uppercase-route',repeat('6',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'provider routes reject uppercase characters instead of silently normalizing'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],
    array['google vertex/us-south1'],'approved_zero_retention',1,'Spaced route.',
    'ai-policy-space-route',repeat('7',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'provider routes reject whitespace'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],
    array['a' || repeat('x',160)],'approved_zero_retention',1,'Overlong route.',
    'ai-policy-overlong-route',repeat('8',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'provider routes reject values longer than 160 characters'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',true,array['translation'],
    array['/google-vertex'],'approved_zero_retention',1,'Malformed route.',
    'ai-policy-malformed-route',repeat('9',64))$$,
  '42501', 'authorized valid tenant AI policy required',
  'provider routes must begin with an alphanumeric character'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001','c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',false,array['translation'],
    array['google-vertex/us-south1'],'deny',1,'Malformed disable request.',
    'ai-policy-disable-with-authority',repeat('91',32))$$,
  '42501', 'authorized valid tenant AI policy required',
  'disabled policy requests reject stale use-case or provider authority instead of silently normalizing it'
);

select is(
  (select policy_version from public.organization_ai_policies
   where organization_id = 'c1200000-0000-4000-8000-000000000001'),
  1,
  'rejected inputs leave the committed policy version unchanged'
);
select is(
  (select provider_allowlist from public.organization_ai_policies
   where organization_id = 'c1200000-0000-4000-8000-000000000001'),
  array['google-vertex/us-south1']::text[],
  'rejected inputs cannot partially change the provider allowlist'
);
select is(
  (select count(*)::integer from public.organization_ai_policy_versions
   where organization_id = 'c1200000-0000-4000-8000-000000000001'),
  1,
  'rejected policy mutations cannot append audit-history evidence'
);

create temporary table denied_ai_policy on commit drop as
select public.bff_set_organization_ai_policy_v2(
  'c1000000-0000-4000-8000-000000000001',
  'c1200000-0000-4000-8000-000000000001',
  'c1100000-0000-4000-8000-000000000001',
  false, array[]::text[], array[]::text[], 'deny', 1,
  'Revoke AI egress while ordinary messaging remains available.',
  'ai-policy-revoke-0010', repeat('a', 64)
) as receipt;
select is(
  (select (receipt ->> 'policy_version')::integer from denied_ai_policy),
  2,
  'an exact revocation advances the policy version once'
);
select ok(
  exists (
    select 1
    from public.organization_ai_policy_versions history
    where history.organization_id = 'c1200000-0000-4000-8000-000000000001'
      and history.policy_version = 2
      and not history.enabled
      and history.approved_use_cases = array[]::text[]
      and history.provider_allowlist = array[]::text[]
      and history.route_policy = 'deny'
      and history.change_reason = 'Revoke AI egress while ordinary messaging remains available.'
      and history.request_sha256 = repeat('a', 64)
      and history.provenance @> jsonb_build_object(
        'source', 'bff_v2_command',
        'request_sha256_semantics', 'client_request_body_sha256'
      )
  ),
  'revocation appends an exact deny snapshot instead of mutating earlier approval evidence'
);
select is(
  public.bff_get_organization_ai_policy(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001'
  ) ->> 'route_policy',
  'deny',
  'the privileged read contract returns the authoritative revoked policy'
);
select is(
  public.bff_get_organization_ai_policy(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001'
  ) -> 'approved_use_cases',
  '[]'::jsonb,
  'revocation clears approved use cases instead of retaining stale egress authority'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"c1000000-0000-4000-8000-000000000002","session_id":"c1100000-0000-4000-8000-000000000002","aal":"aal2"}',
  true
);
select is(
  (public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000002',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000002',
    true, array['translation'], array['google-vertex/us-south1'],
    'approved_zero_retention', 2, 'Reapprove the reviewed route.',
    'ai-policy-delegated-replay', repeat('e', 64)
  ) ->> 'policy_version')::integer,
  3,
  'a currently authorized delegated security administrator can commit a CAS update'
);
select ok(
  (select count(*) = 3 from public.organization_ai_policy_versions
   where organization_id = 'c1200000-0000-4000-8000-000000000001')
  and exists (
    select 1 from public.organization_ai_policy_versions
    where organization_id = 'c1200000-0000-4000-8000-000000000001'
      and policy_version = 3
      and changed_by_user_id = 'c1000000-0000-4000-8000-000000000002'
      and change_reason = 'Reapprove the reviewed route.'
      and request_sha256 = repeat('e', 64)
  ),
  'delegated policy administration appends a separately attributable history version'
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"c1000000-0000-4000-8000-000000000001","session_id":"c1100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
select lives_ok(
  $$select public.bff_revoke_role_assignment(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',
    'c1300000-0000-4000-8000-000000000001',
    'End delegated AI policy administration.',
    'ai-policy-role-revoke', repeat('f', 64)
  )$$,
  'the organization owner can revoke the delegated AI policy role'
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"c1000000-0000-4000-8000-000000000002","session_id":"c1100000-0000-4000-8000-000000000002","aal":"aal2"}',
  true
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000002',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000002',
    true, array['translation'], array['google-vertex/us-south1'],
    'approved_zero_retention', 2, 'Reapprove the reviewed route.',
    'ai-policy-delegated-replay', repeat('e', 64)
  )$$,
  '42501', 'AI policy management permission required',
  'a role-revoked administrator cannot replay an old privileged receipt'
);

update auth.sessions
set created_at = now() - interval '30 minutes'
where id = 'c1100000-0000-4000-8000-000000000001';
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"c1000000-0000-4000-8000-000000000001","session_id":"c1100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
select is(
  public.bff_get_organization_ai_policy(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001'
  ) ->> 'policy_version',
  '3',
  'a current AAL2 policy manager can recover authoritative policy state without a fixed read-freshness window'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',
    true, array['translation', 'summary'], array['google-vertex/us-south1'],
    'approved_zero_retention', 0,
    'Approve the reviewed zero-retention route.',
    'ai-policy-create-0001', repeat('1', 64)
  )$$,
  '42501', 'request authorization denied',
  'an older AAL2 session cannot replay a formerly authorized enable receipt'
);
select is(
  (public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',
    false, array[]::text[], array[]::text[], 'deny', 3,
    'Revoke AI egress from an older current AAL2 session.',
    'ai-policy-old-aal2-revoke', repeat('1a', 32)
  ) ->> 'policy_version')::integer,
  4,
  'revocation remains available to a current AAL2 policy manager after five minutes'
);
select ok(
  (select array_agg(policy_version order by policy_version) = array[1,2,3,4]
   from public.organization_ai_policy_versions
   where organization_id = 'c1200000-0000-4000-8000-000000000001')
  and exists (
    select 1 from public.organization_ai_policy_versions
    where organization_id = 'c1200000-0000-4000-8000-000000000001'
      and policy_version = 4
      and route_policy = 'deny'
      and change_reason = 'Revoke AI egress from an older current AAL2 session.'
      and request_sha256 = repeat('1a', 32)
  ),
  'all committed AI policy decisions remain as a gap-free immutable version sequence'
);
select ok(
  (select count(*) = 4 from public.audit_events
   where organization_id = 'c1200000-0000-4000-8000-000000000001'
     and event_type in ('organization.ai_policy.enabled', 'organization.ai_policy.revoked'))
  and exists (
    select 1 from public.audit_events
    where organization_id = 'c1200000-0000-4000-8000-000000000001'
      and event_type = 'organization.ai_policy.revoked'
      and metadata @> jsonb_build_object(
        'policy_version', 4,
        'enabled', false,
        'approved_use_cases', '[]'::jsonb,
        'provider_allowlist', '[]'::jsonb,
        'route_policy', 'deny',
        'reason', 'Revoke AI egress from an older current AAL2 session.',
        'request_sha256', repeat('1a', 32)
      )
  ),
  'each committed policy version emits an explicit reason-bearing audit event'
);
select throws_ok(
  $$update public.organization_ai_policy_versions
    set change_reason = 'Tampered history.'
    where organization_id = 'c1200000-0000-4000-8000-000000000001'
      and policy_version = 1$$,
  '55000', 'organization AI policy versions are immutable',
  'AI policy history rows reject updates even from the migration-owner test role'
);
select throws_ok(
  $$delete from public.organization_ai_policy_versions
    where organization_id = 'c1200000-0000-4000-8000-000000000001'
      and policy_version = 1$$,
  '55000', 'organization AI policy versions are immutable',
  'AI policy history rows reject deletion even from the migration-owner test role'
);
select throws_ok(
  $$select public.bff_set_organization_ai_policy_v2(
    'c1000000-0000-4000-8000-000000000001',
    'c1200000-0000-4000-8000-000000000001',
    'c1100000-0000-4000-8000-000000000001',
    true, array['translation'], array['google-vertex/us-south1'],
    'approved_zero_retention', 4,
    'Attempt enable from an older AAL2 session.',
    'ai-policy-old-aal2-enable', repeat('1b', 32)
  )$$,
  '42501', 'request authorization denied',
  'enabling requires a server-verified login no more than five minutes old'
);

select * from finish();
rollback;
