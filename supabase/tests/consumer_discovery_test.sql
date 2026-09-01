begin;
select plan(35);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: the personal realm, one workspace organization, and consumer
-- accounts wired the way open signup provisions them (active member,
-- private directory visibility, unique lowercase username).
insert into auth.users (id, email, email_confirmed_at) values
  ('99500000-0000-4000-8000-000000000001', 'discovery-actor@example.test', now()),
  ('99500000-0000-4000-8000-000000000002', 'discovery-bob@example.test', now()),
  ('99500000-0000-4000-8000-000000000003', 'discovery-carol@example.test', now()),
  ('99500000-0000-4000-8000-000000000004', 'discovery-dave@example.test', now()),
  ('99500000-0000-4000-8000-000000000005', 'discovery-erin@example.test', now()),
  ('99500000-0000-4000-8000-000000000006', 'discovery-frank@example.test', now()),
  ('99500000-0000-4000-8000-000000000007', 'discovery-grace@example.test', now()),
  ('99500000-0000-4000-8000-000000000008', 'discovery-nohandle@example.test', now()),
  ('99500000-0000-4000-8000-000000000009', 'discovery-iris@example.test', now()),
  ('99500000-0000-4000-8000-000000000010', 'discovery-yara@example.test', now()),
  ('99500000-0000-4000-8000-000000000011', 'discovery-zed@example.test', now()),
  ('99500000-0000-4000-8000-000000000012', 'discovery-work@example.test', now()),
  ('99500000-0000-4000-8000-000000000013', 'discovery-xena@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id
    when '99500000-0000-4000-8000-000000000001' then 'search_actor'
    when '99500000-0000-4000-8000-000000000002' then 'ali_bob'
    when '99500000-0000-4000-8000-000000000003' then 'ali_carol'
    when '99500000-0000-4000-8000-000000000004' then 'ali_dave'
    when '99500000-0000-4000-8000-000000000005' then 'ali_erin'
    when '99500000-0000-4000-8000-000000000006' then 'ali_frank'
    when '99500000-0000-4000-8000-000000000007' then 'ali_grace'
    when '99500000-0000-4000-8000-000000000008' then null
    when '99500000-0000-4000-8000-000000000009' then 'ali_iris'
    when '99500000-0000-4000-8000-000000000010' then 'group_yara'
    when '99500000-0000-4000-8000-000000000011' then 'zed_stranger'
    when '99500000-0000-4000-8000-000000000012' then 'work_target'
    else 'distant_xena'
  end,
  display_name = case user_id
    when '99500000-0000-4000-8000-000000000001' then 'Actor Alice'
    when '99500000-0000-4000-8000-000000000002' then 'Bob Park'
    when '99500000-0000-4000-8000-000000000003' then 'Carol Song'
    when '99500000-0000-4000-8000-000000000004' then 'Dave Choi'
    when '99500000-0000-4000-8000-000000000005' then 'Erin Waters'
    when '99500000-0000-4000-8000-000000000006' then 'Frank Blocked'
    when '99500000-0000-4000-8000-000000000007' then 'Grace Blocker'
    when '99500000-0000-4000-8000-000000000008' then 'No Handle'
    when '99500000-0000-4000-8000-000000000009' then 'Iris Stone'
    when '99500000-0000-4000-8000-000000000010' then 'Yara Group'
    when '99500000-0000-4000-8000-000000000011' then 'Zed Stranger'
    when '99500000-0000-4000-8000-000000000012' then 'Work Target'
    else 'Xena Distant'
  end
where user_id in (
  '99500000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000002',
  '99500000-0000-4000-8000-000000000003',
  '99500000-0000-4000-8000-000000000004',
  '99500000-0000-4000-8000-000000000005',
  '99500000-0000-4000-8000-000000000006',
  '99500000-0000-4000-8000-000000000007',
  '99500000-0000-4000-8000-000000000008',
  '99500000-0000-4000-8000-000000000009',
  '99500000-0000-4000-8000-000000000010',
  '99500000-0000-4000-8000-000000000011',
  '99500000-0000-4000-8000-000000000012',
  '99500000-0000-4000-8000-000000000013'
);
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('99510000-0000-4000-8000-000000000001', '99500000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('99510000-0000-4000-8000-000000000002', '99500000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('99510000-0000-4000-8000-000000000003', '99500000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('99510000-0000-4000-8000-000000000004', '99500000-0000-4000-8000-000000000004', now(), now(), 'aal1'),
  ('99510000-0000-4000-8000-000000000005', '99500000-0000-4000-8000-000000000005', now(), now(), 'aal1'),
  ('99510000-0000-4000-8000-000000000007', '99500000-0000-4000-8000-000000000007', now(), now(), 'aal1'),
  ('99510000-0000-4000-8000-000000000009', '99500000-0000-4000-8000-000000000009', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values
  ('99510000-0000-4000-8000-000000000001', '99500000-0000-4000-8000-000000000001', '99520000-0000-4000-8000-000000000001', 'ios', decode(repeat('91', 32), 'hex'), 'iphone'),
  ('99510000-0000-4000-8000-000000000002', '99500000-0000-4000-8000-000000000002', '99520000-0000-4000-8000-000000000002', 'ios', decode(repeat('92', 32), 'hex'), 'iphone'),
  ('99510000-0000-4000-8000-000000000003', '99500000-0000-4000-8000-000000000003', '99520000-0000-4000-8000-000000000003', 'web', decode(repeat('93', 32), 'hex'), 'desktop'),
  ('99510000-0000-4000-8000-000000000004', '99500000-0000-4000-8000-000000000004', '99520000-0000-4000-8000-000000000004', 'web', decode(repeat('94', 32), 'hex'), 'desktop'),
  ('99510000-0000-4000-8000-000000000005', '99500000-0000-4000-8000-000000000005', '99520000-0000-4000-8000-000000000005', 'android', decode(repeat('96', 32), 'hex'), 'android'),
  ('99510000-0000-4000-8000-000000000007', '99500000-0000-4000-8000-000000000007', '99520000-0000-4000-8000-000000000007', 'android', decode(repeat('97', 32), 'hex'), 'android'),
  ('99510000-0000-4000-8000-000000000009', '99500000-0000-4000-8000-000000000009', '99520000-0000-4000-8000-000000000009', 'web', decode(repeat('98', 32), 'hex'), 'desktop');

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, '99500000-0000-4000-8000-000000000001'
);

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '99530000-0000-4000-8000-000000000001',
  'consumer-discovery-workspace', 'Discovery workspace',
  '99500000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array[
  '99500000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000002',
  '99500000-0000-4000-8000-000000000003',
  '99500000-0000-4000-8000-000000000004',
  '99500000-0000-4000-8000-000000000005',
  '99500000-0000-4000-8000-000000000006',
  '99500000-0000-4000-8000-000000000007',
  '99500000-0000-4000-8000-000000000008',
  '99500000-0000-4000-8000-000000000009',
  '99500000-0000-4000-8000-000000000010',
  '99500000-0000-4000-8000-000000000011',
  '99500000-0000-4000-8000-000000000013'
]::uuid[]) member_id;

insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
) values
  ('99530000-0000-4000-8000-000000000001', '99500000-0000-4000-8000-000000000001', 'member', 'active', 'organization'),
  ('99530000-0000-4000-8000-000000000001', '99500000-0000-4000-8000-000000000012', 'member', 'active', 'private');

