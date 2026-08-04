-- ADM-02: privileged, purpose-bound audit access and immutable export receipts.
-- Audit records intentionally exclude message bodies, attachment names, free-form
-- metadata, network identifiers, and user-agent fingerprints.

create table private.audit_export_receipts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  actor_user_id uuid not null,
  session_id uuid not null,
  request_id uuid,
  reason_code text not null,
  export_format text not null,
  date_from timestamptz not null,
  date_to timestamptz not null,
  snapshot_at timestamptz not null,
  filter_parameters jsonb not null,
  filter_sha256 bytea not null,
  row_count integer not null,
  payload_bytes integer not null,
  payload_sha256 bytea not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint audit_export_receipts_reason_allowed check (
    reason_code in ('security_review', 'compliance_review', 'incident_investigation', 'access_review')
  ),
  constraint audit_export_receipts_format_allowed check (export_format in ('json', 'csv')),
  constraint audit_export_receipts_range_bounded check (
    date_from <= date_to and date_to - date_from <= interval '31 days'
  ),
  constraint audit_export_receipts_snapshot_in_range check (
    snapshot_at >= date_from and snapshot_at <= date_to
  ),
  constraint audit_export_receipts_filter_object check (
    jsonb_typeof(filter_parameters) = 'object'
    and octet_length(filter_parameters::text) <= 8192
  ),
  constraint audit_export_receipts_filter_hash_length check (octet_length(filter_sha256) = 32),
  constraint audit_export_receipts_row_count_bounded check (row_count between 0 and 5000),
  constraint audit_export_receipts_payload_size_bounded check (
    payload_bytes between 1 and 2000000
  ),
  constraint audit_export_receipts_payload_hash_length check (octet_length(payload_sha256) = 32)
);

create table private.audit_query_receipts (
  id uuid primary key default extensions.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  actor_user_id uuid not null,
  session_id uuid not null,
  request_id uuid,
  reason_code text not null,
  date_from timestamptz not null,
  date_to timestamptz not null,
  snapshot_at timestamptz not null,
  filter_parameters jsonb not null,
  filter_sha256 bytea not null,
  page_limit integer not null,
  cursor_before_at timestamptz,
  cursor_before_id bigint,
  returned_first_at timestamptz,
  returned_first_id bigint,
  returned_last_at timestamptz,
  returned_last_id bigint,
  returned_rows integer not null,
  has_more boolean not null,
  next_cursor_sha256 bytea,
  created_at timestamptz not null default now(),
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint audit_query_receipts_reason_allowed check (
    reason_code in ('security_review', 'compliance_review', 'incident_investigation', 'access_review')
  ),
  constraint audit_query_receipts_range_bounded check (
    date_from <= date_to and date_to - date_from <= interval '90 days'
  ),
  constraint audit_query_receipts_snapshot_in_range check (
    snapshot_at >= date_from and snapshot_at <= date_to
  ),
  constraint audit_query_receipts_filter_object check (
    jsonb_typeof(filter_parameters) = 'object'
    and octet_length(filter_parameters::text) <= 8192
  ),
  constraint audit_query_receipts_filter_hash_length check (octet_length(filter_sha256) = 32),
  constraint audit_query_receipts_page_limit check (page_limit between 1 and 100),
  constraint audit_query_receipts_cursor_paired check (
    (cursor_before_at is null) = (cursor_before_id is null)
  ),
  constraint audit_query_receipts_returned_bounds check (
    returned_rows between 0 and page_limit
    and ((returned_rows = 0) = (returned_first_at is null))
    and ((returned_first_at is null) = (returned_first_id is null))
    and ((returned_last_at is null) = (returned_last_id is null))
    and ((returned_first_at is null) = (returned_last_at is null))
  ),
  constraint audit_query_receipts_next_cursor_consistent check (
    (has_more and next_cursor_sha256 is not null and octet_length(next_cursor_sha256) = 32)
    or (not has_more and next_cursor_sha256 is null)
  )
);

create index audit_export_receipts_org_cursor_idx
  on private.audit_export_receipts (organization_id, created_at desc, id desc);
