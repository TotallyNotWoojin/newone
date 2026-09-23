begin;
select plan(40);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: the personal realm with four accounts. Alice, Bob and Carol share
-- a group chat; Carol joined late, so her history starts after every message
-- here. Xavier is in the realm but not in the chat. Summaries are approved
-- for the realm so Alice can ask for one.
insert into auth.users (id, email, email_confirmed_at) values
  ('e1000000-0000-4000-8000-000000000001', 'projects-alice@example.test', now()),
  ('e1000000-0000-4000-8000-000000000002', 'projects-bob@example.test', now()),
  ('e1000000-0000-4000-8000-000000000003', 'projects-carol@example.test', now()),
  ('e1000000-0000-4000-8000-000000000004', 'projects-xavier@example.test', now());

select set_config('app.bff_service_context', 'on', true);
update public.profiles
set display_name = case user_id
    when 'e1000000-0000-4000-8000-000000000001' then 'Alice'
    when 'e1000000-0000-4000-8000-000000000002' then 'Bob'
    when 'e1000000-0000-4000-8000-000000000003' then 'Carol'
    else 'Xavier'
  end
where user_id::text like 'e1000000-%';
select set_config('app.bff_service_context', 'off', true);

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('e1100000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('e1100000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('e1100000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', now(), now(), 'aal1');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('e1100000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e1200000-0000-4000-8000-000000000001', 'web', decode(repeat('e1', 32), 'hex'), 'desktop'),
  ('e1100000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 'e1200000-0000-4000-8000-000000000002', 'ios', decode(repeat('e2', 32), 'hex'), 'iphone'),
  ('e1100000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000003', 'e1200000-0000-4000-8000-000000000003', 'android', decode(repeat('e3', 32), 'hex'), 'android'),
  ('e1100000-0000-4000-8000-000000000004', 'e1000000-0000-4000-8000-000000000004', 'e1200000-0000-4000-8000-000000000004', 'web', decode(repeat('e4', 32), 'hex'), 'desktop');

insert into public.organizations (
  id, slug, name, default_language, allow_member_direct_messages,
  dm_policy, require_mfa_for_admins, created_by_user_id
) values (
  '11111111-1111-4111-8111-111111111111', 'personal-realm', 'Gist', 'en',
  true, 'request_first', true, 'e1000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (organization_id, user_id, role, status, directory_visibility)
select '11111111-1111-4111-8111-111111111111', member_id, 'member', 'active', 'private'
from unnest(array[
  'e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002',
  'e1000000-0000-4000-8000-000000000003', 'e1000000-0000-4000-8000-000000000004'
]::uuid[]) member_id;
insert into public.organization_ai_policies (
  organization_id, enabled, approved_use_cases, provider_allowlist, route_policy,
  approved_by_user_id, approved_at
) values (
  '11111111-1111-4111-8111-111111111111', true, array['summary', 'translation'],
  array['openrouter'], 'approved_zero_retention', 'e1000000-0000-4000-8000-000000000001', now()
);

insert into public.conversations (id, organization_id, kind, name, visibility, created_by_user_id)
values (
  'e1300000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'group', 'Projects room', 'invite_only', 'e1000000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id, history_visible_from
) values
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'owner', 'e1000000-0000-4000-8000-000000000001', null),
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002', 'member', 'e1000000-0000-4000-8000-000000000001', null),
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000003', 'member', 'e1000000-0000-4000-8000-000000000001', now() + interval '1 second');

create temporary table ids (name text primary key, value text) on commit drop;
grant all on ids to public;

create function pg_temp.command(
  p_actor text, p_action text, p_project uuid, p_item uuid, p_name text, p_target jsonb, p_key text
) returns jsonb language sql as $$
  select public.bff_conversation_project_command(
    ('e1000000-0000-4000-8000-00000000000' || p_actor)::uuid,
    '11111111-1111-4111-8111-111111111111',
    ('e1100000-0000-4000-8000-00000000000' || p_actor)::uuid,
    'e1300000-0000-4000-8000-000000000001',
    p_action, p_project, p_item, p_name, p_target, p_key, repeat('a', 64)
  )
$$;
create function pg_temp.projects(p_actor text) returns jsonb language sql as $$
  select public.bff_read_conversation_projects(
    ('e1000000-0000-4000-8000-00000000000' || p_actor)::uuid,
    '11111111-1111-4111-8111-111111111111',
    ('e1100000-0000-4000-8000-00000000000' || p_actor)::uuid,
    'e1300000-0000-4000-8000-000000000001'
  )
$$;
create function pg_temp.id(p_name text) returns uuid language sql as $$
  select value::uuid from ids where name = p_name
$$;
create function pg_temp.act_as(p_actor text) returns void language sql as $$
  select set_config(
    'request.jwt.claims',
    '{"role":"service_role","sub":"e1000000-0000-4000-8000-00000000000' || p_actor
      || '","session_id":"e1100000-0000-4000-8000-00000000000' || p_actor || '","aal":"aal1"}',
    true
  );
$$;
create function pg_temp.send(p_actor text, p_nonce text, p_body text) returns bigint language plpgsql as $$
declare v_id bigint;
begin
  perform pg_temp.act_as(p_actor);
  perform set_config('app.bff_service_context', 'on', true);
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
  ) values (
    '11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001',
    ('e1000000-0000-4000-8000-00000000000' || p_actor)::uuid,
    ('e1400000-0000-4000-8000-0000000000' || p_nonce)::uuid,
    case when p_body is null then 'attachment' else 'text' end, p_body, 'en'
  ) returning id into v_id;
  perform set_config('app.bff_service_context', 'off', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  return v_id;
end $$;

-- 1-4: link extraction agrees with the app's link cards.
select is(
  (select array_agg(url order by ordinal) from private.extract_message_links(
    '링크: www.newoneinc.com, 그리고 (https://Example.COM/a?b=1#frag). newoneinc.com/path'
  )),
  array['https://www.newoneinc.com/', 'https://example.com/a?b=1', 'https://newoneinc.com/path'],
  'www., scheme and bare-domain links are found, punctuation peeled and fragments dropped'
);
select is(
  (select count(*)::integer from private.extract_message_links(
    'Mr.Kim ok.thanks 3.5kg http://localhost/x https://user@evil.com http://10.0.0.1/ file.txt'
  )),
  0,
  'names, words with a dot, local hosts, credentials, bare IPs and file names are not links'
);
select is(
  (select count(*)::integer from private.extract_message_links(
    (select string_agg('site' || n || '.com', ' ') from generate_series(1, 14) n)
  )),
  10,
  'at most ten links are taken from one message'
);
select is(
  (select count(*)::integer from private.extract_message_links('https://a.com https://a.com/ HTTPS://A.COM')),
  1,
  'one address written three ways is one link'
);

-- 5-8: projects are created, auto-selected for their creator, renamed, and
-- named uniquely within the chat.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into ids values ('hdg', (pg_temp.command('1', 'create', null, null, '  HDG  ', null, 'create-hdg') ->> 'project_id'));
select is(
  (select name from public.conversation_projects where id = pg_temp.id('hdg')),
  'HDG',
  'a new project keeps its trimmed name'
);
select is(
  pg_temp.projects('1') ->> 'selected_project_id',
  pg_temp.id('hdg')::text,
  'the creator is now filing into the new project'
);
select throws_ok(
  $$ select pg_temp.command('2', 'create', null, null, 'hdg', null, 'create-hdg-again') $$,
  '23505',
  null,
  'two projects in one chat cannot share a name'
);
insert into ids values ('maintenance', (pg_temp.command('2', 'create', null, null, 'Maintenance', null, 'create-maint') ->> 'project_id'));
select lives_ok(
  $$ select pg_temp.command('2', 'rename', pg_temp.id('maintenance'), null, 'Maintenance 2026', null, 'rename-maint') $$,
  'any member may rename a project'
);

-- 9-10: people outside the chat reach nothing.
select throws_ok(
  $$ select pg_temp.command('4', 'create', null, null, 'Intruder', null, 'create-intruder') $$,
  '42501',
  null,
  'a realm member outside the chat cannot create a project in it'
);
select throws_ok(
  $$ select pg_temp.projects('4') $$,
  '42501',
  null,
  'a realm member outside the chat cannot read its projects'
);

-- 11-15: what Alice sends while HDG is selected is filed into it.
insert into ids values ('link_message', pg_temp.send('1', '01', 'The site is www.newoneinc.com and the spec is at https://docs.example.com/spec.'));
select is(
  (select array_agg(url order by url) from public.conversation_project_items
   where project_id = pg_temp.id('hdg') and kind = 'link'),
  array['https://docs.example.com/spec', 'https://www.newoneinc.com/'],
  'links in a message sent while a project is selected go into its links'
);
insert into ids values ('bob_link', pg_temp.send('2', '02', 'Bob shares https://bob.example.com'));
select is(
  (select array_agg(project_id) from public.conversation_project_items where url = 'https://bob.example.com/'),
  array[pg_temp.id('maintenance')],
  'a member with a different project selected files into their own project only'
);
insert into ids values ('file_message', pg_temp.send('1', '03', null));
insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  storage_path, file_name, mime_type, byte_size, sha256_hex, scan_status,
  scan_completed_at, scanner_name, scanner_version, detected_mime_type
) values (
  'e1500000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'e1300000-0000-4000-8000-000000000001', (select value::bigint from ids where name = 'file_message'),
  'e1000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111/e1300000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/e1500000-0000-4000-8000-000000000001/upload',
  'HT contract.pdf', 'application/pdf', 2048, repeat('b', 64), 'clean',
  now(), 'consumer-no-scan', '1', 'application/pdf'
);
select is(
  (select count(*)::integer from public.conversation_project_items
   where project_id = pg_temp.id('hdg') and kind = 'upload'
     and attachment_id = 'e1500000-0000-4000-8000-000000000001'),
  1,
  'a file sent while a project is selected goes into its uploads'
);
select pg_temp.act_as('1');
select set_config('app.bff_service_context', 'on', true);
with inserted as (
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code, metadata
  ) values (
    '11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000004',
    'attachment', null, 'en', jsonb_build_object('purpose', 'conversation_avatar')
  ) returning id
)
insert into ids select 'avatar_message', id::text from inserted;
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$ insert into public.message_attachments (
       id, organization_id, conversation_id, message_id, created_by_user_id,
       storage_path, file_name, mime_type, byte_size, sha256_hex, scan_status,
       scan_completed_at, scanner_name, scanner_version, detected_mime_type
     ) values (
       'e1500000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
       'e1300000-0000-4000-8000-000000000001', (select value::bigint from ids where name = 'avatar_message'),
       'e1000000-0000-4000-8000-000000000001',
       '11111111-1111-4111-8111-111111111111/e1300000-0000-4000-8000-000000000001/e1000000-0000-4000-8000-000000000001/e1500000-0000-4000-8000-000000000002/upload',
       'avatar.png', 'image/png', 1024, repeat('c', 64), 'clean',
       now(), 'consumer-no-scan', '1', 'image/png'
     ) $$,
  'a chat photo upload still goes through with a project selected'
);
select is(
  (select count(*)::integer from public.conversation_project_items
   where attachment_id = 'e1500000-0000-4000-8000-000000000002'),
  0,
  'the chat photo is not filed as a project upload'
);

