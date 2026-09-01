begin;
select plan(12);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: one workspace with a group conversation, one unrelated
-- organization. Alice is a conversation member, Bob is an organization
-- member outside the conversation, Casey belongs to the other organization.
insert into auth.users (id, email, email_confirmed_at) values
  ('99700000-0000-4000-8000-000000000001', 'typing-alice@example.test', now()),
  ('99700000-0000-4000-8000-000000000002', 'typing-bob@example.test', now()),
  ('99700000-0000-4000-8000-000000000003', 'typing-casey@example.test', now()),
  ('99700000-0000-4000-8000-000000000004', 'typing-owner@example.test', now());

insert into public.organizations (id, slug, name, created_by_user_id) values
  ('99710000-0000-4000-8000-000000000001', 'typing-channel-org', 'Typing org', '99700000-0000-4000-8000-000000000004'),
  ('99710000-0000-4000-8000-000000000002', 'typing-channel-other', 'Other org', '99700000-0000-4000-8000-000000000003');

insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('99710000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000004', 'owner', 'active'),
  ('99710000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', 'member', 'active'),
  ('99710000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000002', 'member', 'active'),
  ('99710000-0000-4000-8000-000000000002', '99700000-0000-4000-8000-000000000003', 'owner', 'active');

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('99730000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('99730000-0000-4000-8000-000000000002', '99700000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('99730000-0000-4000-8000-000000000003', '99700000-0000-4000-8000-000000000003', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('99730000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', '99740000-0000-4000-8000-000000000001', 'ios', decode(repeat('a1', 32), 'hex'), 'iphone'),
  ('99730000-0000-4000-8000-000000000002', '99700000-0000-4000-8000-000000000002', '99740000-0000-4000-8000-000000000002', 'web', decode(repeat('a2', 32), 'hex'), 'desktop'),
  ('99730000-0000-4000-8000-000000000003', '99700000-0000-4000-8000-000000000003', '99740000-0000-4000-8000-000000000003', 'android', decode(repeat('a3', 32), 'hex'), 'android');

insert into public.conversations (
  id, organization_id, kind, name, visibility, created_by_user_id
) values (
  '99720000-0000-4000-8000-000000000001',
  '99710000-0000-4000-8000-000000000001',
  'group', 'Typing room', 'invite_only', '99700000-0000-4000-8000-000000000004'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id, history_visible_from
) values
  ('99710000-0000-4000-8000-000000000001', '99720000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000004', 'owner', '99700000-0000-4000-8000-000000000004', null),
  ('99710000-0000-4000-8000-000000000001', '99720000-0000-4000-8000-000000000001', '99700000-0000-4000-8000-000000000001', 'member', '99700000-0000-4000-8000-000000000004', null);

-- 1-2: the predicate is an RLS-only capability and both typing policies sit
-- on realtime.messages exactly like the established channel policies.
select ok(
  has_function_privilege('authenticated', 'private.realtime_typing_topic_authorized(text)', 'execute')
  and not has_function_privilege('anon', 'private.realtime_typing_topic_authorized(text)', 'execute')
  and not has_function_privilege('service_role', 'private.realtime_typing_topic_authorized(text)', 'execute'),
  'the typing topic predicate is executable by authenticated RLS only'
);
select ok(
  exists (
    select 1 from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'newone_realtime_typing_receive' and cmd = 'SELECT'
      and roles = array['authenticated']::name[]
  ) and exists (
    select 1 from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'newone_realtime_typing_broadcast' and cmd = 'INSERT'
      and roles = array['authenticated']::name[]
  ),
  'typing channels have scoped receive and broadcast policies'
);

-- 3-7: authorization follows current conversation membership exactly.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"99700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","session_id":"99730000-0000-4000-8000-000000000001"}',
  true
);
select is(
  (select private.realtime_typing_topic_authorized(
    'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing'
  )),
  true,
  'a conversation member may use the conversation typing channel'
);
select is(
  (select private.realtime_typing_topic_authorized(
    'org:99710000-0000-4000-8000-000000000001:user:99700000-0000-4000-8000-000000000001:inbox'
  )),
  false,
  'the typing predicate authorizes only the typing topic shape'
);
select is(
  (select private.realtime_topic_authorized(
    'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing'
  )),
  false,
  'the inbox/control predicate does not leak onto typing topics'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"99700000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1","session_id":"99730000-0000-4000-8000-000000000002"}',
  true
);
select is(
  (select private.realtime_typing_topic_authorized(
    'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing'
  )),
  false,
  'an organization member outside the conversation is refused'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"99700000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1","session_id":"99730000-0000-4000-8000-000000000003"}',
  true
);
select is(
  (select private.realtime_typing_topic_authorized(
    'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing'
  )),
  false,
  'a member of another organization is refused'
);

-- 8-11: the actual Realtime policy path: members subscribe and broadcast,
-- non-members cannot write, and the channel is broadcast-only.
select set_config(
  'request.jwt.claims',
  '{"sub":"99700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","session_id":"99730000-0000-4000-8000-000000000001"}',
  true
);
select set_config(
  'realtime.topic',
  'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing',
  true
);
select lives_ok(
  $publish$
    insert into realtime.messages (topic, extension, event, payload, private)
    values (
      'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing',
      'broadcast', 'typing',
      jsonb_build_object('user_id', '99700000-0000-4000-8000-000000000001'),
      true
    )
  $publish$,
  'a conversation member may broadcast on the typing channel'
);
select ok(
  exists (
    select 1 from realtime.messages
    where topic = 'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing'
      and extension = 'broadcast' and event = 'typing'
  ),
  'a conversation member receives typing broadcasts through the select policy'
);
select throws_ok(
  $publish$
    insert into realtime.messages (topic, extension, event, payload, private)
    values (
      'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing',
      'presence', 'typing',
      jsonb_build_object('user_id', '99700000-0000-4000-8000-000000000001'),
      true
    )
  $publish$,
  '42501',
  null,
  'the typing channel is broadcast-only'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"99700000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1","session_id":"99730000-0000-4000-8000-000000000002"}',
  true
);
select throws_ok(
  $publish$
    insert into realtime.messages (topic, extension, event, payload, private)
    values (
      'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing',
      'broadcast', 'typing',
      jsonb_build_object('user_id', '99700000-0000-4000-8000-000000000002'),
      true
    )
  $publish$,
  '42501',
  null,
  'a non-member cannot broadcast typing state'
);

-- 12: revoked tenant access cuts the typing channel immediately.
reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"99700000-0000-4000-8000-000000000004","aal":"aal2"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
update public.organization_memberships
set status = 'suspended', status_change_reason = 'Typing channel fixture'
where organization_id = '99710000-0000-4000-8000-000000000001'
  and user_id = '99700000-0000-4000-8000-000000000001';
select set_config('app.bff_service_context', 'off', true);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"99700000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1","session_id":"99730000-0000-4000-8000-000000000001"}',
  true
);
select is(
  (select private.realtime_typing_topic_authorized(
    'org:99710000-0000-4000-8000-000000000001:conversation:99720000-0000-4000-8000-000000000001:typing'
  )),
  false,
  'a suspended member loses the typing channel'
);

select * from finish();
rollback;
