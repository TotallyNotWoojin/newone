-- Backlog 45 and 47(e): editing and unsending both close fifteen minutes after
-- a message is sent, and both say so in a code the app has copy for.
--
-- The edit window already lived in this trigger; it raised a bare "not
-- permitted", which the gateway could only render as a generic refusal. It now
-- raises message_edit_window_closed. Unsending gains the matching window:
-- deleting your own message is bounded, deleting someone else's (moderation by
-- an owner or admin) is not.
--
-- The body below is the live definition read with pg_get_functiondef, with only
-- those two guards changed.

CREATE OR REPLACE FUNCTION private.validate_message_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_is_admin boolean := false;
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.sender_user_id is distinct from old.sender_user_id
    or new.client_nonce is distinct from old.client_nonce
    or new.kind is distinct from old.kind
    or new.reply_to_message_id is distinct from old.reply_to_message_id
    or new.thread_root_message_id is distinct from old.thread_root_message_id
    or new.available_at is distinct from old.available_at
    or new.created_at is distinct from old.created_at then
    raise exception 'message identity and threading fields are immutable' using errcode = '22000';
  end if;

  if old.deleted_at is not null then
    raise exception 'deleted messages are immutable' using errcode = '22000';
  end if;

  if coalesce(current_setting('app.scheduled_announcement_cancel_context', true), 'off') = 'on'
    and coalesce(current_setting('app.bff_service_context', true), 'off') = 'on' then
    if old.available_at <= now() or new.deleted_at is null
      or new.available_at is distinct from old.available_at then
      raise exception 'only an unpublished scheduled message may be cancelled'
        using errcode = '42501';
    end if;
    new.deleted_at := now();
    new.deleted_by_user_id := v_actor_id;
    new.deletion_reason := 'user';
    new.body := null;
    new.metadata := '{}'::jsonb;
    new.language_code := null;
    new.detected_language := null;
    new.language_detection_state := 'not_applicable';
    new.language_detection_method := null;
    new.language_detection_confidence := null;
    new.language_detected_at := now();
    perform private.delete_message_translations_internal(
      old.organization_id, old.conversation_id, old.id
    );
    perform private.mark_message_summaries_stale_internal(
      old.organization_id, old.conversation_id, old.id
    );
    return new;
  end if;

  if coalesce(current_setting('app.language_detection_context', true), 'off') = 'on' then
    if v_jwt_role <> 'service_role'
      and coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on'
      or new.body is distinct from old.body
      or new.metadata is distinct from old.metadata
      or new.language_code is distinct from old.language_code
      or new.edited_at is distinct from old.edited_at
      or new.deleted_at is distinct from old.deleted_at
      or new.deleted_by_user_id is distinct from old.deleted_by_user_id
      or new.deletion_reason is distinct from old.deletion_reason then
      raise exception 'language detection may only update trusted detection fields' using errcode = '42501';
    end if;
    return new;
  end if;

  if v_actor_id is null and v_jwt_role = 'service_role' then
    if new.deleted_at is not null then
      new.body := null;
      new.metadata := '{}'::jsonb;
      new.language_code := null;
      new.detected_language := null;
      new.language_detection_state := 'not_applicable';
      new.language_detection_method := null;
      new.language_detection_confidence := null;
      new.language_detected_at := now();
      new.deleted_by_user_id := null;
      new.deletion_reason := 'retention';
      perform private.delete_message_translations_internal(
        old.organization_id, old.conversation_id, old.id
      );
      update public.message_attachments attachment
      set scan_status = 'quarantined',
          scan_completed_at = coalesce(attachment.scan_completed_at, now()),
          scanner_name = coalesce(attachment.scanner_name, 'system-policy'),
          scanner_version = coalesce(attachment.scanner_version, 'retention-v1'),
          scan_failure_code = null,
          detected_mime_type = coalesce(attachment.detected_mime_type, attachment.mime_type),
          scan_policy_code = coalesce(attachment.scan_policy_code, 'retention_deleted'),
          purge_requested_at = coalesce(attachment.purge_requested_at, now())
      where attachment.organization_id = old.organization_id
        and attachment.conversation_id = old.conversation_id
        and attachment.message_id = old.id
        and attachment.scan_status <> 'quarantined';
      perform private.enqueue_outbox_job_internal(
        attachment.organization_id,
        'storage_purge',
        'attachment:' || attachment.id::text,
        jsonb_build_object('attachment_id', attachment.id)
      )
      from public.message_attachments attachment
      where attachment.organization_id = old.organization_id
        and attachment.conversation_id = old.conversation_id
        and attachment.message_id = old.id;
      perform private.mark_message_summaries_stale_internal(
        old.organization_id, old.conversation_id, old.id
      );
    elsif new.body is distinct from old.body then
      new.detected_language := null;
      new.language_detection_state := case when new.body is null then 'not_applicable' else 'pending' end;
      new.language_detection_method := null;
      new.language_detection_confidence := null;
      new.language_detected_at := case when new.body is null then now() else null end;
      perform private.delete_message_translations_internal(
        old.organization_id, old.conversation_id, old.id
      );
      perform private.mark_message_summaries_stale_internal(
        old.organization_id, old.conversation_id, old.id, 'source_changed'
      );
    end if;
    return new;
  end if;

  select exists (
    select 1
    from public.conversation_members conversation_member
    where conversation_member.organization_id = old.organization_id
      and conversation_member.conversation_id = old.conversation_id
      and conversation_member.user_id = v_actor_id
      and conversation_member.status = 'active'
      and conversation_member.role in ('owner', 'admin')
  ) into v_is_admin;

  if new.deleted_at is distinct from old.deleted_at then
    if new.deleted_at is null or (v_actor_id <> old.sender_user_id and not v_is_admin) then
      raise exception 'message deletion is not permitted' using errcode = '42501';
    end if;
    -- Unsending your own message closes on the same fifteen minutes as editing
    -- it. Removing somebody else's message is moderation, not unsending, and
    -- keeps no deadline.
    if v_actor_id = old.sender_user_id
      and old.created_at < now() - interval '15 minutes' then
      raise exception 'message_unsend_window_closed' using errcode = '42501';
    end if;
    if new.metadata is distinct from old.metadata
      or new.language_code is distinct from old.language_code then
      raise exception 'message deletion cannot rewrite message metadata' using errcode = '22000';
    end if;
    new.deleted_at := now();
    new.deleted_by_user_id := v_actor_id;
    new.deletion_reason := 'user';
    new.body := null;
    new.metadata := '{}'::jsonb;
    new.language_code := null;
    new.detected_language := null;
    new.language_detection_state := 'not_applicable';
    new.language_detection_method := null;
    new.language_detection_confidence := null;
    new.language_detected_at := now();
    perform private.delete_message_translations_internal(
      old.organization_id, old.conversation_id, old.id
    );
    update public.message_attachments attachment
    set scan_status = 'quarantined',
        scan_completed_at = coalesce(attachment.scan_completed_at, now()),
        scanner_name = coalesce(attachment.scanner_name, 'system-policy'),
        scanner_version = coalesce(attachment.scanner_version, 'message-delete-v1'),
        scan_failure_code = null,
        detected_mime_type = coalesce(attachment.detected_mime_type, attachment.mime_type),
        scan_policy_code = coalesce(attachment.scan_policy_code, 'message_deleted'),
        purge_requested_at = coalesce(attachment.purge_requested_at, now())
    where attachment.organization_id = old.organization_id
      and attachment.conversation_id = old.conversation_id
      and attachment.message_id = old.id
      and attachment.scan_status <> 'quarantined';
    perform private.enqueue_outbox_job_internal(
      attachment.organization_id,
      'storage_purge',
      'attachment:' || attachment.id::text,
      jsonb_build_object('attachment_id', attachment.id)
    )
    from public.message_attachments attachment
    where attachment.organization_id = old.organization_id
      and attachment.conversation_id = old.conversation_id
      and attachment.message_id = old.id;
    perform private.mark_message_summaries_stale_internal(
      old.organization_id, old.conversation_id, old.id
    );
    return new;
  end if;

  if new.body is distinct from old.body then
    if v_actor_id <> old.sender_user_id or old.created_at < now() - interval '15 minutes' then
      -- The message carries the code so the app can say what happened
      -- rather than showing a bare "not permitted".
      if v_actor_id <> old.sender_user_id then
        raise exception 'message edit is not permitted' using errcode = '42501';
      end if;
      raise exception 'message_edit_window_closed' using errcode = '42501';
    end if;
    if new.metadata is distinct from old.metadata
      or new.language_code is distinct from old.language_code
      or new.deleted_by_user_id is distinct from old.deleted_by_user_id then
      raise exception 'message edits may only change the body' using errcode = '22000';
    end if;
    new.edited_at := now();
    new.detected_language := null;
    new.language_detection_state := 'pending';
    new.language_detection_method := null;
    new.language_detection_confidence := null;
    new.language_detected_at := null;
    perform private.delete_message_translations_internal(
      old.organization_id, old.conversation_id, old.id
    );
    perform private.mark_message_summaries_stale_internal(
      old.organization_id, old.conversation_id, old.id, 'source_changed'
    );
    perform private.enqueue_outbox_job_internal(
      old.organization_id,
      'language_detection',
      'language-detection:' || old.organization_id::text || ':' || old.id::text || ':'
        || encode(extensions.digest(convert_to(new.body, 'UTF8'), 'sha256'), 'hex'),
      jsonb_build_object(
        'organization_id', old.organization_id,
        'conversation_id', old.conversation_id,
        'message_id', old.id,
        'source_sha256', encode(extensions.digest(convert_to(new.body, 'UTF8'), 'sha256'), 'hex'),
        'client_language_hint', old.language_code
      )
    );
    return new;
  end if;

  if new.metadata is distinct from old.metadata
    or new.language_code is distinct from old.language_code
    or new.detected_language is distinct from old.detected_language
    or new.language_detection_state is distinct from old.language_detection_state
    or new.language_detection_method is distinct from old.language_detection_method
    or new.language_detection_confidence is distinct from old.language_detection_confidence
    or new.language_detected_at is distinct from old.language_detected_at
    or new.edited_at is distinct from old.edited_at
    or new.deleted_by_user_id is distinct from old.deleted_by_user_id
    or new.deletion_reason is distinct from old.deletion_reason then
    raise exception 'message field is immutable' using errcode = '22000';
  end if;

  return new;
end;
$function$;
