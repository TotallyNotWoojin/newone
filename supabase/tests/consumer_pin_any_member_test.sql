begin;
select plan(6);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: the personal realm with three consumer accounts. Alice creates a
-- group with Bob (both hold the member role in the realm; Alice becomes the
-- conversation owner, Bob a plain conversation member). Frank is Alice's
-- friend but not in the group.
insert into auth.users (id, email, email_confirmed_at) values
  ('dc000000-0000-4000-8000-000000000001', 'pin-alice@example.test', now()),
  ('dc000000-0000-4000-8000-000000000002', 'pin-bob@example.test', now()),
  ('dc000000-0000-4000-8000-000000000006', 'pin-frank@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id
    when 'dc000000-0000-4000-8000-000000000001' then 'pin_alice'
    when 'dc000000-0000-4000-8000-000000000002' then 'pin_bob'
    else 'pin_frank'
  end,
  display_name = case user_id
    when 'dc000000-0000-4000-8000-000000000001' then 'Pin Alice'
    when 'dc000000-0000-4000-8000-000000000002' then 'Pin Bob'
    else 'Pin Frank'
  end
where user_id in (
  'dc000000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000002',
  'dc000000-0000-4000-8000-000000000006'
);
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('dc100000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('dc100000-0000-4000-8000-000000000002', 'dc000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('dc100000-0000-4000-8000-000000000006', 'dc000000-0000-4000-8000-000000000006', now(), now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('dc100000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000001', 'dc200000-0000-4000-8000-000000000001', 'ios', decode(repeat('d1', 32), 'hex'), 'iphone'),
  ('dc100000-0000-4000-8000-000000000002', 'dc000000-0000-4000-8000-000000000002', 'dc200000-0000-4000-8000-000000000002', 'ios', decode(repeat('d2', 32), 'hex'), 'iphone'),
  ('dc100000-0000-4000-8000-000000000006', 'dc000000-0000-4000-8000-000000000006', 'dc200000-0000-4000-8000-000000000006', 'android', decode(repeat('d6', 32), 'hex'), 'android');

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, 'dc000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array[
  'dc000000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000002',
  'dc000000-0000-4000-8000-000000000006'
]::uuid[]) member_id;

select public.bff_request_contact(
  'dc000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'dc100000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000002',
  'pin-req-alice-bob', repeat('1', 64)
);
select public.bff_respond_contact(
  'dc000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'dc100000-0000-4000-8000-000000000002', 'dc000000-0000-4000-8000-000000000001',
  'accepted', 'pin-acc-alice-bob', repeat('2', 64)
);
select public.bff_request_contact(
  'dc000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'dc100000-0000-4000-8000-000000000001', 'dc000000-0000-4000-8000-000000000006',
  'pin-req-alice-frank', repeat('3', 64)
);
select public.bff_respond_contact(
  'dc000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
  'dc100000-0000-4000-8000-000000000006', 'dc000000-0000-4000-8000-000000000001',
  'accepted', 'pin-acc-alice-frank', repeat('4', 64)
);

create temporary table pin_group on commit drop as
select public.bff_create_group_conversation_v2(
  'dc000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'dc100000-0000-4000-8000-000000000001',
  'Pin duo', null,
  '[{"user_id":"dc000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'pin-create-group', repeat('5', 64)
) as receipt;

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"dc000000-0000-4000-8000-000000000001","session_id":"dc100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values (
  '11111111-1111-4111-8111-111111111111',
  (select (receipt ->> 'conversation_id')::uuid from pin_group),
  'dc000000-0000-4000-8000-000000000001', 'dc400000-0000-4000-8000-000000000001',
  'text', 'Pin me', 'en'
);
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table pin_message on commit drop as
select id from public.messages where client_nonce = 'dc400000-0000-4000-8000-000000000001';

select is(
  (select role from public.conversation_members
   where conversation_id = (select (receipt ->> 'conversation_id')::uuid from pin_group)
     and user_id = 'dc000000-0000-4000-8000-000000000002'),
  'member',
  'Bob holds the plain member role in the conversation'
);

-- Bob (member, not admin) pins in the personal realm.
select lives_ok(
  $$ select public.bff_set_message_pin(
       'dc000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
       'dc100000-0000-4000-8000-000000000002',
       (select (receipt ->> 'conversation_id')::uuid from pin_group),
       (select id from pin_message), true,
       'pin-bob-pins', repeat('6', 64)
     ) $$,
  'a consumer conversation member can pin a message'
);
select is(
  (select pinned_by_user_id from public.message_pins
   where message_id = (select id from pin_message)),
  'dc000000-0000-4000-8000-000000000002'::uuid,
  'the pin row records Bob as the pinner'
);

-- Bob unpins.
select lives_ok(
  $$ select public.bff_set_message_pin(
       'dc000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
       'dc100000-0000-4000-8000-000000000002',
       (select (receipt ->> 'conversation_id')::uuid from pin_group),
       (select id from pin_message), false,
       'pin-bob-unpins', repeat('7', 64)
     ) $$,
  'a consumer conversation member can unpin a message'
);
select is(
  (select count(*)::integer from public.message_pins
   where message_id = (select id from pin_message)),
  0,
  'the pin row is gone after unpin'
);

-- Frank is a friend but not a conversation member: still denied.
select throws_ok(
  $$ select public.bff_set_message_pin(
       'dc000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
       'dc100000-0000-4000-8000-000000000006',
       (select (receipt ->> 'conversation_id')::uuid from pin_group),
       (select id from pin_message), true,
       'pin-frank-pins', repeat('8', 64)
     ) $$,
  '42501',
  null,
  'a non-member cannot pin in the personal realm'
);

select * from finish();
rollback;
