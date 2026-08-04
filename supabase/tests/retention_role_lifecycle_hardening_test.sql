begin;
select plan(15);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('c1000000-0000-4000-8000-000000000001', 'lifecycle-owner@example.test', now()),
  ('c1000000-0000-4000-8000-000000000002', 'lifecycle-employee@example.test', now()),
  ('c1000000-0000-4000-8000-000000000003', 'lifecycle-contractor@example.test', now()),
  ('c1000000-0000-4000-8000-000000000004', 'lifecycle-guest@example.test', now()),
  ('c1000000-0000-4000-8000-000000000005', 'lifecycle-suspended@example.test', now());

insert into public.organizations (
  id, slug, name, message_retention_days, allow_external_guests,
  external_guest_max_access_days, created_by_user_id
) values (
  'c2000000-0000-4000-8000-000000000001',
  'retention-role-lifecycle', 'Retention Role Lifecycle', 1, true, 30,
  'c1000000-0000-4000-8000-000000000001'
);

insert into public.organization_memberships (
  organization_id, user_id, role, status, directory_visibility,
  membership_type, access_expires_at, guest_sponsor_user_id
) values
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'owner', 'active', 'organization', 'employee', null, null
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000002',
    'member', 'active', 'organization', 'employee', null, null
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000003',
    'member', 'active', 'organization', 'contractor', now() + interval '10 days', null
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000004',
    'member', 'active', 'private', 'guest', now() + interval '5 days',
    'c1000000-0000-4000-8000-000000000001'
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000005',
    'member', 'suspended', 'organization', 'employee', null, null
  );

insert into public.conversations (
  id, organization_id, kind, name, visibility, created_by_user_id
) values (
  'c3000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  'group', 'Lifecycle fixtures', 'invite_only',
  'c1000000-0000-4000-8000-000000000001'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values (
  'c2000000-0000-4000-8000-000000000001',
  'c3000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000001', 'owner',
  'c1000000-0000-4000-8000-000000000001'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"c1000000-0000-4000-8000-000000000001"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce,
  kind, body, available_at, metadata
) values
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000001',
    'text', 'held ordinary retention fixture', now(), '{}'::jsonb
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000002',
    'text', 'eligible ordinary retention fixture', now(), '{}'::jsonb
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000003',
    'attachment', null, 'infinity'::timestamptz,
    jsonb_build_object('purpose', 'conversation_avatar')
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000004',
    'attachment', null, 'infinity'::timestamptz,
    jsonb_build_object('purpose', 'conversation_avatar')
  ),
  (
    'c2000000-0000-4000-8000-000000000001',
    'c3000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000001',
    'c4000000-0000-4000-8000-000000000005',
    'attachment', null, 'infinity'::timestamptz,
    jsonb_build_object('purpose', 'conversation_avatar')
  );
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- Rewind only fixture timestamps; the retention worker must see both classes
-- as expired while production inserts continue to receive server time.
alter table public.messages disable trigger messages_10_validate_update;
update public.messages
set created_at = now() - interval '2 days'
where organization_id = 'c2000000-0000-4000-8000-000000000001';
alter table public.messages enable trigger messages_10_validate_update;

insert into public.message_attachments (
  id, organization_id, conversation_id, message_id, created_by_user_id,
  storage_path, file_name, mime_type, byte_size, sha256_hex
)
select
  'c5000000-0000-4000-8000-000000000001',
  message.organization_id, message.conversation_id, message.id,
  'c1000000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001/'
    || 'c3000000-0000-4000-8000-000000000001/'
    || 'c1000000-0000-4000-8000-000000000001/'
    || 'c5000000-0000-4000-8000-000000000001/avatar.png',
  'avatar.png', 'image/png', 128, repeat('a', 64)
from public.messages message
where message.client_nonce = 'c4000000-0000-4000-8000-000000000005';

select set_config('app.conversation_avatar_context', 'on', true);
update public.conversations
set avatar_path = 'c2000000-0000-4000-8000-000000000001/'
    || 'c3000000-0000-4000-8000-000000000001/'
    || 'c1000000-0000-4000-8000-000000000001/'
    || 'c5000000-0000-4000-8000-000000000001/avatar.png'
where id = 'c3000000-0000-4000-8000-000000000001';
select set_config('app.conversation_avatar_context', 'off', true);

insert into private.message_preservation_holds (
  organization_id, conversation_id, message_id, hold_type, reason_code,
  policy_reference_sha256, placed_by_user_id
)
select message.organization_id, message.conversation_id, message.id,
  case message.client_nonce
    when 'c4000000-0000-4000-8000-000000000001' then 'legal'
    else 'incident_preservation'
  end,
  'active-retention-hold', decode(repeat('ab', 32), 'hex'),
  'c1000000-0000-4000-8000-000000000001'
from public.messages message
where message.client_nonce in (
  'c4000000-0000-4000-8000-000000000001',
  'c4000000-0000-4000-8000-000000000003'
);

select ok(
  has_function_privilege(
    'service_role', 'public.bff_scrub_retention(integer)', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'public.bff_scrub_retention(integer)', 'execute'
  ) and not has_function_privilege(
    'service_role',
    'private.scrub_conversation_avatar_candidates_internal(integer,timestamp with time zone)',
    'execute'
  ),
  'retention remains service-only and the avatar helper remains internal'
);

