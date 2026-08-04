begin;
select plan(95);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('9a000000-0000-4000-8000-000000000001', 'group-owner@example.test', now()),
  ('9a000000-0000-4000-8000-000000000002', 'group-admin@example.test', now()),
  ('9a000000-0000-4000-8000-000000000003', 'group-member@example.test', now()),
  ('9a000000-0000-4000-8000-000000000004', 'group-guest@example.test', now()),
  ('9a000000-0000-4000-8000-000000000005', 'expired-contractor@example.test', now()),
  ('9a000000-0000-4000-8000-000000000006', 'invited-guest@example.test', now());

update public.profiles
set display_name = case user_id
    when '9a000000-0000-4000-8000-000000000001' then 'Group Owner'
    when '9a000000-0000-4000-8000-000000000002' then 'Group Admin'
    when '9a000000-0000-4000-8000-000000000003' then 'Group Member'
    when '9a000000-0000-4000-8000-000000000004' then 'External Guest'
    when '9a000000-0000-4000-8000-000000000005' then 'Expired Contractor'
    else 'Invited Guest'
  end,
  preferred_language = case user_id
    when '9a000000-0000-4000-8000-000000000002' then 'ko'
    when '9a000000-0000-4000-8000-000000000003' then 'es'
    else 'en'
  end
where user_id in (
  '9a000000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000002',
  '9a000000-0000-4000-8000-000000000003',
  '9a000000-0000-4000-8000-000000000004',
  '9a000000-0000-4000-8000-000000000005',
  '9a000000-0000-4000-8000-000000000006'
);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('9a100000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('9a100000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('9a100000-0000-4000-8000-000000000003', '9a000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('9a100000-0000-4000-8000-000000000004', '9a000000-0000-4000-8000-000000000004', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values
  ('9a100000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001', '9a200000-0000-4000-8000-000000000001', 'web', decode(repeat('9a', 32), 'hex'), 'desktop'),
  ('9a100000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000002', '9a200000-0000-4000-8000-000000000002', 'web', decode(repeat('9b', 32), 'hex'), 'desktop'),
  ('9a100000-0000-4000-8000-000000000003', '9a000000-0000-4000-8000-000000000003', '9a200000-0000-4000-8000-000000000003', 'ios', decode(repeat('9c', 32), 'hex'), 'iphone'),
  ('9a100000-0000-4000-8000-000000000004', '9a000000-0000-4000-8000-000000000004', '9a200000-0000-4000-8000-000000000004', 'android', decode(repeat('9d', 32), 'hex'), 'android');

insert into public.organizations (
  id, slug, name, created_by_user_id, default_group_join_policy
) values (
  '9a300000-0000-4000-8000-000000000001',
  'group-creation-test', 'Group creation test',
  '9a000000-0000-4000-8000-000000000001', 'approval_required'
);
insert into public.organization_memberships (
  organization_id, user_id, role, status
) values
  ('9a300000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000001', 'owner', 'active'),
  ('9a300000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000002', 'admin', 'active'),
  ('9a300000-0000-4000-8000-000000000001', '9a000000-0000-4000-8000-000000000003', 'member', 'active');

select has_column(
  'public', 'organizations', 'group_creation_policy',
  'organizations configure who may create groups'
);
select has_column(
  'public', 'organization_memberships', 'membership_type',
  'organization memberships distinguish external guests'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_create_group_conversation_v2(uuid,uuid,uuid,text,text,jsonb,text,uuid,text,text,text,text,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_create_group_conversation_v2(uuid,uuid,uuid,text,text,jsonb,text,uuid,text,text,text,text,text,text,text)',
    'execute'
  ),
  'atomic group creation is service-only behind the BFF'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_list_group_creation_candidates(uuid,uuid,uuid,text,integer)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_list_group_creation_candidates(uuid,uuid,uuid,text,integer)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.bff_update_conversation_member_role(uuid,uuid,uuid,uuid,uuid,text,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_update_conversation_member_role(uuid,uuid,uuid,uuid,uuid,text,text,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'private.bff_create_group_conversation_v2_impl(uuid,uuid,uuid,text,text,jsonb,text,uuid,text,text,text,text,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'private.bff_create_group_conversation_v2_impl(uuid,uuid,uuid,text,text,jsonb,text,uuid,text,text,text,text,text,text,text)',
    'execute'
  ),
  'candidate reads and role mutations are service-only BFF capabilities'
);

create temporary table created_group on commit drop as
select public.bff_create_group_conversation_v2(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  'Night shift leads', 'Private coordination for shift leads',
  '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"admin"},{"user_id":"9a000000-0000-4000-8000-000000000003","role":"owner"}]'::jsonb,
  'group', null, 'since_join', 'admins_only', 'inherit',
  null, null, 'group-create-atomic-0001', repeat('1', 64)
) as receipt;

select is(
  (select receipt ->> 'description' from created_group),
  'Private coordination for shift leads',
  'group description is committed by the atomic command'
);
select is(
  (select receipt ->> 'join_policy' from created_group),
  'approval_required',
  'an inherited approval policy is resolved in the authoritative receipt'
);
select is(
  (select receipt ->> 'visibility' from created_group),
  'organization',
  'approval-required groups are discoverable instead of silently invite-only'
);
select is(
  (select count(*)::integer
   from public.conversation_members member
   where member.conversation_id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   ) and member.status = 'active'),
  3,
  'creator and every selected member are committed in one transaction'
);
select is(
  (select role from public.conversation_members member
   where member.conversation_id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   ) and member.user_id = '9a000000-0000-4000-8000-000000000001'),
  'owner',
  'the group creator is always an owner'
);
select is(
  (select role from public.conversation_members member
   where member.conversation_id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   ) and member.user_id = '9a000000-0000-4000-8000-000000000002'),
  'admin',
  'an initial administrator role is atomic rather than a follow-up mutation'
);
select is(
  (select role from public.conversation_members member
   where member.conversation_id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   ) and member.user_id = '9a000000-0000-4000-8000-000000000003'),
  'owner',
  'an authorized group may start with more than one owner'
);
select is(
  (select count(*)::integer from public.messages message
   where message.conversation_id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   ) and message.kind = 'system'),
  3,
  'creation and each initial membership produce visible system events'
);
select ok(
  exists (
    select 1 from public.audit_events event
    where event.event_type = 'conversation.group.created'
      and event.target_id = (
        select receipt ->> 'conversation_id' from created_group
      )
      and (event.metadata ->> 'member_count')::integer = 3
      and event.metadata ->> 'join_policy' = 'approval_required'
  ),
  'atomic group creation produces a bounded administrative audit event'
);
select is(
  (public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'Night shift leads', 'Private coordination for shift leads',
    '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"admin"},{"user_id":"9a000000-0000-4000-8000-000000000003","role":"owner"}]'::jsonb,
    'group', null, 'since_join', 'admins_only', 'inherit', null, null,
    'group-create-atomic-0001', repeat('1', 64)
  ) ->> 'conversation_id')::uuid,
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  'an exact idempotent replay returns the original group without duplicates'
);

