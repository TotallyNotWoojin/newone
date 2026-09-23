-- Projects inside a chat (owner's father, Sep 23 2026). Each chat can hold
-- named projects ("1. HDG", "2. Maintenance"), and each project keeps three
-- drawers: the summaries saved into it, the files and photos people sent,
-- and the links people shared, so any of them can be taken out again later.
--
-- A project is a folder the reader selects while talking in the ordinary
-- room (owner's decision, Sep 23 2026), and everyone in the chat sees every
-- project. Selecting one is remembered per person on the server, so what a
-- person sends while it is selected is filed into it by the database itself:
-- the send, upload and summary paths are not touched, and the phone and the
-- browser agree on which project is current.
--
-- The filing triggers sit on the message, attachment and summary tables, the
-- busiest paths in the product. Each one looks up the sender's selection by
-- primary key first and returns at once without one, and does its filing
-- inside its own exception block: a fault here writes a warning and loses the
-- filing, never the message.
--
-- Also here: the reads for the drawers and for "find by keyword" (찾기), which
-- names the chats a word or a project came up in.

create table public.conversation_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  name text not null,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_projects_conversation_fkey
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete cascade,
  constraint conversation_projects_scope_unique unique (organization_id, conversation_id, id),
  constraint conversation_projects_name_shape
    check (char_length(name) between 1 and 60 and name = btrim(name))
);

create unique index conversation_projects_name_unique_idx
  on public.conversation_projects (organization_id, conversation_id, lower(name));

create table public.conversation_project_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  project_id uuid not null,
  kind text not null,
  summary_id uuid,
  attachment_id uuid,
  message_id bigint,
  url text,
  title text,
  added_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_project_items_project_fkey
    foreign key (organization_id, conversation_id, project_id)
    references public.conversation_projects (organization_id, conversation_id, id) on delete cascade,
  constraint conversation_project_items_summary_fkey
    foreign key (organization_id, conversation_id, summary_id)
    references public.conversation_summaries (organization_id, conversation_id, id) on delete cascade,
  constraint conversation_project_items_attachment_fkey
    foreign key (organization_id, attachment_id)
    references public.message_attachments (organization_id, id) on delete cascade,
  constraint conversation_project_items_message_fkey
    foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete cascade,
  constraint conversation_project_items_kind_allowed
    check (kind in ('summary', 'upload', 'link')),
  constraint conversation_project_items_shape check (
    (kind = 'summary' and summary_id is not null and attachment_id is null and url is null)
    or (kind = 'upload' and attachment_id is not null and summary_id is null and url is null)
    or (kind = 'link' and url is not null and message_id is not null
      and summary_id is null and attachment_id is null)
  ),
  constraint conversation_project_items_title_shape
    check (title is null or (char_length(title) between 1 and 120 and title = btrim(title))),
  constraint conversation_project_items_url_shape
    check (url is null or (char_length(url) between 10 and 2048 and url ~ '^https://'))
);

create unique index conversation_project_items_summary_unique_idx
  on public.conversation_project_items (project_id, summary_id) where summary_id is not null;
create unique index conversation_project_items_attachment_unique_idx
  on public.conversation_project_items (project_id, attachment_id) where attachment_id is not null;
create unique index conversation_project_items_url_unique_idx
  on public.conversation_project_items (project_id, url) where url is not null;
create index conversation_project_items_conversation_idx
  on public.conversation_project_items (organization_id, conversation_id, created_at desc, id desc);
create index conversation_project_items_summary_idx
  on public.conversation_project_items (summary_id) where summary_id is not null;

create table public.conversation_project_selections (
  organization_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  project_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, user_id),
  constraint conversation_project_selections_project_fkey
    foreign key (organization_id, conversation_id, project_id)
    references public.conversation_projects (organization_id, conversation_id, id) on delete cascade
);

create index conversation_project_selections_project_idx
  on public.conversation_project_selections (organization_id, conversation_id, project_id);

-- Only the service's own functions reach these rows; no client role reads or
-- writes them directly.
alter table public.conversation_projects enable row level security;
alter table public.conversation_projects force row level security;
alter table public.conversation_project_items enable row level security;
alter table public.conversation_project_items force row level security;
alter table public.conversation_project_selections enable row level security;
alter table public.conversation_project_selections force row level security;
revoke all on public.conversation_projects from public, anon, authenticated;
revoke all on public.conversation_project_items from public, anon, authenticated;
revoke all on public.conversation_project_selections from public, anon, authenticated;
grant select, insert, update, delete on public.conversation_projects to service_role;
grant select, insert, update, delete on public.conversation_project_items to service_role;
grant select, insert, update, delete on public.conversation_project_selections to service_role;

-- The addresses in a message, the way the app finds them for its link cards
-- (apps/newone/src/features/chat/link-preview.ts): split on whitespace, peel
-- the sentence's punctuation off, accept http(s), www. and a bare domain, and
-- store it as https with no fragment. A bare domain must end in a common
-- top-level domain, so "Mr.Kim" or "ok.thanks" never lands in the drawer.
-- At most ten per message.
create or replace function private.extract_message_links(p_body text)
returns table (url text, ordinal integer)
language plpgsql
immutable
set search_path = ''
as $function$
declare
  v_token text;
  v_candidate text;
  v_last text;
  v_authority text;
  v_host text;
  v_rest text;
  v_seen text[] := array[]::text[];
  v_count integer := 0;
