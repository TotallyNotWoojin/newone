begin;
select plan(20);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('81000000-0000-4000-8000-000000000001', 'departure-owner@example.test', now()),
  ('81000000-0000-4000-8000-000000000002', 'departure-member@example.test', now()),
  ('81000000-0000-4000-8000-000000000003', 'departure-coowner@example.test', now()),
  ('81000000-0000-4000-8000-000000000004', 'departure-outsider@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('81100000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', now(), now(), 'aal1'),
  ('81100000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002', now(), now(), 'aal1'),
  ('81100000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000003', now(), now(), 'aal1'),
  ('81100000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000004', now(), now(), 'aal1');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('81100000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81200000-0000-4000-8000-000000000001', 'web', decode(repeat('81', 32), 'hex'), 'desktop'),
  ('81100000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002', '81200000-0000-4000-8000-000000000002', 'web', decode(repeat('82', 32), 'hex'), 'desktop'),
  ('81100000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000003', '81200000-0000-4000-8000-000000000003', 'web', decode(repeat('83', 32), 'hex'), 'desktop'),
  ('81100000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000004', '81200000-0000-4000-8000-000000000004', 'web', decode(repeat('84', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values (
  '82000000-0000-4000-8000-000000000001', 'departure-contract',
  'Departure Contract', '81000000-0000-4000-8000-000000000001'
);
insert into public.organization_memberships (organization_id, user_id, role) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'owner'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', 'member'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003', 'member'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000004', 'member');

insert into public.conversations (
  id, organization_id, kind, name, visibility, posting_mode, join_policy,
  created_by_user_id
) values
  ('83000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'group', 'Eligible group', 'invite_only', 'all_members', 'inherit', '81000000-0000-4000-8000-000000000001'),
  ('83000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001', 'group', 'Co-owned group', 'invite_only', 'all_members', 'inherit', '81000000-0000-4000-8000-000000000002'),
  ('83000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000001', 'announcement', 'Mandatory announcements', 'organization', 'admins_only', 'invite_only', '81000000-0000-4000-8000-000000000004'),
  ('83000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001', 'group', 'Policy group', 'invite_only', 'all_members', 'inherit', '81000000-0000-4000-8000-000000000004'),
  ('83000000-0000-4000-8000-000000000005', '82000000-0000-4000-8000-000000000001', 'group', 'Organization audience', 'organization', 'all_members', 'inherit', '81000000-0000-4000-8000-000000000004');

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'owner', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', 'member', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002', 'owner', '81000000-0000-4000-8000-000000000002'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000003', 'owner', '81000000-0000-4000-8000-000000000002'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000003', '81000000-0000-4000-8000-000000000004', 'owner', '81000000-0000-4000-8000-000000000004'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000004', 'owner', '81000000-0000-4000-8000-000000000004'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000005', '81000000-0000-4000-8000-000000000004', 'owner', '81000000-0000-4000-8000-000000000004');

insert into public.dynamic_group_policies (
  id, organization_id, conversation_id, member_roles, status, created_by_user_id
) values (
  '83100000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000004',
  array['member']::text[], 'draft', '81000000-0000-4000-8000-000000000004'
);

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"81000000-0000-4000-8000-000000000001","session_id":"81100000-0000-4000-8000-000000000001","aal":"aal1"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values (
  '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001', 'text', 'Preserved departure history'
);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege('service_role', 'public.bff_leave_conversation(uuid,uuid,uuid,uuid,uuid,text,text)', 'execute')
  and not has_function_privilege('authenticated', 'public.bff_leave_conversation(uuid,uuid,uuid,uuid,uuid,text,text)', 'execute'),
  'conversation departure is service-role RPC only'
);
select ok(
  (private.conversation_departure_options_internal(
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000001'
  ) ->> 'eligible')::boolean
  and (private.conversation_departure_options_internal(
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    '83000000-0000-4000-8000-000000000001'
  ) ->> 'requires_ownership_transfer')::boolean,
  'ordinary group exposes last-owner transfer requirement'
);
select is(private.conversation_departure_options_internal(
  '81000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000003'
) ->> 'restriction', 'announcement_mandatory', 'announcements reject self-leave');
select is(private.conversation_departure_options_internal(
  '81000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000004'
) ->> 'restriction', 'policy_managed', 'dynamic groups reject self-leave');
select is(private.conversation_departure_options_internal(
  '81000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000005'
) ->> 'restriction', 'audience_mandatory', 'organization audiences reject self-leave');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok(
  $$select public.bff_leave_conversation(
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001',
    null, 'departure-missing-owner', repeat('1', 64)
  )$$, '42501', 'an active replacement owner is required',
  'last owner cannot leave without a replacement'
);
select throws_ok(
  $$select public.bff_leave_conversation(
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000004', 'departure-invalid-owner', repeat('2', 64)
  )$$, '42501', 'an active replacement owner is required',
  'replacement validation does not expose nonmembership'
);
select lives_ok(
  $$select public.bff_leave_conversation(
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002', 'departure-owner-transfer', repeat('3', 64)
  )$$, 'owner transfer and departure commit atomically'
);
select is(
  public.bff_leave_conversation(
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002', 'departure-owner-transfer', repeat('3', 64)
  ) ->> 'ownership_transferred', 'true', 'exact replay remains safe after access ends'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  (select status = 'left' and role = 'owner' and left_at is not null
   from public.conversation_members where conversation_id = '83000000-0000-4000-8000-000000000001'
     and user_id = '81000000-0000-4000-8000-000000000001')
  and (select status = 'active' and role = 'owner'
   from public.conversation_members where conversation_id = '83000000-0000-4000-8000-000000000001'
     and user_id = '81000000-0000-4000-8000-000000000002'),
  'departure preserves the old role while activating the replacement owner'
);
select is((select count(*)::bigint from public.messages
  where conversation_id = '83000000-0000-4000-8000-000000000001'), 1::bigint,
  'message history is preserved');
select is((select count(*)::bigint from public.audit_events
  where event_type = 'conversation.member.left'
    and target_id = '83000000-0000-4000-8000-000000000001'), 1::bigint,
  'departure emits one content-free explicit audit event');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok(
  (
    select bootstrap.payload ->> 'selected_conversation_id' is distinct from
        '83000000-0000-4000-8000-000000000001'
      and not exists (
        select 1
        from jsonb_array_elements(coalesce(
          bootstrap.payload #> '{timeline,messages}', '[]'::jsonb
        )) timeline_message(value)
        where timeline_message.value ->> 'message_id' = (
          select message.id::text
          from public.messages message
          where message.client_nonce = '84000000-0000-4000-8000-000000000001'
        )
      )
      and exists (
        select 1
        from jsonb_array_elements(coalesce(
          bootstrap.payload -> 'conversations', '[]'::jsonb
        )) conversation(value)
        where conversation.value ->> 'conversation_id' =
            '83000000-0000-4000-8000-000000000001'
          and conversation.value ->> 'management_only' = 'true'
          and conversation.value ->> 'can_post' = 'false'
          and not (conversation.value ? 'preview')
          and coalesce(conversation.value -> 'members', '[]'::jsonb) =
            '[]'::jsonb
      )
    from (select public.bff_bootstrap_messaging_state(
      '81000000-0000-4000-8000-000000000001',
      '82000000-0000-4000-8000-000000000001',
      '81100000-0000-4000-8000-000000000001'
    ) payload) bootstrap
  ),
  'future bootstrap retains only a content-free management shell after departure'
);
select throws_ok(
  $$select public.bff_send_message(
    '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001',
    '84000000-0000-4000-8000-000000000002', 'text', 'must fail', 'en', null, null,
    '{}'::jsonb, 'departure-post-denied', repeat('4', 64)
  )$$, '42501', 'active conversation membership with posting access is required',
  'future posting access ends'
);
select lives_ok(
  $$select public.bff_leave_conversation(
    '81000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002', '83000000-0000-4000-8000-000000000002',
    null, 'departure-non-last-owner', repeat('5', 64)
  )$$, 'a non-last owner leaves without unnecessary transfer'
);
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select ok((select status = 'active' and role = 'owner'
  from public.conversation_members where conversation_id = '83000000-0000-4000-8000-000000000002'
    and user_id = '81000000-0000-4000-8000-000000000003'),
  'co-owned group retains its active owner');

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select throws_ok($$select public.bff_leave_conversation(
  '81000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000004', '83000000-0000-4000-8000-000000000003', null,
  'departure-announcement', repeat('6', 64)
)$$, '42501', 'conversation is not eligible for self-leave', 'announcement departure is rejected');
select throws_ok($$select public.bff_leave_conversation(
  '81000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000004', '83000000-0000-4000-8000-000000000004', null,
  'departure-policy', repeat('7', 64)
)$$, '42501', 'conversation is not eligible for self-leave', 'policy-managed departure is rejected');
select throws_ok($$select public.bff_leave_conversation(
  '81000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000004', '83000000-0000-4000-8000-000000000005', null,
  'departure-audience', repeat('8', 64)
)$$, '42501', 'conversation is not eligible for self-leave', 'organization audience departure is rejected');
select throws_ok($$select public.bff_leave_conversation(
  '81000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000004', null,
  'departure-hidden-membership', repeat('9', 64)
)$$, '42501', 'conversation is not eligible for self-leave', 'nonmember denial matches mandatory audience denial');
reset role;

select * from finish();
rollback;
