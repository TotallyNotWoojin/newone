begin;

-- Close two lifecycle gaps at authoritative database boundaries:
-- 1. retention workers must route around preserved messages instead of
--    selecting one and aborting the entire batch in the deletion trigger;
-- 2. active operational-role assignments must never outlive or bypass the
--    target's canonical organization access.

create or replace function private.scrub_conversation_avatar_candidates_internal(
  p_batch_size integer,
  p_at timestamptz default now()
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scrubbed integer;
begin
  perform private.require_service_role();
  if p_batch_size not between 1 and 5000
    or p_at is null or not isfinite(p_at) then
    raise exception 'invalid conversation avatar retention request'
      using errcode = '22023';
  end if;
  with candidates as (
    select message.id
    from public.messages message
    where message.deleted_at is null
      and message.metadata = jsonb_build_object('purpose', 'conversation_avatar')
      and message.created_at < p_at - interval '24 hours'
      and not exists (
        select 1
        from private.message_preservation_holds hold
        where hold.organization_id = message.organization_id
          and hold.conversation_id = message.conversation_id
          and hold.message_id = message.id
          and hold.released_at is null
      )
      and not exists (
        select 1
        from public.message_attachments attachment
        join public.conversations conversation
          on conversation.organization_id = attachment.organization_id
         and conversation.id = attachment.conversation_id
         and conversation.avatar_path = attachment.storage_path
        where attachment.organization_id = message.organization_id
          and attachment.conversation_id = message.conversation_id
          and attachment.message_id = message.id
      )
    order by message.created_at, message.id
    for update of message skip locked
    limit p_batch_size
  ), scrubbed as (
    update public.messages message
    set deleted_at = now()
    from candidates
    where message.id = candidates.id
    returning message.id
  )
  select count(*) into v_scrubbed from scrubbed;
  return v_scrubbed;
end;
$$;

create or replace function private.bff_scrub_retention_impl(p_batch_size integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_avatar_scrubbed integer;
  v_message_scrubbed integer := 0;
  v_remaining integer;
begin
  perform private.require_service_role();
  if p_batch_size not between 1 and 5000 then
    raise exception 'invalid retention batch size' using errcode = '22023';
  end if;
  v_avatar_scrubbed := private.scrub_conversation_avatar_candidates_internal(
    p_batch_size, now()
  );
  v_remaining := p_batch_size - v_avatar_scrubbed;
  if v_remaining > 0 then
    with candidates as (
      select message.id
      from public.messages message
      join public.organizations organization
        on organization.id = message.organization_id
      where message.deleted_at is null
        and message.created_at
          < now() - make_interval(days => organization.message_retention_days)
        and not exists (
          select 1
          from private.message_preservation_holds hold
          where hold.organization_id = message.organization_id
            and hold.conversation_id = message.conversation_id
            and hold.message_id = message.id
            and hold.released_at is null
        )
        and not exists (
          select 1
          from public.message_attachments attachment
          join public.conversations conversation
            on conversation.organization_id = attachment.organization_id
           and conversation.id = attachment.conversation_id
           and conversation.avatar_path = attachment.storage_path
          where attachment.organization_id = message.organization_id
            and attachment.conversation_id = message.conversation_id
            and attachment.message_id = message.id
        )
      order by message.created_at, message.id
      for update of message skip locked
      limit v_remaining
    ), scrubbed as (
      update public.messages message
      set deleted_at = now()
      from candidates
      where message.id = candidates.id
      returning message.id
    )
    select count(*) into v_message_scrubbed from scrubbed;
  end if;
  return jsonb_build_object(
    'scrubbed_messages', v_avatar_scrubbed + v_message_scrubbed,
    'scrubbed_avatar_candidates', v_avatar_scrubbed
  );
end;
$$;

revoke all on function private.scrub_conversation_avatar_candidates_internal(
  integer, timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.bff_scrub_retention_impl(integer)
from public, anon, authenticated;
grant execute on function private.bff_scrub_retention_impl(integer)
to service_role;

create or replace function private.validate_active_role_assignment_access()
returns trigger
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_membership_type text;
  v_membership_access_expires_at timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.role_name is distinct from old.role_name
      or new.scope_type is distinct from old.scope_type
      or new.unit_id is distinct from old.unit_id
      or new.granted_by_user_id is distinct from old.granted_by_user_id
      or new.grant_reason is distinct from old.grant_reason
      or new.granted_at is distinct from old.granted_at
      or new.expires_at is distinct from old.expires_at then
      raise exception 'role assignment grant fields are immutable'
        using errcode = '22000';
    end if;
  end if;

  -- Revocation is always allowed to move an assignment out of the active set,
  -- including legacy rows whose target no longer has canonical access.
  if new.revoked_at is not null then
    return new;
  end if;

  select membership.membership_type, membership.access_expires_at
    into v_membership_type, v_membership_access_expires_at
  from public.organization_memberships membership
  where membership.organization_id = new.organization_id
    and membership.user_id = new.user_id
    and private.organization_membership_access_current(
      membership.organization_id, membership.user_id, now()
    );

  if not found then
    raise exception 'active role assignment requires current organization access'
      using errcode = '23514';
  end if;
  if v_membership_type = 'guest' then
    raise exception 'external guests cannot receive active organization roles'
      using errcode = '23514';
  end if;
  if v_membership_type = 'contractor' and (
    v_membership_access_expires_at is null
    or new.expires_at is null
    or new.expires_at > v_membership_access_expires_at
  ) then
    raise exception 'contractor role assignment exceeds membership access'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists organization_role_assignments_06_validate_target_access
on public.organization_role_assignments;
create trigger organization_role_assignments_06_validate_target_access
before insert or update on public.organization_role_assignments
for each row execute function private.validate_active_role_assignment_access();

revoke all on function private.validate_active_role_assignment_access()
from public, anon, authenticated, service_role;

comment on function private.validate_active_role_assignment_access() is
  'Trigger-only guard: active organization roles require current non-guest access and contractor assignments cannot outlive membership access.';

commit;
