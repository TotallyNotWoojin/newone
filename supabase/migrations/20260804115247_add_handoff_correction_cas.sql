begin;

-- Close the correction lost-update race without changing the legacy RPC
-- signature. The Edge BFF uses this versioned RPC and binds every correction
-- to the exact immutable version the supervisor reviewed.
create or replace function private.bff_correct_handoff_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_id uuid,
  p_expected_version_id uuid,
  p_expected_version_number integer,
  p_title text,
  p_details text,
  p_source_language text,
  p_shift_started_at timestamptz,
  p_shift_ended_at timestamptz,
  p_source_message_ids bigint[],
  p_acknowledgement_due_at timestamptz,
  p_reason text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_handoff public.shift_handoffs%rowtype;
  v_previous_version_id uuid;
  v_previous_version_number integer;
  v_version_id uuid;
  v_source_snapshot jsonb;
  v_response jsonb;
begin
  -- A completed command is returned before consulting current mutable state.
  -- This preserves exact response replay after the successful correction has
  -- necessarily made the caller's expected version stale.
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'handoff.correct', false, 0, '/v2/handoffs/:id/corrections',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then
    return v_command -> 'response';
  end if;

  if p_expected_version_id is null
    or p_expected_version_number is null
    or p_expected_version_number < 1 then
    raise exception 'expected handoff version is required' using errcode = '22023';
  end if;

  -- Every writer locks the mutable handoff before resolving the latest
  -- immutable version. Concurrent corrections therefore serialize here and
  -- the loser observes the winner's committed version.
  select * into v_handoff
  from public.shift_handoffs handoff
  where handoff.organization_id = p_organization_id
    and handoff.id = p_handoff_id
  for update;

  if not found
    or not private.is_conversation_admin(p_organization_id, v_handoff.conversation_id) then
    raise exception 'conversation supervisor permission required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 2000 then
    raise exception 'correction reason required' using errcode = '22023';
  end if;
  if p_shift_ended_at <= p_shift_started_at
    or (p_acknowledgement_due_at is not null
      and p_acknowledgement_due_at <= p_shift_ended_at) then
    raise exception 'valid handoff shift and acknowledgement deadline required'
      using errcode = '22023';
  end if;

  select version.id, version.version_number
    into v_previous_version_id, v_previous_version_number
  from public.handoff_versions version
  where version.organization_id = p_organization_id
    and version.handoff_id = p_handoff_id
  order by version.version_number desc
  limit 1;

  if not found
    or v_previous_version_id <> p_expected_version_id
    or v_previous_version_number <> p_expected_version_number then
    raise exception 'handoff version conflict' using errcode = '40001';
  end if;

  v_source_snapshot := private.handoff_source_snapshot_internal(
    p_organization_id, v_handoff.conversation_id, p_actor_user_id,
    coalesce(p_source_message_ids, array[]::bigint[])
  );

  update public.shift_handoffs handoff
  set title = p_title,
      details = p_details,
      source_language = p_source_language,
      shift_started_at = p_shift_started_at,
      shift_ended_at = p_shift_ended_at,
      source_message_ids = array(
        select jsonb_array_elements_text(v_source_snapshot -> 'source_message_ids')::bigint
      ),
      source_fingerprint = decode(v_source_snapshot ->> 'source_fingerprint', 'hex'),
      acknowledgement_due_at = p_acknowledgement_due_at,
      status = 'draft',
      submitted_at = null,
      submitted_version_id = null,
      signed_session_id = null,
      signed_device_id = null,
      signed_role_snapshot = null,
      signed_scope_snapshot = null,
      reminder_count = 0,
      last_reminded_at = null,
      escalated_at = null
  where handoff.organization_id = p_organization_id
    and handoff.id = p_handoff_id;

  insert into public.handoff_versions (
    organization_id, handoff_id, conversation_id, version_number, title,
    details, source_language, shift_started_at, shift_ended_at,
    source_message_ids, source_fingerprint, acknowledgement_due_at,
    correction_of_version_id, correction_reason, created_by_user_id
  ) values (
    p_organization_id, p_handoff_id, v_handoff.conversation_id,
    v_previous_version_number + 1, p_title, p_details, p_source_language,
    p_shift_started_at, p_shift_ended_at,
    array(select jsonb_array_elements_text(v_source_snapshot -> 'source_message_ids')::bigint),
    decode(v_source_snapshot ->> 'source_fingerprint', 'hex'),
    p_acknowledgement_due_at, v_previous_version_id, p_reason, p_actor_user_id
  ) returning id into v_version_id;

  v_response := jsonb_build_object(
    'handoff_id', p_handoff_id,
    'handoff_version_id', v_version_id,
    'version_number', v_previous_version_number + 1,
    'status', 'draft',
    'requires_signature', true,
    'source_message_ids', v_source_snapshot -> 'source_message_ids',
    'source_fingerprint', v_source_snapshot ->> 'source_fingerprint',
    'source_state', 'current',
    'acknowledgement_due_at', p_acknowledgement_due_at,
    'reminder_state', 'not_due',
    'escalation_state', 'not_due',
    'sms_fallback_available', false
  );

  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/handoffs/:id/corrections',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function public.bff_correct_handoff_v2(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_id uuid,
  p_expected_version_id uuid,
  p_expected_version_number integer,
  p_title text,
  p_details text,
  p_source_language text,
  p_shift_started_at timestamptz,
  p_shift_ended_at timestamptz,
  p_source_message_ids bigint[],
  p_acknowledgement_due_at timestamptz,
  p_reason text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_correct_handoff_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_handoff_id,
    p_expected_version_id, p_expected_version_number, p_title, p_details,
    p_source_language, p_shift_started_at, p_shift_ended_at,
    p_source_message_ids, p_acknowledgement_due_at, p_reason,
    p_idempotency_key, p_request_sha256
  )
$$;

revoke all on function private.bff_correct_handoff_v2_impl(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text,
  timestamptz, timestamptz, bigint[], timestamptz, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function private.bff_correct_handoff_v2_impl(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text,
  timestamptz, timestamptz, bigint[], timestamptz, text, text, text
) to service_role;

revoke all on function public.bff_correct_handoff_v2(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text,
  timestamptz, timestamptz, bigint[], timestamptz, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.bff_correct_handoff_v2(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text,
  timestamptz, timestamptz, bigint[], timestamptz, text, text, text
) to service_role;

comment on function public.bff_correct_handoff_v2(
  uuid, uuid, uuid, uuid, uuid, integer, text, text, text,
  timestamptz, timestamptz, bigint[], timestamptz, text, text, text
) is 'Creates one immutable corrected handoff version only when the exact expected version remains current; completed idempotent requests replay their original response.';

commit;
