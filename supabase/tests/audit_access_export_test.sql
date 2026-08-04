begin;
select plan(33);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('87000000-0000-4000-8000-000000000001', 'audit-owner@example.test', now()),
  ('87000000-0000-4000-8000-000000000002', 'audit-member@example.test', now()),
  ('87000000-0000-4000-8000-000000000003', 'audit-suspended@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('87100000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('87100000-0000-4000-8000-000000000002', '87000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('87100000-0000-4000-8000-000000000003', '87000000-0000-4000-8000-000000000001', now() - interval '1 hour', now(), 'aal2'),
  ('87100000-0000-4000-8000-000000000004', '87000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('87100000-0000-4000-8000-000000000005', '87000000-0000-4000-8000-000000000003', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('87100000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000001', '87200000-0000-4000-8000-000000000001', 'web', decode(repeat('a1', 32), 'hex'), 'desktop'),
  ('87100000-0000-4000-8000-000000000002', '87000000-0000-4000-8000-000000000002', '87200000-0000-4000-8000-000000000002', 'web', decode(repeat('a2', 32), 'hex'), 'desktop'),
  ('87100000-0000-4000-8000-000000000003', '87000000-0000-4000-8000-000000000001', '87200000-0000-4000-8000-000000000003', 'web', decode(repeat('a3', 32), 'hex'), 'desktop'),
  ('87100000-0000-4000-8000-000000000004', '87000000-0000-4000-8000-000000000001', '87200000-0000-4000-8000-000000000004', 'web', decode(repeat('a4', 32), 'hex'), 'desktop'),
  ('87100000-0000-4000-8000-000000000005', '87000000-0000-4000-8000-000000000003', '87200000-0000-4000-8000-000000000005', 'web', decode(repeat('a5', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values
  ('87300000-0000-4000-8000-000000000001', 'audit-contract', 'Audit Contract', '87000000-0000-4000-8000-000000000001'),
  ('87300000-0000-4000-8000-000000000002', 'audit-other-tenant', 'Audit Other Tenant', '87000000-0000-4000-8000-000000000001');

insert into public.organization_memberships (organization_id, user_id, role, status) values
  ('87300000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000001', 'owner', 'active'),
  ('87300000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000002', 'member', 'active'),
  ('87300000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000003', 'member', 'suspended');

insert into public.audit_events (
  organization_id, actor_user_id, event_type, target_type, target_id, metadata, occurred_at
) values
  ('87300000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000001', 'audit.fixture', 'membership', 'plain-id', '{"result":"committed","body":"must-not-export"}', now() - interval '3 minutes'),
  ('87300000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000001', 'audit.fixture', 'membership', '  =SUM(1,1)', '{"result":"committed"}', now() - interval '2 minutes'),
  ('87300000-0000-4000-8000-000000000001', '87000000-0000-4000-8000-000000000001', 'audit.fixture', 'membership', E'\t+CMD', '{"result":"failed"}', now() - interval '1 minute'),
  ('87300000-0000-4000-8000-000000000002', null, 'audit.fixture', 'organization', 'other-tenant', '{"result":"committed"}', now());

create temporary table audit_test_state (
  date_from timestamptz not null,
  date_to timestamptz not null,
  query_one jsonb,
  query_two jsonb,
  export_json jsonb,
  export_csv jsonb
) on commit drop;
insert into audit_test_state values (now() - interval '1 day', now(), null, null, null, null);
grant select, update on audit_test_state to service_role;

select ok(
  has_function_privilege('service_role', 'public.bff_query_audit_events(uuid,uuid,uuid,text,timestamptz,timestamptz,text[],uuid,text,text,text,integer)', 'execute')
  and has_function_privilege('service_role', 'public.bff_export_audit_events(uuid,uuid,uuid,text,text,timestamptz,timestamptz,text[],uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.bff_query_audit_events(uuid,uuid,uuid,text,timestamptz,timestamptz,text[],uuid,text,text,text,integer)', 'execute'),
  'audit RPCs are executable only through the service-role BFF boundary'
);

select ok(
  not has_table_privilege('authenticated', 'public.audit_events', 'select'),
  'authenticated clients cannot bypass the purpose-bound audit query with table SELECT'
);

select ok(
  not has_table_privilege('service_role', 'private.audit_query_receipts', 'select')
  and not has_table_privilege('service_role', 'private.audit_export_receipts', 'select'),
  'private audit receipts are not directly readable through the service role'
);

select ok(
  (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'private.audit_query_receipts'::regclass)
  and (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'private.audit_export_receipts'::regclass),
  'both private receipt ledgers enable and force RLS'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000002', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000002', 'security_review',
    now() - interval '1 day', now()
  ) ->> 'denied',
  'true',
  'an active ordinary member is denied without receiving audit rows'
);

select is(
  public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000003', 'security_review',
    now() - interval '1 day', now()
  ) ->> 'denied',
  'true',
  'an AAL2 session older than 15 minutes is denied'
);

select is(
  public.bff_export_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000004', 'compliance_review', 'json',
    now() - interval '1 day', now()
  ) ->> 'denied',
  'true',
  'an AAL1 session is denied before export construction'
);

select is(
  public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000003', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000005', 'access_review',
    now() - interval '1 day', now()
  ) ->> 'denied',
  'true',
  'a suspended membership is denied'
);

select is(
  public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000002',
    '87100000-0000-4000-8000-000000000001', 'access_review',
    now() - interval '1 day', now()
  ) ->> 'denied',
  'true',
  'a cross-tenant query fails closed'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select count(*)::integer from public.audit_events
   where organization_id = '87300000-0000-4000-8000-000000000001'
     and event_type = 'audit.access.denied'),
  3,
  'permission, stale-AAL2, and AAL1 denials leave durable tenant security events'
);

