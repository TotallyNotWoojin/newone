begin;

-- Translation preferences are personal and conversation scoped. Derived
-- translations may be shared by recipients that need the same target language,
-- but an opted-out member never contributes a target and never receives the
-- derived projection through the bounded BFF read APIs.
alter table public.conversation_preferences
  add column translation_mode text not null default 'automatic';

alter table public.conversation_preferences
  add constraint conversation_preferences_translation_mode_allowed
  check (translation_mode in ('automatic', 'off'));

create or replace function private.translation_mode_for_user_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_user_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.user_id = p_user_id
        and member.status = 'active'
    ) then coalesce((
      select preference.translation_mode
      from public.conversation_preferences preference
      where preference.organization_id = p_organization_id
        and preference.conversation_id = p_conversation_id
        and preference.user_id = p_user_id
    ), 'automatic')
    else 'off'
  end
$$;

create or replace function private.bff_update_conversation_preferences_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_patch jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_preference public.conversation_preferences%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.preferences.update', false, 0,
    '/v2/conversations/:id/preferences', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id) then
    raise exception 'conversation membership required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_patch) <> 'object'
    or p_patch = '{}'::jsonb
    or exists (
      select 1 from jsonb_object_keys(p_patch) key
      where key not in (
        'is_favorite', 'is_pinned', 'is_hidden', 'notification_level',
        'muted_until', 'translation_mode'
      )
    )
    or exists (
      select 1 from (values ('is_favorite'), ('is_pinned'), ('is_hidden')) boolean_key(name)
      where p_patch ? boolean_key.name
        and jsonb_typeof(p_patch -> boolean_key.name) <> 'boolean'
    )
    or (
      p_patch ? 'notification_level'
      and p_patch ->> 'notification_level' not in ('all', 'mentions', 'none')
    )
    or (
      p_patch ? 'translation_mode'
      and p_patch ->> 'translation_mode' not in ('automatic', 'off')
    ) then
    raise exception 'invalid conversation preference patch' using errcode = '22023';
  end if;

  insert into public.conversation_preferences (
    organization_id, conversation_id, user_id, is_favorite, is_pinned,
    is_hidden, notification_level, muted_until, translation_mode
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id,
    case when p_patch ? 'is_favorite' then (p_patch ->> 'is_favorite')::boolean else false end,
    case when p_patch ? 'is_pinned' then (p_patch ->> 'is_pinned')::boolean else false end,
    case when p_patch ? 'is_hidden' then (p_patch ->> 'is_hidden')::boolean else false end,
    case when p_patch ? 'notification_level' then p_patch ->> 'notification_level' else 'all' end,
    case when p_patch ? 'muted_until' and p_patch -> 'muted_until' <> 'null'::jsonb
      then (p_patch ->> 'muted_until')::timestamptz else null end,
    case when p_patch ? 'translation_mode' then p_patch ->> 'translation_mode' else 'automatic' end
  )
  on conflict (organization_id, conversation_id, user_id) do update
  set is_favorite = case when p_patch ? 'is_favorite'
        then (p_patch ->> 'is_favorite')::boolean else public.conversation_preferences.is_favorite end,
      is_pinned = case when p_patch ? 'is_pinned'
        then (p_patch ->> 'is_pinned')::boolean else public.conversation_preferences.is_pinned end,
      is_hidden = case when p_patch ? 'is_hidden'
        then (p_patch ->> 'is_hidden')::boolean else public.conversation_preferences.is_hidden end,
      notification_level = case when p_patch ? 'notification_level'
        then p_patch ->> 'notification_level' else public.conversation_preferences.notification_level end,
      muted_until = case when p_patch ? 'muted_until'
        then case when p_patch -> 'muted_until' = 'null'::jsonb then null
          else (p_patch ->> 'muted_until')::timestamptz end
        else public.conversation_preferences.muted_until end,
      translation_mode = case when p_patch ? 'translation_mode'
        then p_patch ->> 'translation_mode' else public.conversation_preferences.translation_mode end,
      updated_at = now()
  returning * into v_preference;
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'is_favorite', v_preference.is_favorite,
    'is_pinned', v_preference.is_pinned,
    'is_hidden', v_preference.is_hidden,
    'notification_level', v_preference.notification_level,
    'muted_until', v_preference.muted_until,
    'translation_mode', v_preference.translation_mode,
    'updated_at', v_preference.updated_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/preferences',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_send_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_kind text,
  p_body text,
  p_language_code text,
  p_reply_to_message_id bigint,
  p_thread_root_message_id bigint,
  p_metadata jsonb,
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
  v_message_id bigint;
  v_target_language text;
  v_translation_id bigint;
  v_translation_targets text[] := array[]::text[];
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.send', false, 0, '/v2/conversations/:id/messages',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  v_message_id := private.send_message(
    p_organization_id, p_conversation_id, p_client_nonce, p_kind, p_body,
    p_language_code, p_reply_to_message_id, p_thread_root_message_id, p_metadata
  );
  -- Only active recipients that explicitly remain in automatic mode contribute
  -- their server-owned language. The client has no target-language input.
  if p_body is not null then
    for v_target_language in
      select distinct lower(coalesce(preference.message_language, profile.preferred_language))
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      join public.profiles profile on profile.user_id = member.user_id
      left join public.organization_user_preferences preference
        on preference.organization_id = member.organization_id
       and preference.user_id = member.user_id
      left join public.conversation_preferences conversation_preference
        on conversation_preference.organization_id = member.organization_id
       and conversation_preference.conversation_id = member.conversation_id
       and conversation_preference.user_id = member.user_id
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.status = 'active'
        and member.user_id <> p_actor_user_id
        and coalesce(conversation_preference.translation_mode, 'automatic') = 'automatic'
        and coalesce(preference.message_language, profile.preferred_language) is not null
        and lower(coalesce(preference.message_language, profile.preferred_language)) <> 'und'
        and coalesce(preference.message_language, profile.preferred_language)
          ~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
      order by 1
    loop
      v_translation_id := null;
      insert into public.message_translations (
        organization_id, conversation_id, message_id, source_language,
        target_language, source_body_sha256
      ) values (
        p_organization_id, p_conversation_id, v_message_id,
        'und', v_target_language,
        extensions.digest(convert_to(p_body, 'UTF8'), 'sha256')
      )
      on conflict (organization_id, conversation_id, message_id, target_language) do nothing
      returning id into v_translation_id;
      if v_translation_id is null then
        select translation.id into v_translation_id
        from public.message_translations translation
        where translation.organization_id = p_organization_id
          and translation.conversation_id = p_conversation_id
          and translation.message_id = v_message_id
          and translation.target_language = v_target_language;
      end if;
      v_translation_targets := array_append(v_translation_targets, v_target_language);
    end loop;
    if private.ai_use_case_approved(p_organization_id, 'language_detection', null) then
      perform private.enqueue_outbox_job_internal(
        p_organization_id,
        'language_detection',
        'language-detection:' || p_organization_id::text || ':' || v_message_id::text || ':'
          || encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex'),
        jsonb_build_object(
          'organization_id', p_organization_id,
          'conversation_id', p_conversation_id,
          'message_id', v_message_id,
          'source_sha256', encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex'),
          'client_language_hint', p_language_code,
          'required_target_languages', to_jsonb(v_translation_targets),
          'use_case', 'language_detection'
        )
      );
    else
      perform set_config('app.language_detection_context', 'on', true);
      update public.messages message
      set language_detection_state = 'failed', detected_language = null,
          language_detection_method = 'tenant-policy-disabled',
          language_detection_confidence = null, language_detected_at = now()
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id and message.id = v_message_id;
      update public.message_translations translation
      set status = 'blocked', failure_code = 'tenant_ai_policy_disabled'
      where translation.organization_id = p_organization_id
        and translation.conversation_id = p_conversation_id
        and translation.message_id = v_message_id and translation.status = 'queued';
      perform set_config('app.language_detection_context', 'off', true);
    end if;
  end if;
  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'push',
    'message:' || p_organization_id::text || ':' || p_conversation_id::text || ':' || v_message_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', p_conversation_id,
      'message_id', v_message_id
    )
  );
  v_response := jsonb_build_object(
    'message_id', v_message_id,
    'client_nonce', p_client_nonce,
    'translation_targets', to_jsonb(v_translation_targets),
    'language_detection_queued', p_body is not null
      and private.ai_use_case_approved(p_organization_id, 'language_detection', null),
    'original_committed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/messages',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.scrub_translation_array_for_user_internal(
  p_organization_id uuid,
  p_user_id uuid,
  p_rows jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    case
      when private.translation_mode_for_user_internal(
        p_organization_id,
        nullif(item.value ->> 'conversation_id', '')::uuid,
        p_user_id
      ) = 'off'
      then jsonb_set(item.value, '{translations}', '[]'::jsonb, true)
      else item.value
    end
    order by item.ordinality
  ), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
    with ordinality as item(value, ordinality)
$$;

create or replace function private.bff_bootstrap_messaging_state_v4_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base jsonb;
  v_conversations jsonb;
  v_timeline jsonb;
begin
  perform private.require_service_role();
  -- Compose after moderation's v3 enrichment rather than replacing it.
  v_base := private.bff_bootstrap_messaging_state_v3_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  select coalesce(jsonb_agg(
    jsonb_set(
      item.value,
      '{preferences,translation_mode}',
      to_jsonb(private.translation_mode_for_user_internal(
        p_organization_id,
        (item.value ->> 'conversation_id')::uuid,
        p_actor_user_id
      )),
      true
    ) order by item.ordinality
  ), '[]'::jsonb)
  into v_conversations
  from jsonb_array_elements(coalesce(v_base -> 'conversations', '[]'::jsonb))
    with ordinality as item(value, ordinality);

  v_timeline := coalesce(v_base -> 'timeline', '{}'::jsonb);
  v_timeline := jsonb_set(
    v_timeline,
    '{messages}',
    private.scrub_translation_array_for_user_internal(
      p_organization_id, p_actor_user_id, v_timeline -> 'messages'
    ),
    true
  );
  return v_base
    || jsonb_build_object('conversations', v_conversations, 'timeline', v_timeline)
    || jsonb_build_object(
      'updates', private.scrub_translation_array_for_user_internal(
        p_organization_id, p_actor_user_id, v_base -> 'updates'
      )
    );
end;
$$;

create or replace function private.bff_read_conversation_page_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_before_message_id bigint,
  p_limit integer
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_bootstrap jsonb;
begin
  perform private.require_service_role();
  if p_limit not between 1 and 100 then
    raise exception 'invalid message page bound' using errcode = '22023';
  end if;
  v_bootstrap := private.bff_bootstrap_messaging_state_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_conversation_id, p_before_message_id, 1, p_limit
  );
  return jsonb_build_object(
    'schema_version', 1,
    'conversation_id', p_conversation_id,
    'messages', private.scrub_translation_array_for_user_internal(
      p_organization_id, p_actor_user_id,
      coalesce(v_bootstrap #> '{timeline,messages}', '[]'::jsonb)
    ),
    'has_more', coalesce((v_bootstrap #>> '{timeline,has_more}')::boolean, false),
    'next_before_message_id', v_bootstrap #> '{timeline,next_before_message_id}',
    'reconcile_after', now()
  );
end;
$$;

create or replace function private.require_translation_mode_automatic_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_conversation_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  if private.translation_mode_for_user_internal(
    p_organization_id, p_conversation_id, p_actor_user_id
  ) <> 'automatic' then
    raise exception 'automatic translation is disabled for this conversation'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function private.filter_translation_search_for_user_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_result jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_result, '{}'::jsonb) || jsonb_build_object(
    'results', coalesce((
      select jsonb_agg(item.value order by item.ordinality)
      from jsonb_array_elements(coalesce(p_result -> 'results', '[]'::jsonb))
        with ordinality as item(value, ordinality)
      where item.value ->> 'matched_source' <> 'translation'
        or private.translation_mode_for_user_internal(
          p_organization_id,
          nullif(item.value ->> 'conversation_id', '')::uuid,
          p_actor_user_id
        ) = 'automatic'
    ), '[]'::jsonb)
  )
$$;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_selected_conversation_id uuid default null,
  p_before_message_id bigint default null,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_bootstrap_messaging_state_v4_impl(
  p_actor_user_id, p_organization_id, p_session_id,
  p_selected_conversation_id, p_before_message_id,
  p_conversation_limit, p_timeline_limit
) $$;

create or replace function public.bff_enqueue_translation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_target_language text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = ''
as $$
begin
  perform private.require_translation_mode_automatic_internal(
    p_actor_user_id, p_organization_id, p_conversation_id
  );
  return private.bff_enqueue_translation_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_target_language, p_idempotency_key, p_request_sha256
  );
end;
$$;

create or replace function public.bff_search(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_query text, p_types text[], p_cursor text default null,
  p_limit integer default 20, p_sender_user_id uuid default null,
  p_date_from timestamptz default null, p_date_to timestamptz default null,
  p_match_sources text[] default null
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.filter_translation_search_for_user_internal(
  p_actor_user_id,
  p_organization_id,
  private.bff_search_v2_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_query,
    p_types, p_cursor, p_limit, p_sender_user_id, p_date_from, p_date_to,
    p_match_sources
  )
) $$;

revoke execute on function private.translation_mode_for_user_internal(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.scrub_translation_array_for_user_internal(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function private.bff_bootstrap_messaging_state_v4_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
revoke execute on function private.require_translation_mode_automatic_internal(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.filter_translation_search_for_user_internal(uuid, uuid, jsonb)
  from public, anon, authenticated;

grant execute on function private.translation_mode_for_user_internal(uuid, uuid, uuid)
  to service_role;
grant execute on function private.scrub_translation_array_for_user_internal(uuid, uuid, jsonb)
  to service_role;
grant execute on function private.bff_bootstrap_messaging_state_v4_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;
grant execute on function private.require_translation_mode_automatic_internal(uuid, uuid, uuid)
  to service_role;
grant execute on function private.filter_translation_search_for_user_internal(uuid, uuid, jsonb)
  to service_role;

comment on column public.conversation_preferences.translation_mode is
  'Per-user automatic translation mode. Off suppresses target contribution and derived projection; originals remain readable.';

commit;
