begin;
create extension if not exists pgtap with schema extensions;
select plan(63);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into auth.users (id, email, email_confirmed_at) values
  ('b1000000-0000-4000-8000-000000000001', 'policy-owner@example.test', now()),
  ('b1000000-0000-4000-8000-000000000002', 'policy-rejoin@example.test', now()),
  ('b1000000-0000-4000-8000-000000000003', 'policy-retained@example.test', now()),
  ('b1000000-0000-4000-8000-000000000004', 'policy-all@example.test', now()),
  ('b1000000-0000-4000-8000-000000000005', 'policy-suspended@example.test', now()),
  ('b1000000-0000-4000-8000-000000000006', 'policy-current@example.test', now());

insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
  ('b1100000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', now(), now(), 'aal2'),
  ('b1100000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', now(), now(), 'aal2'),
  ('b1100000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000003', now(), now(), 'aal2');
insert into private.session_installations (
  session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family
) values
  ('b1100000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'b1200000-0000-4000-8000-000000000001', 'web', decode(repeat('b1', 32), 'hex'), 'desktop'),
  ('b1100000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'b1200000-0000-4000-8000-000000000002', 'web', decode(repeat('b2', 32), 'hex'), 'desktop'),
  ('b1100000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000003', 'b1200000-0000-4000-8000-000000000003', 'web', decode(repeat('b3', 32), 'hex'), 'desktop');

insert into public.organizations (
  id, slug, name, created_by_user_id, shift_schedule_authoritative
) values
  ('b2000000-0000-4000-8000-000000000001', 'policy-team-groups', 'Policy Team Groups', 'b1000000-0000-4000-8000-000000000001', true),
  ('b2000000-0000-4000-8000-000000000002', 'policy-other-tenant', 'Other Tenant', 'b1000000-0000-4000-8000-000000000001', true);
insert into public.organization_memberships (
  organization_id, user_id, role, status, job_title
) values
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'owner', 'active', 'director'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 'member', 'active', 'operator'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000003', 'member', 'active', 'operator'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000004', 'member', 'active', 'operator'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000005', 'member', 'suspended', 'operator'),
  ('b2000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000006', 'member', 'active', 'operator'),
  ('b2000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'owner', 'active', 'director');

insert into public.organization_units (
  id, organization_id, parent_unit_id, kind, name, created_by_user_id
) values
  ('b2100000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', null, 'site', 'Main site', 'b1000000-0000-4000-8000-000000000001'),
  ('b2100000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-000000000001', 'department', 'Operations', 'b1000000-0000-4000-8000-000000000001'),
  ('b2100000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-000000000002', 'team', 'Assembly', 'b1000000-0000-4000-8000-000000000001'),
  ('b2100000-0000-4000-8000-000000000004', 'b2000000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-000000000003', 'line', 'Line A', 'b1000000-0000-4000-8000-000000000001'),
  ('b2200000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002', null, 'team', 'Other team', 'b1000000-0000-4000-8000-000000000001');

select ok((select kind = 'line' from public.organization_units
  where id = 'b2100000-0000-4000-8000-000000000004'),
  'line is a supported authoritative organization-unit kind');
select throws_ok(
  $$update public.organization_units set parent_unit_id='b2200000-0000-4000-8000-000000000001' where id='b2100000-0000-4000-8000-000000000001'$$,
  '23514', 'organization unit hierarchy is invalid',
  'organization-unit parents cannot cross tenants');
select throws_ok(
  $$update public.organization_units set parent_unit_id='b2100000-0000-4000-8000-000000000004' where id='b2100000-0000-4000-8000-000000000001'$$,
  '23514', 'organization unit hierarchy cycle is not permitted',
  'recursive organization-unit cycles are rejected');

select is(
  private.normalize_dynamic_group_policy_spec(
    '{"membership_roles":["member","admin","member"]}'::jsonb
  ) -> 'membership_roles',
  '["admin","member"]'::jsonb,
  'policy normalization deduplicates and canonically orders values');
select throws_ok(
  $$select private.normalize_dynamic_group_policy_spec('{"membership_roles":["member"],"sql":"true"}'::jsonb)$$,
  '22023', 'invalid dynamic-group policy selector',
  'unknown selector keys fail closed');
select throws_ok(
  $sql$select private.normalize_dynamic_group_policy_spec((
    select jsonb_build_object('unit_ids', jsonb_agg(gen_random_uuid()::text),
      'membership_roles', jsonb_build_array('member'))
    from generate_series(1,101)
  ))$sql$,
  '22023', 'invalid dynamic-group policy selector',
  'selector arrays are bounded');
select is(
  private.dynamic_group_selector_fingerprint(
    '{"membership_roles":["member","admin"]}'::jsonb
  ),
  private.dynamic_group_selector_fingerprint(
    '{"membership_roles":["admin","member","member"]}'::jsonb
  ),
  'selector fingerprints are stable across equivalent input ordering');
select ok(
  private.dynamic_group_candidate_membership_allowed(
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002', now()
  ) and not private.dynamic_group_candidate_membership_allowed(
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002', now() - interval '1 hour'
  ),
  'candidate membership hook enforces the exact organization join boundary'
);

insert into public.organization_unit_members (organization_id, unit_id, user_id) values
  ('b2000000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000002'),
  ('b2000000-0000-4000-8000-000000000001', 'b2100000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000006');
insert into public.shift_assignments (
  id, organization_id, user_id, unit_id, starts_at, ends_at, created_by_user_id
) values (
  'b2300000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'b2100000-0000-4000-8000-000000000004',
  now() - interval '2 hours', now() + interval '2 hours',
  'b1000000-0000-4000-8000-000000000001'
), (
  'b2300000-0000-4000-8000-000000000002',
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000006',
  'b2100000-0000-4000-8000-000000000003',
  now() + interval '30 minutes', now() + interval '45 minutes',
  'b1000000-0000-4000-8000-000000000001'
);

create temporary table chat04_specs (name text primary key, spec jsonb, fingerprint text);
insert into chat04_specs values (
  'team',
  private.normalize_dynamic_group_policy_spec(jsonb_build_object(
    'team_ids', jsonb_build_array('b2100000-0000-4000-8000-000000000003'),
    'include_descendants', true,
    'membership_roles', jsonb_build_array('member'),
    'shift_mode', 'none'
  )), null
);
insert into chat04_specs values (
  'scheduled',
  private.normalize_dynamic_group_policy_spec(jsonb_build_object(
    'team_ids', jsonb_build_array('b2100000-0000-4000-8000-000000000003'),
    'include_descendants', true,
    'membership_roles', jsonb_build_array('member'),
    'shift_mode', 'scheduled',
    'scheduled_shift_starts_at', now() - interval '1 hour',
    'scheduled_shift_ends_at', now() + interval '1 hour'
  )), null
);
update chat04_specs set fingerprint=private.dynamic_group_selector_fingerprint(spec);

select ok((select bool_and(candidate.eligible_until is null)
  from private.dynamic_group_policy_candidates(
    'b2000000-0000-4000-8000-000000000001',
    (select spec from chat04_specs where name='team'), now()
  ) candidate),
  'shift_mode none ignores incidental active-shift end boundaries');
select is((select count(*)::bigint
  from private.dynamic_group_policy_candidates(
    'b2000000-0000-4000-8000-000000000001',
    private.normalize_dynamic_group_policy_spec(jsonb_build_object(
      'team_ids', jsonb_build_array('b2100000-0000-4000-8000-000000000003'),
      'include_descendants', true, 'membership_roles', jsonb_build_array('member'),
      'shift_mode', 'current'
    )), now()
  )), 1::bigint, 'current-shift selector requires an authoritative active shift');
select is((select count(*)::bigint
  from private.dynamic_group_policy_candidates(
    'b2000000-0000-4000-8000-000000000001',
    (select spec from chat04_specs where name='scheduled'), now()
  )), 1::bigint, 'scheduled-shift selector enforces its finite authoritative window');
select is(
  private.dynamic_group_policy_next_boundary(
    'b2000000-0000-4000-8000-000000000001',
    (select spec from chat04_specs where name='scheduled'), now()
  ),
  (select starts_at from public.shift_assignments
    where id='b2300000-0000-4000-8000-000000000002'),
  'scheduled-shift policies wake at a later assignment start inside the window'
);
select is((select count(*)::bigint
  from private.dynamic_group_policy_candidates(
    'b2000000-0000-4000-8000-000000000001',
    (select spec from chat04_specs where name='scheduled'),
    now() + interval '35 minutes'
  )), 2::bigint,
  'a later scheduled worker gains future access only after its shift starts');

-- Model the later contractor-access seam without depending on columns added by
-- CHAT-03. Its migration replaces these same two canonical hook signatures.
create temporary table chat04_candidate_expiries (
  organization_id uuid not null,
  user_id uuid not null,
  valid_until timestamptz not null,
  primary key (organization_id, user_id)
);
insert into chat04_candidate_expiries values (
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000006',
  now() + interval '15 minutes'
);
create or replace function private.dynamic_group_candidate_membership_allowed(
  p_organization_id uuid, p_user_id uuid, p_at timestamptz
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_at is not null and isfinite(p_at) and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_user_id
      and membership.status = 'active'
      and membership.joined_at <= p_at
      and not exists (
        select 1
        from pg_temp.chat04_candidate_expiries expiry
        where expiry.organization_id = membership.organization_id
          and expiry.user_id = membership.user_id
          and expiry.valid_until <= p_at
      )
  )
$$;
create or replace function private.dynamic_group_candidate_membership_valid_until(
  p_organization_id uuid, p_user_id uuid, p_at timestamptz
)
returns timestamptz
language sql stable security definer set search_path = ''
as $$
  select expiry.valid_until
  from pg_temp.chat04_candidate_expiries expiry
  where expiry.organization_id = p_organization_id
    and expiry.user_id = p_user_id
$$;
select is(
  private.dynamic_group_policy_next_boundary(
    'b2000000-0000-4000-8000-000000000001',
    (select spec from chat04_specs where name='team'), now()
  ),
  (select valid_until from chat04_candidate_expiries),
  'finite organization-access expiry becomes the exact next policy boundary'
);
select ok(
  exists (
    select 1 from private.dynamic_group_policy_candidates(
      'b2000000-0000-4000-8000-000000000001',
      (select spec from chat04_specs where name='team'),
      (select valid_until - interval '1 microsecond' from chat04_candidate_expiries)
    ) candidate where candidate.user_id='b1000000-0000-4000-8000-000000000006'
  ) and not exists (
    select 1 from private.dynamic_group_policy_candidates(
      'b2000000-0000-4000-8000-000000000001',
      (select spec from chat04_specs where name='team'),
      (select valid_until from chat04_candidate_expiries)
    ) candidate where candidate.user_id='b1000000-0000-4000-8000-000000000006'
  ),
  'candidate eligibility lapses at the exact finite organization-access boundary'
);
update chat04_candidate_expiries
set valid_until = now() + interval '1 hour';
select ok(exists (
  select 1 from private.dynamic_group_policy_candidates(
    'b2000000-0000-4000-8000-000000000001',
    (select spec from chat04_specs where name='team'), now() + interval '20 minutes'
  ) candidate where candidate.user_id='b1000000-0000-4000-8000-000000000006'
), 'renewed organization access restores future candidacy without reopening an old interval');

insert into public.conversations (
  id, organization_id, kind, name, history_policy, member_limit, created_by_user_id
) values
  ('b3000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000001', 'team', 'Since-join policy', 'since_join', 20, 'b1000000-0000-4000-8000-000000000001'),
  ('b3000000-0000-4000-8000-000000000002', 'b2000000-0000-4000-8000-000000000001', 'team', 'All-history policy', 'all', 20, 'b1000000-0000-4000-8000-000000000001'),
  ('b3000000-0000-4000-8000-000000000003', 'b2000000-0000-4000-8000-000000000001', 'team', 'Unpublished draft', 'since_join', 20, 'b1000000-0000-4000-8000-000000000001');
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, can_post, joined_by_user_id,
  joined_at, history_visible_from
)
select 'b2000000-0000-4000-8000-000000000001', conversation.id,
  membership.user_id,
  case when membership.user_id='b1000000-0000-4000-8000-000000000001'
    then 'owner' else 'member' end,
  true, 'b1000000-0000-4000-8000-000000000001',
  now() - interval '6 hours', now() - interval '6 hours'
from public.conversations conversation
cross join public.organization_memberships membership
where conversation.id in (
  'b3000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000002'
) and membership.organization_id='b2000000-0000-4000-8000-000000000001'
  and membership.status='active';
insert into public.conversation_members (
  organization_id, conversation_id, user_id, role, joined_by_user_id
) values (
  'b2000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000003', 'member',
  'b1000000-0000-4000-8000-000000000001'
);

create temporary table chat04_messages (name text primary key, id bigint);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"service_role","session_id":"b1100000-0000-4000-8000-000000000001","aal":"aal2"}', true);
with inserted as (
  insert into public.messages (organization_id, conversation_id, sender_user_id, client_nonce, kind, body, created_at)
  values ('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000001','text','before eligibility',now()-interval '5 hours') returning id
) insert into chat04_messages select 'before', id from inserted;
with inserted as (
  insert into public.messages (organization_id, conversation_id, sender_user_id, client_nonce, kind, body, created_at)
  values ('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000002','text','old eligible pagination needle',now()-interval '3 hours 30 minutes') returning id
) insert into chat04_messages select 'old', id from inserted;
with inserted as (
  insert into public.messages (organization_id, conversation_id, sender_user_id, client_nonce, kind, body, created_at)
  values ('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000003','text','hidden gap',now()-interval '2 hours') returning id
) insert into chat04_messages select 'gap', id from inserted;
with inserted as (
  insert into public.messages (organization_id, conversation_id, sender_user_id, client_nonce, kind, body, created_at)
  values ('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000004','text','current eligible',now()-interval '30 minutes') returning id
) insert into chat04_messages select 'current', id from inserted;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000003","role":"service_role","session_id":"b1100000-0000-4000-8000-000000000003","aal":"aal2"}', true);
with inserted as (
  insert into public.messages (organization_id, conversation_id, sender_user_id, client_nonce, kind, body, created_at)
  values ('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003','b4000000-0000-4000-8000-000000000005','text','retained sender old',now()-interval '3 hours 20 minutes') returning id
) insert into chat04_messages select 'retained_sender', id from inserted;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"service_role","session_id":"b1100000-0000-4000-8000-000000000001","aal":"aal2"}', true);
with inserted as (
  insert into public.messages (organization_id, conversation_id, sender_user_id, client_nonce, kind, body, created_at)
  values ('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000006','text','all before',now()-interval '5 hours') returning id
) insert into chat04_messages select 'all_before', id from inserted;
with inserted as (
  insert into public.messages (organization_id, conversation_id, sender_user_id, client_nonce, kind, body, created_at)
  values ('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001','b4000000-0000-4000-8000-000000000007','text','all after loss',now()-interval '2 hours') returning id
) insert into chat04_messages select 'all_after', id from inserted;

