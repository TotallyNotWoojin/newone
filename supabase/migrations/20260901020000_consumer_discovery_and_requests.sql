-- Consumer pivot slice 2: username discovery and person-level message
-- requests inside the personal realm. Discovery is a single bounded,
-- rate-limited, block-aware prefix search over unique usernames; message
-- requests reuse the existing contact-connection and direct-message machinery
-- through a narrow pending-window carve-out instead of a parallel inbox. The
-- personal-realm bootstrap directory is assembled from the actor's own
-- connections and conversations, never from an organization-wide member scan.

begin;

-- Case-insensitive prefix search support. Usernames are stored lowercase by
-- constraint, and the search impl compares on lower(username::text), so a
-- text_pattern_ops btree over that expression serves anchored LIKE prefixes.
create index profiles_username_prefix_idx
  on public.profiles (lower(username::text) text_pattern_ops)
  where username is not null;

-- ---------------------------------------------------------------------------
-- 1. Username prefix search: the only consumer discovery surface.
-- ---------------------------------------------------------------------------

create or replace function private.bff_search_users_by_username_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_limit integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_limit integer := coalesce(p_limit, 25);
  v_users jsonb := '[]'::jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'user.search.read', false, 0
  );

  if p_organization_id <> private.personal_realm_organization_id() then
    raise exception 'username search is a personal-realm capability'
      using errcode = '22023';
  end if;
  if v_limit not between 1 and 25 then
    raise exception 'invalid username search limit' using errcode = '22023';
  end if;

  -- Consume the search budget before answering anything, including malformed
  -- probes, so every query shape shares one abuse envelope.
  if not private.consume_rate_limit(
    'user-search-minute',
    p_organization_id::text || ':' || p_actor_user_id::text,
    30, 60
  ) then
    raise exception 'username search rate limit exceeded' using errcode = 'P0001';
  end if;

  -- Anything that is not a plausible username prefix finds nobody rather than
  -- erroring: the client can stream keystrokes without special-casing input.
  if v_query !~ '^[a-z0-9][a-z0-9_]{1,29}$' then
    return jsonb_build_object('users', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'user_id', candidate.user_id,
    'username', candidate.username,
    'display_name', candidate.display_name,
    'avatar_path', candidate.avatar_path,
    'connection_state', candidate.connection_state
  )) order by candidate.username, candidate.user_id), '[]'::jsonb)
  into v_users
  from (
    select
      membership.user_id,
      profile.username::text as username,
      profile.display_name,
      profile.avatar_path,
      coalesce((
        select case
          when connection.status = 'accepted' then 'accepted'
          when connection.status = 'pending'
            and connection.requested_by_user_id = p_actor_user_id
            then 'pending_outgoing'
          when connection.status = 'pending' then 'pending_incoming'
          else 'none'
        end
        from public.contact_connections connection
        where connection.organization_id = p_organization_id
          and connection.member_low_user_id
            = least(p_actor_user_id, membership.user_id)
          and connection.member_high_user_id
            = greatest(p_actor_user_id, membership.user_id)
      ), 'none') as connection_state
    from public.profiles profile
    join public.organization_memberships membership
      on membership.user_id = profile.user_id
     and membership.organization_id = p_organization_id
    where profile.username is not null
      -- Underscores are literal in usernames, never single-character LIKE
      -- wildcards, so escape them before anchoring the prefix.
      and lower(profile.username::text)
        like replace(v_query, '_', '\_') || '%'
      and membership.user_id <> p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and (
            (block.blocker_user_id = p_actor_user_id
              and block.blocked_user_id = membership.user_id)
            or (block.blocker_user_id = membership.user_id
              and block.blocked_user_id = p_actor_user_id)
          )
      )
    order by profile.username, membership.user_id
    limit v_limit
  ) candidate;

  return jsonb_build_object('users', v_users);
end;
$$;

create or replace function public.bff_search_users_by_username(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_limit integer default 25
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_search_users_by_username_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_query, p_limit
  )
$$;

