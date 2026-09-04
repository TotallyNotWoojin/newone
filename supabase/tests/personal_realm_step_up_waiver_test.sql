begin;
select plan(4);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: one consumer in the personal realm and the same person in a
-- workspace organization, each with an aal1 session created an hour ago.
insert into auth.users (id, email, email_confirmed_at) values
  ('dd000000-0000-4000-8000-000000000001', 'stepup-alice@example.test', now());
insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('dd100000-0000-4000-8000-000000000001', 'dd000000-0000-4000-8000-000000000001', now() - interval '1 hour', now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values (
  'dd100000-0000-4000-8000-000000000001', 'dd000000-0000-4000-8000-000000000001',
  'dd200000-0000-4000-8000-000000000001', 'ios', decode(repeat('e1', 32), 'hex'), 'iphone'
);
insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values
  ('11111111-1111-4111-8111-111111111111', 'personal-realm', 'Newone', 'en',
   true, 'request_first', true, 'dd000000-0000-4000-8000-000000000001'),
  ('dd300000-0000-4000-8000-000000000001', 'stepup-workspace', 'Step-up Workspace', 'en',
   true, 'open', true, 'dd000000-0000-4000-8000-000000000001');
insert into public.organization_memberships (organization_id, user_id, role, status, directory_visibility) values
  ('11111111-1111-4111-8111-111111111111', 'dd000000-0000-4000-8000-000000000001', 'member', 'active', 'private'),
  ('dd300000-0000-4000-8000-000000000001', 'dd000000-0000-4000-8000-000000000001', 'admin', 'active', 'organization');

select is(
  (private.authorize_bff_request_internal(
    'dd000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'dd100000-0000-4000-8000-000000000001', 'conversation.member.role.update', true, 900
  )) ->> 'allowed',
  'true',
  'the personal realm allows a step-up route on an aal1 session an hour old'
);
select is(
  (private.authorize_bff_request_internal(
    'dd000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
    'dd100000-0000-4000-8000-000000000001', 'conversation.member.role.update', true, 900
  )) ->> 'role',
  'member',
  'the waived result still carries the verified membership role'
);
select is(
  (private.authorize_bff_request_internal(
    'dd000000-0000-4000-8000-000000000001', 'dd300000-0000-4000-8000-000000000001',
    'dd100000-0000-4000-8000-000000000001', 'conversation.member.role.update', true, 900
  )) ->> 'reason',
  'aal2_required',
  'a workspace organization still requires AAL2'
);
select is(
  (private.authorize_bff_request_internal(
    'dd000000-0000-4000-8000-000000000001', 'dd300000-0000-4000-8000-000000000001',
    'dd100000-0000-4000-8000-000000000001', 'conversation.controls.update', false, 300
  )) ->> 'reason',
  'recent_auth_required',
  'a workspace organization still requires recent authentication'
);

select * from finish();
rollback;
