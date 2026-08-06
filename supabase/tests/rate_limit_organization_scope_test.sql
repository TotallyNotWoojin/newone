begin;
select plan(8);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values (
  '99000000-0000-4000-8000-000000000001',
  'rate-limit-scope-owner@example.test',
  now()
);

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '99100000-0000-4000-8000-000000000001',
  'rate-limit-organization-scope',
  'Rate limit organization scope',
  '99000000-0000-4000-8000-000000000001'
);

select ok(
  exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'rate_limit_buckets'
      and column_name = 'organization_id'
      and is_nullable = 'YES'
  ),
  'rate-limit buckets expose nullable organization ownership'
);

select ok(
  exists (
    select 1
    from pg_constraint constraint_row
    join pg_class table_row on table_row.oid = constraint_row.conrelid
    join pg_namespace namespace_row on namespace_row.oid = table_row.relnamespace
    where namespace_row.nspname = 'private'
      and table_row.relname = 'rate_limit_buckets'
      and constraint_row.contype = 'f'
      and constraint_row.confdeltype = 'c'
  ),
  'organization-owned rate buckets cascade with the exact organization'
);

select ok(
  private.consume_rate_limit(
    'pgtap-organization-network',
    '99100000-0000-4000-8000-000000000001:' || repeat('a', 64),
    10,
    60
  ),
  'an organization-prefixed network counter is consumed normally'
);

select is(
  (
    select organization_id
    from private.rate_limit_buckets
    where scope = 'pgtap-organization-network'
  ),
  '99100000-0000-4000-8000-000000000001'::uuid,
  'an existing organization prefix records exact tenant ownership'
);

select ok(
  private.consume_rate_limit(
    'pgtap-global-recovery',
    '99000000-0000-4000-8000-000000000001',
    10,
    60
  ),
  'a global user counter is consumed normally'
);

select is(
  (
    select organization_id
    from private.rate_limit_buckets
    where scope = 'pgtap-global-recovery'
  ),
  null::uuid,
  'a global user counter is not misclassified as organization state'
);

select lives_ok(
  $$delete from public.organizations
    where id = '99100000-0000-4000-8000-000000000001'$$,
  'deleting an organization removes its owned counter without weakening global counters'
);

select is(
  (
    select count(*)::bigint
    from private.rate_limit_buckets
    where scope in ('pgtap-organization-network', 'pgtap-global-recovery')
  ),
  1::bigint,
  'the organization counter is gone while the unrelated global counter remains'
);

select * from finish();
rollback;
