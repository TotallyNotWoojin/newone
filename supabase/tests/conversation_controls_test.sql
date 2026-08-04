begin;
create extension if not exists pgtap with schema extensions;
select plan(42);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('a1000000-0000-4000-8000-000000000001', 'controls-owner@example.test', now()),
  ('a1000000-0000-4000-8000-000000000002', 'controls-member@example.test', now()),
  ('a1000000-0000-4000-8000-000000000003', 'controls-requester@example.test', now()),
  ('a1000000-0000-4000-8000-000000000004', 'controls-offboard@example.test', now()),
  ('a1000000-0000-4000-8000-000000000005', 'controls-rejoin@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('a1100000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('a1100000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('a1100000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('a1100000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000003', now(), now(), 'aal2'),
  ('a1100000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000004', now(), now(), 'aal2'),
  ('a1100000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000005', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('a1100000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000001', 'web', decode(repeat('a1', 32), 'hex'), 'desktop'),
  ('a1100000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'a1200000-0000-4000-8000-000000000002', 'web', decode(repeat('a2', 32), 'hex'), 'desktop'),
  ('a1100000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'a1200000-0000-4000-8000-000000000003', 'web', decode(repeat('a3', 32), 'hex'), 'desktop'),
  ('a1100000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000003', 'a1200000-0000-4000-8000-000000000004', 'web', decode(repeat('a4', 32), 'hex'), 'desktop'),
  ('a1100000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000004', 'a1200000-0000-4000-8000-000000000005', 'web', decode(repeat('a5', 32), 'hex'), 'desktop'),
  ('a1100000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000005', 'a1200000-0000-4000-8000-000000000006', 'web', decode(repeat('a6', 32), 'hex'), 'desktop');

insert into public.organizations (
  id, slug, name, created_by_user_id, default_group_join_policy,
  max_pending_join_requests_per_user, join_request_expiry_days
) values (
  'a2000000-0000-4000-8000-000000000001', 'controls-behavior',
  'Controls Behavior', 'a1000000-0000-4000-8000-000000000001',
  'approval_required', 1, 1
);
insert into public.organization_memberships (organization_id, user_id, role) values
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'owner'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'member'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000003', 'member'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000004', 'member'),
  ('a2000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000005', 'member');

insert into public.organization_units (
  id, organization_id, parent_unit_id, kind, name, created_by_user_id
) values
  ('a2100000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', null, 'department', 'Parent unit', 'a1000000-0000-4000-8000-000000000001'),
  ('a2100000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000001', 'team', 'Child unit', 'a1000000-0000-4000-8000-000000000001');
insert into public.organization_unit_members (organization_id, unit_id, user_id) values
  ('a2000000-0000-4000-8000-000000000001', 'a2100000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003');

insert into public.conversations (
  id, organization_id, kind, name, visibility, posting_mode, join_policy,
  history_policy, member_limit, unit_id, created_by_user_id
) values
  ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'group', 'Main group', 'organization', 'all_members', 'inherit', 'since_join', 20, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'group', 'Second group', 'organization', 'all_members', 'approval_required', 'since_join', 20, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001', 'group', 'Full group', 'organization', 'all_members', 'approval_required', 'since_join', 2, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001', 'group', 'Dynamic group', 'organization', 'all_members', 'approval_required', 'since_join', 20, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000005', 'a2000000-0000-4000-8000-000000000001', 'group', 'Offboard group', 'organization', 'all_members', 'approval_required', 'since_join', 20, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000006', 'a2000000-0000-4000-8000-000000000001', 'group', 'Rejoin group', 'organization', 'all_members', 'approval_required', 'since_join', 20, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000007', 'a2000000-0000-4000-8000-000000000001', 'group', 'Policy loss group', 'organization', 'all_members', 'approval_required', 'since_join', 20, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000008', 'a2000000-0000-4000-8000-000000000001', 'direct', null, 'invite_only', 'all_members', 'invite_only', 'all', 2, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000009', 'a2000000-0000-4000-8000-000000000001', 'group', 'Expiry group', 'organization', 'all_members', 'approval_required', 'since_join', 20, null, 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000010', 'a2000000-0000-4000-8000-000000000001', 'group', 'Parent exact scope', 'unit', 'all_members', 'approval_required', 'since_join', 20, 'a2100000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000011', 'a2000000-0000-4000-8000-000000000001', 'group', 'Child exact scope', 'unit', 'all_members', 'approval_required', 'since_join', 20, 'a2100000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001');

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, can_post, status, joined_by_user_id
)
select 'a2000000-0000-4000-8000-000000000001', id,
  'a1000000-0000-4000-8000-000000000001', 'owner', true, 'active',
  'a1000000-0000-4000-8000-000000000001'
from public.conversations
where kind <> 'direct';
insert into public.direct_conversation_pairs (
  organization_id, conversation_id, member_low_user_id, member_high_user_id
) values (
  'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000008',
  'a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, can_post, status, joined_by_user_id, left_at
) values
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002', 'member', true, 'active', 'a1000000-0000-4000-8000-000000000001', null),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'member', true, 'active', 'a1000000-0000-4000-8000-000000000001', null),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'member', true, 'active', 'a1000000-0000-4000-8000-000000000001', null),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000001', 'owner', true, 'active', 'a1000000-0000-4000-8000-000000000001', null),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000008', 'a1000000-0000-4000-8000-000000000002', 'member', true, 'active', 'a1000000-0000-4000-8000-000000000001', null),
  ('a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000005', 'admin', false, 'removed', 'a1000000-0000-4000-8000-000000000001', now());
insert into public.dynamic_group_policies (
  id, organization_id, conversation_id, member_roles, status, created_by_user_id
) values (
  'a3100000-0000-4000-8000-000000000001',
  'a2000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000004',
  array['member']::text[], 'draft', 'a1000000-0000-4000-8000-000000000001'
);

select ok(
  has_function_privilege('service_role', 'public.bff_update_conversation_controls(uuid,uuid,uuid,uuid,text,text,text,text,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.bff_update_conversation_controls(uuid,uuid,uuid,uuid,text,text,text,text,text,text)', 'execute'),
  'conversation controls are service-only RPCs'
);
select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.conversation_join_requests'::regclass)
  and not has_table_privilege('service_role', 'public.conversation_join_requests', 'select'),
  'join requests are forced-RLS and have no direct service-role access'
);

