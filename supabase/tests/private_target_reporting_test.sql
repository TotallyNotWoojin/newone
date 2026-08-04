begin;
select plan(56);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_report_target_v3(uuid,uuid,uuid,text,uuid,bigint,uuid,text,text,boolean,integer,integer,text,text,text)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_report_target_v3(uuid,uuid,uuid,text,uuid,bigint,uuid,text,text,boolean,integer,integer,text,text,text)',
    'execute'
  )
  and has_function_privilege(
    'service_role',
    'public.bff_expand_moderation_fanout(uuid,bigint)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_expand_moderation_fanout(uuid,bigint)',
    'execute'
  )
  and (select relforcerowsecurity
       from pg_catalog.pg_class
       where oid = 'private.message_reports'::regclass),
  'unified report intake is server-only and raw cases remain behind forced RLS'
);
select ok(
  exists (
    select 1
    from pg_catalog.pg_indexes index_row
    where index_row.schemaname = 'private'
      and index_row.indexname = 'message_reports_active_reporter_target_unique_idx'
      and index_row.indexdef like '%UNIQUE%'
      and index_row.indexdef like '%status = ANY%'
  )
  and not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conrelid = 'private.message_reports'::regclass
      and constraint_row.contype = 'u'
      and pg_catalog.pg_get_constraintdef(constraint_row.oid)
        like '%conversation_id, message_id, reporter_user_id%'
  ),
  'one active reporter-target case is race-safe without imposing lifetime suppression'
);
select ok(
  (select count(*) = 3
   from information_schema.columns column_row
   where column_row.table_schema = 'private'
     and column_row.table_name = 'message_reports'
     and column_row.column_name in (
       'target_type', 'target_label_snapshot', 'target_identity_sha256'
     )),
  'cases persist a unified immutable target discriminator, label, and fingerprint'
);

insert into auth.users (id, email, email_confirmed_at, created_at, updated_at) values
  ('81000000-0000-4000-8000-000000000001', 'target-manager@example.test', now(), now(), now()),
  ('81000000-0000-4000-8000-000000000002', 'target-reporter@example.test', now(), now(), now()),
  ('81000000-0000-4000-8000-000000000003', 'target-subject@example.test', now(), now(), now()),
  ('81000000-0000-4000-8000-000000000004', 'target-investigator@example.test', now(), now(), now()),
  ('81000000-0000-4000-8000-000000000005', 'target-hidden@example.test', now(), now(), now()),
  ('81000000-0000-4000-8000-000000000006', 'target-offboarded@example.test', now(), now(), now()),
  ('81000000-0000-4000-8000-000000000007', 'target-unrelated-offboarded@example.test', now(), now(), now());

update public.profiles set display_name = case user_id
  when '81000000-0000-4000-8000-000000000001' then 'Target Case Manager'
  when '81000000-0000-4000-8000-000000000002' then 'Protected Reporter'
  when '81000000-0000-4000-8000-000000000003' then 'Visible Reported Member'
  when '81000000-0000-4000-8000-000000000004' then 'Target Investigator'
  when '81000000-0000-4000-8000-000000000005' then 'Hidden Member'
  when '81000000-0000-4000-8000-000000000006' then 'Soon Offboarded Investigator'
  when '81000000-0000-4000-8000-000000000007' then 'Unrelated Offboarded Member'
  else display_name end
