begin;
select plan(16);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: the personal realm plus one workspace organization. The deleted
-- consumer holds a membership in each, a claimed username, a push
-- registration, and authored message history that must survive deletion.
insert into auth.users (id, email, email_confirmed_at) values
  ('99600000-0000-4000-8000-000000000001', 'deletion-target@example.test', now()),
  ('99600000-0000-4000-8000-000000000002', 'deletion-friend@example.test', now()),
  ('99600000-0000-4000-8000-000000000003', 'deletion-owner@example.test', now()),
  ('99600000-0000-4000-8000-000000000004', 'deletion-memberless@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set username = case user_id
    when '99600000-0000-4000-8000-000000000001' then 'doomed_user'
    when '99600000-0000-4000-8000-000000000002' then 'grieving_friend'
    else 'workspace_owner'
  end,
  display_name = case user_id
    when '99600000-0000-4000-8000-000000000001' then 'Doomed User'
    when '99600000-0000-4000-8000-000000000002' then 'Grieving Friend'
    else 'Workspace Owner'
  end,
  avatar_path = 'avatars/doomed.png',
  status_message = 'About to leave'
where user_id in (
  '99600000-0000-4000-8000-000000000001',
  '99600000-0000-4000-8000-000000000002',
  '99600000-0000-4000-8000-000000000003'
);
select set_config('app.bff_service_context', 'off', true);

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
  true, 'request_first', true, '99600000-0000-4000-8000-000000000001'
);
insert into public.organizations (id, slug, name, created_by_user_id) values (
  '99610000-0000-4000-8000-000000000001', 'account-deletion-workspace',
  'Deletion workspace', '99600000-0000-4000-8000-000000000003'
);

insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility
) values
  ('11111111-1111-4111-8111-111111111111', '99600000-0000-4000-8000-000000000001', 'member', 'active', 'private'),
  ('11111111-1111-4111-8111-111111111111', '99600000-0000-4000-8000-000000000002', 'member', 'active', 'private'),
  ('99610000-0000-4000-8000-000000000001', '99600000-0000-4000-8000-000000000003', 'owner', 'active', 'organization'),
  ('99610000-0000-4000-8000-000000000001', '99600000-0000-4000-8000-000000000001', 'member', 'active', 'organization');

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('99660000-0000-4000-8000-000000000001', '99600000-0000-4000-8000-000000000001', now(), now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform,
  user_agent_hash, user_agent_family
) values (
  '99660000-0000-4000-8000-000000000001',
  '99600000-0000-4000-8000-000000000001',
  '99630000-0000-4000-8000-000000000001', 'ios',
  decode(repeat('99', 32), 'hex'), 'iphone'
);

insert into public.device_registrations (
  id, organization_id, user_id, session_id, installation_id, platform,
  push_token_ciphertext, push_token_type, push_project_id, push_environment
) values (
  '99620000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '99600000-0000-4000-8000-000000000001',
  '99660000-0000-4000-8000-000000000001',
  '99630000-0000-4000-8000-000000000001', 'ios',
  'ciphertext:v1:doomed-user-push-token', 'expo',
  '99640000-0000-4000-8000-000000000001', 'production'
);

insert into public.conversations (
  id, organization_id, kind, name, visibility, created_by_user_id
) values (
  '99650000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'group', 'Survivor room', 'invite_only', '99600000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id, history_visible_from
) values
  ('11111111-1111-4111-8111-111111111111', '99650000-0000-4000-8000-000000000001', '99600000-0000-4000-8000-000000000001', 'member', '99600000-0000-4000-8000-000000000001', null),
  ('11111111-1111-4111-8111-111111111111', '99650000-0000-4000-8000-000000000001', '99600000-0000-4000-8000-000000000002', 'member', '99600000-0000-4000-8000-000000000001', null);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"99600000-0000-4000-8000-000000000001","session_id":"99660000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  '11111111-1111-4111-8111-111111111111',
  '99650000-0000-4000-8000-000000000001',
  '99600000-0000-4000-8000-000000000001',
  '99670000-0000-4000-8000-000000000001', 'text', 'A message that must survive'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1-2: the deletion command is a service-only capability.
