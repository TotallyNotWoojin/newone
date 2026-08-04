begin;
create extension if not exists pgtap with schema extensions;
select plan(69);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('d1000000-0000-4000-8000-000000000001', 'delegation-owner@example.test', now()),
  ('d1000000-0000-4000-8000-000000000002', 'delegation-manager@example.test', now()),
  ('d1000000-0000-4000-8000-000000000003', 'delegation-expired@example.test', now()),
  ('d1000000-0000-4000-8000-000000000004', 'delegation-revoked@example.test', now()),
  ('d1000000-0000-4000-8000-000000000005', 'delegation-guest@example.test', now()),
  ('d1000000-0000-4000-8000-000000000006', 'delegation-inactive@example.test', now()),
  ('d1000000-0000-4000-8000-000000000007', 'conversation-admin@example.test', now()),
  ('d1000000-0000-4000-8000-000000000008', 'delegation-member@example.test', now());

insert into auth.users (id, email, email_confirmed_at)
select
  ('e1000000-0000-4000-8000-' || lpad(candidate::text, 12, '0'))::uuid,
  'delegation-candidate-' || candidate::text || '@example.test',
  now()
from generate_series(1, 110) candidate;

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('d1100000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('d1100000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000004', now(), now(), 'aal2'),
  ('d1100000-0000-4000-8000-000000000007', 'd1000000-0000-4000-8000-000000000007', now(), now(), 'aal2'),
  ('d1100000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000005', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash,
  user_agent_family
) values
  ('d1100000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'd1200000-0000-4000-8000-000000000002', 'web', decode(repeat('d2', 32), 'hex'), 'desktop'),
  ('d1100000-0000-4000-8000-000000000004', 'd1000000-0000-4000-8000-000000000004', 'd1200000-0000-4000-8000-000000000004', 'web', decode(repeat('d4', 32), 'hex'), 'desktop'),
  ('d1100000-0000-4000-8000-000000000007', 'd1000000-0000-4000-8000-000000000007', 'd1200000-0000-4000-8000-000000000007', 'web', decode(repeat('d7', 32), 'hex'), 'desktop'),
  ('d1100000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000005', 'd1200000-0000-4000-8000-000000000005', 'web', decode(repeat('d5', 32), 'hex'), 'desktop');

update public.profiles
set display_name = 'Delegation fixture ' || right(user_id::text, 2)
where user_id::text like 'd1000000-0000-4000-8000-0000000000%';

update public.profiles
set display_name = 'Candidate ' || right(user_id::text, 12)
where user_id::text like 'e1000000-0000-4000-8000-%';

insert into public.organizations (
  id, slug, name, created_by_user_id, allow_external_guests
) values
  ('d2000000-0000-4000-8000-000000000001', 'delegated-management-a',
    'Delegated management A', 'd1000000-0000-4000-8000-000000000001', true),
  ('d2000000-0000-4000-8000-000000000002', 'delegated-management-b',
    'Delegated management B', 'd1000000-0000-4000-8000-000000000001', false);

insert into public.organization_memberships (
  organization_id, user_id, role, status, membership_type,
  access_expires_at, guest_sponsor_user_id, directory_visibility
) values
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'owner', 'active', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 'member', 'active', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'member', 'active', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', 'member', 'active', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000005', 'member', 'active', 'guest', now() + interval '5 days', 'd1000000-0000-4000-8000-000000000001', 'private'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000006', 'member', 'suspended', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000007', 'member', 'active', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000008', 'member', 'active', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'owner', 'active', 'employee', null, null, 'organization'),
  ('d2000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000002', 'member', 'active', 'employee', null, null, 'organization');

insert into public.organization_memberships (
  organization_id, user_id, role, status, membership_type,
  access_expires_at, guest_sponsor_user_id, directory_visibility, job_title
)
select
  'd2000000-0000-4000-8000-000000000001'::uuid,
  ('e1000000-0000-4000-8000-' || lpad(candidate::text, 12, '0'))::uuid,
  'member', 'active', 'employee', null, null, 'organization', 'Operations'
from generate_series(1, 110) candidate;

update public.organization_memberships
set directory_visibility = 'private'
where organization_id = 'd2000000-0000-4000-8000-000000000001'
  and user_id = 'e1000000-0000-4000-8000-000000000101';

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"d1000000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
update public.organization_memberships
set status = 'suspended', status_change_reason = 'Candidate access suspended'
where organization_id = 'd2000000-0000-4000-8000-000000000001'
  and user_id = 'e1000000-0000-4000-8000-000000000102';
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"d1000000-0000-4000-8000-000000000002","session_id":"d1100000-0000-4000-8000-000000000002","aal":"aal2"}',
  true
);
insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
values (
  'd2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000103'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.organization_units (
  id, organization_id, parent_unit_id, kind, name, created_by_user_id
) values
  ('d3000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', null, 'site', 'Delegated site', 'd1000000-0000-4000-8000-000000000001'),
  ('d3000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd3000000-0000-4000-8000-000000000001', 'department', 'Delegated child', 'd1000000-0000-4000-8000-000000000001'),
  ('d3000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', null, 'site', 'Sibling site', 'd1000000-0000-4000-8000-000000000001'),
  ('d3000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000002', null, 'site', 'Other tenant site', 'd1000000-0000-4000-8000-000000000001');

insert into public.organization_role_assignments (
  id, organization_id, user_id, role_name, scope_type, unit_id,
  granted_by_user_id, grant_reason, granted_at, expires_at,
  revoked_at, revoked_by_user_id, revocation_reason
) values
  ('d4000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000002', 'site_admin', 'unit', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Active delegated site', now() - interval '1 day', null, null, null, null),
  ('d4000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000003', 'site_admin', 'unit', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Expired delegated site', now() - interval '2 days', now() - interval '1 day', null, null, null),
  ('d4000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000004', 'site_admin', 'unit', 'd3000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Revoked delegated site', now() - interval '2 days', null, now() - interval '1 day', 'd1000000-0000-4000-8000-000000000001', 'Delegation revoked');

select throws_ok(
  $$
    insert into public.organization_role_assignments (
      id, organization_id, user_id, role_name, scope_type, unit_id,
      granted_by_user_id, grant_reason
    ) values (
      'd4000000-0000-4000-8000-000000000004',
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000005',
      'site_admin', 'unit', 'd3000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000001', 'Guest must remain denied'
    )
  $$,
  '23514',
  'external guests cannot receive active organization roles',
  'a guest cannot receive the active assignment needed for delegated management'
);

select throws_ok(
  $$
    insert into public.organization_role_assignments (
      id, organization_id, user_id, role_name, scope_type, unit_id,
      granted_by_user_id, grant_reason
    ) values (
      'd4000000-0000-4000-8000-000000000005',
      'd2000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000006',
      'site_admin', 'unit', 'd3000000-0000-4000-8000-000000000001',
      'd1000000-0000-4000-8000-000000000001', 'Inactive must remain denied'
    )
  $$,
  '23514',
  'active role assignment requires current organization access',
  'a suspended member cannot receive an active delegated-management assignment'
);

insert into public.conversations (
  id, organization_id, kind, name, visibility, unit_id, history_policy,
  posting_mode, join_policy, member_limit, created_by_user_id
) values
  ('d5000000-0000-4000-8000-000000000001', 'd2000000-0000-4000-8000-000000000001', 'group', 'Parent group', 'unit', 'd3000000-0000-4000-8000-000000000001', 'since_join', default, default, 50, 'd1000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000002', 'd2000000-0000-4000-8000-000000000001', 'team', 'Child team', 'unit', 'd3000000-0000-4000-8000-000000000002', 'since_join', default, default, 50, 'd1000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000003', 'd2000000-0000-4000-8000-000000000001', 'shift', 'Sibling shift', 'unit', 'd3000000-0000-4000-8000-000000000003', 'since_join', 'all_members', 'invite_only', 50, 'd1000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000004', 'd2000000-0000-4000-8000-000000000001', 'direct', null, 'invite_only', 'd3000000-0000-4000-8000-000000000002', 'all', 'all_members', 'invite_only', 2, 'd1000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000005', 'd2000000-0000-4000-8000-000000000001', 'announcement', 'Organization announcement', 'organization', null, 'all', 'admins_only', 'invite_only', 500, 'd1000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000006', 'd2000000-0000-4000-8000-000000000001', 'announcement', 'Scoped announcement', 'unit', 'd3000000-0000-4000-8000-000000000002', 'all', 'admins_only', 'invite_only', 500, 'd1000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000007', 'd2000000-0000-4000-8000-000000000001', 'group', 'Unscoped group', 'organization', null, 'since_join', default, default, 50, 'd1000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000008', 'd2000000-0000-4000-8000-000000000002', 'group', 'Other tenant group', 'unit', 'd3000000-0000-4000-8000-000000000004', 'since_join', default, default, 50, 'd1000000-0000-4000-8000-000000000001');

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, status, joined_by_user_id
) values
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'owner', 'active', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000007', 'admin', 'active', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000008', 'member', 'active', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001', 'owner', 'active', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000007', 'admin', 'active', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000008', 'member', 'active', 'd1000000-0000-4000-8000-000000000001');

insert into public.conversations (
  id, organization_id, kind, name, visibility, unit_id, history_policy,
  posting_mode, join_policy, member_limit, created_by_user_id,
  incident_severity, incident_classification, closed_at, closed_by_user_id,
  closure_reason
) values (
  'd5000000-0000-4000-8000-000000000009',
  'd2000000-0000-4000-8000-000000000001',
  'incident', 'Closed delegated incident', 'unit',
  'd3000000-0000-4000-8000-000000000002', 'since_join',
  'all_members', 'invite_only', 50,
  'd1000000-0000-4000-8000-000000000001', 'low', 'test', now(),
  'd1000000-0000-4000-8000-000000000001', 'Fixture closed incident'
);

insert into public.conversations (
  id, organization_id, kind, name, visibility, unit_id, history_policy,
  member_limit, created_by_user_id, join_policy
) values (
  'd5000000-0000-4000-8000-000000000010',
  'd2000000-0000-4000-8000-000000000001',
  'group', 'Delegated join group', 'organization',
  'd3000000-0000-4000-8000-000000000002', 'since_join', 50,
  'd1000000-0000-4000-8000-000000000001', 'approval_required'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, status, joined_by_user_id
) values (
  'd2000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000010',
  'd1000000-0000-4000-8000-000000000001',
  'owner', 'active', 'd1000000-0000-4000-8000-000000000001'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, status, can_post,
  joined_by_user_id, left_at
) values (
  'd2000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000104',
  'member', 'removed', false,
  'd1000000-0000-4000-8000-000000000001', now()
);

select ok(
  not has_function_privilege(
    'authenticated',
    'private.actor_can_manage_conversation(uuid,uuid,uuid)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'private.actor_is_current_conversation_admin(uuid,uuid,uuid)',
    'execute'
  ),
  'the canonical conversation-management helper is private'
);
select ok(
  private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000007',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  ),
  'an ordinary current conversation admin retains management'
);
select ok(
  private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  ),
  'a current ordinary member with conversation.manage reaches the exact unit'
);
select ok(
  private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000002'
  ),
  'a delegated unit assignment reaches descendant conversations'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000003'
  ),
  'a delegated unit assignment cannot cross to a sibling unit'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000004'
  ),
  'delegated conversation management never reaches direct messages'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000005'
  ),
  'delegated conversation management never reaches unscoped announcements'
);
select ok(
  private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000006'
  ),
  'a unit-scoped announcement is manageable only inside the delegated unit tree'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000007'
  ),
  'a unit assignment does not reach an unscoped group'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000002',
    'd5000000-0000-4000-8000-000000000008'
  ),
  'a role assignment from one tenant cannot authorize another tenant'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000003',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  ),
  'an expired assignment is denied'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  ),
  'a revoked assignment is denied'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000005',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  ),
  'a guest remains denied and cannot acquire an active delegated assignment'
);
select ok(
  not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000006',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  ),
  'an inactive organization member is denied'
);

