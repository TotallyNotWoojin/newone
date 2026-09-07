-- Muting a person silences their notifications everywhere -- one-to-one and
-- inside groups -- and hides nothing. It is a personal preference of the
-- muter's, so it lives beside member_blocks and is never visible to the person
-- who was muted.
create table if not exists public.person_mutes (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  muter_user_id uuid not null,
  muted_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, muter_user_id, muted_user_id),
  constraint person_mutes_distinct_users check (muter_user_id <> muted_user_id),
  constraint person_mutes_organization_id_muter_user_id_fkey
    foreign key (organization_id, muter_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint person_mutes_organization_id_muted_user_id_fkey
    foreign key (organization_id, muted_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict
);

alter table public.person_mutes enable row level security;
alter table public.person_mutes force row level security;

-- A reader sees only their own mutes; writes go through the command below.
drop policy if exists person_mutes_select_own on public.person_mutes;
create policy person_mutes_select_own on public.person_mutes
  for select to authenticated
  using (
    muter_user_id = (select auth.uid())
    and (select private.is_org_member(person_mutes.organization_id))
  );

-- The push resolver asks "who muted this sender?", so that is the index.
create index if not exists person_mutes_muted_user_idx
  on public.person_mutes (organization_id, muted_user_id);

create or replace function private.bff_set_person_mute_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
  p_muted boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare v_command jsonb; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'person.mute.set', false, 0, '/v2/people/:id/mute',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_target_user_id = p_actor_user_id or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_target_user_id
      and membership.status = 'active'
  ) then
    raise exception 'active mute target required' using errcode = '42501';
  end if;
  if p_muted then
    insert into public.person_mutes (organization_id, muter_user_id, muted_user_id)
    values (p_organization_id, p_actor_user_id, p_target_user_id)
    on conflict do nothing;
  else
    delete from public.person_mutes mute
    where mute.organization_id = p_organization_id
      and mute.muter_user_id = p_actor_user_id
      and mute.muted_user_id = p_target_user_id;
  end if;
  v_response := jsonb_build_object('target_user_id', p_target_user_id, 'muted', p_muted);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/people/:id/mute',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$;

create or replace function public.bff_set_person_mute(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
  p_muted boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select private.bff_set_person_mute_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_target_user_id,
    p_muted, p_idempotency_key, p_request_sha256
  )
$function$;

revoke execute on function
  private.bff_set_person_mute_impl(uuid, uuid, uuid, uuid, boolean, text, text),
  public.bff_set_person_mute(uuid, uuid, uuid, uuid, boolean, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  private.bff_set_person_mute_impl(uuid, uuid, uuid, uuid, boolean, text, text),
  public.bff_set_person_mute(uuid, uuid, uuid, uuid, boolean, text, text)
to service_role;
