-- A summary only once there is enough conversation for one (owner, Sep 23
-- 2026: "it should be available once there is enough chats and info for
-- there to be one"). The final recap is three to ten short lines; asked of
-- one or two messages the model padded them out. A range now needs at least
-- three messages with text and 200 characters between them. The request
-- refuses a thinner range with summary_not_enough_conversation (422), and a
-- read tells the sheet, for every range at once, whether it qualifies, so
-- the chips and the button can say so before anyone asks.
--
-- Also: asking again after a failed recap of the same messages collided with
-- the failed row. The request only reuses a queued, processing or finished
-- row, but the uniqueness rule covered every status, so the retry answered
-- 409. Uniqueness now covers exactly the rows the request would reuse.
--
-- The request function is recreated whole from its 20260914230000 text with
-- one addition, the sufficiency check after the range checks; the wrapper
-- and grants are untouched.

create or replace function private.summary_minimum_messages()
returns integer
language sql
immutable
set search_path = ''
as $function$ select 3 $function$;

create or replace function private.summary_minimum_characters()
returns integer
language sql
immutable
set search_path = ''
as $function$ select 200 $function$;

create or replace function private.summary_sources_sufficient_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_ids bigint[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(cardinality(p_message_ids), 0) >= private.summary_minimum_messages()
    and coalesce((
      select sum(char_length(btrim(message.body)))
      from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.id = any (p_message_ids)
    ), 0) >= private.summary_minimum_characters()
$function$;

revoke all on function private.summary_minimum_messages() from public, anon, authenticated;
revoke all on function private.summary_minimum_characters() from public, anon, authenticated;
revoke all on function private.summary_sources_sufficient_internal(uuid, uuid, bigint[])
  from public, anon, authenticated;

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
  -- A recap needs something to recap: a few messages with some substance to
  -- them (owner, Sep 23 2026). The sheet asks the same helper first and
  -- keeps the button off until the range qualifies.
  if not private.summary_sources_sufficient_internal(
    p_organization_id, p_conversation_id, v_ids
  ) then
    raise exception 'summary_not_enough_conversation' using errcode = '42501';
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


drop index if exists public.conversation_summaries_reader_scope_unique_idx;
create unique index conversation_summaries_reader_scope_unique_idx
  on public.conversation_summaries (
    organization_id,
    conversation_id,
    source_fingerprint,
    language_code,
    coalesce(correction_of_summary_id, '00000000-0000-0000-0000-000000000000'::uuid),
    requested_by_user_id,
    scope_kind,
    coalesce(scope_subject, '')
  )
  where status in ('queued', 'processing', 'draft', 'approved');

-- Every range's size for this reader, from one pass over the chat: the same
-- messages the request would pick (text only, never system events, the
-- reader's history window, nothing hidden from them), counted per range.
create or replace function private.bff_read_summary_readiness_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_from_message_id bigint,
  p_utc_offset_minutes integer
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
  v_offset integer;
  v_midnight timestamptz;
  v_after_id bigint;
  v_counts record;
  v_minimum_messages integer := private.summary_minimum_messages();
  v_minimum_characters integer := private.summary_minimum_characters();
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, 'summary.readiness', false, 0
  );
  if coalesce(p_utc_offset_minutes, 0) not between -900 and 900
    or (p_from_message_id is not null and p_from_message_id < 1) then
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
  v_offset := coalesce(p_utc_offset_minutes, 0);
  v_midnight := (date_trunc('day', (now() + make_interval(mins => v_offset)) at time zone 'UTC')
    at time zone 'UTC') - make_interval(mins => v_offset);
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
  select
    count(*) filter (where eligible.id > v_after_id) as unread_messages,
    coalesce(sum(eligible.length) filter (where eligible.id > v_after_id), 0) as unread_characters,
    count(*) filter (where eligible.created_at >= v_midnight) as today_messages,
    coalesce(sum(eligible.length) filter (where eligible.created_at >= v_midnight), 0) as today_characters,
    count(*) filter (where eligible.created_at >= v_midnight - interval '1 day'
      and eligible.created_at < v_midnight) as yesterday_messages,
    coalesce(sum(eligible.length) filter (where eligible.created_at >= v_midnight - interval '1 day'
      and eligible.created_at < v_midnight), 0) as yesterday_characters,
    count(*) filter (where eligible.created_at >= v_midnight - interval '6 days') as week_messages,
    coalesce(sum(eligible.length) filter (where eligible.created_at >= v_midnight - interval '6 days'), 0) as week_characters,
    count(*) filter (where eligible.created_at >= v_midnight - interval '29 days') as month_messages,
    coalesce(sum(eligible.length) filter (where eligible.created_at >= v_midnight - interval '29 days'), 0) as month_characters,
    count(*) filter (where eligible.created_at >= v_midnight - interval '89 days') as quarter_messages,
    coalesce(sum(eligible.length) filter (where eligible.created_at >= v_midnight - interval '89 days'), 0) as quarter_characters,
    count(*) as all_messages,
    coalesce(sum(eligible.length), 0) as all_characters
    into v_counts
  from (
    select message.id, message.created_at, char_length(btrim(message.body)) as length
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
      and private.dynamic_group_message_access_allowed_for_user(
        message.organization_id, message.conversation_id, message.id, p_actor_user_id, now()
      )
  ) eligible;
  return jsonb_build_object(
    'schema_version', 1,
    'conversation_id', p_conversation_id,
    'minimum_messages', v_minimum_messages,
    'minimum_characters', v_minimum_characters,
    'ranges', jsonb_build_object(
      'unread', jsonb_build_object('messages', v_counts.unread_messages, 'characters', v_counts.unread_characters,
        'ready', v_counts.unread_messages between v_minimum_messages and 2000 and v_counts.unread_characters >= v_minimum_characters,
        'too_long', v_counts.unread_messages > 2000),
      'today', jsonb_build_object('messages', v_counts.today_messages, 'characters', v_counts.today_characters,
        'ready', v_counts.today_messages between v_minimum_messages and 2000 and v_counts.today_characters >= v_minimum_characters,
        'too_long', v_counts.today_messages > 2000),
      'yesterday', jsonb_build_object('messages', v_counts.yesterday_messages, 'characters', v_counts.yesterday_characters,
        'ready', v_counts.yesterday_messages between v_minimum_messages and 2000 and v_counts.yesterday_characters >= v_minimum_characters,
        'too_long', v_counts.yesterday_messages > 2000),
      'last_7_days', jsonb_build_object('messages', v_counts.week_messages, 'characters', v_counts.week_characters,
        'ready', v_counts.week_messages between v_minimum_messages and 2000 and v_counts.week_characters >= v_minimum_characters,
        'too_long', v_counts.week_messages > 2000),
      'last_30_days', jsonb_build_object('messages', v_counts.month_messages, 'characters', v_counts.month_characters,
        'ready', v_counts.month_messages between v_minimum_messages and 2000 and v_counts.month_characters >= v_minimum_characters,
        'too_long', v_counts.month_messages > 2000),
      'last_90_days', jsonb_build_object('messages', v_counts.quarter_messages, 'characters', v_counts.quarter_characters,
        'ready', v_counts.quarter_messages between v_minimum_messages and 2000 and v_counts.quarter_characters >= v_minimum_characters,
        'too_long', v_counts.quarter_messages > 2000),
      'everything', jsonb_build_object('messages', v_counts.all_messages, 'characters', v_counts.all_characters,
        'ready', v_counts.all_messages between v_minimum_messages and 2000 and v_counts.all_characters >= v_minimum_characters,
        'too_long', v_counts.all_messages > 2000)
    )
  );
end;
$function$;

revoke all on function private.bff_read_summary_readiness_impl(uuid, uuid, uuid, uuid, bigint, integer)
  from public, anon, authenticated;
grant execute on function private.bff_read_summary_readiness_impl(uuid, uuid, uuid, uuid, bigint, integer)
  to service_role;

create or replace function public.bff_read_summary_readiness(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_from_message_id bigint default null,
  p_utc_offset_minutes integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$ select private.bff_read_summary_readiness_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_from_message_id, p_utc_offset_minutes
) $function$;

revoke all on function public.bff_read_summary_readiness(uuid, uuid, uuid, uuid, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.bff_read_summary_readiness(uuid, uuid, uuid, uuid, bigint, integer)
  to service_role;