select ok(
  private.actor_can_manage_dynamic_group_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  ),
  'unit.manage independently projects dynamic-group eligibility for an ordinary member'
);
select ok(
  private.actor_can_manage_dynamic_group_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000002'
  ),
  'dynamic-group eligibility follows descendants'
);
select ok(
  not private.actor_can_manage_dynamic_group_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000003'
  ),
  'dynamic-group eligibility excludes out-of-scope visible groups'
);
select ok(
  not private.actor_can_manage_dynamic_group_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000004'
  ),
  'dynamic-group eligibility excludes direct messages'
);
select ok(
  not private.actor_can_manage_dynamic_group_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000006'
  ),
  'dynamic-group eligibility excludes announcements'
);
select ok(
  not private.actor_can_manage_dynamic_group_conversation(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000007'
  ),
  'dynamic-group eligibility requires a real conversation unit'
);

create temporary table delegated_policy_spec on commit drop as
select normalized.spec,
  private.dynamic_group_selector_fingerprint(normalized.spec) as fingerprint
from (
  select private.normalize_dynamic_group_policy_spec(jsonb_build_object(
    'unit_ids', jsonb_build_array('d3000000-0000-4000-8000-000000000003'),
    'include_descendants', false,
    'membership_roles', jsonb_build_array('member'),
    'shift_mode', 'none'
  )) as spec
) normalized;