where user_id::text like '81000000-0000-4000-8000-%';

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('81100000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('81100000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('81100000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000004', now(), now(), 'aal2');

insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('81100000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', '81200000-0000-4000-8000-000000000001', 'web', decode(repeat('81', 32), 'hex'), 'desktop'),
  ('81100000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002', '81200000-0000-4000-8000-000000000002', 'web', decode(repeat('82', 32), 'hex'), 'desktop'),
  ('81100000-0000-4000-8000-000000000004', '81000000-0000-4000-8000-000000000004', '81200000-0000-4000-8000-000000000004', 'web', decode(repeat('84', 32), 'hex'), 'desktop');

insert into public.organizations (id, slug, name, created_by_user_id) values
  ('82000000-0000-4000-8000-000000000001', 'private-target-one', 'Private Target One', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000002', 'private-target-two', 'Private Target Two', '81000000-0000-4000-8000-000000000001');

insert into public.organization_memberships (
  organization_id, user_id, role, directory_visibility
) values
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000001', 'owner', 'organization'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', 'member', 'organization'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003', 'member', 'organization'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000004', 'member', 'organization'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000005', 'member', 'private'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000006', 'member', 'organization'),
  ('82000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000007', 'member', 'organization'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000001', 'owner', 'organization'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000002', 'member', 'organization'),
  ('82000000-0000-4000-8000-000000000002', '81000000-0000-4000-8000-000000000003', 'member', 'organization');

insert into public.organization_role_assignments (
  id, organization_id, user_id, role_name, scope_type, unit_id,
  granted_by_user_id, grant_reason
) values
  (
    '82200000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000004',
    'designated_investigator', 'organization', null,
    '81000000-0000-4000-8000-000000000001',
    'Private target reporting test investigator'
  ),
  (
    '82200000-0000-4000-8000-000000000006',
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000006',
    'designated_investigator', 'organization', null,
    '81000000-0000-4000-8000-000000000001',
    'Investigator who will be offboarded after report intake'
  );

select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"81000000-0000-4000-8000-000000000001","session_id":"81100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
insert into public.contact_connections (
  organization_id, member_low_user_id, member_high_user_id,
  requested_by_user_id
) values
  (
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000006',
    '81000000-0000-4000-8000-000000000001'
  ),
  (
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000007',
    '81000000-0000-4000-8000-000000000001'
  );
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"81000000-0000-4000-8000-000000000006"}',
  true
);
update public.contact_connections
set status = 'accepted'
where organization_id = '82000000-0000-4000-8000-000000000001'
  and member_low_user_id = '81000000-0000-4000-8000-000000000001'
  and member_high_user_id = '81000000-0000-4000-8000-000000000006';
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.conversations (
  id, organization_id, kind, name, history_policy,
  incident_severity, incident_classification, posting_mode, join_policy,
  member_limit, created_by_user_id
) values
  ('83000000-0000-4000-8000-000000000001', '82000000-0000-4000-8000-000000000001', 'group', 'Group surface', 'all', null, null, 'all_members', 'inherit', 500, '81000000-0000-4000-8000-000000000001'),
  ('83000000-0000-4000-8000-000000000002', '82000000-0000-4000-8000-000000000001', 'team', 'Team surface', 'all', null, null, 'all_members', 'inherit', 500, '81000000-0000-4000-8000-000000000001'),
  ('83000000-0000-4000-8000-000000000003', '82000000-0000-4000-8000-000000000001', 'shift', 'Shift surface', 'all', null, null, 'all_members', 'invite_only', 500, '81000000-0000-4000-8000-000000000001'),
  ('83000000-0000-4000-8000-000000000004', '82000000-0000-4000-8000-000000000001', 'announcement', 'Announcement surface', 'all', null, null, 'admins_only', 'invite_only', 500, '81000000-0000-4000-8000-000000000001'),
  ('83000000-0000-4000-8000-000000000005', '82000000-0000-4000-8000-000000000001', 'incident', 'Incident surface', 'all', 'high', 'safety', 'all_members', 'invite_only', 500, '81000000-0000-4000-8000-000000000001'),
  ('83000000-0000-4000-8000-000000000006', '82000000-0000-4000-8000-000000000001', 'direct', null, 'all', null, null, 'all_members', 'invite_only', 2, '81000000-0000-4000-8000-000000000001');

insert into public.direct_conversation_pairs (
  organization_id, conversation_id, member_low_user_id, member_high_user_id
) values (
  '82000000-0000-4000-8000-000000000001',
  '83000000-0000-4000-8000-000000000006',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000003'
);

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
)
select '82000000-0000-4000-8000-000000000001', conversation.id,
  '81000000-0000-4000-8000-000000000002', 'member',
  '81000000-0000-4000-8000-000000000001'
from public.conversations conversation
where conversation.organization_id = '82000000-0000-4000-8000-000000000001';

insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003', 'member', '81000000-0000-4000-8000-000000000001'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000006', '81000000-0000-4000-8000-000000000003', 'member', '81000000-0000-4000-8000-000000000001');

grant select, update on private.message_reports,
  private.moderation_case_evidence,
  private.moderation_case_history,
  private.outbox_jobs
to service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

create temporary table target_report_receipts (surface_kind text primary key, receipt jsonb);
insert into target_report_receipts (surface_kind, receipt)
select conversation.kind, public.bff_report_target_v3(
  '81000000-0000-4000-8000-000000000002',
  '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000002',
  'group', conversation.id, null, null,
  'other', 'Private report for the group surface.', true, 0, 0,
  'moderation-report-v2', 'group-report-' || conversation.kind,
  repeat(substr(md5(conversation.kind), 1, 1), 64)
)
from public.conversations conversation
where conversation.organization_id = '82000000-0000-4000-8000-000000000001'
  and conversation.kind in ('group', 'team', 'shift', 'announcement', 'incident')