revoke all on function private.bff_search_users_by_username_impl(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
grant execute on function private.bff_search_users_by_username_impl(
  uuid, uuid, uuid, text, integer
) to service_role;

revoke all on function public.bff_search_users_by_username(
  uuid, uuid, uuid, text, integer
) from public, anon, authenticated;
grant execute on function public.bff_search_users_by_username(
  uuid, uuid, uuid, text, integer
) to service_role;

comment on function public.bff_search_users_by_username(
  uuid, uuid, uuid, text, integer
) is
  'Service-only, actor-authorized, rate-limited username prefix search. The single consumer discovery surface: bounded, block-aware, personal-realm only.';

-- ---------------------------------------------------------------------------
-- 2. Message requests: the pending-window posting carve-out.
-- ---------------------------------------------------------------------------

-- Full recreate of the canonical direct-pair policy predicate. The only
-- change is the personal-realm pending arm of `request_first`: while a
-- contact request is pending, the requester (and only the requester) may
-- post, capped at three delivered messages, so a first hello can arrive
-- without the pair being connected yet. Decline, cancel, or a block in
-- either direction closes the window immediately because this predicate is
-- re-evaluated on every post.
create or replace function private.direct_pair_policy_permitted(
  p_organization_id uuid,
  p_first_user_id uuid,
  p_second_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organizations organization
    join public.organization_memberships first_member
      on first_member.organization_id = organization.id
     and first_member.user_id = p_first_user_id
    join public.organization_memberships second_member
      on second_member.organization_id = organization.id
     and second_member.user_id = p_second_user_id
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
      and p_first_user_id <> p_second_user_id
      and first_member.status = 'active'
      and second_member.status = 'active'
      and first_member.membership_type <> 'guest'
      and second_member.membership_type <> 'guest'
      and (first_member.access_expires_at is null or first_member.access_expires_at > now())
      and (second_member.access_expires_at is null or second_member.access_expires_at > now())
      and not exists (
        select 1 from public.member_blocks block
        where block.organization_id = p_organization_id
          and (
            (block.blocker_user_id = p_first_user_id and block.blocked_user_id = p_second_user_id)
            or (block.blocker_user_id = p_second_user_id and block.blocked_user_id = p_first_user_id)
          )
      )
      and case organization.dm_policy
        when 'directory_open' then true
        when 'request_first' then (
          exists (
            select 1 from public.contact_connections connection
            where connection.organization_id = p_organization_id
              and connection.member_low_user_id = least(p_first_user_id, p_second_user_id)
              and connection.member_high_user_id = greatest(p_first_user_id, p_second_user_id)
              and connection.status = 'accepted'
          )
          -- Personal-realm message requests: the pending requester may post
          -- up to three non-system, non-deleted messages before acceptance.
          or (
            organization.id = private.personal_realm_organization_id()
            and exists (
              select 1 from public.contact_connections pending_connection
              where pending_connection.organization_id = p_organization_id
                and pending_connection.member_low_user_id
                  = least(p_first_user_id, p_second_user_id)
                and pending_connection.member_high_user_id
                  = greatest(p_first_user_id, p_second_user_id)
                and pending_connection.status = 'pending'
                and pending_connection.requested_by_user_id = (select auth.uid())
            )
            and (
              select count(*)
              from public.direct_conversation_pairs pair
              join public.messages message
                on message.organization_id = pair.organization_id
               and message.conversation_id = pair.conversation_id
              where pair.organization_id = p_organization_id
                and pair.member_low_user_id
                  = least(p_first_user_id, p_second_user_id)
                and pair.member_high_user_id
                  = greatest(p_first_user_id, p_second_user_id)
                and message.sender_user_id = (select auth.uid())
                and message.kind <> 'system'
                and message.deleted_at is null
            ) < 3
          )
        )
        when 'scoped_unit' then exists (
          select 1
          from public.organization_unit_members first_unit
          join public.organization_unit_members second_unit
            on second_unit.organization_id = first_unit.organization_id
           and second_unit.unit_id = first_unit.unit_id
           and second_unit.user_id = p_second_user_id
          where first_unit.organization_id = p_organization_id
            and first_unit.user_id = p_first_user_id
        )
        else false
      end
  )
$$;

-- Full recreate of the anti-enumeration guard for contact and block writes.
-- Every personal-realm membership is directory-private, so the directory
-- predicate alone can never authorize a first contact between strangers
-- there. In the personal realm only, a target that holds a live username on
-- an active membership is exactly as reachable as username search makes
-- them. Every other organization keeps the prior directory-visibility rule.
create or replace function private.validate_identity_relationship_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := (select auth.uid());
  v_target_user_id uuid;
  v_target_permitted boolean;
begin
  if tg_table_name = 'contact_connections' then
    v_target_user_id := case when new.member_low_user_id = v_actor_user_id
      then new.member_high_user_id else new.member_low_user_id end;
    if new.requested_by_user_id is distinct from v_actor_user_id
      or v_actor_user_id not in (new.member_low_user_id, new.member_high_user_id) then
      raise exception 'visible relationship target required' using errcode = '42501';
    end if;
  elsif tg_table_name = 'member_blocks' then
    if new.blocker_user_id is distinct from v_actor_user_id then
      raise exception 'visible relationship target required' using errcode = '42501';
    end if;
    v_target_user_id := new.blocked_user_id;
  else
    raise exception 'unsupported identity relationship' using errcode = '42501';
  end if;
  if v_actor_user_id is null or v_target_user_id is null
    or v_target_user_id = v_actor_user_id
    or not private.current_session_active_for_org(new.organization_id) then
    raise exception 'visible relationship target required' using errcode = '42501';
  end if;
  v_target_permitted := private.can_view_org_member_for_actor(
    new.organization_id, v_actor_user_id, v_target_user_id, now()
  );
  if not v_target_permitted
    and new.organization_id = private.personal_realm_organization_id() then
    v_target_permitted := exists (
      select 1
      from public.organization_memberships target_membership
      join public.profiles target_profile
        on target_profile.user_id = target_membership.user_id
      where target_membership.organization_id = new.organization_id
        and target_membership.user_id = v_target_user_id
        and private.organization_membership_access_current(
          target_membership.organization_id, target_membership.user_id, now()
        )
        and target_profile.username is not null
    );
  end if;
  if not v_target_permitted then
    raise exception 'visible relationship target required' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- One atomic command: the pending contact request, the direct conversation,
-- and the first message. Acceptance and decline continue through the
-- existing bff_respond_contact; no new state machine is introduced.
create or replace function private.bff_send_message_request_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
  p_body text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_low uuid;
  v_high uuid;
  v_conversation_id uuid;
  v_message_id bigint;
  v_target_language text;
  v_translation_id bigint;
  v_translation_targets text[] := array[]::text[];
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'contact.message_request', false, 0
  );

  if p_organization_id <> private.personal_realm_organization_id() then
    raise exception 'message requests are a personal-realm capability'
      using errcode = '22023';
  end if;
  if p_target_user_id is null or p_target_user_id = p_actor_user_id then
    raise exception 'message request target must be another member'
      using errcode = '22023';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 20000 then
    raise exception 'message request body is required' using errcode = '22023';
  end if;

  -- Same daily budget as bff_request_contact_impl: a message request is a
  -- contact request with a first message attached.
  if not private.consume_rate_limit(
    'contact-request-day',
    p_organization_id::text || ':' || p_actor_user_id::text,
    20, 86400
  ) then
    raise exception 'contact request rate limit exceeded' using errcode = 'P0001';
  end if;

  -- The relationship triggers, the DM policy predicate, and send_message all
  -- authorize with the end-user identity, exactly as in every other BFF
  -- command path.
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal',
    'contact.message_request'
  );

  -- Canonical-pair insert with the 7-day cooldown upsert, mirroring
  -- private.bff_request_contact_impl.
  v_low := least(p_actor_user_id, p_target_user_id);
  v_high := greatest(p_actor_user_id, p_target_user_id);
  insert into public.contact_connections (
    organization_id, member_low_user_id, member_high_user_id, requested_by_user_id
  ) values (
    p_organization_id, v_low, v_high, p_actor_user_id
  )
  on conflict (organization_id, member_low_user_id, member_high_user_id) do update
    set status = 'pending', responded_at = null, updated_at = now()
    where public.contact_connections.requested_by_user_id = p_actor_user_id
      and public.contact_connections.status in ('declined', 'cancelled')
      and public.contact_connections.responded_at <= now() - interval '7 days';
  if not found then
    raise exception 'contact request is pending, accepted, or in cooldown'
      using errcode = 'P0001';
  end if;

  -- Idempotent per pair; permitted under the new pending arm of the policy
  -- predicate because the actor is now the pending requester.
  v_conversation_id := private.create_direct_conversation(
    p_organization_id, p_target_user_id
  );

  -- The first message travels the same trusted path bff_send_message_impl
  -- uses, including the translation fan-out and push wakeup.
  v_message_id := private.send_message(
    p_organization_id, v_conversation_id, gen_random_uuid(), 'text',
    p_body, null, null, null, '{}'::jsonb
  );

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
      and member.conversation_id = v_conversation_id
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
      p_organization_id, v_conversation_id, v_message_id,
      'und', v_target_language,
      extensions.digest(convert_to(p_body, 'UTF8'), 'sha256')
    )
    on conflict (organization_id, conversation_id, message_id, target_language) do nothing
    returning id into v_translation_id;
    if v_translation_id is null then
      select translation.id into v_translation_id
      from public.message_translations translation
      where translation.organization_id = p_organization_id
        and translation.conversation_id = v_conversation_id
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
        'conversation_id', v_conversation_id,
        'message_id', v_message_id,
        'source_sha256', encode(extensions.digest(convert_to(p_body, 'UTF8'), 'sha256'), 'hex'),
        'client_language_hint', null,
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
      and message.conversation_id = v_conversation_id and message.id = v_message_id;
    update public.message_translations translation
    set status = 'blocked', failure_code = 'tenant_ai_policy_disabled'
    where translation.organization_id = p_organization_id
      and translation.conversation_id = v_conversation_id
      and translation.message_id = v_message_id and translation.status = 'queued';
    perform set_config('app.language_detection_context', 'off', true);
  end if;

  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'push',
    'message:' || p_organization_id::text || ':' || v_conversation_id::text || ':' || v_message_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', v_conversation_id,
      'message_id', v_message_id
    )
  );

  perform private.clear_bff_actor_context_internal();
  return jsonb_build_object(
    'connection_status', 'pending',
    'conversation_id', v_conversation_id,
    'message_id', v_message_id
  );
