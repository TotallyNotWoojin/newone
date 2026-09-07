begin;
select plan(6);

-- Retention (20260908060000).
select has_function(
  'private', 'purge_cron_run_details_internal',
  'cron run-log retention function exists'
);
select is(
  (select count(*)::int from cron.job where jobname = 'newone-cron-log-retention'),
  1,
  'cron run-log retention is scheduled'
);
-- The window is the point: nothing succeeded older than three days survives.
select is(
  (select count(*)::int from cron.job_run_details
   where coalesce(status, '') = 'succeeded'
     and start_time < now() - interval '3 days'),
  0,
  'no succeeded cron run older than the retention window is left behind'
);

-- The maintenance worker's timer is gone; its RPCs are not (20260908061000).
select is(
  (select count(*)::int from cron.job where jobname = 'newone-maintenance-worker'),
  0,
  'newone-maintenance-worker is not scheduled'
);
select has_function(
  'public', 'bff_process_overdue_handoffs',
  'the maintenance RPCs stay for the workplace realm'
);

-- Wake on enqueue (20260908062000).
select is(
  (select count(*)::int from pg_trigger
   where tgrelid = 'private.outbox_jobs'::regclass
     and tgname = 'outbox_jobs_91_wake_outbox_worker'),
  1,
  'an outbox enqueue wakes the outbox worker'
);

select * from finish();
rollback;