order by conversation.kind;

select is(
  (select count(*)::bigint from target_report_receipts),
  5::bigint,
  'group reporting covers group, team, shift, announcement, and incident surfaces'
);
select is(
  (select count(*)::bigint from private.message_reports where target_type = 'group'),
  5::bigint,
  'all five group-like surfaces create unified group cases'
);
select ok(
  (select bool_and(
    (receipt ->> 'created')::boolean
    and (receipt ->> 'target_not_notified')::boolean
    and (receipt ->> 'reporter_identity_protected')::boolean
    and receipt ->> 'target_type' = 'group'
  ) from target_report_receipts),
  'group receipts explicitly preserve reporter privacy and target silence'
);
select is(
  (select count(*)::bigint
   from private.moderation_case_evidence evidence
   join private.message_reports report
     on report.organization_id = evidence.organization_id and report.id = evidence.case_id
   where report.target_type = 'group'),
  0::bigint,
  'group reports never copy conversation content into evidence'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000006', null, null,
    'other', null, true, 0, 0, 'moderation-report-v2',
    'direct-report-denied', repeat('6', 64)
  )$$,
  '42501', 'group is not available',
  'direct conversations cannot be reported as group targets'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000002',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000001', null, null,
    'other', null, true, 0, 0, 'moderation-report-v2',
    'cross-tenant-group', repeat('7', 64)
  )$$,
  '42501', 'group is not available',
  'a visible group identifier cannot cross organization boundaries'
);
select is(
  (public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000001', null, null,
    'privacy', 'A duplicate cannot widen the original report.', true, 0, 0,
    'moderation-report-v2', 'active-group-duplicate', repeat('8', 64)
  ) ->> 'created')::boolean,
  false,
  'a second command converges on the existing active reporter-target case'
);
select is(
  (select count(*)::bigint from private.message_reports where target_type = 'group'),
  5::bigint,
  'active duplicate defense leaves one case per reported group target'
);
select ok(
  (select bool_and(report.target_label_snapshot = conversation.name)
   from private.message_reports report
   join public.conversations conversation
     on conversation.organization_id = report.organization_id
    and conversation.id = report.conversation_id
   where report.target_type = 'group'),
  'group target labels are server-derived immutable snapshots'
);
select ok(
  (select count(*) = 5
     and bool_and(
       job.payload - array['schema_version', 'case_id', 'state', 'reason', 'version']
         = '{}'::jsonb
       and job.payload ->> 'schema_version' = '1'
       and job.payload ->> 'state' = 'open'
       and job.payload ->> 'reason' = 'case_available'
     )
   from private.outbox_jobs job
   where job.topic = 'moderation'),
  'group intake enqueues one exact content-free moderation intent per case'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs job
    where job.topic = 'moderation'
      and (
        job.payload ? 'user_id'
        or job.payload ? 'reporter_user_id'
        or job.payload ? 'subject_user_id'
        or job.payload ? 'target_id'
      )
  ),
  'fanout intents contain no reporter, target, or recipient identity'
);

