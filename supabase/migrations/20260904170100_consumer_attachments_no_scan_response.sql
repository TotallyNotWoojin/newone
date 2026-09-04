-- The finalize response keeps its original shape. The previous migration
-- appended scan_status 'clean' and detected_mime_type to it; the app's strict
-- response parser refused the extra fields and showed "The secure service
-- returned an invalid response" on every photo send (device suite,
-- run-2026-09-04T11-00-15). The attachment row is still marked clean at
-- once; the app learns that through its state poll and invalidations.

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
    and attachment.scan_status = 'pending';
  update private.outbox_jobs job
  set status = 'completed', claimed_by = null, claimed_until = null,
      completed_at = now(), updated_at = now()
  where job.organization_id = p_organization_id
    and job.topic = 'storage_scan'
    and job.dedupe_key = 'attachment-scan:' || p_attachment_id::text
    and job.status in ('pending', 'failed');
  return v_response;
end;
$$;
