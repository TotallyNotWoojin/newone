begin;
select plan(37);

select has_table('public', 'profiles', 'profiles table exists');
select is(
  (
    select count(*)::bigint
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relname = any (array[
        'profiles', 'organizations', 'organization_units', 'organization_memberships',
        'organization_unit_members', 'member_blocks', 'contact_connections',
        'conversations', 'direct_conversation_pairs', 'conversation_members',
        'messages', 'message_translations', 'message_reactions',
        'conversation_read_cursors', 'announcements', 'announcement_recipients',
        'announcement_acknowledgements', 'shift_handoffs',
        'handoff_acknowledgements', 'message_attachments', 'device_registrations',
        'shift_assignments',
        'organization_invites', 'audit_events'
      ])
  ),
  24::bigint,
  'all application tables exist'
);
select is(
  (
    select count(*)::bigint
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relrowsecurity
      and relation.relname = any (array[
        'profiles', 'organizations', 'organization_units', 'organization_memberships',
        'organization_unit_members', 'member_blocks', 'contact_connections',
        'conversations', 'direct_conversation_pairs', 'conversation_members',
        'messages', 'message_translations', 'message_reactions',
        'conversation_read_cursors', 'announcements', 'announcement_recipients',
        'announcement_acknowledgements', 'shift_handoffs',
        'handoff_acknowledgements', 'message_attachments', 'device_registrations',
        'shift_assignments',
        'organization_invites', 'audit_events'
      ])
  ),
  24::bigint,
  'RLS is enabled on every public application table'
);
select is(
  (
    select count(*)::bigint
    from pg_class relation
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relkind = 'r'
      and relation.relforcerowsecurity
      and relation.relname = any (array[
        'profiles', 'organizations', 'organization_units', 'organization_memberships',
        'organization_unit_members', 'member_blocks', 'contact_connections',
        'conversations', 'direct_conversation_pairs', 'conversation_members',
        'messages', 'message_translations', 'message_reactions',
        'conversation_read_cursors', 'announcements', 'announcement_recipients',
        'announcement_acknowledgements', 'shift_handoffs',
        'handoff_acknowledgements', 'message_attachments', 'device_registrations',
        'shift_assignments',
        'organization_invites', 'audit_events'
      ])
  ),
  24::bigint,
  'RLS is forced on every public application table'
);
select is(
  (
    select count(*)::bigint
    from information_schema.role_table_grants grant_row
    where grant_row.grantee = 'anon'
      and grant_row.table_schema = 'public'
      and grant_row.table_name = any (array[
        'profiles', 'organizations', 'organization_units', 'organization_memberships',
        'organization_unit_members', 'member_blocks', 'contact_connections',
        'conversations', 'direct_conversation_pairs', 'conversation_members',
        'messages', 'message_translations', 'message_reactions',
        'conversation_read_cursors', 'announcements', 'announcement_recipients',
        'announcement_acknowledgements', 'shift_handoffs',
        'handoff_acknowledgements', 'message_attachments', 'device_registrations',
        'shift_assignments',
        'organization_invites', 'audit_events'
      ])
  ),
  0::bigint,
  'anonymous role has no application table privileges'
);
select ok(
  exists (
    select 1 from storage.buckets
    where id = 'message-attachments' and public = false and file_size_limit = 104857600
  ),
  'attachment bucket is private and size-limited'
);
select is(
  (select count(*)::bigint from pg_policies where schemaname = 'storage' and policyname like 'newone_attachments_%'),
  2::bigint,
  'storage has scoped read and write policies'
);
select is(
  (select count(*)::bigint from pg_policies where schemaname = 'realtime' and policyname like 'newone_realtime_%'),
  4::bigint,
  'Realtime has private topic policies'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'private.consume_rate_limit(text,text,integer,integer)',
    'execute'
  ),
  'rate-limit mutation primitive is not client executable'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.bff_create_direct_conversation(uuid,uuid,uuid,uuid,text,text)',
    'execute'
  ) and has_function_privilege(
    'service_role',
    'public.bff_create_direct_conversation(uuid,uuid,uuid,uuid,text,text)',
    'execute'
  ),
  'BFF command RPCs are service-role-only'
);
select ok(
  (
    select count(*) = 1
      and count(*) filter (
        where proc.oid =
          'public.hook_newone_custom_access_token(jsonb)'::regprocedure::oid
      ) = 1
    from pg_proc proc
    join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname = 'public' and proc.prosecdef
  )
  and has_function_privilege(
    'supabase_auth_admin',
    'public.hook_newone_custom_access_token(jsonb)',
    'execute'
  )
  and not has_function_privilege(
    'anon', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  )
  and not has_function_privilege(
    'authenticated', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  )
  and not has_function_privilege(
    'service_role', 'public.hook_newone_custom_access_token(jsonb)', 'execute'
  ),
  'the only public SECURITY DEFINER is the isolated Supabase Auth lifecycle hook'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'owner@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'member@example.test'),
  ('33333333-3333-4333-8333-333333333333', 'outsider@example.test');

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('15151515-1515-4515-8515-151515151515', '11111111-1111-4111-8111-111111111111', now(), now(), 'aal2'),
  ('25252525-2525-4525-8525-252525252525', '22222222-2222-4222-8222-222222222222', now(), now(), 'aal1'),
  ('35353535-3535-4535-8535-353535353535', '33333333-3333-4333-8333-333333333333', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('15151515-1515-4515-8515-151515151515', '11111111-1111-4111-8111-111111111111', '16161616-1616-4616-8616-161616161616', 'web', decode(repeat('11', 32), 'hex'), 'desktop'),
  ('25252525-2525-4525-8525-252525252525', '22222222-2222-4222-8222-222222222222', '26262626-2626-4626-8626-262626262626', 'web', decode(repeat('22', 32), 'hex'), 'desktop'),
  ('35353535-3535-4535-8535-353535353535', '33333333-3333-4333-8333-333333333333', '36363636-3636-4636-8636-363636363636', 'web', decode(repeat('33', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'alpha-company', 'Alpha Company', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'beta-company', 'Beta Company', '33333333-3333-4333-8333-333333333333');

insert into public.organization_memberships (organization_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '22222222-2222-4222-8222-222222222222', 'member'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333', 'owner');

insert into public.conversations (
  id, organization_id, kind, name, member_limit, posting_mode, join_policy,
  created_by_user_id
) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'group', 'Alpha operations', 500, 'all_members', 'inherit', '11111111-1111-4111-8111-111111111111'),
  ('c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'group', 'Safety crew', 500, 'all_members', 'inherit', '11111111-1111-4111-8111-111111111111'),
  ('c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'direct', null, 2, 'all_members', 'invite_only', '11111111-1111-4111-8111-111111111111'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'group', 'Beta operations', 500, 'all_members', 'inherit', '33333333-3333-4333-8333-333333333333');

insert into public.direct_conversation_pairs (
  organization_id, conversation_id, member_low_user_id, member_high_user_id
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3',
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '11111111-1111-4111-8111-111111111111', 'owner', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '22222222-2222-4222-8222-222222222222', 'member', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', '11111111-1111-4111-8111-111111111111', 'owner', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c2c2c2c2-c2c2-42c2-82c2-c2c2c2c2c2c2', '22222222-2222-4222-8222-222222222222', 'member', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', '11111111-1111-4111-8111-111111111111', 'member', '11111111-1111-4111-8111-111111111111'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', '22222222-2222-4222-8222-222222222222', 'member', '11111111-1111-4111-8111-111111111111'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', '33333333-3333-4333-8333-333333333333', 'owner', '33333333-3333-4333-8333-333333333333');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"11111111-1111-4111-8111-111111111111","session_id":"15151515-1515-4515-8515-151515151515","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '11111111-1111-4111-8111-111111111111',
  '10000000-0000-4000-8000-000000000001',
  'text', 'Alpha first'
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"22222222-2222-4222-8222-222222222222","session_id":"25252525-2525-4525-8525-252525252525","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '22222222-2222-4222-8222-222222222222',
  '10000000-0000-4000-8000-000000000002',
  'text', 'Alpha second'
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"11111111-1111-4111-8111-111111111111","session_id":"15151515-1515-4515-8515-151515151515","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '11111111-1111-4111-8111-111111111111',
  '10000000-0000-4000-8000-000000000004',
  'attachment', null
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"33333333-3333-4333-8333-333333333333","session_id":"35353535-3535-4535-8535-353535353535","aal":"aal2"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  '33333333-3333-4333-8333-333333333333',
  '10000000-0000-4000-8000-000000000003',
  'text', 'Beta private'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select is((select count(*)::bigint from public.profiles), 3::bigint, 'auth trigger provisions one profile per user');
select ok((select count(*) > 0 from public.audit_events), 'governance writes produce audit events');

select ok(
  not has_table_privilege('authenticated', 'public.messages', 'delete')
  and not has_table_privilege('authenticated', 'public.audit_events', 'insert')
  and not has_table_privilege('authenticated', 'public.audit_events', 'update')
  and not has_table_privilege('authenticated', 'public.audit_events', 'delete'),
  'clients have no hard-delete or audit-write privileges'
);

-- Production is RPC-only. Grant transaction-local table privileges only so
-- the remainder of this pgTAP file can exercise RLS policies directly; the
-- enclosing rollback guarantees these grants never survive the test.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function private.normalize_search_text(text) to authenticated;
grant execute on function private.current_session_active_for_org(uuid)
  to authenticated;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","session_id":"15151515-1515-4515-8515-151515151515","aal":"aal2"}',
  true
);

select is((select count(*)::bigint from public.organizations), 1::bigint, 'member sees only their organization');
select is((select count(*)::bigint from public.profiles), 2::bigint, 'directory hides profiles from other tenants');
select is(
  (select count(*)::bigint from public.messages where organization_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0::bigint,
  'member cannot read another tenant messages'
);
select throws_ok(
  $$select public.bff_create_group_conversation(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51515151-5151-4515-8515-515151515151',
    'Safety crew',
    array['22222222-2222-4222-8222-222222222222']::uuid[],
    'group',
    null,
    'foundation-group-denied',
    repeat('a', 64)
  )$$,
  '42501',
  null,
  'clients cannot execute group mutation RPCs directly'
);
select is(
  (select count(*)::bigint from public.conversations where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and kind = 'group'),
  2::bigint,
  'new group is visible after membership is created'
);
select throws_ok(
  $$select public.bff_create_direct_conversation(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51515151-5151-4515-8515-515151515151',
    '22222222-2222-4222-8222-222222222222',
    'foundation-direct-denied',
    repeat('b', 64)
  )$$,
  '42501',
  null,
  'clients cannot execute direct mutation RPCs directly'
);
select is(
  (select count(*)::bigint from public.direct_conversation_pairs where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  1::bigint,
  'direct conversation pair is unique and visible to its participants'
);
select throws_ok(
  $$select public.bff_send_message(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '51515151-5151-4515-8515-515151515151',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '10000000-0000-4000-8000-000000000004',
    'attachment',
    null,
    null,
    null,
    null,
    '{}'::jsonb,
    'foundation-message-denied',
    repeat('c', 64)
  )$$,
  '42501',
  null,
  'clients cannot execute message mutation RPCs directly'
);
select throws_ok(
  $$insert into public.message_translations (
    organization_id, conversation_id, message_id, source_language, target_language
  ) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select min(id) from public.messages where conversation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
    'ko',
    'es'
  )$$,
  '42501',
  null,
  'clients cannot forge provider translation rows'
);
select throws_ok(
  $$insert into public.message_attachments (
    id, organization_id, conversation_id, message_id, created_by_user_id,
    storage_path, file_name, mime_type, byte_size, scan_status
  ) values (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    (select max(id) from public.messages where conversation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' and sender_user_id = '11111111-1111-4111-8111-111111111111'),
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cccccccc-cccc-4ccc-8ccc-cccccccccccc/11111111-1111-4111-8111-111111111111/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/test.pdf',
    'test.pdf',
    'application/pdf',
    100,
    'clean'
  )$$,
  '42501',
  null,
  'clients cannot self-approve malware scans'
);
select lives_ok(
  $$insert into public.conversation_read_cursors (
    organization_id, conversation_id, user_id, last_read_message_id
  ) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '11111111-1111-4111-8111-111111111111',
    (select max(id) from public.messages where conversation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  )$$,
  'member can create a read cursor'
);
select throws_ok(
  $$update public.conversation_read_cursors
    set last_read_message_id = (
      select min(id) from public.messages where conversation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and conversation_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      and user_id = '11111111-1111-4111-8111-111111111111'$$,
  '22000',
  'read cursors cannot move backwards',
  'read cursor cannot move backward'
);
select lives_ok(
  $$insert into public.contact_connections (
    organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
  ) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '11111111-1111-4111-8111-111111111111'
  )$$,
  'member can request a contact connection'
);
select throws_ok(
  $$update public.contact_connections set status = 'accepted'
    where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and member_low_user_id = '11111111-1111-4111-8111-111111111111'
      and member_high_user_id = '22222222-2222-4222-8222-222222222222'$$,
  '42501',
  'requesters may only cancel pending requests',
  'requester cannot accept their own contact request'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","session_id":"25252525-2525-4525-8525-252525252525","aal":"aal1"}',
  true
);
select is(
  (select count(*)::bigint from public.messages where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  3::bigint,
  'second member can read their shared conversation'
);
select lives_ok(
  $$update public.contact_connections set status = 'accepted'
    where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and member_low_user_id = '11111111-1111-4111-8111-111111111111'
      and member_high_user_id = '22222222-2222-4222-8222-222222222222'$$,
  'contact recipient can accept a pending request'
);
select is(
  (
    select status from public.contact_connections
    where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      and member_low_user_id = '11111111-1111-4111-8111-111111111111'
      and member_high_user_id = '22222222-2222-4222-8222-222222222222'
  ),
  'accepted',
  'contact connection records the accepted state'
);
select lives_ok(
  $$insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
    values (
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111'
    )$$,
  'member can block another organization member'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","session_id":"15151515-1515-4515-8515-151515151515","aal":"aal2"}',
  true
);
select throws_ok(
  $$insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, body
  ) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    (select conversation_id from public.direct_conversation_pairs limit 1),
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000005',
    'blocked direct message'
  )$$,
  '42501',
  null,
  'a block prevents further direct messages in an existing thread'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated","session_id":"35353535-3535-4535-8535-353535353535","aal":"aal2"}',
  true
);
select is((select count(*)::bigint from public.organizations), 1::bigint, 'other tenant member sees only their own organization');
select is(
  (select count(*)::bigint from public.messages where organization_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0::bigint,
  'other tenant member cannot read Alpha messages'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"11111111-1111-4111-8111-111111111111","session_id":"15151515-1515-4515-8515-151515151515","aal":"aal2"}',
  true
);
-- This assertion deliberately isolates the composite tenant foreign key. The
-- posting guards are covered above and would reject the malformed link first.
alter table public.messages disable trigger messages_05_serialize_posting_access;
alter table public.messages disable trigger messages_10_validate_insert;
select throws_ok(
  $$insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, body
  ) values (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '11111111-1111-4111-8111-111111111111',
    '10000000-0000-4000-8000-000000000006',
    'cross-tenant link attempt'
  )$$,
  '23503',
  null,
  'composite foreign keys reject cross-tenant links'
);
alter table public.messages enable trigger messages_10_validate_insert;
alter table public.messages enable trigger messages_05_serialize_posting_access;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$update public.audit_events set event_type = 'tampered'
    where id = (select min(id) from public.audit_events)$$,
  '55000',
  'audit events are append-only',
  'audit events cannot be rewritten'
);
select * from finish();
rollback;
