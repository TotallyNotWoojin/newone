-- MSG-04: protected message history, preservation holds, and safe forwarding.
-- Content history and hold metadata stay in the non-exposed private schema.

create table private.message_versions (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  version_number integer not null,
  body text not null,
  body_sha256 bytea not null,
  language_code text,
  recorded_by_user_id uuid,
  recorded_at timestamptz not null default now(),
  unique (organization_id, conversation_id, message_id, version_number),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, recorded_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint message_versions_version_positive check (version_number > 0),
  constraint message_versions_body_length check (char_length(body) between 1 and 20000),
  constraint message_versions_body_hash_length check (octet_length(body_sha256) = 32),
  constraint message_versions_language_length check (
    language_code is null or char_length(language_code) between 2 and 35
  )
);

create index message_versions_message_recorded_idx
on private.message_versions (
  organization_id, conversation_id, message_id, recorded_at desc, id desc
);

create table private.message_preservation_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  hold_type text not null,
  reason_code text not null,
  policy_reference_sha256 bytea not null,
  placed_by_user_id uuid not null,
  placed_at timestamptz not null default now(),
  released_by_user_id uuid,
  released_at timestamptz,
  release_reason_code text,
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, placed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, released_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint message_preservation_holds_type_allowed check (
    hold_type in ('legal', 'incident_preservation')
  ),
  constraint message_preservation_holds_reason_length check (
    char_length(reason_code) between 3 and 80
  ),
  constraint message_preservation_holds_reference_hash_length check (
    octet_length(policy_reference_sha256) = 32
  ),
  constraint message_preservation_holds_release_reason_length check (
    release_reason_code is null or char_length(release_reason_code) between 3 and 80
  ),
  constraint message_preservation_holds_release_consistent check (
    (released_at is null and released_by_user_id is null and release_reason_code is null)
    or (released_at is not null and released_by_user_id is not null and release_reason_code is not null)
  )
);

create unique index message_preservation_holds_one_active_type_idx
on private.message_preservation_holds (
  organization_id, conversation_id, message_id, hold_type
)
where released_at is null;

create index message_preservation_holds_active_lookup_idx
on private.message_preservation_holds (organization_id, conversation_id, message_id)
where released_at is null;

revoke all on table private.message_versions from public, anon, authenticated, service_role;
revoke all on sequence private.message_versions_id_seq from public, anon, authenticated, service_role;
revoke all on table private.message_preservation_holds from public, anon, authenticated, service_role;

alter table private.message_versions enable row level security;
alter table private.message_versions force row level security;
alter table private.message_preservation_holds enable row level security;
alter table private.message_preservation_holds force row level security;

create or replace function private.capture_message_version()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_version_number integer;
begin
  if tg_op = 'INSERT' then
    if new.body is null then return new; end if;
    v_version_number := 1;
  else
    if new.deleted_at is not null
      or new.body is null
      or new.body is not distinct from old.body then
      return new;
    end if;
    select coalesce(max(version.version_number), 0) + 1
      into v_version_number
    from private.message_versions version
    where version.organization_id = new.organization_id
      and version.conversation_id = new.conversation_id
      and version.message_id = new.id;
  end if;

  insert into private.message_versions (
    organization_id, conversation_id, message_id, version_number,
    body, body_sha256, language_code, recorded_by_user_id
  ) values (
    new.organization_id, new.conversation_id, new.id, v_version_number,
    new.body, extensions.digest(convert_to(new.body, 'UTF8'), 'sha256'),
    new.language_code, (select auth.uid())
  ) on conflict (organization_id, conversation_id, message_id, version_number) do nothing;
  return new;
end;
$$;

create or replace function private.block_message_version_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'message versions are immutable' using errcode = '22000';
end;
$$;

create or replace function private.validate_preservation_hold_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.message_id is distinct from old.message_id
    or new.hold_type is distinct from old.hold_type
    or new.reason_code is distinct from old.reason_code
    or new.policy_reference_sha256 is distinct from old.policy_reference_sha256
    or new.placed_by_user_id is distinct from old.placed_by_user_id
    or new.placed_at is distinct from old.placed_at then
    raise exception 'preservation hold identity is immutable' using errcode = '22000';
  end if;
  if old.released_at is not null then
    raise exception 'released preservation holds are immutable' using errcode = '22000';
  end if;
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
    or new.released_at is null
    or new.released_by_user_id is distinct from (select auth.uid())
    or new.release_reason_code is null then
    raise exception 'preservation hold release requires an authorized command' using errcode = '42501';
  end if;
  new.released_at := now();
  return new;
end;
$$;

create or replace function private.block_preservation_hold_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'preservation holds are immutable records' using errcode = '22000';
end;
$$;