select set_config('app.bff_service_context', 'on', true);
select set_config('app.organization_policy_context', 'on', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000001","session_id":"9a100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
update public.organizations
set group_creation_policy = 'admins'
where id = '9a300000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('app.organization_policy_context', 'off', true);
select set_config('app.bff_service_context', 'off', true);
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000003',
    'Unauthorized member group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'group-create-member-denied', repeat('2', 64)
  )$$,
  '42501', 'group creation is not permitted',
  'organization policy can restrict group creation to administrators'
);
select is(
  (select count(*)::integer from public.conversations
   where name = 'Unauthorized member group'),
  0,
  'a denied group command leaves no partial conversation behind'
);

select set_config('app.bff_service_context', 'on', true);
select set_config('app.organization_policy_context', 'on', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000001","session_id":"9a100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
update public.organizations
set allow_external_guests = true
where id = '9a300000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('app.organization_policy_context', 'off', true);
select set_config('app.bff_service_context', 'off', true);
insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility,
  membership_type, access_expires_at, guest_sponsor_user_id,
  joined_at
) values (
  '9a300000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000004',
  'member', 'active', 'private', 'guest', now() + interval '30 days',
  '9a000000-0000-4000-8000-000000000001', now()
);
select set_config('app.bff_service_context', 'on', true);
select set_config('app.organization_policy_context', 'on', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000001","session_id":"9a100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
update public.organizations
set allow_external_guests = false
where id = '9a300000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('app.organization_policy_context', 'off', true);
select set_config('app.bff_service_context', 'off', true);
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'Guest disabled group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000004","role":"member"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'group-create-guest-disabled', repeat('3', 64)
  )$$,
  '42501', 'initial group membership is not permitted',
  'external guests fail closed while the organization feature is disabled'
);
select is(
  (select count(*)::integer from public.conversations
   where name = 'Guest disabled group'),
  0,
  'a rejected guest assignment leaves no partial group behind'
);

select set_config('app.bff_service_context', 'on', true);
select set_config('app.organization_policy_context', 'on', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000001","session_id":"9a100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
update public.organizations
set allow_external_guests = true
where id = '9a300000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('app.organization_policy_context', 'off', true);
select set_config('app.bff_service_context', 'off', true);
create temporary table guest_group on commit drop as
select public.bff_create_group_conversation_v2(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  'Vendor installation room', 'Named and time-bounded guest scope',
  '[{"user_id":"9a000000-0000-4000-8000-000000000004","role":"member"}]'::jsonb,
  'group', null, 'since_join', 'all_members', 'invite_only', null, null,
  'group-create-guest-allowed', repeat('4', 64)
) as receipt;
select is(
  (select member.role from guest_group,
   public.conversation_members member
   where member.conversation_id = (receipt ->> 'conversation_id')::uuid
     and member.user_id = '9a000000-0000-4000-8000-000000000004'),
  'member',
  'an enabled external guest is scoped to a named group as a non-admin member'
);
select ok(
  not private.direct_pair_policy_permitted(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004'
  ),
  'external guests cannot participate in direct-message discovery or creation'
);
select ok(
  not private.dynamic_group_candidate_membership_allowed(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004', now()
  ),
  'external guests are excluded before dynamic-group materialization'
);
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'Guest elevated group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000004","role":"admin"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'group-create-guest-admin-denied', repeat('5', 64)
  )$$,
  '42501', 'initial group membership is not permitted',
  'an external guest cannot be elevated to a group administrator'
);

select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'Duplicate assignment group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"admin"},{"user_id":"9a000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'group-create-duplicate-denied', repeat('6', 64)
  )$$,
  '22023', 'invalid initial group member assignments',
  'duplicate initial identities cannot race role assignment ordering'
);
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'Creator duplicated group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000001","role":"owner"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only', null, null,
    'group-create-creator-duplicate', repeat('7', 64)
  )$$,
  '22023', 'invalid initial group member assignments',
  'the creator cannot be duplicated inside the selected assignment set'
);

select ok(
  not private.organization_membership_access_current(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004',
    now() + interval '31 days'
  ),
  'guest access fails closed at the exact configured expiration boundary'
);
select is(
  private.authorize_bff_request_internal(
    '9a000000-0000-4000-8000-000000000004',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000004',
    'workspace.read', false, 0
  ) ->> 'allowed',
  'true',
  'a not-yet-expired guest session remains usable only for its named scope'
);

select set_config('app.bff_service_context', 'on', true);
select set_config('app.organization_policy_context', 'on', true);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000001","session_id":"9a100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
update public.organizations
set group_creation_policy = 'members'
where id = '9a300000-0000-4000-8000-000000000001';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('app.organization_policy_context', 'off', true);
select set_config('app.bff_service_context', 'off', true);

select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.bff_list_group_creation_candidates(
      '9a000000-0000-4000-8000-000000000003',
      '9a300000-0000-4000-8000-000000000001',
      '9a100000-0000-4000-8000-000000000003', null, 100
    ) -> 'candidates') candidate
    where candidate ->> 'user_id' = '9a000000-0000-4000-8000-000000000004'
  ),
  'an ordinary group creator cannot discover an unrelated private guest'
);
select ok(
  exists (
    select 1
    from jsonb_array_elements(public.bff_list_group_creation_candidates(
      '9a000000-0000-4000-8000-000000000001',
      '9a300000-0000-4000-8000-000000000001',
      '9a100000-0000-4000-8000-000000000001', 'external', 100
    ) -> 'candidates') candidate
    where candidate ->> 'user_id' = '9a000000-0000-4000-8000-000000000004'
      and candidate ->> 'membership_type' = 'guest'
      and candidate ->> 'access_expires_at' is not null
  ),
  'a sponsor receives the bounded guest label and expiration needed for safe selection'
);
select ok(
  private.can_view_org_member_for_actor(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004',
    '9a000000-0000-4000-8000-000000000001', now()
  ),
  'a guest can identify a colleague in the same named conversation'
);
select ok(
  not private.can_view_org_member_for_actor(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004',
    '9a000000-0000-4000-8000-000000000002', now()
  ),
  'a guest cannot browse unrelated organization-directory members'
);

