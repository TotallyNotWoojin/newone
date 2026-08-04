begin;
create extension if not exists dblink with schema extensions;
select plan(13);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $setup_fixture$
begin
  perform extensions.dblink_connect(
    'handoff_cas_writer',
    'host=supabase_db_newone port=5432 dbname=postgres user=postgres password=postgres sslmode=disable'
  );
  -- Fixture teardown is the only place that bypasses immutable/audit triggers.
  -- It uses the local Supabase test administrator and an exact, reserved test
  -- identity; the writer/loser connections still exercise production BFF code
  -- as the ordinary non-superuser database role.
  perform extensions.dblink_connect(
    'handoff_cas_cleanup',
    'host=supabase_db_newone port=5432 dbname=postgres user=supabase_admin password=postgres sslmode=disable'
  );
  perform extensions.dblink_exec(
    'handoff_cas_cleanup',
    $cleanup$do $remote$
    declare
      v_table record;
    begin
      perform set_config('request.jwt.claims', '{"role":"service_role"}', false);
      perform set_config('session_replication_role', 'replica', true);
      for v_table in
        select column_row.table_schema, column_row.table_name
        from information_schema.columns column_row
        join information_schema.tables table_row
          on table_row.table_schema = column_row.table_schema
         and table_row.table_name = column_row.table_name
         and table_row.table_type = 'BASE TABLE'
        where column_row.column_name = 'organization_id'
          and column_row.table_schema in ('public', 'private')
      loop
        execute format(
          'delete from %I.%I where organization_id = $1',
          v_table.table_schema, v_table.table_name
        ) using '9a000000-0000-4000-8000-000000000001'::uuid;
      end loop;
      delete from public.organizations
        where id = '9a000000-0000-4000-8000-000000000001';
      delete from private.session_installations
        where user_id = '9a000000-0000-4000-8000-000000000002';
      delete from public.profiles
        where user_id = '9a000000-0000-4000-8000-000000000002';
      delete from auth.sessions
        where id = '9a000000-0000-4000-8000-000000000003';
      delete from auth.users
        where id = '9a000000-0000-4000-8000-000000000002';
      perform set_config('session_replication_role', 'origin', true);
    end
    $remote$$cleanup$
  );
  perform extensions.dblink_exec(
    'handoff_cas_writer',
    $setup$do $remote$
    begin
      perform set_config('request.jwt.claims', '{"role":"service_role"}', false);

      insert into auth.users (id, email, email_confirmed_at) values (
        '9a000000-0000-4000-8000-000000000002',
        'handoff-cas-owner@example.test',
        now()
      );
      insert into auth.sessions (id, user_id, created_at, updated_at, aal) values (
        '9a000000-0000-4000-8000-000000000003',
        '9a000000-0000-4000-8000-000000000002',
        now(), now(), 'aal1'
      );
      insert into private.session_installations (
        session_id, user_id, installation_id, platform,
        user_agent_hash, user_agent_family
      ) values (
        '9a000000-0000-4000-8000-000000000003',
        '9a000000-0000-4000-8000-000000000002',
        '9a000000-0000-4000-8000-000000000004',
        'web', decode(repeat('9a', 32), 'hex'), 'desktop'
      );
      insert into public.organizations (
        id, slug, name, created_by_user_id
      ) values (
        '9a000000-0000-4000-8000-000000000001',
        'handoff-cas-contract', 'Handoff CAS contract',
        '9a000000-0000-4000-8000-000000000002'
      );
      insert into public.organization_memberships (
        organization_id, user_id, role, joined_at
      ) values (
        '9a000000-0000-4000-8000-000000000001',
        '9a000000-0000-4000-8000-000000000002', 'owner',
        now() - interval '1 day'
      );
      insert into public.conversations (
        id, organization_id, kind, name, member_limit, posting_mode,
        join_policy, created_by_user_id
      ) values (
        '9a000000-0000-4000-8000-000000000005',
        '9a000000-0000-4000-8000-000000000001',
        'shift', 'CAS shift', 500, 'all_members', 'invite_only',
        '9a000000-0000-4000-8000-000000000002'
      );
      insert into public.conversation_members (
        organization_id, conversation_id, user_id, role, joined_by_user_id
      ) values (
        '9a000000-0000-4000-8000-000000000001',
        '9a000000-0000-4000-8000-000000000005',
        '9a000000-0000-4000-8000-000000000002', 'owner',
        '9a000000-0000-4000-8000-000000000002'
      );
      perform set_config(
        'request.jwt.claims',
        '{"role":"service_role","sub":"9a000000-0000-4000-8000-000000000002","session_id":"9a000000-0000-4000-8000-000000000003","aal":"aal1"}',
        false
      );
      insert into public.messages (
        id, organization_id, conversation_id, sender_user_id,
        client_nonce, kind, body
      ) overriding system value values (
        9900001,
        '9a000000-0000-4000-8000-000000000001',
        '9a000000-0000-4000-8000-000000000005',
        '9a000000-0000-4000-8000-000000000002',
        '9a000000-0000-4000-8000-000000000006',
        'text', 'Gauge P-14 reads 41 PSI.'
      );
      perform set_config(
        'request.jwt.claims',
        '{"role":"service_role","sub":"9a000000-0000-4000-8000-000000000002","session_id":"9a000000-0000-4000-8000-000000000003","aal":"aal1"}',
        false
      );
      insert into public.shift_handoffs (
        id, organization_id, conversation_id, author_user_id,
        title, details, source_language, shift_started_at, shift_ended_at,
        source_message_ids, source_fingerprint, acknowledgement_due_at
      ) values (
        '9a000000-0000-4000-8000-000000000007',
        '9a000000-0000-4000-8000-000000000001',
        '9a000000-0000-4000-8000-000000000005',
        '9a000000-0000-4000-8000-000000000002',
        'Baseline handoff', 'Baseline pressure reading.', 'en',
        '2030-08-10T00:00:00Z', '2030-08-10T08:00:00Z',
        array[9900001]::bigint[],
        extensions.digest(convert_to('baseline', 'UTF8'), 'sha256'),
        '2030-08-10T08:30:00Z'
      );
    end
    $remote$$setup$
  );
  perform extensions.dblink_connect(
    'handoff_cas_loser',
    'host=supabase_db_newone port=5432 dbname=postgres user=postgres password=postgres sslmode=disable'
  );
