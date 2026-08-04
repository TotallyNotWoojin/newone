-- Closed incidents are durable operational records. Application RPCs already
-- make them read-only for posting; this trigger also prevents a privileged
-- maintenance path from silently reopening or rewriting the closure evidence.
create or replace function private.validate_conversation_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.kind is distinct from old.kind
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'conversation identity fields are immutable' using errcode = '22000';
  end if;

  if old.kind = 'direct' and (
    new.name is distinct from old.name
    or new.description is distinct from old.description
    or new.avatar_path is distinct from old.avatar_path
    or new.visibility is distinct from old.visibility
    or new.unit_id is distinct from old.unit_id
    or new.member_limit is distinct from old.member_limit
  ) then
    raise exception 'direct conversation metadata is immutable' using errcode = '22000';
  end if;

  if old.closed_at is not null and (
    new.closed_at is distinct from old.closed_at
    or new.closed_by_user_id is distinct from old.closed_by_user_id
    or new.closure_reason is distinct from old.closure_reason
    or new.incident_severity is distinct from old.incident_severity
    or new.incident_classification is distinct from old.incident_classification
  ) then
    raise exception 'closed incident record is immutable' using errcode = '22000';
  end if;

  return new;
end;
$$;

comment on function private.validate_conversation_update() is
  'Protects conversation identity and direct-chat metadata and makes completed incident closure evidence append-only.';
