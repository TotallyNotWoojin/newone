begin;
select plan(15);

-- Conversation role hardening (20260903030000, part 3): members can never
-- change their own role; only the owner can promote or demote admins;
-- admins may add and remove ordinary members but not owner/admin rows;
-- the owner transfers ownership explicitly (promote, then the new owner
-- demotes the old one); and the sole active owner cannot leave -- neither
-- through the guarded leave command nor through a raw table update --
-- without an active replacement.

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- ---------------------------------------------------------------------------
-- Fixtures: personal realm, Alice + four friends for the role-change group,
-- and a separate Frank/Grace pair for the sole-owner-leave tests.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('ca000000-0000-4000-8000-000000000001', 'ca-alice@example.test', now()),
  ('ca000000-0000-4000-8000-000000000002', 'ca-bob@example.test', now()),
  ('ca000000-0000-4000-8000-000000000003', 'ca-carol@example.test', now()),
  ('ca000000-0000-4000-8000-000000000004', 'ca-dave@example.test', now()),
  ('ca000000-0000-4000-8000-000000000005', 'ca-eve@example.test', now()),
  ('ca000000-0000-4000-8000-000000000006', 'ca-frank@example.test', now()),
  ('ca000000-0000-4000-8000-000000000007', 'ca-grace@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = 'ca_' || case user_id
    when 'ca000000-0000-4000-8000-000000000001' then 'alice'
    when 'ca000000-0000-4000-8000-000000000002' then 'bob'
    when 'ca000000-0000-4000-8000-000000000003' then 'carol'
    when 'ca000000-0000-4000-8000-000000000004' then 'dave'
    when 'ca000000-0000-4000-8000-000000000005' then 'eve'
    when 'ca000000-0000-4000-8000-000000000006' then 'frank'
    else 'grace'
  end
where user_id in (
  'ca000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
  'ca000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000004',
  'ca000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000006',
  'ca000000-0000-4000-8000-000000000007'
);
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal)
select ('ca100000-0000-4000-8000-00000000000' || right(user_id::text, 1))::uuid, user_id, now(), now(), 'aal2'
from unnest(array[
  'ca000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
  'ca000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000004',
  'ca000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000006',
  'ca000000-0000-4000-8000-000000000007'
]::uuid[]) user_id;

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
)
select ('ca100000-0000-4000-8000-00000000000' || right(user_id::text, 1))::uuid, user_id,
  ('ca200000-0000-4000-8000-00000000000' || right(user_id::text, 1))::uuid, 'ios',
  decode(repeat(right(user_id::text, 1) || '1', 32), 'hex'), 'iphone'
from unnest(array[
  'ca000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
  'ca000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000004',
  'ca000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000006',
  'ca000000-0000-4000-8000-000000000007'
]::uuid[]) user_id;

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, 'ca000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
)
select '11111111-1111-4111-8111-111111111111', user_id, 'member', 'active', 'private'
from unnest(array[
  'ca000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
  'ca000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000004',
  'ca000000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000006',
  'ca000000-0000-4000-8000-000000000007'
]::uuid[]) user_id;

-- Alice becomes accepted friends with Bob, Carol, Dave, and Eve so the
-- friends-only rule (part 2) permits the group below.
select public.bff_request_contact(
  'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
  'ca-req-bob', repeat('1', 64)
);
select public.bff_respond_contact(
  'ca000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001',
  'accepted', 'ca-acc-bob', repeat('2', 64)
);
select public.bff_request_contact(
  'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000003',
  'ca-req-carol', repeat('3', 64)
);
select public.bff_respond_contact(
  'ca000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001',
  'accepted', 'ca-acc-carol', repeat('4', 64)
);
select public.bff_request_contact(
  'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000004',
  'ca-req-dave', repeat('5', 64)
);
select public.bff_respond_contact(
  'ca000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000001',
  'accepted', 'ca-acc-dave', repeat('6', 64)
);
select public.bff_request_contact(
  'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000005',
  'ca-req-eve', repeat('7', 64)
);
select public.bff_respond_contact(
  'ca000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000005', 'ca000000-0000-4000-8000-000000000001',
  'accepted', 'ca-acc-eve', repeat('8', 64)
);

-- Frank -- Grace: accepted, for the isolated sole-owner-leave group.
select public.bff_request_contact(
  'ca000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000006', 'ca000000-0000-4000-8000-000000000007',
  'ca-req-frank-grace', repeat('3', 64)
);
select public.bff_respond_contact(
  'ca000000-0000-4000-8000-000000000007', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000007', 'ca000000-0000-4000-8000-000000000006',
  'accepted', 'ca-acc-frank-grace', repeat('4', 64)
);