create temporary table chat04_search_messages as
with inserted as (
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, client_nonce, kind, body
  )
  select 'b2000000-0000-4000-8000-000000000001'::uuid,
    'b3000000-0000-4000-8000-000000000001'::uuid,
    'b1000000-0000-4000-8000-000000000001'::uuid,
    gen_random_uuid(), 'text', 'pagination needle hidden ' || series.ordinality
  from generate_series(1,55) series(ordinality)
  returning id
)
select id, row_number() over (order by id)::integer as ordinality
from inserted;

-- The production insert validator assigns the server timestamp. Rewind only this
-- transaction's fixtures so the interval/cutoff assertions exercise exact time
-- boundaries instead of seven effectively simultaneous messages.
alter table public.messages disable trigger user;
update public.messages message
set created_at = case fixture.name
  when 'before' then now() - interval '5 hours'
  when 'old' then now() - interval '3 hours 30 minutes'
  when 'retained_sender' then now() - interval '3 hours 20 minutes'
  when 'gap' then now() - interval '2 hours'
  when 'current' then now() - interval '30 minutes'
  when 'all_before' then now() - interval '5 hours'
  when 'all_after' then now() - interval '2 hours'
end
from chat04_messages fixture
where message.id = fixture.id;
update public.messages message
set created_at = now() - interval '2 hours'
from chat04_search_messages fixture
where message.id = fixture.id;
alter table public.messages enable trigger user;