-- 1-3: the new surfaces exist, are service-only, and the prefix index is in
-- place for the citext username column.
select ok(
  has_function_privilege('service_role',
    'public.bff_search_users_by_username(uuid,uuid,uuid,text,integer)', 'execute')
  and not has_function_privilege('authenticated',
    'public.bff_search_users_by_username(uuid,uuid,uuid,text,integer)', 'execute')
  and not has_function_privilege('anon',
    'public.bff_search_users_by_username(uuid,uuid,uuid,text,integer)', 'execute')
  and has_function_privilege('service_role',
    'private.bff_search_users_by_username_impl(uuid,uuid,uuid,text,integer)', 'execute')
  and not has_function_privilege('authenticated',
    'private.bff_search_users_by_username_impl(uuid,uuid,uuid,text,integer)', 'execute'),
  'username search is a service-only BFF capability'
);

select ok(
  has_function_privilege('service_role',
    'public.bff_send_message_request(uuid,uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('authenticated',
    'public.bff_send_message_request(uuid,uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('anon',
    'public.bff_send_message_request(uuid,uuid,uuid,uuid,text)', 'execute')
  and has_function_privilege('service_role',
    'private.bff_send_message_request_impl(uuid,uuid,uuid,uuid,text)', 'execute')
  and not has_function_privilege('authenticated',
    'private.bff_send_message_request_impl(uuid,uuid,uuid,uuid,text)', 'execute'),
  'message requests are a service-only BFF capability'
);

