-- A notification for a message you have already read (owner, Sep 8 2026). The
-- server is not the slow part -- a push reached the provider six seconds after
-- the message on Sep 8 -- but nothing between the enqueue and the send ever
-- asked whether the reader had got there first, so a push delayed anywhere
-- downstream (the provider, APNs, a phone that was off) still arrived and
-- announced something the person had read minutes ago.
--
-- The resolver runs at send time, which is exactly when the answer is known:
-- a recipient whose read cursor already covers this message is dropped from
-- the fan-out, using the same notifications_muted flag the mute and block
-- rules use, so the worker's accounting and the delivery log are unchanged.

create or replace function private.bff_resolve_push_job_v5_impl(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid, p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_result jsonb;
  v_job private.outbox_jobs%rowtype;
  v_message_id bigint;
  v_conversation_id uuid;
  v_deliveries jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_resolve_push_job_v4_impl(
    p_worker_id, p_job_id, p_after_device_id, p_limit
  );
  if jsonb_typeof(v_result -> 'deliveries') <> 'array'
     or jsonb_array_length(v_result -> 'deliveries') = 0 then
    return v_result;
  end if;

  select * into v_job from private.outbox_jobs job where job.id = p_job_id;
  if not found or not (v_job.payload ? 'message_id') then
    return v_result;
  end if;
  v_message_id := nullif(v_job.payload ->> 'message_id', '')::bigint;
  if v_message_id is null then
    return v_result;
  end if;
  select message.conversation_id into v_conversation_id
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.id = v_message_id;
  if v_conversation_id is null then
    return v_result;
  end if;

  select coalesce(jsonb_agg(
      case when exists (
          select 1 from public.conversation_read_cursors cursor_row
          where cursor_row.organization_id = v_job.organization_id
            and cursor_row.conversation_id = v_conversation_id
            and cursor_row.user_id = nullif(entry.delivery ->> 'user_id', '')::uuid
            and cursor_row.last_read_message_id >= v_message_id
        )
        then jsonb_set(entry.delivery, '{notifications_muted}', 'true'::jsonb, true)
        else entry.delivery
      end
      order by entry.ordinality), '[]'::jsonb)
    into v_deliveries
  from jsonb_array_elements(v_result -> 'deliveries')
    with ordinality as entry(delivery, ordinality);

  return jsonb_set(v_result, '{deliveries}', v_deliveries, true);
end;
$function$;

revoke all on function private.bff_resolve_push_job_v5_impl(uuid, bigint, uuid, integer) from public;
grant execute on function private.bff_resolve_push_job_v5_impl(uuid, bigint, uuid, integer) to service_role;

create or replace function public.bff_resolve_push_job(
  p_worker_id uuid, p_job_id bigint,
  p_after_device_id uuid default null::uuid, p_limit integer default 500
)
returns jsonb
language sql
set search_path = ''
as $function$ select private.bff_resolve_push_job_v5_impl(
  p_worker_id, p_job_id, p_after_device_id, p_limit
) $function$;