-- 16-19: a summary asked for while HDG is selected is saved into it and named
-- by the AI's title once written; a second one with the same title is #2.
-- Alice's history already has enough conversation for one.
select pg_temp.send('1', '05', 'We cut the wood to size in the workshop and will finish the edges so it looks presentable.');
select pg_temp.send('2', '06', 'Please paint the whole base white and send the original ppt file by email today.');
select pg_temp.send('1', '07', 'The acid delivery arrives at Otay on Friday; Francisco will confirm when it is in the warehouse.');
insert into ids values ('summary', (public.bff_request_conversation_summary_scope(
  'e1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
  'e1100000-0000-4000-8000-000000000001', 'e1300000-0000-4000-8000-000000000001',
  'everything', null, null, 0, 'en', 'summary-everything', repeat('d', 64)
) ->> 'summary_id'));
select is(
  (select title from public.conversation_project_items where summary_id = pg_temp.id('summary')),
  null,
  'a summary still being written is filed into the selected project without a name yet'
);
create function pg_temp.finish_summary(p_id uuid, p_topic text) returns void language plpgsql as $$
begin
  perform set_config('app.bff_service_context', 'on', true);
  update public.conversation_summaries
  set status = 'draft', primary_topic = p_topic, summary_body = '1. Alice: acid arrives Friday',
      key_topics = array[]::text[], decisions = '[]'::jsonb, action_items = '[]'::jsonb,
      ambiguities = array[]::text[], output_fingerprint = decode(repeat('ee', 32), 'hex'),
      processor_type = 'ai', provider = 'openrouter', model = 'test-model',
      processor_provenance = '{}'::jsonb
  where id = p_id;
  perform set_config('app.bff_service_context', 'off', true);
