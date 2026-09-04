-- AI worker: wake on every job.
--
-- The per-topic two-second debounce (20260903020000) made the second message
-- of a burst wait for the ten-second cron: measured on Sep 3 2026, the second
-- of two messages sent a second apart took 5.9s to be detected and 10.1s to be
-- translated while the first took 0.8s / 4.8s. The worker now drains its queue
-- inside one pass and job claims are atomic, so a wake per enqueued job is both
-- safe and cheap. Owner requirement: a translation must be quick every time;
-- the cron remains only a safety net, never the normal path.
--
-- The function keeps its signature because the enqueue trigger calls it.
create or replace function private.ai_worker_wake_debounced(
  p_topic text,
  p_job_id bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select false
$$;

comment on function private.ai_worker_wake_debounced(text, bigint) is
  'Always false since 20260904040000: every AI job wakes the worker; the drain loop and atomic claims make concurrent wakes harmless.';
