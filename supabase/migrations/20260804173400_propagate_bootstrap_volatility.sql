begin;

-- Discoverability includes wall-clock join-request expiry and request-time
-- authorization. Propagate that VOLATILE contract through every current
-- bootstrap and page-reader caller so PostgreSQL cannot reuse a stale result.
alter function private.bff_bootstrap_messaging_state_v7_pre_dynamic_group_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) volatile;

alter function private.bff_bootstrap_messaging_state_v7_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) volatile;

alter function private.bff_bootstrap_messaging_state_v8_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) volatile;

alter function private.bff_bootstrap_messaging_state_v9_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) volatile;

alter function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) volatile;

alter function private.bff_read_conversation_page_impl(
  uuid, uuid, uuid, uuid, bigint, integer
) volatile;

alter function public.bff_read_conversation_page(
  uuid, uuid, uuid, uuid, bigint, integer
) volatile;

commit;
