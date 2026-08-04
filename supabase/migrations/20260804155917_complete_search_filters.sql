begin;

-- Conversation and language filters are authorization-narrowing predicates.
-- Quoted web-search phrases remain intact while document punctuation continues
-- to use the immutable normalized tsvector indexes from the foundation.

create or replace function private.bff_search_v3_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_types text[],
  p_cursor text,
  p_limit integer,
  p_sender_user_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_match_sources text[] default null,
  p_conversation_id uuid default null,
  p_language text default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_types text[];
  v_match_sources text[];
  v_query tsquery;
  v_query_hash text;
  v_types_hash text;
  v_filters_hash text;
  v_cursor_json jsonb;
  v_cursor_at timestamptz;
  v_cursor_type text;
  v_cursor_id text;
  v_results jsonb;
  v_has_more boolean;
  v_last_at timestamptz;
  v_last_type text;
  v_last_id text;
  v_next_cursor text;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'search.read', false, 0
  );
  if char_length(btrim(coalesce(p_query, ''))) not between 2 and 200
    or p_limit not between 1 and 50
    or (p_date_from is not null and not isfinite(p_date_from))
    or (p_date_to is not null and not isfinite(p_date_to))
    or (p_date_from is not null and p_date_to is not null and (
      p_date_to < p_date_from or p_date_to - p_date_from > interval '10 years'
    )) then
    raise exception 'invalid search request' using errcode = '22023';
  end if;
  if p_language is not null
    and p_language not in ('ko', 'es', 'en', 'mixed', 'und') then
    raise exception 'invalid search language filter' using errcode = '22023';
  end if;
  if p_conversation_id is not null and not exists (
    select 1
    from public.conversation_members filtered_member
    where filtered_member.organization_id = p_organization_id
      and filtered_member.conversation_id = p_conversation_id
      and filtered_member.user_id = p_actor_user_id
      and filtered_member.status = 'active'
  ) then
    raise exception 'conversation search filter denied' using errcode = '42501';
  end if;

  select array_agg(distinct requested_type order by requested_type)
    into v_types
  from unnest(coalesce(
    p_types,
    array['people', 'conversations', 'messages', 'announcements', 'handoffs']::text[]
  )) requested_type;
  if coalesce(cardinality(v_types), 0) not between 1 and 5
    or not (v_types <@ array[
      'people', 'conversations', 'messages', 'announcements', 'handoffs'
    ]::text[]) then
    raise exception 'invalid search entity types' using errcode = '22023';
  end if;

  select array_agg(distinct requested_source order by requested_source)
    into v_match_sources
  from unnest(coalesce(
    p_match_sources,
    array['original', 'translation', 'sender', 'attachment_filename']::text[]
  )) requested_source;
  if coalesce(cardinality(v_match_sources), 0) not between 1 and 4
    or not (v_match_sources <@ array[
      'original', 'translation', 'sender', 'attachment_filename'
    ]::text[])
    or (p_match_sources is not null and v_types <> array['messages']::text[])
    or (p_sender_user_id is not null and v_types <> array['messages']::text[]) then
    raise exception 'invalid search message filters' using errcode = '22023';
  end if;

  v_query := websearch_to_tsquery(
    'simple',
    regexp_replace(
      lower(extensions.unaccent(btrim(p_query))),
      '[^[:alnum:][:space:]"]+', ' ', 'g'
    )
  );
  if numnode(v_query) = 0 then
    raise exception 'search query has no searchable terms' using errcode = '22023';
  end if;
  v_query_hash := encode(
    extensions.digest(convert_to(lower(btrim(p_query)), 'UTF8'), 'sha256'), 'hex'
  );
  v_types_hash := encode(
    extensions.digest(convert_to(array_to_string(v_types, ','), 'UTF8'), 'sha256'), 'hex'
  );
  v_filters_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'sender_user_id', p_sender_user_id,
    'date_from', p_date_from,
    'date_to', p_date_to,
    'match_sources', case when p_match_sources is null then null else v_match_sources end,
    'conversation_id', p_conversation_id,
    'language', p_language
  )::text, 'UTF8'), 'sha256'), 'hex');

  if p_cursor is not null then
    begin
      if char_length(p_cursor) > 1536 or p_cursor !~ '^[A-Za-z0-9+/]+={0,2}$' then
        raise exception 'malformed cursor';
      end if;
      v_cursor_json := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      if jsonb_typeof(v_cursor_json) <> 'object'
        or (select count(*) from pg_catalog.jsonb_object_keys(v_cursor_json)) <> 7
        or not (v_cursor_json ?& array[
          'version', 'at', 'type', 'id', 'query_hash', 'types_hash', 'filters_hash'
        ])
        or v_cursor_json -> 'version' <> '1'::jsonb
        or coalesce(v_cursor_json ->> 'query_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(v_cursor_json ->> 'types_hash', '') !~ '^[0-9a-f]{64}$'
        or coalesce(v_cursor_json ->> 'filters_hash', '') !~ '^[0-9a-f]{64}$' then
        raise exception 'malformed cursor payload';
      end if;
      v_cursor_at := (v_cursor_json ->> 'at')::timestamptz;
      v_cursor_type := v_cursor_json ->> 'type';
      v_cursor_id := v_cursor_json ->> 'id';
      if not isfinite(v_cursor_at)
        or not (v_cursor_type = any(v_types))
        or (v_cursor_type = 'messages' and v_cursor_id !~ '^[1-9][0-9]{0,18}$')
        or (v_cursor_type <> 'messages' and v_cursor_id !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
        or v_cursor_json ->> 'query_hash' <> v_query_hash
        or v_cursor_json ->> 'types_hash' <> v_types_hash
        or v_cursor_json ->> 'filters_hash' <> v_filters_hash then
        raise exception 'cursor binding mismatch';
      end if;
    exception when others then
      raise exception 'invalid search cursor' using errcode = '22023';
    end;
  end if;

  with searchable as (
    select
      'people'::text as entity_type,
      membership.user_id::text as entity_id,
      profile.display_name as title,
      left(coalesce(membership.job_title, profile.status_message, ''), 240) as snippet,
      'profile'::text as matched_source,
      profile.preferred_language as matched_language,
      null::uuid as conversation_id,
      membership.updated_at as occurred_at
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where 'people' = any(v_types)
      and p_match_sources is null
      and p_sender_user_id is null
      and membership.organization_id = p_organization_id
      and membership.status = 'active'
      and (
        to_tsvector('simple', private.normalize_search_text(
          coalesce(profile.display_name, '') || ' ' || coalesce(profile.status_message, '')
        )) @@ v_query
        or to_tsvector('simple', private.normalize_search_text(
          coalesce(membership.job_title, '') || ' ' || coalesce(membership.employee_code, '')
        )) @@ v_query
      )
      and (
        membership.user_id = p_actor_user_id
        or exists (
          select 1 from public.organization_memberships viewer
          where viewer.organization_id = p_organization_id
            and viewer.user_id = p_actor_user_id
            and viewer.status = 'active'
            and viewer.role in ('owner', 'admin')
        )
        or (
          membership.directory_visibility <> 'private'
          and not exists (
            select 1 from public.member_blocks block
            where block.organization_id = p_organization_id
              and (
                (block.blocker_user_id = p_actor_user_id and block.blocked_user_id = membership.user_id)
                or (block.blocker_user_id = membership.user_id and block.blocked_user_id = p_actor_user_id)
              )
          )
          and (
            membership.directory_visibility = 'organization'
            or exists (
              select 1
              from public.organization_unit_members viewer_unit
              join public.organization_unit_members target_unit
                on target_unit.organization_id = viewer_unit.organization_id
               and target_unit.unit_id = viewer_unit.unit_id
               and target_unit.user_id = membership.user_id
              where viewer_unit.organization_id = p_organization_id
                and viewer_unit.user_id = p_actor_user_id
            )
          )
        )
      )

    union all

    select
      'conversations', conversation.id::text,
      coalesce(conversation.name, 'Direct conversation'),
      left(coalesce(conversation.description, ''), 240),
      'conversation', null::text,
      conversation.id, conversation.updated_at
    from public.conversations conversation
    join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where 'conversations' = any(v_types)
      and (p_conversation_id is null or conversation.id = p_conversation_id)
      and p_match_sources is null
      and p_sender_user_id is null
      and conversation.organization_id = p_organization_id
      and to_tsvector('simple', private.normalize_search_text(
        coalesce(conversation.name, '') || ' ' || coalesce(conversation.description, '')
      )) @@ v_query

    union all

    select
      'messages', message.id::text, sender.display_name,
      left(case
        when 'original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query
          then message.body
        when matched_translation.effective_body is not null
          then matched_translation.effective_body
        when matched_attachment.file_name is not null then matched_attachment.file_name
        else sender.display_name
      end, 240),
      case
        when 'original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query
          then 'original'
        when matched_translation.effective_body is not null then 'translation'
        when matched_attachment.file_name is not null then 'attachment_filename'
        else 'sender'
      end,
      case
        when 'original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query
          then message.detected_language
        when matched_translation.effective_body is not null
          then matched_translation.target_language
        else null
      end,
      message.conversation_id, message.created_at
    from public.messages message
    join public.conversation_members member
      on member.organization_id = message.organization_id
     and member.conversation_id = message.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.profiles sender on sender.user_id = message.sender_user_id
    left join lateral (
      select
        coalesce(approved_correction.corrected_body, translation.translated_body) as effective_body,
        translation.target_language
      from public.message_translations translation
      left join lateral (
        select correction.corrected_body
        from public.translation_corrections correction
        where correction.organization_id = translation.organization_id
          and correction.conversation_id = translation.conversation_id
          and correction.message_id = translation.message_id
          and correction.target_language = translation.target_language
          and correction.status = 'approved'
        order by correction.reviewed_at desc nulls last, correction.created_at desc, correction.id desc
        limit 1
      ) approved_correction on true
      where 'translation' = any(v_match_sources)
        and (p_language is null or translation.target_language = p_language)
        and translation.organization_id = message.organization_id
        and translation.conversation_id = message.conversation_id
        and translation.message_id = message.id
        and translation.status = 'completed'
        and translation.source_body_sha256 = extensions.digest(
          convert_to(message.body, 'UTF8'), 'sha256'
        )
        and to_tsvector('simple', private.normalize_search_text(
          coalesce(approved_correction.corrected_body, translation.translated_body)
        )) @@ v_query
      order by translation.target_language, translation.id
      limit 1
    ) matched_translation on true
    left join lateral (
      select attachment.file_name
      from public.message_attachments attachment
      where 'attachment_filename' = any(v_match_sources)
        and attachment.organization_id = message.organization_id
        and attachment.conversation_id = message.conversation_id
        and attachment.message_id = message.id
        and attachment.scan_status = 'clean'
        and attachment.file_name_search @@ v_query
      order by attachment.id
      limit 1
    ) matched_attachment on true
    where 'messages' = any(v_types)
      and message.organization_id = p_organization_id
      and (p_conversation_id is null or message.conversation_id = p_conversation_id)
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and (p_sender_user_id is null or message.sender_user_id = p_sender_user_id)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
      and (
        ('original' = any(v_match_sources)
          and (p_language is null
            or message.detected_language = p_language)
          and message.body_search @@ v_query)
        or ('sender' = any(v_match_sources) and to_tsvector(
          'simple', private.normalize_search_text(sender.display_name)
        ) @@ v_query)
        or matched_translation.effective_body is not null
        or matched_attachment.file_name is not null
      )

    union all

    select
      'announcements', announcement.id::text, version.title,
      left(case when message.body_search @@ v_query then message.body else version.title end, 240),
      'announcement',
      message.detected_language,
      announcement.conversation_id, version.published_at
    from public.announcements announcement
    join public.announcement_versions version
      on version.organization_id = announcement.organization_id
     and version.announcement_id = announcement.id
    join public.messages message
      on message.organization_id = version.organization_id
     and message.conversation_id = version.conversation_id
     and message.id = version.message_id
    join public.conversation_members member
      on member.organization_id = announcement.organization_id
     and member.conversation_id = announcement.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where 'announcements' = any(v_types)
      and (p_conversation_id is null or announcement.conversation_id = p_conversation_id)
      and p_match_sources is null
      and p_sender_user_id is null
      and announcement.organization_id = p_organization_id
      and announcement.status in ('published', 'archived')
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
      and not exists (
        select 1 from public.announcement_versions newer
        where newer.organization_id = version.organization_id
          and newer.announcement_id = version.announcement_id
          and newer.version_number > version.version_number
      )
      and (
        to_tsvector('simple', private.normalize_search_text(version.title)) @@ v_query
        or message.body_search @@ v_query
      )

    union all

    select
      'handoffs', handoff.id::text, version.title,
      left(version.details, 240), 'handoff', version.source_language,
      handoff.conversation_id, version.created_at
    from public.shift_handoffs handoff
    join public.handoff_versions version
      on version.organization_id = handoff.organization_id
     and version.handoff_id = handoff.id
    join public.conversation_members member
      on member.organization_id = handoff.organization_id
     and member.conversation_id = handoff.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where 'handoffs' = any(v_types)
      and (p_conversation_id is null or handoff.conversation_id = p_conversation_id)
      and p_match_sources is null
      and p_sender_user_id is null
      and handoff.organization_id = p_organization_id
      and (member.history_visible_from is null
        or version.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.handoff_versions newer
        where newer.organization_id = version.organization_id
          and newer.handoff_id = version.handoff_id
          and newer.version_number > version.version_number
      )
      and to_tsvector('simple', private.normalize_search_text(
        version.title || ' ' || version.details
      )) @@ v_query
  ), page as (
    select searchable.*
    from searchable
    where (p_date_from is null or searchable.occurred_at >= p_date_from)
      and (p_date_to is null or searchable.occurred_at <= p_date_to)
      and (p_conversation_id is null or searchable.conversation_id = p_conversation_id)
      and (p_language is null or searchable.matched_language = p_language)
      and (
        p_cursor is null
        or (searchable.occurred_at, searchable.entity_type, searchable.entity_id)
          < (v_cursor_at, v_cursor_type, v_cursor_id)
      )
    order by searchable.occurred_at desc, searchable.entity_type desc, searchable.entity_id desc
    limit p_limit + 1
  ), numbered as (
    select page.*, row_number() over (
      order by page.occurred_at desc, page.entity_type desc, page.entity_id desc
    ) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'type', numbered.entity_type,
        'id', numbered.entity_id,
        'title', numbered.title,
        'snippet', numbered.snippet,
        'matched_source', numbered.matched_source,
        'matched_language', numbered.matched_language,
        'conversation_id', numbered.conversation_id,
        'occurred_at', numbered.occurred_at
      ) order by numbered.occurred_at desc, numbered.entity_type desc, numbered.entity_id desc
    ) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    max(numbered.occurred_at) filter (where numbered.row_number = p_limit),
    max(numbered.entity_type) filter (where numbered.row_number = p_limit),
    max(numbered.entity_id) filter (where numbered.row_number = p_limit)
  into v_results, v_has_more, v_last_at, v_last_type, v_last_id
  from numbered;

  if v_has_more then
    v_next_cursor := replace(encode(convert_to(jsonb_build_object(
      'version', 1,
      'at', v_last_at,
      'type', v_last_type,
      'id', v_last_id,
      'query_hash', v_query_hash,
      'types_hash', v_types_hash,
      'filters_hash', v_filters_hash
    )::text, 'UTF8'), 'base64'), E'\n', '');
  end if;
  return jsonb_build_object(
    'results', v_results,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more
  );
end;
$$;

drop function public.bff_search(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[]
);

create function public.bff_search(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_query text, p_types text[], p_cursor text default null,
  p_limit integer default 20, p_sender_user_id uuid default null,
  p_date_from timestamptz default null, p_date_to timestamptz default null,
  p_match_sources text[] default null, p_conversation_id uuid default null,
  p_language text default null
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_search_v3_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_query,
  p_types, p_cursor, p_limit, p_sender_user_id, p_date_from, p_date_to,
  p_match_sources, p_conversation_id, p_language
) $$;

revoke execute on function private.bff_search_v3_impl(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) from public, anon, authenticated;
grant execute on function private.bff_search_v3_impl(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) to service_role;
revoke execute on function public.bff_search(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) from public, anon, authenticated;
grant execute on function public.bff_search(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) to service_role;

comment on function public.bff_search(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[], uuid, text
) is 'Authorization-trimmed unified search. Conversation and language filters only narrow already-visible results.';

drop function private.bff_search_v2_impl(
  uuid, uuid, uuid, text, text[], text, integer, uuid, timestamptz, timestamptz, text[]
);

commit;
