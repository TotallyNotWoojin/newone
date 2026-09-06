begin;
select plan(14);

-- Invite anyone (20260906030000): in the personal realm any current member
-- with a handle can be placed into a group, whatever the contact-connection
-- status; a block in either direction still refuses, and a member who has
-- not finished signup (no username) stays invisible. Workspace organizations
-- keep their existing directory-based rules.

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Fixtures: personal realm with five consumer accounts.
--   Alice -- Bob:   accepted
--   Alice -- Carol: pending only (never accepted)
--   Alice -- Dave:  no connection at all
--   Erin:           no username yet (signup not finished)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('fa000000-0000-4000-8000-000000000001', 'fg-alice@example.test', now()),
  ('fa000000-0000-4000-8000-000000000002', 'fg-bob@example.test', now()),
  ('fa000000-0000-4000-8000-000000000003', 'fg-carol@example.test', now()),
  ('fa000000-0000-4000-8000-000000000004', 'fg-dave@example.test', now()),
  ('fa000000-0000-4000-8000-000000000007', 'fg-erin@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id
    when 'fa000000-0000-4000-8000-000000000001' then 'fg_alice'
    when 'fa000000-0000-4000-8000-000000000002' then 'fg_bob'
    when 'fa000000-0000-4000-8000-000000000003' then 'fg_carol'
    else 'fg_dave'
  end
where user_id in (
  'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002',
  'fa000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000004'
);
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('fa100000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('fa100000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('fa100000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000004', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000001', 'fa200000-0000-4000-8000-000000000001', 'ios', decode(repeat('d1', 32), 'hex'), 'iphone'),
  ('fa100000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000002', 'fa200000-0000-4000-8000-000000000002', 'ios', decode(repeat('d2', 32), 'hex'), 'iphone'),
  ('fa100000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000003', 'fa200000-0000-4000-8000-000000000003', 'ios', decode(repeat('d3', 32), 'hex'), 'iphone'),
  ('fa100000-0000-4000-8000-000000000004', 'fa000000-0000-4000-8000-000000000004', 'fa200000-0000-4000-8000-000000000004', 'ios', decode(repeat('d4', 32), 'hex'), 'iphone');

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, 'fa000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array[
  'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002',
  'fa000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000004',
  'fa000000-0000-4000-8000-000000000007'
]::uuid[]) member_id;

select public.bff_request_contact(
  'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002',
  'fg-req-alice-bob', repeat('1', 64)
);
select public.bff_respond_contact(
  'fa000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'fa100000-0000-4000-8000-000000000002', 'fa000000-0000-4000-8000-000000000001',
  'accepted', 'fg-acc-alice-bob', repeat('2', 64)
);
select public.bff_request_contact(
  'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'fa100000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003',
  'fg-req-alice-carol', repeat('3', 64)
);
-- Carol never responds: the connection stays pending.

-- ---------------------------------------------------------------------------
-- 1: the predicates directly.
-- ---------------------------------------------------------------------------
select ok(
  private.group_member_candidate_permitted(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002'
  ),
  'an accepted friend is a permitted group candidate'
);
select ok(
  private.group_member_candidate_permitted(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003'
  ),
  'a pending (not yet accepted) contact is a permitted group candidate'
);
select ok(
  private.group_member_candidate_permitted(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000004'
  ),
  'a stranger with no connection at all is a permitted group candidate'
);
select ok(
  private.can_view_org_member_for_actor(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000004', now()
  ),
  'a stranger with a handle is visible in the private personal-realm directory'
);
select ok(
  not private.can_view_org_member_for_actor(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000007', now()
  ),
  'a member without a username stays invisible (anti-enumeration parity)'
);

-- ---------------------------------------------------------------------------
-- 2: creating a group with a stranger succeeds.
-- ---------------------------------------------------------------------------
create temporary table fg_group on commit drop as
select public.bff_create_group_conversation_v2(
  'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'fa100000-0000-4000-8000-000000000001',
  'Anyone', null,
  '[{"user_id":"fa000000-0000-4000-8000-000000000004","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'fg-create-group-stranger', repeat('4', 64)
) as receipt;
select ok(
  (select receipt ->> 'conversation_id' from fg_group) is not null,
  'creating a personal-realm group with a stranger succeeds'
);

-- ---------------------------------------------------------------------------
-- 3: adding a merely-pending contact to that group succeeds.
-- ---------------------------------------------------------------------------
select is(
  (public.bff_add_conversation_member(
    'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'fa100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from fg_group),
    'fa000000-0000-4000-8000-000000000003', 'member',
    'fg-add-member-pending', repeat('5', 64)
  )) ->> 'role',
  'member',
  'adding a pending (not accepted) contact to a group succeeds'
);

