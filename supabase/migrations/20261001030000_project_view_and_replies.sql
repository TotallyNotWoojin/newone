-- A project's conversation on its own (owner's father, Oct 1 2026: "since
-- multiple project conversations happen on the same screen, it's very
-- inconvenient to follow the discussions"; owner's decision the same day:
-- opening a project shows only that project's messages, and replies join the
-- project of what they answer).
--
-- A message belonged to a project only when its sender had that project
-- selected. In a group most answers come from people who never select one:
-- Marisol's reply about Juan Salvador sat in no project although it answered a
-- Transportation message. Now a message whose sender has no project selected
-- joins the project of the message it replies to (or of the file or link it
-- answers, when that was filed by hand). The sender's own selection still
-- wins: the "Saving to" bar over the composer says where it goes.
--
-- The projects read now lists each project's messages (newest 1000 the reader
-- can reach) instead of only the newest one, so the app can show a project's
-- conversation by itself. bff_read_conversation_projects_impl below is the
-- definition from 20261001010000 (hosted source compared before writing
-- this) with last_message_id replaced by message_ids;
-- file_message_into_selected_project is the 20261001010000 definition with
-- the reply rule added.

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
  if new.reply_to_message_id is null and not exists (
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
    -- No project of its own: an answer goes where the message it answers is.
    if v_project_id is null and new.reply_to_message_id is not null then
      select tagged.project_id into v_project_id
      from public.conversation_project_messages tagged
      where tagged.organization_id = new.organization_id
        and tagged.conversation_id = new.conversation_id
        and tagged.message_id = new.reply_to_message_id;
      if v_project_id is null then
        select filed.project_id into v_project_id
        from public.conversation_project_items filed
        where filed.organization_id = new.organization_id
          and filed.conversation_id = new.conversation_id
          and filed.message_id = new.reply_to_message_id
        order by filed.created_at desc
        limit 1;
      end if;
    end if;
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

-- Answers already in the chats join the project of what they answer, a chain
-- of answers link by link.
do $$
declare
  v_added integer;
  v_round integer := 0;
begin
  loop
    insert into public.conversation_project_messages (
      organization_id, conversation_id, message_id, project_id, created_at
    )
    select reply.organization_id, reply.conversation_id, reply.id, tagged.project_id, reply.created_at
    from public.conversation_project_messages tagged
    join public.messages reply
      on reply.organization_id = tagged.organization_id
     and reply.conversation_id = tagged.conversation_id
     and reply.reply_to_message_id = tagged.message_id
    where reply.kind <> 'system'
      and coalesce(reply.metadata ->> 'purpose', '') <> 'conversation_avatar'
    on conflict do nothing;
    get diagnostics v_added = row_count;
    v_round := v_round + 1;
    exit when v_added = 0 or v_round >= 10;
  end loop;
end;
$$;

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
      -- The messages that make up the project's conversation, newest first:
      -- sent under it, answering one of its messages, or carrying a file or
      -- link in its drawers. The app shows only these while the reader looks
      -- at the project; anything the reader may not see in the chat is never
      -- on their screen to begin with, so only history and deletion apply.
      'message_ids', coalesce((
        select jsonb_agg(member.message_id::text order by member.message_id desc)
        from (
          select distinct candidate.message_id
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
          join public.messages message
            on message.organization_id = p_organization_id
           and message.conversation_id = p_conversation_id
           and message.id = candidate.message_id
          where message.deleted_at is null
            and (v_history_visible_from is null or message.created_at >= v_history_visible_from)
          order by candidate.message_id desc
          limit 1000
        ) member
      ), '[]'::jsonb)
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