select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'profiles'
      and indexname = 'profiles_username_prefix_idx'
  ),
  'profiles carry a dedicated username prefix search index'
);

-- Relationship fixtures, written as the signed-in users so the relaxed
-- anti-enumeration trigger is what authorizes each stranger-to-stranger row.
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99500000-0000-4000-8000-000000000001","session_id":"99510000-0000-4000-8000-000000000001","aal":"aal1"}',
  true);
insert into public.contact_connections (
  organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111',
  '99500000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000003',
  '99500000-0000-4000-8000-000000000001'
);
insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
values (
  '11111111-1111-4111-8111-111111111111',
  '99500000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000006'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99500000-0000-4000-8000-000000000003","session_id":"99510000-0000-4000-8000-000000000003","aal":"aal1"}',
  true);
update public.contact_connections
set status = 'accepted'
where organization_id = '11111111-1111-4111-8111-111111111111'
  and member_low_user_id = '99500000-0000-4000-8000-000000000001'
  and member_high_user_id = '99500000-0000-4000-8000-000000000003';

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99500000-0000-4000-8000-000000000005","session_id":"99510000-0000-4000-8000-000000000005","aal":"aal1"}',
  true);
insert into public.contact_connections (
  organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111',
  '99500000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000005',
  '99500000-0000-4000-8000-000000000005'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99500000-0000-4000-8000-000000000007","session_id":"99510000-0000-4000-8000-000000000007","aal":"aal1"}',
  true);
insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
values (
  '11111111-1111-4111-8111-111111111111',
  '99500000-0000-4000-8000-000000000007',
  '99500000-0000-4000-8000-000000000001'
);

-- Dave receives a message request before the search assertions so search can
-- observe a live pending_outgoing state.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table dave_request on commit drop as
select public.bff_send_message_request(
  '99500000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99510000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000004',
  'Hi Dave, this is Alice.'
) as response;

-- 4-12: username prefix search.
select is(
  jsonb_array_length(public.bff_search_users_by_username(
    '99500000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '99510000-0000-4000-8000-000000000001',
    'ali', 25
  ) -> 'users'),
  5,
  'prefix search returns every active unblocked handle match'
);

select is(
  (select jsonb_object_agg(entry.value ->> 'username', entry.value ->> 'connection_state')
   from jsonb_array_elements(public.bff_search_users_by_username(
     '99500000-0000-4000-8000-000000000001',
     '11111111-1111-4111-8111-111111111111',
     '99510000-0000-4000-8000-000000000001',
     'ali', 25
   ) -> 'users') entry(value)),
  jsonb_build_object(
    'ali_bob', 'none',
    'ali_carol', 'accepted',
    'ali_dave', 'pending_outgoing',
    'ali_erin', 'pending_incoming',
    'ali_iris', 'none'
  ),
  'connection states derive from the actor''s contact connections'
);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.bff_search_users_by_username(
      '99500000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000001',
      'ali', 25
    ) -> 'users') entry(value)
    where entry.value ->> 'username' in ('ali_frank', 'ali_grace')
  ),
  'search excludes blocked pairs in both directions'
);

select is(
  jsonb_array_length(public.bff_search_users_by_username(
    '99500000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '99510000-0000-4000-8000-000000000001',
    'ali', 2
  ) -> 'users'),
  2,
  'search results are bounded by the requested limit'
);

