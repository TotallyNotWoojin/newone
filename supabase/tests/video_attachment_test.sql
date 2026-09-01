begin;
select plan(6);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Fixtures: one workspace, one conversation, and attachment-kind messages to
-- hang grant rows from.
insert into auth.users (id, email, email_confirmed_at) values
  ('99800000-0000-4000-8000-000000000001', 'video-sender@example.test', now());

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '99810000-0000-4000-8000-000000000001', 'video-attachment-org', 'Video org',
  '99800000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (organization_id, user_id, role, status) values (
  '99810000-0000-4000-8000-000000000001', '99800000-0000-4000-8000-000000000001', 'owner', 'active'
);
insert into public.conversations (
  id, organization_id, kind, name, visibility, created_by_user_id
) values (
  '99820000-0000-4000-8000-000000000001', '99810000-0000-4000-8000-000000000001',
  'group', 'Video room', 'invite_only', '99800000-0000-4000-8000-000000000001'
);
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id, history_visible_from
) values (
  '99810000-0000-4000-8000-000000000001', '99820000-0000-4000-8000-000000000001',
  '99800000-0000-4000-8000-000000000001', 'owner', '99800000-0000-4000-8000-000000000001', null
);
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"99800000-0000-4000-8000-000000000001","session_id":"99830000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values
  ('99810000-0000-4000-8000-000000000001', '99820000-0000-4000-8000-000000000001', '99800000-0000-4000-8000-000000000001', '99840000-0000-4000-8000-000000000001', 'attachment', null),
  ('99810000-0000-4000-8000-000000000001', '99820000-0000-4000-8000-000000000001', '99800000-0000-4000-8000-000000000001', '99840000-0000-4000-8000-000000000002', 'attachment', null);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- 1: the private bucket allows the two video containers under the raised
-- storage backstop.
select ok(
  exists (
    select 1 from storage.buckets
    where id = 'message-attachments'
      and public = false
      and file_size_limit = 104857600
      and allowed_mime_types @> array['video/mp4', 'video/quicktime']
      and not (allowed_mime_types @> array['video/x-msvideo'])
  ),
  'the attachment bucket allows exactly the two video containers at 100 MiB'
);

-- 2-4: the row constraint enforces the per-type byte caps.
select lives_ok(
  $video$
    insert into public.message_attachments (
      id, organization_id, conversation_id, message_id, created_by_user_id,
      storage_path, file_name, mime_type, byte_size, sha256_hex
    ) values (
      '99850000-0000-4000-8000-000000000001',
      '99810000-0000-4000-8000-000000000001',
      '99820000-0000-4000-8000-000000000001',
      (select id from public.messages where client_nonce = '99840000-0000-4000-8000-000000000001'),
      '99800000-0000-4000-8000-000000000001',
      '99810000-0000-4000-8000-000000000001/99820000-0000-4000-8000-000000000001/99800000-0000-4000-8000-000000000001/99850000-0000-4000-8000-000000000001/upload',
      'clip.mp4', 'video/mp4', 94371840, repeat('a', 64)
    )
  $video$,
  'a 90 MiB video/mp4 grant row is accepted'
);
select throws_ok(
  $video$
    insert into public.message_attachments (
      id, organization_id, conversation_id, message_id, created_by_user_id,
      storage_path, file_name, mime_type, byte_size, sha256_hex
    ) values (
      '99850000-0000-4000-8000-000000000002',
      '99810000-0000-4000-8000-000000000001',
      '99820000-0000-4000-8000-000000000001',
      (select id from public.messages where client_nonce = '99840000-0000-4000-8000-000000000002'),
      '99800000-0000-4000-8000-000000000001',
      '99810000-0000-4000-8000-000000000001/99820000-0000-4000-8000-000000000001/99800000-0000-4000-8000-000000000001/99850000-0000-4000-8000-000000000002/upload',
      'huge.jpg', 'image/jpeg', 94371840, repeat('b', 64)
    )
  $video$,
  '23514',
  null,
  'non-video attachments keep the 25 MiB cap'
);
select throws_ok(
  $video$
    insert into public.message_attachments (
      id, organization_id, conversation_id, message_id, created_by_user_id,
      storage_path, file_name, mime_type, byte_size, sha256_hex
    ) values (
      '99850000-0000-4000-8000-000000000003',
      '99810000-0000-4000-8000-000000000001',
      '99820000-0000-4000-8000-000000000001',
      (select id from public.messages where client_nonce = '99840000-0000-4000-8000-000000000002'),
      '99800000-0000-4000-8000-000000000001',
      '99810000-0000-4000-8000-000000000001/99820000-0000-4000-8000-000000000001/99800000-0000-4000-8000-000000000001/99850000-0000-4000-8000-000000000003/upload',
      'oversized.mov', 'video/quicktime', 104857601, repeat('c', 64)
    )
  $video$,
  '23514',
  null,
  'video attachments are capped at 100 MiB'
);

-- 5-6: the trusted grant and scan validators carry the same allowlist.
select ok(
  pg_get_functiondef(
    'private.bff_create_attachment_upload_pre_dynamic_group_impl(uuid,uuid,uuid,uuid,bigint,text,text,bigint,text,text,text)'::regprocedure
  ) like '%''video/mp4'', ''video/quicktime''%'
  and pg_get_functiondef(
    'private.bff_create_attachment_upload_pre_dynamic_group_impl(uuid,uuid,uuid,uuid,bigint,text,text,bigint,text,text,text)'::regprocedure
  ) like '%104857600%',
  'the upload grant enforces the video allowlist and the 100 MiB video cap'
);
select ok(
  pg_get_functiondef(
    'private.bff_complete_attachment_scan_impl(uuid,bigint,uuid,text,text,text,text,text)'::regprocedure
  ) like '%''video/mp4'', ''video/quicktime''%',
  'a detected video type is an allowed clean scan outcome'
);

select * from finish();
rollback;
