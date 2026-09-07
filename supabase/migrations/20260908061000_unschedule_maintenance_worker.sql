-- Backlog 54 / audit section 4: newone-maintenance-worker is 100% workplace
-- machinery running against tables that have never held a row.
--
-- The whole Edge Function calls exactly three RPCs --
-- bff_promote_due_announcements, bff_process_announcement_obligations and
-- bff_process_overdue_handoffs -- and they act only on announcements and shift
-- handoffs. Live on Sep 7 2026: announcements, announcement_versions,
-- announcement_recipients, shift_handoffs, handoff_versions and
-- handoff_acknowledgements all have n_tup_ins = 0 over the whole life of the
-- database, and all three RPCs have 3,573 calls each in pg_stat_statements.
-- Real work, on nothing.
--
-- Cost removed: 1,440 Edge invocations a day (43,200 a month), 4,320 RPC round
-- trips a day, and 1,440 rows a day into cron.job_run_details.
--
-- What is NOT removed: the newone-maintenance-worker Edge Function and all
-- three RPCs stay exactly as they are. The workplace realm is not retired; only
-- the timer is. Nothing else calls the schedule, so this is one line to undo.
--
-- To put it back, with the schedule and command exactly as they are today:
--
--   select cron.schedule(
--     'newone-maintenance-worker',
--     '* * * * *',
--     $cron$
--
--           select net.http_post(
--             url := (select decrypted_secret from vault.decrypted_secrets where name = 'newone_project_url') || '/functions/v1/newone-maintenance-worker',
--             headers := jsonb_build_object(
--               'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'newone_server_apikey'),
--               'X-Newone-Worker-Token', (select decrypted_secret from vault.decrypted_secrets where name = 'newone_worker_token')
--             ),
--             body := '{}'::jsonb,
--             timeout_milliseconds := 8000
--           );
--
--     $cron$
--   );
--
-- Anyone restoring it should re-check the two tables first: if they are still
-- empty, the job still has nothing to do.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'newone-maintenance-worker') then
    perform cron.unschedule('newone-maintenance-worker');
    raise notice 'newone-maintenance-worker unscheduled';
  else
    raise notice 'newone-maintenance-worker was not scheduled here';
  end if;
end;
$$;
