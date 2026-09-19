-- The outbox sweep runs every ten seconds, not once a minute.
--
-- Owner's father, Sep 19 2026, tested side by side: a message took 34 seconds
-- to reach his Android phone as a push, so he had opened the app to look
-- before it arrived. Three days of push jobs say why. A job that is not held
-- completes 0.4 s after enqueue (79 jobs, max 5.2 s): the enqueue wake works.
-- A job held for the recipient's translation completes after a median 33 s
-- (4 jobs, max 42.6 s) even though the translation itself lands in about
-- four seconds: the hold answers 503 translation_pending with a five-second
-- retry, but nothing wakes the worker when that retry falls due -- the wake
-- fires on enqueue only -- so the job waits for the minute sweep, or for an
-- unrelated enqueue (his own read receipt, that evening) to wake it.
--
-- Ten seconds matches the AI worker that produces the translation, so a held
-- push now goes out within about ten seconds of the translation landing
-- instead of within a minute. The command is copied from the live job, as
-- 20260908062000 did, so only the schedule changes. The enqueue wake stays.
do $$
declare
  v_command text;
begin
  select job.command into v_command from cron.job job
  where job.jobname = 'newone-outbox-worker';
  if v_command is null then
    raise notice 'newone-outbox-worker is not scheduled here; nothing to speed up';
    return;
  end if;
  perform cron.unschedule('newone-outbox-worker');
  perform cron.schedule('newone-outbox-worker', '10 seconds', v_command);
end;
$$;
