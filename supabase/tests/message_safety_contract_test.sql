begin;
select plan(20);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('86000000-0000-4000-8000-000000000001', 'message-safety-owner@example.test', now()),
  ('86000000-0000-4000-8000-000000000002', 'message-safety-member@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('86100000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('86100000-0000-4000-8000-000000000002', '86000000-0000-4000-8000-000000000002', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('86100000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', '86200000-0000-4000-8000-000000000001', 'web', decode(repeat('91', 32), 'hex'), 'desktop'),
  ('86100000-0000-4000-8000-000000000002', '86000000-0000-4000-8000-000000000002', '86200000-0000-4000-8000-000000000002', 'web', decode(repeat('92', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '86300000-0000-4000-8000-000000000001',
  'message-safety-contract', 'Message Safety Contract',
  '86000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('86300000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', 'owner'),
  ('86300000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000002', 'member');

insert into public.conversations (
  id, organization_id, kind, name, visibility, created_by_user_id
) values
  ('86400000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001', 'group', 'Source room', 'invite_only', '86000000-0000-4000-8000-000000000001'),
  ('86400000-0000-4000-8000-000000000002', '86300000-0000-4000-8000-000000000001', 'group', 'Target room', 'invite_only', '86000000-0000-4000-8000-000000000001');

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id, history_visible_from
) values
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', 'owner', '86000000-0000-4000-8000-000000000001', null),
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000002', 'member', '86000000-0000-4000-8000-000000000001', now() + interval '1 hour'),
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000002', '86000000-0000-4000-8000-000000000001', 'owner', '86000000-0000-4000-8000-000000000001', null),
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000002', '86000000-0000-4000-8000-000000000002', 'member', '86000000-0000-4000-8000-000000000001', null);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"86000000-0000-4000-8000-000000000001","session_id":"86100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', '86500000-0000-4000-8000-000000000001', 'text', 'Original protected body', 'en'),
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', '86500000-0000-4000-8000-000000000002', 'text', 'Hidden forward source', 'en'),
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', '86500000-0000-4000-8000-000000000003', 'text', 'Visible forward source', 'en'),
  ('86300000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001', '86000000-0000-4000-8000-000000000001', '86500000-0000-4000-8000-000000000004', 'attachment', null, null);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.message_user_visibility (
  organization_id, conversation_id, message_id, user_id
)
select '86300000-0000-4000-8000-000000000001',
       '86400000-0000-4000-8000-000000000001', message.id,
       '86000000-0000-4000-8000-000000000001'
from public.messages message
where message.client_nonce = '86500000-0000-4000-8000-000000000002';

create temporary table message_safety_state (
  hold_receipt jsonb,
  forward_receipt jsonb
) on commit drop;
insert into message_safety_state default values;
grant select, update on message_safety_state to service_role;

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_place_message_preservation_hold(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_place_message_preservation_hold(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text)',
    'execute'
  ),
  'preservation administration is service-role BFF only'
);

select ok(
  not has_table_privilege('service_role', 'private.message_versions', 'select')
  and not has_table_privilege('service_role', 'private.message_preservation_holds', 'select'),
  'protected version and hold records are not directly readable through the service role'
);

select is(
  (select count(*)::bigint from private.message_versions version
   join public.messages message on message.organization_id = version.organization_id
    and message.conversation_id = version.conversation_id and message.id = version.message_id
   where message.client_nonce = '86500000-0000-4000-8000-000000000001'),
  1::bigint,
  'message insertion captures the original immutable version'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.bff_edit_message(
    '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000001'),
    'Edited protected body', 'message-safety-edit', repeat('1', 64)
  )$$,
  'authorized edit succeeds'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select count(*)::bigint from private.message_versions version
   join public.messages message on message.organization_id = version.organization_id
    and message.conversation_id = version.conversation_id and message.id = version.message_id
   where message.client_nonce = '86500000-0000-4000-8000-000000000001'),
  2::bigint,
  'edit appends exactly one protected version'
);

select is(
  (select array_agg(version.body order by version.version_number)
   from private.message_versions version
   join public.messages message on message.organization_id = version.organization_id
    and message.conversation_id = version.conversation_id and message.id = version.message_id
   where message.client_nonce = '86500000-0000-4000-8000-000000000001'),
  array['Original protected body', 'Edited protected body']::text[],
  'version history preserves original and edited plaintext in order'
);

