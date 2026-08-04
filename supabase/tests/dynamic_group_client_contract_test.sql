begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

select ok(
  to_regprocedure('public.bff_list_dynamic_group_policies(uuid,uuid,uuid,uuid,integer)') is not null
  and to_regprocedure('private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)') is not null,
  'the bounded public wrapper and private list implementation both exist'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.bff_list_dynamic_group_policies(uuid,uuid,uuid,uuid,integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'public.bff_list_dynamic_group_policies(uuid,uuid,uuid,uuid,integer)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'public.bff_list_dynamic_group_policies(uuid,uuid,uuid,uuid,integer)',
    'execute'
  ),
  'the public policy-query RPC is service-role only'
);

select ok(
  has_function_privilege(
    'service_role',
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)',
    'execute'
  )
  and not has_function_privilege(
    'authenticated',
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)',
    'execute'
  )
  and not has_function_privilege(
    'anon',
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)',
    'execute'
  ),
  'the private policy-query implementation is service-role only'
);

select ok(
  (select procedure_row.prosecdef and procedure_row.provolatile = 's'
   from pg_catalog.pg_proc procedure_row
   where procedure_row.oid =
     'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure),
  'the private policy query is stable and security definer'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%assert_bff_request_internal(%dynamic_group.policy.read%true,%900%',
  'policy queries require the dedicated permission and recent AAL2 session'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%actor_has_permission(%unit.manage%conversation.unit_id%'
  and pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%selected.unit_id%',
  'policy rows require unit.manage for the conversation and every selected unit'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%p_after_policy_id is null or policy.id > p_after_policy_id%'
  and pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%order by policy.id%'
  and pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%limit p_limit + 1%',
  'policy pagination uses a deterministic exclusive UUID cursor and bounded lookahead'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%conversation.kind in (%group%team%shift%'
  and pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%normalize_dynamic_group_policy_spec(policy.policy_spec)%',
  'the list exposes only eligible managed conversation kinds and normalized selectors'
);

select ok(
  pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%next_after_policy_id%'
  and pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%published_version_id%'
  and pg_catalog.pg_get_functiondef(
    'private.bff_list_dynamic_group_policies_impl(uuid,uuid,uuid,uuid,integer)'::regprocedure
  ) like '%selector_fingerprint%',
  'the policy page returns cursor, immutable publish identity, and CAS selector metadata'
);

select * from finish();
rollback;
