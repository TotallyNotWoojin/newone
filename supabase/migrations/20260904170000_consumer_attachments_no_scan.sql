-- Consumer uploads are available immediately: no scan step.
--
-- Owner request (Sep 4 2026): the quarantine-and-scan step on images was
-- unwanted for the consumer product. In the personal realm a finalized
-- upload is marked clean at once (scanner `consumer-no-scan`, detected type =
-- declared type) and its scan job is closed, so the card shows the file
-- right away and the download grant works without waiting for a worker.
-- Workspace organizations keep the scan.

alter function private.bff_finalize_attachment_upload_impl(
  uuid, uuid, uuid, uuid, text, text, bigint, text, text, text
) rename to bff_finalize_attachment_upload_pre_consumer_no_scan_impl;

create or replace function private.bff_finalize_attachment_upload_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_attachment_id uuid,
  p_bucket_id text,
  p_storage_path text,
  p_object_byte_size bigint,
  p_object_sha256_hex text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_response jsonb;
  v_declared_mime text;
begin
  v_response := private.bff_finalize_attachment_upload_pre_consumer_no_scan_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_attachment_id, p_bucket_id,
    p_storage_path, p_object_byte_size, p_object_sha256_hex, p_idempotency_key, p_request_sha256
  );
  if p_organization_id <> private.personal_realm_organization_id()
    or coalesce(v_response ->> 'scan_status', '') <> 'pending' then
    return v_response;
  end if;
  update public.message_attachments attachment
  set scan_status = 'clean',
      scan_completed_at = now(),
      scanner_name = 'consumer-no-scan',
      scanner_version = 'v1',
      scan_failure_code = null,
      detected_mime_type = lower(attachment.mime_type),
      scan_policy_code = null
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'pending'
  returning lower(attachment.mime_type) into v_declared_mime;
  if not found then
    return v_response;
  end if;
  update private.outbox_jobs job
  set status = 'completed', claimed_by = null, claimed_until = null,
      completed_at = now(), updated_at = now()
  where job.organization_id = p_organization_id
    and job.topic = 'storage_scan'
    and job.dedupe_key = 'attachment-scan:' || p_attachment_id::text
    and job.status in ('pending', 'failed');
  return v_response
    || jsonb_build_object('scan_status', 'clean', 'scan_queued', false, 'detected_mime_type', v_declared_mime);
end;
$$;

revoke all on function private.bff_finalize_attachment_upload_impl(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text) from public;
grant execute on function private.bff_finalize_attachment_upload_impl(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text) to service_role;
revoke all on function private.bff_finalize_attachment_upload_pre_consumer_no_scan_impl(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text) from public;
grant execute on function private.bff_finalize_attachment_upload_pre_consumer_no_scan_impl(uuid, uuid, uuid, uuid, text, text, bigint, text, text, text) to service_role;