create or replace function private.block_preserved_message_deletion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_message public.messages%rowtype;
begin
  if tg_op = 'DELETE' then v_message := old; else v_message := new; end if;
  if tg_op = 'UPDATE' and (old.deleted_at is not null or new.deleted_at is null) then
    return new;
  end if;
  if exists (
    select 1
    from private.message_preservation_holds hold
    where hold.organization_id = v_message.organization_id
      and hold.conversation_id = v_message.conversation_id
      and hold.message_id = v_message.id
      and hold.released_at is null
  ) then
    raise exception 'message deletion blocked by organization preservation policy'
      using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- Backfill the currently visible revision before enabling live capture.
insert into private.message_versions (
  organization_id, conversation_id, message_id, version_number,
  body, body_sha256, language_code, recorded_by_user_id, recorded_at
)
select message.organization_id, message.conversation_id, message.id, 1,
       message.body, extensions.digest(convert_to(message.body, 'UTF8'), 'sha256'),
       message.language_code, message.sender_user_id,
       coalesce(message.edited_at, message.created_at)
from public.messages message
where message.body is not null
on conflict (organization_id, conversation_id, message_id, version_number) do nothing;

create trigger messages_05_block_preserved_delete
before update of deleted_at or delete on public.messages
for each row execute function private.block_preserved_message_deletion();

create trigger messages_70_capture_version
after insert or update of body on public.messages
for each row execute function private.capture_message_version();

create trigger message_versions_10_immutable
before update or delete on private.message_versions
for each row execute function private.block_message_version_mutation();

create trigger message_versions_90_audit
after insert on private.message_versions
for each row execute function private.write_audit_event('message.version', 'id');

create trigger message_preservation_holds_10_validate_update
before update on private.message_preservation_holds
for each row execute function private.validate_preservation_hold_update();

create trigger message_preservation_holds_10_block_delete
before delete on private.message_preservation_holds
for each row execute function private.block_preservation_hold_delete();

create trigger message_preservation_holds_90_audit
after insert or update on private.message_preservation_holds
for each row execute function private.write_audit_event('message.preservation_hold', 'id');

insert into public.organization_role_permissions (role_name, permission)
values ('security_admin', 'message.preservation.manage')
on conflict (role_name, permission) do nothing;

