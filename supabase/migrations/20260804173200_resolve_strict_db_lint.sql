begin;

-- These read endpoints make statement-time authorization decisions and inspect
-- wall-clock expiry. Mark both the private implementations and public wrappers
-- VOLATILE so PostgreSQL never treats those decisions as statement-stable.
alter function private.bff_list_discoverable_conversations_impl(
  uuid, uuid, uuid, integer
) volatile;
alter function public.bff_list_discoverable_conversations(
  uuid, uuid, uuid, integer
) volatile;

alter function private.bff_list_conversation_join_requests_impl(
  uuid, uuid, uuid, uuid, integer
) volatile;
alter function public.bff_list_conversation_join_requests(
  uuid, uuid, uuid, uuid, integer
) volatile;

alter function private.bff_list_conversation_member_candidates_impl(
  uuid, uuid, uuid, uuid, text, text, integer
) volatile;
alter function public.bff_list_conversation_member_candidates(
  uuid, uuid, uuid, uuid, text, text, integer
) volatile;

-- Keep the legacy dynamic-group APIs fail closed. Reading their arguments is a
-- deliberate no-op that documents the compatibility signature and keeps the
-- strict PL/pgSQL analyzer from treating those inputs as accidental omissions.
create or replace function private.bff_save_dynamic_group_policy_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_policy_id uuid,
  p_unit_id uuid,
  p_member_roles text[],
  p_include_unit_descendants boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  perform p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_policy_id, p_unit_id, p_member_roles,
    p_include_unit_descendants, p_idempotency_key, p_request_sha256;
  raise exception 'dynamic-group v2 CAS save and preview/publish are required'
    using errcode = '0A000';
end;
$$;

create or replace function private.bff_sync_dynamic_group_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  perform p_actor_user_id, p_organization_id, p_session_id,
    p_policy_id, p_idempotency_key, p_request_sha256;
  raise exception 'dynamic-group preview fingerprint and CAS publish are required'
    using errcode = '0A000';
end;
$$;

create or replace function private.bff_preview_dynamic_group_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  perform p_actor_user_id, p_organization_id, p_session_id,
    p_policy_id, p_limit;
  raise exception 'dynamic-group v2 CAS preview is required'
    using errcode = '0A000';
end;
$$;

-- The moderation fanout function needs only an existence check. Avoid loading
-- an entire row into a variable that is intentionally never read.
create or replace function private.notify_moderation_viewers_internal(
  p_organization_id uuid,
  p_case_id uuid,
  p_state text,
  p_reason text,
  p_version integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform 1
  from private.message_reports report
  where report.organization_id = p_organization_id
    and report.id = p_case_id;
  if not found then
    raise exception 'moderation case not found' using errcode = 'P0002';
  end if;
  if p_state not in ('open', 'assigned', 'in_review', 'resolved', 'dismissed')
    or p_reason not in (
      'case_available', 'case_assigned', 'case_reassigned', 'case_status_changed'
    )
    or p_version < 1 then
    raise exception 'invalid moderation fanout request' using errcode = '22023';
  end if;

  -- User-facing intake/lifecycle commits stay O(1). The durable worker expands
  -- this content-free intent set-wise using authorization at processing time.
  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'moderation',
    'moderation-fanout:' || p_case_id::text || ':' || p_version::text || ':' || p_reason,
    jsonb_build_object(
      'schema_version', 1,
      'case_id', p_case_id,
      'state', p_state,
      'reason', p_reason,
      'version', p_version
    )
  );
end;
$$;

-- Use an explicit counter for the bounded scan. This avoids both the implicit
-- FOR-loop shadow variable and a loop value that is never read by the body.
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
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_page jsonb;
  v_page_filtered jsonb;
  v_authorized jsonb := '[]'::jsonb;
  v_scan_cursor text := p_cursor;
  v_next_cursor text;
  v_page_has_more boolean;
  v_needed integer;
  v_filtered_count integer;
  v_anchor_ordinal integer;
  v_iteration integer := 0;
begin
  if p_limit not between 1 and 50 then
    -- Preserve the inherited request contract before any scan work.
    return private.bff_search_v3_pre_dynamic_group_impl(
      p_actor_user_id, p_organization_id, p_session_id, p_query, p_types,
      p_cursor, p_limit, p_sender_user_id, p_date_from, p_date_to,
      p_match_sources, p_conversation_id, p_language
    );
  end if;

  -- Search up to 500 underlying rows per request. An authorization-empty page
  -- is never represented as terminal while the underlying cursor has work.
  while v_iteration < 10 loop
    v_iteration := v_iteration + 1;
    v_page := private.bff_search_v3_pre_dynamic_group_impl(
      p_actor_user_id, p_organization_id, p_session_id, p_query, p_types,
      v_scan_cursor, 50, p_sender_user_id, p_date_from, p_date_to,
      p_match_sources, p_conversation_id, p_language
    );
    v_page_has_more := coalesce((v_page ->> 'has_more')::boolean, false);
    select coalesce(
        jsonb_agg(item.value order by item.ordinality), '[]'::jsonb
      ), count(*)::integer
      into v_page_filtered, v_filtered_count
    from jsonb_array_elements(coalesce(v_page -> 'results', '[]'::jsonb))
      with ordinality item(value, ordinality)
    where private.dynamic_group_search_item_allowed_for_user(
      p_organization_id, p_actor_user_id, item.value, now()
    );

    v_needed := p_limit - jsonb_array_length(v_authorized);
    if v_filtered_count >= v_needed then
      select coalesce(jsonb_agg(item.value order by item.ordinality), '[]'::jsonb)
        into v_page_filtered
      from jsonb_array_elements(v_page_filtered)
        with ordinality item(value, ordinality)
      where item.ordinality <= v_needed;
      v_authorized := v_authorized || v_page_filtered;

      if v_filtered_count > v_needed or v_page_has_more then
        with allowed as (
          select item.ordinality,
            row_number() over (order by item.ordinality) allowed_ordinality
          from jsonb_array_elements(coalesce(v_page -> 'results', '[]'::jsonb))
            with ordinality item(value, ordinality)
          where private.dynamic_group_search_item_allowed_for_user(
            p_organization_id, p_actor_user_id, item.value, now()
          )
        )
        select allowed.ordinality::integer into v_anchor_ordinal
        from allowed where allowed.allowed_ordinality = v_needed;
        -- Ask the inherited cursor encoder to bind a cursor to the last row
        -- actually returned, leaving later authorized rows reachable.
        v_next_cursor := private.bff_search_v3_pre_dynamic_group_impl(
          p_actor_user_id, p_organization_id, p_session_id, p_query, p_types,
          v_scan_cursor, v_anchor_ordinal, p_sender_user_id, p_date_from,
          p_date_to, p_match_sources, p_conversation_id, p_language
        ) ->> 'next_cursor';
      end if;
      return jsonb_build_object(
        'results', v_authorized,
        'next_cursor', v_next_cursor,
        'has_more', v_next_cursor is not null
      );
    end if;

    v_authorized := v_authorized || v_page_filtered;
    if not v_page_has_more then
      return jsonb_build_object(
        'results', v_authorized, 'next_cursor', null, 'has_more', false
      );
    end if;
    v_scan_cursor := v_page ->> 'next_cursor';
  end loop;

  return jsonb_build_object(
    'results', v_authorized,
    'next_cursor', v_scan_cursor,
    'has_more', v_scan_cursor is not null
  );
end;
$$;

commit;
