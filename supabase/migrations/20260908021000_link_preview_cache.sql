-- Backlog 47(g): a message holding a link shows what the page calls itself.
--
-- The phones never fetch the page. The gateway fetches it once per address and
-- keeps the answer here for a fortnight, so a link shared into a group of ten
-- costs one request from us rather than ten from ten phones — and nobody's
-- address or browser ever reaches the site they were sent a link to.
--
-- The cache is keyed by the sha256 of the normalized address, so nothing is
-- ever indexed on raw member-supplied text, and it is private: only the service
-- role reaches it, through the two functions below.

create table if not exists private.link_previews (
  url_sha256 text primary key
    constraint link_previews_key_sha256 check (url_sha256 ~ '^[0-9a-f]{64}$'),
  url text not null
    constraint link_previews_url_length check (char_length(url) between 8 and 2048),
  title text
    constraint link_previews_title_length check (title is null or char_length(title) <= 200),
  site_name text
    constraint link_previews_site_length check (site_name is null or char_length(site_name) <= 80),
  image_url text
    constraint link_previews_image_length check (image_url is null or char_length(image_url) <= 2048),
  status text not null
    constraint link_previews_status_allowed check (status in ('ready', 'unavailable')),
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table private.link_previews is
  'What a shared link says about itself, fetched once by the gateway and kept for fourteen days.';

revoke all on table private.link_previews from public, anon, authenticated;

create index if not exists link_previews_fetched_at_idx
  on private.link_previews (fetched_at);

-- Reading is also where the fetch is paced: a member gets sixty misses a
-- minute, far more than a person can share and far less than a script could use
-- us as a way to reach the rest of the internet with.
create or replace function private.bff_link_preview_lookup_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_url_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
$$;

create or replace function private.bff_link_preview_record_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_url_sha256 text,
  p_url text,
  p_title text,
  p_site_name text,
  p_image_url text,
  p_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
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
    url_sha256, url, title, site_name, image_url, status, fetched_at, updated_at
  )
  values (
    p_url_sha256, p_url, p_title, p_site_name, p_image_url, p_status, now(), now()
  )
  on conflict (url_sha256) do update
    set url = excluded.url,
        title = excluded.title,
        site_name = excluded.site_name,
        image_url = excluded.image_url,
        status = excluded.status,
        fetched_at = excluded.fetched_at,
        updated_at = excluded.updated_at
  returning jsonb_build_object(
    'url', preview.url,
    'title', preview.title,
    'site_name', preview.site_name,
    'image_url', preview.image_url,
    'status', preview.status,
    'fetched_at', preview.fetched_at,
    'cached', false
  ) into v_preview;
  return v_preview;
end;
$$;

create or replace function public.bff_link_preview_lookup(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_url_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_link_preview_lookup_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_url_sha256
  )
$$;

create or replace function public.bff_link_preview_record(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_url_sha256 text,
  p_url text,
  p_title text,
  p_site_name text,
  p_image_url text,
  p_status text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_link_preview_record_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_url_sha256, p_url, p_title, p_site_name, p_image_url, p_status
  )
$$;

revoke all on function private.bff_link_preview_lookup_impl(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function private.bff_link_preview_lookup_impl(uuid, uuid, uuid, text) to service_role;
revoke all on function private.bff_link_preview_record_impl(uuid, uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function private.bff_link_preview_record_impl(uuid, uuid, uuid, text, text, text, text, text, text)
  to service_role;
revoke all on function public.bff_link_preview_lookup(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.bff_link_preview_lookup(uuid, uuid, uuid, text) to service_role;
revoke all on function public.bff_link_preview_record(uuid, uuid, uuid, text, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.bff_link_preview_record(uuid, uuid, uuid, text, text, text, text, text, text)
  to service_role;

comment on function public.bff_link_preview_lookup(uuid, uuid, uuid, text) is
  'Returns a cached link preview, or {cached:false} after taking one off the caller''s fetch allowance.';
comment on function public.bff_link_preview_record(uuid, uuid, uuid, text, text, text, text, text, text) is
  'Stores what the gateway read from a shared page, replacing anything older.';
