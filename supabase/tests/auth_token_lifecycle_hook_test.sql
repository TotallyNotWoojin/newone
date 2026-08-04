begin;
select plan(12);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('ab000000-0000-4000-8000-000000000001', 'auth-hook-owner@example.test', now()),
  ('ab000000-0000-4000-8000-000000000002', 'auth-hook-invite@example.test', now()),
  ('ab000000-0000-4000-8000-000000000003', 'auth-hook-outsider@example.test', now()),
  ('ab000000-0000-4000-8000-000000000004', 'auth-hook-revoked@example.test', now()),
  ('ab000000-0000-4000-8000-000000000005', 'auth-hook-member@example.test', now()),
  ('ab000000-0000-4000-8000-000000000006', 'auth-hook-sponsor@example.test', now()),
  ('ab000000-0000-4000-8000-000000000007', 'auth-hook-guest@example.test', now());

insert into public.organizations (
  id, slug, name, allow_external_guests, created_by_user_id
) values (
  'ab100000-0000-4000-8000-000000000001',
  'auth-token-hook-test', 'Auth token hook test', true,
  'ab000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (
  organization_id, user_id, role, status
) values
  (
    'ab100000-0000-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000001', 'owner', 'active'
  ),
  (
    'ab100000-0000-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000005', 'member', 'active'
  ),
  (
    'ab100000-0000-4000-8000-000000000001',
    'ab000000-0000-4000-8000-000000000006', 'member', 'active'
  );

insert into public.organization_invites (
  organization_id, email, destination_type, destination, invited_user_id,
  token_hash, role, expires_at, created_by_user_id
) values
  (
    'ab100000-0000-4000-8000-000000000001',
    'auth-hook-invite@example.test', 'email', 'auth-hook-invite@example.test',
    'ab000000-0000-4000-8000-000000000002', decode(repeat('a1', 32), 'hex'),
    'member', now() + interval '1 day', 'ab000000-0000-4000-8000-000000000001'
  ),
  (
    'ab100000-0000-4000-8000-000000000001',
    'auth-hook-revoked@example.test', 'email', 'auth-hook-revoked@example.test',
    'ab000000-0000-4000-8000-000000000004', decode(repeat('a2', 32), 'hex'),
    'member', now() + interval '1 day', 'ab000000-0000-4000-8000-000000000001'
  );

insert into public.organization_invites (
  organization_id, email, destination_type, destination, invited_user_id,
  token_hash, role, expires_at, created_by_user_id, membership_type,
  membership_access_expires_at, guest_sponsor_user_id
) values (
  'ab100000-0000-4000-8000-000000000001',
  'auth-hook-guest@example.test', 'email', 'auth-hook-guest@example.test',
  'ab000000-0000-4000-8000-000000000007', decode(repeat('a3', 32), 'hex'),
  'member', now() + interval '1 day', 'ab000000-0000-4000-8000-000000000001',
  'guest', now() + interval '5 days', 'ab000000-0000-4000-8000-000000000006'
);

update public.organization_invites
set revoked_at = now()
where invited_user_id = 'ab000000-0000-4000-8000-000000000004';

select ok(
  has_function_privilege(
    'supabase_auth_admin', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  ) and has_schema_privilege('supabase_auth_admin', 'public', 'usage'),
  'Supabase Auth can resolve and execute the lifecycle hook'
);
select ok(
  not has_function_privilege(
    'anon', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  ) and not has_function_privilege(
    'service_role', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  ),
  'Data API and application roles cannot invoke the Auth hook'
);

select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000001',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000001', 'role', 'authenticated')
  )) -> 'claims' ->> 'sub',
  'ab000000-0000-4000-8000-000000000001',
  'a current canonical member may receive a token'
);
select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000002',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000002', 'role', 'authenticated')
  )) -> 'claims' ->> 'sub',
  'ab000000-0000-4000-8000-000000000002',
  'the exact principal of a live invitation may authenticate before redemption'
);
select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000003',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000003', 'role', 'authenticated')
  )) #>> '{error,http_code}',
  '403',
  'an unrelated Auth principal is denied token issuance'
);
select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000004',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000004', 'role', 'authenticated')
  )) #>> '{error,http_code}',
  '403',
  'a revoked invitation cannot authorize token issuance'
);
select is(
  public.hook_newone_custom_access_token('{}'::jsonb) #>> '{error,http_code}',
  '403',
  'a malformed hook event fails closed'
);
select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000001',
    'claims', jsonb_build_object(
      'sub', 'ab000000-0000-4000-8000-000000000001',
      'role', 'authenticated', 'session_id', 'ab200000-0000-4000-8000-000000000001',
      'aal', 'aal2', 'custom', jsonb_build_object('preserved', true)
    )
  )) #>> '{claims,custom,preserved}',
  'true',
  'the hook preserves the complete GoTrue claim document'
);

select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000007',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000007', 'role', 'authenticated')
  )) -> 'claims' ->> 'sub',
  'ab000000-0000-4000-8000-000000000007',
  'a live guest invitation requires a current non-guest sponsor and enabled organization policy'
);

select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"ab000000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
update public.organization_memberships
set status = 'suspended', status_change_reason = 'Auth hook lifecycle fixture'
where organization_id = 'ab100000-0000-4000-8000-000000000001'
  and user_id in (
    'ab000000-0000-4000-8000-000000000005',
    'ab000000-0000-4000-8000-000000000006'
  );
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000005',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000005', 'role', 'authenticated')
  )) #>> '{error,http_code}',
  '403',
  'a suspended member cannot receive a new or refreshed token'
);

select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000007',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000007', 'role', 'authenticated')
  )) #>> '{error,http_code}',
  '403',
  'a guest invitation stops authorizing tokens when its sponsor is suspended'
);

select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', 'ab000000-0000-4000-8000-000000000002',
    'claims', jsonb_build_object('sub', 'ab000000-0000-4000-8000-000000000002', 'role', 'authenticated')
  )) #>> '{error,message}',
  null,
  'an allowed response never includes an error disclosure'
);

select * from finish();
rollback;