end;
$setup_fixture$;

create temporary table handoff_cas_fixture on commit drop as
select handoff.id as handoff_id, version.id as version_id
from public.shift_handoffs handoff
join public.handoff_versions version
  on version.organization_id = handoff.organization_id
 and version.handoff_id = handoff.id
where handoff.organization_id = '9a000000-0000-4000-8000-000000000001'
  and handoff.id = '9a000000-0000-4000-8000-000000000007'
  and version.version_number = 1;

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"9a000000-0000-4000-8000-000000000002","session_id":"9a000000-0000-4000-8000-000000000003","aal":"aal1"}',
  true
);

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_correct_handoff_v2(uuid,uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,timestamptz,bigint[],timestamptz,text,text,text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_correct_handoff_v2(uuid,uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,timestamptz,bigint[],timestamptz,text,text,text)',
    'execute'
  )
  and not (
    select function.prosecdef
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.proname = 'bff_correct_handoff_v2'
  ),
  'the CAS wrapper is service-role-only and SECURITY INVOKER'
);

select is(
  (select count(*)::bigint from handoff_cas_fixture),
  1::bigint,
  'the concurrency fixture starts from one exact immutable version'
);

select throws_ok(
  $sql$select public.bff_correct_handoff_v2(
    '9a000000-0000-4000-8000-000000000002',
    '9a000000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000003',
    '9a000000-0000-4000-8000-000000000007',
    '9a000000-0000-4000-8000-000000000099', 1,
    'Wrong-id correction', 'Must never commit.', 'en',
    '2030-08-10T00:00:00Z', '2030-08-10T08:00:00Z',
    array[9900001]::bigint[], '2030-08-10T08:30:00Z',
    'Wrong expected version id', 'handoff-cas-wrong-id', repeat('1', 64)
  )$sql$,
  '40001',
  'handoff version conflict',
  'a matching version number cannot substitute for the exact expected version id'
);

select throws_ok(
  $sql$select public.bff_correct_handoff_v2(
    '9a000000-0000-4000-8000-000000000002',
    '9a000000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000003',
    '9a000000-0000-4000-8000-000000000007',
    (select version_id from handoff_cas_fixture), 2,
    'Wrong-number correction', 'Must never commit.', 'en',
    '2030-08-10T00:00:00Z', '2030-08-10T08:00:00Z',
    array[9900001]::bigint[], '2030-08-10T08:30:00Z',
    'Wrong expected version number', 'handoff-cas-wrong-number', repeat('2', 64)
  )$sql$,
  '40001',
  'handoff version conflict',
  'a matching version id cannot substitute for the exact expected version number'
);

