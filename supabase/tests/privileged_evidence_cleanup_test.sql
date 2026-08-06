begin;
select plan(10);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('98000000-0000-4000-8000-000000000001', 'maintenance-owner@example.test', now()),
  ('98000000-0000-4000-8000-000000000002', 'maintenance-member@example.test', now());

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '98100000-0000-4000-8000-000000000001',
  'maintenance-cleanup-contract',
  'Maintenance Cleanup Contract',
  '98000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (organization_id, user_id, role) values
  ('98100000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 'owner'),
  ('98100000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000002', 'member');

insert into public.conversations (
  id, organization_id, kind, name, visibility, created_by_user_id
) values (
  '98200000-0000-4000-8000-000000000001',
  '98100000-0000-4000-8000-000000000001',
  'group',
  'Maintenance evidence room',
  'invite_only',
  '98000000-0000-4000-8000-000000000001'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('98100000-0000-4000-8000-000000000001', '98200000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000001', 'owner', '98000000-0000-4000-8000-000000000001'),
  ('98100000-0000-4000-8000-000000000001', '98200000-0000-4000-8000-000000000001', '98000000-0000-4000-8000-000000000002', 'member', '98000000-0000-4000-8000-000000000001');

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"98000000-0000-4000-8000-000000000001"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body, language_code
) values (
  '98100000-0000-4000-8000-000000000001',
  '98200000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000001',
  '98300000-0000-4000-8000-000000000001',
  'text',
  'Controlled cleanup test input',
  'en'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.message_mentions (
  organization_id, conversation_id, message_id, mentioned_user_id
)
select
  '98100000-0000-4000-8000-000000000001',
  '98200000-0000-4000-8000-000000000001',
  message.id,
  '98000000-0000-4000-8000-000000000002'
from public.messages message
where message.client_nonce = '98300000-0000-4000-8000-000000000001';

select is(
  (select count(*)::bigint from private.message_versions
   where organization_id = '98100000-0000-4000-8000-000000000001'),
  1::bigint,
  'the controlled message creates a real immutable version row'
);
select is(
  (select count(*)::bigint from public.message_mentions
   where organization_id = '98100000-0000-4000-8000-000000000001'),
  1::bigint,
  'the controlled message creates a real immutable mention row'
);
select ok(
  (select count(*) from public.audit_events
   where organization_id = '98100000-0000-4000-8000-000000000001') > 0,
  'the controlled workflow creates append-only audit evidence'
);

select throws_ok(
  $$delete from private.message_versions
    where organization_id = '98100000-0000-4000-8000-000000000001'$$,
  '22000',
  'message versions are immutable',
  'ordinary maintenance cannot delete message versions'
);
select throws_ok(
  $$delete from public.message_mentions
    where organization_id = '98100000-0000-4000-8000-000000000001'$$,
  '22000',
  'immutable records cannot be updated or deleted',
  'ordinary maintenance cannot delete immutable mentions'
);
select throws_ok(
  $$delete from public.audit_events
    where organization_id = '98100000-0000-4000-8000-000000000001'$$,
  '55000',
  'audit events are append-only',
  'ordinary maintenance cannot delete audit evidence'
);

select set_config('app.allow_audit_maintenance', 'on', true);
delete from private.message_versions
where organization_id = '98100000-0000-4000-8000-000000000001';
delete from public.message_mentions
where organization_id = '98100000-0000-4000-8000-000000000001';
delete from public.audit_events
where organization_id = '98100000-0000-4000-8000-000000000001';

select is(
  (select count(*)::bigint from private.message_versions
   where organization_id = '98100000-0000-4000-8000-000000000001'),
  0::bigint,
  'the privileged transaction-local gate deletes only targeted message versions'
);
select is(
  (select count(*)::bigint from public.message_mentions
   where organization_id = '98100000-0000-4000-8000-000000000001'),
  0::bigint,
  'the privileged transaction-local gate deletes only targeted mentions'
);
select is(
  (select count(*)::bigint from public.audit_events
   where organization_id = '98100000-0000-4000-8000-000000000001'),
  0::bigint,
  'the privileged transaction-local gate deletes only targeted audit evidence'
);

insert into public.audit_events (
  organization_id, actor_user_id, event_type, target_type, target_id, metadata
) values (
  '98100000-0000-4000-8000-000000000001',
  '98000000-0000-4000-8000-000000000001',
  'maintenance.proof',
  'organization',
  '98100000-0000-4000-8000-000000000001',
  '{}'::jsonb
);
select throws_ok(
  $$update public.audit_events set event_type = 'maintenance.tamper'
    where organization_id = '98100000-0000-4000-8000-000000000001'$$,
  '55000',
  'audit events are append-only',
  'the maintenance gate remains DELETE-only'
);

select * from finish();
rollback;