end $$;
select pg_temp.finish_summary(pg_temp.id('summary'), 'Acid delivery');
select is(
  (select title from public.conversation_project_items where summary_id = pg_temp.id('summary')),
  'Acid delivery #1',
  'once written, the saved summary is named after the AI''s title'
);
select is(
  private.project_summary_title(pg_temp.id('hdg'), 'Acid delivery'),
  'Acid delivery #2',
  'the next summary with the same title is numbered after it'
);
select is(
  private.project_summary_title(pg_temp.id('hdg'), repeat('word ', 30)),
  btrim(regexp_replace(left(repeat('word ', 30), 60), '\s+\S*$', '')) || ' #1',
  'a long title is clipped at a word to a file name''s length'
);

-- 20-24: every member reads the drawers; the rules of the timeline apply.
select is(
  (select count(*)::integer from jsonb_array_elements(pg_temp.projects('2') -> 'projects')),
  2,
  'Bob sees both projects'
);
select is(
  (select array_agg(item ->> 'kind' order by item ->> 'kind')
   from jsonb_array_elements(pg_temp.projects('2') -> 'items') item
   where item ->> 'project_id' = pg_temp.id('hdg')::text),
  array['link', 'link', 'summary', 'upload'],
  'Bob sees Alice''s links, file and saved summary in HDG'
);
select is(
  (select count(*)::integer from jsonb_array_elements(pg_temp.projects('3') -> 'items')),
  0,
  'Carol, whose history starts later, sees the projects but none of the earlier drawer contents'
);
insert into public.message_user_visibility (organization_id, conversation_id, message_id, user_id)
values (
  '11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001',
  (select value::bigint from ids where name = 'link_message'), 'e1000000-0000-4000-8000-000000000002'
);
select is(
  (select count(*)::integer from jsonb_array_elements(pg_temp.projects('2') -> 'items') item
   where item ->> 'kind' = 'link' and item ->> 'project_id' = pg_temp.id('hdg')::text),
  0,
  'a message Bob hid for himself takes its links out of his drawers'
);
select is(
  (select count(*)::integer from jsonb_array_elements(pg_temp.projects('1') -> 'items') item
   where item ->> 'kind' = 'link' and item ->> 'project_id' = pg_temp.id('hdg')::text),
  2,
  'the same links stay in Alice''s drawers'
);

