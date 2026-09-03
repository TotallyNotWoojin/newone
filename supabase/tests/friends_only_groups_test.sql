begin;
select plan(12);

-- Friends-only groups (20260903030000, part 2): in the personal realm,
-- creating a group or adding a member requires an accepted contact
-- connection between the actor and each added member. Workspace
-- organizations keep their existing directory-based rules.

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Fixtures: personal realm with four consumer accounts.
--   Alice -- Bob:   accepted
--   Alice -- Carol: pending only (never accepted)
--   Alice -- Dave:  no connection at all
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('fa000000-0000-4000-8000-000000000001', 'fg-alice@example.test', now()),
  ('fa000000-0000-4000-8000-000000000002', 'fg-bob@example.test', now()),
  ('fa000000-0000-4000-8000-000000000003', 'fg-carol@example.test', now()),
  ('fa000000-0000-4000-8000-000000000004', 'fg-dave@example.test', now());

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
  'fa000000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000004'
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
-- 1: the underlying predicate directly.
-- ---------------------------------------------------------------------------
select ok(
  private.group_member_candidate_permitted(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000002'
  ),
  'an accepted friend is a permitted group candidate'
);
select ok(
  not private.group_member_candidate_permitted(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000003'
  ),
  'a pending (not yet accepted) connection is not a permitted group candidate'
);
select ok(
  not private.group_member_candidate_permitted(
    '11111111-1111-4111-8111-111111111111',
    'fa000000-0000-4000-8000-000000000001', 'fa000000-0000-4000-8000-000000000004'
  ),
  'no connection at all is not a permitted group candidate'
);

-- ---------------------------------------------------------------------------
-- 2: creating a group with an accepted friend succeeds.
-- ---------------------------------------------------------------------------
create temporary table fg_group on commit drop as
select public.bff_create_group_conversation_v2(
  'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'fa100000-0000-4000-8000-000000000001',
  'Friends only', null,
  '[{"user_id":"fa000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'fg-create-group-ok', repeat('4', 64)
) as receipt;
select ok(
  (select receipt ->> 'conversation_id' from fg_group) is not null,
  'creating a personal-realm group with an accepted friend succeeds'
);

-- ---------------------------------------------------------------------------
-- 3: creating a group with a pending (not accepted) contact is rejected.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'fa100000-0000-4000-8000-000000000001',
    'Not friends yet', null,
    '[{"user_id":"fa000000-0000-4000-8000-000000000003","role":"member"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'fg-create-group-pending', repeat('5', 64)
  )$$,
  '42501', 'initial group membership is not permitted',
  'creating a group with a merely-pending contact is rejected'
);

-- ---------------------------------------------------------------------------
-- 4: creating a group with a stranger (no connection) is rejected.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'fa100000-0000-4000-8000-000000000001',
    'Strangers', null,
    '[{"user_id":"fa000000-0000-4000-8000-000000000004","role":"member"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'fg-create-group-stranger', repeat('6', 64)
  )$$,
  '42501', 'initial group membership is not permitted',
  'creating a group with a stranger (no contact connection) is rejected'
);

-- ---------------------------------------------------------------------------
-- 5: adding a pending contact to an existing group is rejected.
-- ---------------------------------------------------------------------------
select throws_ok(
  format(
    $$select public.bff_add_conversation_member(
      'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
      'fa100000-0000-4000-8000-000000000001', %L,
      'fa000000-0000-4000-8000-000000000003', 'member',
      'fg-add-member-pending', repeat('7', 64)
    )$$,
    (select receipt ->> 'conversation_id' from fg_group)
  ),
  '42501', 'group members must be accepted contacts',
  'adding a pending (not accepted) contact to a group is rejected'
);

-- ---------------------------------------------------------------------------
-- 6: adding a stranger to an existing group is rejected. A stranger with no
-- contact connection at all is not even visible to the actor in the private
-- personal-realm directory, so this fails the earlier visibility gate
-- rather than the friends-only check reached by a merely-pending contact
-- above -- both are rejections, from two layered checks.
select throws_ok(
  format(
    $$select public.bff_add_conversation_member(
      'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
      'fa100000-0000-4000-8000-000000000001', %L,
      'fa000000-0000-4000-8000-000000000004', 'member',
      'fg-add-member-stranger', repeat('8', 64)
    )$$,
    (select receipt ->> 'conversation_id' from fg_group)
  ),
  '42501', 'current organization member required',
  'adding a stranger (no contact connection at all) to a group is rejected'
);

-- Carol accepts Alice's request; now she is a permitted candidate and can
-- be added to the same group that previously rejected her.
select public.bff_respond_contact(
  'fa000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
  'fa100000-0000-4000-8000-000000000003', 'fa000000-0000-4000-8000-000000000001',
  'accepted', 'fg-acc-alice-carol', repeat('9', 64)
);
select is(
  (public.bff_add_conversation_member(
    'fa000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'fa100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from fg_group),
    'fa000000-0000-4000-8000-000000000003', 'member',
    'fg-add-member-now-accepted', repeat('a', 64)
  )) ->> 'role',
  'member',
  'once accepted, the same contact can be added to the group'
);

-- ---------------------------------------------------------------------------
-- 7: workspace organizations keep their existing directory rules -- no
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
  'the friends-only predicate is vacuously true outside the personal realm'
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
