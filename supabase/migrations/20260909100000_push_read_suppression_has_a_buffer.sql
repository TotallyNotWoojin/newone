-- The read-check added in v3.4 was meant for a notification arriving after you
-- had already read the message. It also swallowed prompt ones: a reply lands
-- while the chat is open, the app marks it read within a second, and the push
-- resolves a moment later to find the cursor already past it. The owner's own
-- log, Sep 9 2026: message at 09:23:44.2, push resolved at 09:23:44.8, dropped.
--
-- A buffer fixes it (owner's suggestion): reading a message half a second
-- before the push is prepared does not count as having read it already. A push
-- is only held back when the read is genuinely older than that — which is what
-- "I read this on my laptop a while ago" looks like, and is the case this rule
-- exists for.

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
            -- The buffer: a read from the same instant is not "already read".
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
