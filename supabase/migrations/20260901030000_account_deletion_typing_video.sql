-- Consumer pivot slice 3: account deletion (App Store 5.1.1(v)), typing
-- indicator channel authorization, and video attachments.
--
-- Deletion is a tombstone, never a hard delete: the profile is anonymized,
-- the released username is quarantined against re-registration, every
-- membership is deactivated through the canonical status machinery (so the
-- existing side-effect trigger revokes push installations and queues session
-- and realtime revocation), and push registrations are removed. Message
-- history and the personal-realm organization row stay untouched. The Edge
-- gateway then soft-deletes the Auth user (auth.users.deleted_at), which the
-- signup authorizer and the token lifecycle hook already fail closed on.

begin;

-- ---------------------------------------------------------------------------
-- 1. Account deletion.
-- ---------------------------------------------------------------------------

-- Full recreate of the canonical membership-update validator. The only change
-- is the narrow account-deletion arm of the actor ladder: under the dedicated
-- trusted service context (settable only by SECURITY DEFINER service
-- functions, exactly like app.bff_service_context), the departing member's
-- own memberships may transition to 'deactivated' and nothing else. Every
-- other rule -- immutable identity fields, the trusted-BFF requirement for
-- security state, the reason requirement, admin/owner authority, and the
-- final-active-owner invariant -- is preserved verbatim, so deleting the sole
-- active owner of a workspace organization still fails until ownership is
-- transferred.
create or replace function private.validate_membership_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_actor_role text;
begin
  if new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.joined_at is distinct from old.joined_at then
    raise exception 'membership identity fields are immutable' using errcode = '22000';
  end if;

  if new.status = 'deactivated' and old.status <> 'deactivated' then
    new.deactivated_at := coalesce(new.deactivated_at, now());
  elsif new.status <> 'deactivated' then
    new.deactivated_at := null;
  end if;

  if new.revocation_generation is distinct from old.revocation_generation
    or new.security_changed_at is distinct from old.security_changed_at
    or new.security_changed_by_user_id is distinct from old.security_changed_by_user_id
    or new.status_change_reason is distinct from old.status_change_reason then
    if current_setting('app.bff_service_context', true) <> 'on'
      or v_actor_id is null then
      raise exception 'membership security state requires the trusted BFF workflow' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    if current_setting('app.bff_service_context', true) <> 'on' then
      raise exception 'membership status changes require the trusted BFF workflow' using errcode = '42501';
    end if;
    if char_length(btrim(coalesce(new.status_change_reason, ''))) not between 3 and 500 then
      raise exception 'membership status change reason is required' using errcode = '22023';
    end if;
    new.revocation_generation := old.revocation_generation + 1;
    new.security_changed_at := now();
    new.security_changed_by_user_id := v_actor_id;
  elsif new.revocation_generation is distinct from old.revocation_generation
    or new.security_changed_at is distinct from old.security_changed_at
    or new.security_changed_by_user_id is distinct from old.security_changed_by_user_id
    or new.status_change_reason is distinct from old.status_change_reason then
    raise exception 'membership security state changes only with status' using errcode = '22000';
  end if;

  if v_actor_id is null and v_jwt_role = 'service_role' then
    -- Service workflows still cannot remove the final active owner below.
    null;
  elsif v_actor_id = old.user_id
    and coalesce(current_setting('app.account_deletion_context', true), 'off') = 'on' then
    -- Trusted account-deletion tombstone: only the deactivation itself is
    -- permitted; every other column must stay untouched.
    if new.status <> 'deactivated'
      or new.role is distinct from old.role
      or new.membership_type is distinct from old.membership_type
      or new.directory_visibility is distinct from old.directory_visibility
      or new.employee_code is distinct from old.employee_code
      or new.job_title is distinct from old.job_title
      or new.invited_by_user_id is distinct from old.invited_by_user_id
      or new.access_expires_at is distinct from old.access_expires_at
      or new.guest_sponsor_user_id is distinct from old.guest_sponsor_user_id then
      raise exception 'account deletion may only deactivate the membership' using errcode = '42501';
    end if;
  elsif v_actor_id = old.user_id then
    if new.role is distinct from old.role
      or new.status is distinct from old.status
      or new.employee_code is distinct from old.employee_code
      or new.job_title is distinct from old.job_title
      or new.invited_by_user_id is distinct from old.invited_by_user_id
      or new.joined_at is distinct from old.joined_at
      or new.deactivated_at is distinct from old.deactivated_at then
      raise exception 'members may only change their own directory visibility' using errcode = '42501';
    end if;
  else
    select membership.role into v_actor_role
    from public.organization_memberships membership
    where membership.organization_id = old.organization_id
      and membership.user_id = v_actor_id
      and membership.status = 'active';

    if v_actor_role = 'owner' then
      null;
    elsif v_actor_role = 'admin' then
      if new.role is distinct from old.role
        or old.role in ('owner', 'admin')
        or new.role in ('owner', 'admin') then
        raise exception 'only owners may change roles or manage owners and admins' using errcode = '42501';
      end if;
    else
      raise exception 'organization administrator permission required' using errcode = '42501';
    end if;
  end if;

  if old.role = 'owner' and old.status = 'active'
    and (new.role <> 'owner' or new.status <> 'active') then
    -- Serialize owner changes so two concurrent demotions cannot both observe
    -- another owner and leave the tenant ownerless.
    perform 1
    from public.organizations organization
    where organization.id = old.organization_id
    for update;

    if not exists (
      select 1
      from public.organization_memberships other_owner
      where other_owner.organization_id = old.organization_id
        and other_owner.user_id <> old.user_id
        and other_owner.role = 'owner'
        and other_owner.status = 'active'
    ) then
      raise exception 'an organization must retain at least one active owner' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.delete_account_impl(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_username text;
  v_memberships integer := 0;
begin
  perform private.require_service_role();
  if p_user_id is null then
    raise exception 'invalid account deletion request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users auth_user where auth_user.id = p_user_id
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- (a) Quarantine the released handle before releasing it, so no later
  -- signup can pass the reserved-name check and impersonate the deleted
  -- account. Then null the profile username through the same service context
  -- the signup redemption uses to satisfy the username guard trigger.
  select profile.username::text into v_username
  from public.profiles profile
  where profile.user_id = p_user_id;

  if v_username is not null then
    insert into private.reserved_usernames (username, reserved_reason)
    values (v_username::extensions.citext, 'post-deletion-quarantine')
    on conflict (username) do nothing;
  end if;

  -- (b) Tombstone the profile. Message history keeps rendering under the
  -- anonymized identity; nothing content-bearing is removed.
  perform set_config('app.bff_service_context', 'on', true);
  update public.profiles profile
  set username = null,
      display_name = 'Deleted account',
      avatar_path = null,
      status_message = null
  where profile.user_id = p_user_id;
  perform set_config('app.bff_service_context', 'off', true);

  -- (c) Deactivate every membership through the canonical status machinery.
  -- validate_membership_update demands the trusted BFF context, a status
  -- change reason, and a non-null acting principal; the dedicated
  -- account-deletion context authorizes the departing member as that
  -- principal. The status side-effect trigger then revokes push
  -- installations and enqueues session/realtime revocation per membership.
  perform set_config('app.bff_service_context', 'on', true);
  perform set_config('app.account_deletion_context', 'on', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text,
    true
  );
  update public.organization_memberships membership
  set status = 'deactivated',
      deactivated_at = now(),
      status_change_reason = 'Account deletion (self-service)'
  where membership.user_id = p_user_id
    and membership.status <> 'deactivated';
  get diagnostics v_memberships = row_count;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('app.account_deletion_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);

  -- (d) Remove push registrations outright: a deleted account must leave no
  -- routable push tokens behind (the side-effect trigger already revoked
  -- them inside this transaction).
  delete from public.device_registrations device
  where device.user_id = p_user_id;

  -- (e) The caller (trusted Edge gateway) soft-deletes the Auth user after
  -- this commits; auth.users.deleted_at then gates every authorizer and the
  -- token lifecycle hook.
  return jsonb_build_object(
    'user_id', p_user_id,
    'memberships_deactivated', v_memberships
  );
end;
$$;

revoke all on function private.delete_account_impl(uuid)
  from public, anon, authenticated;
grant execute on function private.delete_account_impl(uuid)
  to service_role;
comment on function private.delete_account_impl(uuid) is
  'Service-only account-deletion tombstone: quarantines the username, anonymizes the profile, deactivates every membership, and deletes push registrations in one transaction. Never removes message history.';

create or replace function public.bff_delete_account(p_user_id uuid)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.delete_account_impl(p_user_id)
$$;

revoke all on function public.bff_delete_account(uuid)
  from public, anon, authenticated;
grant execute on function public.bff_delete_account(uuid)
  to service_role;
comment on function public.bff_delete_account(uuid) is
  'Service-only account deletion (App Store 5.1.1(v)): tombstones the account in one transaction. The Edge gateway follows with the GoTrue admin soft delete.';

-- ---------------------------------------------------------------------------
-- 2. Typing indicator channel authorization.
-- ---------------------------------------------------------------------------

-- Same shape as private.realtime_topic_authorized, scoped to the
-- conversation-level typing topic. Membership is evaluated with the full
-- is_conversation_member predicate (current session, active tenant and
-- conversation membership, dynamic-group eligibility), so revocation cuts
-- typing traffic exactly when it cuts message access.
create or replace function private.realtime_typing_topic_authorized(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_match text[];
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  begin
    v_match := regexp_match(
      p_topic,
      '^org:([0-9a-fA-F-]{36}):conversation:([0-9a-fA-F-]{36}):typing$'
    );
    if v_match is null then
      return false;
    end if;
    return private.is_conversation_member(v_match[1]::uuid, v_match[2]::uuid);
  exception when invalid_text_representation then
    return false;
  end;
end;
$$;

revoke all on function private.realtime_typing_topic_authorized(text)
  from public, anon, authenticated, service_role;
-- Needed while Realtime RLS executes as `authenticated`; the private schema
-- is not in api.schemas, so it cannot be invoked as an RPC.
grant execute on function private.realtime_typing_topic_authorized(text)
  to authenticated;
comment on function private.realtime_typing_topic_authorized(text) is
  'Authorizes org:{org}:conversation:{conversation}:typing Realtime topics for current conversation members only.';

-- Typing indicators are ephemeral broadcast-only traffic: members of the
-- conversation may subscribe and publish; nothing is persisted and no
-- presence state is involved.
drop policy if exists newone_realtime_typing_receive on realtime.messages;
create policy newone_realtime_typing_receive
on realtime.messages for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select private.realtime_typing_topic_authorized((select realtime.topic())))
);

drop policy if exists newone_realtime_typing_broadcast on realtime.messages;
create policy newone_realtime_typing_broadcast
on realtime.messages for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and (select private.realtime_typing_topic_authorized((select realtime.topic())))
);

