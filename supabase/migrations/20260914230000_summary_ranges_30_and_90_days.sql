-- Two more summary ranges: the last 30 days and the last 90 days. The owner's
-- father wanted to choose the span himself, and "Unread" leaves the app's
-- chips (the server keeps accepting it for builds that still send it), so
-- the choice runs Today, Yesterday, 7 days, 30 days, 90 days, Everything
-- (owner, Sep 14 2026). The request function is recreated whole from its
-- 20260907040000 text with two additions: the accepted kinds and the two
-- window arms; the wrapper and grants are untouched.

alter table public.conversation_summaries
  drop constraint if exists conversation_summaries_scope_kind_allowed;
alter table public.conversation_summaries
  add constraint conversation_summaries_scope_kind_allowed
  check (scope_kind is null or scope_kind in (
    'unread', 'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'everything'
  ));

create or replace function private.bff_request_conversation_summary_scope_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_scope_kind text, p_scope_subject text,
  p_from_message_id bigint, p_utc_offset_minutes integer, p_language_code text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_command jsonb; v_source jsonb; v_summary_id uuid; v_version integer;
  v_job_id bigint; v_status text; v_created boolean := false; v_response jsonb;
  v_subject text; v_offset integer; v_midnight timestamptz; v_after_id bigint;
  v_ids bigint[]; v_history_visible_from timestamptz; v_member_found boolean;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'summary.request', false, 0, '/v2/conversations/:id/summaries',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if coalesce(p_language_code, '') !~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
    or not private.ai_use_case_approved(p_organization_id, 'summary', null) then
    raise exception 'valid tenant-approved summary request required' using errcode = '42501';
  end if;
  if coalesce(p_scope_kind, '') not in ('unread', 'today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'everything')
    or coalesce(p_utc_offset_minutes, 0) not between -900 and 900
    or (p_from_message_id is not null and p_from_message_id < 1) then
    raise exception 'invalid summary scope' using errcode = '22023';
  end if;
  v_subject := nullif(btrim(regexp_replace(coalesce(p_scope_subject, ''), '\s+', ' ', 'g')), '');
  if char_length(coalesce(v_subject, '')) > 200 then
    raise exception 'invalid summary scope' using errcode = '22023';
  end if;
  select true, member.history_visible_from into v_member_found, v_history_visible_from
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.user_id = p_actor_user_id
    and member.status = 'active';
  if coalesce(v_member_found, false) is false then
    raise exception 'active conversation membership required' using errcode = '42501';
  end if;
  -- "Today" and "Yesterday" follow the reader's clock: the client sends its
  -- UTC offset, the server turns it into that day's midnight.
  v_offset := coalesce(p_utc_offset_minutes, 0);
  v_midnight := (date_trunc('day', (now() + make_interval(mins => v_offset)) at time zone 'UTC')
    at time zone 'UTC') - make_interval(mins => v_offset);
  if p_scope_kind = 'unread' then
    -- The app marks a chat read the moment it opens, so the client names the
    -- first message it showed as unread; without that hint the read cursor
    -- is the boundary.
    if p_from_message_id is not null then
      v_after_id := p_from_message_id - 1;
    else
      select cursor_row.last_read_message_id into v_after_id
      from public.conversation_read_cursors cursor_row
      where cursor_row.organization_id = p_organization_id
        and cursor_row.conversation_id = p_conversation_id
        and cursor_row.user_id = p_actor_user_id;
      v_after_id := coalesce(v_after_id, 0);
    end if;
  end if;
  -- The server picks the messages, so the client's loaded window never
  -- limits what a summary covers. Only messages with text count; the worker
  -- has nothing to say about attachments or system events.
  select array_agg(candidate.id order by candidate.id) into v_ids
  from (
    select message.id
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.deleted_at is null
      and message.available_at <= now()
      and message.kind <> 'system'
      and coalesce(btrim(message.body), '') <> ''
      and (v_history_visible_from is null or message.created_at >= v_history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
      and case p_scope_kind
        when 'unread' then message.id > v_after_id
        when 'today' then message.created_at >= v_midnight
        when 'yesterday' then message.created_at >= v_midnight - interval '1 day'
          and message.created_at < v_midnight
        when 'last_7_days' then message.created_at >= v_midnight - interval '6 days'
        when 'last_30_days' then message.created_at >= v_midnight - interval '29 days'
        when 'last_90_days' then message.created_at >= v_midnight - interval '89 days'
        else true
      end
      and private.dynamic_group_message_access_allowed_for_user(
        message.organization_id, message.conversation_id, message.id, p_actor_user_id, now()
      )
    order by message.id
    limit 2001
  ) candidate;
  if v_ids is null then
    raise exception 'summary_range_empty' using errcode = '42501';
  end if;
  if cardinality(v_ids) > 2000 then
    raise exception 'summary_range_too_long' using errcode = '42501';
  end if;
  v_source := private.summary_source_snapshot_internal(
    p_organization_id, p_conversation_id, p_actor_user_id, v_ids
  );
  perform 1 from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  for update;
  -- The same reader asking for the same messages with the same subject and
  -- language gets the version that is queued or already readable; nothing
  -- else is ever excluded because an earlier summary covered it.
  select summary.id, summary.version_number, summary.status
    into v_summary_id, v_version, v_status
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id
    and summary.conversation_id = p_conversation_id
    and summary.requested_by_user_id = p_actor_user_id
    and summary.source_fingerprint = decode(v_source ->> 'source_fingerprint', 'hex')
    and summary.language_code = lower(p_language_code)
    and summary.correction_of_summary_id is null
    and summary.scope_kind = p_scope_kind
    and summary.scope_subject is not distinct from v_subject
    and summary.status in ('queued', 'processing', 'draft', 'approved')
  order by summary.version_number desc
  limit 1;
  if v_summary_id is not null then
    select job.id into v_job_id from private.outbox_jobs job
    where job.topic = 'summary' and job.dedupe_key = 'summary:' || v_summary_id::text;
  else
    if not private.consume_rate_limit(
        'summary-handoff-conversation-hour',
        p_organization_id::text || ':' || p_conversation_id::text,
        8, 3600
      )
      or not private.consume_rate_limit(
        'summary-handoff-actor-day',
        p_organization_id::text || ':' || p_actor_user_id::text,
        30, 86400
      ) then
      raise exception 'summary/handoff draft rate limit exceeded'
        using errcode = 'P0001';
    end if;
    select coalesce(max(summary.version_number), 0) + 1 into v_version
    from public.conversation_summaries summary
    where summary.organization_id = p_organization_id
      and summary.conversation_id = p_conversation_id;
    insert into public.conversation_summaries (
      organization_id, conversation_id, version_number, source_message_ids,
      source_first_message_id, source_last_message_id, source_fingerprint,
      requested_by_user_id, request_mode, language_code, scope_kind, scope_subject
    ) values (
      p_organization_id, p_conversation_id, v_version, v_ids,
      v_ids[1], v_ids[cardinality(v_ids)],
      decode(v_source ->> 'source_fingerprint', 'hex'), p_actor_user_id,
      'manual', lower(p_language_code), p_scope_kind, v_subject
    ) returning id, status into v_summary_id, v_status;
    v_created := true;
    -- The job names the version; the worker reads the source ids from the
    -- row (2,000 ids would not fit the job payload).
    v_job_id := private.enqueue_outbox_job_internal(
      p_organization_id, 'summary', 'summary:' || v_summary_id::text,
      jsonb_build_object(
        'summary_id', v_summary_id,
        'organization_id', p_organization_id,
        'conversation_id', p_conversation_id,
        'source_message_count', cardinality(v_ids),
        'source_fingerprint', v_source ->> 'source_fingerprint',
        'language_code', lower(p_language_code),
        'scope_kind', p_scope_kind,
        'request_mode', 'manual',
        'human_review_required', true
      )
    );
  end if;
  v_response := jsonb_build_object(
    'summary_id', v_summary_id, 'version_number', v_version,
    'status', coalesce(v_status, 'queued'), 'summary_job_id', v_job_id,
    'source_fingerprint', v_source ->> 'source_fingerprint',
    'source_message_count', cardinality(v_ids),
    'scope_kind', p_scope_kind, 'scope_subject', v_subject,
    'deduplicated', not v_created,
    'human_review_required', true, 'originals_unaffected', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/summaries',
    p_idempotency_key, p_request_sha256, v_response, 202
  );
end;
$$;