select ok(
  exists (
    select 1 from pg_trigger database_trigger
    join pg_class relation on relation.oid = database_trigger.tgrelid
    join pg_namespace namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'organization_role_assignments'
      and database_trigger.tgname =
        'organization_role_assignments_06_validate_target_access'
      and not database_trigger.tgisinternal
      and database_trigger.tgenabled <> 'D'
  ) and not has_function_privilege(
    'anon', 'private.validate_active_role_assignment_access()', 'execute'
  ) and not has_function_privilege(
    'authenticated', 'private.validate_active_role_assignment_access()', 'execute'
  ) and not has_function_privilege(
    'service_role', 'private.validate_active_role_assignment_access()', 'execute'
  ),
  'the role lifecycle trigger is enabled and its function is trigger-only'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  public.bff_scrub_retention(10),
  jsonb_build_object('scrubbed_messages', 2, 'scrubbed_avatar_candidates', 1),
  'held rows do not abort a batch containing eligible ordinary and avatar rows'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  not exists (
    select 1 from public.messages message
    where message.client_nonce in (
      'c4000000-0000-4000-8000-000000000001',
      'c4000000-0000-4000-8000-000000000003'
    ) and message.deleted_at is not null
  ),
  'active preservation holds skip both ordinary and avatar retention passes'
);
select ok(
  not exists (
    select 1 from public.messages message
    where message.client_nonce in (
      'c4000000-0000-4000-8000-000000000002',
      'c4000000-0000-4000-8000-000000000004'
    ) and message.deleted_at is null
  ),
  'another eligible row in each retention class is still scrubbed'
);
select ok(
  exists (
    select 1 from public.messages message
    join public.message_attachments attachment
      on attachment.organization_id = message.organization_id
     and attachment.conversation_id = message.conversation_id
     and attachment.message_id = message.id
    join public.conversations conversation
      on conversation.organization_id = attachment.organization_id
     and conversation.id = attachment.conversation_id
     and conversation.avatar_path = attachment.storage_path
    where message.client_nonce = 'c4000000-0000-4000-8000-000000000005'
      and message.deleted_at is null
  ),
  'the active avatar backing message remains preserved'
);

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$insert into public.organization_role_assignments (
    id, organization_id, user_id, role_name, granted_by_user_id, grant_reason
  ) values (
    'c6000000-0000-4000-8000-000000000001',
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000004', 'supervisor',
    'c1000000-0000-4000-8000-000000000001', 'guest denial fixture'
  )$$,
  '23514', 'external guests cannot receive active organization roles',
  'an external guest can never receive an active role assignment'
);
select throws_ok(
  $$insert into public.organization_role_assignments (
    id, organization_id, user_id, role_name, granted_by_user_id, grant_reason
  ) values (
    'c6000000-0000-4000-8000-000000000002',
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000005', 'supervisor',
    'c1000000-0000-4000-8000-000000000001', 'suspended denial fixture'
  )$$,
  '23514', 'active role assignment requires current organization access',
  'canonical current access rejects a suspended role target'
);
select throws_ok(
  $$insert into public.organization_role_assignments (
    id, organization_id, user_id, role_name, granted_by_user_id, grant_reason
  ) values (
    'c6000000-0000-4000-8000-000000000003',
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000003', 'supervisor',
    'c1000000-0000-4000-8000-000000000001', 'unbounded contractor fixture'
  )$$,
  '23514', 'contractor role assignment exceeds membership access',
  'a contractor role cannot be unbounded'
);
select throws_ok(
  $$insert into public.organization_role_assignments (
    id, organization_id, user_id, role_name, granted_by_user_id, grant_reason,
    expires_at
  ) values (
    'c6000000-0000-4000-8000-000000000004',
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000003', 'supervisor',
    'c1000000-0000-4000-8000-000000000001', 'overlong contractor fixture',
    now() + interval '20 days'
  )$$,
  '23514', 'contractor role assignment exceeds membership access',
  'a contractor role cannot exceed membership access expiration'
);
select lives_ok(
  $$insert into public.organization_role_assignments (
    id, organization_id, user_id, role_name, granted_by_user_id, grant_reason,
    expires_at
  ) values (
    'c6000000-0000-4000-8000-000000000005',
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000003', 'supervisor',
    'c1000000-0000-4000-8000-000000000001', 'bounded contractor fixture',
    now() + interval '5 days'
  )$$,
  'a contractor role may end before membership access expires'
);
select lives_ok(
  $$insert into public.organization_role_assignments (
    id, organization_id, user_id, role_name, granted_by_user_id, grant_reason
  ) values (
    'c6000000-0000-4000-8000-000000000006',
    'c2000000-0000-4000-8000-000000000001',
    'c1000000-0000-4000-8000-000000000002', 'supervisor',
    'c1000000-0000-4000-8000-000000000001', 'employee success fixture'
  )$$,
  'a current employee may receive an active role assignment'
);
select throws_ok(
  $$update public.organization_role_assignments
    set expires_at = now() + interval '1 day',
        revoked_at = now(),
        revoked_by_user_id = 'c1000000-0000-4000-8000-000000000001',
        revocation_reason = 'attempted grant mutation during revocation'
    where id = 'c6000000-0000-4000-8000-000000000006'$$,
  '22000', 'role assignment grant fields are immutable',
  'revocation cannot smuggle a mutation to immutable grant-time fields'
);
select lives_ok(
  $$update public.organization_role_assignments
    set revoked_at = now(),
        revoked_by_user_id = 'c1000000-0000-4000-8000-000000000001',
        revocation_reason = 'employee role no longer needed'
    where id = 'c6000000-0000-4000-8000-000000000006'$$,
  'role revocation remains possible through the strict lifecycle trigger'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  exists (
    select 1 from public.organization_role_assignments assignment
    where assignment.id = 'c6000000-0000-4000-8000-000000000006'
      and assignment.revoked_at is not null
      and assignment.revoked_by_user_id =
        'c1000000-0000-4000-8000-000000000001'
  ),
  'the employee assignment is durably revoked rather than left active'
);

select * from finish();
rollback;