select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'Malformed ordinary group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
    'group', null, 'since_join', 'all_members', 'invite_only',
    'high', 'should-not-exist', 'group-create-malformed-incident-pair', repeat('8', 64)
  )$$,
  '22023', 'invalid group creation policy',
  'non-incident groups reject every incident-field combination'
);
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'Malformed incident', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
    'incident', null, 'since_join', 'admins_only', 'invite_only',
    'high', null, 'group-create-missing-incident-class', repeat('9', 64)
  )$$,
  '22023', 'invalid group creation policy',
  'incidents require both a valid severity and classification'
);

insert into public.organization_units (
  id, organization_id, kind, name, created_by_user_id
) values (
  '9a400000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  'team', 'Restricted unit', '9a000000-0000-4000-8000-000000000001'
);
select throws_ok(
  $$select public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000003',
    'Cross-unit group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
    'group', '9a400000-0000-4000-8000-000000000001',
    'since_join', 'all_members', 'invite_only', null, null,
    'group-create-cross-unit-denied', repeat('a', 64)
  )$$,
  '42501', 'group creator is not authorized for organization unit',
  'a creator cannot claim an active unit they do not belong to or manage'
);
select is(
  (select count(*)::integer from public.conversations
   where name = 'Cross-unit group'),
  0,
  'a cross-unit rejection leaves no partial conversation'
);
insert into public.organization_unit_members (
  organization_id, unit_id, user_id
) values (
  '9a300000-0000-4000-8000-000000000001',
  '9a400000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000003'
);
select is(
  public.bff_create_group_conversation_v2(
    '9a000000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000003',
    'Authorized unit group', null,
    '[{"user_id":"9a000000-0000-4000-8000-000000000002","role":"member"}]'::jsonb,
    'group', '9a400000-0000-4000-8000-000000000001',
    'since_join', 'all_members', 'invite_only', null, null,
    'group-create-unit-allowed', repeat('b', 64)
  ) ->> 'visibility',
  'unit',
  'an actual unit member may create a correctly unit-scoped group'
);

select throws_ok(
  $$insert into public.organization_memberships (
    organization_id, user_id, role, status, membership_type,
    joined_at, access_expires_at
  ) values (
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000005', 'member', 'active',
    'contractor', now() - interval '2 days', now() - interval '1 day'
  )$$,
  '23514', 'contractor access expiration must be future-bounded',
  'a contractor cannot be inserted with access that is already expired'
);

create temporary table added_member on commit drop as
select public.bff_add_conversation_member(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  '9a000000-0000-4000-8000-000000000004', 'member',
  'group-member-add-event-0001', repeat('c', 64)
) as receipt;
select is(
  (select receipt ->> 'role' from added_member), 'member',
  'later group membership additions return an authoritative role receipt'
);
select ok(
  exists (
    select 1 from public.messages message
    where message.conversation_id = (
      select (receipt ->> 'conversation_id')::uuid from created_group
    ) and message.kind = 'system'
      and message.metadata ->> 'event_type' = 'conversation.member.added'
      and message.metadata ->> 'target_user_id' =
        '9a000000-0000-4000-8000-000000000004'
  ),
  'later membership additions are visible as target-bound system events'
);

create temporary table changed_role on commit drop as
select public.bff_update_conversation_member_role(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  '9a000000-0000-4000-8000-000000000002', 'admin', 'member',
  'group-member-role-cas-0001', repeat('d', 64)
) as receipt;
select is(
  (select receipt ->> 'previous_role' from changed_role), 'admin',
  'role changes return the compare-and-swap predecessor'
);
select is(
  (select role from public.conversation_members member
   where member.conversation_id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   ) and member.user_id = '9a000000-0000-4000-8000-000000000002'),
  'member',
  'the role mutation commits exactly the requested successor role'
);
select ok(
  exists (
    select 1 from public.messages message
    where message.conversation_id = (
      select (receipt ->> 'conversation_id')::uuid from created_group
    ) and message.kind = 'system'
      and message.metadata ->> 'event_type' = 'conversation.member.role_changed'
      and message.metadata ->> 'target_user_id' =
        '9a000000-0000-4000-8000-000000000002'
  ),
  'role changes are visible without exposing arbitrary system-message metadata'
);

create temporary table removed_member on commit drop as
select public.bff_remove_conversation_member(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  '9a000000-0000-4000-8000-000000000004',
  'group-member-remove-event-0001', repeat('e', 64)
) as receipt;
select is(
  (select receipt ->> 'removed' from removed_member), 'true',
  'later group member removal returns an authoritative receipt'
);
select ok(
  exists (
    select 1 from public.messages message
    where message.conversation_id = (
      select (receipt ->> 'conversation_id')::uuid from created_group
    ) and message.kind = 'system'
      and message.metadata ->> 'event_type' = 'conversation.member.removed'
      and message.metadata ->> 'target_user_id' =
        '9a000000-0000-4000-8000-000000000004'
  ),
  'later member removals remain visible to the conversation after access ends'
);