set local role service_role;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal1"}', true);
select throws_ok(
  $$select public.bff_update_conversation_controls('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000002','a3000000-0000-4000-8000-000000000001','admins_only',null,null,'Protected posting change','control-aal1',repeat('1',64))$$,
  '42501', null, 'AAL1 owner cannot update controls'
);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}', true);
select throws_ok(
  $$select public.bff_update_conversation_controls('a1000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000003','a3000000-0000-4000-8000-000000000001','admins_only',null,null,'Unauthorized posting change','control-member',repeat('2',64))$$,
  '42501', null, 'ordinary member cannot update controls'
);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select is(
  public.bff_update_conversation_controls('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','admins_only',null,null,'Operational briefing control','control-admins',repeat('3',64)) ->> 'posting_mode',
  'admins_only', 'AAL2 conversation owner can restrict posting'
);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}', true);
select throws_ok(
  $$select public.bff_send_message('a1000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000003','a3000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000001','text','blocked member post','en',null,null,'{}','post-denied',repeat('4',64))$$,
  '42501', null, 'admins-only mode denies an ordinary member send'
);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select is(
  public.bff_update_conversation_controls('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000001','all_members',null,null,'Briefing is complete','control-all',repeat('5',64)) ->> 'posting_mode',
  'all_members', 'owner restores all-member posting'
);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}', true);
select lives_ok(
  $$select public.bff_send_message('a1000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000003','a3000000-0000-4000-8000-000000000001','a4000000-0000-4000-8000-000000000002','text','restored member post','en',null,null,'{}','post-restored',repeat('6',64))$$,
  'all-members mode permits the member send again'
);
select is((select count(*)::bigint from public.messages where conversation_id='a3000000-0000-4000-8000-000000000001' and kind='system' and body is null and metadata->>'event_type' in ('conversation.posting.admins_only','conversation.posting.all_members')), 2::bigint, 'posting changes create visible content-free system events');
select is((select count(*)::bigint from public.audit_events where organization_id='a2000000-0000-4000-8000-000000000001' and event_type='conversation.controls.updated' and metadata ? 'reason' and not (metadata ? 'body')), 2::bigint, 'posting changes create explicit content-free audit evidence');