insert into public.dynamic_group_policies (
  id, organization_id, conversation_id, member_roles, status, version,
  created_by_user_id, approved_by_user_id, approved_at,
  policy_spec, draft_state, selector_fingerprint
) values (
  'd5100000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001',
  array['member']::text[], 'active', 1,
  'd1000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000001', now(),
  (select spec from delegated_policy_spec), 'published',
  (select fingerprint from delegated_policy_spec)
);

insert into public.dynamic_group_policy_versions (
  id, organization_id, policy_id, conversation_id, policy_version,
  policy_spec, selector_fingerprint, membership_state_fingerprint,
  evaluated_at, eligible_count, added_count, removed_count, unchanged_count,
  published_by_user_id, published_at
) values (
  'd5200000-0000-4000-8000-000000000001',
  'd2000000-0000-4000-8000-000000000001',
  'd5100000-0000-4000-8000-000000000001',
  'd5000000-0000-4000-8000-000000000001', 1,
  (select spec from delegated_policy_spec),
  (select fingerprint from delegated_policy_spec),
  private.dynamic_group_membership_state_fingerprint(
    'd2000000-0000-4000-8000-000000000001',
    (select spec from delegated_policy_spec), now()
  ), now(), 0, 0, 0, 0,
  'd1000000-0000-4000-8000-000000000001', now()
);