select has_column(
  'public', 'organization_invites', 'membership_access_expires_at',
  'invitations carry the exact bounded membership access scope'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_issue_organization_invite_v2(uuid,uuid,uuid,text,text,uuid,text,text,text,integer,text,timestamp with time zone,uuid,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_issue_organization_invite_v2(uuid,uuid,uuid,text,text,uuid,text,text,text,integer,text,timestamp with time zone,uuid,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'private.bff_issue_organization_invite_v2_impl(uuid,uuid,uuid,text,text,uuid,text,text,text,integer,text,timestamp with time zone,uuid,text,text)',
    'execute'
  ),
  'scoped employee, contractor, and guest invitations remain BFF-only'
);
select throws_ok(
  $$select public.bff_issue_organization_invite_v2(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    'email', 'invited-guest@example.test',
    '9a000000-0000-4000-8000-000000000006', null, 'otp', 'member', 3600,
    'employee', now() + interval '30 days', null,
    'employee-invite-expiry-denied', repeat('2a', 32)
  )$$,
  '22023', 'invalid invitation membership scope',
  'employee invitations cannot smuggle a temporary-access or sponsor scope'
);
create temporary table issued_guest_invite on commit drop as
select public.bff_issue_organization_invite_v2(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  'email', 'invited-guest@example.test',
  '9a000000-0000-4000-8000-000000000006', null, 'otp', 'member', 3600,
  'guest', now() + interval '30 days',
  '9a000000-0000-4000-8000-000000000001',
  'guest-invite-scoped-0001', repeat('2b', 32)
) as receipt;
select is(
  (select receipt ->> 'membership_type' from issued_guest_invite),
  'guest',
  'guest invitation receipt discloses the temporary membership type'
);
select ok(
  exists (
    select 1 from public.organization_invites invitation
    where invitation.id = (
      select (receipt ->> 'invite_id')::uuid from issued_guest_invite
    ) and invitation.membership_type = 'guest'
      and invitation.membership_access_expires_at > invitation.expires_at
      and invitation.guest_sponsor_user_id =
        '9a000000-0000-4000-8000-000000000001'
  ),
  'the persisted invite binds expiry and sponsor before token redemption'
);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000006"}',
  true
);
create temporary table redeemed_guest on commit drop as
select public.redeem_organization_invite(
  (select receipt ->> 'token' from issued_guest_invite), null
) as receipt;
select is(
  (select receipt ->> 'membership_type' from redeemed_guest),
  'guest',
  'verified single-use redemption propagates the guest scope atomically'
);
select ok(
  exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id =
        '9a300000-0000-4000-8000-000000000001'
      and membership.user_id = '9a000000-0000-4000-8000-000000000006'
      and membership.status = 'active'
      and membership.role = 'member'
      and membership.directory_visibility = 'private'
      and membership.membership_type = 'guest'
      and membership.access_expires_at > now()
      and membership.guest_sponsor_user_id =
        '9a000000-0000-4000-8000-000000000001'
  ),
  'redeemed guests are private, sponsored, non-admin, and time-bounded'
);
select throws_ok(
  $$select public.redeem_organization_invite(
    (select receipt ->> 'token' from issued_guest_invite), null
  )$$,
  '42501', 'invitation is invalid or expired',
  'a scoped guest invitation remains single-use after successful redemption'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_create_conversation_avatar_upload(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_create_conversation_avatar_upload(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.bff_activate_conversation_avatar(uuid,uuid,uuid,uuid,uuid,text,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.bff_remove_conversation_avatar(uuid,uuid,uuid,uuid,text,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.bff_authorize_conversation_avatar_download(uuid,uuid,uuid,uuid,uuid)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'private.bff_create_conversation_avatar_upload_impl(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text)',
    'execute'
  ),
  'conversation avatar grant, activation, and removal stay behind the BFF'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.scrub_conversation_avatar_candidates_internal(integer,timestamp with time zone)',
    'execute'
  ) and not has_function_privilege(
    'service_role',
    'private.scrub_conversation_avatar_candidates_internal(integer,timestamp with time zone)',
    'execute'
  ) and has_function_privilege(
    'service_role', 'private.bff_scrub_retention_impl(integer)', 'execute'
  ) and has_function_privilege(
    'authenticated', 'private.storage_download_authorized(text)', 'execute'
  ) and not has_function_privilege(
    'anon', 'private.storage_download_authorized(text)', 'execute'
  ),
  'avatar retention helpers and storage predicates expose only their required roles'
);
create temporary table avatar_upload on commit drop as
select public.bff_create_conversation_avatar_upload(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  'night-shift.png', 'image/png', 128, repeat('f', 64),
  'group-avatar-upload-0001', repeat('1a', 32)
) as receipt;
select ok(
  (select receipt ->> 'scan_status' = 'pending'
      and receipt ->> 'bucket_id' = 'message-attachments'
      and (receipt ->> 'maximum_byte_size')::integer = 5242880
   from avatar_upload),
  'avatar upload grants are image-only, private, bounded, and pending scan'
);
select ok(
  (select not isfinite(message.available_at)
      and message.metadata = jsonb_build_object('purpose', 'conversation_avatar')
   from public.messages message
   where message.id = (
     select (receipt ->> 'message_id')::bigint from avatar_upload
   )),
  'avatar candidates are permanently unavailable to the ordinary message channel'
);
select throws_ok(
  $$select public.bff_create_conversation_avatar_upload(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from created_group),
    'not-an-avatar.pdf', 'application/pdf', 128, repeat('e', 64),
    'group-avatar-pdf-denied', repeat('1b', 32)
  )$$,
  '22023', 'invalid conversation avatar upload metadata',
  'non-image attachments cannot enter the group-avatar workflow'
);
select is(
  public.bff_finalize_attachment_upload(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'attachment_id')::uuid from avatar_upload),
    'message-attachments',
    (select receipt ->> 'storage_path' from avatar_upload),
    128, repeat('f', 64),
    'group-avatar-finalize-0001', repeat('1c', 32)
  ) ->> 'scan_queued',
  'true',
  'avatar bytes enter the same mandatory malware-scan queue as message media'
);
create temporary table avatar_scan_claim on commit drop as
select public.bff_claim_attachment_scan_jobs(
  '9a500000-0000-4000-8000-000000000001', 10, 300
) as receipt;
select is(
  public.bff_complete_attachment_scan(
    '9a500000-0000-4000-8000-000000000001',
    (select (job ->> 'id')::bigint
     from avatar_scan_claim,
     jsonb_array_elements(receipt -> 'jobs') job
     where job -> 'payload' ->> 'attachment_id' =
       (select receipt ->> 'attachment_id' from avatar_upload)),
    (select (receipt ->> 'attachment_id')::uuid from avatar_upload),
    'clean', 'image/png', null, 'test-scanner', '1.0'
  ) ->> 'scan_status',
  'clean',
  'only a clean scanner verdict makes an avatar attachment activatable'
);
select is(
  public.bff_authorize_attachment_download(
    '9a000000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000003',
    (select (receipt ->> 'attachment_id')::uuid from avatar_upload)
  ) ->> 'authorized',
  'false',
  'the generic BFF attachment route cannot download an avatar candidate'
);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000003","session_id":"9a100000-0000-4000-8000-000000000003","aal":"aal1"}',
  true
);
select is(
  private.storage_download_authorized(
    (select receipt ->> 'storage_path' from avatar_upload)
  ),
  false,
  'storage RLS also denies a clean avatar candidate outside the dedicated route'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table activated_avatar on commit drop as
select public.bff_activate_conversation_avatar(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  (select (receipt ->> 'attachment_id')::uuid from avatar_upload),
  null, 'group-avatar-activate-0001', repeat('1d', 32)
) as receipt;
select is(
  (select receipt ->> 'activated' from activated_avatar), 'true',
  'a clean same-conversation image activates through compare-and-swap'
);
select is(
  (select conversation.avatar_path
   from public.conversations conversation
   where conversation.id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   )),
  (select receipt ->> 'storage_path' from avatar_upload),
  'the group stores only the scanner-authorized private object path'
);
select is(
  public.bff_authorize_conversation_avatar_download(
    '9a000000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000003',
    (select (receipt ->> 'conversation_id')::uuid from created_group),
    (select (receipt ->> 'attachment_id')::uuid from avatar_upload)
  ) ->> 'authorized',
  'true',
  'a current group member can receive an inline grant for the active clean avatar'
);
select throws_ok(
  $$select public.bff_update_conversation(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from created_group),
    '{"avatar_path":"arbitrary/unscanned/path"}'::jsonb,
    'group-avatar-raw-path-denied', repeat('1e', 32)
  )$$,
  '42501', 'conversation avatars require the scanned activation workflow',
  'generic conversation patches cannot inject an unscanned avatar path'
);
select throws_ok(
  $$update public.messages message
    set deleted_at = now(), body = null, deleted_by_user_id = null,
      deletion_reason = 'retention'
    where message.id = (select (receipt ->> 'message_id')::bigint from avatar_upload)$$,
  '23514', 'active conversation avatar must be replaced or removed first',
  'retention cannot purge the message object backing an active avatar'
);
select ok(
  exists (
    select 1 from public.messages message
    where message.conversation_id = (
      select (receipt ->> 'conversation_id')::uuid from created_group
    ) and message.metadata =
      jsonb_build_object('event_type', 'conversation.avatar.changed')
  ),
  'avatar activation produces a visible bounded system event'
);

