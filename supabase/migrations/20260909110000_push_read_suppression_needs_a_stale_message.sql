-- Follow-up to 20260909100000, from its own smoke: a half-second buffer on the
-- read is too tight to survive how long the worker takes. The push resolves a
-- second or two after the read, the read is already "old", and a prompt
-- notification is dropped exactly as before.
--
-- The rule keeps the owner's buffer and adds the thing that actually separates
-- the two cases: how long ago the message was sent. A notification for
-- something sent in the last minute always goes out — nobody has "already read
-- it" in any sense worth acting on — and only an older message, read at least
-- half a second before this moment, is held back. That is what reading it on
-- another device and getting the push much later looks like, which is the only
-- case this rule was ever for.

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
  -- Sent in the last minute: nobody has already read it in any sense that
  -- should cost them the notification.
  if v_conversation_id is null or v_created_at > now() - interval '60 seconds' then
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