select ok(
  (public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'member', null, null, '81000000-0000-4000-8000-000000000003',
    'harassment', 'Private member report.', true, 0, 0,
    'moderation-report-v2', 'member-report-org-one', repeat('9', 64)
  ) ->> 'created')::boolean,
  'a currently visible organization member can be reported privately'
);
reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"81000000-0000-4000-8000-000000000002","session_id":"81100000-0000-4000-8000-000000000002","aal":"aal2"}',
  true
);
insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
values (
  '82000000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000002',
  '81000000-0000-4000-8000-000000000003'
);
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'member', null, null, '81000000-0000-4000-8000-000000000003',
    'harassment', 'Blocking must not erase the safety route.', true, 0, 0,
    'moderation-report-v2', 'member-report-after-block', repeat('6', 64)
  ) ->> 'created')::boolean,
  false,
  'either-party blocking preserves reporting for a previously shared conversation member'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'member', null, null, '81000000-0000-4000-8000-000000000002',
    'other', null, true, 0, 0, 'moderation-report-v2',
    'member-report-self', repeat('a', 64)
  )$$,
  '22023', 'a reporter cannot report themselves',
  'self-reporting is rejected before case creation'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'member', null, null, '81000000-0000-4000-8000-000000000005',
    'other', null, true, 0, 0, 'moderation-report-v2',
    'member-report-hidden', repeat('b', 64)
  )$$,
  '42501', 'member is not available',
  'private directory members cannot be targeted through identifier guessing'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs job
    join private.message_reports report
      on report.id = (job.payload ->> 'case_id')::uuid
     and report.organization_id = job.organization_id
    where job.topic = 'moderation'
      and report.target_type = 'member'
      and (
        job.payload ? 'subject_user_id'
        or job.payload ? 'target_id'
        or job.payload ? 'target_label'
      )
  ),
  'member fanout intent does not identify or expose the reported member'
);
select is(
  (select count(*)::bigint
   from private.moderation_case_evidence evidence
   join private.message_reports report
     on report.organization_id = evidence.organization_id and report.id = evidence.case_id
   where report.target_type = 'member'),
  0::bigint,
  'member reports contain no copied message evidence'
);
select ok(
  (public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000002',
    '81100000-0000-4000-8000-000000000002',
    'member', null, null, '81000000-0000-4000-8000-000000000003',
    'privacy', 'Separate tenant report.', true, 0, 0,
    'moderation-report-v2', 'member-report-org-two', repeat('c', 64)
  ) ->> 'created')::boolean,
  'the same visible person can be independently reported in another tenant'
);
select ok(
  (select count(distinct encode(target_identity_sha256, 'hex')) = 2
   from private.message_reports
   where target_type = 'member'
     and subject_user_id = '81000000-0000-4000-8000-000000000003'),
  'target fingerprints include organization identity and cannot correlate tenants'
);

select ok(
  (select pg_catalog.pg_get_functiondef(
      'private.bff_expand_moderation_fanout_impl(uuid,bigint)'::regprocedure
    ) ~* 'with eligible as materialized'
    and pg_catalog.pg_get_functiondef(
      'private.bff_expand_moderation_fanout_impl(uuid,bigint)'::regprocedure
    ) ~* 'on conflict \(topic, dedupe_key\) do nothing'
    and pg_catalog.pg_get_functiondef(
      'private.bff_expand_moderation_fanout_impl(uuid,bigint)'::regprocedure
    ) !~* '\mlimit\M'),
  'moderation fanout is an uncapped set-wise current-authorization expansion'
);