select ok(
  not exists (
    select 1 from public.audit_events
    where organization_id = '87300000-0000-4000-8000-000000000002'
      and event_type = 'audit.access.denied'
  ),
  'a claimed organization without active membership cannot be polluted with denial events'
);

select ok(
  not exists (
    select 1 from public.audit_events
    where event_type = 'audit.access.denied'
      and (metadata ? 'body' or metadata ? 'target_id' or metadata ? 'reason')
  ),
  'denied-attempt audit records remain content-free and non-oracular'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

update audit_test_state
set query_one = public.bff_query_audit_events(
  '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
  '87100000-0000-4000-8000-000000000001', 'security_review',
  date_from, date_to, null, null, null, null, null, 2
);

select ok(
  jsonb_array_length(query_one -> 'items') = 2
  and (query_one ->> 'has_more')::boolean
  and query_one ->> 'receipt_id' ~* '^[0-9a-f-]{36}$',
  'a bounded first page returns a continuation and immutable receipt identifier'
)
from audit_test_state;

select ok(
  not exists (
    select 1
    from audit_test_state, jsonb_array_elements(query_one -> 'items') item
    where item ? 'metadata' or item ? 'ip_hash' or item ? 'user_agent_hash' or item ? 'body'
  ),
  'query rows expose only content-free whitelisted envelopes'
);

update audit_test_state
set query_two = public.bff_query_audit_events(
  '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
  '87100000-0000-4000-8000-000000000001', 'security_review',
  date_from, date_to, null, null, null, null, query_one ->> 'next_cursor', 2
);

select ok(
  not exists (
    select 1 from audit_test_state,
      jsonb_array_elements(query_one -> 'items') first_page,
      jsonb_array_elements(query_two -> 'items') second_page
    where first_page ->> 'id' = second_page ->> 'id'
  ),
  'cursor pagination advances without duplicating an audit event'
);

select throws_ok(
  $$select public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000001', 'security_review',
    date_from, date_to, null, null, null, null,
    left(query_one ->> 'next_cursor', -1) || 'A', 2
  ) from audit_test_state$$,
  '22023', 'invalid audit cursor',
  'tampered database cursors fail closed'
);

select throws_ok(
  $$select public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000001', 'security_review',
    date_from, date_to, null, null, 'membership', null,
    query_one ->> 'next_cursor', 2
  ) from audit_test_state$$,
  '22023', 'invalid audit cursor',
  'a cursor cannot be replayed with different filters'
);

select throws_ok(
  $$select public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000001', 'security_review',
    now() + interval '1 minute', now() + interval '2 minutes'
  )$$,
  '22023', 'invalid audit query',
  'future-only query windows fail as a client error before receipt insertion'
);