select throws_ok(
  $$update private.message_versions set body = 'rewritten' where version_number = 1$$,
  '22000', 'message versions are immutable',
  'version history cannot be rewritten'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_place_message_preservation_hold(
    '86000000-0000-4000-8000-000000000002', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000002', '86400000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000001'),
    'legal', 'litigation', repeat('a', 64), 'message-safety-hold-member', repeat('2', 64)
  )$$,
  '42501', 'authorized preservation hold target and policy are required',
  'ordinary members cannot place organization preservation holds'
);

update message_safety_state
set hold_receipt = public.bff_place_message_preservation_hold(
  '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
  '86100000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000001'),
  'legal', 'litigation', repeat('b', 64), 'message-safety-hold-owner', repeat('3', 64)
);

select is((select hold_receipt ->> 'active' from message_safety_state), 'true',
  'authorized AAL2 owner receives an active hold receipt');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select count(*)::bigint from private.message_preservation_holds where released_at is null),
  1::bigint,
  'organization-scoped active hold is persisted once'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_delete_message(
    '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000001'),
    'message-safety-delete-held', repeat('4', 64)
  )$$,
  '42501', 'message deletion blocked by organization preservation policy',
  'active hold blocks destructive delete without disclosing case details'
);

select throws_ok(
  $$select public.bff_release_message_preservation_hold(
    '86000000-0000-4000-8000-000000000002', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000002',
    (select (hold_receipt ->> 'hold_id')::uuid from message_safety_state),
    'case-closed', 'message-safety-release-member', repeat('5', 64)
  )$$,
  '42501', 'authorized preservation release is required',
  'ordinary members cannot release a preservation hold'
);

select lives_ok(
  $$select public.bff_release_message_preservation_hold(
    '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000001',
    (select (hold_receipt ->> 'hold_id')::uuid from message_safety_state),
    'case-closed', 'message-safety-release-owner', repeat('6', 64)
  )$$,
  'authorized AAL2 owner releases the hold through an audited command'
);

select lives_ok(
  $$select public.bff_delete_message(
    '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000001'),
    'message-safety-delete-released', repeat('7', 64)
  )$$,
  'destructive delete resumes after an authorized hold release'
);

select throws_ok(
  $$select public.bff_forward_message(
    '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000002'),
    '86400000-0000-4000-8000-000000000002', '86600000-0000-4000-8000-000000000001',
    'message-safety-forward-hidden', repeat('8', 64)
  )$$,
  '42501', 'readable forwardable text message not found',
  'delete-for-me hidden sources cannot be forwarded'
);

select throws_ok(
  $$select public.bff_forward_message(
    '86000000-0000-4000-8000-000000000002', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000002', '86400000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000003'),
    '86400000-0000-4000-8000-000000000002', '86600000-0000-4000-8000-000000000002',
    'message-safety-forward-history', repeat('9', 64)
  )$$,
  '42501', 'readable forwardable text message not found',
  'history-invisible sources cannot be forwarded'
);

update message_safety_state
set forward_receipt = public.bff_forward_message(
  '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
  '86100000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001',
  (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000003'),
  '86400000-0000-4000-8000-000000000002', '86600000-0000-4000-8000-000000000003',
  'message-safety-forward-visible', repeat('c', 64)
);

select is((select forward_receipt ->> 'forwarded' from message_safety_state), 'true',
  'currently readable text forwards as a new message');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select count(*)::bigint from public.message_forward_provenance provenance
   where provenance.target_message_id = (select (forward_receipt ->> 'message_id')::bigint from message_safety_state)),
  1::bigint,
  'successful forward retains immutable server provenance'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_forward_message(
    '86000000-0000-4000-8000-000000000001', '86300000-0000-4000-8000-000000000001',
    '86100000-0000-4000-8000-000000000001', '86400000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '86500000-0000-4000-8000-000000000004'),
    '86400000-0000-4000-8000-000000000002', '86600000-0000-4000-8000-000000000004',
    'message-safety-forward-attachment', repeat('d', 64)
  )$$,
  '42501', 'readable forwardable text message not found',
  'attachment forwarding remains denied pending destination reauthorization'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select count(*) >= 5 from public.audit_events where event_type = 'message.version.insert')
  and (select count(*) = 1 from public.audit_events where event_type = 'message.preservation_hold.insert')
  and (select count(*) = 1 from public.audit_events where event_type = 'message.preservation_hold.update')
  and not exists (
    select 1 from public.audit_events event
    where event.event_type like 'message.version.%'
      and (event.metadata ? 'body' or event.metadata ? 'policy_reference_sha256')
  ),
  'version and hold lifecycle changes emit content-free transactional audit events'
);

select * from finish();
rollback;