-- 25-27: summaries saved to a project export for other members; unsaved ones
-- stay private to their requester.
select is(
  public.bff_read_summary_for_export(
    'e1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
    'e1100000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001',
    pg_temp.id('summary')
  ) ->> 'found',
  'true',
  'Bob may take out a summary Alice saved into a project'
);
select is(
  public.bff_read_summary_for_export(
    'e1000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
    'e1100000-0000-4000-8000-000000000003', 'e1300000-0000-4000-8000-000000000001',
    pg_temp.id('summary')
  ) ->> 'found',
  'false',
  'Carol may not take out a summary of messages from before she joined'
);
select pg_temp.command('1', 'remove_item', null,
  (select id from public.conversation_project_items where summary_id = pg_temp.id('summary')),
  null, null, 'remove-summary');
select is(
  public.bff_read_summary_for_export(
    'e1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
    'e1100000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001',
    pg_temp.id('summary')
  ) ->> 'found',
  'false',
  'taken back out of the project, the summary is Alice''s alone again'
);

-- 28-32: items are added by hand, renamed and removed.
select is(
  (pg_temp.command('1', 'add_item', pg_temp.id('hdg'), null, null,
    jsonb_build_object('kind', 'summary', 'summaryId', pg_temp.id('summary')), 'add-summary') ->> 'item_id') is not null,
  true,
  'a finished summary can be saved into a project by hand'
);
select is(
  (select title from public.conversation_project_items where summary_id = pg_temp.id('summary')),
  'Acid delivery #1',
  'saved by hand it is named the same way'
);
select lives_ok(
  $$ select pg_temp.command('1', 'rename_item', null,
       (select id from public.conversation_project_items where summary_id = pg_temp.id('summary')),
       'Acid summary for Luis', null, 'rename-summary') $$,
  'a saved summary can be renamed'
);
select throws_ok(
  $$ select pg_temp.command('2', 'add_item', pg_temp.id('maintenance'), null, null,
       jsonb_build_object('kind', 'summary', 'summaryId', pg_temp.id('summary')), 'bob-add-summary') $$,
  'P0002',
  null,
  'nobody but its requester can file a summary'
);
select is(
  (pg_temp.command('2', 'add_item', pg_temp.id('maintenance'), null, null,
    jsonb_build_object('kind', 'link', 'messageId', (select value from ids where name = 'bob_link')),
    'bob-add-link') ->> 'item_id') is not null,
  true,
  'a link in an earlier message can be saved into a project by hand'
);