update public.dynamic_group_policies
set published_version_id = 'd5200000-0000-4000-8000-000000000001'
where id = 'd5100000-0000-4000-8000-000000000001';

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"d1000000-0000-4000-8000-000000000002","session_id":"d1100000-0000-4000-8000-000000000002","aal":"aal2"}',
  true
);

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_list_conversation_member_candidates(uuid,uuid,uuid,uuid,text,text,integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_list_conversation_member_candidates(uuid,uuid,uuid,uuid,text,text,integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'private.bff_list_conversation_member_candidates_impl(uuid,uuid,uuid,uuid,text,text,integer)',
    'execute'
  ),
  'candidate RPC entrypoints remain service-only'
);

create temporary table delegated_candidate_page_one on commit drop as
select public.bff_list_conversation_member_candidates(
  'd1000000-0000-4000-8000-000000000002',
  'd2000000-0000-4000-8000-000000000001',
  'd1100000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000002',
  '', null, 100
) as payload;

select ok(
  jsonb_array_length(payload -> 'candidates') = 100
  and nullif(payload ->> 'next_cursor', '') is not null,
  'the first candidate page reaches the 100-row bound and returns a continuation'
)
from delegated_candidate_page_one;

create temporary table delegated_candidate_page_two on commit drop as
select public.bff_list_conversation_member_candidates(
  'd1000000-0000-4000-8000-000000000002',
  'd2000000-0000-4000-8000-000000000001',
  'd1100000-0000-4000-8000-000000000002',
  'd5000000-0000-4000-8000-000000000002',
  '', (select payload ->> 'next_cursor' from delegated_candidate_page_one), 100
) as payload;