do $start_race$
declare
  v_expected_version_id uuid := (select version_id from handoff_cas_fixture);
begin
  perform extensions.dblink_exec('handoff_cas_writer', 'begin');
  perform extensions.dblink_exec(
    'handoff_cas_writer',
    $lock$do $remote$
    begin
      perform 1
      from public.shift_handoffs
      where organization_id = '9a000000-0000-4000-8000-000000000001'
        and id = '9a000000-0000-4000-8000-000000000007'
      for update;
    end
    $remote$$lock$
  );
  perform extensions.dblink_exec(
    'handoff_cas_loser',
    format($create$create or replace function pg_temp.attempt_stale_handoff_correction()
      returns text language plpgsql as $body$
      begin
        perform set_config(
          'request.jwt.claims',
          '{"role":"service_role","sub":"9a000000-0000-4000-8000-000000000002","session_id":"9a000000-0000-4000-8000-000000000003","aal":"aal1"}',
          false
        );
        perform public.bff_correct_handoff_v2(
          '9a000000-0000-4000-8000-000000000002',
          '9a000000-0000-4000-8000-000000000001',
          '9a000000-0000-4000-8000-000000000003',
          '9a000000-0000-4000-8000-000000000007',
          %L::uuid, 1,
          'Losing correction', 'This stale write must not commit.', 'en',
          '2030-08-10T00:00:00Z', '2030-08-10T08:00:00Z',
          array[9900001]::bigint[], '2030-08-10T08:30:00Z',
          'Concurrent stale correction', 'handoff-cas-loser', repeat('3', 64)
        );
        return 'committed';
      exception when serialization_failure then
        return 'stale';
      end
      $body$$create$, v_expected_version_id)
  );
  perform extensions.dblink_send_query(
    'handoff_cas_loser',
    'select pg_temp.attempt_stale_handoff_correction() as result'
  );
end;
$start_race$;

select pg_sleep(0.15);
select is(
  extensions.dblink_is_busy('handoff_cas_loser'),
  1,
  'the competing correction waits behind the handoff row lock'
);

create temporary table handoff_cas_winner_response (
  response jsonb not null
) on commit drop;

insert into handoff_cas_winner_response (response)
select result.response
from extensions.dblink(
  'handoff_cas_writer',
  $query$select public.bff_correct_handoff_v2(
    '9a000000-0000-4000-8000-000000000002',
    '9a000000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000003',
    '9a000000-0000-4000-8000-000000000007',
    (select id from public.handoff_versions
      where organization_id = '9a000000-0000-4000-8000-000000000001'
        and handoff_id = '9a000000-0000-4000-8000-000000000007'
        and version_number = 1),
    1, 'Winning correction', 'Gauge P-14 is confirmed at 41 PSI.', 'en',
    '2030-08-10T00:00:00Z', '2030-08-10T08:00:00Z',
    array[9900001]::bigint[], '2030-08-10T08:30:00Z',
    'Confirmed pressure correction', 'handoff-cas-winner', repeat('4', 64)
  ) as response$query$
) as result(response jsonb);

select is(
  (select (response ->> 'version_number')::integer from handoff_cas_winner_response),
  2,
  'the lock holder creates version two from the expected version one'
);

select extensions.dblink_exec('handoff_cas_writer', 'commit');

create temporary table handoff_cas_loser_response (
  result text not null
) on commit drop;

insert into handoff_cas_loser_response (result)
select response.result
from extensions.dblink_get_result('handoff_cas_loser') as response(result text);

do $drain_loser$
begin
  perform response.result
  from extensions.dblink_get_result('handoff_cas_loser') as response(result text);
end;
$drain_loser$;

select is(
  (select result from handoff_cas_loser_response),
  'stale',
  'the serialized loser rejects its stale expected version instead of creating version three'
);

select is(
  (select count(*)::bigint
    from public.handoff_versions
    where organization_id = '9a000000-0000-4000-8000-000000000001'
      and handoff_id = '9a000000-0000-4000-8000-000000000007'),
  2::bigint,
  'exactly one correction version exists after the concurrent race'
);

select ok(
  exists (
    select 1
    from public.handoff_versions corrected
    join handoff_cas_fixture expected
      on expected.version_id = corrected.correction_of_version_id
    where corrected.organization_id = '9a000000-0000-4000-8000-000000000001'
      and corrected.handoff_id = '9a000000-0000-4000-8000-000000000007'
      and corrected.version_number = 2
      and corrected.title = 'Winning correction'
  ),
  'the winner records the exact corrected version as immutable provenance'
);