-- 33-35: find by keyword names the chat a word, a translation, a file name or
-- a project came up in, and only for people in the chat.
select set_config('app.bff_service_context', 'on', true);
insert into public.message_translations (
  organization_id, conversation_id, message_id, source_language, target_language,
  source_body_sha256, status, translated_body, provider, model
) values (
  '11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000001',
  (select value::bigint from ids where name = 'bob_link'), 'en', 'ko',
  decode(repeat('f', 64), 'hex'), 'completed', '밥이 회의록 사이트를 공유합니다', 'openrouter', 'test-model'
);
select set_config('app.bff_service_context', 'off', true);
create function pg_temp.find(p_actor text, p_query text) returns jsonb language sql as $$
  select public.bff_find_keyword(
    ('e1000000-0000-4000-8000-00000000000' || p_actor)::uuid,
    '11111111-1111-4111-8111-111111111111',
    ('e1100000-0000-4000-8000-00000000000' || p_actor)::uuid,
    p_query, 30
  )
$$;
select is(
  (pg_temp.find('1', '회의') -> 'results' -> 0 ->> 'conversation_id'),
  'e1300000-0000-4000-8000-000000000001',
  'a Korean keyword finds the chat through the start of a longer word in a translation'
);
select is(
  (pg_temp.find('2', 'hdg') -> 'results' -> 0 -> 'projects' -> 0 ->> 'name'),
  'HDG',
  'a project name finds its chat, whatever the case'
);
select is(
  jsonb_array_length(pg_temp.find('4', 'acid') -> 'results'),
  0,
  'someone outside the chat finds nothing in it'
);

-- 36-37: deleting a project empties its drawers and anyone's selection of it,
-- and never the files or messages themselves.
select pg_temp.command('2', 'delete', pg_temp.id('hdg'), null, null, null, 'delete-hdg');
select is(
  (select count(*)::integer from public.conversation_project_items where project_id = pg_temp.id('hdg'))
  + (select count(*)::integer from public.conversation_project_selections where project_id = pg_temp.id('hdg')),
  0,
  'a deleted project takes its drawers and selections with it'
);
select is(
  (select count(*)::integer from public.message_attachments where id = 'e1500000-0000-4000-8000-000000000001'),
  1,
  'the file itself stays in the chat'
);

-- 38-40: a summary needs enough conversation, and asking again after a
-- failed one no longer collides with it.
select is(
  (public.bff_read_summary_readiness(
    'e1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
    'e1100000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001', null, 0
  ) -> 'ranges' -> 'everything' ->> 'ready'),
  'true',
  'a chat with a few substantial messages is ready for a summary'
);
insert into public.conversations (id, organization_id, kind, name, visibility, created_by_user_id)
values (
  'e1300000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'group', 'Quiet room', 'invite_only', 'e1000000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id, history_visible_from
) values
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'owner', 'e1000000-0000-4000-8000-000000000001', null),
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 'member', 'e1000000-0000-4000-8000-000000000001', null);
select pg_temp.act_as('1');
select set_config('app.bff_service_context', 'on', true);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000001', 'e1400000-0000-4000-8000-000000000011', 'text', '테스트', 'ko');
select pg_temp.act_as('2');
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values
  ('11111111-1111-4111-8111-111111111111', 'e1300000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000002', 'e1400000-0000-4000-8000-000000000012', 'text', 'ok thanks', 'en');
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$ select public.bff_request_conversation_summary_scope(
       'e1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
       'e1100000-0000-4000-8000-000000000001', 'e1300000-0000-4000-8000-000000000002',
       'everything', null, null, 0, 'en', 'quiet-summary', repeat('e', 64)
     ) $$,
  '42501',
  'summary_not_enough_conversation',
  'two short messages are not enough for a summary, and the readiness read agrees'
    || case when (public.bff_read_summary_readiness(
      'e1000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111',
      'e1100000-0000-4000-8000-000000000001', 'e1300000-0000-4000-8000-000000000002', null, 0
    ) -> 'ranges' -> 'everything' ->> 'ready') = 'false' then '' else ' (READINESS DISAGREES)' end
);
select public.bff_request_conversation_summary_scope(
  'e1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
  'e1100000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001',
  'everything', 'paint', null, 0, 'en', 'bob-summary-1', repeat('1', 64)
);
select set_config('app.bff_service_context', 'on', true);
update public.conversation_summaries set status = 'failed', failure_code = 'provider_unavailable'
where requested_by_user_id = 'e1000000-0000-4000-8000-000000000002' and scope_subject = 'paint';
select set_config('app.bff_service_context', 'off', true);
select lives_ok(
  $$ select public.bff_request_conversation_summary_scope(
       'e1000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111',
       'e1100000-0000-4000-8000-000000000002', 'e1300000-0000-4000-8000-000000000001',
       'everything', 'paint', null, 0, 'en', 'bob-summary-2', repeat('2', 64)
     ) $$,
  'asking again for the same recap after it failed makes a new one instead of a conflict'
);

select * from finish();
rollback;