insert into public.dynamic_group_policies (
  id, organization_id, conversation_id, member_roles, status, version,
  created_by_user_id, approved_by_user_id, approved_at,
  policy_spec, draft_state, selector_fingerprint
) values
  ('b3100000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',array['member']::text[],'active',1,'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',now(),(select spec from chat04_specs where name='team'),'published',(select fingerprint from chat04_specs where name='team')),
  ('b3100000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002',array['member']::text[],'active',1,'b1000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',now(),(select spec from chat04_specs where name='team'),'published',(select fingerprint from chat04_specs where name='team')),
  ('b3100000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000003',array['member']::text[],'draft',1,'b1000000-0000-4000-8000-000000000001',null,null,(select spec from chat04_specs where name='team'),'draft',(select fingerprint from chat04_specs where name='team'));
insert into public.dynamic_group_policy_versions (
  id, organization_id, policy_id, conversation_id, policy_version,
  policy_spec, selector_fingerprint, membership_state_fingerprint,
  evaluated_at, eligible_count, added_count, removed_count, unchanged_count,
  published_by_user_id, published_at
) values
  ('b3200000-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',1,(select spec from chat04_specs where name='team'),(select fingerprint from chat04_specs where name='team'),private.dynamic_group_membership_state_fingerprint('b2000000-0000-4000-8000-000000000001',(select spec from chat04_specs where name='team'),now()),now(),2,2,3,0,'b1000000-0000-4000-8000-000000000001',now()),
  ('b3200000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000002',1,(select spec from chat04_specs where name='team'),(select fingerprint from chat04_specs where name='team'),private.dynamic_group_membership_state_fingerprint('b2000000-0000-4000-8000-000000000001',(select spec from chat04_specs where name='team'),now()),now(),2,2,3,0,'b1000000-0000-4000-8000-000000000001',now());