-- Authorization is deliberately resolved when the durable worker processes
-- the intent. User 6 loses membership after intake, while users 3 and 5 gain
-- investigator authority after intake. User 3 is also the member-report target
-- and must still be excluded from that one case.
reset role;
insert into public.organization_role_assignments (
  id, organization_id, user_id, role_name, scope_type, unit_id,
  granted_by_user_id, grant_reason
) values
  (
    '82200000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000003',
    'designated_investigator', 'organization', null,
    '81000000-0000-4000-8000-000000000001',
    'Verify reported targets stay excluded from delayed fanout'
  ),
  (
    '82200000-0000-4000-8000-000000000003',
    '82000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000005',
    'designated_investigator', 'organization', null,
    '81000000-0000-4000-8000-000000000001',
    'Verify newly eligible investigators receive delayed fanout'
  );

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.bff_suspend_member(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000006',
  'Offboard before delayed moderation fanout is processed.',
  'offboard-delayed-investigator', repeat('7', 64)
);
select public.bff_suspend_member(
  '81000000-0000-4000-8000-000000000001',
  '82000000-0000-4000-8000-000000000001',
  '81100000-0000-4000-8000-000000000001',
  '81000000-0000-4000-8000-000000000007',
  'Offboard unrelated member before private-report checks.',
  'offboard-unrelated-member', repeat('8', 64)
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001',
    'member', null, null, '81000000-0000-4000-8000-000000000007',
    'other', null, true, 0, 0, 'moderation-report-v2',
    'inactive-unrelated-member', repeat('8', 64)
  )$$,
  '42501', 'member is not available',
  'a pending request cannot expose an unrelated inactive member through identifier guessing'
);
select ok(
  (public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001',
    'member', null, null, '81000000-0000-4000-8000-000000000006',
    'other', 'Offboarding must not erase an established safety route.',
    true, 0, 0, 'moderation-report-v2',
    'inactive-established-member', repeat('9', 64)
  ) ->> 'created')::boolean,
  'an established contact can still be reported after suspension'
);
create temporary table target_moderation_claims as
with envelope as (
  select public.bff_claim_outbox_topics(
    '85000000-0000-4000-8000-000000000001',
    array['moderation']::text[], 100, 300
  ) result
)
select (job.value ->> 'id')::bigint job_id,
  (job.value ->> 'organization_id')::uuid organization_id,
  (job.value #>> '{payload,case_id}')::uuid case_id,
  (job.value ->> 'attempts')::integer attempts
from envelope
cross join lateral jsonb_array_elements(envelope.result -> 'jobs') job(value);

select is(
  (select count(*)::bigint from target_moderation_claims),
  (select count(*)::bigint from private.message_reports),
  'the worker claims exactly one O(1) fanout intent for every intake case'
);

create temporary table target_moderation_expansions as
select claim.*,
  public.bff_expand_moderation_fanout(
    '85000000-0000-4000-8000-000000000001', claim.job_id
  ) receipt
from target_moderation_claims claim;

select ok(
  (select bool_and(
    (receipt ->> 'current_authorization_applied')::boolean
    and (receipt ->> 'replay_safe')::boolean
    and (receipt ->> 'eligible_count')::integer
      = (receipt ->> 'enqueued_count')::integer
  ) from target_moderation_expansions),
  'first expansion applies current authorization and enqueues every eligible viewer'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs job
    join target_moderation_claims claim
      on claim.organization_id = job.organization_id
     and claim.case_id = (job.payload ->> 'entity_id')::uuid
    where job.topic = 'realtime_control'
      and job.payload ->> 'user_id' = '81000000-0000-4000-8000-000000000006'
  )
  and (
    select count(*) = 7
    from private.outbox_jobs job
    join target_moderation_claims claim
      on claim.organization_id = job.organization_id
     and claim.case_id = (job.payload ->> 'entity_id')::uuid
    where job.topic = 'realtime_control'
      and job.organization_id = '82000000-0000-4000-8000-000000000001'
      and job.payload ->> 'user_id' = '81000000-0000-4000-8000-000000000005'
  ),
  'processing-time authorization excludes offboarded and includes newly eligible investigators'
);
select ok(
  not exists (
    select 1 from private.outbox_jobs job
    join private.message_reports report
      on report.organization_id = job.organization_id
     and report.id = (job.payload ->> 'entity_id')::uuid
    where job.topic = 'realtime_control'
      and report.reporter_user_id = (job.payload ->> 'user_id')::uuid
  )
  and not exists (
    select 1 from private.outbox_jobs job
    join private.message_reports report
      on report.organization_id = job.organization_id
     and report.id = (job.payload ->> 'entity_id')::uuid
    where job.topic = 'realtime_control'
      and report.target_type = 'member'
      and report.subject_user_id = (job.payload ->> 'user_id')::uuid
  ),
  'fanout never queues an invalidation for the protected reporter or member target'
);

select is(
  (public.bff_expand_moderation_fanout(
    '85000000-0000-4000-8000-000000000001',
    (select min(job_id) from target_moderation_claims)
  ) ->> 'enqueued_count')::integer,
  0,
  'duplicate expansion under the same lease is idempotent'
);

select public.bff_fail_outbox_job(
  '85000000-0000-4000-8000-000000000001',
  (select min(job_id) from target_moderation_claims),
  'test_worker_failure', 1
);
update private.outbox_jobs
set available_at = clock_timestamp() - interval '1 second'
where id = (select min(job_id) from target_moderation_claims);
create temporary table target_moderation_retry as
with envelope as (
  select public.bff_claim_outbox_topics(
    '85000000-0000-4000-8000-000000000002',
    array['moderation']::text[], 1, 300
  ) result
), claimed as (
  select (job.value ->> 'id')::bigint job_id,
    (job.value ->> 'attempts')::integer attempts
  from envelope
  cross join lateral jsonb_array_elements(envelope.result -> 'jobs') job(value)
)
select claimed.*,
  public.bff_expand_moderation_fanout(
    '85000000-0000-4000-8000-000000000002', claimed.job_id
  ) receipt
from claimed;
select ok(
  (select count(*) = 1
      and min(attempts) = 2
      and min((receipt ->> 'enqueued_count')::integer) = 0
   from target_moderation_retry),
  'a failed worker lease can be reclaimed and replayed without duplicate recipients'
);
select public.bff_complete_outbox_job(
  '85000000-0000-4000-8000-000000000002', job_id
)
from target_moderation_retry;
select public.bff_complete_outbox_job(
  '85000000-0000-4000-8000-000000000001', job_id
)
from target_moderation_claims
where job_id <> (select min(job_id) from target_moderation_claims);

