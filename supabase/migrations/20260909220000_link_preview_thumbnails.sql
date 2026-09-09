-- Backlog 56: the thumbnail a page offers is drawn, without the phone ever
-- reaching the site to get it.
--
-- The gateway already fetches the page once per address and keeps what it said.
-- It now fetches the thumbnail on the same terms - https only, never a private
-- address, every redirect re-checked, a timeout, a size cap, and the type taken
-- from what arrived rather than what was claimed - and keeps the bytes in a
-- private bucket. The reader is served a short-lived signed link to our own
-- copy, so the site learns nothing about who was sent the link.

alter table private.link_previews
  add column if not exists image_path text
    constraint link_previews_image_path_length
      check (image_path is null or char_length(image_path) between 8 and 400);

comment on column private.link_previews.image_path is
  'Our own copy of the page thumbnail, in the link-preview-images bucket.';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'link-preview-images', 'link-preview-images', false, 1500000,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = 1500000,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- The bucket is private and carries no policy of its own, so nothing but the
-- service role reaches it and readers are served signed links. Deliberately no
-- grant here: storage.objects is shared with avatars and attachments, and this
-- bucket has no business changing what they allow.

CREATE OR REPLACE FUNCTION private.bff_link_preview_lookup_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_url_sha256 text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_preview jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'message.link_preview.read', false, 0
  );
  if p_url_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'link preview key must be a sha256 digest' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'url', preview.url,
    'title', preview.title,
    'site_name', preview.site_name,
    'image_url', preview.image_url,
    'image_path', preview.image_path,
    'status', preview.status,
    'fetched_at', preview.fetched_at,
    'cached', true
  )
  into v_preview
  from private.link_previews preview
  where preview.url_sha256 = p_url_sha256
    and preview.fetched_at > now() - interval '14 days';

  if v_preview is not null then
    return v_preview;
  end if;

  if not private.consume_rate_limit(
    'link-preview-minute', p_organization_id::text || ':' || p_actor_user_id::text, 60, 60
  ) then
    raise exception 'link preview rate limit exceeded' using errcode = 'P0001';
  end if;
  return jsonb_build_object('cached', false);
end;
$function$;


CREATE OR REPLACE FUNCTION private.bff_link_preview_record_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_url_sha256 text, p_url text, p_title text, p_site_name text, p_image_url text, p_status text, p_image_path text default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_preview jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'message.link_preview.record', false, 0
  );
  if p_url_sha256 !~ '^[0-9a-f]{64}$' or p_status not in ('ready', 'unavailable') then
    raise exception 'link preview record is malformed' using errcode = '22023';
  end if;

  insert into private.link_previews as preview (
    url_sha256, url, title, site_name, image_url, image_path, status, fetched_at, updated_at
  )
  values (
    p_url_sha256, p_url, p_title, p_site_name, p_image_url, p_image_path, p_status, now(), now()
  )
  on conflict (url_sha256) do update
    set url = excluded.url,
        title = excluded.title,
        site_name = excluded.site_name,
        image_url = excluded.image_url,
        image_path = excluded.image_path,
        status = excluded.status,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
  returning jsonb_build_object(
    'url', preview.url,
    'title', preview.title,
    'site_name', preview.site_name,
    'image_url', preview.image_url,
    'image_path', preview.image_path,
    'status', preview.status,
    'fetched_at', preview.fetched_at,
    'cached', false
  ) into v_preview;
  return v_preview;
end;
$function$
;