select is(
  jsonb_array_length(public.bff_search_users_by_username(
    '99500000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '99510000-0000-4000-8000-000000000001',
    'ALI', 25
  ) -> 'users'),
  5,
  'queries are normalized to lowercase before matching'
);

select is(
  public.bff_search_users_by_username(
    '99500000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '99510000-0000-4000-8000-000000000001',
    'not a handle!', 25
  ) -> 'users',
  '[]'::jsonb,
  'a malformed query finds nobody instead of erroring'
);

select is(
  public.bff_search_users_by_username(
    '99500000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '99510000-0000-4000-8000-000000000001',
    'a', 25
  ) -> 'users',
  '[]'::jsonb,
  'single-character probes find nobody'
);

select throws_ok(
  $search_workspace$
    select public.bff_search_users_by_username(
      '99500000-0000-4000-8000-000000000001',
      '99530000-0000-4000-8000-000000000001',
      '99510000-0000-4000-8000-000000000001',
      'ali', 25
    )
  $search_workspace$,
  '22023',
  'username search is a personal-realm capability',
  'username search refuses workspace organizations'
);

select throws_ok(
  $search_limit$
    select public.bff_search_users_by_username(
      '99500000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000001',
      'ali', 26
    )
  $search_limit$,
  '22023',
  'invalid username search limit',
  'oversized search limits are refused'
);

-- 13-16: the atomic message request to Bob.
create temporary table bob_request on commit drop as
select public.bff_send_message_request(
  '99500000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99510000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000002',
  'Hi Bob! Alice here.'
) as response;

select is(
  (select response ->> 'connection_status' from bob_request),
  'pending',
  'a message request reports its pending connection'
);

select ok(
  exists (
    select 1 from public.contact_connections
    where organization_id = '11111111-1111-4111-8111-111111111111'
      and member_low_user_id = '99500000-0000-4000-8000-000000000001'
      and member_high_user_id = '99500000-0000-4000-8000-000000000002'
      and status = 'pending'
      and requested_by_user_id = '99500000-0000-4000-8000-000000000001'
  ),
  'a message request stores the canonical pending connection'
);

select ok(
  exists (
    select 1
    from public.direct_conversation_pairs pair
    join bob_request
      on pair.conversation_id = (bob_request.response ->> 'conversation_id')::uuid
    where pair.organization_id = '11111111-1111-4111-8111-111111111111'
      and pair.member_low_user_id = '99500000-0000-4000-8000-000000000001'
      and pair.member_high_user_id = '99500000-0000-4000-8000-000000000002'
  ),
  'a message request opens the direct conversation for the pair'
);

select ok(
  exists (
    select 1
    from public.messages message
    join bob_request
      on message.conversation_id = (bob_request.response ->> 'conversation_id')::uuid
     and message.id = (bob_request.response ->> 'message_id')::bigint
    where message.organization_id = '11111111-1111-4111-8111-111111111111'
      and message.sender_user_id = '99500000-0000-4000-8000-000000000001'
      and message.body = 'Hi Bob! Alice here.'
      and message.deleted_at is null
  ),
  'a message request delivers its first message'
);

-- 17-20: the pending window allows the requester three messages and the
-- recipient none.
select lives_ok(
  $second_message$
    select public.bff_send_message(
      '99500000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000001',
      (select (response ->> 'conversation_id')::uuid from bob_request),
      gen_random_uuid(), 'text', 'Second hello', null, null, null,
      '{}'::jsonb, 'discovery-bob-msg-2', repeat('2', 64)
    )
  $second_message$,
  'the pending requester may send a second message'
);

select lives_ok(
  $third_message$
    select public.bff_send_message(
      '99500000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000001',
      (select (response ->> 'conversation_id')::uuid from bob_request),
      gen_random_uuid(), 'text', 'Third hello', null, null, null,
      '{}'::jsonb, 'discovery-bob-msg-3', repeat('3', 64)
    )
  $third_message$,
  'the pending requester may send a third message'
);