create temporary table handoff_cas_replay_response (
  response jsonb not null
) on commit drop;

insert into handoff_cas_replay_response (response)
select result.response
from extensions.dblink(
  'handoff_cas_writer',
  $query$select public.bff_correct_handoff_v2(
      '9a000000-0000-4000-8000-000000000002',
      '9a000000-0000-4000-8000-000000000001',
      '9a000000-0000-4000-8000-000000000003',
      '9a000000-0000-4000-8000-000000000007',
      (select id from public.handoff_versions
        where organization_id = '9a000000-0000-4000-8000-000000000001'
          and handoff_id = '9a000000-0000-4000-8000-000000000007'
          and version_number = 1),
      1,
      'Winning correction', 'Gauge P-14 is confirmed at 41 PSI.', 'en',
      '2030-08-10T00:00:00Z', '2030-08-10T08:00:00Z',
      array[9900001]::bigint[], '2030-08-10T08:30:00Z',
      'Confirmed pressure correction', 'handoff-cas-winner', repeat('4', 64)
    ) as response$query$
) as result(response jsonb);

select is(
  (select response ->> 'handoff_version_id' from handoff_cas_replay_response),
  (select response ->> 'handoff_version_id' from handoff_cas_winner_response),
  'an exact idempotent replay returns the original successful version after it becomes stale'
);

select is(
  (select count(*)::bigint
    from public.handoff_versions
    where organization_id = '9a000000-0000-4000-8000-000000000001'
      and handoff_id = '9a000000-0000-4000-8000-000000000007'),
  2::bigint,
  'idempotent replay does not create another immutable version'
);

select throws_ok(
  $sql$select public.bff_correct_handoff_v2(
    '9a000000-0000-4000-8000-000000000002',
    '9a000000-0000-4000-8000-000000000001',
    '9a000000-0000-4000-8000-000000000003',
    '9a000000-0000-4000-8000-000000000007',
    (select version_id from handoff_cas_fixture), 1,
    'Fresh stale correction', 'Must never create version three.', 'en',
    '2030-08-10T00:00:00Z', '2030-08-10T08:00:00Z',
    array[9900001]::bigint[], '2030-08-10T08:30:00Z',
    'Fresh request from stale state', 'handoff-cas-fresh-stale', repeat('5', 64)
  )$sql$,
  '40001',
  'handoff version conflict',
  'a fresh request based on the stale version is rejected'
);

select is(
  (select count(*)::bigint
    from public.handoff_versions
    where organization_id = '9a000000-0000-4000-8000-000000000001'
      and handoff_id = '9a000000-0000-4000-8000-000000000007'),
  2::bigint,
  'all stale paths leave the immutable version chain unchanged'
);

do $cleanup_fixture$
begin
  perform extensions.dblink_exec(
    'handoff_cas_cleanup',
    $cleanup$do $remote$
    declare
      v_table record;
    begin
      perform set_config('session_replication_role', 'replica', true);
      for v_table in
        select column_row.table_schema, column_row.table_name
        from information_schema.columns column_row
        join information_schema.tables table_row
          on table_row.table_schema = column_row.table_schema
         and table_row.table_name = column_row.table_name
         and table_row.table_type = 'BASE TABLE'
        where column_row.column_name = 'organization_id'
          and column_row.table_schema in ('public', 'private')
      loop
        execute format(
          'delete from %I.%I where organization_id = $1',
          v_table.table_schema, v_table.table_name
        ) using '9a000000-0000-4000-8000-000000000001'::uuid;
      end loop;
      delete from public.organizations
        where id = '9a000000-0000-4000-8000-000000000001';
      delete from private.session_installations
        where user_id = '9a000000-0000-4000-8000-000000000002';
      delete from public.profiles
        where user_id = '9a000000-0000-4000-8000-000000000002';
      delete from auth.sessions
        where id = '9a000000-0000-4000-8000-000000000003';
      delete from auth.users
        where id = '9a000000-0000-4000-8000-000000000002';
      perform set_config('session_replication_role', 'origin', true);
    end
    $remote$$cleanup$
  );
  perform extensions.dblink_disconnect('handoff_cas_writer');
  perform extensions.dblink_disconnect('handoff_cas_loser');
  perform extensions.dblink_disconnect('handoff_cas_cleanup');
end;
$cleanup_fixture$;

select * from finish();
rollback;
