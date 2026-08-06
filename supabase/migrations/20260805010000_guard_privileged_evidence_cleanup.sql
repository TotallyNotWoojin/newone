-- Allow database-owner maintenance to remove evidence only during an explicit,
-- transaction-local cleanup window. The gate never permits evidence updates,
-- and application/service roles cannot satisfy the current_user check even if
-- they set the custom GUC themselves.

create or replace function private.block_message_version_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'message versions are immutable' using errcode = '22000';
end;
$$;

create or replace function private.block_preservation_hold_delete()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'preservation holds are immutable records' using errcode = '22000';
end;
$$;

create or replace function private.prevent_immutable_record_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'immutable records cannot be updated or deleted' using errcode = '22000';
end;
$$;

create or replace function private.prevent_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'audit events are append-only' using errcode = '55000';
end;
$$;

create or replace function private.prevent_moderation_evidence_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'moderation evidence and case history are append-only' using errcode = '55000';
end;
$$;

create or replace function private.prevent_audit_export_receipt_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return old;
  end if;
  raise exception 'audit export receipts are append-only' using errcode = '55000';
end;
$$;

comment on function private.block_message_version_mutation() is
  'Rejects version mutation; database-owner DELETE is allowed only inside the transaction-local audited maintenance window.';
comment on function private.prevent_immutable_record_mutation() is
  'Rejects immutable-record mutation; database-owner DELETE is allowed only inside the transaction-local audited maintenance window.';
comment on function private.prevent_audit_mutation() is
  'Keeps audit events append-only; database-owner DELETE is allowed only inside the transaction-local audited maintenance window.';
