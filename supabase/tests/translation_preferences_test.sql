begin;
select plan(16);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('7b000000-0000-4000-8000-000000000001', 'translation-sender@example.test', now()),
  ('7b000000-0000-4000-8000-000000000002', 'translation-off@example.test', now()),
  ('7b000000-0000-4000-8000-000000000003', 'translation-shared-ko@example.test', now()),
  ('7b000000-0000-4000-8000-000000000004', 'translation-auto-es@example.test', now());

update public.profiles
set preferred_language = case user_id
  when '7b000000-0000-4000-8000-000000000001' then 'en'
  when '7b000000-0000-4000-8000-000000000002' then 'ko'
  when '7b000000-0000-4000-8000-000000000003' then 'ko'
  else 'es'
end
where user_id in (
  '7b000000-0000-4000-8000-000000000001',
  '7b000000-0000-4000-8000-000000000002',
  '7b000000-0000-4000-8000-000000000003',
  '7b000000-0000-4000-8000-000000000004'
);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('7b100000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('7b100000-0000-4000-8000-000000000002', '7b000000-0000-4000-8000-000000000002', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('7b100000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001', '7b200000-0000-4000-8000-000000000001', 'web', decode(repeat('7b', 32), 'hex'), 'desktop'),
  ('7b100000-0000-4000-8000-000000000002', '7b000000-0000-4000-8000-000000000002', '7b200000-0000-4000-8000-000000000002', 'web', decode(repeat('7c', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '7b300000-0000-4000-8000-000000000001',
  'translation-preferences-contract', 'Translation preferences contract',
  '7b000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('7b300000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001', 'owner'),
  ('7b300000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000002', 'member'),
  ('7b300000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000003', 'member'),
  ('7b300000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000004', 'member');

insert into public.conversations (
  id, organization_id, kind, name, created_by_user_id
) values (
  '7b400000-0000-4000-8000-000000000001',
  '7b300000-0000-4000-8000-000000000001',
  'group', 'Translation controls',
  '7b000000-0000-4000-8000-000000000001'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('7b300000-0000-4000-8000-000000000001', '7b400000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000001', 'owner', '7b000000-0000-4000-8000-000000000001'),
  ('7b300000-0000-4000-8000-000000000001', '7b400000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000002', 'member', '7b000000-0000-4000-8000-000000000001'),
  ('7b300000-0000-4000-8000-000000000001', '7b400000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000003', 'member', '7b000000-0000-4000-8000-000000000001'),
  ('7b300000-0000-4000-8000-000000000001', '7b400000-0000-4000-8000-000000000001', '7b000000-0000-4000-8000-000000000004', 'member', '7b000000-0000-4000-8000-000000000001');

select col_type_is('public', 'conversation_preferences', 'translation_mode', 'text',
  'conversation preferences store a per-user translation mode');

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_enqueue_translation(uuid,uuid,uuid,uuid,bigint,text,text,text)',
    'execute'
  ) and not has_function_privilege(
    'authenticated',
    'public.bff_enqueue_translation(uuid,uuid,uuid,uuid,bigint,text,text,text)',
    'execute'
  ),
  'manual translation requests remain service-only BFF commands'
);

select is(
  public.bff_update_conversation_preferences(
    '7b000000-0000-4000-8000-000000000002',
    '7b300000-0000-4000-8000-000000000001',
    '7b100000-0000-4000-8000-000000000002',
    '7b400000-0000-4000-8000-000000000001',
    '{"translation_mode":"off"}'::jsonb,
    'translation-pref-off-0001', repeat('1', 64)
  ) ->> 'translation_mode',
  'off',
  'a member can opt out through the checked preference command'
);

create temporary table first_send on commit drop as
select public.bff_send_message(
  '7b000000-0000-4000-8000-000000000001',
  '7b300000-0000-4000-8000-000000000001',
  '7b100000-0000-4000-8000-000000000001',
  '7b400000-0000-4000-8000-000000000001',
  '7b500000-0000-4000-8000-000000000001',
  'text', 'Shared Korean target remains required.', 'en', null, null,
  '{}'::jsonb, 'translation-send-0001', repeat('2', 64)
) as response;

select is(
  (select response -> 'translation_targets' from first_send),
  '["es", "ko"]'::jsonb,
  'the opted-out Korean member contributes nothing while another automatic Korean recipient preserves the shared target'
);

select is(
  (select count(*)::bigint
   from public.message_translations translation
   where translation.organization_id = '7b300000-0000-4000-8000-000000000001'
     and translation.message_id = (select (response ->> 'message_id')::bigint from first_send)
     and translation.target_language = 'ko'),
  1::bigint,
  'shared Korean derived data may still exist for the independently authorized automatic recipient'
);

create temporary table off_bootstrap on commit drop as
select public.bff_bootstrap_messaging_state(
  '7b000000-0000-4000-8000-000000000002',
  '7b300000-0000-4000-8000-000000000001',
  '7b100000-0000-4000-8000-000000000002',
  '7b400000-0000-4000-8000-000000000001', null, 10, 10
) as response;

select is(
  (select response #>> '{conversations,0,preferences,translation_mode}' from off_bootstrap),
  'off',
  'bootstrap returns the authoritative per-conversation mode'
);

select is(
  (select jsonb_array_length(response #> '{timeline,messages,0,translations}') from off_bootstrap),
  0,
  'bootstrap hides all shared derived translations from the opted-out member'
);

select is(
  (select response #>> '{timeline,messages,0,body}' from off_bootstrap),
  'Shared Korean target remains required.',
  'the canonical original remains fully usable while translation is off'
);

select is(
  jsonb_array_length(public.bff_read_conversation_page(
    '7b000000-0000-4000-8000-000000000002',
    '7b300000-0000-4000-8000-000000000001',
    '7b100000-0000-4000-8000-000000000002',
    '7b400000-0000-4000-8000-000000000001', null, 10
  ) #> '{messages,0,translations}'),
  0,
  'paginated reads apply the same opt-out projection boundary'
);

select throws_ok(
  $$select public.bff_enqueue_translation(
    '7b000000-0000-4000-8000-000000000002',
    '7b300000-0000-4000-8000-000000000001',
    '7b100000-0000-4000-8000-000000000002',
    '7b400000-0000-4000-8000-000000000001',
    (select (response ->> 'message_id')::bigint from first_send),
    'ko', 'translation-manual-0001', repeat('3', 64)
  )$$,
  '42501',
  'automatic translation is disabled for this conversation',
  'a forged manual request cannot bypass the opted-out mode'
);

insert into public.conversation_preferences (
  organization_id, conversation_id, user_id, translation_mode
) values (
  '7b300000-0000-4000-8000-000000000001',
  '7b400000-0000-4000-8000-000000000001',
  '7b000000-0000-4000-8000-000000000003', 'off'
);

create temporary table second_send on commit drop as
select public.bff_send_message(
  '7b000000-0000-4000-8000-000000000001',
  '7b300000-0000-4000-8000-000000000001',
  '7b100000-0000-4000-8000-000000000001',
  '7b400000-0000-4000-8000-000000000001',
  '7b500000-0000-4000-8000-000000000002',
  'text', 'No automatic Korean recipient remains.', 'en', null, null,
  '{}'::jsonb, 'translation-send-0002', repeat('4', 64)
) as response;

select is(
  (select response -> 'translation_targets' from second_send),
  '["es"]'::jsonb,
  'only active automatic recipients contribute server-derived targets'
);

select is(
  (select count(*)::bigint
   from public.message_translations translation
   where translation.organization_id = '7b300000-0000-4000-8000-000000000001'
     and translation.message_id = (select (response ->> 'message_id')::bigint from second_send)
     and translation.target_language = 'ko'),
  0::bigint,
  'no Korean translation row is staged when every Korean recipient is off'
);

select is(
  public.bff_update_conversation_preferences(
    '7b000000-0000-4000-8000-000000000002',
    '7b300000-0000-4000-8000-000000000001',
    '7b100000-0000-4000-8000-000000000002',
    '7b400000-0000-4000-8000-000000000001',
    '{"translation_mode":"automatic"}'::jsonb,
    'translation-pref-on-0001', repeat('5', 64)
  ) ->> 'translation_mode',
  'automatic',
  'the member can explicitly re-enable automatic translation'
);

select ok(
  jsonb_array_length(public.bff_bootstrap_messaging_state(
    '7b000000-0000-4000-8000-000000000002',
    '7b300000-0000-4000-8000-000000000001',
    '7b100000-0000-4000-8000-000000000002',
    '7b400000-0000-4000-8000-000000000001', null, 10, 10
  ) #> '{timeline,messages,0,translations}') > 0,
  're-enabled members can receive an existing shared derived projection'
);

select throws_ok(
  $$insert into public.conversation_preferences (
    organization_id, conversation_id, user_id, translation_mode
  ) values (
    '7b300000-0000-4000-8000-000000000001',
    '7b400000-0000-4000-8000-000000000001',
    '7b000000-0000-4000-8000-000000000004', 'client_targets'
  )$$,
  '23514',
  null,
  'the database rejects unknown translation modes'
);

select is(
  private.translation_mode_for_user_internal(
    '7b300000-0000-4000-8000-000000000001',
    '7b400000-0000-4000-8000-000000000001',
    '7b000000-0000-4000-8000-000000000099'
  ),
  'off',
  'a non-member never receives an automatic translation mode'
);

select * from finish();
rollback;