-- ---------------------------------------------------------------------------
-- 3. Video attachments.
-- ---------------------------------------------------------------------------

-- Videos join the attachment allowlist with their own 100 MiB cap; every
-- other type keeps the 25 MiB cap. The bucket-level limit is the coarse
-- storage backstop (Storage caps are global, not per-type); the exact
-- per-type discipline lives in the grant function and the row constraint,
-- and upload authorization already requires a matching pending grant row.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-attachments',
  'message-attachments',
  false,
  104857600,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/ogg',
    'video/mp4', 'video/quicktime'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.message_attachments
  drop constraint message_attachments_byte_size_range;
alter table public.message_attachments
  add constraint message_attachments_byte_size_range check (
    byte_size between 1 and case
      when mime_type in ('video/mp4', 'video/quicktime') then 104857600
      else 26214400
    end
  );

-- Full recreate of the pre-dynamic-group grant body (the current
-- bff_create_attachment_upload_impl wrapper adds the dynamic-group
-- eligibility gate and delegates here). Only the MIME allowlist and the
-- per-type byte cap change.
create or replace function private.bff_create_attachment_upload_pre_dynamic_group_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256_hex text,
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
  v_attachment_id uuid := gen_random_uuid();
  v_storage_path text;
  v_hour_bytes bigint;
  v_rate_key text;
  v_max_bytes bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.upload.create', false, 0, '/v2/attachments/grants',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_message_sender(p_organization_id, p_conversation_id, p_message_id) then
    raise exception 'attachment message sender permission required' using errcode = '42501';
  end if;
  if p_mime_type not in (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/ogg',
    'video/mp4', 'video/quicktime'
  ) then
    raise exception 'attachment MIME type is not permitted' using errcode = '22023';
  end if;
  v_max_bytes := case
    when p_mime_type in ('video/mp4', 'video/quicktime') then 104857600
    else 26214400
  end;
  if p_byte_size not between 1 and v_max_bytes
    or coalesce(p_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid attachment size or digest' using errcode = '22023';
  end if;
  v_rate_key := p_organization_id::text || ':' || p_actor_user_id::text;
  if not private.consume_rate_limit('upload-minute', v_rate_key, 10, 60) then
    raise exception 'attachment upload rate limit exceeded' using errcode = 'P0001';
  end if;
  select coalesce(sum(attachment.byte_size), 0) into v_hour_bytes
  from public.message_attachments attachment
  where attachment.organization_id = p_organization_id
    and attachment.created_by_user_id = p_actor_user_id
    and attachment.created_at >= now() - interval '1 hour';
  if v_hour_bytes + p_byte_size > 262144000 then
    raise exception 'attachment hourly byte quota exceeded' using errcode = 'P0001';
  end if;

  v_storage_path := p_organization_id::text || '/' || p_conversation_id::text || '/'
    || p_actor_user_id::text || '/' || v_attachment_id::text || '/upload';
  insert into public.message_attachments (
    id, organization_id, conversation_id, message_id, created_by_user_id,
    storage_path, file_name, mime_type, byte_size, sha256_hex
  ) values (
    v_attachment_id, p_organization_id, p_conversation_id, p_message_id,
    p_actor_user_id, v_storage_path, p_file_name, p_mime_type, p_byte_size,
    p_sha256_hex
  );
  v_response := jsonb_build_object(
    'attachment_id', v_attachment_id,
    'bucket_id', 'message-attachments',
    'storage_path', v_storage_path,
    'scan_status', 'pending'
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/attachments/grants',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

-- Full recreate of the scan-completion validator: the detected-MIME
-- allowlist gains the two video types so a clean video scan is no longer
-- forced into quarantine as a disallowed detected type.
create or replace function private.bff_complete_attachment_scan_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_attachment_id uuid,
  p_scan_result text,
  p_detected_mime_type text,
  p_policy_code text,
  p_scanner_name text,
  p_scanner_version text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_storage_path text;
  v_declared_mime_type text;
  v_detected_allowed boolean;
  v_requires_quarantine boolean;
  v_response jsonb;
begin
  perform private.require_service_role();
  if p_scan_result not in ('clean', 'quarantined')
    or char_length(coalesce(p_detected_mime_type, '')) not between 3 and 160
    or (p_policy_code is not null and char_length(p_policy_code) not between 1 and 120)
    or char_length(coalesce(p_scanner_name, '')) not between 2 and 120
    or char_length(coalesce(p_scanner_version, '')) not between 1 and 120 then
    raise exception 'invalid attachment scan result' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'storage_scan'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
    and job.payload ->> 'attachment_id' = p_attachment_id::text
  for update;
  if not found then raise exception 'active attachment scan lease required' using errcode = '42501'; end if;
  v_declared_mime_type := lower(v_job.payload ->> 'declared_mime_type');
  v_detected_allowed := lower(p_detected_mime_type) = any(array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/ogg',
    'video/mp4', 'video/quicktime'
  ]::text[]);
  v_requires_quarantine := not v_detected_allowed
    or lower(p_detected_mime_type) is distinct from v_declared_mime_type;
  if (v_requires_quarantine and p_scan_result <> 'quarantined')
    or (v_requires_quarantine and p_policy_code is null)
    or (p_scan_result = 'clean' and p_policy_code is not null) then
    raise exception 'detected media policy requires quarantine' using errcode = '22023';
  end if;
  update public.message_attachments attachment
  set scan_status = p_scan_result,
      scan_completed_at = now(),
      scanner_name = p_scanner_name,
      scanner_version = p_scanner_version,
      scan_failure_code = null,
      detected_mime_type = lower(p_detected_mime_type),
      scan_policy_code = p_policy_code,
      purge_requested_at = case when p_scan_result = 'quarantined' then now() else null end
  where attachment.organization_id = v_job.organization_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'pending'
  returning attachment.storage_path into v_storage_path;
  if not found then raise exception 'pending attachment scan not found' using errcode = 'P0002'; end if;
  update private.outbox_jobs job
  set status = 'completed', claimed_by = null, claimed_until = null,
      completed_at = now(), updated_at = now()
  where job.id = p_job_id;
  if p_scan_result = 'quarantined' then
    perform private.enqueue_outbox_job_internal(
      v_job.organization_id, 'storage_purge',
      'attachment:' || p_attachment_id::text,
      jsonb_build_object(
        'attachment_id', p_attachment_id,
        'bucket_id', 'message-attachments',
        'storage_path', v_storage_path,
        'reason', 'scanner_quarantine'
      )
    );
  end if;
  v_response := jsonb_build_object(
    'attachment_id', p_attachment_id,
    'scan_status', p_scan_result,
    'detected_mime_type', lower(p_detected_mime_type),
    'policy_code', p_policy_code,
    'scan_completed', true,
    'purge_queued', p_scan_result = 'quarantined'
  );
  return v_response;
end;
$$;

commit;