select throws_ok(
  $$update private.message_reports
    set target_label_snapshot = 'Tampered target'
    where target_type = 'group'
      and conversation_id = '83000000-0000-4000-8000-000000000002'$$,
  '55000', 'moderation case target, source, and consent fields are immutable',
  'target labels and identity cannot be changed after report intake'
);

select ok(
  (select result ->> 'schema_version' = '2'
      and jsonb_array_length(result -> 'cases') = 6
      and exists (
        select 1 from jsonb_array_elements(result -> 'cases') listed(item)
        where listed.item #>> '{target,type}' = 'group'
          and listed.item #>> '{target,label}' = 'Group surface'
      )
   from (select public.bff_query_moderation_cases(
     '81000000-0000-4000-8000-000000000001',
     '82000000-0000-4000-8000-000000000001',
     '81100000-0000-4000-8000-000000000001',
     array['open']::text[], null, null, 50
   ) result) listed),
  'case managers receive nullable-subject group cases through the scoped v2 target DTO'
);
select ok(
  (select exists (
    select 1 from jsonb_array_elements(result #> '{cases,0,eligible_investigator_user_ids}') candidate
    where candidate #>> '{}' = '81000000-0000-4000-8000-000000000004'
  )
  from (select public.bff_query_moderation_cases(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001',
    array['open']::text[], null, null, 50
  ) result) listed),
  'NULL group subjects do not erase eligible investigators from assignment DTOs'
);

select is(
  (public.bff_assign_moderation_case(
    '81000000-0000-4000-8000-000000000001',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000001',
    (select id from private.message_reports
     where target_type = 'group'
       and conversation_id = '83000000-0000-4000-8000-000000000001'
     order by created_at limit 1),
    '81000000-0000-4000-8000-000000000004', 1,
    'Assign the nullable-subject group case.',
    'assign-group-case', repeat('d', 64)
  ) ->> 'record_version')::integer,
  2,
  'nullable-subject group cases support explicit independent assignment'
);
select ok(
  (select result ->> 'schema_version' = '2'
      and result #>> '{case,target,type}' = 'group'
      and result #>> '{case,target,label}' = 'Group surface'
      and jsonb_array_length(result #> '{case,evidence}') = 0
   from (select public.bff_read_moderation_case(
     '81000000-0000-4000-8000-000000000004',
     '82000000-0000-4000-8000-000000000001',
     '81100000-0000-4000-8000-000000000004',
     (select id from private.message_reports
      where target_type = 'group'
        and conversation_id = '83000000-0000-4000-8000-000000000001'
      order by created_at limit 1)
   ) result) detailed),
  'assigned group detail exposes its target label but no conversation content'
);
select ok(
  (select (result #>> '{scope,target_only}')::boolean
      and not (result #>> '{scope,message_evidence_included}')::boolean
      and not (result #>> '{scope,reporter_identity_included}')::boolean
   from (select public.bff_read_moderation_case(
     '81000000-0000-4000-8000-000000000004',
     '82000000-0000-4000-8000-000000000001',
     '81100000-0000-4000-8000-000000000004',
     (select id from private.message_reports
      where target_type = 'group'
        and conversation_id = '83000000-0000-4000-8000-000000000001'
      order by created_at limit 1)
   ) result) detailed),
  'group detail declares target-only scope and protected reporter identity'
);
select is(
  (public.bff_transition_moderation_case(
    '81000000-0000-4000-8000-000000000004',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000004',
    (select id from private.message_reports
     where target_type = 'group'
       and conversation_id = '83000000-0000-4000-8000-000000000001'
     order by created_at limit 1),
    'in_review', 2, 'Review of the group target began.', '{}'::jsonb,
    'review-group-case', repeat('e', 64)
  ) ->> 'status'),
  'in_review',
  'nullable-subject cases enter review without weakening investigator checks'
);
select is(
  (public.bff_transition_moderation_case(
    '81000000-0000-4000-8000-000000000004',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000004',
    (select id from private.message_reports
     where target_type = 'group'
       and conversation_id = '83000000-0000-4000-8000-000000000001'
     order by created_at limit 1),
    'resolved', 3, 'The first incident was resolved.',
    '{"policy_code":"GROUP.1"}'::jsonb,
    'resolve-group-case', repeat('f', 64)
  ) ->> 'status'),
  'resolved',
  'a reviewed group case closes through the existing investigator lifecycle'
);
select ok(
  (public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000001', null, null,
    'threat', 'A genuinely later incident.', true, 0, 0,
    'moderation-report-v2', 'later-group-incident', repeat('0', 64)
  ) ->> 'created')::boolean,
  'a later incident may create a new case after the prior case closes'
);
select is(
  (select count(*)::bigint from private.message_reports
   where target_type = 'group'
     and conversation_id = '83000000-0000-4000-8000-000000000001'),
  2::bigint,
  'closed history and one new active case coexist for the same reporter-target pair'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000002', null, null,
    'other', null, true, 1, 0, 'moderation-report-v2',
    'group-context-denied', repeat('1', 64)
  )$$,
  '22023', 'valid report consent and bounded target scope required',
  'non-message reports cannot request copied message context'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000002', null, null,
    'other', null, false, 0, 0, 'moderation-report-v2',
    'group-consent-denied', repeat('2', 64)
  )$$,
  '22023', 'valid report consent and bounded target scope required',
  'every report target requires affirmative disclosure consent'
);

reset role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"81000000-0000-4000-8000-000000000002"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000002', '84000000-0000-4000-8000-000000000001', 'text', 'Consented context before');
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"81000000-0000-4000-8000-000000000003"}',
  true
);
insert into public.messages (
  organization_id, conversation_id, sender_user_id, client_nonce, kind, body
) values
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003', '84000000-0000-4000-8000-000000000002', 'text', 'Reported message'),
  ('82000000-0000-4000-8000-000000000001', '83000000-0000-4000-8000-000000000001', '81000000-0000-4000-8000-000000000003', '84000000-0000-4000-8000-000000000003', 'text', 'Consented context after');

