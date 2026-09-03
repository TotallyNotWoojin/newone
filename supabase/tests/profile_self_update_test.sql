begin;
select plan(17);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: an actor with a bound session, a bystander with no session, one
-- workspace organization holding both, and gateway-assigned usernames.
insert into auth.users (id, email, email_confirmed_at) values
  ('99700000-0000-4000-8000-000000000001', 'profile-actor@example.test', now()),
  ('99700000-0000-4000-8000-000000000002', 'profile-bystander@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id
    when '99700000-0000-4000-8000-000000000001' then 'profile_actor'
    else 'profile_bystander'
  end,
  display_name = case user_id
    when '99700000-0000-4000-8000-000000000001' then 'Actor Original'
    else 'Bystander Original'
  end,
  status_message = case user_id
    when '99700000-0000-4000-8000-000000000001' then 'Original status'
    else 'Bystander status'
  end
where user_id in (
  '99700000-0000-4000-8000-000000000001',
  '99700000-0000-4000-8000-000000000002'
);
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('99710000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values (
  '99710000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001',
  '99720000-0000-4000-8000-000000000001', 'ios', decode(repeat('a1', 32), 'hex'), 'iphone'
);

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '99730000-0000-4000-8000-000000000001',
  'profile-self-update', 'Profile self update',
  '99700000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('99730000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', 'member'),
  ('99730000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000002', 'member');

-- 1: the surface is service-only at both layers.
select ok(
  has_function_privilege('service_role',
    'public.bff_update_profile(uuid,uuid,uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated',
    'public.bff_update_profile(uuid,uuid,uuid,text,text)', 'execute')
  and not has_function_privilege('anon',
    'public.bff_update_profile(uuid,uuid,uuid,text,text)', 'execute')
  and has_function_privilege('service_role',
    'private.bff_update_profile_impl(uuid,uuid,uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated',
    'private.bff_update_profile_impl(uuid,uuid,uuid,text,text)', 'execute')
  and not has_function_privilege('anon',
    'private.bff_update_profile_impl(uuid,uuid,uuid,text,text)', 'execute'),
  'profile self update is a service-only BFF capability'
);

-- 2-5: happy path trims the display name, stores the status message, returns
-- exactly the three self-service fields, and leaves the username alone.
select is(
  public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    '  Actor Renamed  ',
    '  On shift until six  '
  ),
  jsonb_build_object(
    'user_id', '99700000-0000-4000-8000-000000000001',
    'display_name', 'Actor Renamed',
    'status_message', 'On shift until six'
  ),
  'the receipt carries the trimmed display name and status message'
);

select is(
  (select array[display_name, status_message, username::text]
   from public.profiles
   where user_id = '99700000-0000-4000-8000-000000000001'),
  array['Actor Renamed', 'On shift until six', 'profile_actor'],
  'the actor profile row persists the rename with the username untouched'
);

select is(
  coalesce(current_setting('app.bff_service_context', true), 'off'),
  'off',
  'the service context does not leak past the command'
);

select is(
  (select display_name || '|' || status_message || '|' || username::text
   from public.profiles
   where user_id = '99700000-0000-4000-8000-000000000002'),
  'Bystander Original|Bystander status|profile_bystander',
  'another user''s profile is untouched by the actor''s update'
);

-- 6-7: a null or blank status clears the column; the 120/280 boundaries are
-- accepted exactly.
select is(
  public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    repeat('n', 120),
    '   '
  ) -> 'status_message',
  'null'::jsonb,
  'a blank status message clears the column and a 120-character name is accepted'
);

select is(
  char_length(public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    'Actor Renamed',
    repeat('s', 280)
  ) ->> 'status_message'),
  280,
  'a 280-character status message is accepted'
);

-- 8-11: bounds fail closed before any write.
select throws_ok(
  $$select public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    '   ', null
  )$$,
  '22023',
  'display name must be 1 to 120 characters',
  'a whitespace-only display name is rejected'
);

select throws_ok(
  $$select public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    null, null
  )$$,
  '22023',
  'display name must be 1 to 120 characters',
  'a null display name is rejected'
);

select throws_ok(
  format($$select public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    %L, null
  )$$, repeat('n', 121)),
  '22023',
  'display name must be 1 to 120 characters',
  'a 121-character display name is rejected'
);

select throws_ok(
  format($$select public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    'Actor Renamed', %L
  )$$, repeat('s', 281)),
  '22023',
  'status message must be at most 280 characters',
  'a 281-character status message is rejected'
);

select is(
  (select array[display_name, status_message]
   from public.profiles
   where user_id = '99700000-0000-4000-8000-000000000001'),
  array['Actor Renamed', repeat('s', 280)],
  'rejected updates leave the last accepted values in place'
);

-- 13-15: actor authorization is the same prelude every BFF command uses.
select throws_ok(
  $$select public.bff_update_profile(
    '99700000-0000-4000-8000-000000000002',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    'Stolen Name', null
  )$$,
  '42501',
  'request authorization denied',
  'a session bound to another user cannot rename that user'
);

select throws_ok(
  $$select public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '99710000-0000-4000-8000-000000000001',
    'Wrong Realm', null
  )$$,
  '42501',
  'request authorization denied',
  'an organization the actor does not belong to is refused'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99700000-0000-4000-8000-000000000001","session_id":"99710000-0000-4000-8000-000000000001","aal":"aal1"}',
  true);
select throws_ok(
  $$select public.bff_update_profile(
    '99700000-0000-4000-8000-000000000001',
    '99730000-0000-4000-8000-000000000001',
    '99710000-0000-4000-8000-000000000001',
    'Self Service', null
  )$$,
  '42501',
  'trusted BFF service role required',
  'an authenticated caller cannot invoke the service-only RPC directly'
);

-- 16-17: the username stays gateway-owned. The RPC exposes no username input
-- and the guard trigger still refuses a direct rewrite after the command ran.
select throws_ok(
  $$update public.profiles
    set username = 'stolen_handle'
    where user_id = '99700000-0000-4000-8000-000000000001'$$,
  '42501',
  'usernames change only through the trusted gateway',
  'the username guard keeps refusing direct rewrites'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select display_name || '|' || username::text
   from public.profiles
   where user_id = '99700000-0000-4000-8000-000000000002'),
  'Bystander Original|profile_bystander',
  'the bystander is still untouched after every attempt'
);

select * from finish();
rollback;
