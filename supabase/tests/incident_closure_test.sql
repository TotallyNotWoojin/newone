begin;
select plan(13);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('85000000-0000-4000-8000-000000000001', 'incident-owner@example.test', now()),
  ('85000000-0000-4000-8000-000000000002', 'incident-member@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('85100000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('85100000-0000-4000-8000-000000000002', '85000000-0000-4000-8000-000000000002', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('85100000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', '85200000-0000-4000-8000-000000000001', 'web', decode(repeat('85', 32), 'hex'), 'desktop'),
  ('85100000-0000-4000-8000-000000000002', '85000000-0000-4000-8000-000000000002', '85200000-0000-4000-8000-000000000002', 'web', decode(repeat('86', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '85300000-0000-4000-8000-000000000001', 'incident-closure-contract',
  'Incident Closure Contract', '85000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (organization_id, user_id, role) values
  ('85300000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', 'owner'),
  ('85300000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000002', 'member');

insert into public.conversations (
  id, organization_id, kind, name, visibility, incident_severity,
  incident_classification, posting_mode, join_policy, created_by_user_id
) values (
  '85400000-0000-4000-8000-000000000001',
  '85300000-0000-4000-8000-000000000001',
  'incident', 'Line 3 incident', 'invite_only', 'high',
  'equipment-safety', 'all_members', 'invite_only',
  '85000000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('85300000-0000-4000-8000-000000000001', '85400000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000001', 'owner', '85000000-0000-4000-8000-000000000001'),
  ('85300000-0000-4000-8000-000000000001', '85400000-0000-4000-8000-000000000001', '85000000-0000-4000-8000-000000000002', 'member', '85000000-0000-4000-8000-000000000001');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"85000000-0000-4000-8000-000000000001","session_id":"85100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  '85300000-0000-4000-8000-000000000001', '85400000-0000-4000-8000-000000000001',
  '85000000-0000-4000-8000-000000000001', '85500000-0000-4000-8000-000000000001',
  'text', 'Preserved incident source record'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_close_incident(uuid,uuid,uuid,uuid,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_close_incident(uuid,uuid,uuid,uuid,text,text,text)',
    'execute'
  ),
  'incident closure is available only through the service-role BFF'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_close_incident(
    '85000000-0000-4000-8000-000000000002', '85300000-0000-4000-8000-000000000001',
    '85100000-0000-4000-8000-000000000002', '85400000-0000-4000-8000-000000000001',
    'Member cannot close', 'incident-member-close', repeat('1', 64)
  )$$,
  '42501', 'incident administrator and closure reason required',
  'ordinary members cannot close an incident'
);
select throws_ok(
  $$select public.bff_close_incident(
    '85000000-0000-4000-8000-000000000001', '85300000-0000-4000-8000-000000000001',
    '85100000-0000-4000-8000-000000000001', '85400000-0000-4000-8000-000000000001',
    'x', 'incident-short-reason', repeat('2', 64)
  )$$,
  '42501', 'incident administrator and closure reason required',
  'closure requires an attributable reason'
);

create temporary table incident_test_state (receipt jsonb) on commit drop;
insert into incident_test_state (receipt)
select public.bff_close_incident(
  '85000000-0000-4000-8000-000000000001', '85300000-0000-4000-8000-000000000001',
  '85100000-0000-4000-8000-000000000001', '85400000-0000-4000-8000-000000000001',
  'Line stabilized and safety review complete', 'incident-owner-close', repeat('3', 64)
);

select is((select receipt ->> 'is_read_only' from incident_test_state), 'true',
  'closure receipt explicitly marks the incident read-only');
select is((select receipt ->> 'closure_reason' from incident_test_state),
  'Line stabilized and safety review complete',
  'closure receipt preserves the exact reason');
select is((select receipt ->> 'closed_by_user_id' from incident_test_state),
  '85000000-0000-4000-8000-000000000001',
  'closure receipt identifies the actor');
select ok((select closed_at is not null and closed_by_user_id = '85000000-0000-4000-8000-000000000001'
  and closure_reason = 'Line stabilized and safety review complete'
  from public.conversations where id = '85400000-0000-4000-8000-000000000001'),
  'conversation retains the authoritative closure record');
select is((select count(*)::bigint from public.messages
  where conversation_id = '85400000-0000-4000-8000-000000000001'), 1::bigint,
  'closing preserves incident message history');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is((select count(*)::bigint from private.outbox_jobs
  where topic = 'push' and dedupe_key = 'incident:85400000-0000-4000-8000-000000000001:closed'), 1::bigint,
  'closure queues one content-free change notification');
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.bff_close_incident(
    '85000000-0000-4000-8000-000000000001', '85300000-0000-4000-8000-000000000001',
    '85100000-0000-4000-8000-000000000001', '85400000-0000-4000-8000-000000000001',
    'Line stabilized and safety review complete', 'incident-owner-close', repeat('3', 64)
  ) ->> 'closure_reason',
  'Line stabilized and safety review complete',
  'idempotent replay returns the retained closure result'
);
select throws_ok(
  $$select public.bff_send_message(
    '85000000-0000-4000-8000-000000000001', '85300000-0000-4000-8000-000000000001',
    '85100000-0000-4000-8000-000000000001', '85400000-0000-4000-8000-000000000001',
    '85500000-0000-4000-8000-000000000002', 'text', 'must fail', 'en', null, null,
    '{}'::jsonb, 'incident-post-close', repeat('4', 64)
  )$$,
  '42501', 'active conversation membership with posting access is required',
  'closed incidents reject new messages'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$update public.conversations
    set closure_reason = 'Silently rewritten reason'
    where id = '85400000-0000-4000-8000-000000000001'$$,
  '22000', 'closed incident record is immutable',
  'even privileged maintenance cannot rewrite closure evidence'
);
select throws_ok(
  $$update public.conversations
    set closed_at = null, closed_by_user_id = null, closure_reason = null
    where id = '85400000-0000-4000-8000-000000000001'$$,
  '22000', 'closed incident record is immutable',
  'a closed incident cannot be reopened by mutation'
);

select * from finish();
rollback;