end;
$$;

create or replace function public.bff_send_message_request(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
  p_body text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_send_message_request_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_target_user_id, p_body
  )
$$;

revoke all on function private.bff_send_message_request_impl(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function private.bff_send_message_request_impl(
  uuid, uuid, uuid, uuid, text
) to service_role;

revoke all on function public.bff_send_message_request(
  uuid, uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.bff_send_message_request(
  uuid, uuid, uuid, uuid, text
) to service_role;

comment on function public.bff_send_message_request(
  uuid, uuid, uuid, uuid, text
) is
  'Service-only atomic message request: pending contact connection, direct conversation, and first message in one transaction. Personal-realm only.';

-- ---------------------------------------------------------------------------
-- 3. Personal-realm bootstrap directory: connections and conversations only.
-- ---------------------------------------------------------------------------

-- V10 composes on the existing chain and, for the personal realm only,
-- replaces the inherited directory with one assembled from the actor's own
-- contact-connection partners (any status involving the actor) and the
-- co-members of the actor's conversations. Every other organization keeps
-- the v9 output untouched. The inherited v8 directory block still executes
-- inside the chain, but with every consumer membership directory-private its
-- visibility predicate already narrows to contacts and shared conversations;
-- removing that inner pass entirely is a follow-up optimization.
create or replace function private.bff_bootstrap_messaging_state_v10_impl(
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
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_directory jsonb;
begin
  perform private.require_service_role();
  v_result := private.bff_bootstrap_messaging_state_v9_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  if p_organization_id <> private.personal_realm_organization_id() then
    return v_result;
  end if;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'user_id', visible.user_id,
    'display_name', visible.display_name,
    'avatar_path', visible.avatar_path,
    'status_message', visible.status_message,
    'preferred_language', visible.preferred_language,
    'time_zone', visible.time_zone,
    'membership_role', visible.membership_role,
    'membership_type', visible.membership_type,
    'membership_status', visible.membership_status,
    'access_expires_at', visible.access_expires_at,
    'job_title', visible.job_title,
    'directory_visibility', visible.directory_visibility,
    'unit_ids', visible.unit_ids,
    'is_saved_contact', visible.is_saved_contact,
    'is_blocked', visible.is_blocked,
    'connection', visible.connection
  )) order by visible.display_name, visible.user_id), '[]'::jsonb)
  into v_directory
  from (
    select membership.user_id, profile.display_name, profile.avatar_path,
      profile.status_message, profile.preferred_language, profile.time_zone,
      membership.role as membership_role,
      membership.membership_type, membership.status as membership_status,
      membership.access_expires_at, membership.job_title,
      membership.directory_visibility,
      (
        select coalesce(jsonb_agg(unit_member.unit_id order by unit_member.unit_id),
          '[]'::jsonb)
        from public.organization_unit_members unit_member
        where unit_member.organization_id = membership.organization_id
          and unit_member.user_id = membership.user_id
      ) as unit_ids,
      exists (
        select 1 from public.saved_contacts saved
        where saved.organization_id = membership.organization_id
          and saved.owner_user_id = p_actor_user_id
          and saved.contact_user_id = membership.user_id
      ) as is_saved_contact,
      exists (
        select 1 from public.member_blocks block
        where block.organization_id = membership.organization_id
          and block.blocker_user_id = p_actor_user_id
          and block.blocked_user_id = membership.user_id
      ) as is_blocked,
      (
        select jsonb_build_object(
          'status', connection.status,
          'requested_by_user_id', connection.requested_by_user_id,
          'created_at', connection.created_at,
          'responded_at', connection.responded_at,
          'updated_at', connection.updated_at
        )
        from public.contact_connections connection
        where connection.organization_id = membership.organization_id
          and p_actor_user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
          and membership.user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
          and membership.user_id <> p_actor_user_id
      ) as connection
    from (
      select relevant.user_id
      from (
        select case when connection.member_low_user_id = p_actor_user_id
            then connection.member_high_user_id
            else connection.member_low_user_id end as user_id
        from public.contact_connections connection
        where connection.organization_id = p_organization_id
          and p_actor_user_id in (
            connection.member_low_user_id, connection.member_high_user_id
          )
        union
        select co_member.user_id
        from public.conversation_members actor_member
        join public.conversation_members co_member
          on co_member.organization_id = actor_member.organization_id
         and co_member.conversation_id = actor_member.conversation_id
         and co_member.user_id <> p_actor_user_id
         and co_member.status = 'active'
        where actor_member.organization_id = p_organization_id
          and actor_member.user_id = p_actor_user_id
          and actor_member.status = 'active'
      ) relevant
    ) scoped
    join public.organization_memberships membership
      on membership.organization_id = p_organization_id
     and membership.user_id = scoped.user_id
    join public.profiles profile on profile.user_id = membership.user_id
    order by profile.display_name, membership.user_id
    limit 500
  ) visible;

  return jsonb_set(v_result, '{directory}', v_directory, true);
end;
$$;

-- Workspace organizations keep delegating to the untouched V9 chain; only
-- the personal realm routes through the V10 directory replacement.
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
volatile
security invoker
set search_path = ''
as $$
  select case
    when p_organization_id = private.personal_realm_organization_id()
    then private.bff_bootstrap_messaging_state_v10_impl(
      p_actor_user_id, p_organization_id, p_session_id,
      p_selected_conversation_id, p_before_message_id,
      p_conversation_limit, p_timeline_limit
    )
    else private.bff_bootstrap_messaging_state_v9_impl(
      p_actor_user_id, p_organization_id, p_session_id,
      p_selected_conversation_id, p_before_message_id,
      p_conversation_limit, p_timeline_limit
    )
  end
$$;

revoke all on function private.bff_bootstrap_messaging_state_v10_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function private.bff_bootstrap_messaging_state_v10_impl(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

revoke all on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) from public, anon, authenticated;
grant execute on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) to service_role;

comment on function public.bff_bootstrap_messaging_state(
  uuid, uuid, uuid, uuid, bigint, integer, integer
) is
  'Service-only bootstrap. In the personal realm the directory is assembled from the actor''s connections and conversation co-members only; workspace organizations keep the established directory chain.';

commit;
