-- Where each project's conversation got to (owner's father, Oct 1 2026):
-- "pressing the project name should move you to the project room", and the
-- chat should land "at the last position where the project-specific chat
-- ended" instead of staying where it was.
--
-- A project is still a folder the reader selects while talking in the
-- ordinary room (owner's decision, Sep 23 2026). Until now only the files and
-- links sent under it were filed; the words around them were not, so there
-- was no place to go back to. Every message sent while its sender has a
-- project selected is now recorded against that project, and the projects
-- read names, per project, the newest of those messages (or of the messages
-- whose file or link sits in its drawers) that this reader may see.
--
-- The recording trigger sits on the busiest table in the product, so it
-- follows the other filing triggers: the sender's selection is looked up by
-- primary key first and it returns at once without one, and the filing runs
-- inside its own exception block, so a fault loses the record and never the
-- message.
--
-- Messages from before this change are recorded only where that is certain:
-- a sender's current selection has not changed since its updated_at, so what
-- they sent in that chat since then was sent under it.
--
-- bff_read_conversation_projects_impl below is the definition from
-- 20260923010000_conversation_projects.sql (the hosted source was compared
-- before writing this) with only last_message_id added to each project.

create table public.conversation_project_messages (
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  project_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, message_id),
  constraint conversation_project_messages_project_fkey
    foreign key (organization_id, conversation_id, project_id)
    references public.conversation_projects (organization_id, conversation_id, id) on delete cascade,
  constraint conversation_project_messages_message_fkey
    foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete cascade
);

create index conversation_project_messages_project_idx
  on public.conversation_project_messages (project_id, message_id desc);
create index conversation_project_items_project_message_idx
  on public.conversation_project_items (project_id, message_id desc)
  where message_id is not null;

alter table public.conversation_project_messages enable row level security;
alter table public.conversation_project_messages force row level security;
revoke all on public.conversation_project_messages from public, anon, authenticated;
grant select, insert, update, delete on public.conversation_project_messages to service_role;

-- A message sent while its sender has a project selected belongs to that
-- project's conversation.
create or replace function private.file_message_into_selected_project()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_project_id uuid;
begin
  if new.kind = 'system' then
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
    if coalesce(new.metadata ->> 'purpose', '') = 'conversation_avatar' then
      return null;
    end if;
    v_project_id := private.selected_conversation_project(
      new.organization_id, new.conversation_id, new.sender_user_id
    );
    if v_project_id is null then
      return null;
    end if;
    insert into public.conversation_project_messages (
      organization_id, conversation_id, message_id, project_id
    ) values (
      new.organization_id, new.conversation_id, new.id, v_project_id
    )
    on conflict do nothing;
  exception when others then
    raise warning 'project filing skipped for message %: %', new.id, sqlerrm;
  end;
  return null;
end;
$function$;

revoke all on function private.file_message_into_selected_project() from public, anon, authenticated;

create trigger messages_61_file_into_project
after insert on public.messages
for each row execute function private.file_message_into_selected_project();

insert into public.conversation_project_messages (
  organization_id, conversation_id, message_id, project_id, created_at
)
select message.organization_id, message.conversation_id, message.id, selection.project_id,
  message.created_at
from public.conversation_project_selections selection
join public.messages message
  on message.organization_id = selection.organization_id
 and message.conversation_id = selection.conversation_id
 and message.sender_user_id = selection.user_id
where message.created_at >= selection.updated_at
  and message.kind <> 'system'
  and coalesce(message.metadata ->> 'purpose', '') <> 'conversation_avatar'
on conflict do nothing;

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
      'updated_at', project.updated_at,
      -- Where the project's conversation got to for this reader: the newest
      -- message they may see that was sent under it, or whose file or link
      -- sits in its drawers.
      'last_message_id', (
        select candidate.message_id::text
        from (
          select tagged.message_id
          from public.conversation_project_messages tagged
          where tagged.project_id = project.id
          union all
          select filed.message_id
          from public.conversation_project_items filed
          where filed.project_id = project.id
            and filed.message_id is not null
        ) candidate
        where private.project_message_visible(
          p_organization_id, p_conversation_id, candidate.message_id, p_actor_user_id,
          v_history_visible_from
        )
        order by candidate.message_id desc
        limit 1
      )
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
