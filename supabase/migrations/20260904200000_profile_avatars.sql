-- Profile pictures (owner backlog v2, Sep 4 2026). A user uploads a square
-- image to the private `profile-avatars` bucket through a signed upload URL
-- issued by the API, then activates it; `profiles.avatar_path` points at the
-- object and every co-member of the organization may read it through a short
-- signed download URL. Consumer realm: no scan step, same as attachments.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create table if not exists public.profile_avatar_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (user_id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  byte_size bigint not null check (byte_size between 1 and 5242880),
  sha256_hex text not null check (sha256_hex ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'active', 'replaced', 'removed')),
  created_at timestamptz not null default now(),
  activated_at timestamptz
);
create index if not exists profile_avatar_uploads_user_idx on public.profile_avatar_uploads (organization_id, user_id, created_at desc);
alter table public.profile_avatar_uploads enable row level security;
revoke all on public.profile_avatar_uploads from public, anon, authenticated;

create or replace function private.bff_create_profile_avatar_upload_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256_hex text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_upload_id uuid := gen_random_uuid();
  v_storage_path text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'profile.avatar.upload.create', false, 0, '/v2/profile/avatar/grants',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if char_length(coalesce(p_file_name, '')) not between 1 and 255
    or p_file_name ~ '[/\\]'
    or p_mime_type is null
    or lower(p_mime_type) not in ('image/jpeg', 'image/png', 'image/webp')
    or p_byte_size not between 1 and 5242880
    or coalesce(p_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid profile avatar upload metadata' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'profile-avatar-upload-minute', p_organization_id::text || ':' || p_actor_user_id::text, 5, 60
  ) then
    raise exception 'profile avatar upload rate limit exceeded' using errcode = 'P0001';
  end if;
  v_storage_path := p_organization_id::text || '/' || p_actor_user_id::text || '/' || v_upload_id::text || '/avatar';
  insert into public.profile_avatar_uploads (
    id, organization_id, user_id, storage_path, file_name, mime_type, byte_size, sha256_hex
  ) values (
    v_upload_id, p_organization_id, p_actor_user_id, v_storage_path, p_file_name,
    lower(p_mime_type), p_byte_size, p_sha256_hex
  );
  v_response := jsonb_build_object(
    'upload_id', v_upload_id,
    'bucket_id', 'profile-avatars',
    'storage_path', v_storage_path,
    'maximum_byte_size', 5242880
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/profile/avatar/grants',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_activate_profile_avatar_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_upload_id uuid, p_expected_avatar_path text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_upload public.profile_avatar_uploads%rowtype;
  v_profile public.profiles%rowtype;
  v_object_size bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'profile.avatar.activate', false, 0, '/v2/profile/avatar/:uploadId/activate',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select profile.* into v_profile from public.profiles profile where profile.user_id = p_actor_user_id for update;
  if not found then
    raise exception 'profile required' using errcode = '42501';
  end if;
  if v_profile.avatar_path is distinct from p_expected_avatar_path then
    raise exception 'profile avatar version conflict' using errcode = '40001';
  end if;
  select upload.* into v_upload
  from public.profile_avatar_uploads upload
  where upload.id = p_upload_id
    and upload.organization_id = p_organization_id
    and upload.user_id = p_actor_user_id
    and upload.status = 'pending'
  for update;
  if not found then
    raise exception 'pending actor-owned profile avatar upload required' using errcode = '42501';
  end if;
  -- The object must exist in the bucket with the declared size; the storage
  -- service records size and mime type in the object's metadata.
  select nullif(object.metadata ->> 'size', '')::bigint into v_object_size
  from storage.objects object
  where object.bucket_id = 'profile-avatars' and object.name = v_upload.storage_path;
  if v_object_size is null or v_object_size <> v_upload.byte_size then
    raise exception 'profile avatar object not uploaded' using errcode = '42501';
  end if;
  update public.profile_avatar_uploads upload
  set status = 'replaced'
  where upload.organization_id = p_organization_id and upload.user_id = p_actor_user_id
    and upload.status = 'active' and upload.id <> p_upload_id;
  update public.profile_avatar_uploads upload
  set status = 'active', activated_at = now()
  where upload.id = p_upload_id;
  update public.profiles profile
  set avatar_path = v_upload.storage_path
  where profile.user_id = p_actor_user_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'profile.avatar.changed', 'profile', p_actor_user_id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'upload_id', p_upload_id,
      'previous_avatar_path', v_profile.avatar_path,
      'avatar_path', v_upload.storage_path
    ))
  );
  v_response := jsonb_build_object(
    'user_id', p_actor_user_id,
    'upload_id', p_upload_id,
    'avatar_path', v_upload.storage_path,
    'previous_avatar_path', v_profile.avatar_path,
    'activated', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/profile/avatar/:uploadId/activate',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_remove_profile_avatar_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_expected_avatar_path text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_profile public.profiles%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'profile.avatar.remove', false, 0, '/v2/profile/avatar',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select profile.* into v_profile from public.profiles profile where profile.user_id = p_actor_user_id for update;
  if not found or v_profile.avatar_path is null then
    raise exception 'profile avatar required' using errcode = '42501';
  end if;
  if v_profile.avatar_path is distinct from p_expected_avatar_path then
    raise exception 'profile avatar version conflict' using errcode = '40001';
  end if;
  update public.profile_avatar_uploads upload
  set status = 'removed'
  where upload.user_id = p_actor_user_id and upload.status = 'active';
  update public.profiles profile set avatar_path = null where profile.user_id = p_actor_user_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'profile.avatar.removed', 'profile', p_actor_user_id::text,
    jsonb_build_object('previous_avatar_path', v_profile.avatar_path)
  );
  v_response := jsonb_build_object(
    'user_id', p_actor_user_id,
    'previous_avatar_path', v_profile.avatar_path,
    'avatar_path', null,
    'removed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/profile/avatar',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_authorize_profile_avatar_download_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_target_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'profile.avatar.download.authorize', false, 0
  );
  -- Anyone who shares the organization (the whole consumer realm) may see a
  -- member's picture, the same audience that sees display names in search.
  select jsonb_build_object(
    'authorized', true,
    'user_id', profile.user_id,
    'bucket_id', 'profile-avatars',
    'storage_path', profile.avatar_path,
    'mime_type', upload.mime_type,
    'byte_size', upload.byte_size
  ) into v_result
  from public.profiles profile
  join public.profile_avatar_uploads upload
    on upload.user_id = profile.user_id and upload.storage_path = profile.avatar_path and upload.status = 'active'
  where profile.user_id = p_target_user_id
    and profile.avatar_path is not null
    and (p_target_user_id = p_actor_user_id or (
      exists (select 1 from public.organization_memberships m where m.organization_id = p_organization_id and m.user_id = p_actor_user_id and m.status = 'active')
      and exists (select 1 from public.organization_memberships m where m.organization_id = p_organization_id and m.user_id = p_target_user_id and m.status = 'active')
    ));
  if not found then return jsonb_build_object('authorized', false); end if;
  return v_result;
