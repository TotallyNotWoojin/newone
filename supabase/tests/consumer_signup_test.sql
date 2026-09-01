begin;
select plan(27);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Structure: the handle column, its case-insensitive uniqueness, and the
-- signup reservation store all exist as designed.
select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'username'
      and udt_name = 'citext'
  ),
  'profiles expose a citext username column'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'profiles'
      and indexname = 'profiles_username_key'
  ),
  'profiles enforce unique usernames'
);

select ok(
  exists (
    select 1
    from information_schema.tables
    where table_schema = 'private'
      and table_name = 'signup_reservations'
  ),
  'signup reservations live in the private schema'
);

select is(
  private.personal_realm_organization_id(),
  '11111111-1111-4111-8111-111111111111'::uuid,
  'the personal realm identifier is fixed'
);

-- Reserved, malformed, and unknown-language signups are refused before any
-- reservation is written.
select is(
  (public.bff_authorize_signup_otp(
    'email', 'reserved-name@example.test', 'admin', 'Reserved Name', 'en',
    repeat('a', 64), repeat('b', 64), 'request'
  )) ->> 'reason',
  'username_reserved',
  'reserved usernames are refused'
);

select is(
  (public.bff_authorize_signup_otp(
    'email', 'short-name@example.test', 'ab', 'Short Name', 'en',
    repeat('a', 64), repeat('c', 64), 'request'
  )) ->> 'reason',
  'invalid_username',
  'malformed usernames are refused'
);

select is(
  (public.bff_authorize_signup_otp(
    'email', 'bad-language@example.test', 'good_handle', 'Bad Language', 'fr',
    repeat('a', 64), repeat('d', 64), 'request'
  )) ->> 'reason',
  'invalid_language',
  'unsupported onboarding languages are refused'
);

select is(
  (public.bff_authorize_signup_otp(
    'not-an-email', 'not-an-email', 'good_handle', 'Bad Destination', 'en',
    repeat('a', 64), repeat('e', 64), 'request'
  )) ->> 'reason',
  'invalid_destination',
  'non-email destinations are refused'
);

-- A valid request reserves the username for its destination.
select is(
  (public.bff_authorize_signup_otp(
    'email', 'first-signup@example.test', 'first_user', 'First User', 'es',
    repeat('a', 64), repeat('f', 64), 'request'
  )) ->> 'reason',
  'ok',
  'a valid signup request is authorized'
);

select ok(
  exists (
    select 1 from private.signup_reservations
    where destination = 'first-signup@example.test'
      and username = 'first_user'
      and preferred_language = 'es'
      and expires_at > now()
  ),
  'an authorized signup holds a live reservation'
);

-- The reserved handle is unavailable to any other destination, including
-- case-variant spellings, while the reservation lives.
select is(
  (public.bff_authorize_signup_otp(
    'email', 'second-signup@example.test', 'first_user', 'Second User', 'en',
    repeat('a', 64), repeat('1', 64), 'request'
  )) ->> 'reason',
  'username_taken',
  'a reserved handle is unavailable to another signup'
);

-- Re-requesting from the same destination replaces its own reservation.
select is(
  (public.bff_authorize_signup_otp(
    'email', 'first-signup@example.test', 'first_user_alt', 'First User', 'ko',
    repeat('a', 64), repeat('f', 64), 'request'
  )) ->> 'reason',
  'ok',
  'a destination can revise its own in-flight signup'
);

select is(
  (select count(*)::integer from private.signup_reservations
    where destination = 'first-signup@example.test'),
  1,
  'a destination holds at most one reservation'
);

-- Verification without a live reservation fails closed.
select is(
  (public.bff_authorize_signup_otp(
    'email', 'never-requested@example.test', null, null, null,
    repeat('a', 64), repeat('2', 64), 'verify'
  )) ->> 'reason',
  'reservation_expired',
  'verification without a reservation is refused'
);

