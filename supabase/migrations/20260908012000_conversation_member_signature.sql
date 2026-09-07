-- An order-independent signature of a conversation's live membership, kept up
-- to date as people join and leave. It is what answers "is there already a
-- group with exactly these people?" without scanning memberships.
--
-- The signature lives in its own private table rather than in a column on
-- public.conversations: every update of that table writes an audit event and
-- passes the conversation update guards, and a membership change is not a
-- change to the conversation itself.
create table if not exists private.conversation_member_signatures (
  organization_id uuid not null,
  conversation_id uuid not null,
  members_signature text not null,
  member_count integer not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, conversation_id),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade
);

alter table private.conversation_member_signatures enable row level security;
alter table private.conversation_member_signatures force row level security;

create index if not exists conversation_member_signatures_lookup_idx
  on private.conversation_member_signatures (organization_id, members_signature);

-- Order-independent by construction: the ids are de-duplicated and sorted
-- before they are hashed, so any two orderings of the same people agree.
create or replace function private.member_set_signature_internal(p_user_ids uuid[])
returns text
language sql
immutable
set search_path = ''
as $function$
  select md5(coalesce(string_agg(distinct member_id::text, ',' order by member_id::text), ''))
  from unnest(coalesce(p_user_ids, array[]::uuid[])) as member_id;
$function$;

create or replace function private.conversation_member_signature_internal(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $function$
  select private.member_set_signature_internal(
    coalesce(array_agg(member.user_id), array[]::uuid[])
  )
  from public.conversation_members member
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.status = 'active';
$function$;

create or replace function private.refresh_conversation_member_signature()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_organization_id uuid;
  v_conversation_id uuid;
  v_result record;
begin
  if tg_op = 'DELETE' then
    v_organization_id := old.organization_id;
    v_conversation_id := old.conversation_id;
  else
    v_organization_id := new.organization_id;
    v_conversation_id := new.conversation_id;
  end if;

  -- A membership row removed with its conversation has nothing to sign.
  if not exists (
    select 1 from public.conversations conversation
    where conversation.organization_id = v_organization_id
      and conversation.id = v_conversation_id
  ) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select private.member_set_signature_internal(
      coalesce(array_agg(member.user_id), array[]::uuid[])
    ) as members_signature,
    count(*)::integer as member_count
  into v_result
  from public.conversation_members member
  where member.organization_id = v_organization_id
    and member.conversation_id = v_conversation_id
    and member.status = 'active';

  insert into private.conversation_member_signatures (
    organization_id, conversation_id, members_signature, member_count, updated_at
  ) values (
    v_organization_id, v_conversation_id,
    v_result.members_signature, v_result.member_count, now()
  )
  on conflict (organization_id, conversation_id) do update
    set members_signature = excluded.members_signature,
      member_count = excluded.member_count,
      updated_at = excluded.updated_at;

  return case when tg_op = 'DELETE' then old else new end;
end;
$function$;

drop trigger if exists conversation_members_85_refresh_signature
  on public.conversation_members;
create trigger conversation_members_85_refresh_signature
after insert or delete or update of status on public.conversation_members
for each row execute function private.refresh_conversation_member_signature();

-- The one group whose live members are exactly this set and that the actor is
-- still in. A group the actor left has a different set, so it never matches.
create or replace function private.existing_group_with_member_set_internal(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_member_user_ids uuid[]
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select conversation.id
  from private.conversation_member_signatures signature
  join public.conversations conversation
    on conversation.organization_id = signature.organization_id
   and conversation.id = signature.conversation_id
  join public.conversation_members member
    on member.organization_id = conversation.organization_id
   and member.conversation_id = conversation.id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  where signature.organization_id = p_organization_id
    and signature.members_signature
      = private.member_set_signature_internal(p_member_user_ids)
    and conversation.kind = 'group'
  order by conversation.created_at, conversation.id
  limit 1;
$function$;

insert into private.conversation_member_signatures (
  organization_id, conversation_id, members_signature, member_count
)
select member.organization_id, member.conversation_id,
  private.member_set_signature_internal(array_agg(member.user_id)),
  count(*)::integer
from public.conversation_members member
join public.conversations conversation
  on conversation.organization_id = member.organization_id
 and conversation.id = member.conversation_id
where member.status = 'active'
group by member.organization_id, member.conversation_id
on conflict (organization_id, conversation_id) do update
  set members_signature = excluded.members_signature,
    member_count = excluded.member_count,
    updated_at = now();

revoke all on private.conversation_member_signatures from anon, authenticated;
revoke all on function private.member_set_signature_internal(uuid[]) from anon, authenticated;
revoke all on function private.conversation_member_signature_internal(uuid, uuid)
  from anon, authenticated;
revoke all on function private.refresh_conversation_member_signature() from anon, authenticated;
revoke all on function private.existing_group_with_member_set_internal(uuid, uuid, uuid[])
  from anon, authenticated;