begin
  if p_body is null or btrim(p_body) = '' then
    return;
  end if;
  foreach v_token in array regexp_split_to_array(btrim(p_body), '\s+') loop
    v_candidate := regexp_replace(v_token, '^[("''\[{<¡¿«]+', '');
    loop
      exit when v_candidate = '';
      v_last := right(v_candidate, 1);
      if v_last in ('.', ',', ';', ':', '!', '?', '"', '''', '…', '>', '»') then
        v_candidate := left(v_candidate, -1);
      elsif v_last = ')' and position('(' in left(v_candidate, -1)) = 0 then
        v_candidate := left(v_candidate, -1);
      elsif v_last = ']' and position('[' in left(v_candidate, -1)) = 0 then
        v_candidate := left(v_candidate, -1);
      elsif v_last = '}' and position('{' in left(v_candidate, -1)) = 0 then
        v_candidate := left(v_candidate, -1);
      else
        exit;
      end if;
    end loop;
    continue when v_candidate = '' or char_length(v_candidate) > 2000;
    if v_candidate ~* '^https?://' then
      null;
    elsif v_candidate ~* '^www\.[^./]' then
      v_candidate := 'https://' || v_candidate;
    elsif split_part(v_candidate, '/', 1) ~* (
      '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+(com|net|org|io|co|kr|mx|es|us|uk|ca|de|fr|jp|cn|in|au|br|ar|cl|pe|app|dev|ai|edu|gov|info|biz|me|tv|ly|gl|to|be|nl|it|ch|site|online|shop|store|page|link|xyz)$'
    ) then
      v_candidate := 'https://' || v_candidate;
    else
      continue;
    end if;
    v_candidate := regexp_replace(v_candidate, '^https?://', 'https://', 'i');
    v_candidate := split_part(v_candidate, '#', 1);
    v_authority := substring(v_candidate from '^https://([^/?#]*)');
    continue when v_authority is null or v_authority = '' or position('@' in v_authority) > 0;
    v_host := lower(split_part(v_authority, ':', 1));
    continue when position('.' in v_host) = 0
      or v_host = 'localhost'
      or v_host like '%.localhost'
      or v_host like '%.local'
      or v_host like '%.internal'
      or v_host like '%.home.arpa'
      or v_host ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
      or v_host !~ '^[a-z0-9.-]+$';
    v_rest := substring(v_candidate from char_length('https://' || v_authority) + 1);
    v_candidate := 'https://' || lower(v_authority) || case when v_rest = '' then '/' else v_rest end;
    continue when char_length(v_candidate) > 2048 or v_candidate = any (v_seen);
    v_seen := v_seen || v_candidate;
    v_count := v_count + 1;
    url := v_candidate;
    ordinal := v_count;
    return next;
    exit when v_count >= 10;
  end loop;
end;
$function$;

revoke all on function private.extract_message_links(text) from public, anon, authenticated;
grant execute on function private.extract_message_links(text) to service_role;

-- "Acid summary #1": the AI's own title for the recap, clipped to a file
-- name's length at a word, then numbered among the project's summaries that
-- carry the same name. The date is never part of the stored name; every
-- reader shows it after the name, so a rename cannot drop it.
create or replace function private.project_summary_title(
  p_project_id uuid,
  p_primary_topic text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_base text;
  v_next integer;
begin
  v_base := btrim(regexp_replace(coalesce(p_primary_topic, ''), '\s+', ' ', 'g'));
  v_base := btrim(v_base, ' .,;:-–—');
  if v_base = '' then
    v_base := 'Summary';
  end if;
  if char_length(v_base) > 60 then
    v_base := left(v_base, 60);
    if position(' ' in v_base) > 20 then
      v_base := regexp_replace(v_base, '\s+\S*$', '');
    end if;
    v_base := btrim(v_base, ' .,;:-–—');
  end if;
  select coalesce(max(substr(item.title, char_length(v_base) + 3)::integer), 0) + 1
    into v_next
  from public.conversation_project_items item
  where item.project_id = p_project_id
    and item.kind = 'summary'
    and item.title is not null
    and left(item.title, char_length(v_base) + 2) = v_base || ' #'
    and substr(item.title, char_length(v_base) + 3) ~ '^[0-9]{1,6}$';
  return v_base || ' #' || v_next::text;
end;
$function$;

revoke all on function private.project_summary_title(uuid, text) from public, anon, authenticated;

-- The reader's current project in a chat, if they have one and are still in
-- the chat.
create or replace function private.selected_conversation_project(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $function$
  select selection.project_id
  from public.conversation_project_selections selection
  join public.conversation_members member
    on member.organization_id = selection.organization_id
   and member.conversation_id = selection.conversation_id
   and member.user_id = selection.user_id
   and member.status = 'active'
  where selection.organization_id = p_organization_id
    and selection.conversation_id = p_conversation_id
    and selection.user_id = p_user_id
$function$;

revoke all on function private.selected_conversation_project(uuid, uuid, uuid) from public, anon, authenticated;

-- A file or photo sent while a project is selected goes into its uploads.
create or replace function private.file_attachment_into_selected_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project_id uuid;
begin
  if not exists (
    select 1 from public.conversation_project_selections selection
    where selection.organization_id = new.organization_id
      and selection.conversation_id = new.conversation_id
      and selection.user_id = new.created_by_user_id
  ) then
    return null;
  end if;
  begin
    v_project_id := private.selected_conversation_project(
      new.organization_id, new.conversation_id, new.created_by_user_id
    );
    if v_project_id is null or exists (
      select 1 from public.messages message
      where message.organization_id = new.organization_id
        and message.conversation_id = new.conversation_id
        and message.id = new.message_id
        and message.metadata ->> 'purpose' = 'conversation_avatar'
    ) then
      return null;
    end if;
    insert into public.conversation_project_items (
      organization_id, conversation_id, project_id, kind, attachment_id, message_id, added_by_user_id
    ) values (
      new.organization_id, new.conversation_id, v_project_id, 'upload', new.id, new.message_id,
      new.created_by_user_id
    )
    on conflict do nothing;
  exception when others then
    raise warning 'project filing skipped for attachment %: %', new.id, sqlerrm;
  end;
  return null;
end;
$function$;

revoke all on function private.file_attachment_into_selected_project() from public, anon, authenticated;

create trigger message_attachments_60_file_into_project
after insert on public.message_attachments
for each row execute function private.file_attachment_into_selected_project();

-- A link sent while a project is selected goes into its links.
create or replace function private.file_links_into_selected_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project_id uuid;
begin
  if new.kind = 'system' or new.body is null
    or new.body !~* '(://|www\.|[a-z0-9]\.[a-z]{2,})' then
    return null;
  end if;
  if not exists (
    select 1 from public.conversation_project_selections selection
    where selection.organization_id = new.organization_id
      and selection.conversation_id = new.conversation_id
      and selection.user_id = new.sender_user_id
  ) then
    return null;
  end if;
  begin
    v_project_id := private.selected_conversation_project(
      new.organization_id, new.conversation_id, new.sender_user_id
    );
    if v_project_id is null then
      return null;
    end if;
    insert into public.conversation_project_items (
      organization_id, conversation_id, project_id, kind, message_id, url, added_by_user_id
    )
    select new.organization_id, new.conversation_id, v_project_id, 'link', new.id, link.url,
      new.sender_user_id
    from private.extract_message_links(new.body) link
    order by link.ordinal
    on conflict do nothing;
  exception when others then
    raise warning 'project filing skipped for message %: %', new.id, sqlerrm;
  end;
  return null;
end;
$function$;

revoke all on function private.file_links_into_selected_project() from public, anon, authenticated;

create trigger messages_60_file_links_into_project
after insert on public.messages
for each row execute function private.file_links_into_selected_project();

-- A summary asked for while a project is selected is saved into its
-- summaries; it is named once the AI has written it.
create or replace function private.file_summary_into_selected_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project_id uuid;
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.conversation_project_selections selection
      where selection.organization_id = new.organization_id
        and selection.conversation_id = new.conversation_id
        and selection.user_id = new.requested_by_user_id
    ) then
      return null;
    end if;
    begin
      v_project_id := private.selected_conversation_project(
        new.organization_id, new.conversation_id, new.requested_by_user_id
      );
      if v_project_id is null then
        return null;
      end if;
      insert into public.conversation_project_items (
        organization_id, conversation_id, project_id, kind, summary_id, title, added_by_user_id
      ) values (
        new.organization_id, new.conversation_id, v_project_id, 'summary', new.id,
        case when new.status in ('draft', 'approved')
          then private.project_summary_title(v_project_id, new.primary_topic) end,
        new.requested_by_user_id
      )
      on conflict do nothing;
    exception when others then
      raise warning 'project filing skipped for summary %: %', new.id, sqlerrm;
    end;
    return null;
  end if;
  if new.status in ('draft', 'approved')
    and old.status is distinct from new.status
    and not (old.status in ('draft', 'approved')) then
    begin
      update public.conversation_project_items item
      set title = private.project_summary_title(item.project_id, new.primary_topic),
          updated_at = now()
      where item.summary_id = new.id
        and item.title is null;
    exception when others then
      raise warning 'project naming skipped for summary %: %', new.id, sqlerrm;
    end;
  end if;
  return null;
end;
$function$;

revoke all on function private.file_summary_into_selected_project() from public, anon, authenticated;

create trigger conversation_summaries_60_file_into_project
after insert or update of status on public.conversation_summaries
for each row execute function private.file_summary_into_selected_project();

-- Membership as every project call needs it: an active member of the chat,
-- inside an active organization membership, with conversation access.
create or replace function private.project_member_history_from(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid
)
returns table (found boolean, history_visible_from timestamptz)
language sql
stable
security definer
set search_path = ''
as $function$
  select true, member.history_visible_from
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.user_id = p_user_id
    and member.status = 'active'
    and private.dynamic_group_conversation_access_allowed_for_user(
      p_organization_id, p_conversation_id, p_user_id, now()
    )
$function$;

revoke all on function private.project_member_history_from(uuid, uuid, uuid) from public, anon, authenticated;

-- Whether a message is one this reader may see: the timeline's own rules.
create or replace function private.project_message_visible(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_user_id uuid,
  p_history_visible_from timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_message_id
      and message.deleted_at is null
      and message.available_at <= now()
      and (p_history_visible_from is null or message.created_at >= p_history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility hidden
        where hidden.organization_id = message.organization_id
          and hidden.conversation_id = message.conversation_id
          and hidden.message_id = message.id
          and hidden.user_id = p_user_id
      )
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and block.blocker_user_id = p_user_id
          and block.blocked_user_id = message.sender_user_id
      )
      and private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, p_conversation_id, message.id, p_user_id, now()
      )
  )
$function$;

revoke all on function private.project_message_visible(uuid, uuid, bigint, uuid, timestamptz) from public, anon, authenticated;

-- One command endpoint for every change to a chat's projects. Actions:
--   create       name                       (the creator's selection moves to it)
--   rename       project_id, name
--   delete       project_id                 (its drawers go with it; the files stay in the chat)
--   select       project_id or null
--   add_item     project_id, target {kind, summaryId | attachmentId | messageId + url}
--   rename_item  item_id, name
--   remove_item  item_id
-- Everyone in the chat may do all of it: the projects belong to the chat.
create or replace function private.bff_conversation_project_command_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_action text,
  p_project_id uuid,
  p_item_id uuid,
  p_name text,
  p_target jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_command jsonb;
  v_member_found boolean;
  v_history_visible_from timestamptz;
  v_name text;
  v_project_id uuid := p_project_id;
  v_item_id uuid := p_item_id;
  v_kind text;
  v_summary_id uuid;
  v_summary_status text;
  v_summary_topic text;
  v_attachment_id uuid;
  v_attachment_message_id bigint;
  v_message_id bigint;
  v_url text;
  v_selected uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'project.command', false, 0, '/v2/conversations/:id/projects/commands',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if coalesce(p_action, '') not in (
    'create', 'rename', 'delete', 'select', 'add_item', 'rename_item', 'remove_item'
  ) then
    raise exception 'invalid project command' using errcode = '22023';
  end if;
  select member.found, member.history_visible_from
    into v_member_found, v_history_visible_from
  from private.project_member_history_from(p_organization_id, p_conversation_id, p_actor_user_id) member;
  if coalesce(v_member_found, false) is false then
    raise exception 'active conversation membership required' using errcode = '42501';
  end if;
  v_name := nullif(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), '');

  if p_action in ('rename', 'delete', 'add_item')
    or (p_action = 'select' and p_project_id is not null) then
    if p_project_id is null or not exists (
      select 1 from public.conversation_projects project
      where project.organization_id = p_organization_id
        and project.conversation_id = p_conversation_id
        and project.id = p_project_id
    ) then
      raise exception 'project not found' using errcode = 'P0002';
    end if;
  end if;
  if p_action in ('rename_item', 'remove_item') then
    select item.project_id into v_project_id
    from public.conversation_project_items item
    where item.organization_id = p_organization_id
      and item.conversation_id = p_conversation_id
      and item.id = p_item_id;
    if v_project_id is null then
      raise exception 'project item not found' using errcode = 'P0002';
    end if;
  end if;

  if p_action = 'create' then
    if v_name is null or char_length(v_name) > 60 then
      raise exception 'invalid project name' using errcode = '22023';
    end if;
    if (
      select count(*) from public.conversation_projects project
      where project.organization_id = p_organization_id
        and project.conversation_id = p_conversation_id
    ) >= 50 then
      raise exception 'project limit reached' using errcode = '22023';
    end if;
    insert into public.conversation_projects (
      organization_id, conversation_id, name, created_by_user_id
    ) values (
      p_organization_id, p_conversation_id, v_name, p_actor_user_id
    )
    returning id into v_project_id;
    insert into public.conversation_project_selections (
      organization_id, conversation_id, user_id, project_id
    ) values (
      p_organization_id, p_conversation_id, p_actor_user_id, v_project_id
    )
    on conflict (organization_id, conversation_id, user_id) do update
      set project_id = excluded.project_id, updated_at = now();
  elsif p_action = 'rename' then
    if v_name is null or char_length(v_name) > 60 then
      raise exception 'invalid project name' using errcode = '22023';
    end if;
    update public.conversation_projects project
    set name = v_name, updated_at = now()
    where project.id = p_project_id;
  elsif p_action = 'delete' then
    delete from public.conversation_projects project
    where project.id = p_project_id;
    v_project_id := null;
  elsif p_action = 'select' then
    if p_project_id is null then
      delete from public.conversation_project_selections selection
      where selection.organization_id = p_organization_id
        and selection.conversation_id = p_conversation_id
        and selection.user_id = p_actor_user_id;
    else
      insert into public.conversation_project_selections (
        organization_id, conversation_id, user_id, project_id
      ) values (
        p_organization_id, p_conversation_id, p_actor_user_id, p_project_id
      )
      on conflict (organization_id, conversation_id, user_id) do update
        set project_id = excluded.project_id, updated_at = now();
    end if;
  elsif p_action = 'add_item' then
    v_kind := p_target ->> 'kind';
    if v_kind = 'summary' then
      -- A reader files their own recap; nobody else can see it to file it.
      select summary.id, summary.status, summary.primary_topic
        into v_summary_id, v_summary_status, v_summary_topic
      from public.conversation_summaries summary
      where summary.organization_id = p_organization_id
        and summary.conversation_id = p_conversation_id
        and summary.id = (p_target ->> 'summaryId')::uuid
        and summary.requested_by_user_id = p_actor_user_id
        and summary.status in ('queued', 'processing', 'draft', 'approved');
      if v_summary_id is null then
        raise exception 'summary not found' using errcode = 'P0002';
      end if;
      insert into public.conversation_project_items (
        organization_id, conversation_id, project_id, kind, summary_id, title, added_by_user_id
      ) values (
        p_organization_id, p_conversation_id, p_project_id, 'summary', v_summary_id,
        case when v_summary_status in ('draft', 'approved')
          then private.project_summary_title(p_project_id, v_summary_topic) end,
        p_actor_user_id
      )
      on conflict do nothing
      returning id into v_item_id;
    elsif v_kind = 'upload' then
      select file.id, file.message_id into v_attachment_id, v_attachment_message_id
      from public.message_attachments file
      where file.organization_id = p_organization_id
        and file.conversation_id = p_conversation_id
        and file.id = (p_target ->> 'attachmentId')::uuid
        and file.scan_status = 'clean'
        and file.purge_requested_at is null;
      if v_attachment_id is null or not private.project_message_visible(
        p_organization_id, p_conversation_id, v_attachment_message_id, p_actor_user_id,
        v_history_visible_from
      ) then
        raise exception 'attachment not found' using errcode = 'P0002';
      end if;
      insert into public.conversation_project_items (
        organization_id, conversation_id, project_id, kind, attachment_id, message_id, added_by_user_id
      ) values (
        p_organization_id, p_conversation_id, p_project_id, 'upload', v_attachment_id,
        v_attachment_message_id, p_actor_user_id
      )
      on conflict do nothing
      returning id into v_item_id;
    elsif v_kind = 'link' then
      if coalesce(p_target ->> 'messageId', '') !~ '^[1-9][0-9]{0,18}$' then
        raise exception 'invalid project item' using errcode = '22023';
      end if;
      v_message_id := (p_target ->> 'messageId')::bigint;
      if not private.project_message_visible(
        p_organization_id, p_conversation_id, v_message_id, p_actor_user_id, v_history_visible_from
      ) then
        raise exception 'message not found' using errcode = 'P0002';
      end if;
      -- Only an address the message really carries, as the drawer stores it.
      select link.url into v_url
      from public.messages message
      cross join lateral private.extract_message_links(message.body) link
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.id = v_message_id
        and (
          p_target ->> 'url' is null
          or link.url = (
            select normalized.url from private.extract_message_links(p_target ->> 'url') normalized
            order by normalized.ordinal limit 1
          )
        )
      order by link.ordinal
      limit 1;
      if v_url is null then
        raise exception 'link not found' using errcode = 'P0002';
      end if;
      insert into public.conversation_project_items (
        organization_id, conversation_id, project_id, kind, message_id, url, added_by_user_id
      ) values (
        p_organization_id, p_conversation_id, p_project_id, 'link', v_message_id, v_url,
        p_actor_user_id
      )
      on conflict do nothing
      returning id into v_item_id;
    else
      raise exception 'invalid project item' using errcode = '22023';
    end if;
    -- Already there: answer with the row that is.
    if v_item_id is null then
      select item.id into v_item_id
      from public.conversation_project_items item
      where item.project_id = p_project_id
        and (
          (v_kind = 'summary' and item.summary_id = v_summary_id)
          or (v_kind = 'upload' and item.attachment_id = v_attachment_id)
          or (v_kind = 'link' and item.url = v_url)
        );
    end if;
  elsif p_action = 'rename_item' then
    if v_name is null or char_length(v_name) > 120 then
      raise exception 'invalid project item name' using errcode = '22023';
    end if;
    update public.conversation_project_items item
    set title = v_name, updated_at = now()
    where item.id = p_item_id;
  elsif p_action = 'remove_item' then
    delete from public.conversation_project_items item
    where item.id = p_item_id;
  end if;

  select private.selected_conversation_project(p_organization_id, p_conversation_id, p_actor_user_id)
    into v_selected;
  -- Every member's open drawers follow along.
  perform private.enqueue_conversation_invalidation_internal(
    p_organization_id, p_conversation_id, 'conversation', p_conversation_id::text,
    'conversation_updated'
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'action', p_action,
    'project_id', v_project_id,
    'item_id', case when p_action in ('add_item', 'rename_item') then v_item_id end,
    'selected_project_id', v_selected
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/projects/commands',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$function$;

revoke all on function private.bff_conversation_project_command_impl(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function private.bff_conversation_project_command_impl(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, jsonb, text, text
) to service_role;

create or replace function public.bff_conversation_project_command(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_action text,
  p_project_id uuid,
  p_item_id uuid,
  p_name text,
  p_target jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$ select private.bff_conversation_project_command_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id, p_action,
  p_project_id, p_item_id, p_name, p_target, p_idempotency_key, p_request_sha256
) $function$;

revoke all on function public.bff_conversation_project_command(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.bff_conversation_project_command(
  uuid, uuid, uuid, uuid, text, uuid, uuid, text, jsonb, text, text
) to service_role;

-- A chat's projects and everything in their drawers, as this reader may see
-- it. Uploads and links follow the timeline's rules (a hidden, deleted or
-- blocked sender's message takes its file or link out of the drawer for that
-- reader); a summary shows once written, and only to a reader whose history
-- reaches back to the first message it read. Bucket and path leave the
-- database only for the gateway to sign previews; it strips both.
create or replace function private.bff_read_conversation_projects_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_member_found boolean;
  v_history_visible_from timestamptz;
  v_projects jsonb;
  v_items jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'projects.read', false, 0
  );
  select member.found, member.history_visible_from
    into v_member_found, v_history_visible_from
  from private.project_member_history_from(p_organization_id, p_conversation_id, p_actor_user_id) member;
  if coalesce(v_member_found, false) is false then
    raise exception 'projects unavailable' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'project_id', project.id,
      'name', project.name,
      'created_by_user_id', project.created_by_user_id,
      'created_at', project.created_at,
      'updated_at', project.updated_at
    ) order by project.created_at, project.id), '[]'::jsonb)
    into v_projects
  from public.conversation_projects project
  where project.organization_id = p_organization_id
    and project.conversation_id = p_conversation_id;

  select coalesce(jsonb_agg(entry.payload order by entry.created_at desc, entry.item_id desc), '[]'::jsonb)
    into v_items
  from (
    select item.created_at, item.id as item_id,
      jsonb_build_object(
        'item_id', item.id,
        'project_id', item.project_id,
        'kind', item.kind,
        'title', item.title,
        'added_by_user_id', item.added_by_user_id,
        'created_at', item.created_at,
        'summary_id', item.summary_id,
        'summary_state', case
          when summary.status in ('draft', 'approved') then 'ready'
          when summary.status in ('queued', 'processing') then 'pending'
        end,
        'summary_topic', summary.primary_topic,
        'summary_language', summary.language_code,
        'summary_created_at', summary.created_at,
        'attachment_id', item.attachment_id,
        'message_id', item.message_id::text,
        'file_name', file.file_name,
        'mime_type', file.mime_type,
        'byte_size', file.byte_size,
        'media_kind', case
          when file.id is null then null
          when file.mime_type like 'image/%' then 'image'
          when file.mime_type like 'video/%' then 'video'
          when file.mime_type like 'audio/%' then 'voice'
          else 'file'
        end,
        'url', item.url,
        'sender_user_id', message.sender_user_id,
        'sender_display_name', sender.display_name,
        'bucket_id', file.bucket_id,
        'storage_path', file.storage_path
      ) as payload
    from public.conversation_project_items item
    left join public.conversation_summaries summary
      on summary.organization_id = item.organization_id
     and summary.conversation_id = item.conversation_id
     and summary.id = item.summary_id
    left join public.message_attachments file
      on file.organization_id = item.organization_id
     and file.id = item.attachment_id
    left join public.messages message
      on message.organization_id = item.organization_id
     and message.conversation_id = item.conversation_id
     and message.id = item.message_id
    left join public.profiles sender on sender.user_id = message.sender_user_id
    where item.organization_id = p_organization_id
      and item.conversation_id = p_conversation_id
      and (
        (item.kind = 'summary'
          and summary.status in ('queued', 'processing', 'draft', 'approved')
          and (
            summary.requested_by_user_id = p_actor_user_id
            or (
              summary.status in ('draft', 'approved')
              and (v_history_visible_from is null or not exists (
                select 1 from public.messages first_source
                where first_source.organization_id = summary.organization_id
                  and first_source.conversation_id = summary.conversation_id
                  and first_source.id = summary.source_first_message_id
                  and first_source.created_at < v_history_visible_from
              ))
            )
          ))
        or (item.kind = 'upload'
          and file.scan_status = 'clean'
          and file.purge_requested_at is null
          and private.project_message_visible(
            p_organization_id, p_conversation_id, file.message_id, p_actor_user_id,
            v_history_visible_from
          ))
        or (item.kind = 'link'
          and private.project_message_visible(
            p_organization_id, p_conversation_id, item.message_id, p_actor_user_id,
            v_history_visible_from
          ))
      )
    order by item.created_at desc, item.id desc
    limit 1000
  ) entry;

  return jsonb_build_object(
    'schema_version', 1,
    'conversation_id', p_conversation_id,
    'selected_project_id', private.selected_conversation_project(
      p_organization_id, p_conversation_id, p_actor_user_id
    ),
    'projects', v_projects,
    'items', v_items
  );
end;
$function$;

revoke all on function private.bff_read_conversation_projects_impl(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function private.bff_read_conversation_projects_impl(uuid, uuid, uuid, uuid)
  to service_role;

create or replace function public.bff_read_conversation_projects(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$ select private.bff_read_conversation_projects_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id
) $function$;

revoke all on function public.bff_read_conversation_projects(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.bff_read_conversation_projects(uuid, uuid, uuid, uuid)
  to service_role;

-- A summary a reader may take out as a file: their own finished recap, or a
-- finished recap someone saved into one of this chat's projects when the
-- reader's history reaches back to the first message it read. The export
-- route used to query the table for the requester alone.
create or replace function private.bff_read_summary_for_export_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_summary_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_member_found boolean;
  v_history_visible_from timestamptz;
  v_summary jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'read.summary_export', false, 0
  );
  select member.found, member.history_visible_from
    into v_member_found, v_history_visible_from
  from private.project_member_history_from(p_organization_id, p_conversation_id, p_actor_user_id) member;
  if coalesce(v_member_found, false) is false then
    return jsonb_build_object('schema_version', 1, 'found', false);
  end if;
  select jsonb_build_object(
      'id', summary.id,
      'primary_topic', summary.primary_topic,
      'summary_body', summary.summary_body,
      'status', summary.status,
      'source_first_message_id', summary.source_first_message_id,
      'source_last_message_id', summary.source_last_message_id,
      'created_at', summary.created_at
    )
    into v_summary
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id
    and summary.conversation_id = p_conversation_id
    and summary.id = p_summary_id
    and summary.status in ('draft', 'approved')
    and (
      summary.requested_by_user_id = p_actor_user_id
      or (
        exists (
          select 1 from public.conversation_project_items item
          where item.organization_id = summary.organization_id
            and item.conversation_id = summary.conversation_id
            and item.summary_id = summary.id
        )
        and (v_history_visible_from is null or not exists (
          select 1 from public.messages first_source
          where first_source.organization_id = summary.organization_id
            and first_source.conversation_id = summary.conversation_id
            and first_source.id = summary.source_first_message_id
            and first_source.created_at < v_history_visible_from
        ))
      )
    );
  if v_summary is null then
    return jsonb_build_object('schema_version', 1, 'found', false);
  end if;
  return jsonb_build_object('schema_version', 1, 'found', true, 'summary', v_summary);
end;
$function$;

revoke all on function private.bff_read_summary_for_export_impl(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function private.bff_read_summary_for_export_impl(uuid, uuid, uuid, uuid, uuid)
  to service_role;

create or replace function public.bff_read_summary_for_export(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_summary_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$ select private.bff_read_summary_for_export_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id, p_summary_id
) $function$;

revoke all on function public.bff_read_summary_for_export(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.bff_read_summary_for_export(uuid, uuid, uuid, uuid, uuid)
  to service_role;

-- 찾기 (find by keyword): which chats a word came up in. A plain substring
-- match, so a Korean keyword finds "회의록" from "회의" where the full-text
-- search's whole-word tokens would not. It reads the reader's own chats only
-- and their visible messages only (the timeline's rules), the translations of
-- those messages, file names, and the chats' project names and drawer titles.
-- One row per chat, newest match first, with the newest matching message to
-- open at.
create or replace function private.bff_find_keyword_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_query text;
  v_pattern text;
  v_results jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'find.read', false, 0
  );
  v_query := btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'));
  if char_length(v_query) not between 1 and 100 or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'invalid keyword' using errcode = '22023';
  end if;
  v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  with chats as (
    select member.conversation_id, member.history_visible_from
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    join public.conversations conversation
      on conversation.organization_id = member.organization_id
     and conversation.id = member.conversation_id
    where member.organization_id = p_organization_id
      and member.user_id = p_actor_user_id
      and member.status = 'active'
      and private.dynamic_group_conversation_access_allowed_for_user(
        p_organization_id, member.conversation_id, p_actor_user_id, now()
      )
  ),
  matched_messages as (
    select message.conversation_id, message.id, message.created_at,
      coalesce(
        case when message.body ilike v_pattern then message.body end,
        (
          select translation.translated_body
          from public.message_translations translation
          where translation.organization_id = message.organization_id
            and translation.message_id = message.id
            and translation.status = 'completed'
            and translation.translated_body ilike v_pattern
          limit 1
        ),
        (
          select file.file_name
          from public.message_attachments file
          where file.organization_id = message.organization_id
            and file.conversation_id = message.conversation_id
            and file.message_id = message.id
            and file.scan_status = 'clean'
            and file.purge_requested_at is null
            and file.file_name ilike v_pattern
          limit 1
        )
      ) as matched_text
    from chats
    join public.messages message
      on message.organization_id = p_organization_id
     and message.conversation_id = chats.conversation_id
    where message.deleted_at is null
      and message.kind <> 'system'
      and message.available_at <= now()
      and (chats.history_visible_from is null or message.created_at >= chats.history_visible_from)
      and (
        message.body ilike v_pattern
        or exists (
          select 1 from public.message_translations translation
          where translation.organization_id = message.organization_id
            and translation.message_id = message.id
            and translation.status = 'completed'
            and translation.translated_body ilike v_pattern
        )
        or exists (
          select 1 from public.message_attachments file
          where file.organization_id = message.organization_id
            and file.conversation_id = message.conversation_id
            and file.message_id = message.id
            and file.scan_status = 'clean'
            and file.purge_requested_at is null
            and file.file_name ilike v_pattern
        )
      )
      and not exists (
        select 1 from public.message_user_visibility hidden
        where hidden.organization_id = message.organization_id
          and hidden.conversation_id = message.conversation_id
          and hidden.message_id = message.id
          and hidden.user_id = p_actor_user_id
      )
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = message.sender_user_id
      )
      and private.dynamic_group_message_access_allowed_for_user(
        p_organization_id, message.conversation_id, message.id, p_actor_user_id, now()
      )
  ),
  message_hits as (
    select ranked.conversation_id, ranked.total, ranked.id as latest_message_id,
      ranked.created_at as latest_at, ranked.matched_text
    from (
      select matched_messages.*,
        count(*) over (partition by matched_messages.conversation_id) as total,
        row_number() over (
          partition by matched_messages.conversation_id
          order by matched_messages.created_at desc, matched_messages.id desc
        ) as position
      from matched_messages
    ) ranked
    where ranked.position = 1
  ),
  project_hits as (
    select project.conversation_id,
      jsonb_agg(jsonb_build_object('project_id', project.id, 'name', project.name)
        order by project.created_at) as projects,
      max(project.updated_at) as latest_at
    from chats
    join public.conversation_projects project
      on project.organization_id = p_organization_id
     and project.conversation_id = chats.conversation_id
    where project.name ilike v_pattern
    group by project.conversation_id
  ),
  item_hits as (
    select ranked.conversation_id,
      jsonb_agg(jsonb_build_object(
        'project_id', ranked.project_id, 'project_name', ranked.project_name,
        'kind', ranked.kind, 'title', ranked.label
      ) order by ranked.created_at desc) as items,
      max(ranked.created_at) as latest_at
    from (
      select item.conversation_id, item.project_id, project.name as project_name, item.kind,
        item.created_at,
        coalesce(item.title, summary.primary_topic, file.file_name, item.url) as label,
        row_number() over (partition by item.conversation_id order by item.created_at desc) as position
      from chats
      join public.conversation_project_items item
        on item.organization_id = p_organization_id
       and item.conversation_id = chats.conversation_id
      join public.conversation_projects project on project.id = item.project_id
      left join public.conversation_summaries summary
        on summary.organization_id = item.organization_id
       and summary.conversation_id = item.conversation_id
       and summary.id = item.summary_id
      left join public.message_attachments file
        on file.organization_id = item.organization_id
       and file.id = item.attachment_id
      where (
          (item.kind = 'summary' and summary.status in ('draft', 'approved')
            and (summary.requested_by_user_id = p_actor_user_id or chats.history_visible_from is null
              or not exists (
                select 1 from public.messages first_source
                where first_source.organization_id = summary.organization_id
                  and first_source.conversation_id = summary.conversation_id
                  and first_source.id = summary.source_first_message_id
                  and first_source.created_at < chats.history_visible_from
              )))
          or (item.kind = 'upload' and file.scan_status = 'clean' and file.purge_requested_at is null
            and private.project_message_visible(
              p_organization_id, item.conversation_id, file.message_id, p_actor_user_id,
              chats.history_visible_from
            ))
          or (item.kind = 'link' and private.project_message_visible(
              p_organization_id, item.conversation_id, item.message_id, p_actor_user_id,
              chats.history_visible_from
            ))
        )
        and coalesce(item.title, summary.primary_topic, file.file_name, item.url) ilike v_pattern
    ) ranked
    where ranked.position <= 5
    group by ranked.conversation_id
  ),
  combined as (
    select chats.conversation_id,
      coalesce(message_hits.total, 0) as message_count,
      message_hits.latest_message_id,
      message_hits.latest_at as message_at,
      message_hits.matched_text,
      coalesce(project_hits.projects, '[]'::jsonb) as projects,
      coalesce(item_hits.items, '[]'::jsonb) as items,
      greatest(message_hits.latest_at, project_hits.latest_at, item_hits.latest_at) as latest_at
    from chats
    left join message_hits on message_hits.conversation_id = chats.conversation_id
    left join project_hits on project_hits.conversation_id = chats.conversation_id
    left join item_hits on item_hits.conversation_id = chats.conversation_id
    where message_hits.conversation_id is not null
      or project_hits.conversation_id is not null
      or item_hits.conversation_id is not null
    order by greatest(message_hits.latest_at, project_hits.latest_at, item_hits.latest_at) desc nulls last,
      chats.conversation_id
    limit p_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'conversation_id', combined.conversation_id,
      'message_count', combined.message_count,
      'latest_message_id', combined.latest_message_id::text,
      'latest_message_at', combined.message_at,
      'snippet', case when combined.matched_text is null then null else
        left(substr(
          combined.matched_text,
          greatest(1, strpos(lower(combined.matched_text), lower(v_query)) - 40)
        ), 200) end,
      'projects', combined.projects,
      'items', combined.items,
      'latest_at', combined.latest_at
    ) order by combined.latest_at desc nulls last, combined.conversation_id), '[]'::jsonb)
    into v_results
  from combined;

  return jsonb_build_object(
    'schema_version', 1,
    'query', v_query,
    'results', v_results
  );
end;
$function$;

revoke all on function private.bff_find_keyword_impl(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function private.bff_find_keyword_impl(uuid, uuid, uuid, text, integer)
  to service_role;

create or replace function public.bff_find_keyword(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_limit integer default 30
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$ select private.bff_find_keyword_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_query, p_limit
) $function$;

revoke all on function public.bff_find_keyword(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.bff_find_keyword(uuid, uuid, uuid, text, integer)
  to service_role;