select throws_ok(
  $$select public.bff_query_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000001', 'security_review',
    now() - interval '91 days', now()
  )$$,
  '22023', 'invalid audit query',
  'query ranges longer than 90 days are rejected'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  exists (
    select 1 from private.audit_query_receipts receipt, audit_test_state state
    where receipt.id = (state.query_one ->> 'receipt_id')::uuid
      and receipt.reason_code = 'security_review'
      and receipt.filter_parameters ->> 'date_from' is not null
      and receipt.snapshot_at is not null
      and receipt.returned_first_id is not null
      and receipt.returned_last_id is not null
      and receipt.returned_rows = 2
      and receipt.has_more
      and receipt.next_cursor_sha256 is not null
  ),
  'the immutable query receipt reconstructs normalized filters, snapshot, boundary, and page result'
);

select ok(
  exists (
    select 1 from public.audit_events event, audit_test_state state
    where event.event_type = 'audit.accessed'
      and event.target_type = 'audit_query_receipt'
      and event.target_id = state.query_one ->> 'receipt_id'
  ),
  'successful audit access is itself bound to the query receipt in the audit stream'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  jsonb_array_length(public.bff_bootstrap_messaging_state(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000001'
  ) -> 'audit_events'),
  0,
  'general workspace bootstrap never ambiently returns audit data'
);

update audit_test_state
set export_json = public.bff_export_audit_events(
  '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
  '87100000-0000-4000-8000-000000000001', 'compliance_review', 'json',
  date_from, date_to, array['audit.fixture']::text[]
);

select ok(
  (export_json ->> 'row_count')::integer = 3
  and (export_json ->> 'payload_bytes')::integer between 1 and 2000000
  and export_json ->> 'sha256' ~ '^[0-9a-f]{64}$',
  'JSON export is row/byte bounded and includes a SHA-256 digest'
)
from audit_test_state;

select ok(
  not ((export_json ->> 'payload')::jsonb #> '{events,0}') ? 'metadata'
  and position('must-not-export' in export_json ->> 'payload') = 0,
  'JSON export excludes arbitrary metadata and employee content'
)
from audit_test_state;

update audit_test_state
set export_csv = public.bff_export_audit_events(
  '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
  '87100000-0000-4000-8000-000000000001', 'incident_investigation', 'csv',
  date_from, date_to, array['audit.fixture']::text[]
);

select ok(
  position(E'"''  =SUM(1,1)"' in export_csv ->> 'payload') > 0
  and position(E'"''\t+CMD"' in export_csv ->> 'payload') > 0,
  'CSV export neutralizes formulas hidden behind whitespace and controls'
)
from audit_test_state;

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  exists (
    select 1 from private.audit_export_receipts receipt, audit_test_state state
    where receipt.id = (state.export_json ->> 'receipt_id')::uuid
      and encode(receipt.payload_sha256, 'hex') = state.export_json ->> 'sha256'
      and receipt.payload_bytes = (state.export_json ->> 'payload_bytes')::integer
      and receipt.row_count = 3
      and receipt.reason_code = 'compliance_review'
  ),
  'export receipt immutably binds purpose, filters, rows, bytes, and payload digest'
);

select ok(
  exists (
    select 1 from public.audit_events event, audit_test_state state
    where event.event_type = 'audit.exported'
      and event.target_id = state.export_json ->> 'receipt_id'
      and event.metadata ->> 'payload_sha256' = state.export_json ->> 'sha256'
  ),
  'successful export is itself recorded with its receipt and digest'
);

select throws_ok(
  $$update private.audit_query_receipts set returned_rows = 0$$,
  '55000', 'audit export receipts are append-only',
  'query receipts cannot be rewritten'
);

select throws_ok(
  $$delete from private.audit_export_receipts$$,
  '55000', 'audit export receipts are append-only',
  'export receipts cannot be deleted'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(
  $$select public.bff_export_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000001', 'compliance_review', 'json',
    now() - interval '32 days', now()
  )$$,
  '22023', 'invalid audit export',
  'export ranges longer than 31 days are rejected'
);

select throws_ok(
  $$select public.bff_export_audit_events(
    '87000000-0000-4000-8000-000000000001', '87300000-0000-4000-8000-000000000001',
    '87100000-0000-4000-8000-000000000001', 'curiosity', 'json',
    now() - interval '1 day', now()
  )$$,
  '22023', 'invalid audit export',
  'unapproved free-form export purposes are rejected'
);

reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is(
  (select count(*)::integer from private.audit_query_receipts),
  2,
  'exactly one immutable query receipt exists per successful page'
);

select is(
  (select count(*)::integer from private.audit_export_receipts),
  2,
  'exactly one immutable export receipt exists per successful export'
);

select * from finish();
rollback;