select ok(
  jsonb_array_length(page_two.payload -> 'candidates') between 1 and 100
  and page_two.payload -> 'next_cursor' = 'null'::jsonb
  and not exists (
    select 1
    from jsonb_array_elements(page_one.payload -> 'candidates') first_candidate(value)
    join jsonb_array_elements(page_two.payload -> 'candidates') second_candidate(value)
      on first_candidate.value ->> 'user_id' = second_candidate.value ->> 'user_id'
  ),
  'the second keyset page is bounded, terminal, and does not repeat page one'
)
from delegated_candidate_page_one page_one
cross join delegated_candidate_page_two page_two;

select ok(
  not exists (
    select 1
    from (
      select candidate.value
      from delegated_candidate_page_one page,
        lateral jsonb_array_elements(page.payload -> 'candidates') candidate(value)
      union all
      select candidate.value
      from delegated_candidate_page_two page,
        lateral jsonb_array_elements(page.payload -> 'candidates') candidate(value)
    ) all_candidates
    where all_candidates.value ->> 'user_id' in (
      'd1000000-0000-4000-8000-000000000002',
      'd1000000-0000-4000-8000-000000000008',
      'e1000000-0000-4000-8000-000000000101',
      'e1000000-0000-4000-8000-000000000102',
      'e1000000-0000-4000-8000-000000000103',
      'e1000000-0000-4000-8000-000000000104'
    )
  ),
  'candidate pages exclude the actor, active members, private, suspended, blocked, and prior-member identities'
);

select is(
  public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002',
    'd5000000-0000-4000-8000-000000000001', '', null, 50
  ),
  '{"candidates":[],"next_cursor":null}'::jsonb,
  'a published dynamic-policy conversation advertises no manual additions'
);

select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000004','',null,50
  )$$,
  '42501', 'conversation member candidates unavailable',
  'direct-message targets are denied'
);
select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000009','',null,50
  )$$,
  '42501', 'conversation member candidates unavailable',
  'closed conversations are denied'
);
select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000003','',null,50
  )$$,
  '42501', 'conversation member candidates unavailable',
  'out-of-scope conversations are denied'
);
select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000002',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000008','',null,50
  )$$,
  '42501', 'conversation member candidates unavailable',
  'cross-tenant targets are denied'
);
select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000005','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000005','d5000000-0000-4000-8000-000000000002','',null,50
  )$$,
  '42501', 'conversation member candidates unavailable',
  'guest actors are denied'
);

select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002','changed',
    (select payload ->> 'next_cursor' from delegated_candidate_page_one),100
  )$$,
  '22023', 'invalid conversation member candidate cursor',
  'candidate cursors are query-bound'
);
select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002','',
    (select payload ->> 'next_cursor' from delegated_candidate_page_one),99
  )$$,
  '22023', 'invalid conversation member candidate cursor',
  'candidate cursors are page-size-bound'
);
select throws_ok(
  $$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002','',
    (select payload ->> 'next_cursor' from delegated_candidate_page_one) || '$',100
  )$$,
  '22023', 'invalid conversation member candidate cursor',
  'malformed candidate cursors fail closed'
);
select throws_ok(
  $sql$select public.bff_list_conversation_member_candidates(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002','',
    (
      select replace(encode(convert_to(jsonb_set(
        convert_from(decode(payload ->> 'next_cursor', 'base64'), 'UTF8')::jsonb,
        '{snapshot_at}', to_jsonb((now() - interval '1 hour')::text)
      )::text, 'UTF8'), 'base64'), E'\n', '')
      from delegated_candidate_page_one
    ),100
  )$sql$,
  '22023', 'invalid conversation member candidate cursor',
  'stale candidate cursors fail closed'
);

