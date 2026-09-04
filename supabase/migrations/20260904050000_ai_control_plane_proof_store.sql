-- AI worker: persist the OpenRouter control-plane proof.
--
-- The four management-API proofs (key, BYOK, guardrails, workspace) are
-- cached for five minutes, but only in the worker isolate's memory, and the
-- Edge isolate is recycled between most invocations, so nearly every job
-- re-proved them: 0.5–1s before any tenant text could move, per stage.
-- Persist the verified time per proof tuple so a fresh isolate reads one row
-- instead of calling the management API. Same five-minute window; the key is
-- a SHA-256 of (key hash, workspace, model, route, ceilings) and carries no
-- secret. Nothing here shortens or skips the per-completion route probe.
create table if not exists private.ai_control_plane_proofs (
  cache_key text primary key
    constraint ai_control_plane_proofs_key_sha256 check (cache_key ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz not null,
  updated_at timestamptz not null default now()
);

revoke all on table private.ai_control_plane_proofs from public, anon, authenticated;

create or replace function public.bff_ai_control_plane_proof_lookup(p_cache_key text)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select proof.verified_at
  from private.ai_control_plane_proofs proof
  where proof.cache_key = p_cache_key
    and proof.verified_at <= now()
    and proof.verified_at > now() - interval '5 minutes'
$$;

create or replace function public.bff_ai_control_plane_proof_record(p_cache_key text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into private.ai_control_plane_proofs as proof (cache_key, verified_at, updated_at)
  values (p_cache_key, now(), now())
  on conflict (cache_key) do update
    set verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
$$;

revoke all on function public.bff_ai_control_plane_proof_lookup(text) from public, anon, authenticated;
grant execute on function public.bff_ai_control_plane_proof_lookup(text) to service_role;
revoke all on function public.bff_ai_control_plane_proof_record(text) from public, anon, authenticated;
grant execute on function public.bff_ai_control_plane_proof_record(text) to service_role;

comment on function public.bff_ai_control_plane_proof_lookup(text) is
  'AI worker only: verified_at of a control-plane proof tuple if it is within the five-minute window, else null.';
comment on function public.bff_ai_control_plane_proof_record(text) is
  'AI worker only: records that the control-plane proof for a tuple succeeded now.';
