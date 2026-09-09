-- Owner's call, Sep 9 2026: five seconds rather than a minute.
--
-- The guard exists so a prompt notification is never dropped for a message the
-- reader has "already read" — which, with the chat open, happens within a
-- second of it arriving. Five seconds still covers the case that broke it (the
-- push resolved 0.6s after the message), and holds back a genuinely late push
-- sooner than a minute did.
--
-- The trade, recorded so it is not a surprise: if the worker ever takes longer
-- than five seconds to resolve a push — a backlog, a retry — a message the
-- reader has open will stop notifying again. The half-second read buffer from
-- 20260909100000 is what covers the ordinary case.

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
  v_created_at timestamptz;
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
  select message.conversation_id, message.created_at
    into v_conversation_id, v_created_at
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.id = v_message_id;
  -- Sent in the last five seconds: nobody has already read it in any sense
  -- that should cost them the notification.
  if v_conversation_id is null or v_created_at > now() - interval '5 seconds' then
    return v_result;
  end if;

  select coalesce(jsonb_agg(
      case when exists (
          select 1 from public.conversation_read_cursors cursor_row
          where cursor_row.organization_id = v_job.organization_id
            and cursor_row.conversation_id = v_conversation_id
            and cursor_row.user_id = nullif(entry.delivery ->> 'user_id', '')::uuid
            and cursor_row.last_read_message_id >= v_message_id
            and cursor_row.last_read_at < now() - interval '500 milliseconds'
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