create or replace function private.inject_post_consent_message_test()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_type = 'message' then
    insert into public.messages (
      organization_id, conversation_id, sender_user_id, client_nonce, kind, body,
      available_at, created_at
    ) values (
      new.organization_id, new.conversation_id, new.reporter_user_id,
      '84000000-0000-4000-8000-000000000004', 'text',
      'Post-consent message must never enter evidence',
      clock_timestamp(), clock_timestamp()
    );
  end if;
  return new;
end;
$$;
create trigger inject_post_consent_message_test
before insert on private.message_reports
for each row execute function private.inject_post_consent_message_test();
set local role service_role;
select set_config(
  'request.jwt.claims',
  '{"role":"service_role","sub":"81000000-0000-4000-8000-000000000002"}',
  true
);

select ok(
  (public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'message', '83000000-0000-4000-8000-000000000001',
    (select id from public.messages where client_nonce = '84000000-0000-4000-8000-000000000002'),
    null, 'privacy', 'Message report details.', true, 1, 2,
    'moderation-report-v2', 'message-target-report', repeat('3', 64)
  ) ->> 'created')::boolean,
  'message reporting remains available through unified consent-gated intake'
);
select ok(
  exists (
    select 1 from public.messages
    where client_nonce = '84000000-0000-4000-8000-000000000004'
  ),
  'the test fixture inserted a message after the consent boundary was captured'
);
select is(
  (select array_agg(evidence.relationship order by evidence.relative_position)
   from private.moderation_case_evidence evidence
   join private.message_reports report
     on report.organization_id = evidence.organization_id and report.id = evidence.case_id
   where report.target_type = 'message'),
  array['context_before', 'reported', 'context_after']::text[],
  'message evidence contains only the reported item and consent-time bounded context'
);
select ok(
  not exists (
    select 1 from private.moderation_case_evidence
    where message_body = 'Post-consent message must never enter evidence'
  ),
  'a message committed after consent is excluded by timestamp and deterministic ID boundaries'
);