update public.dynamic_group_policies set published_version_id=case id
  when 'b3100000-0000-4000-8000-000000000001' then 'b3200000-0000-4000-8000-000000000001'::uuid
  else 'b3200000-0000-4000-8000-000000000002'::uuid end
where id in ('b3100000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000002');

insert into private.dynamic_group_access_intervals (
  organization_id, policy_id, policy_version_id, conversation_id, user_id,
  valid_from, valid_until, history_visible_from, selector_fingerprint,
  opened_reason, closed_reason
) values
  ('b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',now()-interval '4 hours',now()-interval '3 hours',now()-interval '4 hours',(select fingerprint from chat04_specs where name='team'),'test.old','test.loss'),
  ('b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',now()-interval '1 hour',null,now()-interval '1 hour',(select fingerprint from chat04_specs where name='team'),'test.rejoin',null),
  ('b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003',now()-interval '4 hours',now()-interval '3 hours',now()-interval '4 hours',(select fingerprint from chat04_specs where name='team'),'test.retained','test.loss'),
  ('b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',now()-interval '4 hours',now()-interval '3 hours',now()-interval '4 hours',(select fingerprint from chat04_specs where name='team'),'test.governance','test.loss'),
  ('b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000005',now()-interval '4 hours',now()-interval '3 hours',null,(select fingerprint from chat04_specs where name='team'),'test.suspended','test.loss'),
  ('b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000001','b3200000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000006',now()-interval '1 hour',null,now()-interval '1 hour',(select fingerprint from chat04_specs where name='team'),'test.current',null),
  ('b2000000-0000-4000-8000-000000000001','b3100000-0000-4000-8000-000000000002','b3200000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000004',now()-interval '4 hours',now()-interval '3 hours',null,(select fingerprint from chat04_specs where name='team'),'test.all','test.loss');