-- Materialize retention candidates while the conversation is still writable,
-- as the production avatar-upload workflow does. Later assertions archive the
-- conversation and verify that the already-created candidates are handled
-- without weakening the posting serializer for service-role fixture writes.
create temporary table stale_avatar_messages (
  candidate text primary key,
  message_id bigint not null,
  attachment_id uuid not null,
  storage_path text not null
) on commit drop;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"9a000000-0000-4000-8000-000000000001","session_id":"9a100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
with inserted as (
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, kind, body,
    language_detection_state, language_detection_method,
    language_detected_at, available_at, metadata
  ) values (
    '9a300000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from created_group),
    '9a000000-0000-4000-8000-000000000001', 'attachment', null,
    'not_applicable', 'system', now(), 'infinity'::timestamptz,
    jsonb_build_object('purpose', 'conversation_avatar')
  )
  returning id
)
insert into stale_avatar_messages (candidate, message_id, attachment_id, storage_path)
select 'active', inserted.id,
  '9a600000-0000-4000-8000-000000000001'::uuid,
  '9a300000-0000-4000-8000-000000000001/'
    || (select receipt ->> 'conversation_id' from created_group)
    || '/9a000000-0000-4000-8000-000000000001/'
    || '9a600000-0000-4000-8000-000000000001/upload'
from inserted;
with inserted as (
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, kind, body,
    language_detection_state, language_detection_method,
    language_detected_at, available_at, metadata
  ) values (
    '9a300000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from created_group),
    '9a000000-0000-4000-8000-000000000001', 'attachment', null,
    'not_applicable', 'system', now(), 'infinity'::timestamptz,
    jsonb_build_object('purpose', 'conversation_avatar')
  )
  returning id
)
insert into stale_avatar_messages (candidate, message_id, attachment_id, storage_path)
select 'inactive', inserted.id,
  '9a600000-0000-4000-8000-000000000002'::uuid,
  '9a300000-0000-4000-8000-000000000001/'
    || (select receipt ->> 'conversation_id' from created_group)
    || '/9a000000-0000-4000-8000-000000000001/'
    || '9a600000-0000-4000-8000-000000000002/upload'
from inserted;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  storage_path, file_name, mime_type, byte_size, sha256_hex
)
select candidate.attachment_id,
  '9a300000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  candidate.message_id, '9a000000-0000-4000-8000-000000000001',
  candidate.storage_path, candidate.candidate || '.png', 'image/png', 128,
  repeat(case candidate.candidate when 'active' then 'a' else 'b' end, 64)
from stale_avatar_messages candidate;

-- Only the two synthetic TTL candidates are old. The previously removed real
-- avatar upload remains younger than the candidate TTL and must not inflate
-- this retention pass.
alter table public.messages disable trigger messages_10_validate_update;
update public.messages message
set created_at = now() - interval '25 hours'
where message.id in (
  select candidate.message_id from stale_avatar_messages candidate
);
alter table public.messages enable trigger messages_10_validate_update;

update public.conversations conversation
set is_archived = true
where conversation.id = (
  select (receipt ->> 'conversation_id')::uuid from created_group
);
select throws_ok(
  $$select public.bff_activate_conversation_avatar(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    (select (receipt ->> 'conversation_id')::uuid from created_group),
    (select (receipt ->> 'attachment_id')::uuid from avatar_upload),
    (select receipt ->> 'avatar_path' from activated_avatar),
    'group-avatar-archived-activate-denied', repeat('20', 32)
  )$$,
  '42501', 'active group conversation required',
  'archived or closed conversations reject avatar activation even for an administrator'
);
create temporary table removed_avatar on commit drop as
select public.bff_remove_conversation_avatar(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  (select (receipt ->> 'conversation_id')::uuid from created_group),
  (select receipt ->> 'avatar_path' from activated_avatar),
  'group-avatar-remove-0001', repeat('1f', 32)
) as receipt;
select is(
  (select receipt ->> 'removed' from removed_avatar), 'true',
  'group administrators can explicitly remove the active avatar with CAS'
);
select is(
  (select conversation.avatar_path
   from public.conversations conversation
   where conversation.id = (
     select (receipt ->> 'conversation_id')::uuid from created_group
   )),
  null,
  'avatar removal clears the active path without deleting audit history'
);
select is(
  public.bff_authorize_conversation_avatar_download(
    '9a000000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000003',
    (select (receipt ->> 'conversation_id')::uuid from created_group),
    (select (receipt ->> 'attachment_id')::uuid from avatar_upload)
  ) ->> 'authorized',
  'false',
  'removing an avatar immediately revokes new inline grants for the old object'
);
select ok(
  exists (
    select 1 from public.messages message
    where message.conversation_id = (
      select (receipt ->> 'conversation_id')::uuid from created_group
    ) and message.metadata =
      jsonb_build_object('event_type', 'conversation.avatar.removed')
  ),
  'avatar removal is also visible to current group members'
);
select ok(
  exists (
    select 1 from public.audit_events audit
    where audit.organization_id = '9a300000-0000-4000-8000-000000000001'
      and audit.event_type = 'conversation.avatar.removed'
      and audit.target_id = (
        select receipt ->> 'conversation_id' from created_group
      )
      and audit.metadata ->> 'reason' = 'data_minimization'
      and (audit.metadata ->> 'lifecycle_override')::boolean
  ),
  'post-archive avatar removal is an explicit audited data-minimization exception'
);
select set_config('app.conversation_avatar_context', 'on', true);
update public.conversations conversation
set avatar_path = candidate.storage_path
from stale_avatar_messages candidate
where conversation.id = (
    select (receipt ->> 'conversation_id')::uuid from created_group
  ) and candidate.candidate = 'active';