create temporary table target_lifecycle_moderation_claims as
with envelope as (
  select public.bff_claim_outbox_topics(
    '85000000-0000-4000-8000-000000000003',
    array['moderation']::text[], 100, 300
  ) result
)
select (job.value ->> 'id')::bigint job_id,
  (job.value ->> 'organization_id')::uuid organization_id,
  (job.value #>> '{payload,case_id}')::uuid case_id
from envelope
cross join lateral jsonb_array_elements(envelope.result -> 'jobs') job(value);
create temporary table target_lifecycle_moderation_expansions as
select claim.*,
  public.bff_expand_moderation_fanout(
    '85000000-0000-4000-8000-000000000003', claim.job_id
  ) receipt
from target_lifecycle_moderation_claims claim;
select ok(
  exists (
    select 1 from target_lifecycle_moderation_claims claim
    join private.message_reports report
      on report.organization_id = claim.organization_id
     and report.id = claim.case_id
    where report.target_type = 'message'
  )
  and not exists (
    select 1 from private.outbox_jobs job
    join private.message_reports report
      on report.organization_id = job.organization_id
     and report.id = (job.payload ->> 'entity_id')::uuid
    where job.topic = 'realtime_control'
      and report.target_type = 'message'
      and report.subject_user_id = (job.payload ->> 'user_id')::uuid
  ),
  'expanded message fanout excludes the reported sender even when they are an investigator'
);
select public.bff_complete_outbox_job(
  '85000000-0000-4000-8000-000000000003', job_id
)
from target_lifecycle_moderation_claims;
select ok(
  (select target_identity_sha256 = extensions.digest(convert_to(
      'organization:' || organization_id::text
        || ':message:' || conversation_id::text || ':' || message_id::text,
      'UTF8'
    ), 'sha256')
   from private.message_reports where target_type = 'message'),
  'message target identity is an immutable tenant-bound canonical digest'
);
select ok(
  exists (
    select 1 from public.audit_events event
    where event.event_type = 'moderation_case_event.insert'
      and event.metadata ->> 'bff_operation' = 'conversation.report'
  )
  and exists (
    select 1 from public.audit_events event
    where event.event_type = 'moderation_case_event.insert'
      and event.metadata ->> 'bff_operation' = 'member.report'
  )
  and exists (
    select 1 from public.audit_events event
    where event.event_type = 'moderation_case_event.insert'
      and event.metadata ->> 'bff_operation' = 'message.report'
  ),
  'content-free audit correlation distinguishes group, member, and message report operations'
);
select ok(
  not exists (
    select 1 from private.moderation_case_history history
    where history.event_type = 'reported'
      and (
        history.evidence_metadata ? 'details'
        or history.evidence_metadata ? 'reporter_user_id'
        or history.evidence_metadata ? 'target_label'
      )
  ),
  'report history records only bounded scope metadata and no details or identities'
);
select ok(
  (select position('reporter_user_id' in result::text) = 0
      and position('conversation_id' in result::text) = 0
      and position('message_id' in result::text) = 0
      and position('details' in result::text) = 0
   from (select public.bff_query_moderation_cases(
     '81000000-0000-4000-8000-000000000001',
     '82000000-0000-4000-8000-000000000001',
     '81100000-0000-4000-8000-000000000001',
     array['open', 'resolved']::text[], null, null, 50
   ) result) listed),
  'moderation queue DTOs expose target labels without raw source or reporter identifiers'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000003', null, null,
    'other', E'unsafe\x01details', true, 0, 0, 'moderation-report-v2',
    'unsafe-report-details', repeat('4', 64)
  )$$,
  '22023', 'valid report consent and bounded target scope required',
  'report details reject control characters'
);
select throws_ok(
  $$select public.bff_report_target_v3(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    'group', '83000000-0000-4000-8000-000000000003', null, null,
    'unsupported', null, true, 0, 0, 'moderation-report-v2',
    'invalid-report-category', repeat('5', 64)
  )$$,
  '22023', 'valid report consent and bounded target scope required',
  'report categories remain a bounded policy allowlist'
);

create temporary table target_gateway_rate_receipts as
select operation.operation_name, attempt.attempt_number,
  public.bff_consume_rate_limit(
    '81000000-0000-4000-8000-000000000002',
    '82000000-0000-4000-8000-000000000001',
    '81100000-0000-4000-8000-000000000002',
    operation.operation_name, null
  ) as receipt
from (values ('conversation.report'), ('member.report')) operation(operation_name)
cross join generate_series(1, 11) attempt(attempt_number)
order by operation.operation_name, attempt.attempt_number;
select ok(
  (select bool_and((receipt ->> 'allowed')::boolean)
   from target_gateway_rate_receipts
   where operation_name = 'conversation.report' and attempt_number <= 10)
  and not (select (receipt ->> 'allowed')::boolean
           from target_gateway_rate_receipts
           where operation_name = 'conversation.report' and attempt_number = 11),
  'conversation.report uses the strict gateway budget of ten requests per hour'
);
select ok(
  (select bool_and((receipt ->> 'allowed')::boolean)
   from target_gateway_rate_receipts
   where operation_name = 'member.report' and attempt_number <= 10)
  and not (select (receipt ->> 'allowed')::boolean
           from target_gateway_rate_receipts
           where operation_name = 'member.report' and attempt_number = 11),
  'member.report uses the strict gateway budget of ten requests per hour'
);

select * from finish();
rollback;
