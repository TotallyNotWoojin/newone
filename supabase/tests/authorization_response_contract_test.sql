begin;
select plan(6);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at)
values (
  '81000000-0000-4000-8000-000000000001',
  'authorization-contract-owner@example.test',
  now()
);

insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values (
  '81100000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  now(),
  now(),
  'aal2'
);

insert into public.organizations (id, slug, name, created_by_user_id)
values (
  '82000000-0000-4000-8000-000000000001',
  'authorization-response-contract',
  'Authorization Response Contract',
  '81000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role, status)
values (
  '82000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  'owner',
  'active'
);

select lives_ok(
  $$select public.bff_bind_session_installation(
    '81000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001',
    '81200000-0000-4000-8000-000000000001',
    'web', '1.0.0', 'en-US', repeat('8', 64), 'desktop'
  )$$,
  'a real Auth session can be bound for authorization contract verification'
);

create temporary table authorization_result on commit drop as
select public.bff_authorize_request(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000001',
  'authorization.contract',
  true,
  900
) as value;

select is(
  (select (value ->> 'allowed')::boolean from authorization_result),
  true,
  'canonical authorization allows the active recent AAL2 session'
);

select is(
  (select value ->> 'role' from authorization_result),
  'owner',
  'canonical authorization returns the verified membership role required by Edge'
);

select is(
  (select value ->> 'membership_status' from authorization_result),
  'active',
  'canonical authorization returns the verified active membership status required by Edge'
);

select is(
  (select value ->> 'aal' from authorization_result),
  'aal2',
  'canonical authorization preserves the verified Auth assurance level'
);

select is(
  (select (value ->> 'revocation_generation')::bigint from authorization_result),
  0::bigint,
  'canonical authorization preserves the membership revocation generation'
);

select * from finish();
rollback;