end;
$$;

create or replace function public.bff_create_profile_avatar_upload(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_file_name text, p_mime_type text, p_byte_size bigint, p_sha256_hex text,
  p_idempotency_key text, p_request_sha256 text
) returns jsonb language sql set search_path = '' as $$
  select private.bff_create_profile_avatar_upload_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_file_name, p_mime_type, p_byte_size, p_sha256_hex,
    p_idempotency_key, p_request_sha256
  )
$$;
create or replace function public.bff_activate_profile_avatar(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_upload_id uuid, p_expected_avatar_path text, p_idempotency_key text, p_request_sha256 text
) returns jsonb language sql set search_path = '' as $$
  select private.bff_activate_profile_avatar_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_upload_id, p_expected_avatar_path,
    p_idempotency_key, p_request_sha256
  )
$$;
create or replace function public.bff_remove_profile_avatar(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_expected_avatar_path text, p_idempotency_key text, p_request_sha256 text
) returns jsonb language sql set search_path = '' as $$
  select private.bff_remove_profile_avatar_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_expected_avatar_path, p_idempotency_key, p_request_sha256
  )
$$;
create or replace function public.bff_authorize_profile_avatar_download(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_target_user_id uuid
) returns jsonb language sql stable set search_path = '' as $$
  select private.bff_authorize_profile_avatar_download_impl(p_actor_user_id, p_organization_id, p_session_id, p_target_user_id)
$$;

do $$
declare
  v_fn text;
begin
  foreach v_fn in array array[
    'private.bff_create_profile_avatar_upload_impl(uuid, uuid, uuid, text, text, bigint, text, text, text)',
    'private.bff_activate_profile_avatar_impl(uuid, uuid, uuid, uuid, text, text, text)',
    'private.bff_remove_profile_avatar_impl(uuid, uuid, uuid, text, text, text)',
    'private.bff_authorize_profile_avatar_download_impl(uuid, uuid, uuid, uuid)',
    'public.bff_create_profile_avatar_upload(uuid, uuid, uuid, text, text, bigint, text, text, text)',
    'public.bff_activate_profile_avatar(uuid, uuid, uuid, uuid, text, text, text)',
    'public.bff_remove_profile_avatar(uuid, uuid, uuid, text, text, text)',
    'public.bff_authorize_profile_avatar_download(uuid, uuid, uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_fn);
    execute format('grant execute on function %s to service_role', v_fn);
  end loop;
end;
$$;