select throws_ok(
  $fourth_message$
    select public.bff_send_message(
      '99500000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000001',
      (select (response ->> 'conversation_id')::uuid from bob_request),
      gen_random_uuid(), 'text', 'Fourth hello', null, null, null,
      '{}'::jsonb, 'discovery-bob-msg-4', repeat('4', 64)
    )
  $fourth_message$,
  '42501',
  'active conversation membership with posting access is required',
  'the pending requester is capped at three messages'
);

select throws_ok(
  $pending_reply$
    select public.bff_send_message(
      '99500000-0000-4000-8000-000000000002',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000002',
      (select (response ->> 'conversation_id')::uuid from bob_request),
      gen_random_uuid(), 'text', 'Who is this?', null, null, null,
      '{}'::jsonb, 'discovery-bob-reply-1', repeat('5', 64)
    )
  $pending_reply$,
  '42501',
  'active conversation membership with posting access is required',
  'the recipient cannot reply while the request is pending'
);

-- 21-23: acceptance through the existing contact response unlocks a normal
-- DM in both directions.
select is(
  (public.bff_respond_contact(
    '99500000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    '99510000-0000-4000-8000-000000000002',
    '99500000-0000-4000-8000-000000000001',
    'accepted', 'discovery-bob-accept', repeat('6', 64)
  )) ->> 'status',
  'accepted',
  'the recipient accepts through the existing contact response'
);

select lives_ok(
  $accepted_reply$
    select public.bff_send_message(
      '99500000-0000-4000-8000-000000000002',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000002',
      (select (response ->> 'conversation_id')::uuid from bob_request),
      gen_random_uuid(), 'text', 'Alice! Good to hear from you.', null, null, null,
      '{}'::jsonb, 'discovery-bob-reply-2', repeat('7', 64)
    )
  $accepted_reply$,
  'acceptance unlocks the conversation for the recipient'
);

select lives_ok(
  $post_accept_message$
    select public.bff_send_message(
      '99500000-0000-4000-8000-000000000001',
      '11111111-1111-4111-8111-111111111111',
      '99510000-0000-4000-8000-000000000001',
      (select (response ->> 'conversation_id')::uuid from bob_request),
      gen_random_uuid(), 'text', 'Fourth message, now connected', null, null, null,
      '{}'::jsonb, 'discovery-bob-msg-5', repeat('8', 64)
    )
  $post_accept_message$,
  'acceptance lifts the requester message cap'
);

-- 24-25: decline immediately revokes the requester posting window.
select is(
  (public.bff_respond_contact(
    '99500000-0000-4000-8000-000000000004',
    '11111111-1111-4111-8111-111111111111',
    '99510000-0000-4000-8000-000000000004',
    '99500000-0000-4000-8000-000000000001',
    'declined', 'discovery-dave-decline', repeat('9', 64)
  )) ->> 'status',
  'declined',
  'the recipient declines through the existing contact response'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99500000-0000-4000-8000-000000000001","session_id":"99510000-0000-4000-8000-000000000001","aal":"aal1"}',
  true);
select ok(
  not private.can_post_to_conversation(
    '11111111-1111-4111-8111-111111111111',
    (select (response ->> 'conversation_id')::uuid from dave_request)
  ),
  'decline immediately revokes the requester posting window'
);

-- 26-27: a block wins over a live pending window.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table iris_request on commit drop as
select public.bff_send_message_request(
  '99500000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99510000-0000-4000-8000-000000000001',
  '99500000-0000-4000-8000-000000000009',
  'Hi Iris!'
) as response;

select is(
  (select response ->> 'connection_status' from iris_request),
  'pending',
  'a message request to a second recipient opens its own pending window'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99500000-0000-4000-8000-000000000009","session_id":"99510000-0000-4000-8000-000000000009","aal":"aal1"}',
  true);
insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
values (
  '11111111-1111-4111-8111-111111111111',
  '99500000-0000-4000-8000-000000000009',
  '99500000-0000-4000-8000-000000000001'
);

select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"99500000-0000-4000-8000-000000000001","session_id":"99510000-0000-4000-8000-000000000001","aal":"aal1"}',
  true);
select ok(
  not private.can_post_to_conversation(
    '11111111-1111-4111-8111-111111111111',
    (select (response ->> 'conversation_id')::uuid from iris_request)
  ),
  'a block wins over a pending request window'
);