insert into private.dynamic_group_access_intervals (
  organization_id, policy_id, policy_version_id, conversation_id, user_id,
  valid_from, eligibility_valid_until, history_visible_from,
  selector_fingerprint, opened_reason
) values (
  'b2000000-0000-4000-8000-000000000001',
  'b3100000-0000-4000-8000-000000000002',
  'b3200000-0000-4000-8000-000000000002',
  'b3000000-0000-4000-8000-000000000002',
  'b1000000-0000-4000-8000-000000000003',
  now() + interval '1 hour', now() + interval '2 hours', null,
  (select fingerprint from chat04_specs where name='team'), 'test.future'
);
select ok(not private.dynamic_group_conversation_access_allowed_for_user(
  'b2000000-0000-4000-8000-000000000001',
  'b3000000-0000-4000-8000-000000000002',
  'b1000000-0000-4000-8000-000000000003', now()
), 'a future eligibility interval does not expose its conversation shell early');

select ok(private.dynamic_group_user_currently_eligible('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',now()), 'rejoined authoritative member has current access');
select ok(not private.dynamic_group_user_currently_eligible('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003',now()), 'stale active cache row does not grant current access');
select ok(not private.dynamic_group_user_currently_eligible('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',now()), 'governance ownership does not bypass content eligibility');
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"service_role","session_id":"b1100000-0000-4000-8000-000000000001","aal":"aal2"}', true);
select ok(
  not private.is_conversation_member(
    'b2000000-0000-4000-8000-000000000001',
    'b3000000-0000-4000-8000-000000000001'
  ) and not private.is_conversation_admin(
    'b2000000-0000-4000-8000-000000000001',
    'b3000000-0000-4000-8000-000000000001'
  ),
  'a stale cached owner row grants neither current membership nor content administration after policy eligibility is lost'
);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"service_role","session_id":"b1100000-0000-4000-8000-000000000002","aal":"aal2"}', true);
select ok(
  private.is_conversation_member(
    'b2000000-0000-4000-8000-000000000001',
    'b3000000-0000-4000-8000-000000000001'
  ) and not private.is_conversation_admin(
    'b2000000-0000-4000-8000-000000000001',
    'b3000000-0000-4000-8000-000000000001'
  ),
  'a currently eligible ordinary member retains current membership without acquiring administration'
);
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000001","role":"service_role","session_id":"b1100000-0000-4000-8000-000000000001","aal":"aal2"}', true);
select ok(not private.dynamic_group_conversation_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000005',now()), 'suspended member loses current and retained history immediately');
select ok(private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',(select id from chat04_messages where name='old'),'b1000000-0000-4000-8000-000000000002',now()), 'old interval remains readable after rejoin');
select ok(not private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',(select id from chat04_messages where name='before'),'b1000000-0000-4000-8000-000000000002',now()), 'since-join denies pre-eligibility history');
select ok(not private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',(select id from chat04_messages where name='gap'),'b1000000-0000-4000-8000-000000000002',now()), 'rejoin does not expose an ineligibility gap');
select ok(private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',(select id from chat04_messages where name='current'),'b1000000-0000-4000-8000-000000000002',now()), 'post-rejoin messages are readable');
select ok(private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',(select id from chat04_messages where name='retained_sender'),'b1000000-0000-4000-8000-000000000003',now()), 'retained-only member keeps old authorized content');
select ok(not private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',(select id from chat04_messages where name='current'),'b1000000-0000-4000-8000-000000000003',now()), 'retained-only member cannot read future content');
select ok(private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002',(select id from chat04_messages where name='all_before'),'b1000000-0000-4000-8000-000000000004',now()), 'all-history permits content before eligibility');
select ok(not private.dynamic_group_message_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000002',(select id from chat04_messages where name='all_after'),'b1000000-0000-4000-8000-000000000004',now()), 'all-history remains bounded at exact eligibility loss');
select ok(private.dynamic_group_conversation_access_allowed_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003',now()), 'retained interval exposes a read-only conversation shell');
select ok(not private.dynamic_group_policy_conversation('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000003'), 'unpublished draft does not alter access or controls');

update public.organization_memberships
set directory_visibility='private'
where organization_id='b2000000-0000-4000-8000-000000000001'
  and user_id in (
    'b1000000-0000-4000-8000-000000000003',
    'b1000000-0000-4000-8000-000000000006'
  );
select ok(not private.dynamic_group_search_item_allowed_for_user(
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  jsonb_build_object('type','people','id','b1000000-0000-4000-8000-000000000003'),
  now()
), 'people search applies explicit-actor private-directory visibility');
select ok(private.dynamic_group_search_item_allowed_for_user(
  'b2000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  jsonb_build_object('type','people','id','b1000000-0000-4000-8000-000000000003'),
  now()
), 'organization governance may resolve a private directory member');
select is(jsonb_array_length(
  private.dynamic_group_conversation_list_item_for_user(
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000002',
    jsonb_build_object(
      'conversation_id','b3000000-0000-4000-8000-000000000001',
      'members',jsonb_build_array(
        jsonb_build_object('user_id','b1000000-0000-4000-8000-000000000002'),
        jsonb_build_object('user_id','b1000000-0000-4000-8000-000000000006')
      )
    ), now()
  ) -> 'members'
), 1, 'bootstrap roster projection applies actor-aware directory visibility');

select throws_ok($$update public.conversation_members set role='admin' where conversation_id='b3000000-0000-4000-8000-000000000001' and user_id='b1000000-0000-4000-8000-000000000006'$$, '42501', 'manual membership is locked by the published dynamic policy', 'published policy locks manual membership mutation');
select throws_ok($$update private.dynamic_group_access_intervals set valid_until=now()+interval '1 hour' where policy_id='b3100000-0000-4000-8000-000000000001' and user_id='b1000000-0000-4000-8000-000000000003'$$, '55000', 'dynamic-group access intervals may only close monotonically', 'closed intervals cannot be extended or reopened');
select throws_ok($$delete from private.dynamic_group_access_intervals where policy_id='b3100000-0000-4000-8000-000000000001' and user_id='b1000000-0000-4000-8000-000000000003'$$, '55000', 'dynamic-group access intervals cannot be deleted', 'access intervals are undeletable');
select throws_ok($$update public.dynamic_group_policy_versions set eligible_count=1 where id='b3200000-0000-4000-8000-000000000001'$$, '55000', 'published dynamic-group policy versions are immutable', 'published versions are immutable');
select throws_ok($$update public.organization_unit_members set user_id='b1000000-0000-4000-8000-000000000003' where unit_id='b2100000-0000-4000-8000-000000000004' and user_id='b1000000-0000-4000-8000-000000000002'$$, '22000', 'organization unit membership identity is immutable', 'unit-member source identity cannot be reassigned');
select throws_ok($$update public.organization_memberships set joined_at=joined_at-interval '1 day' where organization_id='b2000000-0000-4000-8000-000000000001' and user_id='b1000000-0000-4000-8000-000000000002'$$, '22000', 'organization membership identity and join boundary are immutable', 'organization join boundary cannot be rewritten');
select ok((select (trigger_row.tgtype::integer & 28) = 28
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid='public.organization_memberships'::regclass
    and trigger_row.tgname='organization_memberships_96_dynamic_group_source'
    and not trigger_row.tgisinternal),
  'membership source invalidation covers insert, delete, and relevant updates');

select ok(has_function_privilege('service_role','public.bff_publish_dynamic_group_policy(uuid,uuid,uuid,uuid,integer,text,text,text)','execute') and not has_function_privilege('authenticated','public.bff_publish_dynamic_group_policy(uuid,uuid,uuid,uuid,integer,text,text,text)','execute'), 'publish RPC is service-role only');
select ok((select relrowsecurity and relforcerowsecurity from pg_class where oid='public.dynamic_group_policy_versions'::regclass) and not has_table_privilege('authenticated','public.dynamic_group_policy_versions','select'), 'immutable versions are forced-RLS with no client table privilege');

grant select on public.conversation_members, public.messages to authenticated;
grant execute on function private.current_session_active_for_org(uuid) to authenticated;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000003","role":"authenticated","session_id":"b1100000-0000-4000-8000-000000000003","aal":"aal2"}', true);
select is((select count(*)::bigint from public.conversation_members where conversation_id='b3000000-0000-4000-8000-000000000001'), 1::bigint, 'retained-only direct RLS exposes at most the viewer cache row');
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"b1100000-0000-4000-8000-000000000002","aal":"aal2"}', true);
select is((select count(*)::bigint from public.conversation_members where conversation_id='b3000000-0000-4000-8000-000000000001'), 2::bigint, 'current direct RLS roster contains only current policy candidates');
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select throws_ok(format($sql$select private.bff_set_message_reaction_impl('b1000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','b1100000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001',%s,'x','gap-reaction',repeat('1',64))$sql$,(select id from chat04_messages where name='gap')), '42501', 'reaction target is not available', 'guessed gap reaction is denied before command execution');
select throws_ok(format($sql$select private.bff_send_message_impl('b1000000-0000-4000-8000-000000000002','b2000000-0000-4000-8000-000000000001','b1100000-0000-4000-8000-000000000002','b3000000-0000-4000-8000-000000000001','b4100000-0000-4000-8000-000000000001','text','gap reply','en',%s,null,'{}','gap-reply',repeat('2',64))$sql$,(select id from chat04_messages where name='gap')), '42501', 'reply, thread, and mentions require current policy access', 'guessed gap reply is denied before command execution');
select throws_ok(format($sql$select private.bff_edit_message_impl('b1000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000001','b1100000-0000-4000-8000-000000000003','b3000000-0000-4000-8000-000000000001',%s,'forbidden retained edit','retained-edit',repeat('8',64))$sql$,(select id from chat04_messages where name='retained_sender')), '42501', 'message mutation requires current policy access', 'retained-history access cannot edit an old message');
select throws_ok(format($sql$select private.bff_delete_message_impl('b1000000-0000-4000-8000-000000000003','b2000000-0000-4000-8000-000000000001','b1100000-0000-4000-8000-000000000003','b3000000-0000-4000-8000-000000000001',%s,'retained-delete',repeat('9',64))$sql$,(select id from chat04_messages where name='retained_sender')), '42501', 'message mutation requires current policy access', 'retained-history access cannot delete an old message');
select is((private.dynamic_group_conversation_list_item_for_user('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',jsonb_build_object('conversation_id','b3000000-0000-4000-8000-000000000001','posting_mode','all_members','member_role','member','members','[]'::jsonb,'last_read_message_id',null),now())#>>'{preview,message_id}')::bigint,(select id from chat04_messages where name='current'),'conversation preview skips hidden ineligibility-gap content');
select ok((private.dynamic_group_conversation_list_item_for_user('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003',jsonb_build_object('conversation_id','b3000000-0000-4000-8000-000000000001','posting_mode','all_members','member_role','member','members','[]'::jsonb,'last_read_message_id',null),now())->>'can_post')::boolean is false and (private.dynamic_group_conversation_list_item_for_user('b2000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000003',jsonb_build_object('conversation_id','b3000000-0000-4000-8000-000000000001','posting_mode','all_members','member_role','member','members','[]'::jsonb,'last_read_message_id',null),now())#>>'{preview,message_id}')::bigint=(select id from chat04_messages where name='retained_sender'), 'retained conversation card is read-only and bounded to its cutoff');
select is(private.dynamic_group_receipt_payload_for_user('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001',(select id from chat04_messages where name='retained_sender'),'b1000000-0000-4000-8000-000000000003',now()), null::jsonb, 'retained sender cannot observe live receipt aggregates');
select is(
  (private.bff_search_v3_impl(
    'b1000000-0000-4000-8000-000000000002',
    'b2000000-0000-4000-8000-000000000001',
    'b1100000-0000-4000-8000-000000000002',
    'needle', array['messages']::text[], null, 1,
    null, null, null, array['original']::text[],
    'b3000000-0000-4000-8000-000000000001', null
  ) #>> '{results,0,id}')::bigint,
  (select id from chat04_messages where name='old'),
  'search scans past more than fifty unauthorized gap rows without a false terminal page'
);

create temporary table chat04_due_boundary as
select statement_timestamp() - interval '10 minutes' as boundary_at;
select set_config('app.dynamic_group_policy_write_context', 'on', true);
update public.dynamic_group_policies
set next_evaluation_at=(select boundary_at from chat04_due_boundary)
where id='b3100000-0000-4000-8000-000000000002';
select set_config('app.dynamic_group_policy_write_context', 'off', true);
select lives_ok(
  $$select private.bff_process_dynamic_group_boundaries_impl(20)$$,
  'delayed scheduled-boundary processing succeeds'
);
select is((select boundary.boundary_at
  from private.dynamic_group_policy_source_boundaries boundary
  where boundary.policy_id='b3100000-0000-4000-8000-000000000002'
    and boundary.reason='time.boundary'),
  (select boundary_at from chat04_due_boundary),
  'a delayed worker preserves the scheduled cutoff instead of its execution time');

update public.organization_units set is_active=false where id='b2100000-0000-4000-8000-000000000003';
select ok(not private.dynamic_group_user_currently_eligible('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',now()), 'broad authoritative source change denies stale current access immediately');
update public.organization_units set is_active=true where id='b2100000-0000-4000-8000-000000000003';
select ok((select count(*) >= 2 from private.dynamic_group_policy_source_boundaries where policy_id='b3100000-0000-4000-8000-000000000001') and not private.dynamic_group_user_currently_eligible('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',now()), 'overlapping broad changes retain every cutoff and stay fail closed');
select lives_ok($$select private.bff_process_dynamic_group_reconciliation_impl(5,500)$$, 'bounded reconciliation drains both broad source changes');
select ok(private.dynamic_group_user_currently_eligible('b2000000-0000-4000-8000-000000000001','b3000000-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000002',now()) and not exists (select 1 from private.dynamic_group_policy_source_boundaries where policy_id='b3100000-0000-4000-8000-000000000001'), 'access resumes only after bounded reconciliation clears durable cutoffs');

select lives_ok($$select private.bff_pause_dynamic_group_policy_impl(
  'b1000000-0000-4000-8000-000000000001',
  'b2000000-0000-4000-8000-000000000001',
  'b1100000-0000-4000-8000-000000000001',
  'b3100000-0000-4000-8000-000000000001',
  1, 'Shift team retired', 'policy-pause-test', repeat('7',64)
)$$, 'authenticated AAL2 BFF pause emits the strict content-free policy system event');
select set_config(
  'request.jwt.claims',
  '{"sub":"b1000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"b1100000-0000-4000-8000-000000000001","aal":"aal2"}',
  true
);
select set_config('app.bff_service_context', 'on', true);
select throws_ok($sql$
  insert into public.messages (
    organization_id, conversation_id, sender_user_id, kind, body,
    language_detection_state, language_detection_method,
    language_detected_at, metadata
  ) values (
    'b2000000-0000-4000-8000-000000000001',
    'b3000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000001',
    'system', null, 'not_applicable', 'system', now(),
    '{"event_type":"dynamic_group.policy.paused","policy_version":1,"extra":"forbidden"}'::jsonb
  )
$sql$, '42501', 'system messages require a service workflow',
  'strict policy-event metadata rejects arbitrary authenticated BFF fields');
select set_config('app.bff_service_context', 'off', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select * from finish();
rollback;