select set_config('app.conversation_avatar_context', 'off', true);
select is(
  private.scrub_conversation_avatar_candidates_internal(
    10, now()
  ),
  1,
  'the short avatar-candidate retention pass scrubs only inactive expired candidates'
);
select ok(
  exists (
    select 1
    from stale_avatar_messages candidate
    join public.messages message on message.id = candidate.message_id
    join public.message_attachments attachment
      on attachment.id = candidate.attachment_id
    where candidate.candidate = 'inactive'
      and message.deleted_at is not null
      and attachment.scan_status = 'quarantined'
      and attachment.purge_requested_at is not null
  ),
  'expired inactive avatar candidates enter the existing storage-purge workflow'
);
select ok(
  exists (
    select 1
    from stale_avatar_messages candidate
    join public.messages message on message.id = candidate.message_id
    join public.message_attachments attachment
      on attachment.id = candidate.attachment_id
    where candidate.candidate = 'active'
      and message.deleted_at is null
      and attachment.purge_requested_at is null
  ),
  'the active avatar backing message and object are preserved past candidate TTL'
);

-- Delayed transport work must re-check the canonical organization-access
-- boundary. A stale active membership, conversation row, announcement
-- snapshot, device, or socket topic is never an authorization source.
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values (
  '9ad00000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000005', now(), now(), 'aal1'
);
insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values (
  '9ad00000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000005',
  '9ad10000-0000-4000-8000-000000000001',
  'web', decode(repeat('9e', 32), 'hex'), 'desktop'
);
insert into public.organization_memberships (
  organization_id, user_id, role, status, membership_type,
  joined_at, access_expires_at
) values (
  '9a300000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000005',
  'member', 'active', 'contractor',
  now() - interval '2 days', now() + interval '1 day'
);

insert into public.conversations (
  id, organization_id, kind, name, visibility, posting_mode,
  join_policy, created_by_user_id
) values
  (
    '9ae00000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    'team', 'Temporary access operations', 'invite_only', 'all_members',
    'invite_only', '9a000000-0000-4000-8000-000000000001'
  ),
  (
    '9ae00000-0000-4000-8000-000000000002',
    '9a300000-0000-4000-8000-000000000001',
    'announcement', 'Temporary access announcements', 'invite_only',
    'admins_only', 'invite_only',
    '9a000000-0000-4000-8000-000000000001'
  ),
  (
    '9ae00000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    'group', 'Inherited organization controls', 'organization',
    'all_members', 'inherit',
    '9a000000-0000-4000-8000-000000000001'
  );
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  (
    '9a300000-0000-4000-8000-000000000001',
    '9ae00000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000001', 'owner',
    '9a000000-0000-4000-8000-000000000001'
  ),
  (
    '9a300000-0000-4000-8000-000000000001',
    '9ae00000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004', 'member',
    '9a000000-0000-4000-8000-000000000001'
  ),
  (
    '9a300000-0000-4000-8000-000000000001',
    '9ae00000-0000-4000-8000-000000000002',
    '9a000000-0000-4000-8000-000000000001', 'owner',
    '9a000000-0000-4000-8000-000000000001'
  ),
  (
    '9a300000-0000-4000-8000-000000000001',
    '9ae00000-0000-4000-8000-000000000002',
    '9a000000-0000-4000-8000-000000000005', 'member',
    '9a000000-0000-4000-8000-000000000001'
  );

insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform,
  push_token_ciphertext, push_token_type, push_project_id, push_environment
) values
  (
    '9ad20000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    '9a200000-0000-4000-8000-000000000001', 'web',
    'vault:group-access-owner-token-0001', 'expo',
    '9ad30000-0000-4000-8000-000000000001', 'development'
  ),
  (
    '9ad20000-0000-4000-8000-000000000002',
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004',
    '9a100000-0000-4000-8000-000000000004',
    '9a200000-0000-4000-8000-000000000004', 'android',
    'vault:group-access-guest-token-0002', 'expo',
    '9ad30000-0000-4000-8000-000000000002', 'development'
  ),
  (
    '9ad20000-0000-4000-8000-000000000003',
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000005',
    '9ad00000-0000-4000-8000-000000000001',
    '9ad10000-0000-4000-8000-000000000001', 'web',
    'vault:group-access-contractor-token-0003', 'expo',
    '9ad30000-0000-4000-8000-000000000003', 'development'
  );

-- Rewind only these fixtures to model a job queued while access was current
-- and resolved after exact expiry. Production triggers prohibit this rewrite.
alter table public.organization_memberships disable trigger user;
update public.organization_memberships membership
set joined_at = case
      when membership.user_id = '9a000000-0000-4000-8000-000000000004'
        then now() - interval '2 days'
      else membership.joined_at
    end,
    access_expires_at = now() - interval '1 hour'
where membership.organization_id = '9a300000-0000-4000-8000-000000000001'
  and membership.user_id in (
    '9a000000-0000-4000-8000-000000000004',
    '9a000000-0000-4000-8000-000000000005'
  );
alter table public.organization_memberships enable trigger user;

select ok(
  private.organization_membership_access_current(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000001', now()
  )
  and not private.organization_membership_access_current(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000004', now()
  )
  and not private.organization_membership_access_current(
    '9a300000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000005', now()
  ),
  'canonical organization access expires for guests and contractors while current employees remain eligible'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"9a000000-0000-4000-8000-000000000001","session_id":"9a100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
create temporary table access_transport_message on commit drop as
with inserted as (
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, kind, body
  ) values (
    '9a300000-0000-4000-8000-000000000001',
    '9ae00000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000001',
    '9af00000-0000-4000-8000-000000000001',
    'text', 'Current recipients only'
  ) returning id
)
select id from inserted;

create temporary table access_announcement_message on commit drop as
with inserted as (
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, kind, body
  ) values (
    '9a300000-0000-4000-8000-000000000001',
    '9ae00000-0000-4000-8000-000000000002',
    '9a000000-0000-4000-8000-000000000001',
    '9af00000-0000-4000-8000-000000000002',
    'text', 'Delayed announcement recipient check'
  ) returning id
)
select id from inserted;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.announcements (
  id, organization_id, conversation_id, message_id, title,
  created_by_user_id, audience_spec
) values (
  '9af10000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9ae00000-0000-4000-8000-000000000002',
  (select id from access_announcement_message),
  'Delayed access announcement',
  '9a000000-0000-4000-8000-000000000001',
  '{"company":true}'::jsonb
);
insert into public.shift_handoffs (
  id, organization_id, conversation_id, author_user_id,
  title, details, source_language, status,
  shift_started_at, shift_ended_at
) values (
  '9af20000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9ae00000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000001',
  'Delayed access handoff', 'No expired recipient may receive this hint',
  'en', 'draft', now() - interval '2 hours', now() - interval '1 hour'
);