-- ---------------------------------------------------------------------------
-- 4: a member without a username cannot be added (visibility gate).
-- ---------------------------------------------------------------------------
select throws_ok(
  format(
    $$select public.bff_add_conversation_member(
      'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
      'fa100000-0000-4000-8000-000000000001', %L,
      'fa000000-0000-4000-8000-000000000007', 'member',
      'fg-add-member-no-handle', repeat('6', 64)
    )$$,
    (select receipt ->> 'conversation_id' from fg_group)
  ),
  '42501', 'current organization member required',
  'adding a member without a username is rejected'
);

-- ---------------------------------------------------------------------------
-- 5: a block in either direction refuses. Bob blocks Alice, so Alice can
-- neither create a group with Bob nor add him to hers, even though they are
-- accepted friends.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims',
  '{"role":"authenticated","sub":"fa000000-0000-4000-8000-000000000002","session_id":"fa100000-0000-4000-8000-000000000002","aal":"aal1"}',
  true);
insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
values (
  '11111111-1111-4111-8111-111111111111',
  'fa000000-0000-4000-8000-000000000002',
  'fa000000-0000-4000-8000-000000000001'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  not private.group_member_candidate_permitted(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002'
  ),
  'a block by the target refuses the candidate even for an accepted friend'
);
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'fa100000-0000-4000-8000-000000000001',
    'Blocked', null,
    '[{"user_id":"fa000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'fg-create-group-blocked', repeat('7', 64)
  )$$,
  '42501', 'initial group membership is not permitted',
  'creating a group with someone who blocked you is rejected'
);
select throws_ok(
  format(
    $$select public.bff_add_conversation_member(
      'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
      'fa100000-0000-4000-8000-000000000001', %L,
      'fa000000-0000-4000-8000-000000000002', 'member',
      'fg-add-member-blocked', repeat('8', 64)
    )$$,
    (select receipt ->> 'conversation_id' from fg_group)
  ),
  '42501', 'current organization member required',
  'adding someone who blocked you to a group is rejected'
);

-- ---------------------------------------------------------------------------
-- 6: workspace organizations keep their existing directory rules -- no
-- contact connection exists between the workspace owner and member, and
-- group creation still succeeds.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('fa000000-0000-4000-8000-000000000005', 'fg-owner@example.test', now()),
  ('fa000000-0000-4000-8000-000000000006', 'fg-member@example.test', now());
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('fa100000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000005', now(), now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values (
  'fa100000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000005',
  'fa200000-0000-4000-8000-000000000005', 'ios', decode(repeat('d5', 32), 'hex'), 'iphone'
);
insert into public.organizations (id, slug, name, created_by_user_id) values (
  'fa300000-0000-4000-8000-000000000001', 'fg-workspace', 'FG workspace',
  'fa000000-0000-4000-8000-000000000005'
);
insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('fa300000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000005', 'owner', 'active'),
  ('fa300000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000006', 'member', 'active');

select ok(
  not exists (
    select 1 from public.contact_connections connection
    where connection.organization_id = 'fa300000-0000-4000-8000-000000000001'
  ),
  'the workspace owner and member have no contact connection at all'
);
select ok(
  private.group_member_candidate_permitted(
    'fa300000-0000-4000-8000-000000000001',
    'fa000000-0000-4000-8000-000000000005', 'fa000000-0000-4000-8000-000000000006'
  ),
  'the candidate predicate is vacuously true outside the personal realm'
);
create temporary table fg_workspace_group on commit drop as
select public.bff_create_group_conversation_v2(
  'fa000000-0000-4000-8000-000000000005', 'fa300000-0000-4000-8000-000000000001',
  'fa100000-0000-4000-8000-000000000005',
  'Workspace group', null,
  '[{"user_id":"fa000000-0000-4000-8000-000000000006","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'fg-create-workspace-group', repeat('b', 64)
) as receipt;
select ok(
  (select receipt ->> 'conversation_id' from fg_workspace_group) is not null,
  'a workspace group is created without any contact connection requirement'
);

select * from finish();
rollback;