-- 28-30: anti-enumeration. Relationship writes reach only personal-realm
-- targets that hold a live username; username-less members and workspace
-- strangers stay unreachable.
select throws_ok(
  $contact_no_handle$
    insert into public.contact_connections (
      organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
    ) values (
      '11111111-1111-4111-8111-111111111111',
      '99500000-0000-4000-8000-000000000001',
      '99500000-0000-4000-8000-000000000008',
      '99500000-0000-4000-8000-000000000001'
    )
  $contact_no_handle$,
  '42501',
  'visible relationship target required',
  'a username-less personal-realm member cannot be targeted'
);

select throws_ok(
  $contact_workspace$
    insert into public.contact_connections (
      organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
    ) values (
      '99530000-0000-4000-8000-000000000001',
      '99500000-0000-4000-8000-000000000001',
      '99500000-0000-4000-8000-000000000012',
      '99500000-0000-4000-8000-000000000001'
    )
  $contact_workspace$,
  '42501',
  'visible relationship target required',
  'workspace organizations keep the directory-visibility contact rule'
);

select lives_ok(
  $contact_stranger$
    insert into public.contact_connections (
      organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
    ) values (
      '11111111-1111-4111-8111-111111111111',
      '99500000-0000-4000-8000-000000000001',
      '99500000-0000-4000-8000-000000000011',
      '99500000-0000-4000-8000-000000000001'
    )
  $contact_stranger$,
  'a personal-realm username holder accepts a first contact request'
);

-- A named group with Yara gives the actor a conversation co-member who is
-- not a contact, exercising the second directory source independently.
create temporary table yara_group on commit drop as
select private.create_group_conversation(
  '11111111-1111-4111-8111-111111111111',
  'Weekend crew',
  array['99500000-0000-4000-8000-000000000010']::uuid[]
) as conversation_id;

-- 31-35: personal-realm bootstrap directory comes only from connections and
-- shared conversations; workspaces keep the established directory chain.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table realm_bootstrap on commit drop as
select public.bff_bootstrap_messaging_state(
  '99500000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99510000-0000-4000-8000-000000000001'
) as state;

select ok(
  exists (
    select 1
    from realm_bootstrap,
      jsonb_array_elements(state -> 'directory') entry(value)
    where entry.value ->> 'user_id' = '99500000-0000-4000-8000-000000000003'
  ),
  'the personal-realm directory includes connection partners'
);

select ok(
  exists (
    select 1
    from realm_bootstrap,
      jsonb_array_elements(state -> 'directory') entry(value)
    where entry.value ->> 'user_id' = '99500000-0000-4000-8000-000000000010'
  ),
  'the personal-realm directory includes conversation co-members'
);

select ok(
  exists (
    select 1
    from realm_bootstrap,
      jsonb_array_elements(state -> 'directory') entry(value)
    where entry.value ->> 'user_id' = '99500000-0000-4000-8000-000000000002'
      and entry.value -> 'connection' ->> 'status' = 'accepted'
  ),
  'the personal-realm directory carries the connection payload for partners'
);

select ok(
  not exists (
    select 1
    from realm_bootstrap,
      jsonb_array_elements(state -> 'directory') entry(value)
    where entry.value ->> 'user_id' in (
      '99500000-0000-4000-8000-000000000013',
      '99500000-0000-4000-8000-000000000008'
    )
  ),
  'the personal-realm directory omits unrelated realm members'
);

select is(
  public.bff_bootstrap_messaging_state(
    '99500000-0000-4000-8000-000000000001',
    '99530000-0000-4000-8000-000000000001',
    '99510000-0000-4000-8000-000000000001'
  ) -> 'directory',
  private.bff_bootstrap_messaging_state_v9_impl(
    '99500000-0000-4000-8000-000000000001',
    '99530000-0000-4000-8000-000000000001',
    '99510000-0000-4000-8000-000000000001',
    null, null, 100, 50
  ) -> 'directory',
  'workspace organizations keep the established directory'
);

select * from finish();
rollback;