insert into private.outbox_jobs (
  organization_id, topic, dedupe_key, payload
) values
  (
    '9a300000-0000-4000-8000-000000000001', 'push',
    'group-access-conversation-push',
    jsonb_build_object(
      'conversation_id', '9ae00000-0000-4000-8000-000000000001'
    )
  ),
  (
    '9a300000-0000-4000-8000-000000000001', 'push',
    'group-access-announcement-push',
    jsonb_build_object(
      'conversation_id', '9ae00000-0000-4000-8000-000000000002',
      'announcement_id', '9af10000-0000-4000-8000-000000000001'
    )
  ),
  (
    '9a300000-0000-4000-8000-000000000001', 'push',
    'group-access-handoff-push',
    jsonb_build_object(
      'conversation_id', '9ae00000-0000-4000-8000-000000000001',
      'handoff_id', '9af20000-0000-4000-8000-000000000001'
    )
  );
select public.bff_claim_outbox_topics(
  '9af30000-0000-4000-8000-000000000001',
  array['push']::text[], 100, 60
);
create temporary table access_push_resolutions (
  kind text primary key,
  receipt jsonb not null
) on commit drop;
insert into access_push_resolutions (kind, receipt)
select 'conversation', public.bff_resolve_push_job(
  '9af30000-0000-4000-8000-000000000001', job.id, null, 100
)
from private.outbox_jobs job
where job.dedupe_key = 'group-access-conversation-push';
insert into access_push_resolutions (kind, receipt)
select 'announcement', public.bff_resolve_push_job(
  '9af30000-0000-4000-8000-000000000001', job.id, null, 100
)
from private.outbox_jobs job
where job.dedupe_key = 'group-access-announcement-push';
insert into access_push_resolutions (kind, receipt)
select 'handoff', public.bff_resolve_push_job(
  '9af30000-0000-4000-8000-000000000001', job.id, null, 100
)
from private.outbox_jobs job
where job.dedupe_key = 'group-access-handoff-push';

select ok(
  (select jsonb_array_length(receipt -> 'deliveries') = 1
      and receipt #>> '{deliveries,0,user_id}' =
        '9a000000-0000-4000-8000-000000000001'
   from access_push_resolutions where kind = 'conversation'),
  'conversation push fanout excludes an expired guest despite stale active conversation and device rows'
);
select ok(
  (select jsonb_array_length(receipt -> 'deliveries') = 1
      and receipt #>> '{deliveries,0,user_id}' =
        '9a000000-0000-4000-8000-000000000001'
   from access_push_resolutions where kind = 'announcement')
  and exists (
    select 1 from public.announcement_recipients recipient
    where recipient.announcement_id =
      '9af10000-0000-4000-8000-000000000001'
      and recipient.user_id = '9a000000-0000-4000-8000-000000000005'
  ),
  'announcement push rechecks access after an immutable recipient snapshot captured an expired contractor'
);
select ok(
  (select jsonb_array_length(receipt -> 'deliveries') = 1
      and receipt #>> '{deliveries,0,user_id}' =
        '9a000000-0000-4000-8000-000000000001'
   from access_push_resolutions where kind = 'handoff'),
  'handoff push fanout excludes an expired guest despite stale active handoff audience rows'
);
select ok(
  not exists (
    select 1
    from private.push_delivery_attempts attempt
    join private.outbox_jobs job on job.id = attempt.outbox_job_id
    where job.dedupe_key in (
      'group-access-conversation-push',
      'group-access-announcement-push',
      'group-access-handoff-push'
    ) and attempt.user_id in (
      '9a000000-0000-4000-8000-000000000004',
      '9a000000-0000-4000-8000-000000000005'
    )
  ) and (
    select count(*) = 3
    from private.push_delivery_attempts attempt
    join private.outbox_jobs job on job.id = attempt.outbox_job_id
    where job.dedupe_key in (
      'group-access-conversation-push',
      'group-access-announcement-push',
      'group-access-handoff-push'
    ) and attempt.user_id = '9a000000-0000-4000-8000-000000000001'
  ),
  'the final device layer creates durable attempts only for canonical current recipients'
);

create temporary table access_realtime_resolution on commit drop as
select private.bff_resolve_realtime_fanout_impl(
  '9a300000-0000-4000-8000-000000000001',
  '9ae00000-0000-4000-8000-000000000001',
  'workspace.invalidated', 'conversation',
  '9ae00000-0000-4000-8000-000000000001', null,
  'organization_access_expiry'
) as receipt;
select ok(
  (select jsonb_array_length(receipt -> 'deliveries') = 1
      and receipt #>> '{deliveries,0,topic}' =
        'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000001:inbox'
   from access_realtime_resolution),
  'resolved realtime fanout excludes expired principals from private inbox topics'
);

select set_config('app.bff_service_context', 'on', true);
select private.broadcast_receipt_invalidation_internal(
  '9a300000-0000-4000-8000-000000000001',
  '9ae00000-0000-4000-8000-000000000001',
  (select id from access_transport_message)
);
select private.broadcast_conversation_control_internal(
  '9a300000-0000-4000-8000-000000000001',
  '9ae00000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000004', 'join_rejected'
);
select private.broadcast_organization_conversation_controls_internal(
  '9a300000-0000-4000-8000-000000000001'
);
select private.broadcast_conversation_departure_internal(
  '9a300000-0000-4000-8000-000000000001',
  '9ae00000-0000-4000-8000-000000000001',
  '9a000000-0000-4000-8000-000000000004'
);
select set_config('app.bff_service_context', 'off', true);

select ok(
  exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000001:inbox'
      and event.payload ->> 'entity_type' = 'message'
      and event.payload ->> 'entity_id' =
        (select id::text from access_transport_message)
  ) and not exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000004:inbox'
      and event.payload ->> 'entity_type' = 'message'
      and event.payload ->> 'entity_id' =
        (select id::text from access_transport_message)
  ),
  'message-change broadcast sends no private-topic hint to an expired guest'
);
select ok(
  exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000001:inbox'
      and event.payload ->> 'entity_type' = 'receipt'
      and event.payload ->> 'entity_id' =
        (select id::text from access_transport_message)
  ) and not exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000004:inbox'
      and event.payload ->> 'entity_type' = 'receipt'
      and event.payload ->> 'entity_id' =
        (select id::text from access_transport_message)
  ),
  'receipt invalidation sends no private-topic hint to an expired guest'
);
select ok(
  exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000001:inbox'
      and event.payload ->> 'entity_type' = 'conversation_control'
      and event.payload ->> 'reason' = 'join_rejected'
      and event.payload ->> 'conversation_id' =
        '9ae00000-0000-4000-8000-000000000001'
  ) and not exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000004:inbox'
      and event.payload ->> 'entity_type' = 'conversation_control'
      and event.payload ->> 'reason' = 'join_rejected'
      and event.payload ->> 'conversation_id' =
        '9ae00000-0000-4000-8000-000000000001'
  ),
  'conversation-control fanout rechecks target organization access'
);
select ok(
  exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000001:inbox'
      and event.payload ->> 'entity_type' = 'organization_control'
      and event.payload ->> 'reason' =
        'organization_conversation_controls_changed'
  ) and not exists (
    select 1 from realtime.messages event
    where event.topic in (
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000004:inbox',
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000005:inbox'
    ) and event.payload ->> 'entity_type' = 'organization_control'
      and event.payload ->> 'reason' =
        'organization_conversation_controls_changed'
  ),
  'organization-control fanout excludes expired guests and contractors'
);
select ok(
  exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000001:inbox'
      and event.payload ->> 'entity_type' = 'membership'
      and event.payload ->> 'reason' = 'member_left'
      and event.payload ->> 'conversation_id' =
        '9ae00000-0000-4000-8000-000000000001'
  ) and not exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000004:inbox'
      and event.payload ->> 'entity_type' = 'membership'
      and event.payload ->> 'reason' = 'member_left'
      and event.payload ->> 'conversation_id' =
        '9ae00000-0000-4000-8000-000000000001'
  ),
  'departure fanout preserves the current-member hint without notifying an already-expired principal'
);

