-- A chat with a message from today sat below one nobody had touched since
-- last week. The list was ordered by conversations.updated_at, and nothing
-- bumps that row when a message arrives: on the live stack three conversations
-- carried messages 33 hours newer than the updated_at they were sorted by.
--
-- Order by the message the row actually shows instead, falling back to
-- updated_at for a conversation with no messages yet. Pinned first, then
-- favourites, then most recent - the shape was already right, only the time
-- was wrong. The pick-and-limit moves from `authorized` (which has not joined
-- the preview yet) down to `rows` (which has).

CREATE OR REPLACE FUNCTION private.bff_bootstrap_messaging_state_impl(p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid, p_selected_conversation_id uuid, p_before_message_id bigint, p_conversation_limit integer, p_timeline_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_selected_conversation_id uuid;
  v_conversations jsonb;
  v_timeline jsonb;
  v_has_more boolean;
  v_next_before bigint;
  v_history_visible_from timestamptz;
  v_selected_unit_id uuid;
  v_preferences jsonb;
  v_saved_contacts jsonb;
  v_member_blocks jsonb;
  v_can_review_language boolean := false;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'messaging.bootstrap.read', false, 0
  );
  if p_conversation_limit not between 1 and 200
    or p_timeline_limit not between 1 and 100 then
    raise exception 'invalid messaging bootstrap bounds' using errcode = '22023';
  end if;
  if p_selected_conversation_id is not null and not exists (
    select 1 from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = p_organization_id
      and member.conversation_id = p_selected_conversation_id
      and member.user_id = p_actor_user_id
      and member.status = 'active'
  ) then
    raise exception 'selected conversation not found' using errcode = 'P0002';
  end if;
  with authorized as (
    select conversation.*, member.role as member_role, member.notification_level,
      member.muted_until, member.history_visible_from,
      member.updated_at as membership_updated_at,
      preference.is_favorite, preference.is_pinned, preference.is_hidden,
      preference.notification_level as preference_notification_level,
      preference.muted_until as preference_muted_until,
      preference.user_id is not null as has_personal_preference
    from public.conversations conversation
    join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    left join public.conversation_preferences preference
      on preference.organization_id = member.organization_id
     and preference.conversation_id = member.conversation_id
     and preference.user_id = member.user_id
    where conversation.organization_id = p_organization_id
      and coalesce(preference.is_hidden, false) is false
  ), rows as (
    select authorized.*, preview.id as preview_id, preview.sender_user_id as preview_sender_user_id,
      preview.kind as preview_kind, preview.body as preview_body,
      preview.created_at as preview_created_at, preview.edited_at as preview_edited_at,
      read_cursor.last_read_message_id,
      (select count(*) from public.messages unread
       where unread.organization_id = authorized.organization_id
         and unread.conversation_id = authorized.id
         and unread.deleted_at is null
         and unread.available_at <= now()
         and (authorized.history_visible_from is null
           or unread.created_at >= authorized.history_visible_from)
         and unread.id > coalesce(read_cursor.last_read_message_id, 0)
         and unread.sender_user_id <> p_actor_user_id
         and not exists (
           select 1 from public.message_user_visibility visibility
           where visibility.organization_id = unread.organization_id
             and visibility.conversation_id = unread.conversation_id
             and visibility.message_id = unread.id
             and visibility.user_id = p_actor_user_id
         )) as unread_count
    from authorized
    left join lateral (
      select message.* from public.messages message
      where message.organization_id = authorized.organization_id
        and message.conversation_id = authorized.id
        and message.deleted_at is null
        and message.available_at <= now()
        and (authorized.history_visible_from is null
          or message.created_at >= authorized.history_visible_from)
        and not exists (
          select 1 from public.message_user_visibility visibility
          where visibility.organization_id = message.organization_id
            and visibility.conversation_id = message.conversation_id
            and visibility.message_id = message.id
            and visibility.user_id = p_actor_user_id
        )
      order by message.created_at desc, message.id desc limit 1
    ) preview on true
    left join public.conversation_read_cursors read_cursor
      on read_cursor.organization_id = authorized.organization_id
     and read_cursor.conversation_id = authorized.id
     and read_cursor.user_id = p_actor_user_id
    order by coalesce(authorized.is_pinned, false) desc,
      coalesce(authorized.is_favorite, false) desc,
      coalesce(preview.created_at, authorized.updated_at) desc, authorized.id
    limit p_conversation_limit
  )
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'conversation_id', rows.id,
    'kind', rows.kind,
    'name', rows.name,
    'description', rows.description,
    'avatar_path', rows.avatar_path,
    'is_archived', rows.is_archived,
    'updated_at', rows.updated_at,
    'member_role', rows.member_role,
    'preferences', jsonb_build_object(
      'is_favorite', coalesce(rows.is_favorite, false),
      'is_pinned', coalesce(rows.is_pinned, false),
      'notification_level', coalesce(rows.preference_notification_level, rows.notification_level, 'all'),
      'muted_until', case when rows.has_personal_preference
        then rows.preference_muted_until else rows.muted_until end
    ),
    'last_read_message_id', rows.last_read_message_id,
    'unread_count', rows.unread_count,
    'preview', case when rows.preview_id is null then null else jsonb_build_object(
      'message_id', rows.preview_id,
      'sender_user_id', rows.preview_sender_user_id,
      'kind', rows.preview_kind,
      'body', rows.preview_body,
      'created_at', rows.preview_created_at,
      'edited_at', rows.preview_edited_at
    ) end
  )) order by coalesce(rows.is_pinned, false) desc,
    coalesce(rows.is_favorite, false) desc,
    coalesce(rows.preview_created_at, rows.updated_at) desc, rows.id), '[]'::jsonb),
    coalesce(p_selected_conversation_id, (array_agg(rows.id order by
      coalesce(rows.is_pinned, false) desc, coalesce(rows.is_favorite, false) desc,
      coalesce(rows.preview_created_at, rows.updated_at) desc, rows.id))[1])
  into v_conversations, v_selected_conversation_id
  from rows;

  if v_selected_conversation_id is not null then
    select member.history_visible_from, conversation.unit_id
      into v_history_visible_from, v_selected_unit_id
    from public.conversation_members member
    join public.conversations conversation
      on conversation.organization_id = member.organization_id
     and conversation.id = member.conversation_id
    where member.organization_id = p_organization_id
      and member.conversation_id = v_selected_conversation_id
      and member.user_id = p_actor_user_id
      and member.status = 'active';
    v_can_review_language := private.actor_has_permission(
      p_actor_user_id,
      p_organization_id,
      'language.review',
      v_selected_unit_id
    );
    with page as (
      select message.*
      from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = v_selected_conversation_id
        and message.deleted_at is null
        and message.available_at <= now()
        and (v_history_visible_from is null
          or message.created_at >= v_history_visible_from)
        and (p_before_message_id is null or message.id < p_before_message_id)
        and not exists (
          select 1 from public.message_user_visibility visibility
          where visibility.organization_id = message.organization_id
            and visibility.conversation_id = message.conversation_id
            and visibility.message_id = message.id
            and visibility.user_id = p_actor_user_id
        )
      order by message.created_at desc, message.id desc
      limit p_timeline_limit + 1
    ), numbered as (
      select page.*, row_number() over (order by page.created_at desc, page.id desc) row_number
      from page
    )
    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'message_id', numbered.id,
      'conversation_id', numbered.conversation_id,
      'client_nonce', numbered.client_nonce,
      'kind', numbered.kind,
      'body', numbered.body,
      'client_language_hint', numbered.language_code,
      'detected_language', numbered.detected_language,
      'language_detection_state', numbered.language_detection_state,
      'language_detection_method', numbered.language_detection_method,
      'language_detection_confidence', numbered.language_detection_confidence,
      'language_detected_at', numbered.language_detected_at,
      'sender', jsonb_build_object(
        'user_id', numbered.sender_user_id,
        'display_name', sender.display_name,
        'avatar_path', sender.avatar_path
      ),
      'created_at', numbered.created_at,
      'edited_at', numbered.edited_at,
      'thread_root_message_id', numbered.thread_root_message_id,
      'reply', case when reply.id is null then null else jsonb_build_object(
        'message_id', reply.id,
        'sender_user_id', reply.sender_user_id,
        'kind', reply.kind,
        'body', left(reply.body, 240)
      ) end,
      'mentions', (select coalesce(jsonb_agg(mention.mentioned_user_id order by mention.mentioned_user_id), '[]'::jsonb)
        from public.message_mentions mention where mention.organization_id = numbered.organization_id
          and mention.conversation_id = numbered.conversation_id and mention.message_id = numbered.id),
      'reactions', (select coalesce(jsonb_agg(jsonb_build_object(
          'emoji', reaction.emoji, 'user_id', reaction.user_id
        ) order by reaction.created_at, reaction.user_id), '[]'::jsonb)
        from public.message_reactions reaction where reaction.organization_id = numbered.organization_id
          and reaction.conversation_id = numbered.conversation_id and reaction.message_id = numbered.id),
      'receipt', case when numbered.sender_user_id = p_actor_user_id then (
        -- Senders receive privacy-safe aggregate counts only. Read eligibility
        -- is computed before counting, so nobody/contacts preferences cannot
        -- be reverse-engineered through a raw receipt total. No recipient
        -- identity or per-user detail crosses this DTO boundary.
        select jsonb_build_object(
          'scope', 'aggregate',
          'recipient_count', count(*),
          'delivered_count', count(*) filter (
            where receipt.delivered_at is not null
          ),
          'visible_read_eligible_count', count(*) filter (where
            coalesce(receipt_preference.read_visibility, 'everyone') = 'everyone'
            or (
              coalesce(receipt_preference.read_visibility, 'everyone') = 'contacts'
              and receipt_connection.status = 'accepted'
            )
          ),
          'visible_read_count', count(*) filter (where
            receipt.read_at is not null
            and (
              coalesce(receipt_preference.read_visibility, 'everyone') = 'everyone'
              or (
                coalesce(receipt_preference.read_visibility, 'everyone') = 'contacts'
                and receipt_connection.status = 'accepted'
              )
            )
          ),
          'delivered', coalesce(bool_or(receipt.delivered_at is not null), false),
          'delivered_at', min(receipt.delivered_at),
          'read', coalesce(bool_or(
            receipt.read_at is not null and (
              coalesce(receipt_preference.read_visibility, 'everyone') = 'everyone'
              or (
                coalesce(receipt_preference.read_visibility, 'everyone') = 'contacts'
                and receipt_connection.status = 'accepted'
              )
            )
          ), false),
          'read_at', min(receipt.read_at) filter (where
            coalesce(receipt_preference.read_visibility, 'everyone') = 'everyone'
            or (
              coalesce(receipt_preference.read_visibility, 'everyone') = 'contacts'
              and receipt_connection.status = 'accepted'
            )
          )
        )
        from public.conversation_members receipt_member
        join public.organization_memberships receipt_organization_member
          on receipt_organization_member.organization_id = receipt_member.organization_id
         and receipt_organization_member.user_id = receipt_member.user_id
         and receipt_organization_member.status = 'active'
        left join public.message_receipts receipt
          on receipt.organization_id = numbered.organization_id
         and receipt.conversation_id = numbered.conversation_id
         and receipt.message_id = numbered.id
         and receipt.user_id = receipt_member.user_id
        left join public.organization_user_preferences receipt_preference
          on receipt_preference.organization_id = receipt_member.organization_id
         and receipt_preference.user_id = receipt_member.user_id
        left join public.contact_connections receipt_connection
          on receipt_connection.organization_id = receipt_member.organization_id
         and receipt_connection.member_low_user_id = least(
           numbered.sender_user_id, receipt_member.user_id
         )
         and receipt_connection.member_high_user_id = greatest(
           numbered.sender_user_id, receipt_member.user_id
         )
         and receipt_connection.status = 'accepted'
        where receipt_member.organization_id = numbered.organization_id
          and receipt_member.conversation_id = numbered.conversation_id
          and receipt_member.status = 'active'
          and receipt_member.user_id <> numbered.sender_user_id
          and (receipt_member.history_visible_from is null
            or numbered.created_at >= receipt_member.history_visible_from)
          and not exists (
            select 1 from public.message_user_visibility receipt_visibility
            where receipt_visibility.organization_id = numbered.organization_id
              and receipt_visibility.conversation_id = numbered.conversation_id
              and receipt_visibility.message_id = numbered.id
              and receipt_visibility.user_id = receipt_member.user_id
          )
      ) else (
        -- A recipient can always reconcile their own local state, regardless
        -- of whether they elect to expose read state back to the sender.
        select jsonb_build_object(
          'scope', 'self',
          'delivered', coalesce(bool_or(receipt.delivered_at is not null), false),
          'delivered_at', min(receipt.delivered_at),
          'read', coalesce(bool_or(receipt.read_at is not null), false),
          'read_at', min(receipt.read_at)
        )
        from public.message_receipts receipt
        where receipt.organization_id = numbered.organization_id
          and receipt.conversation_id = numbered.conversation_id
          and receipt.message_id = numbered.id
          and receipt.user_id = p_actor_user_id
      ) end,
      'pinned', exists (select 1 from public.message_pins pin where pin.organization_id = numbered.organization_id
          and pin.conversation_id = numbered.conversation_id and pin.message_id = numbered.id),
      'translations', (select coalesce(jsonb_agg(jsonb_build_object(
          'translation_id', translation.id,
          'source_language', translation.source_language,
          'target_language', translation.target_language,
          'source_body_sha256', encode(translation.source_body_sha256, 'hex'),
          'translated_body', translation.translated_body,
          'status', translation.status,
          'provider', translation.provider,
          'model', translation.model,
          'confidence', translation.confidence,
          'reviewed_by_user_id', translation.reviewed_by_user_id,
          'reviewed_at', translation.reviewed_at,
          'failure_code', translation.failure_code,
          'policy_version', case
            when coalesce(translation_job.payload ->> 'ai_policy_version', '') ~ '^[1-9][0-9]*$'
              then (translation_job.payload ->> 'ai_policy_version')::integer
            else null
          end,
          'latest_correction', latest_correction.payload,
          'created_at', translation.created_at,
          'updated_at', translation.updated_at
        ) order by translation.target_language), '[]'::jsonb)
        from public.message_translations translation
        left join private.outbox_jobs translation_job
          on translation_job.topic = 'translation'
         and translation_job.dedupe_key = 'translation:' || translation.id::text
        left join lateral (
          select jsonb_strip_nulls(
            jsonb_build_object(
              'correction_id', correction.id,
              'status', correction.status,
              'corrected_body', correction.corrected_body,
              'rationale', correction.rationale,
              'created_at', correction.created_at,
              'updated_at', correction.updated_at
            ) || case when v_can_review_language then jsonb_build_object(
              'proposed_by_user_id', correction.proposed_by_user_id,
              'reviewed_by_user_id', correction.reviewed_by_user_id,
              'reviewed_at', correction.reviewed_at,
              'review_note', correction.review_note
            ) else '{}'::jsonb end
          ) as payload
          from public.translation_corrections correction
          where correction.organization_id = translation.organization_id
            and correction.conversation_id = translation.conversation_id
            and correction.message_id = translation.message_id
            and correction.target_language = translation.target_language
            and (v_can_review_language or correction.status = 'approved')
          order by correction.created_at desc, correction.id desc
          limit 1
        ) latest_correction on true
        where translation.organization_id = numbered.organization_id
          and translation.conversation_id = numbered.conversation_id
          and translation.message_id = numbered.id
          and translation.source_body_sha256 = extensions.digest(
            convert_to(numbered.body, 'UTF8'), 'sha256'
          )
          and translation.status in ('completed', 'queued', 'processing', 'failed', 'blocked')),
      'attachments', (select coalesce(jsonb_agg(jsonb_build_object(
          'attachment_id', attachment.id, 'file_name', attachment.file_name,
          'mime_type', attachment.mime_type, 'byte_size', attachment.byte_size,
          'scan_status', attachment.scan_status,
          'scan_failure_code', attachment.scan_failure_code,
          'detected_mime_type', attachment.detected_mime_type,
          'scan_policy_code', attachment.scan_policy_code,
          'created_by_user_id', attachment.created_by_user_id,
          'created_at', attachment.created_at
        ) order by attachment.created_at, attachment.id), '[]'::jsonb)
        from public.message_attachments attachment
        where attachment.organization_id = numbered.organization_id
          and attachment.conversation_id = numbered.conversation_id
          and attachment.message_id = numbered.id
          and (attachment.created_by_user_id = p_actor_user_id
            or attachment.scan_status = 'clean')),
      'forward', case when forward.target_message_id is null then null else
        case when exists (
          select 1
          from public.conversation_members source_member
          join public.messages source_message
            on source_message.organization_id = source_member.organization_id
           and source_message.conversation_id = source_member.conversation_id
           and source_message.id = forward.source_message_id
           and source_message.deleted_at is null
           and source_message.available_at <= now()
          where source_member.organization_id = numbered.organization_id
            and source_member.conversation_id = forward.source_conversation_id
            and source_member.user_id = p_actor_user_id
            and source_member.status = 'active'
            and (source_member.history_visible_from is null
              or source_message.created_at >= source_member.history_visible_from)
        )
          then jsonb_build_object('forwarded', true, 'source_conversation_id', forward.source_conversation_id,
            'source_message_id', forward.source_message_id)
          else jsonb_build_object('forwarded', true) end end
    )) || case when numbered.kind = 'system' then jsonb_build_object(
        'system_event', jsonb_build_object(
          'event_type', numbered.metadata ->> 'event_type',
          'target_user_id', numbered.metadata ->> 'target_user_id'
        )
      ) else '{}'::jsonb end order by numbered.created_at, numbered.id) filter (where numbered.row_number <= p_timeline_limit), '[]'::jsonb),
      count(*) > p_timeline_limit,
      min(numbered.id) filter (where numbered.row_number <= p_timeline_limit)
    into v_timeline, v_has_more, v_next_before
    from numbered
    join public.profiles sender on sender.user_id = numbered.sender_user_id
    left join public.messages reply
      on reply.organization_id = numbered.organization_id
     and reply.conversation_id = numbered.conversation_id
     and reply.id = numbered.reply_to_message_id
     and reply.deleted_at is null
     and reply.available_at <= now()
     and (v_history_visible_from is null or reply.created_at >= v_history_visible_from)
     and not exists (
       select 1 from public.message_user_visibility visibility
       where visibility.organization_id = reply.organization_id
         and visibility.conversation_id = reply.conversation_id
         and visibility.message_id = reply.id and visibility.user_id = p_actor_user_id
     )
    left join public.message_forward_provenance forward
      on forward.organization_id = numbered.organization_id
     and forward.target_conversation_id = numbered.conversation_id
     and forward.target_message_id = numbered.id;
  else
    v_timeline := '[]'::jsonb; v_has_more := false; v_next_before := null;
  end if;

  select jsonb_strip_nulls(jsonb_build_object(
    'ui_language', coalesce(preference.ui_language, profile.preferred_language, 'en'),
    'message_language', preference.message_language,
    'time_zone', coalesce(preference.time_zone, profile.time_zone, 'UTC'),
    'quiet_hours_start', preference.quiet_hours_start,
    'quiet_hours_end', preference.quiet_hours_end,
    'quiet_days', coalesce(to_jsonb(preference.quiet_days), '[0,1,2,3,4,5,6]'::jsonb),
    'notification_preview', coalesce(preference.notification_preview, 'generic'),
    'sound_enabled', coalesce(preference.sound_enabled, true),
    'vibration_enabled', coalesce(preference.vibration_enabled, true),
    'shift_aware_suppression', coalesce(preference.shift_aware_suppression, false),
    'read_visibility', coalesce(preference.read_visibility, 'everyone')
  )) into v_preferences
  from public.profiles profile
  left join public.organization_user_preferences preference
    on preference.organization_id = p_organization_id and preference.user_id = profile.user_id
  where profile.user_id = p_actor_user_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'contact_user_id', contact.contact_user_id,
    'alias', contact.alias,
    'is_favorite', contact.is_favorite,
    'updated_at', contact.updated_at
  ) order by contact.is_favorite desc, contact.updated_at desc, contact.contact_user_id), '[]'::jsonb)
  into v_saved_contacts from public.saved_contacts contact
  join public.organization_memberships membership
    on membership.organization_id = contact.organization_id
   and membership.user_id = contact.contact_user_id and membership.status = 'active'
  where contact.organization_id = p_organization_id and contact.owner_user_id = p_actor_user_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'blocked_user_id', block.blocked_user_id, 'blocked_at', block.created_at
  ) order by block.created_at desc, block.blocked_user_id), '[]'::jsonb)
  into v_member_blocks from public.member_blocks block
  where block.organization_id = p_organization_id and block.blocker_user_id = p_actor_user_id;
  return jsonb_build_object(
    'organization_id', p_organization_id,
    'user_id', p_actor_user_id,
    'preferences', v_preferences,
    'saved_contacts', v_saved_contacts,
    'member_blocks', v_member_blocks,
    'conversations', v_conversations,
    'selected_conversation_id', v_selected_conversation_id,
    'timeline', jsonb_build_object(
      'messages', v_timeline,
      'has_more', coalesce(v_has_more, false),
      'next_before_message_id', case when v_has_more then v_next_before else null end
    ),
    'reconcile_after', now()
  );
end;
$function$
;