select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select lives_ok($$select public.bff_set_member_block('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002',true,'direct-block',repeat('7',64))$$, 'blocking a direct counterpart commits');
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}', true);
select throws_ok(
  $$select public.bff_send_message('a1000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000003','a3000000-0000-4000-8000-000000000008','a4000000-0000-4000-8000-000000000003','text','blocked direct post','en',null,null,'{}','direct-denied',repeat('8',64))$$,
  '42501', null, 'direct block is rechecked by the final message insert gate'
);
select ok(not has_table_privilege('authenticated','public.member_blocks','update'), 'block writes are limited to advisory-locked insert and delete operations');

create temporary table chat05_receipts (name text primary key, payload jsonb);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal2"}', true);
insert into chat05_receipts values ('main-request', public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004','a3000000-0000-4000-8000-000000000001','join-main-1',repeat('9',64)));
select is((select payload->>'status' from chat05_receipts where name='main-request'), 'pending', 'eligible member creates a pending request');
select is(
  public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004','a3000000-0000-4000-8000-000000000001','join-main-2',repeat('a',64)) ->> 'request_id',
  (select payload->>'request_id' from chat05_receipts where name='main-request'),
  'a second key returns the same pending request even at the exact pending limit'
);
select throws_ok(
  $$select public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004','a3000000-0000-4000-8000-000000000002','join-over-budget',repeat('b',64))$$,
  'P0001', null, 'organization-requester budget prevents a different-group overshoot'
);
insert into chat05_receipts values ('main-cancel', public.bff_cancel_conversation_join_request('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004',(select (payload->>'request_id')::uuid from chat05_receipts where name='main-request'),1,'join-cancel',repeat('c',64)));
select is((select payload->>'status' from chat05_receipts where name='main-cancel'), 'cancelled', 'requester cancels with expected-version CAS');
select throws_ok(
  $$select public.bff_cancel_conversation_join_request('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004',(select (payload->>'request_id')::uuid from chat05_receipts where name='main-request'),1,'join-cancel-stale',repeat('d',64))$$,
  '40001', null, 'stale cancellation version is rejected'
);

reset role;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal2"}', true);
select set_config('app.bff_service_context', 'on', true);
insert into public.conversation_join_requests (
  organization_id, conversation_id, requester_user_id, expires_at
) values (
  'a2000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000009',
  'a1000000-0000-4000-8000-000000000003',clock_timestamp()+interval '100 milliseconds'
);
select pg_sleep(0.15);
set local role service_role;
insert into chat05_receipts values ('expiry-replacement', public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004','a3000000-0000-4000-8000-000000000009','join-expiry-replace',repeat('e',64)));
reset role;
select ok(
  (select count(*)=1 from public.conversation_join_requests where conversation_id='a3000000-0000-4000-8000-000000000009' and status='expired')
  and (select count(*)=1 from public.conversation_join_requests where conversation_id='a3000000-0000-4000-8000-000000000009' and status='pending'),
  'expired request is closed before a replacement request is created'
);
set local role service_role;
select throws_ok(
  $$update public.conversation_join_requests set requester_user_id='a1000000-0000-4000-8000-000000000004' where id=(select (payload->>'request_id')::uuid from chat05_receipts where name='expiry-replacement')$$,
  '42501', null, 'RPC-only grants prevent direct request identity mutation'
);

-- Free the single pending slot, then exercise decision authorization and CAS.
select lives_ok($$select public.bff_cancel_conversation_join_request('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004',(select (payload->>'request_id')::uuid from chat05_receipts where name='expiry-replacement'),1,'expiry-cancel',repeat('f',64))$$, 'expiry replacement can be cancelled');
insert into chat05_receipts values ('decision-request', public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004','a3000000-0000-4000-8000-000000000002','join-decision',repeat('0',64)));
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000002","role":"service_role","aal":"aal2"}', true);
select throws_ok(
  $$select public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000002','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000003',(select (payload->>'request_id')::uuid from chat05_receipts where name='decision-request'),1,'approved','Unauthorized approval','decision-member',repeat('1',64))$$,
  '42501', null, 'non-admin cannot decide a request'
);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select is(
  public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',(select (payload->>'request_id')::uuid from chat05_receipts where name='decision-request'),1,'approved','Verified team assignment','decision-owner',repeat('2',64)) ->> 'status',
  'approved', 'AAL2 conversation owner approves exact pending version'
);
select throws_ok(
  $$select public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',(select (payload->>'request_id')::uuid from chat05_receipts where name='decision-request'),1,'approved','Replay with stale version','decision-stale',repeat('3',64))$$,
  '40001', null, 'stale decision version is rejected'
);

select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000004","role":"service_role","aal":"aal2"}', true);
insert into chat05_receipts values ('capacity-request', public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000004','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000005','a3000000-0000-4000-8000-000000000003','join-capacity',repeat('4',64)));
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select throws_ok(
  $$select public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',(select (payload->>'request_id')::uuid from chat05_receipts where name='capacity-request'),1,'approved','Capacity test approval','decision-capacity',repeat('5',64))$$,
  '23514', null, 'conversation row lock protects the member capacity bound'
);
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000003","role":"service_role","aal":"aal2"}', true);
select throws_ok(
  $$select public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000004','a3000000-0000-4000-8000-000000000004','join-dynamic',repeat('6',64))$$,
  '42501', null, 'policy-managed dynamic group denies manual join requests'
);

-- Rejection remains possible after the conversation ceases to be eligible.
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000005","role":"service_role","aal":"aal2"}', true);
insert into chat05_receipts values ('policy-loss-request', public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000005','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000006','a3000000-0000-4000-8000-000000000007','join-policy-loss',repeat('7',64)));
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select lives_ok($$select public.bff_update_conversation_controls('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000007',null,'invite_only','invite_only','Closing discovery','policy-loss-control',repeat('8',64))$$, 'admin can close discovery');
select is(
  public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',(select (payload->>'request_id')::uuid from chat05_receipts where name='policy-loss-request'),1,'rejected','Group is no longer discoverable','policy-loss-reject',repeat('9',64)) ->> 'status',
  'rejected', 'admin can reject a pending request after group eligibility loss'
);

-- Offboarding blocks approval but does not strand the pending request.
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000004","role":"service_role","aal":"aal2"}', true);
select lives_ok($$select public.bff_cancel_conversation_join_request('a1000000-0000-4000-8000-000000000004','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000005',(select (payload->>'request_id')::uuid from chat05_receipts where name='capacity-request'),1,'capacity-cancel',repeat('a',64))$$, 'capacity request cleanup succeeds');
insert into chat05_receipts values ('offboard-request', public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000004','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000005','a3000000-0000-4000-8000-000000000005','join-offboard',repeat('b',64)));
reset role;
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select set_config('app.bff_service_context', 'on', true);
update public.organization_memberships set status='suspended', status_change_reason='Employment ended'
where organization_id='a2000000-0000-4000-8000-000000000001' and user_id='a1000000-0000-4000-8000-000000000004';
set local role service_role;
select throws_ok(
  $$select public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',(select (payload->>'request_id')::uuid from chat05_receipts where name='offboard-request'),1,'approved','Should not approve','offboard-approve',repeat('c',64))$$,
  '42501', null, 'offboarded requester cannot be approved'
);
select is(
  public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',(select (payload->>'request_id')::uuid from chat05_receipts where name='offboard-request'),1,'rejected','Requester is no longer active','offboard-reject',repeat('d',64)) ->> 'status',
  'rejected', 'admin can close an offboarded requester pending row by rejection'
);

select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000005","role":"service_role","aal":"aal2"}', true);
insert into chat05_receipts values ('rejoin-request', public.bff_request_conversation_join('a1000000-0000-4000-8000-000000000005','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000006','a3000000-0000-4000-8000-000000000006','join-reactivate',repeat('e',64)));
select set_config('request.jwt.claims', '{"sub":"a1000000-0000-4000-8000-000000000001","role":"service_role","aal":"aal2"}', true);
select is(
  public.bff_decide_conversation_join_request('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',(select (payload->>'request_id')::uuid from chat05_receipts where name='rejoin-request'),1,'approved','Returning assigned member','rejoin-approve',repeat('f',64)) ->> 'status',
  'approved', 'removed member can be approved through the controlled reactivation path'
);
select ok((select status='active' and role='member' and can_post and history_visible_from is not null and left_at is null from public.conversation_members where conversation_id='a3000000-0000-4000-8000-000000000006' and user_id='a1000000-0000-4000-8000-000000000005'), 'reactivation resets role, posting access, departure state, and since-join history boundary');
select is((select count(*)::bigint from public.messages where conversation_id='a3000000-0000-4000-8000-000000000006' and kind='system' and body is null and metadata->>'event_type'='conversation.join.approved' and metadata->>'target_user_id'='a1000000-0000-4000-8000-000000000005'), 1::bigint, 'approval emits a visible content-free targeted system event');
select ok((select count(*) >= 1 from public.audit_events where organization_id='a2000000-0000-4000-8000-000000000001' and event_type='conversation.join.approved' and metadata->>'reason'='Returning assigned member' and not (metadata ? 'body')), 'approval audit stores explicit reason without message content');

reset role;
select ok(
  not private.conversation_join_request_eligible('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000010')
  and private.conversation_join_request_eligible('a1000000-0000-4000-8000-000000000003','a2000000-0000-4000-8000-000000000001','a3000000-0000-4000-8000-000000000011'),
  'unit discovery uses exact membership rather than implicit descendants'
);

create temporary table chat05_revision_before as select conversation_controls_version from public.organizations where id='a2000000-0000-4000-8000-000000000001';
set local role service_role;
select is(
  public.bff_update_organization_conversation_controls('a1000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000001','a1100000-0000-4000-8000-000000000001',null,null,2,null,'Longer decision window','org-expiry-control',repeat('0',64)) ->> 'join_request_expiry_days',
  '2', 'non-policy organization default update succeeds under AAL2 owner workflow'
);
reset role;
select is((select conversation_controls_version from public.organizations where id='a2000000-0000-4000-8000-000000000001'), (select conversation_controls_version + 1 from chat05_revision_before), 'every organization control update increments durable reconciliation revision');
select ok((select count(*) >= 1 from public.audit_events where organization_id='a2000000-0000-4000-8000-000000000001' and event_type='organization.conversation_controls.updated' and metadata->>'reason'='Longer decision window'), 'organization control change is explicitly audited');
select ok((select count(*) >= 1 from realtime.messages where topic like 'org:a2000000-0000-4000-8000-000000000001:user:%:inbox' and event='workspace.invalidated' and private and payload->>'reason'='organization_conversation_controls_changed' and not (payload ? 'body')), 'non-policy organization default change emits bounded content-free reconciliation invalidation');
select ok((select bool_and(isfinite(requested_at) and isfinite(expires_at) and expires_at <= requested_at + interval '30 days') from public.conversation_join_requests where organization_id='a2000000-0000-4000-8000-000000000001'), 'all durable request timestamps are finite and bounded');
select ok(position(':join-budget:' in pg_get_functiondef('private.bff_request_conversation_join_impl(uuid,uuid,uuid,uuid,text,text)'::regprocedure)) > 0, 'request workflow contains the organization-requester serialization lock for same and different groups');

select * from finish();
rollback;