-- The role-hardening group: Alice (owner), Bob (admin), Carol/Dave/Eve
-- (members).
create temporary table ca_group on commit drop as
select public.bff_create_group_conversation_v2(
  'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000001',
  'Role hardening room', null,
  '[{"user_id":"ca000000-0000-4000-8000-000000000002","role":"admin"},{"user_id":"ca000000-0000-4000-8000-000000000003","role":"member"},{"user_id":"ca000000-0000-4000-8000-000000000004","role":"member"},{"user_id":"ca000000-0000-4000-8000-000000000005","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'ca-create-group', repeat('5', 64)
) as receipt;

-- Dave is promoted to admin by the owner so there are two admins for the
-- "admin cannot touch another admin" tests below.
select public.bff_update_conversation_member_role(
  'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from ca_group),
  'ca000000-0000-4000-8000-000000000004', 'member', 'admin',
  'ca-owner-promotes-dave', repeat('6', 64)
);

-- ---------------------------------------------------------------------------
-- 1: members cannot change their own role -- including an admin trying to
-- promote themselves to owner. The RPC's own admin gate lets an admin
-- actor through; the trigger's self-block is what actually stops this.
-- ---------------------------------------------------------------------------
select throws_ok(
  format(
    $$select public.bff_update_conversation_member_role(
      'ca000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
      'ca100000-0000-4000-8000-000000000002', %L,
      'ca000000-0000-4000-8000-000000000002', 'admin', 'owner',
      'ca-self-promote', repeat('7', 64)
    )$$,
    (select receipt ->> 'conversation_id' from ca_group)
  ),
  '42501', 'members may only change preferences or leave',
  'an admin cannot promote themselves, even to owner'
);

-- ---------------------------------------------------------------------------
-- 2: only the owner can promote a member to admin.
-- ---------------------------------------------------------------------------
select throws_ok(
  format(
    $$select public.bff_update_conversation_member_role(
      'ca000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
      'ca100000-0000-4000-8000-000000000002', %L,
      'ca000000-0000-4000-8000-000000000003', 'member', 'admin',
      'ca-admin-promotes-carol', repeat('8', 64)
    )$$,
    (select receipt ->> 'conversation_id' from ca_group)
  ),
  '42501', 'only conversation owners may manage owner and admin roles',
  'an admin cannot promote another member to admin'
);

-- ---------------------------------------------------------------------------
-- 3: only the owner can demote an admin.
-- ---------------------------------------------------------------------------
select throws_ok(
  format(
    $$select public.bff_update_conversation_member_role(
      'ca000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
      'ca100000-0000-4000-8000-000000000002', %L,
      'ca000000-0000-4000-8000-000000000004', 'admin', 'member',
      'ca-admin-demotes-dave', repeat('9', 64)
    )$$,
    (select receipt ->> 'conversation_id' from ca_group)
  ),
  '42501', 'only conversation owners may manage owner and admin roles',
  'an admin cannot demote another admin'
);

-- ---------------------------------------------------------------------------
-- 4: an admin cannot remove another admin.
-- ---------------------------------------------------------------------------
select throws_ok(
  format(
    $$select public.bff_remove_conversation_member(
      'ca000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
      'ca100000-0000-4000-8000-000000000002', %L,
      'ca000000-0000-4000-8000-000000000004',
      'ca-admin-removes-dave', repeat('a', 64)
    )$$,
    (select receipt ->> 'conversation_id' from ca_group)
  ),
  '42501', 'only conversation owners may manage owner and admin roles',
  'an admin cannot remove another admin'
);

-- ---------------------------------------------------------------------------
-- 5: an admin CAN remove an ordinary member.
-- ---------------------------------------------------------------------------
select is(
  (public.bff_remove_conversation_member(
    'ca000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
    'ca100000-0000-4000-8000-000000000002',
    (select (receipt ->> 'conversation_id')::uuid from ca_group),
    'ca000000-0000-4000-8000-000000000005',
    'ca-admin-removes-eve', repeat('b', 64)
  )) ->> 'removed',
  'true',
  'an admin can remove an ordinary member'
);

-- ---------------------------------------------------------------------------
-- 6/7: the owner CAN promote a member to admin and demote an admin.
-- ---------------------------------------------------------------------------
select is(
  (public.bff_update_conversation_member_role(
    'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'ca100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from ca_group),
    'ca000000-0000-4000-8000-000000000003', 'member', 'admin',
    'ca-owner-promotes-carol', repeat('c', 64)
  )) ->> 'previous_role',
  'member',
  'the owner can promote a member to admin'
);
select is(
  (public.bff_update_conversation_member_role(
    'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'ca100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from ca_group),
    'ca000000-0000-4000-8000-000000000003', 'admin', 'member',
    'ca-owner-demotes-carol', repeat('d', 64)
  )) ->> 'previous_role',
  'admin',
  'the owner can demote an admin back to member'
);

