-- Backlog 54 / audit section 1: cron.job_run_details is 80% of the database and
-- nothing has ever pruned it.
--
-- Measured on the live project, Sep 7 2026:
--   192,189 rows, 237 MB, of a 293 MB database; oldest row Sep 1 23:12 UTC.
--   39,518 rows a day at ~1,296 bytes each, so ~51 MB a day, unbounded.
-- pg_cron writes one row per execution and stores the whole command text in it,
-- which is why a row costs a kilobyte and a week costs a quarter of a gigabyte.
-- The application schema this serves is 6 MB. pg_net already self-purges its
-- own response log; pg_cron does not, and only a human debugging a job ever
-- reads this table.
--
-- Window. A flat seven days would settle at roughly 200 MB even after the other
-- two changes in this set cut the row rate, and it would also throw away
-- failures after a week -- and failures are the only rows anyone actually
-- reads. So the window is split:
--
--   succeeded runs   3 days   covers a weekend, which is the real ask ("it
--                             broke on Friday and I looked on Monday")
--   everything else  30 days  failures and rows still running; 43 rows exist
--                             in the whole six-day history, about 7 a day, so
--                             a month of them costs under half a megabyte
--
-- Steady state after this and the two sibling migrations: ~22,300 rows a day
-- (the outbox drops from 17,226 runs to 1,440 and maintenance to 0), so about
-- 67,000 succeeded rows and ~210 failed ones -- roughly 87 MB, against 238 MB
-- today and unbounded growth. Strictly more failure history than a 7-day
-- window, at 43% of its size.
--
-- Counted against the live table on Sep 7 2026, the one-off below keeps 9,922
-- of 192,696 rows: 238 MB becomes about 12 MB, so roughly 226 MB comes back and
-- the database should fall from 294 MB to somewhere near 70 MB.
--
-- This is operational telemetry, not application data. Nothing in the client,
-- the Edge Functions, the tests or the scripts reads it.

create or replace function private.purge_cron_run_details_internal()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer := 0;
begin
  if to_regclass('cron.job_run_details') is null then
    return 0;
  end if;
  delete from cron.job_run_details entry
  where entry.start_time < now() - interval '30 days'
     or (coalesce(entry.status, '') = 'succeeded'
         and entry.start_time < now() - interval '3 days');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function private.purge_cron_run_details_internal()
  from public, anon, authenticated, service_role;

comment on function private.purge_cron_run_details_internal() is
  'Deletes cron run rows outside the retention window: succeeded runs older than three days, anything else older than thirty. Operational telemetry only.';

-- The backlog, once.
--
-- A plain delete of 190,000 rows leaves 237 MB of dead tuples: autovacuum makes
-- the space reusable but never returns it to the operating system, so the
-- database would stay 293 MB and the file would simply be refilled. Truncate
-- assigns a new relfilenode and unlinks the old one at commit, which is the
-- only way to actually give the disk back without VACUUM FULL -- and VACUUM
-- FULL cannot run inside a migration's transaction.
--
-- So: snapshot what is worth keeping, truncate, put it back. RESTART IDENTITY
-- is deliberately absent, so the runid sequence keeps counting past the rows
-- that are restored. A few seconds of run rows written by pg_cron between the
-- snapshot and the truncate are lost; they are telemetry about the truncate
-- itself. If the exclusive lock cannot be had, this degrades to the ordinary
-- delete: the retention rule still takes effect, only the disk is not returned
-- until the table is rewritten some other way.
--
-- The one-off keeps every non-succeeded row and six hours of succeeded ones,
-- not the three days the rule keeps. Truncate holds an exclusive lock until the
-- rows are back, and every cron job's own log write queues behind it; copying
-- three days of succeeded rows (~118,000 rows, ~150 MB, and as much WAL) would
-- stall the workers for as long as that took. Six hours is ~10,000 rows and a
-- couple of seconds. From the deploy forward the daily job keeps the full
-- window.
do $$
declare
  v_before bigint;
  v_after bigint;
  v_kept bigint;
begin
  if to_regclass('cron.job_run_details') is null then
    raise notice 'cron.job_run_details is absent here; nothing to compact';
    return;
  end if;
  v_before := pg_total_relation_size('cron.job_run_details');
  perform set_config('lock_timeout', '15s', true);

  create temporary table cron_run_details_keep on commit drop as
    select entry.* from cron.job_run_details entry
    where entry.start_time >= now() - interval '30 days'
      and (coalesce(entry.status, '') <> 'succeeded'
           or entry.start_time >= now() - interval '6 hours');
  select count(*) into v_kept from pg_temp.cron_run_details_keep;

  truncate cron.job_run_details;
  insert into cron.job_run_details select * from pg_temp.cron_run_details_keep;

  v_after := pg_total_relation_size('cron.job_run_details');
  raise notice 'cron.job_run_details compacted: % bytes -> % bytes, % rows kept',
    v_before, v_after, v_kept;
exception when others then
  raise warning 'cron.job_run_details truncate-compaction unavailable (%); falling back to delete', sqlstate;
  raise notice 'cron.job_run_details purged % rows by delete', private.purge_cron_run_details_internal();
end;
$$;

-- Daily, off the hour so it does not land with everything else. A day's worth
-- of deletions is around 22,000 rows, comfortably over the autovacuum threshold
-- for this table, so the space is recycled without any further help. The table
-- has only its primary key, so this is one sequential scan a day over roughly
-- 87 MB; adding an index to a table owned by supabase_admin is not worth the
-- fragility across platform upgrades.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'newone-cron-log-retention') then
    perform cron.unschedule('newone-cron-log-retention');
  end if;
  perform cron.schedule(
    'newone-cron-log-retention',
    '17 3 * * *',
    $cron$ select private.purge_cron_run_details_internal(); $cron$
  );
end;
$$;