select has_column(
  'public', 'organizations', 'organization_policy_version',
  'organization policy changes have a durable compare-and-swap revision'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.bff_update_organization_policy(uuid,uuid,uuid,integer,boolean,text,boolean,boolean,text,boolean,integer,bigint,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_update_organization_policy(uuid,uuid,uuid,integer,boolean,text,boolean,boolean,text,boolean,integer,bigint,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'private.bff_update_organization_policy_impl(uuid,uuid,uuid,integer,boolean,text,boolean,boolean,text,boolean,integer,bigint,text,text,text)',
    'execute'
  ),
  'organization policy mutation is service-only behind the BFF'
);
select set_config(
  'request.jwt.claims',
  '{"role":"authenticated","sub":"9a000000-0000-4000-8000-000000000002","session_id":"9a100000-0000-4000-8000-000000000002","aal":"aal2"}',
  true
);
select throws_ok(
  $$update public.organizations
    set message_retention_days = 364
    where id = '9a300000-0000-4000-8000-000000000001'$$,
  '42501', 'organization policy requires the trusted AAL2 owner workflow',
  'a raw organization-table update cannot bypass the audited policy workflow'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_update_organization_policy(
    '9a000000-0000-4000-8000-000000000002',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000002',
    180, false, 'request_first', true, true, 'admins', false, 45, 1,
    'admin must not own organization policy', 'organization-policy-admin-denied',
    repeat('21', 32)
  )$$,
  '42501', 'organization owner permission required',
  'an AAL2 administrator still cannot mutate owner-only organization policy'
);
update auth.sessions set aal = 'aal1'
where id = '9a100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select public.bff_update_organization_policy(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    180, false, 'request_first', true, true, 'admins', false, 45, 1,
    'AAL1 must not change organization policy', 'organization-policy-aal1-denied',
    repeat('22', 32)
  )$$,
  '42501', 'request authorization denied',
  'organization policy mutation fails closed without recent AAL2'
);
update auth.sessions set aal = 'aal2'
where id = '9a100000-0000-4000-8000-000000000001';
create temporary table updated_organization_policy on commit drop as
select public.bff_update_organization_policy(
  '9a000000-0000-4000-8000-000000000001',
  '9a300000-0000-4000-8000-000000000001',
  '9a100000-0000-4000-8000-000000000001',
  180, false, 'request_first', true, true, 'admins', false, 45, 1,
  'tighten organization messaging and guest policy', 'organization-policy-update-0001',
  repeat('23', 32)
) as receipt;
select is(
  (select receipt from updated_organization_policy),
  jsonb_build_object(
    'message_retention_days', 180,
    'allow_member_direct_messages', false,
    'dm_policy', 'request_first',
    'require_mfa_for_admins', true,
    'shift_schedule_authoritative', true,
    'group_creation_policy', 'admins',
    'allow_external_guests', false,
    'external_guest_max_access_days', 45,
    'version', 2
  ),
  'the owner receives the complete authoritative policy receipt and next version'
);
select ok(
  exists (
    select 1 from public.organizations organization
    where organization.id = '9a300000-0000-4000-8000-000000000001'
      and organization.message_retention_days = 180
      and not organization.allow_member_direct_messages
      and organization.dm_policy = 'request_first'
      and organization.require_mfa_for_admins
      and organization.shift_schedule_authoritative
      and organization.group_creation_policy = 'admins'
      and not organization.allow_external_guests
      and organization.external_guest_max_access_days = 45
      and organization.organization_policy_version = 2
  ) and exists (
    select 1 from public.audit_events audit
    where audit.organization_id = '9a300000-0000-4000-8000-000000000001'
      and audit.event_type = 'organization.policy.updated'
      and audit.metadata ->> 'reason' =
        'tighten organization messaging and guest policy'
      and audit.metadata #>> '{before,organization_policy_version}' = '1'
      and audit.metadata #>> '{after,organization_policy_version}' = '2'
  ) and exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000001:inbox'
      and event.payload ->> 'entity_type' = 'organization_policy'
      and event.payload ->> 'reason' = 'organization_policy_changed'
  ) and not exists (
    select 1 from realtime.messages event
    where event.topic =
      'org:9a300000-0000-4000-8000-000000000001:user:9a000000-0000-4000-8000-000000000004:inbox'
      and event.payload ->> 'entity_type' = 'organization_policy'
  ),
  'policy state, bounded audit, durable version, and current-access fanout commit atomically'
);
select throws_ok(
  $$select public.bff_update_organization_policy(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001',
    181, false, 'request_first', true, true, 'admins', false, 45, 1,
    'stale policy write must fail', 'organization-policy-stale-version', repeat('24', 32)
  )$$,
  '40001', 'organization policy version conflict',
  'compare-and-swap rejects a stale organization policy draft'
);
select is(
  private.bff_bootstrap_messaging_state_v8_impl(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001', null, null, 100, 50
  ) #> '{organization}',
  (select private.bff_bootstrap_messaging_state_v8_impl(
    '9a000000-0000-4000-8000-000000000001',
    '9a300000-0000-4000-8000-000000000001',
    '9a100000-0000-4000-8000-000000000001', null, null, 100, 50
  ) #> '{organization}' || jsonb_build_object(
    'organization_policy_version', 2,
    'group_creation_policy', 'admins',
    'allow_external_guests', false,
    'external_guest_max_access_days', 45,
    'shift_schedule_authoritative', true
  )),
  'bootstrap exposes the authoritative policy values and CAS revision'
);

select * from finish();
rollback;