-- ---------------------------------------------------------------------------
-- 8: the owner CAN remove an admin (Dave).
-- ---------------------------------------------------------------------------
select is(
  (public.bff_remove_conversation_member(
    'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'ca100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from ca_group),
    'ca000000-0000-4000-8000-000000000004',
    'ca-owner-removes-dave', repeat('e', 64)
  )) ->> 'removed',
  'true',
  'the owner can remove an admin'
);

-- ---------------------------------------------------------------------------
-- 9: ownership transfers explicitly -- the owner promotes another member to
-- owner, then the NEW owner demotes the original owner (who cannot demote
-- themselves per rule 1).
-- ---------------------------------------------------------------------------
select is(
  (public.bff_update_conversation_member_role(
    'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'ca100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from ca_group),
    'ca000000-0000-4000-8000-000000000002', 'admin', 'owner',
    'ca-transfer-step1-promote-bob', repeat('f', 64)
  )) ->> 'role',
  'owner',
  'the owner explicitly promotes another member to owner (step 1 of a transfer)'
);
select throws_ok(
  format(
    $$select public.bff_update_conversation_member_role(
      'ca000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
      'ca100000-0000-4000-8000-000000000001', %L,
      'ca000000-0000-4000-8000-000000000001', 'owner', 'member',
      'ca-old-owner-self-demote', repeat('1', 64)
    )$$,
    (select receipt ->> 'conversation_id' from ca_group)
  ),
  '42501', 'members may only change preferences or leave',
  'the original owner cannot demote themselves -- the new owner must do it'
);
select is(
  (public.bff_update_conversation_member_role(
    'ca000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
    'ca100000-0000-4000-8000-000000000002',
    (select (receipt ->> 'conversation_id')::uuid from ca_group),
    'ca000000-0000-4000-8000-000000000001', 'owner', 'member',
    'ca-transfer-step2-demote-alice', repeat('2', 64)
  )) ->> 'role',
  'member',
  'the new owner completes the transfer by demoting the original owner (step 2)'
);
select is(
  (select role from public.conversation_members member
   where member.organization_id = '11111111-1111-4111-8111-111111111111'
     and member.conversation_id = (select (receipt ->> 'conversation_id')::uuid from ca_group)
     and member.user_id = 'ca000000-0000-4000-8000-000000000002'),
  'owner',
  'Bob is the sole owner after the completed transfer'
);

-- ---------------------------------------------------------------------------
-- 10: the sole active owner cannot leave without a replacement, through the
-- guarded leave command (Frank/Grace: Frank is the only owner).
-- ---------------------------------------------------------------------------
create temporary table ca_pair_group on commit drop as
select public.bff_create_group_conversation_v2(
  'ca000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
  'ca100000-0000-4000-8000-000000000006',
  'Sole owner room', null,
  '[{"user_id":"ca000000-0000-4000-8000-000000000007","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'ca-create-pair-group', repeat('3', 64)
) as receipt;

select throws_ok(
  format(
    $$select public.bff_leave_conversation(
      'ca000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111111',
      'ca100000-0000-4000-8000-000000000006', %L, null,
      'ca-sole-owner-leave-no-transfer', repeat('4', 64)
    )$$,
    (select receipt ->> 'conversation_id' from ca_pair_group)
  ),
  '42501', 'an active replacement owner is required',
  'the guarded leave command refuses a sole owner departure without a replacement'
);

-- ---------------------------------------------------------------------------
-- 11: the same rule holds against a raw table update that bypasses the
-- guarded command entirely (the gap this migration closes: the trigger's
-- self-service leave branch must still enforce the last-owner invariant).
-- ---------------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"ca000000-0000-4000-8000-000000000006","session_id":"ca100000-0000-4000-8000-000000000006","aal":"aal2"}',
  true
);
select throws_ok(
  format(
    $$update public.conversation_members
      set status = 'left'
      where organization_id = '11111111-1111-4111-8111-111111111111'
        and conversation_id = %L
        and user_id = 'ca000000-0000-4000-8000-000000000006'$$,
    (select receipt ->> 'conversation_id' from ca_pair_group)
  ),
  '23514', 'a managed conversation must retain an active owner',
  'a raw self-service leave by the sole owner is rejected even outside the guarded command'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select status from public.conversation_members member
   where member.organization_id = '11111111-1111-4111-8111-111111111111'
     and member.conversation_id = (select (receipt ->> 'conversation_id')::uuid from ca_pair_group)
     and member.user_id = 'ca000000-0000-4000-8000-000000000006'),
  'active',
  'the sole owner is still an active member after the rejected raw leave attempt'
);

select * from finish();
rollback;
