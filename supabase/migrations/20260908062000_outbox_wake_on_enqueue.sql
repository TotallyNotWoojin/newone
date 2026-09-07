-- Backlog 54 / audit section 3: the outbox worker polled 17,225 times in 24
-- hours to process 22 jobs -- a 0.13% hit rate, and with it ~17,000 Edge
-- invocations and as many cron log rows a day bought for nothing. The enqueue
-- side already knows when there is work: private.wake_ai_worker_on_enqueue has
-- woken the AI worker straight from the insert since 20260903020000. This
-- gives the outbox worker the same wake and turns its five-second poll into a
-- once-a-minute sweep.
--
-- The sweep is not decoration, and it is why the interval is a minute rather
-- than an hour. A wake is a best-effort net.http_post that is a silent no-op
-- whenever pg_net, Vault or the three secrets are missing, and a job deferred
-- by a retry backoff (available_at in the future) is never woken at all. One
-- minute is therefore the worst case for a job whose wake did not land, against
-- five seconds before. Every wake path stays fire-and-forget: a wake that
-- cannot be posted must never fail the send that enqueued the job.
--
-- The function below is the live pg_get_functiondef of the AI wake with four
-- textual edits: the name, the topic list, the target slug and batch limit, and
-- the warning text. It has no debounce because 20260904040000 measured the AI
-- debounce making the second message of a burst wait for the cron and
-- neutralised it; this worker drains and claims jobs the same way, so a wake
-- per enqueued job is both correct and cheap at 22 jobs a day.
--
-- The topics are exactly OUTBOX_TOPICS in newone-outbox-worker/handler.ts. A
-- deployment whose NEWONE_OUTBOX_TOPICS is narrower simply claims nothing on
-- that wake; the enqueue is rare enough that the wasted invocation does not
-- matter.

CREATE OR REPLACE FUNCTION private.wake_outbox_worker_on_enqueue()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_project_url text;
  v_server_apikey text;
  v_worker_token text;
begin
  if new.topic not in (
    'push', 'realtime_control', 'moderation',
    'storage_purge', 'session_revoke', 'dynamic_group_sync'
  )
    or new.status <> 'pending'
    or new.available_at > now() then
    return null;
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
    or to_regclass('vault.decrypted_secrets') is null then
    return null;
  end if;

  begin
    execute $sql$
      select
        max(secret.decrypted_secret) filter (where secret.name = 'newone_project_url'),
        max(secret.decrypted_secret) filter (where secret.name = 'newone_server_apikey'),
        max(secret.decrypted_secret) filter (where secret.name = 'newone_worker_token')
      from vault.decrypted_secrets secret
      where secret.name in (
        'newone_project_url', 'newone_server_apikey', 'newone_worker_token'
      )
    $sql$ into v_project_url, v_server_apikey, v_worker_token;
    if nullif(btrim(coalesce(v_project_url, '')), '') is null
      or nullif(btrim(coalesce(v_server_apikey, '')), '') is null
      or nullif(btrim(coalesce(v_worker_token, '')), '') is null then
      return null;
    end if;
    -- pg_net adds its own Content-Type: application/json; supplying one here
    -- duplicates the header and the gateway rejects the request.
    execute 'select net.http_post($1, $2, $3, $4, $5)'
    using rtrim(btrim(v_project_url), '/') || '/functions/v1/newone-outbox-worker',
      jsonb_build_object('limit', 10),
      '{}'::jsonb,
      jsonb_build_object(
        'apikey', btrim(v_server_apikey),
        'X-Newone-Worker-Token', btrim(v_worker_token)
      ),
      8000;
  exception when others then
    raise warning 'newone outbox worker wake skipped (%)', sqlstate;
  end;
  return null;
end;
$function$
;

-- The AI wake fires on the same table for its own topics. Ordering the triggers
-- 90 then 91 keeps the reading order obvious; each returns early on the other's
-- topics, so exactly one of them ever posts for a given row.
drop trigger if exists outbox_jobs_91_wake_outbox_worker on private.outbox_jobs;
create trigger outbox_jobs_91_wake_outbox_worker
  after insert on private.outbox_jobs
  for each row execute function private.wake_outbox_worker_on_enqueue();

revoke all on function private.wake_outbox_worker_on_enqueue()
  from public, anon, authenticated, service_role;

comment on function private.wake_outbox_worker_on_enqueue() is
  'Wakes newone-outbox-worker through pg_net when a worker-owned outbox job is enqueued; reads newone_project_url, newone_server_apikey, and newone_worker_token from Vault by name and is a no-op when pg_net, Vault, or those secrets are absent.';

-- The five-second poll becomes a one-minute sweep. The command is copied from
-- the live job rather than retyped, so the URL, headers, batch limit and
-- timeout stay exactly what they are today and only the schedule changes.
--
-- To restore the old behaviour, drop the trigger above and re-schedule with the
-- original interval:
--   drop trigger outbox_jobs_91_wake_outbox_worker on private.outbox_jobs;
--   do $r$ declare v text; begin
--     select command into v from cron.job where jobname = 'newone-outbox-worker';
--     perform cron.unschedule('newone-outbox-worker');
--     perform cron.schedule('newone-outbox-worker', '5 seconds', v);
--   end $r$;
do $$
declare
  v_command text;
begin
  select job.command into v_command from cron.job job
  where job.jobname = 'newone-outbox-worker';
  if v_command is null then
    raise notice 'newone-outbox-worker is not scheduled here; nothing to slow down';
    return;
  end if;
  perform cron.unschedule('newone-outbox-worker');
  perform cron.schedule('newone-outbox-worker', '* * * * *', v_command);
end;
$$;