create index audit_query_receipts_org_cursor_idx
  on private.audit_query_receipts (organization_id, created_at desc, id desc);

alter table private.audit_export_receipts enable row level security;
alter table private.audit_export_receipts force row level security;
alter table private.audit_query_receipts enable row level security;
alter table private.audit_query_receipts force row level security;

create or replace function private.prevent_audit_export_receipt_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'audit export receipts are append-only' using errcode = '55000';
end;
$$;

create trigger audit_export_receipts_immutable
before update or delete on private.audit_export_receipts
for each row execute function private.prevent_audit_export_receipt_mutation();

create trigger audit_query_receipts_immutable
before update or delete on private.audit_query_receipts
for each row execute function private.prevent_audit_export_receipt_mutation();

create or replace function private.audit_csv_cell(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select '"' || replace(
    case
      when coalesce(p_value, '') ~ '^[[:space:][:cntrl:]]*[=+@-]'
        then '''' || coalesce(p_value, '')
      else coalesce(p_value, '')
    end,
    '"', '""'
  ) || '"'
$$;

create or replace function private.record_audit_access_denial_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_operation text,
  p_denial_stage text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
begin
  perform private.require_service_role();
  if p_operation not in ('audit.query', 'audit.export')
    or p_denial_stage not in ('session_assurance', 'permission', 'edge_authorization') then
    raise exception 'invalid audit denial envelope' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
  ) then
    return jsonb_build_object('recorded', false);
  end if;
  if not private.consume_rate_limit(
    'audit-denial-hour',
    p_organization_id::text || ':' || p_actor_user_id::text || ':' || p_operation,
    300,
    3600
  ) then
    return jsonb_build_object('recorded', false);
  end if;
  begin
    v_request_id := nullif(
      nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-request-id',
      ''
    )::uuid;
  exception when others then
    v_request_id := null;
  end;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id,
    request_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'audit.access.denied', 'audit_log',
    p_actor_user_id::text, v_request_id,
    jsonb_build_object(
      'operation', p_operation,
      'denial_stage', p_denial_stage,
      'result', 'denied'
    )
  );
  return jsonb_build_object('recorded', true);
end;
$$;

create or replace function private.bff_query_audit_events_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_reason_code text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_event_types text[] default null,
  p_filter_actor_user_id uuid default null,
  p_target_type text default null,
  p_target_id text default null,
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_event_types text[];
  v_snapshot_at timestamptz;
  v_before_at timestamptz;
  v_before_id bigint;
  v_cursor_json jsonb;
  v_filter_json jsonb;
  v_filter_hash text;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_next_cursor text;
  v_last_at timestamptz;
  v_last_id bigint;
  v_first_at timestamptz;
  v_first_id bigint;
  v_query_receipt_id uuid;
  v_request_id uuid;
begin
  perform private.require_service_role();
  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'audit.query', true, 900
  );

  if not coalesce((v_authorization ->> 'allowed')::boolean, false) then
    perform private.record_audit_access_denial_internal(
      p_actor_user_id, p_organization_id, 'audit.query', 'session_assurance'
    );
    return jsonb_build_object('schema_version', 1, 'denied', true);
  end if;

  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
  ) then
    return jsonb_build_object('schema_version', 1, 'denied', true);
  end if;
  if not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'audit.read', null
  ) then
    perform private.record_audit_access_denial_internal(
      p_actor_user_id, p_organization_id, 'audit.query', 'permission'
    );
    return jsonb_build_object('schema_version', 1, 'denied', true);
  end if;

  select coalesce(array_agg(distinct event_type order by event_type), array[]::text[])
    into v_event_types
  from unnest(coalesce(p_event_types, array[]::text[])) event_type;

  if p_reason_code not in (
      'security_review', 'compliance_review', 'incident_investigation', 'access_review'
    )
    or p_date_from is null or p_date_to is null
    or not isfinite(p_date_from) or not isfinite(p_date_to)
    or p_date_from > p_date_to
    or p_date_to - p_date_from > interval '90 days'
    or p_date_from > clock_timestamp()
    or p_date_to > clock_timestamp() + interval '5 minutes'
    or p_limit not between 1 and 100
    or cardinality(v_event_types) > 10
    or exists (
      select 1 from unnest(v_event_types) event_type
      where char_length(event_type) not between 3 and 120
        or event_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$'
    )
    or (p_target_type is not null and (
      char_length(p_target_type) not between 2 and 80
      or p_target_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$'
    ))
    or (p_target_id is not null and (
      char_length(p_target_id) not between 1 and 240
      or p_target_id ~ '[[:cntrl:]]'
    )) then
    raise exception 'invalid audit query' using errcode = '22023';
  end if;

  if not private.consume_rate_limit(
    'audit-query-hour', p_organization_id::text || ':' || p_actor_user_id::text,
    300, 3600
  ) then
    raise exception 'audit query rate limit exceeded' using errcode = 'P0001';
  end if;

  v_filter_json := jsonb_strip_nulls(jsonb_build_object(
    'date_from', p_date_from,
    'date_to', p_date_to,
    'event_types', to_jsonb(v_event_types),
    'actor_user_id', p_filter_actor_user_id,
    'target_type', p_target_type,
    'target_id', p_target_id,
    'reason_code', p_reason_code
  ));
  v_filter_hash := encode(
    extensions.digest(convert_to(v_filter_json::text, 'UTF8'), 'sha256'), 'hex'
  );

  if p_cursor is null then
    v_snapshot_at := least(p_date_to, clock_timestamp());
  else
    begin
      if char_length(p_cursor) > 1536 or p_cursor !~ '^[A-Za-z0-9+/]+={0,2}$' then
        raise exception 'malformed cursor';
      end if;
      v_cursor_json := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      if jsonb_typeof(v_cursor_json) <> 'object'
        or (select count(*) from pg_catalog.jsonb_object_keys(v_cursor_json)) <> 5
        or not (v_cursor_json ?& array[
          'version', 'snapshot_at', 'before_at', 'before_id', 'filter_sha256'
        ])
        or v_cursor_json -> 'version' <> '1'::jsonb
        or coalesce(v_cursor_json ->> 'before_id', '') !~ '^[1-9][0-9]{0,18}$'
        or coalesce(v_cursor_json ->> 'filter_sha256', '') !~ '^[0-9a-f]{64}$' then
        raise exception 'malformed cursor payload';
      end if;
      v_snapshot_at := (v_cursor_json ->> 'snapshot_at')::timestamptz;
      v_before_at := (v_cursor_json ->> 'before_at')::timestamptz;
      v_before_id := (v_cursor_json ->> 'before_id')::bigint;
      if not isfinite(v_snapshot_at) or not isfinite(v_before_at)
        or v_snapshot_at < p_date_from or v_snapshot_at > p_date_to
        or v_snapshot_at > clock_timestamp() + interval '5 minutes'
        or v_before_at > v_snapshot_at
        or v_cursor_json ->> 'filter_sha256' <> v_filter_hash then
        raise exception 'cursor binding mismatch';
      end if;
    exception when others then
      raise exception 'invalid audit cursor' using errcode = '22023';
    end;
  end if;

  with page as (
    select event.id, event.actor_user_id, event.event_type, event.target_type,
      event.target_id, event.request_id, event.occurred_at,
      case
        when lower(coalesce(event.metadata ->> 'result', '')) in
          ('denied', 'forbidden', 'rejected') then 'denied'
        when lower(coalesce(event.metadata ->> 'result', '')) in
          ('failed', 'error') then 'failed'
        else 'succeeded'
      end as outcome
    from public.audit_events event
    where event.organization_id = p_organization_id
      and event.occurred_at >= p_date_from
      and event.occurred_at <= v_snapshot_at
      and (cardinality(v_event_types) = 0 or event.event_type = any(v_event_types))
      and (p_filter_actor_user_id is null or event.actor_user_id = p_filter_actor_user_id)
      and (p_target_type is null or event.target_type = p_target_type)
      and (p_target_id is null or event.target_id = p_target_id)
      and (p_cursor is null or (event.occurred_at, event.id) < (v_before_at, v_before_id))
    order by event.occurred_at desc, event.id desc
    limit p_limit + 1
  ), numbered as (
    select page.*, row_number() over (order by page.occurred_at desc, page.id desc) row_number
    from page
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', numbered.id::text,
      'actor_user_id', numbered.actor_user_id,
      'event_type', numbered.event_type,
      'target_type', numbered.target_type,
      'target_id', numbered.target_id,
      'request_id', numbered.request_id,
      'occurred_at', numbered.occurred_at,
      'outcome', numbered.outcome
    ) order by numbered.occurred_at desc, numbered.id desc)
      filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit
    into v_items, v_has_more
  from numbered;

  if v_has_more and jsonb_array_length(v_items) > 0 then
    v_last_at := (v_items -> (jsonb_array_length(v_items) - 1) ->> 'occurred_at')::timestamptz;
    v_last_id := (v_items -> (jsonb_array_length(v_items) - 1) ->> 'id')::bigint;
    v_next_cursor := replace(encode(convert_to(jsonb_build_object(
      'version', 1,
      'snapshot_at', v_snapshot_at,
      'before_at', v_last_at,
      'before_id', v_last_id::text,
      'filter_sha256', v_filter_hash
    )::text, 'UTF8'), 'base64'), E'\n', '');
  end if;

  if jsonb_array_length(v_items) > 0 then
    v_first_at := (v_items -> 0 ->> 'occurred_at')::timestamptz;
    v_first_id := (v_items -> 0 ->> 'id')::bigint;
    v_last_at := (v_items -> (jsonb_array_length(v_items) - 1) ->> 'occurred_at')::timestamptz;
    v_last_id := (v_items -> (jsonb_array_length(v_items) - 1) ->> 'id')::bigint;
  end if;

  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal', 'audit.query'
  );
  begin
    v_request_id := nullif(current_setting('app.audit_request_id', true), '')::uuid;
  exception when others then
    v_request_id := null;
  end;
  insert into private.audit_query_receipts (
    organization_id, actor_user_id, session_id, request_id, reason_code,
    date_from, date_to, snapshot_at, filter_parameters, filter_sha256,
    page_limit, cursor_before_at, cursor_before_id,
    returned_first_at, returned_first_id, returned_last_at, returned_last_id,
    returned_rows, has_more, next_cursor_sha256
  ) values (
    p_organization_id, p_actor_user_id, p_session_id, v_request_id, p_reason_code,
    p_date_from, p_date_to, v_snapshot_at, v_filter_json, decode(v_filter_hash, 'hex'),
    p_limit, v_before_at, v_before_id,
    v_first_at, v_first_id, v_last_at, v_last_id,
    jsonb_array_length(v_items), v_has_more,
    case when v_next_cursor is null then null else
      extensions.digest(convert_to(v_next_cursor, 'UTF8'), 'sha256') end
  ) returning id into v_query_receipt_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id,
    request_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'audit.accessed', 'audit_query_receipt',
    v_query_receipt_id::text, v_request_id,
    jsonb_build_object(
      'query_receipt_id', v_query_receipt_id,
      'reason_code', p_reason_code,
      'filter_sha256', v_filter_hash,
      'returned_rows', jsonb_array_length(v_items),
      'has_more', v_has_more,
      'result', 'committed'
    )
  );
  perform private.clear_bff_actor_context_internal();

  return jsonb_build_object(
    'schema_version', 1,
    'items', v_items,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more,
    'snapshot_at', v_snapshot_at,
    'filter_sha256', v_filter_hash,
    'receipt_id', v_query_receipt_id
  );
end;
$$;

create or replace function private.bff_export_audit_events_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_reason_code text,
  p_export_format text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_event_types text[] default null,
  p_filter_actor_user_id uuid default null,
  p_target_type text default null,
  p_target_id text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_event_types text[];
  v_snapshot_at timestamptz;
  v_filter_json jsonb;
  v_filter_hash bytea;
  v_rows jsonb := '[]'::jsonb;
  v_row_count integer;
  v_payload text;
  v_payload_bytes integer;
  v_payload_hash bytea;
  v_receipt_id uuid;
  v_exported_at timestamptz := clock_timestamp();
  v_request_id uuid;
begin
  perform private.require_service_role();
  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'audit.export', true, 900
  );
  if not coalesce((v_authorization ->> 'allowed')::boolean, false) then
    perform private.record_audit_access_denial_internal(
      p_actor_user_id, p_organization_id, 'audit.export', 'session_assurance'
    );
    return jsonb_build_object('schema_version', 1, 'denied', true);
  end if;
  if not exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
  ) then
    return jsonb_build_object('schema_version', 1, 'denied', true);
  end if;
  if not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'audit.read', null
  ) then
    perform private.record_audit_access_denial_internal(
      p_actor_user_id, p_organization_id, 'audit.export', 'permission'
    );
    return jsonb_build_object('schema_version', 1, 'denied', true);
  end if;

  select coalesce(array_agg(distinct event_type order by event_type), array[]::text[])
    into v_event_types
  from unnest(coalesce(p_event_types, array[]::text[])) event_type;
  if p_reason_code not in (
      'security_review', 'compliance_review', 'incident_investigation', 'access_review'
    )
    or p_export_format not in ('json', 'csv')
    or p_date_from is null or p_date_to is null
    or not isfinite(p_date_from) or not isfinite(p_date_to)
    or p_date_from > p_date_to
    or p_date_to - p_date_from > interval '31 days'
    or p_date_from > clock_timestamp()
    or p_date_to > clock_timestamp() + interval '5 minutes'
    or cardinality(v_event_types) > 10
    or exists (
      select 1 from unnest(v_event_types) event_type
      where char_length(event_type) not between 3 and 120
        or event_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,119}$'
    )
    or (p_target_type is not null and (
      char_length(p_target_type) not between 2 and 80
      or p_target_type !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,79}$'
    ))
    or (p_target_id is not null and (
      char_length(p_target_id) not between 1 and 240
      or p_target_id ~ '[[:cntrl:]]'
    )) then
    raise exception 'invalid audit export' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'audit-export-hour', p_organization_id::text || ':' || p_actor_user_id::text,
    10, 3600
  ) then
    raise exception 'audit export rate limit exceeded' using errcode = 'P0001';
  end if;

  v_snapshot_at := least(p_date_to, v_exported_at);
  v_filter_json := jsonb_strip_nulls(jsonb_build_object(
    'date_from', p_date_from,
    'date_to', p_date_to,
    'event_types', to_jsonb(v_event_types),
    'actor_user_id', p_filter_actor_user_id,
    'target_type', p_target_type,
    'target_id', p_target_id,
    'reason_code', p_reason_code
  ));
  v_filter_hash := extensions.digest(convert_to(v_filter_json::text, 'UTF8'), 'sha256');

  with export_rows as (
    select event.id, event.actor_user_id, event.event_type, event.target_type,
      event.target_id, event.request_id, event.occurred_at,
      case
        when lower(coalesce(event.metadata ->> 'result', '')) in
          ('denied', 'forbidden', 'rejected') then 'denied'
        when lower(coalesce(event.metadata ->> 'result', '')) in
          ('failed', 'error') then 'failed'
        else 'succeeded'
      end as outcome
    from public.audit_events event
    where event.organization_id = p_organization_id
      and event.occurred_at >= p_date_from
      and event.occurred_at <= v_snapshot_at
      and (cardinality(v_event_types) = 0 or event.event_type = any(v_event_types))
      and (p_filter_actor_user_id is null or event.actor_user_id = p_filter_actor_user_id)
      and (p_target_type is null or event.target_type = p_target_type)
      and (p_target_id is null or event.target_id = p_target_id)
    order by event.occurred_at desc, event.id desc
    limit 5001
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', export_rows.id::text,
    'actor_user_id', export_rows.actor_user_id,
    'event_type', export_rows.event_type,
    'target_type', export_rows.target_type,
    'target_id', export_rows.target_id,
    'request_id', export_rows.request_id,
    'occurred_at', export_rows.occurred_at,
    'outcome', export_rows.outcome
  ) order by export_rows.occurred_at desc, export_rows.id desc), '[]'::jsonb),
    count(*)::integer
  into v_rows, v_row_count
  from export_rows;
  if v_row_count > 5000 then
    raise exception 'audit export row limit exceeded' using errcode = '54000';
  end if;

  if p_export_format = 'json' then
    v_payload := jsonb_pretty(jsonb_build_object(
      'schema_version', 1,
      'generated_at', v_exported_at,
      'organization_id', p_organization_id,
      'snapshot_at', v_snapshot_at,
      'filter_sha256', encode(v_filter_hash, 'hex'),
      'events', v_rows
    ));
  else
    select 'event_id,actor_user_id,event_type,target_type,target_id,request_id,occurred_at,outcome'
      || case when count(*) = 0 then '' else E'\r\n' || string_agg(
        private.audit_csv_cell(row ->> 'id') || ',' ||
        private.audit_csv_cell(row ->> 'actor_user_id') || ',' ||
        private.audit_csv_cell(row ->> 'event_type') || ',' ||
        private.audit_csv_cell(row ->> 'target_type') || ',' ||
        private.audit_csv_cell(row ->> 'target_id') || ',' ||
        private.audit_csv_cell(row ->> 'request_id') || ',' ||
        private.audit_csv_cell(row ->> 'occurred_at') || ',' ||
        private.audit_csv_cell(row ->> 'outcome'),
        E'\r\n' order by ordinality
      ) end
      into v_payload
    from jsonb_array_elements(v_rows) with ordinality as item(row, ordinality);
  end if;

  v_payload_bytes := octet_length(convert_to(v_payload, 'UTF8'));
  if v_payload_bytes < 1 or v_payload_bytes > 2000000 then
    raise exception 'audit export payload limit exceeded' using errcode = '54000';
  end if;
  v_payload_hash := extensions.digest(convert_to(v_payload, 'UTF8'), 'sha256');

  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal', 'audit.export'
  );
  begin
    v_request_id := nullif(current_setting('app.audit_request_id', true), '')::uuid;
  exception when others then
    v_request_id := null;
  end;
  insert into private.audit_export_receipts (
    organization_id, actor_user_id, session_id, request_id, reason_code,
    export_format, date_from, date_to, snapshot_at, filter_parameters,
    filter_sha256, row_count, payload_bytes, payload_sha256, created_at
  ) values (
    p_organization_id, p_actor_user_id, p_session_id, v_request_id, p_reason_code,
    p_export_format, p_date_from, p_date_to, v_snapshot_at, v_filter_json,
    v_filter_hash, v_row_count, v_payload_bytes, v_payload_hash, v_exported_at
  ) returning id into v_receipt_id;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id,
    request_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'audit.exported', 'audit_export_receipt',
    v_receipt_id::text, v_request_id,
    jsonb_build_object(
      'reason_code', p_reason_code,
      'export_format', p_export_format,
      'filter_sha256', encode(v_filter_hash, 'hex'),
      'payload_sha256', encode(v_payload_hash, 'hex'),
      'row_count', v_row_count,
      'payload_bytes', v_payload_bytes,
      'result', 'committed'
    )
  );
  perform private.clear_bff_actor_context_internal();

  return jsonb_build_object(
    'schema_version', 1,
    'receipt_id', v_receipt_id,
    'format', p_export_format,
    'content_type', case when p_export_format = 'json'
      then 'application/json' else 'text/csv' end,
    'file_name', 'newone-audit-' || to_char(v_exported_at at time zone 'UTC', 'YYYYMMDD-HH24MISS')
      || '.' || p_export_format,
    'row_count', v_row_count,
    'payload_bytes', v_payload_bytes,
    'sha256', encode(v_payload_hash, 'hex'),
    'created_at', v_exported_at,
    'payload', v_payload
  );
end;
$$;

create or replace function public.bff_query_audit_events(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_reason_code text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_event_types text[] default null,
  p_filter_actor_user_id uuid default null,
  p_target_type text default null,
  p_target_id text default null,
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_query_audit_events_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_reason_code,
    p_date_from, p_date_to, p_event_types, p_filter_actor_user_id,
    p_target_type, p_target_id, p_cursor, p_limit
  )
$$;

create or replace function public.bff_record_audit_access_denial(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_operation text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.record_audit_access_denial_internal(
    p_actor_user_id, p_organization_id, p_operation, 'edge_authorization'
  )
$$;

create or replace function public.bff_export_audit_events(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_reason_code text,
  p_export_format text,
  p_date_from timestamptz,
  p_date_to timestamptz,
  p_event_types text[] default null,
  p_filter_actor_user_id uuid default null,
  p_target_type text default null,
  p_target_id text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_export_audit_events_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_reason_code,
    p_export_format, p_date_from, p_date_to, p_event_types,
    p_filter_actor_user_id, p_target_type, p_target_id
  )
$$;

-- General bootstrap is not an acceptable audit-read boundary. Keep the
-- capability visible, but require the dedicated purpose-bound query above.
create or replace function private.bff_bootstrap_messaging_state_v6_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_set(private.bff_bootstrap_messaging_state_v5_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  ), '{audit_events}', '[]'::jsonb, true)
$$;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid default null,
  p_before_message_id bigint default null,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_bootstrap_messaging_state_v6_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  )
$$;

drop policy if exists audit_events_select_admin on public.audit_events;
revoke select on table public.audit_events from authenticated;

revoke all on table
  private.audit_export_receipts,
  private.audit_query_receipts
from public, anon, authenticated, service_role;
revoke execute on function
  private.prevent_audit_export_receipt_mutation(),
  private.audit_csv_cell(text),
  private.record_audit_access_denial_internal(uuid, uuid, text, text),
  private.bff_query_audit_events_impl(uuid, uuid, uuid, text, timestamptz, timestamptz, text[], uuid, text, text, text, integer),
  private.bff_export_audit_events_impl(uuid, uuid, uuid, text, text, timestamptz, timestamptz, text[], uuid, text, text),
  private.bff_bootstrap_messaging_state_v6_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
from public, anon, authenticated, service_role;
grant execute on function
  private.record_audit_access_denial_internal(uuid, uuid, text, text),
  private.bff_query_audit_events_impl(uuid, uuid, uuid, text, timestamptz, timestamptz, text[], uuid, text, text, text, integer),
  private.bff_export_audit_events_impl(uuid, uuid, uuid, text, text, timestamptz, timestamptz, text[], uuid, text, text),
  private.bff_bootstrap_messaging_state_v6_impl(uuid, uuid, uuid, uuid, bigint, integer, integer)
to service_role;

revoke execute on function
  public.bff_record_audit_access_denial(uuid, uuid, text),
  public.bff_query_audit_events(uuid, uuid, uuid, text, timestamptz, timestamptz, text[], uuid, text, text, text, integer),
  public.bff_export_audit_events(uuid, uuid, uuid, text, text, timestamptz, timestamptz, text[], uuid, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.bff_record_audit_access_denial(uuid, uuid, text),
  public.bff_query_audit_events(uuid, uuid, uuid, text, timestamptz, timestamptz, text[], uuid, text, text, text, integer),
  public.bff_export_audit_events(uuid, uuid, uuid, text, text, timestamptz, timestamptz, text[], uuid, text, text)
to service_role;

comment on table private.audit_export_receipts is
  'Append-only ADM-02 receipts. Stores purpose, filters, and digests, never exported audit payloads.';
comment on table private.audit_query_receipts is
  'Append-only ADM-02 query receipts with normalized filters, snapshot, page boundary, and returned event bounds.';
comment on function public.bff_query_audit_events(uuid, uuid, uuid, text, timestamptz, timestamptz, text[], uuid, text, text, text, integer) is
  'Purpose-bound, recent-AAL2, cursor-safe audit query. Returns content-free audit envelopes only.';
comment on function public.bff_export_audit_events(uuid, uuid, uuid, text, text, timestamptz, timestamptz, text[], uuid, text, text) is
  'Bounded content-free JSON or CSV audit export with an immutable SHA-256 receipt.';