select ok(
  has_function_privilege('service_role', 'public.bff_delete_account(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.bff_delete_account(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.bff_delete_account(uuid)', 'execute'),
  'account deletion is a service-only BFF capability'
);
select ok(
  has_function_privilege('service_role', 'private.delete_account_impl(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'private.delete_account_impl(uuid)', 'execute')
  and not has_function_privilege('anon', 'private.delete_account_impl(uuid)', 'execute'),
  'the deletion implementation is service-only'
);

-- 3: the tombstone reports every deactivated membership.
select is(
  (public.bff_delete_account('99600000-0000-4000-8000-000000000001'))
    - 'user_id',
  jsonb_build_object('memberships_deactivated', 2),
  'deletion deactivates both memberships in one transaction'
);

-- 4-6: the profile is anonymized and the handle is quarantined.
select ok(
  exists (
    select 1 from public.profiles
    where user_id = '99600000-0000-4000-8000-000000000001'
      and username is null
      and display_name = 'Deleted account'
      and avatar_path is null
      and status_message is null
  ),
  'deletion tombstones the profile in place'
);
select ok(
  exists (
    select 1 from private.reserved_usernames
    where username = 'doomed_user'
      and reserved_reason = 'post-deletion-quarantine'
  ),
  'the released username is quarantined as reserved'
);
select is(
  (public.bff_authorize_signup_otp(
    'email', 'handle-reuser@example.test', 'doomed_user', 'Handle Reuser', 'en',
    repeat('a', 64), repeat('b', 64), 'request'
  )) ->> 'reason',
  'username_reserved',
  'a fresh signup can never claim a deleted account''s handle'
);

-- 7-9: every membership is deactivated through the canonical machinery and
-- push state is gone.
select is(
  (select count(*)::integer from public.organization_memberships
    where user_id = '99600000-0000-4000-8000-000000000001'
      and status = 'deactivated'
      and deactivated_at is not null
      and status_change_reason = 'Account deletion (self-service)'),
  2,
  'both memberships are deactivated with an auditable reason'
);
select is(
  (select count(*)::integer from private.outbox_jobs
    where topic = 'session_revoke'
      and payload ->> 'user_id' = '99600000-0000-4000-8000-000000000001'),
  2,
  'deactivation queues session revocation for every membership'
);
select is(
  (select count(*)::integer from public.device_registrations
    where user_id = '99600000-0000-4000-8000-000000000001'),
  0,
  'deletion removes the account''s push registrations'
);

-- 10-11: nothing content-bearing is removed.
select ok(
  exists (
    select 1 from public.messages
    where sender_user_id = '99600000-0000-4000-8000-000000000001'
      and body = 'A message that must survive'
      and deleted_at is null
  ),
  'messages authored by the deleted account remain'
);
select ok(
  exists (
    select 1 from public.organizations
    where id = private.personal_realm_organization_id()
      and slug = 'personal-realm'
  ),
  'the personal-realm organization row is untouched'
);

-- 12: repeating the command is a harmless no-op tombstone refresh.
select is(
  (public.bff_delete_account('99600000-0000-4000-8000-000000000001'))
    ->> 'memberships_deactivated',
  '0',
  'repeated deletion is idempotent'
);

-- 13: an account with zero memberships deletes gracefully.
select is(
  (public.bff_delete_account('99600000-0000-4000-8000-000000000004'))
    - 'user_id',
  jsonb_build_object('memberships_deactivated', 0),
  'a memberless account deletes gracefully'
);

-- 14: unknown principals fail closed.
select throws_ok(
  $delete$
    select public.bff_delete_account('99600000-0000-4000-8000-0000000000ff')
  $delete$,
  'P0002',
  'account not found',
  'deleting an unknown account fails closed'
);

-- 15-16: the Edge gateway follows with the GoTrue soft delete; the token
-- lifecycle hook then refuses claims for the soft-deleted principal.
select ok(
  (public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', '99600000-0000-4000-8000-000000000002',
    'claims', jsonb_build_object('sub', '99600000-0000-4000-8000-000000000002', 'role', 'authenticated')
  ))) ? 'claims',
  'a live member still receives claims through the hook'
);

update auth.users
set deleted_at = now()
where id = '99600000-0000-4000-8000-000000000001';

select is(
  public.hook_newone_custom_access_token(jsonb_build_object(
    'user_id', '99600000-0000-4000-8000-000000000001',
    'claims', jsonb_build_object('sub', '99600000-0000-4000-8000-000000000001', 'role', 'authenticated')
  )) #>> '{error,http_code}',
  '403',
  'the lifecycle hook refuses claims for a soft-deleted account'
);

select * from finish();
rollback;