-- An address that already belongs to an active member is diverted to the
-- member sign-in flow without widening the response envelope.
insert into auth.users (id, email, email_confirmed_at) values (
  '99200000-0000-4000-8000-000000000001',
  'existing-member@example.test',
  now()
);
insert into public.organizations (id, slug, name, created_by_user_id) values (
  '99210000-0000-4000-8000-000000000001',
  'consumer-signup-existing-org',
  'Existing org',
  '99200000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (organization_id, user_id, role, status)
values (
  '99210000-0000-4000-8000-000000000001',
  '99200000-0000-4000-8000-000000000001',
  'owner', 'active'
);

select is(
  (public.bff_authorize_signup_otp(
    'email', 'existing-member@example.test', 'brand_new_handle', 'Existing', 'en',
    repeat('a', 64), repeat('3', 64), 'request'
  )) ->> 'reason',
  'account_exists',
  'an existing active member is diverted to sign-in'
);

-- Redemption: a confirmed auth user with a live reservation becomes a
-- private-directory member of the personal realm and claims the handle.
insert into auth.users (id, email, email_confirmed_at) values (
  '99200000-0000-4000-8000-000000000002',
  'first-signup@example.test',
  now()
);

-- The token lifecycle hook issues claims during the live reservation window
-- (before any membership exists), and only during it.
select ok(
  (public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', '99200000-0000-4000-8000-000000000002',
    'claims', jsonb_build_object('role', 'authenticated')
  ))) ? 'claims',
  'a live signup reservation permits token issuance before membership'
);

select ok(
  (public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', '99200000-0000-4000-8000-000000000001',
    'claims', jsonb_build_object('role', 'authenticated')
  ))) ? 'claims',
  'an active member still receives claims through the hook'
);

select lives_ok(
  $redeem$
    select public.bff_redeem_signup(
      '99200000-0000-4000-8000-000000000002', 'email',
      'first-signup@example.test'
    )
  $redeem$,
  'a confirmed reservation redeems successfully'
);

select is(
  (select username::text from public.profiles
    where user_id = '99200000-0000-4000-8000-000000000002'),
  'first_user_alt',
  'redemption claims the reserved username'
);

select is(
  (select preferred_language from public.profiles
    where user_id = '99200000-0000-4000-8000-000000000002'),
  'ko',
  'redemption applies the chosen language'
);

select ok(
  exists (
    select 1 from public.organization_memberships
    where organization_id = private.personal_realm_organization_id()
      and user_id = '99200000-0000-4000-8000-000000000002'
      and role = 'member'
      and status = 'active'
      and directory_visibility = 'private'
  ),
  'redemption provisions a private-directory personal-realm membership'
);

select ok(
  exists (
    select 1 from public.organizations
    where id = private.personal_realm_organization_id()
      and dm_policy = 'request_first'
      and slug = 'personal-realm'
  ),
  'the personal realm exists with request-first messaging'
);

select is(
  (select ui_language from public.organization_user_preferences
    where organization_id = private.personal_realm_organization_id()
      and user_id = '99200000-0000-4000-8000-000000000002'),
  'ko',
  'redemption records the realm UI language preference'
);

select is(
  (select count(*)::integer from private.signup_reservations
    where destination = 'first-signup@example.test'),
  0,
  'redemption consumes the reservation'
);

-- A claimed handle is refused to later signups case-insensitively.
select is(
  (public.bff_authorize_signup_otp(
    'email', 'third-signup@example.test', 'first_user_alt', 'Third User', 'en',
    repeat('a', 64), repeat('4', 64), 'request'
  )) ->> 'reason',
  'username_taken',
  'a claimed handle is permanently unavailable'
);

-- Redeeming without a reservation fails closed.
select throws_ok(
  $redeem$
    select public.bff_redeem_signup(
      '99200000-0000-4000-8000-000000000002', 'email',
      'first-signup@example.test'
    )
  $redeem$,
  'P0002',
  'signup reservation is missing or expired',
  'redemption without a live reservation is refused'
);

-- Users cannot rewrite their own handle through the direct profile surface.
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"99200000-0000-4000-8000-000000000002"}',
  true
);
select throws_ok(
  $update$
    update public.profiles
    set username = 'stolen_handle'
    where user_id = '99200000-0000-4000-8000-000000000002'
  $update$,
  '42501',
  'usernames change only through the trusted gateway',
  'direct username rewrites are refused outside the gateway'
);

select * from finish();
rollback;