create or replace function private.bff_place_message_preservation_hold_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_hold_type text,
  p_reason_code text,
  p_policy_reference_sha256 text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_hold_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.preservation.place', true, 900,
    '/v2/admin/messages/:id/preservation-holds',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  if not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'message.preservation.manage', null
    )
    or p_hold_type not in ('legal', 'incident_preservation')
    or char_length(coalesce(p_reason_code, '')) not between 3 and 80
    or coalesce(p_policy_reference_sha256, '') !~ '^[0-9a-f]{64}$'
    or not exists (
      select 1 from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.id = p_message_id
    ) then
    raise exception 'authorized preservation hold target and policy are required'
      using errcode = '42501';
  end if;

  insert into private.message_preservation_holds (
    organization_id, conversation_id, message_id, hold_type, reason_code,
    policy_reference_sha256, placed_by_user_id
  ) values (
    p_organization_id, p_conversation_id, p_message_id, p_hold_type, p_reason_code,
    decode(p_policy_reference_sha256, 'hex'), p_actor_user_id
  )
  on conflict (organization_id, conversation_id, message_id, hold_type)
    where released_at is null do nothing
  returning id into v_hold_id;

  if v_hold_id is null then
    select hold.id into v_hold_id
    from private.message_preservation_holds hold
    where hold.organization_id = p_organization_id
      and hold.conversation_id = p_conversation_id
      and hold.message_id = p_message_id
      and hold.hold_type = p_hold_type
      and hold.released_at is null;
  end if;

  v_response := jsonb_build_object(
    'hold_id', v_hold_id,
    'message_id', p_message_id,
    'hold_type', p_hold_type,
    'active', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/admin/messages/:id/preservation-holds',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_release_message_preservation_hold_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_hold_id uuid,
  p_release_reason_code text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_message_id bigint;
  v_released_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.preservation.release', true, 900,
    '/v2/admin/message-preservation-holds/:id/release',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  if not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'message.preservation.manage', null
    )
    or char_length(coalesce(p_release_reason_code, '')) not between 3 and 80 then
    raise exception 'authorized preservation release is required' using errcode = '42501';
  end if;

  update private.message_preservation_holds hold
  set released_by_user_id = p_actor_user_id,
      released_at = now(),
      release_reason_code = p_release_reason_code
  where hold.organization_id = p_organization_id
    and hold.id = p_hold_id
    and hold.released_at is null
  returning hold.message_id, hold.released_at into v_message_id, v_released_at;
  if not found then
    raise exception 'active preservation hold not found' using errcode = 'P0002';
  end if;

  v_response := jsonb_build_object(
    'hold_id', p_hold_id,
    'message_id', v_message_id,
    'active', false,
    'released_at', v_released_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/admin/message-preservation-holds/:id/release',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function public.bff_place_message_preservation_hold(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_hold_type text,
  p_reason_code text,
  p_policy_reference_sha256 text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_place_message_preservation_hold_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_hold_type, p_reason_code, p_policy_reference_sha256,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_release_message_preservation_hold(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_hold_id uuid,
  p_release_reason_code text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_release_message_preservation_hold_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_hold_id,
    p_release_reason_code, p_idempotency_key, p_request_sha256
  )
$$;

-- Forwarding is a fresh text message. It may only read content that is visible
-- to the actor now; attachments are denied until independent reauthorization
-- of every referenced object is implemented.
create or replace function private.bff_forward_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_source_conversation_id uuid,
  p_source_message_id bigint,
  p_target_conversation_id uuid,
  p_client_nonce uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_source public.messages%rowtype;
  v_target_message_id bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.forward', false, 0, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  select message.* into v_source
  from public.messages message
  join public.conversation_members source_member
    on source_member.organization_id = message.organization_id
   and source_member.conversation_id = message.conversation_id
   and source_member.user_id = p_actor_user_id
   and source_member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = message.organization_id
   and organization_member.user_id = p_actor_user_id
   and organization_member.status = 'active'
  where message.organization_id = p_organization_id
    and message.conversation_id = p_source_conversation_id
    and message.id = p_source_message_id
    and message.deleted_at is null
    and message.available_at <= now()
    and message.kind = 'text'
    and message.body is not null
    and (source_member.history_visible_from is null
      or message.created_at >= source_member.history_visible_from)
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = message.organization_id
        and visibility.conversation_id = message.conversation_id
        and visibility.message_id = message.id
        and visibility.user_id = p_actor_user_id
    )
    and not exists (
      select 1 from public.message_attachments attachment
      where attachment.organization_id = message.organization_id
        and attachment.conversation_id = message.conversation_id
        and attachment.message_id = message.id
    );
  if not found then
    raise exception 'readable forwardable text message not found' using errcode = '42501';
  end if;

  v_target_message_id := private.send_message(
    p_organization_id, p_target_conversation_id, p_client_nonce, 'text',
    v_source.body, v_source.language_code, null, null, '{}'::jsonb
  );
  insert into public.message_forward_provenance (
    organization_id, target_conversation_id, target_message_id,
    source_conversation_id, source_message_id, forwarded_by_user_id
  ) values (
    p_organization_id, p_target_conversation_id, v_target_message_id,
    p_source_conversation_id, p_source_message_id, p_actor_user_id
  ) on conflict (organization_id, target_conversation_id, target_message_id) do nothing;
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'push',
    'message:' || p_organization_id::text || ':' || p_target_conversation_id::text || ':' || v_target_message_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', p_target_conversation_id,
      'message_id', v_target_message_id
    )
  );
  v_response := jsonb_build_object(
    'message_id', v_target_message_id,
    'client_nonce', p_client_nonce,
    'forwarded', true,
    'source', jsonb_build_object(
      'conversation_id', p_source_conversation_id,
      'message_id', p_source_message_id
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

revoke all on function private.capture_message_version() from public, anon, authenticated, service_role;
revoke all on function private.block_message_version_mutation() from public, anon, authenticated, service_role;
revoke all on function private.validate_preservation_hold_update() from public, anon, authenticated, service_role;
revoke all on function private.block_preservation_hold_delete() from public, anon, authenticated, service_role;
revoke all on function private.block_preserved_message_deletion() from public, anon, authenticated, service_role;
revoke all on function private.bff_place_message_preservation_hold_impl(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function private.bff_release_message_preservation_hold_impl(uuid,uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated;
revoke all on function public.bff_place_message_preservation_hold(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text)
  from public, anon, authenticated;
revoke all on function public.bff_release_message_preservation_hold(uuid,uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated;

grant execute on function private.bff_place_message_preservation_hold_impl(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text)
  to service_role;
grant execute on function private.bff_release_message_preservation_hold_impl(uuid,uuid,uuid,uuid,text,text,text)
  to service_role;
grant execute on function public.bff_place_message_preservation_hold(uuid,uuid,uuid,uuid,bigint,text,text,text,text,text)
  to service_role;
grant execute on function public.bff_release_message_preservation_hold(uuid,uuid,uuid,uuid,text,text,text)
  to service_role;

comment on table private.message_versions is
  'Append-only protected message plaintext revisions. Not exposed through the Data API.';
comment on table private.message_preservation_holds is
  'Organization-scoped legal and incident preservation policy records; references are hashed.';