select throws_ok(
  $$select private.bff_add_conversation_member_impl(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002',
    'd1000000-0000-4000-8000-000000000002','member','delegate-self-add',repeat('1',64)
  )$$,
  '42501', 'delegated managers cannot add themselves to conversations',
  'a nonmember delegate cannot self-add by guessing their own identity'
);
select ok(
  not exists (
    select 1 from public.conversation_members member
    where member.organization_id = 'd2000000-0000-4000-8000-000000000001'
      and member.conversation_id = 'd5000000-0000-4000-8000-000000000002'
      and member.user_id = 'd1000000-0000-4000-8000-000000000002'
      and member.status = 'active'
  ),
  'self-add denial leaves the delegate outside conversation membership'
);
select ok(
  (
    select item.value ->> 'management_only' = 'true'
    from jsonb_array_elements(private.bff_bootstrap_messaging_state_v9_impl(
      'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
      'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002',
      null,100,50
    ) -> 'conversations') item(value)
    where item.value ->> 'conversation_id' = 'd5000000-0000-4000-8000-000000000002'
  )
  and jsonb_array_length(private.bff_bootstrap_messaging_state_v9_impl(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002',
    null,100,50
  ) #> '{timeline,messages}') = 0,
  'the denied delegate retains only a management shell with no messages'
);
select is(
  private.bff_add_conversation_member_impl(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000002',
    'e1000000-0000-4000-8000-000000000105','member','delegate-add-other',repeat('2',64)
  ) ->> 'user_id',
  'e1000000-0000-4000-8000-000000000105',
  'a delegate can add another eligible ordinary member'
);
select ok(
  exists (
    select 1 from public.conversation_members member
    where member.organization_id = 'd2000000-0000-4000-8000-000000000001'
      and member.conversation_id = 'd5000000-0000-4000-8000-000000000002'
      and member.user_id = 'e1000000-0000-4000-8000-000000000105'
      and member.status = 'active' and member.role = 'member'
  ),
  'the authorized other-member add is persisted as an ordinary member'
);

create temporary table delegated_self_join_request on commit drop as
select private.bff_request_conversation_join_impl(
  'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
  'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000010',
  'delegate-self-join-request',repeat('3',64)
) as payload;
select is(
  (select payload ->> 'requester_user_id' from delegated_self_join_request),
  'd1000000-0000-4000-8000-000000000002',
  'a delegate can submit the same direct join request as an ordinary nonmember'
);
select is(
  jsonb_array_length(private.bff_list_conversation_join_requests_impl(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002','d5000000-0000-4000-8000-000000000010',100
  ) -> 'join_requests'),
  0,
  'a delegate never receives their own join request in the management queue'
);
select throws_ok(
  $$select private.bff_decide_conversation_join_request_impl(
    'd1000000-0000-4000-8000-000000000002','d2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002',
    (select (payload ->> 'request_id')::uuid from delegated_self_join_request),
    1,'approved','self approval must fail','delegate-self-join-decision',repeat('4',64)
  )$$,
  '42501', 'conversation administrators cannot decide their own join request',
  'a delegate cannot self-approve a direct join request'
);
select ok(
  not exists (
    select 1 from public.conversation_members member
    where member.organization_id = 'd2000000-0000-4000-8000-000000000001'
      and member.conversation_id = 'd5000000-0000-4000-8000-000000000010'
      and member.user_id = 'd1000000-0000-4000-8000-000000000002'
      and member.status = 'active'
  ),
  'self-join decision denial preserves nonmember status'
);
select ok(
  position('for update' in lower(pg_get_functiondef(
    'private.bff_add_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  ))) > 0
  and position('delegated managers cannot add themselves to conversations' in pg_get_functiondef(
    'private.bff_add_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  )) > 0,
  'member addition serializes the conversation limit and contains the self-add guard'
);
select ok(
  position('requester_user_id = p_actor_user_id' in pg_get_functiondef(
    'private.bff_decide_conversation_join_request_impl(uuid,uuid,uuid,uuid,integer,text,text,text,text)'::regprocedure
  )) > 0
  and position('conversation_join_request_eligible' in pg_get_functiondef(
    'private.bff_list_conversation_join_requests_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  )) > 0,
  'join decisions reject self-elevation and the queue rechecks current eligibility'
);

select ok(
  not private.actor_is_current_conversation_admin(
    'd1000000-0000-4000-8000-000000000007',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  )
  and not private.actor_can_manage_conversation(
    'd1000000-0000-4000-8000-000000000007',
    'd2000000-0000-4000-8000-000000000001',
    'd5000000-0000-4000-8000-000000000001'
  )
  and not exists (
    select 1
    from jsonb_array_elements(
      private.bff_bootstrap_messaging_state_v9_impl(
        'd1000000-0000-4000-8000-000000000007',
        'd2000000-0000-4000-8000-000000000001',
        'd1100000-0000-4000-8000-000000000007',
        'd5000000-0000-4000-8000-000000000001', null, 100, 50
      ) -> 'conversations'
    ) item(value)
    where item.value ->> 'conversation_id' =
      'd5000000-0000-4000-8000-000000000001'
  ),
  'a dynamically ineligible admin has no management authority or shell'
);

select throws_ok(
  $$select private.bff_add_conversation_member_impl(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002',
    'd5000000-0000-4000-8000-000000000002',
    'd1000000-0000-4000-8000-000000000008', 'admin',
    'delegate-add-admin', repeat('a', 64)
  )$$,
  '42501', 'delegated managers may add conversation members only',
  'delegated management cannot add an elevated conversation role'
);

select throws_ok(
  $$select private.bff_remove_conversation_member_impl(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002',
    'd5000000-0000-4000-8000-000000000002',
    'd1000000-0000-4000-8000-000000000007',
    'delegate-remove-admin', repeat('b', 64)
  )$$,
  '42501', 'delegated managers may remove ordinary non-policy members only',
  'delegated management cannot remove a conversation administrator'
);

select throws_ok(
  $$select private.bff_remove_conversation_member_impl(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002',
    'd5000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000008',
    'delegate-remove-policy', repeat('c', 64)
  )$$,
  '42501', 'delegated managers may remove ordinary non-policy members only',
  'delegated management cannot remove membership from a published dynamic group'
);

select throws_ok(
  $$select private.bff_add_conversation_member_impl(
    'd1000000-0000-4000-8000-000000000002',
    'd2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000002',
    'd5000000-0000-4000-8000-000000000001',
    'd1000000-0000-4000-8000-000000000008', 'member',
    'delegate-add-policy', repeat('e', 64)
  )$$,
  '42501', 'delegated managers cannot override policy-managed membership',
  'delegated management cannot add membership to a published dynamic group'
);

insert into private.api_idempotency_keys (
  organization_id, actor_user_id, route, idempotency_key, request_sha256,
  state, response_status, response_body, completed_at
) values (
  'd2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000004',
  '/v2/conversations/:id', 'revoked-replay-denial', decode(repeat('d', 64), 'hex'),
  'completed', 200, '{"conversation_id":"d5000000-0000-4000-8000-000000000001","updated":true}'::jsonb,
  now()
);

select throws_ok(
  $$select private.bff_update_conversation_impl(
    'd1000000-0000-4000-8000-000000000004',
    'd2000000-0000-4000-8000-000000000001',
    'd1100000-0000-4000-8000-000000000004',
    'd5000000-0000-4000-8000-000000000001', '{}'::jsonb,
    'revoked-replay-denial', repeat('d', 64)
  )$$,
  '42501', 'conversation administrator permission required',
  'a revoked delegated assignment cannot replay a prior privileged receipt'
);

select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_update_conversation_impl(uuid,uuid,uuid,uuid,jsonb,text,text)'::regprocedure
  )) > 0
  and position('conversation avatar management requires a current conversation administrator' in pg_get_functiondef(
    'private.bff_update_conversation_impl(uuid,uuid,uuid,uuid,jsonb,text,text)'::regprocedure
  )) > 0,
  'metadata update uses canonical management while keeping avatar authority owner/admin-only'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_add_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  )) > 0
  and position('delegated_conversation_management_context' in pg_get_functiondef(
    'private.bff_add_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  )) > 0
  and position('delegated managers may add conversation members only' in pg_get_functiondef(
    'private.bff_add_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  )) > 0
  and position('history_policy' in pg_get_functiondef(
    'private.bff_add_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  )) > 0
  and position('history_visible_from' in pg_get_functiondef(
    'private.bff_add_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  )) > 0,
  'member addition uses canonical authorization, narrow trigger context, and a complete history receipt'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_remove_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure
  )) > 0
  and position('delegated_conversation_management_context' in pg_get_functiondef(
    'private.bff_remove_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure
  )) > 0
  and position('delegated managers may remove ordinary non-policy members only' in pg_get_functiondef(
    'private.bff_remove_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure
  )) > 0
  and position('managed_by_policy_id is null' in pg_get_functiondef(
    'private.bff_remove_conversation_member_impl(uuid,uuid,uuid,uuid,uuid,text,text)'::regprocedure
  )) > 0,
  'member removal uses canonical authorization and rejects elevated or policy-managed targets'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_update_conversation_controls_impl(uuid,uuid,uuid,uuid,text,text,text,text,text,text)'::regprocedure
  )) > 0,
  'group and team controls use canonical authorization'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_decide_conversation_join_request_impl(uuid,uuid,uuid,uuid,integer,text,text,text,text)'::regprocedure
  )) > 0
  and position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_list_conversation_join_requests_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  )) > 0,
  'join-request list and decision use canonical authorization'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_update_conversation_member_role_impl(uuid,uuid,uuid,uuid,uuid,text,text,text,text)'::regprocedure
  )) = 0,
  'delegated management does not reach role mutation'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.is_conversation_admin(uuid,uuid)'::regprocedure
  )) = 0,
  'the global conversation-admin predicate remains unchanged'
);
select ok(
  position('only conversation owners may add another owner' in pg_get_functiondef(
    'private.validate_conversation_member_write()'::regprocedure
  )) > 0
  and position('a managed conversation must retain an active owner' in pg_get_functiondef(
    'private.validate_conversation_member_write()'::regprocedure
  )) > 0
  and position('delegated managers may add conversation members only' in pg_get_functiondef(
    'private.validate_conversation_member_write()'::regprocedure
  )) > 0
  and position('delegated managers may remove ordinary non-policy members only' in pg_get_functiondef(
    'private.validate_conversation_member_write()'::regprocedure
  )) > 0,
  'trigger enforcement retains owner invariants and delegated role/policy bounds'
);
select ok(
  exists (
    select 1 from pg_trigger trigger
    where trigger.tgrelid = 'public.conversation_members'::regclass
      and trigger.tgname = 'conversation_members_05_lock_dynamic_policy'
      and not trigger.tgisinternal
  ),
  'the published dynamic-membership lock remains installed'
);
select ok(
  position('can_manage' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0
  and position('can_manage_conversation' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0
  and position('management_only' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0
  and position('p_conversation_limit - jsonb_array_length(v_conversations)' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0
  and position('dynamic_group_conversation_access_allowed_for_user' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0
  and position('discoverable_conversations' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0,
  'bootstrap separates owner authority, nonmember management shells, discovery, and one bounded collection'
);
select ok(
  position('can_manage_dynamic_group' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0,
  'bootstrap projects dynamic-group management separately'
);
select ok(
  position('''messages'', ''[]''::jsonb' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0
  and position('''can_post'', false' in pg_get_functiondef(
    'private.bff_bootstrap_messaging_state_v9_impl(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0,
  'management-only selection has an empty timeline and cannot post'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_bootstrap_messaging_state(uuid,uuid,uuid,uuid,bigint,integer,integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_bootstrap_messaging_state(uuid,uuid,uuid,uuid,bigint,integer,integer)',
    'execute'
  ),
  'management bootstrap remains service-only'
);
select ok(
  position('bff_bootstrap_messaging_state_v9_impl' in pg_get_functiondef(
    'public.bff_bootstrap_messaging_state(uuid,uuid,uuid,uuid,bigint,integer,integer)'::regprocedure
  )) > 0,
  'the public bootstrap delegates to V9'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_close_incident_impl(uuid,uuid,uuid,uuid,text,text,text)'::regprocedure
  )) = 0
  and position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_set_summary_policy_impl(uuid,uuid,uuid,uuid,text,integer,text,text)'::regprocedure
  )) = 0,
  'incident closure and summary policy remain outside delegated management'
);
select ok(
  position('actor_can_manage_conversation' in pg_get_functiondef(
    'private.bff_create_conversation_avatar_upload_impl(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text)'::regprocedure
  )) = 0,
  'avatar management remains outside delegated management'
);

select * from finish();
rollback;
