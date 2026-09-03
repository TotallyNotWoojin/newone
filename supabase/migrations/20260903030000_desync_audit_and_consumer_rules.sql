-- Desync audit and consumer rules.
--
-- Real-device testing of the consumer messenger found that many state
-- changes reached the acting device only. Every other device -- the actor's
-- own second device included -- stayed stale until a restart. This
-- migration closes the audit in four parts:
--
-- 1. A generic private inbox invalidation helper
--    (private.enqueue_workspace_invalidation_internal) generalises the
--    contact-connection fan-out from 20260903020000: one immediate
--    realtime.send acceleration plus one durable realtime_control outbox job
--    per addressed recipient. Row triggers on reactions, pins, hide-for-me
--    visibility, attachment scan verdicts, translation outcomes, summary
--    lifecycle, member blocks, conversation metadata, conversation
--    preferences, and profile changes now fan out through it, and the
--    contact request / cancel / remove commands and attachment upload
--    completion call it explicitly. Message send/edit/delete/forward, read
--    receipts, language detection, group roster changes, departures, and
--    conversation controls already broadcast and are unchanged.
--
-- 2. Personal-realm groups are friends-only: group creation, member
--    addition, and both candidate directories require an accepted contact
--    connection between the actor and every target. Workspace organizations
--    keep their directory rules.
--
-- 3. Conversation role hardening: members can never change their own role.
--    Administrators may add and remove ordinary members, but promoting a
--    member to admin, demoting or removing an admin, and anything that
--    touches an owner role are all owner-only, including a sole owner's
--    self-service leave; ownership moves only through an explicit
--    owner-performed transfer. Delegated organization managers still cannot
--    change any role.
--
-- 4. Consumer summaries: the platform personal-realm AI policy approves the
--    'summary' use case (existing rows are upgraded in place, never
--    resurrected after revocation).

begin;

-- pg_net backs the AI-worker wake-on-enqueue call added by 20260903020000
-- (private.notify_ai_worker_internal calls net.http_post through a
-- to_regprocedure probe and no-ops when it is absent). The hosted `newone`
-- project already has it enabled (that is what let 20260903020000 measure
-- single-digit-second AI latency); local and any other environment that
-- provisions this schema from migrations alone need it declared explicitly.
-- Idempotent everywhere, including on hosted where it is already installed.
create extension if not exists pg_net with schema net;

-- ---------------------------------------------------------------------------
-- 1. Generic private inbox invalidation
-- ---------------------------------------------------------------------------

-- The (entity_type, reason) vocabulary is shared with the outbox worker's
-- realtime_control validation (newone-outbox-worker/handler.ts). Both sides
-- fail closed on anything outside this table.
create or replace function private.workspace_invalidation_reason_allowed(
  p_entity_type text,
  p_reason text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_entity_type, p_reason) in (
    ('contact_connection', 'contact_request_created'),
    ('contact_connection', 'contact_accepted'),
    ('contact_connection', 'contact_declined'),
    ('contact_connection', 'contact_cancelled'),
    ('contact_connection', 'contact_removed'),
    ('member_block', 'member_blocked'),
    ('member_block', 'member_unblocked'),
    ('reaction', 'reaction_added'),
    ('reaction', 'reaction_removed'),
    ('pin', 'message_pinned'),
    ('pin', 'message_unpinned'),
    ('message_visibility', 'message_hidden_for_user'),
    ('attachment', 'attachment_uploaded'),
    ('attachment', 'attachment_scan_clean'),
    ('attachment', 'attachment_scan_quarantined'),
    ('attachment', 'attachment_scan_failed'),
    ('translation', 'translation_completed'),
    ('translation', 'translation_failed'),
    ('translation', 'translation_blocked'),
    ('summary', 'summary_queued'),
    ('summary', 'summary_draft'),
    ('summary', 'summary_failed'),
    ('summary', 'summary_stale'),
    ('summary', 'summary_approved'),
    ('conversation', 'conversation_updated'),
    ('conversation_preference', 'conversation_preferences_updated'),
    ('profile', 'profile_updated'),
    ('profile', 'account_deleted')
  )
$$;

revoke all on function private.workspace_invalidation_reason_allowed(text, text)
  from public, anon, authenticated, service_role;

-- Fan one content-free invalidation out to an explicit recipient list.
-- Recipients must hold a current active membership in the organization;
-- anyone else is silently skipped so a departed counterpart never receives
-- a private-topic hint. The immediate realtime.send mirrors the message
-- trigger; the realtime_control job mirrors the moderation fan-out so a
-- briefly disconnected app still reconciles through the outbox worker.
-- p_dedupe_scope lets a caller keep an established dedupe-key family (the
-- contact helper below); p_event_id lets one logical event share its id
-- across recipients that need different entity ids.
create or replace function private.enqueue_workspace_invalidation_internal(
  p_organization_id uuid,
  p_user_ids uuid[],
  p_entity_type text,
  p_entity_id text,
  p_conversation_id uuid,
  p_reason text,
  p_event_id uuid default null,
  p_dedupe_scope text default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_event_id uuid := coalesce(p_event_id, gen_random_uuid());
  v_occurred_at timestamptz := now();
  v_scope text;
  v_recipient record;
  v_count integer := 0;
begin
  if p_organization_id is null
    or not private.workspace_invalidation_reason_allowed(p_entity_type, p_reason)
    or char_length(coalesce(p_entity_id, '')) not between 1 and 240 then
    raise exception 'invalid workspace invalidation' using errcode = '22023';
  end if;
  if p_user_ids is null or cardinality(p_user_ids) = 0 then
    return 0;
  end if;
  -- Dedupe keys are capped at 240 characters; long entity ids are hashed.
  v_scope := coalesce(
    p_dedupe_scope,
    'invalidate:' || p_organization_id::text || ':' || p_entity_type || ':'
      || case when char_length(p_entity_id) > 40 then md5(p_entity_id) else p_entity_id end
  );

  for v_recipient in
    select distinct participant.user_id
    from unnest(p_user_ids) as participant(user_id)
    join public.organization_memberships membership
      on membership.organization_id = p_organization_id
     and membership.user_id = participant.user_id
     and membership.status = 'active'
    where participant.user_id is not null
      and private.organization_membership_access_current(
        p_organization_id, participant.user_id, now()
      )
    order by participant.user_id
  loop
    perform realtime.send(
      jsonb_build_object(
        'schema_version', 1, 'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'organization_id', p_organization_id,
        'occurred_at', v_occurred_at,
        'conversation_id', p_conversation_id,
        'entity_type', p_entity_type,
        'entity_id', p_entity_id,
        'version_id', null, 'reason', p_reason
      ),
      'workspace.invalidated',
      'org:' || p_organization_id::text || ':user:'
        || v_recipient.user_id::text || ':inbox',
      true
    );
    perform private.enqueue_outbox_job_internal(
      p_organization_id,
      'realtime_control',
      v_scope || ':' || v_recipient.user_id::text || ':' || p_reason
        || ':' || v_event_id::text,
      jsonb_build_object(
        'schema_version', 1,
        'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'control_topic', 'org:' || p_organization_id::text || ':user:'
          || v_recipient.user_id::text || ':inbox',
        'organization_id', p_organization_id,
        'occurred_at', v_occurred_at,
        'user_id', v_recipient.user_id,
        'entity_type', p_entity_type,
        'entity_id', p_entity_id,
        'reason', p_reason
      ) || case
        when p_conversation_id is null then '{}'::jsonb
        else jsonb_build_object('conversation_id', p_conversation_id)
      end
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function private.enqueue_workspace_invalidation_internal(
  uuid, uuid[], text, text, uuid, text, uuid, text
) from public, anon, authenticated, service_role;

comment on function private.enqueue_workspace_invalidation_internal(
  uuid, uuid[], text, text, uuid, text, uuid, text
) is
  'Fans one content-free workspace.invalidated hint out to the listed current members: an immediate private realtime.send plus one durable realtime_control outbox job per recipient.';

-- Conversation-scoped fan-out: every current active member of the
-- conversation (with the same organization-access and dynamic-group
-- eligibility filters the message-change trigger applies), plus any extra
-- recipients such as a member who was just removed.
create or replace function private.enqueue_conversation_invalidation_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_entity_type text,
  p_entity_id text,
  p_reason text,
  p_extra_user_ids uuid[] default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipients uuid[];
begin
  select array_agg(recipient.user_id) into v_recipients
  from (
    select member.user_id
    from public.conversation_members member
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.status = 'active'
      and (
        not private.dynamic_group_policy_conversation(
          member.organization_id, member.conversation_id
        ) or private.dynamic_group_user_currently_eligible(
          member.organization_id, member.conversation_id, member.user_id, now()
        )
      )
    union
    select extra.user_id
    from unnest(coalesce(p_extra_user_ids, array[]::uuid[])) as extra(user_id)
    where extra.user_id is not null
  ) recipient;
  return private.enqueue_workspace_invalidation_internal(
    p_organization_id, v_recipients, p_entity_type, p_entity_id,
    p_conversation_id, p_reason
  );
end;
$$;

revoke all on function private.enqueue_conversation_invalidation_internal(
  uuid, uuid, text, text, text, uuid[]
) from public, anon, authenticated, service_role;

-- The contact helper from 20260903020000 now delegates to the generic
-- helper. Its payload shape, recipient filtering, and 'contact:' dedupe-key
-- family are unchanged; it additionally accepts the cancel and remove
-- reasons emitted below.
create or replace function private.enqueue_contact_connection_invalidation_internal(
  p_organization_id uuid,
  p_first_user_id uuid,
  p_second_user_id uuid,
  p_reason text
)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_low uuid := least(p_first_user_id, p_second_user_id);
  v_high uuid := greatest(p_first_user_id, p_second_user_id);
  v_event_id uuid := gen_random_uuid();
  v_conversation_id uuid;
  v_scope text;
begin
  if not private.workspace_invalidation_reason_allowed('contact_connection', p_reason) then
    raise exception 'invalid contact invalidation reason' using errcode = '22023';
  end if;
  if p_first_user_id is null or p_second_user_id is null
    or p_first_user_id = p_second_user_id then
    raise exception 'contact invalidation requires two distinct members'
      using errcode = '22023';
  end if;

  select pair.conversation_id into v_conversation_id
  from public.direct_conversation_pairs pair
  where pair.organization_id = p_organization_id
    and pair.member_low_user_id = v_low
    and pair.member_high_user_id = v_high;

  v_scope := 'contact:' || p_organization_id::text || ':' || v_low::text || ':'
    || v_high::text;
  -- Each participant is told about the *other* one, so the pair is two
  -- single-recipient deliveries sharing one event id.
  return private.enqueue_workspace_invalidation_internal(
      p_organization_id, array[v_low], 'contact_connection', v_high::text,
      v_conversation_id, p_reason, v_event_id, v_scope
    ) + private.enqueue_workspace_invalidation_internal(
      p_organization_id, array[v_high], 'contact_connection', v_low::text,
      v_conversation_id, p_reason, v_event_id, v_scope
    );
end;
$$;

revoke all on function private.enqueue_contact_connection_invalidation_internal(
  uuid, uuid, uuid, text
) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1a. Row triggers for state that previously changed silently
-- ---------------------------------------------------------------------------

-- Reactions: every current member re-projects the message. Cascaded deletes
-- (message purge) find no live parent message and stay silent.
create or replace function private.broadcast_reaction_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.message_reactions%rowtype := case when tg_op = 'DELETE' then old else new end;
begin
  if not exists (
    select 1 from public.messages message
    where message.organization_id = v_row.organization_id
      and message.conversation_id = v_row.conversation_id
      and message.id = v_row.message_id
      and message.deleted_at is null
  ) then
    return null;
  end if;
  perform private.enqueue_conversation_invalidation_internal(
    v_row.organization_id, v_row.conversation_id, 'reaction',
    v_row.message_id::text,
    case when tg_op = 'DELETE' then 'reaction_removed' else 'reaction_added' end
  );
  return null;
end;
$$;

drop trigger if exists message_reactions_80_broadcast_change on public.message_reactions;
create trigger message_reactions_80_broadcast_change
  after insert or delete on public.message_reactions
  for each row execute function private.broadcast_reaction_change();

-- Pins: re-pinning refreshes the pinned_at timestamp and is a pin.
create or replace function private.broadcast_pin_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.message_pins%rowtype := case when tg_op = 'DELETE' then old else new end;
begin
  if not exists (
    select 1 from public.messages message
    where message.organization_id = v_row.organization_id
      and message.conversation_id = v_row.conversation_id
      and message.id = v_row.message_id
      and message.deleted_at is null
  ) then
    return null;
  end if;
  perform private.enqueue_conversation_invalidation_internal(
    v_row.organization_id, v_row.conversation_id, 'pin',
    v_row.message_id::text,
    case when tg_op = 'DELETE' then 'message_unpinned' else 'message_pinned' end
  );
  return null;
end;
$$;

drop trigger if exists message_pins_80_broadcast_change on public.message_pins;
create trigger message_pins_80_broadcast_change
  after insert or update or delete on public.message_pins
  for each row execute function private.broadcast_pin_change();

-- Hide-for-me is private to the acting user: only that user's other devices
-- need to drop the message.
create or replace function private.broadcast_message_visibility_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_workspace_invalidation_internal(
    new.organization_id, array[new.user_id], 'message_visibility',
    new.message_id::text, new.conversation_id, 'message_hidden_for_user'
  );
  return null;
end;
$$;

drop trigger if exists message_user_visibility_80_broadcast_change
  on public.message_user_visibility;
create trigger message_user_visibility_80_broadcast_change
  after insert on public.message_user_visibility
  for each row execute function private.broadcast_message_visibility_change();

-- Attachment scan verdicts. An attachment whose message is not (yet)
-- available to the conversation -- avatar candidates -- concerns only its
-- uploader.
create or replace function private.broadcast_attachment_scan_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_available boolean;
begin
  if new.scan_status not in ('clean', 'quarantined', 'failed')
    or new.scan_status is not distinct from old.scan_status then
    return null;
  end if;
  select message.available_at <= now() into v_available
  from public.messages message
  where message.organization_id = new.organization_id
    and message.conversation_id = new.conversation_id
    and message.id = new.message_id
    and message.deleted_at is null;
  if v_available is null then
    return null;
  end if;
  if v_available then
    perform private.enqueue_conversation_invalidation_internal(
      new.organization_id, new.conversation_id, 'attachment', new.id::text,
      'attachment_scan_' || new.scan_status
    );
  else
    perform private.enqueue_workspace_invalidation_internal(
      new.organization_id, array[new.created_by_user_id], 'attachment',
      new.id::text, new.conversation_id, 'attachment_scan_' || new.scan_status
    );
  end if;
  return null;
end;
$$;

drop trigger if exists message_attachments_80_broadcast_scan_change
  on public.message_attachments;
create trigger message_attachments_80_broadcast_scan_change
  after update of scan_status on public.message_attachments
  for each row execute function private.broadcast_attachment_scan_change();

-- Translation outcomes. Queued/processing transitions are invisible to
-- readers; completion, failure, and policy blocks change what they see.
create or replace function private.broadcast_translation_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status not in ('completed', 'failed', 'blocked')
    or new.status is not distinct from old.status then
    return null;
  end if;
  if not exists (
    select 1 from public.messages message
    where message.organization_id = new.organization_id
      and message.conversation_id = new.conversation_id
      and message.id = new.message_id
      and message.deleted_at is null
  ) then
    return null;
  end if;
  perform private.enqueue_conversation_invalidation_internal(
    new.organization_id, new.conversation_id, 'translation', new.id::text,
    'translation_' || new.status
  );
  return null;
end;
$$;

drop trigger if exists message_translations_80_broadcast_change
  on public.message_translations;
create trigger message_translations_80_broadcast_change
  after update of status on public.message_translations
  for each row execute function private.broadcast_translation_change();

-- Summary lifecycle: queued (request), draft (worker or manual fallback),
-- failed, stale, approved. The worker's processing claim is not observable.
create or replace function private.broadcast_summary_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if new.status not in ('queued', 'draft', 'failed', 'stale', 'approved')
    or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return null;
  end if;
  perform private.enqueue_conversation_invalidation_internal(
    new.organization_id, new.conversation_id, 'summary', new.id::text,
    'summary_' || new.status
  );
  return null;
end;
$$;

drop trigger if exists conversation_summaries_80_broadcast_change
  on public.conversation_summaries;
create trigger conversation_summaries_80_broadcast_change
  after insert or update of status on public.conversation_summaries
  for each row execute function private.broadcast_summary_change();

-- Member blocks change both directories and the pair's DM posting policy.
-- Each side is addressed separately and told about the counterpart only.
create or replace function private.broadcast_member_block_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_row public.member_blocks%rowtype := case when tg_op = 'DELETE' then old else new end;
  v_reason text := case when tg_op = 'DELETE' then 'member_unblocked' else 'member_blocked' end;
  v_event_id uuid := gen_random_uuid();
  v_conversation_id uuid;
begin
  select pair.conversation_id into v_conversation_id
  from public.direct_conversation_pairs pair
  where pair.organization_id = v_row.organization_id
    and pair.member_low_user_id = least(v_row.blocker_user_id, v_row.blocked_user_id)
    and pair.member_high_user_id = greatest(v_row.blocker_user_id, v_row.blocked_user_id);
  perform private.enqueue_workspace_invalidation_internal(
    v_row.organization_id, array[v_row.blocker_user_id], 'member_block',
    v_row.blocked_user_id::text, v_conversation_id, v_reason, v_event_id
  );
  perform private.enqueue_workspace_invalidation_internal(
    v_row.organization_id, array[v_row.blocked_user_id], 'member_block',
    v_row.blocker_user_id::text, v_conversation_id, v_reason, v_event_id
  );
  return null;
end;
$$;

drop trigger if exists member_blocks_80_broadcast_change on public.member_blocks;
create trigger member_blocks_80_broadcast_change
  after insert or delete on public.member_blocks
  for each row execute function private.broadcast_member_block_change();

-- Conversation metadata (rename, description, archive). Avatar changes and
-- control changes already broadcast through system events and the control
-- fan-out, so the trigger is scoped to the silent columns.
create or replace function private.broadcast_conversation_metadata_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_conversation_invalidation_internal(
    new.organization_id, new.id, 'conversation', new.id::text,
    'conversation_updated'
  );
  return null;
end;
$$;

drop trigger if exists conversations_80_broadcast_metadata_change on public.conversations;
create trigger conversations_80_broadcast_metadata_change
  after update of name, description, is_archived on public.conversations
  for each row
  when (
    old.name is distinct from new.name
    or old.description is distinct from new.description
    or old.is_archived is distinct from new.is_archived
  )
  execute function private.broadcast_conversation_metadata_change();

-- Conversation preferences are private: the acting user's other devices.
create or replace function private.broadcast_conversation_preference_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.enqueue_workspace_invalidation_internal(
    new.organization_id, array[new.user_id], 'conversation_preference',
    new.conversation_id::text, new.conversation_id,
    'conversation_preferences_updated'
  );
  return null;
end;
$$;

drop trigger if exists conversation_preferences_80_broadcast_change
  on public.conversation_preferences;
create trigger conversation_preferences_80_broadcast_change
  after insert or update on public.conversation_preferences
  for each row execute function private.broadcast_conversation_preference_change();

-- Profile changes reach every directory that renders the profile: in each
-- organization the user is active in, the user's own devices, every contact
-- (pending or accepted), and every co-member of an active conversation.
-- Account deletion tombstones the profile under the deletion context and is
-- reported as such. Signup provisioning updates the profile before any
-- membership exists and therefore reaches nobody.
create or replace function private.broadcast_profile_change()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reason text := case
    when coalesce(current_setting('app.account_deletion_context', true), 'off') = 'on'
    then 'account_deleted' else 'profile_updated' end;
  v_membership record;
  v_recipients uuid[];
begin
  for v_membership in
    select membership.organization_id
    from public.organization_memberships membership
    where membership.user_id = new.user_id
      and membership.status = 'active'
    order by membership.organization_id
  loop
    select array_agg(recipient.user_id) into v_recipients
    from (
      select candidate.user_id
      from (
        select new.user_id as user_id
        union
        select case when connection.member_low_user_id = new.user_id
          then connection.member_high_user_id else connection.member_low_user_id end
        from public.contact_connections connection
        where connection.organization_id = v_membership.organization_id
          and new.user_id in (connection.member_low_user_id, connection.member_high_user_id)
          and connection.status in ('pending', 'accepted')
        union
        select other.user_id
        from public.conversation_members mine
        join public.conversation_members other
          on other.organization_id = mine.organization_id
         and other.conversation_id = mine.conversation_id
         and other.status = 'active'
         and other.user_id <> mine.user_id
        where mine.organization_id = v_membership.organization_id
          and mine.user_id = new.user_id
          and mine.status = 'active'
      ) candidate
      order by candidate.user_id
      limit 5000
    ) recipient;
    perform private.enqueue_workspace_invalidation_internal(
      v_membership.organization_id, v_recipients, 'profile',
      new.user_id::text, null, v_reason
    );
  end loop;
  return null;
end;
$$;

drop trigger if exists profiles_80_broadcast_change on public.profiles;
create trigger profiles_80_broadcast_change
  after update of display_name, avatar_path, status_message, username on public.profiles
  for each row
  when (
    old.display_name is distinct from new.display_name
    or old.avatar_path is distinct from new.avatar_path
    or old.status_message is distinct from new.status_message
    or old.username is distinct from new.username
  )
  execute function private.broadcast_profile_change();

revoke all on function private.broadcast_reaction_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_pin_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_message_visibility_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_attachment_scan_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_translation_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_summary_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_member_block_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_conversation_metadata_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_conversation_preference_change() from public, anon, authenticated, service_role;
revoke all on function private.broadcast_profile_change() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1b. Command paths that change no row the triggers can observe
-- ---------------------------------------------------------------------------

-- Contact request (no first message): both participants re-project. Full
-- recreate of the foundation command; the fan-out after the upsert is the
-- only change.
create or replace function private.bff_request_contact_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
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
  v_low uuid;
  v_high uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'contact.request', false, 0, '/v2/contacts',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_target_user_id = p_actor_user_id then
    raise exception 'contact target must be another member' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'contact-request-day', p_organization_id::text || ':' || p_actor_user_id::text, 20, 86400
  ) then
    raise exception 'contact request rate limit exceeded' using errcode = 'P0001';
  end if;
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
    raise exception 'contact request is pending, accepted, or in cooldown' using errcode = 'P0001';
  end if;
  perform private.enqueue_contact_connection_invalidation_internal(
    p_organization_id, p_actor_user_id, p_target_user_id, 'contact_request_created'
  );
  v_response := jsonb_build_object(
    'member_low_user_id', v_low,
    'member_high_user_id', v_high,
    'status', 'pending'
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/contacts',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

-- Contact cancel (pending) and remove (accepted) share one command. The
-- counterpart's request surface or friend list and the pair's DM posting
-- policy change, so both participants re-project. Deleting nothing emits
-- nothing.
create or replace function private.bff_remove_contact_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_other_user_id uuid,
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
  v_low uuid := least(p_actor_user_id, p_other_user_id);
  v_high uuid := greatest(p_actor_user_id, p_other_user_id);
  v_previous_status text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'contact.remove', false, 0, '/v2/contacts/:id',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  delete from public.contact_connections connection
  where connection.organization_id = p_organization_id
    and connection.member_low_user_id = v_low
    and connection.member_high_user_id = v_high
  returning connection.status into v_previous_status;
  if v_previous_status is not null then
    perform private.enqueue_contact_connection_invalidation_internal(
      p_organization_id, p_actor_user_id, p_other_user_id,
      case when v_previous_status = 'pending' then 'contact_cancelled'
        else 'contact_removed' end
    );
  end if;
  v_response := jsonb_build_object(
    'member_low_user_id', v_low,
    'member_high_user_id', v_high,
    'removed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/contacts/:id',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

-- Attachment upload completion changes no attachment column (the verdict
-- does), yet readers render the pending-scan placeholder from it. Full
-- recreate of the foundation command with the fan-out after the scan job.
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
  v_command jsonb;
  v_attachment public.message_attachments%rowtype;
  v_job_id bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.upload.finalize', false, 0, '/v2/attachments/:id/finalize',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select * into v_attachment
  from public.message_attachments attachment
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
  for update;
  if not found
    or v_attachment.created_by_user_id <> p_actor_user_id
    or v_attachment.scan_status <> 'pending'
    or not private.is_conversation_member(p_organization_id, v_attachment.conversation_id)
    or not exists (
      select 1 from public.messages message
      where message.organization_id = v_attachment.organization_id
        and message.conversation_id = v_attachment.conversation_id
        and message.id = v_attachment.message_id
        and message.deleted_at is null
    ) then
    raise exception 'finalizable attachment upload not found' using errcode = '42501';
  end if;
  if p_bucket_id is distinct from v_attachment.bucket_id
    or p_storage_path is distinct from v_attachment.storage_path
    or p_object_byte_size is distinct from v_attachment.byte_size
    or lower(coalesce(p_object_sha256_hex, '')) is distinct from v_attachment.sha256_hex then
    raise exception 'uploaded object metadata does not match grant' using errcode = '22023';
  end if;
  v_job_id := private.enqueue_outbox_job_internal(
    p_organization_id,
    'storage_scan',
    'attachment-scan:' || p_attachment_id::text,
    jsonb_build_object(
      'attachment_id', p_attachment_id,
      'bucket_id', v_attachment.bucket_id,
      'storage_path', v_attachment.storage_path,
      'byte_size', v_attachment.byte_size,
      'sha256_hex', v_attachment.sha256_hex,
      'declared_mime_type', v_attachment.mime_type
    )
  );
  if exists (
    select 1 from public.messages message
    where message.organization_id = v_attachment.organization_id
      and message.conversation_id = v_attachment.conversation_id
      and message.id = v_attachment.message_id
      and message.available_at <= now()
  ) then
    perform private.enqueue_conversation_invalidation_internal(
      p_organization_id, v_attachment.conversation_id, 'attachment',
      p_attachment_id::text, 'attachment_uploaded'
    );
  else
    perform private.enqueue_workspace_invalidation_internal(
      p_organization_id, array[p_actor_user_id], 'attachment',
      p_attachment_id::text, v_attachment.conversation_id, 'attachment_uploaded'
    );
  end if;
  v_response := jsonb_build_object(
    'attachment_id', p_attachment_id,
    'scan_status', 'pending',
    'scan_job_id', v_job_id,
    'scan_queued', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/attachments/:id/finalize',
    p_idempotency_key, p_request_sha256, v_response, 202
  );
end;
$$;

-- Account deletion: the deletion context is installed before the profile
-- tombstone so the profile trigger reports 'account_deleted' to every
-- counterpart while the memberships that select them are still active.
-- Everything else is the 20260901030000 implementation unchanged.
create or replace function private.delete_account_impl(p_user_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_username text;
  v_memberships integer := 0;
begin
  perform private.require_service_role();
  if p_user_id is null then
    raise exception 'invalid account deletion request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from auth.users auth_user where auth_user.id = p_user_id
  ) then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- (a) Quarantine the released handle before releasing it, so no later
  -- signup can pass the reserved-name check and impersonate the deleted
  -- account. Then null the profile username through the same service context
  -- the signup redemption uses to satisfy the username guard trigger.
  select profile.username::text into v_username
  from public.profiles profile
  where profile.user_id = p_user_id;

  if v_username is not null then
    insert into private.reserved_usernames (username, reserved_reason)
    values (v_username::extensions.citext, 'post-deletion-quarantine')
    on conflict (username) do nothing;
  end if;

  -- (b) Tombstone the profile. Message history keeps rendering under the
  -- anonymized identity; nothing content-bearing is removed. The deletion
  -- context tells the profile fan-out trigger to report 'account_deleted'.
  perform set_config('app.bff_service_context', 'on', true);
  perform set_config('app.account_deletion_context', 'on', true);
  update public.profiles profile
  set username = null,
      display_name = 'Deleted account',
      avatar_path = null,
      status_message = null
  where profile.user_id = p_user_id;
  perform set_config('app.account_deletion_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);

  -- (c) Deactivate every membership through the canonical status machinery.
  -- validate_membership_update demands the trusted BFF context, a status
  -- change reason, and a non-null acting principal; the dedicated
  -- account-deletion context authorizes the departing member as that
  -- principal. The status side-effect trigger then revokes push
  -- installations and enqueues session/realtime revocation per membership.
  perform set_config('app.bff_service_context', 'on', true);
  perform set_config('app.account_deletion_context', 'on', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', p_user_id)::text,
    true
  );
  update public.organization_memberships membership
  set status = 'deactivated',
      deactivated_at = now(),
      status_change_reason = 'Account deletion (self-service)'
  where membership.user_id = p_user_id
    and membership.status <> 'deactivated';
  get diagnostics v_memberships = row_count;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('app.account_deletion_context', 'off', true);
  perform set_config('app.bff_service_context', 'off', true);

  -- (d) Remove push registrations outright: a deleted account must leave no
  -- routable push tokens behind (the side-effect trigger already revoked
  -- them inside this transaction).
  delete from public.device_registrations device
  where device.user_id = p_user_id;

  -- (e) The caller (trusted Edge gateway) soft-deletes the Auth user after
  -- this commits; auth.users.deleted_at then gates every authorizer and the
  -- token lifecycle hook.
  return jsonb_build_object(
    'user_id', p_user_id,
    'memberships_deactivated', v_memberships
  );
end;
$$;

revoke all on function private.delete_account_impl(uuid)
  from public, anon, authenticated;
grant execute on function private.delete_account_impl(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Personal-realm groups are friends-only
-- ---------------------------------------------------------------------------

-- In the personal realm a user may only place accepted contacts into a
-- group. Workspace organizations keep their directory rules (this predicate
-- is true there), and the existing directory-visibility predicate still
-- applies in both cases, so blocks and expired access remain excluded.
create or replace function private.group_member_candidate_permitted(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_organization_id is not null
    and p_actor_user_id is not null
    and p_target_user_id is not null
    and p_actor_user_id <> p_target_user_id
    and (
      p_organization_id <> private.personal_realm_organization_id()
      or exists (
        select 1 from public.contact_connections connection
        where connection.organization_id = p_organization_id
          and connection.member_low_user_id = least(p_actor_user_id, p_target_user_id)
          and connection.member_high_user_id = greatest(p_actor_user_id, p_target_user_id)
          and connection.status = 'accepted'
      )
    )
$$;

revoke all on function private.group_member_candidate_permitted(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function private.group_member_candidate_permitted(uuid, uuid, uuid) is
  'True when the actor may place the target into a group: always in workspace organizations, only for accepted contacts in the personal realm.';

-- Full recreate of the 20260804172200 atomic group creation. The only change
-- is the friends-only predicate inside the initial-membership validation.
create or replace function private.bff_create_group_conversation_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_name text,
  p_description text,
  p_member_assignments jsonb,
  p_kind text,
  p_unit_id uuid,
  p_history_policy text,
  p_posting_mode text,
  p_join_policy text,
  p_incident_severity text,
  p_incident_classification text,
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
  v_organization public.organizations%rowtype;
  v_conversation_id uuid := gen_random_uuid();
  v_effective_join_policy text;
  v_visibility text;
  v_member_count integer;
  v_history_visible_from timestamptz := case
    when p_history_policy = 'since_join' then statement_timestamp() else null end;
  v_assignment record;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.group.create', p_kind = 'incident',
    case when p_kind = 'incident' then 900 else 0 end,
    '/v2/conversations/group', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  select * into v_organization
  from public.organizations organization
  where organization.id = p_organization_id
  for share;
  if not found or not private.actor_can_create_group(
    p_actor_user_id, p_organization_id, p_unit_id
  ) then
    raise exception 'group creation is not permitted' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('group', 'team', 'shift', 'incident')
    or char_length(btrim(coalesce(p_name, ''))) not between 1 and 160
    or (p_description is not null
      and char_length(btrim(p_description)) not between 1 and 2000)
    or p_history_policy is null
    or p_history_policy not in ('all', 'since_join')
    or p_posting_mode is null
    or p_posting_mode not in ('all_members', 'admins_only')
    or p_join_policy is null
    or p_join_policy not in ('inherit', 'invite_only', 'approval_required')
    or (p_kind in ('shift', 'incident') and p_join_policy <> 'invite_only')
    or (
      p_kind = 'incident' and (
        p_incident_severity is null
        or p_incident_severity not in ('low', 'medium', 'high', 'critical')
        or char_length(btrim(coalesce(p_incident_classification, '')))
          not between 1 and 120
      )
    )
    or (
      p_kind <> 'incident'
      and (p_incident_severity is not null
        or p_incident_classification is not null)
    ) then
    raise exception 'invalid group creation policy' using errcode = '22023';
  end if;
  if p_kind = 'incident' and not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'conversation.manage', p_unit_id
  ) then
    raise exception 'incident creation requires administrator permission'
      using errcode = '42501';
  end if;
  if p_unit_id is not null and not exists (
    select 1 from public.organization_units unit
    where unit.organization_id = p_organization_id
      and unit.id = p_unit_id and unit.is_active
  ) then
    raise exception 'active organization unit required' using errcode = '22023';
  end if;
  if p_unit_id is not null and not (
    exists (
      select 1 from public.organization_unit_members unit_member
      where unit_member.organization_id = p_organization_id
        and unit_member.unit_id = p_unit_id
        and unit_member.user_id = p_actor_user_id
    )
    or private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'conversation.manage', null
    )
  ) then
    raise exception 'group creator is not authorized for organization unit'
      using errcode = '42501';
  end if;

  if p_member_assignments is null
    or jsonb_typeof(p_member_assignments) <> 'array'
    or jsonb_array_length(p_member_assignments) < 1
    or jsonb_array_length(p_member_assignments) >= v_organization.default_group_member_limit
    or octet_length(p_member_assignments::text) > 262144
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      where jsonb_typeof(item.value) <> 'object'
        or not (item.value ? 'user_id' and item.value ? 'role')
        or exists (
          select 1 from jsonb_object_keys(item.value) supplied(key)
          where supplied.key not in ('user_id', 'role')
        )
        or jsonb_typeof(item.value -> 'user_id') <> 'string'
        or jsonb_typeof(item.value -> 'role') <> 'string'
        or item.value ->> 'role' not in ('owner', 'admin', 'member')
        or coalesce(item.value ->> 'user_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      where (item.value ->> 'user_id')::uuid = p_actor_user_id
    )
    or (
      select count(*) <> count(distinct item.value ->> 'user_id')
      from jsonb_array_elements(p_member_assignments) item(value)
    ) then
    raise exception 'invalid initial group member assignments' using errcode = '22023';
  end if;

  select jsonb_array_length(p_member_assignments) + 1 into v_member_count;
  if v_member_count > v_organization.default_group_member_limit
    or exists (
      select 1
      from jsonb_array_elements(p_member_assignments) item(value)
      left join public.organization_memberships membership
        on membership.organization_id = p_organization_id
       and membership.user_id = (item.value ->> 'user_id')::uuid
      where membership.user_id is null
        or not private.organization_membership_access_current(
          p_organization_id, (item.value ->> 'user_id')::uuid, now()
        )
        or not private.can_view_org_member_for_actor(
          p_organization_id, p_actor_user_id,
          (item.value ->> 'user_id')::uuid, now()
        )
        or not private.group_member_candidate_permitted(
          p_organization_id, p_actor_user_id, (item.value ->> 'user_id')::uuid
        )
        or (membership.membership_type = 'guest' and (
          not v_organization.allow_external_guests
          or item.value ->> 'role' <> 'member'
        ))
    ) then
    raise exception 'initial group membership is not permitted' using errcode = '42501';
  end if;

  v_effective_join_policy := case when p_join_policy = 'inherit'
    then v_organization.default_group_join_policy else p_join_policy end;
  v_visibility := case
    when p_unit_id is not null then 'unit'
    when v_effective_join_policy = 'approval_required' then 'organization'
    else 'invite_only'
  end;

  insert into public.conversations (
    id, organization_id, kind, name, description, visibility, unit_id,
    history_policy, incident_severity, incident_classification,
    member_limit, posting_mode, join_policy, created_by_user_id
  ) values (
    v_conversation_id, p_organization_id, p_kind, btrim(p_name),
    case when p_description is null then null else btrim(p_description) end,
    v_visibility, p_unit_id, p_history_policy, p_incident_severity,
    case when p_incident_classification is null then null
      else btrim(p_incident_classification) end,
    v_organization.default_group_member_limit, p_posting_mode, p_join_policy,
    p_actor_user_id
  );

  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id, v_conversation_id, p_actor_user_id, 'owner',
    p_actor_user_id, v_history_visible_from
  );
  for v_assignment in
    select (item.value ->> 'user_id')::uuid as user_id,
      item.value ->> 'role' as role
    from jsonb_array_elements(p_member_assignments)
      with ordinality item(value, ordinality)
    order by item.ordinality
  loop
    insert into public.conversation_members (
      organization_id, conversation_id, user_id, role, joined_by_user_id,
      history_visible_from
    ) values (
      p_organization_id, v_conversation_id, v_assignment.user_id,
      v_assignment.role, p_actor_user_id, v_history_visible_from
    );
  end loop;

  perform private.insert_conversation_system_event_internal(
    p_organization_id, v_conversation_id, p_actor_user_id,
    'conversation.created', null
  );
  for v_assignment in
    select (item.value ->> 'user_id')::uuid as user_id
    from jsonb_array_elements(p_member_assignments) item(value)
  loop
    perform private.insert_conversation_system_event_internal(
      p_organization_id, v_conversation_id, p_actor_user_id,
      'conversation.member.added', v_assignment.user_id
    );
  end loop;

  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id, metadata
  ) values (
    p_organization_id, p_actor_user_id, 'conversation.group.created',
    'conversation', v_conversation_id::text,
    jsonb_build_object(
      'kind', p_kind, 'member_count', v_member_count,
      'history_policy', p_history_policy, 'posting_mode', p_posting_mode,
      'join_policy', v_effective_join_policy,
      'guest_count', (
        select count(*)
        from jsonb_array_elements(p_member_assignments) item(value)
        join public.organization_memberships membership
          on membership.organization_id = p_organization_id
         and membership.user_id = (item.value ->> 'user_id')::uuid
        where membership.membership_type = 'guest'
      )
    )
  );

  v_response := jsonb_build_object(
    'conversation_id', v_conversation_id, 'kind', p_kind,
    'name', btrim(p_name),
    'description', case when p_description is null then null else btrim(p_description) end,
    'history_policy', p_history_policy,
    'history_disclosure', jsonb_build_object(
      'policy', p_history_policy, 'visible_from', v_history_visible_from,
      'label_key', case when p_history_policy = 'all'
        then 'conversation.history.all' else 'conversation.history.since_join' end
    ),
    'posting_mode', p_posting_mode,
    'join_policy', v_effective_join_policy,
    'configured_join_policy', p_join_policy,
    'visibility', v_visibility, 'member_count', v_member_count,
    'member_limit', v_organization.default_group_member_limit,
    'is_read_only', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/group',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
exception when invalid_text_representation then
  raise exception 'invalid initial group member assignments' using errcode = '22023';
end;
$$;


-- Full recreate of the 20260804172700 member addition. The only change is
-- the friends-only predicate after the directory-visibility check.
create or replace function private.bff_add_conversation_member_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_target_user_id uuid,
  p_role text,
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
  v_history_policy text;
  v_history_visible_from timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.add', false, 0, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256
  );
  if not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation administrator permission required'
      using errcode = '42501';
  end if;
  if p_target_user_id = p_actor_user_id
    and not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) then
    raise exception 'delegated managers cannot add themselves to conversations'
      using errcode = '42501';
  end if;
  -- Serialize member-limit validation with join approval and concurrent adds.
  -- The locked row also makes kind/lifecycle and dynamic-policy checks below
  -- describe one authoritative conversation state.
  perform 1
  from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind in ('group', 'team', 'shift', 'incident')
    and not conversation.is_archived
    and conversation.closed_at is null
  for update;
  if not found then
    raise exception 'open named group required' using errcode = '42501';
  end if;
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    ) and private.dynamic_group_policy_conversation(
      p_organization_id, p_conversation_id
    ) then
    raise exception 'delegated managers cannot override policy-managed membership'
      using errcode = '42501';
  end if;
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_role is null or p_role not in ('owner', 'admin', 'member') then
    raise exception 'invalid conversation role' using errcode = '22023';
  end if;
  if not private.actor_is_current_conversation_admin(
      p_actor_user_id, p_organization_id, p_conversation_id
    )
    and p_role <> 'member' then
    raise exception 'delegated managers may add conversation members only'
      using errcode = '42501';
  end if;
  if not private.organization_membership_access_current(
    p_organization_id, p_target_user_id, now()
  ) or not private.can_view_org_member_for_actor(
    p_organization_id, p_actor_user_id, p_target_user_id, now()
  ) then
    raise exception 'current organization member required' using errcode = '42501';
  end if;
  if not private.group_member_candidate_permitted(
    p_organization_id, p_actor_user_id, p_target_user_id
  ) then
    raise exception 'group members must be accepted contacts' using errcode = '42501';
  end if;
  perform set_config('app.delegated_conversation_management_context', 'on', true);
  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id, p_conversation_id, p_target_user_id, p_role,
    p_actor_user_id,
    case when exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.history_policy = 'since_join'
    ) then now() else null end
  );
  perform set_config('app.delegated_conversation_management_context', 'off', true);
  select conversation.history_policy, membership.history_visible_from
    into v_history_policy, v_history_visible_from
  from public.conversations conversation
  join public.conversation_members membership
    on membership.organization_id = conversation.organization_id
   and membership.conversation_id = conversation.id
   and membership.user_id = p_target_user_id
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  if exists (
    select 1 from public.conversation_members actor_member
    where actor_member.organization_id = p_organization_id
      and actor_member.conversation_id = p_conversation_id
      and actor_member.user_id = p_actor_user_id
      and actor_member.status = 'active'
  ) then
    perform private.insert_conversation_system_event_internal(
      p_organization_id, p_conversation_id, p_actor_user_id,
      'conversation.member.added', p_target_user_id
    );
  end if;
  perform private.broadcast_conversation_control_internal(
    p_organization_id, p_conversation_id, p_target_user_id, 'member_added'
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'role', p_role,
    'history_policy', v_history_policy,
    'history_visible_from', v_history_visible_from,
    'history_disclosure', jsonb_build_object(
      'policy', v_history_policy,
      'visible_from', v_history_visible_from,
      'label_key', case when v_history_policy = 'all'
        then 'conversation.history.all' else 'conversation.history.since_join' end
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;


-- Full recreate of the 20260804172200 group-creation candidate directory
-- with the friends-only predicate in the candidate filter.
create or replace function private.bff_list_group_creation_candidates_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_candidates jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.group.candidates.read', false, 0
  );
  if p_limit not between 1 and 100
    or char_length(btrim(coalesce(p_query, ''))) > 120 then
    raise exception 'invalid group candidate query' using errcode = '22023';
  end if;
  if not private.actor_can_create_group(
      p_actor_user_id, p_organization_id, null
    ) and not exists (
      select 1
      from public.organization_role_assignments assignment
      join public.organization_role_permissions permission
        on permission.role_name = assignment.role_name
       and permission.permission = 'conversation.manage'
      where assignment.organization_id = p_organization_id
        and assignment.user_id = p_actor_user_id
        and assignment.revoked_at is null
        and (assignment.expires_at is null or assignment.expires_at > now())
    ) then
    raise exception 'group creation is not permitted' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', candidate.user_id,
    'display_name', candidate.display_name,
    'avatar_path', candidate.avatar_path,
    'job_title', candidate.job_title,
    'membership_role', candidate.membership_role,
    'membership_type', candidate.membership_type,
    'access_expires_at', candidate.access_expires_at
  ) order by candidate.display_name, candidate.user_id), '[]'::jsonb)
  into v_candidates
  from (
    select membership.user_id, profile.display_name, profile.avatar_path,
      membership.job_title, membership.role as membership_role,
      membership.membership_type, membership.access_expires_at
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id <> p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, now()
      )
      and private.can_view_org_member_for_actor(
        p_organization_id, p_actor_user_id, membership.user_id, now()
      )
      and private.group_member_candidate_permitted(
        p_organization_id, p_actor_user_id, membership.user_id
      )
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or private.normalize_search_text(profile.display_name) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'
        or private.normalize_search_text(coalesce(membership.job_title, '')) like
          '%' || private.normalize_search_text(btrim(p_query)) || '%'
      )
    order by profile.display_name, membership.user_id
    limit p_limit
  ) candidate;
  return jsonb_build_object('candidates', v_candidates, 'limit', p_limit);
end;
$$;


-- Full recreate of the 20260804173000 member-candidate directory (its
-- 20260804173200 volatility alteration is re-applied below) with the
-- friends-only predicate in the eligible set.
create or replace function private.bff_list_conversation_member_candidates_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_query text default '',
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_snapshot_at timestamptz;
  v_query text;
  v_query_hash text;
  v_cursor_json jsonb;
  v_cursor_actor_user_id uuid;
  v_cursor_organization_id uuid;
  v_cursor_conversation_id uuid;
  v_after_name text;
  v_after_user_id uuid;
  v_candidates jsonb := '[]'::jsonb;
  v_has_more boolean := false;
  v_last_name text;
  v_last_user_id uuid;
  v_next_cursor text;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member_candidates.read', false, 0
  );

  if p_limit is null or p_limit not between 1 and 100
    or char_length(btrim(coalesce(p_query, ''))) > 120 then
    raise exception 'invalid conversation member candidate query'
      using errcode = '22023';
  end if;

  -- Keep the explicit tenant-membership check even though the canonical
  -- management helper also checks it. This endpoint must never become a
  -- directory oracle if that helper evolves independently.
  if not exists (
    select 1
    from public.organization_memberships actor
    where actor.organization_id = p_organization_id
      and actor.user_id = p_actor_user_id
      and actor.membership_type <> 'guest'
      and private.organization_membership_access_current(
        actor.organization_id, actor.user_id, v_now
      )
  ) or not exists (
    select 1
    from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.kind <> 'direct'
      and conversation.kind in ('group', 'team', 'shift', 'incident')
      and not conversation.is_archived
      and conversation.closed_at is null
  ) or not private.actor_can_manage_conversation(
    p_actor_user_id, p_organization_id, p_conversation_id
  ) then
    raise exception 'conversation member candidates unavailable'
      using errcode = '42501';
  end if;

  -- Published dynamic membership is reconciled exclusively by policy. Do not
  -- advertise manual additions that the write path and provenance trigger
  -- will reject, including to a current owner or administrator.
  if private.dynamic_group_policy_conversation(
    p_organization_id, p_conversation_id
  ) then
    return jsonb_build_object(
      'candidates', '[]'::jsonb,
      'next_cursor', null
    );
  end if;

  v_query := private.normalize_search_text(btrim(coalesce(p_query, '')));
  v_query_hash := encode(
    extensions.digest(convert_to(v_query, 'UTF8'), 'sha256'), 'hex'
  );

  if p_cursor is null then
    v_snapshot_at := v_now;
  else
    begin
      if char_length(p_cursor) > 1536
        or p_cursor !~ '^[A-Za-z0-9+/]+={0,2}$' then
        raise exception 'malformed cursor';
      end if;
      v_cursor_json := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      if jsonb_typeof(v_cursor_json) <> 'object'
        or (select count(*) from pg_catalog.jsonb_object_keys(v_cursor_json)) <> 9
        or not (v_cursor_json ?& array[
          'version', 'actor_user_id', 'organization_id', 'conversation_id',
          'query_sha256', 'page_size', 'snapshot_at', 'after_name', 'after_user_id'
        ])
        or v_cursor_json -> 'version' <> '1'::jsonb
        or coalesce(v_cursor_json ->> 'actor_user_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(v_cursor_json ->> 'organization_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(v_cursor_json ->> 'conversation_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(v_cursor_json ->> 'query_sha256', '') !~ '^[0-9a-f]{64}$'
        or coalesce(v_cursor_json ->> 'page_size', '') !~ '^[1-9][0-9]{0,2}$'
        or char_length(coalesce(v_cursor_json ->> 'after_name', '')) not between 1 and 160
        or coalesce(v_cursor_json ->> 'after_user_id', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception 'malformed cursor payload';
      end if;

      v_cursor_actor_user_id := (v_cursor_json ->> 'actor_user_id')::uuid;
      v_cursor_organization_id := (v_cursor_json ->> 'organization_id')::uuid;
      v_cursor_conversation_id := (v_cursor_json ->> 'conversation_id')::uuid;
      v_snapshot_at := (v_cursor_json ->> 'snapshot_at')::timestamptz;
      v_after_name := v_cursor_json ->> 'after_name';
      v_after_user_id := (v_cursor_json ->> 'after_user_id')::uuid;

      if v_cursor_actor_user_id is null
        or v_cursor_actor_user_id <> p_actor_user_id
        or v_cursor_organization_id is null
        or v_cursor_organization_id <> p_organization_id
        or v_cursor_conversation_id is null
        or v_cursor_conversation_id <> p_conversation_id
        or v_cursor_json ->> 'query_sha256' <> v_query_hash
        or (v_cursor_json ->> 'page_size')::integer <> p_limit
        or v_snapshot_at is null
        or not isfinite(v_snapshot_at)
        or v_snapshot_at > v_now + interval '1 minute'
        or v_snapshot_at < v_now - interval '15 minutes' then
        raise exception 'stale or mismatched cursor';
      end if;
    exception when others then
      raise exception 'invalid conversation member candidate cursor'
        using errcode = '22023';
    end;
  end if;

  with eligible as (
    select
      membership.user_id,
      profile.display_name,
      profile.avatar_path,
      membership.job_title as role_label,
      membership.membership_type,
      private.normalize_search_text(profile.display_name) as sort_name
    from public.organization_memberships membership
    join public.profiles profile
      on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.user_id <> p_actor_user_id
      and private.organization_membership_access_current(
        membership.organization_id, membership.user_id, v_now
      )
      and membership.updated_at <= v_snapshot_at
      and profile.updated_at <= v_snapshot_at
      and private.can_view_org_member_for_actor(
        p_organization_id, p_actor_user_id, membership.user_id, v_now
      )
      and private.group_member_candidate_permitted(
        p_organization_id, p_actor_user_id, membership.user_id
      )
      and not exists (
        select 1
        from public.conversation_members current_member
        where current_member.organization_id = p_organization_id
          and current_member.conversation_id = p_conversation_id
          and current_member.user_id = membership.user_id
      )
      and (
        v_query = ''
        or private.normalize_search_text(profile.display_name)
          like '%' || v_query || '%'
        or private.normalize_search_text(coalesce(membership.job_title, ''))
          like '%' || v_query || '%'
      )
  ), page as (
    select eligible.*
    from eligible
    where p_cursor is null
      or (eligible.sort_name, eligible.user_id) > (v_after_name, v_after_user_id)
    order by eligible.sort_name, eligible.user_id
    limit p_limit + 1
  ), numbered as (
    select page.*, row_number() over (
      order by page.sort_name, page.user_id
    ) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'user_id', numbered.user_id,
        'display_name', numbered.display_name,
        'avatar_path', numbered.avatar_path,
        'role_label', numbered.role_label,
        'membership_type', numbered.membership_type
      )) order by numbered.sort_name, numbered.user_id
    ) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    max(numbered.sort_name) filter (where numbered.row_number = p_limit),
    (max(numbered.user_id::text) filter (
      where numbered.row_number = p_limit
    ))::uuid
  into v_candidates, v_has_more, v_last_name, v_last_user_id
  from numbered;

  if v_has_more then
    v_next_cursor := replace(encode(convert_to(jsonb_build_object(
      'version', 1,
      'actor_user_id', p_actor_user_id,
      'organization_id', p_organization_id,
      'conversation_id', p_conversation_id,
      'query_sha256', v_query_hash,
      'page_size', p_limit,
      'snapshot_at', v_snapshot_at,
      'after_name', v_last_name,
      'after_user_id', v_last_user_id
    )::text, 'UTF8'), 'base64'), E'\n', '');
  end if;

  return jsonb_build_object(
    'candidates', v_candidates,
    'next_cursor', v_next_cursor
  );
end;
$$;

-- Re-apply the 20260804173200 volatility alteration: this recreate reset the
-- function to its originally-declared STABLE, but it makes a statement-time
-- authorization decision (clock_timestamp()-based cursor/session expiry), so
-- it must stay VOLATILE. The public wrapper was not recreated above and
-- still carries that migration's VOLATILE marking.
alter function private.bff_list_conversation_member_candidates_impl(
  uuid, uuid, uuid, uuid, text, text, integer
) volatile;

-- ---------------------------------------------------------------------------
-- 3. Conversation role hardening
-- ---------------------------------------------------------------------------

-- Full recreate of the 20260804172700 membership write validator. Two
-- changes: a conversation administrator may now promote a member to admin
-- or demote an admin to member (owner roles remain owner-only in every
-- direction, and the sole active owner is still retained), and delegated
-- organization managers are explicitly barred from any role change.
create or replace function private.validate_conversation_member_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_actor_conversation_role text;
  v_conversation_kind text;
  v_history_policy text;
  v_member_limit integer;
  v_conversation_creator uuid;
  v_existing_member_count integer;
  v_delegated_workflow boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(
      current_setting('app.delegated_conversation_management_context', true),
      'off'
    ) = 'on';
  v_delegated_manager boolean := false;
  v_offboarding boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.member_offboarding_context', true), 'off') = 'on';
  v_join_reactivation boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.conversation_join_reactivation_context', true), 'off') = 'on';
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = new.organization_id
        and membership.user_id = new.user_id
        and membership.status = 'active'
    ) then
      raise exception 'conversation members must be active organization members' using errcode = '23514';
    end if;

    select conversation.kind, conversation.member_limit, conversation.created_by_user_id
      into v_conversation_kind, v_member_limit, v_conversation_creator
    from public.conversations conversation
    where conversation.organization_id = new.organization_id
      and conversation.id = new.conversation_id;

    if v_conversation_kind = 'direct' and not exists (
      select 1 from public.direct_conversation_pairs pair
      where pair.organization_id = new.organization_id
        and pair.conversation_id = new.conversation_id
        and new.user_id in (pair.member_low_user_id, pair.member_high_user_id)
    ) then
      raise exception 'direct conversations are limited to their canonical pair' using errcode = '23514';
    end if;

    select count(*) into v_existing_member_count
    from public.conversation_members existing_member
    where existing_member.organization_id = new.organization_id
      and existing_member.conversation_id = new.conversation_id
      and existing_member.status = 'active';
    if v_existing_member_count >= v_member_limit then
      raise exception 'conversation member limit reached' using errcode = '23514';
    end if;

    if v_offboarding and v_actor_id is not null
      and new.user_id = v_actor_id and new.role = 'owner'
      and new.status = 'active' and new.left_at is null
      and v_conversation_kind in ('group', 'incident') then
      return new;
    end if;
    if v_actor_id is null and v_jwt_role = 'service_role' then return new; end if;
    if v_actor_id is null then
      raise exception 'signed-in user required' using errcode = '42501';
    end if;
    if new.status <> 'active' or new.left_at is not null then
      raise exception 'new conversation members must start active' using errcode = '22000';
    end if;
    if new.joined_by_user_id is distinct from v_actor_id then
      raise exception 'conversation join actor must match signed-in user' using errcode = '42501';
    end if;
    if v_conversation_kind = 'direct' then
      if v_actor_id <> v_conversation_creator then
        raise exception 'direct membership is created only by the conversation creator workflow' using errcode = '42501';
      end if;
      new.role := 'member';
      return new;
    end if;
    if v_existing_member_count = 0 then
      if v_actor_id <> v_conversation_creator or new.user_id <> v_actor_id or new.role <> 'owner' then
        raise exception 'the conversation creator must initialize the owner membership' using errcode = '42501';
      end if;
      return new;
    end if;
    select conversation_member.role into v_actor_conversation_role
    from public.conversation_members conversation_member
    where conversation_member.organization_id = new.organization_id
      and conversation_member.conversation_id = new.conversation_id
      and conversation_member.user_id = v_actor_id
      and conversation_member.status = 'active';
    v_delegated_manager := v_delegated_workflow
      and private.actor_can_manage_conversation(
        v_actor_id, new.organization_id, new.conversation_id
      );
    if coalesce(v_actor_conversation_role, '') not in ('owner', 'admin')
      and not v_delegated_manager then
      raise exception 'conversation administrator permission required' using errcode = '42501';
    end if;
    if v_delegated_manager
      and not private.actor_is_current_conversation_admin(
        v_actor_id, new.organization_id, new.conversation_id
      ) then
      if new.role <> 'member' then
        raise exception 'delegated managers may add conversation members only'
          using errcode = '42501';
      end if;
      if new.managed_by_policy_id is not null
        or private.dynamic_group_policy_conversation(
          new.organization_id, new.conversation_id
        ) then
        raise exception 'delegated managers cannot override policy-managed membership'
          using errcode = '42501';
      end if;
    end if;
    if new.role = 'owner' and coalesce(v_actor_conversation_role, '') <> 'owner' then
      raise exception 'only conversation owners may add another owner' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.user_id is distinct from old.user_id
    or new.joined_by_user_id is distinct from old.joined_by_user_id
    or new.joined_at is distinct from old.joined_at then
    raise exception 'conversation membership identity fields are immutable' using errcode = '22000';
  end if;

  if new.managed_by_policy_id is distinct from old.managed_by_policy_id
    and v_jwt_role <> 'service_role'
    and coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'dynamic membership provenance is server-owned' using errcode = '42501';
  end if;

  if v_offboarding and v_actor_id is not null then
    if new.user_id = v_actor_id and new.status = 'active' and new.role = 'owner'
      and new.left_at is null then return new; end if;
    if old.user_id <> v_actor_id
      and old.status = 'active' and new.status = 'removed'
      and new.role = (case when old.role = 'owner' then 'member' else old.role end)
      and new.can_post = false and new.left_at is not null
      and new.notification_level is not distinct from old.notification_level
      and new.muted_until is not distinct from old.muted_until
      and new.managed_by_policy_id is not distinct from old.managed_by_policy_id
      and new.history_visible_from is not distinct from old.history_visible_from then
      return new;
    end if;
  end if;

  if v_join_reactivation and v_actor_id is not null
    and old.user_id <> v_actor_id and old.status in ('left', 'removed')
    and new.status = 'active' and new.role = 'member' and new.can_post
    and new.left_at is null and old.managed_by_policy_id is null
    and new.managed_by_policy_id is null
    and new.notification_level is not distinct from old.notification_level
    and new.muted_until is not distinct from old.muted_until
    and exists (
      select 1 from public.organization_memberships target
      where target.organization_id = old.organization_id
        and target.user_id = old.user_id and target.status = 'active'
    ) then
    select administrator.role into v_actor_conversation_role
    from public.conversation_members administrator
    where administrator.organization_id = old.organization_id
      and administrator.conversation_id = old.conversation_id
      and administrator.user_id = v_actor_id
      and administrator.status = 'active';
    v_delegated_manager := v_delegated_workflow
      and private.actor_can_manage_conversation(
        v_actor_id, old.organization_id, old.conversation_id
      );
    select conversation.history_policy into v_history_policy
    from public.conversations conversation
    where conversation.organization_id = old.organization_id
      and conversation.id = old.conversation_id;
    if (
        coalesce(v_actor_conversation_role, '') not in ('owner', 'admin')
        and not v_delegated_manager
      )
      or (v_history_policy = 'all' and new.history_visible_from is not null)
      or (v_history_policy = 'since_join' and (
        new.history_visible_from is null
        or new.history_visible_from < statement_timestamp() - interval '5 minutes'
        or new.history_visible_from > statement_timestamp() + interval '1 minute'
      )) then
      raise exception 'approved conversation reactivation is invalid' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status <> 'active' and new.status = 'active' and v_jwt_role <> 'service_role' then
    raise exception 'left or removed members require a service workflow to rejoin' using errcode = '42501';
  end if;
  if new.status = 'active' then new.left_at := null;
  else new.left_at := coalesce(new.left_at, now()); end if;
  if v_actor_id is null and v_jwt_role = 'service_role' then return new; end if;
  if v_actor_id = old.user_id then
    if new.role is distinct from old.role
      or new.can_post is distinct from old.can_post
      or (new.status is distinct from old.status
        and not (old.status = 'active' and new.status = 'left')) then
      raise exception 'members may only change preferences or leave' using errcode = '42501';
    end if;
    -- A self-service leave is still a departure: the sole active owner
    -- cannot use it to walk away without transferring ownership first.
    -- (bff_leave_conversation_impl already enforces this earlier, by
    -- promoting a replacement owner in the same transaction before this
    -- row is touched, so that legitimate path always finds another active
    -- owner here; a raw client update against the directly-granted table
    -- privilege does not get that courtesy.)
    if old.role = 'owner' and old.status = 'active' and new.status = 'left' then
      perform 1 from public.conversations conversation
      where conversation.organization_id = old.organization_id
        and conversation.id = old.conversation_id for update;
      if not exists (
        select 1 from public.conversation_members other_owner
        where other_owner.organization_id = old.organization_id
          and other_owner.conversation_id = old.conversation_id
          and other_owner.user_id <> old.user_id
          and other_owner.role = 'owner' and other_owner.status = 'active'
      ) then
        raise exception 'a managed conversation must retain an active owner' using errcode = '23514';
      end if;
    end if;
    return new;
  end if;

  select conversation_member.role into v_actor_conversation_role
  from public.conversation_members conversation_member
  where conversation_member.organization_id = old.organization_id
    and conversation_member.conversation_id = old.conversation_id
    and conversation_member.user_id = v_actor_id
    and conversation_member.status = 'active';
  v_delegated_manager := v_delegated_workflow
    and private.actor_can_manage_conversation(
      v_actor_id, old.organization_id, old.conversation_id
    );
  if coalesce(v_actor_conversation_role, '') not in ('owner', 'admin')
    and not v_delegated_manager then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if v_delegated_manager
    and not private.actor_is_current_conversation_admin(
      v_actor_id, old.organization_id, old.conversation_id
    )
    and (
      old.role <> 'member'
      or new.role is distinct from old.role
      or old.managed_by_policy_id is not null
      or private.dynamic_group_policy_conversation(
        old.organization_id, old.conversation_id
      )
    ) then
    raise exception 'delegated managers may remove ordinary non-policy members only'
      using errcode = '42501';
  end if;
  -- Administrators manage ordinary member rows only (adding, removing,
  -- toggling posting rights). Anything that touches an owner or admin role
  -- -- promoting a member to admin, demoting or removing an admin, or any
  -- change that touches an owner -- stays owner-only. Ownership therefore
  -- transfers only through an owner, and only the owner promotes or demotes
  -- admins.
  if coalesce(v_actor_conversation_role, '') <> 'owner'
    and (
      old.role in ('owner', 'admin')
      or new.role in ('owner', 'admin')
    ) then
    raise exception 'only conversation owners may manage owner and admin roles'
      using errcode = '42501';
  end if;
  if old.role = 'owner' and old.status = 'active'
    and (new.role <> 'owner' or new.status <> 'active') then
    perform 1 from public.conversations conversation
    where conversation.organization_id = old.organization_id
      and conversation.id = old.conversation_id for update;
    if not exists (
      select 1 from public.conversation_members other_owner
      where other_owner.organization_id = old.organization_id
        and other_owner.conversation_id = old.conversation_id
        and other_owner.user_id <> old.user_id
        and other_owner.role = 'owner' and other_owner.status = 'active'
    ) then
      raise exception 'a managed conversation must retain an active owner' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Consumer summaries: the personal realm approves the 'summary' use case
-- ---------------------------------------------------------------------------

-- The platform consumer policy now approves language detection, translation,
-- and conversation summaries over the same pinned zero-retention route.
-- Existing enabled rows (every database that has served a signup) are
-- upgraded in place by appending the use case; the policy version is left
-- alone so in-flight detection and translation jobs resolved against the
-- current version still complete. A revoked row is never touched: an
-- explicit revocation through the audited v2 command stays permanent.
-- Summaries produced for consumers stay drafts until reviewed
-- (conversation_summary_policies.require_human_review is untouched); the
-- consumer client renders drafts as unapproved.
create or replace function private.ensure_personal_realm_ai_policy()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_realm_id uuid := private.personal_realm_organization_id();
  v_approver_user_id uuid;
  v_use_cases text[] := array['language_detection', 'translation', 'summary']::text[];
begin
  -- Existing row: upgrade an enabled, unrevoked platform policy that predates
  -- consumer summaries; leave anything else (including revocations) alone.
  if exists (
    select 1 from public.organization_ai_policies policy
    where policy.organization_id = v_realm_id
  ) then
    update public.organization_ai_policies policy
    set approved_use_cases = array_append(policy.approved_use_cases, 'summary')
    where policy.organization_id = v_realm_id
      and policy.enabled
      and policy.revoked_at is null
      and policy.route_policy = 'approved_zero_retention'
      and not ('summary' = any(policy.approved_use_cases))
    returning policy.approved_by_user_id into v_approver_user_id;
    if found then
      insert into public.audit_events (
        organization_id, actor_user_id, event_type, target_type, target_id,
        metadata
      ) values (
        v_realm_id, v_approver_user_id, 'organization.ai_policy.updated',
        'organization_ai_policy', v_realm_id::text,
        jsonb_build_object(
          'enabled', true,
          'approved_use_cases', to_jsonb(v_use_cases),
          'provider_allowlist',
            to_jsonb(array['google-vertex/us-south1']::text[]),
          'route_policy', 'approved_zero_retention',
          'reason',
            'Platform default: consumer conversation summaries are enabled '
            || 'for the personal realm over the pinned zero-retention route. '
            || 'Outputs remain unapproved drafts until reviewed.',
          'source', 'platform_consumer_default',
          'migration', '20260903030000_desync_audit_and_consumer_rules'
        )
      );
    end if;
    return;
  end if;

  if not exists (
    select 1 from public.organizations organization
    where organization.id = v_realm_id
  ) then
    return;
  end if;

  -- The approval-consistency constraint requires a realm-member approver.
  -- The earliest active member records the platform decision; consumer
  -- authority never derives from this provenance column. When invoked from
  -- redeem_signup_impl the redeeming member always satisfies this lookup.
  select membership.user_id into v_approver_user_id
  from public.organization_memberships membership
  where membership.organization_id = v_realm_id
    and membership.status = 'active'
  order by membership.joined_at, membership.user_id
  limit 1;
  if v_approver_user_id is null then
    return;
  end if;

  insert into public.organization_ai_policies (
    organization_id, enabled, policy_version, approved_use_cases,
    provider_allowlist, route_policy, approved_by_user_id, approved_at
  ) values (
    v_realm_id, true, 1, v_use_cases,
    array['google-vertex/us-south1']::text[],
    'approved_zero_retention', v_approver_user_id, now()
  )
  on conflict (organization_id) do nothing;
  if not found then
    return;
  end if;

  -- Mirror the audited v2 command's event shape so policy monitoring sees
  -- one stream. The generic table audit trigger also records the insert.
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id,
    metadata
  ) values (
    v_realm_id, v_approver_user_id, 'organization.ai_policy.enabled',
    'organization_ai_policy', v_realm_id::text,
    jsonb_build_object(
      'policy_version', 1,
      'enabled', true,
      'approved_use_cases', to_jsonb(v_use_cases),
      'provider_allowlist',
        to_jsonb(array['google-vertex/us-south1']::text[]),
      'route_policy', 'approved_zero_retention',
      'reason',
        'Platform default: consumer personal-realm translation between '
        || 'en/es/ko and conversation summaries are enabled at signup per '
        || 'the published privacy policy. Members opt out of translation '
        || 'per conversation via translation preferences; summaries remain '
        || 'unapproved drafts until reviewed.',
      'source', 'platform_consumer_default',
      'migration', '20260903030000_desync_audit_and_consumer_rules'
    )
  );
end;
$$;

revoke all on function private.ensure_personal_realm_ai_policy()
  from public, anon, authenticated, service_role;
comment on function private.ensure_personal_realm_ai_policy() is
  'Idempotently provisions the platform-approved personal-realm AI policy (language_detection + translation + summary over the pinned zero-retention route) once the realm and its first member exist, and appends the summary use case to an earlier enabled platform row. Never overwrites a revoked policy row.';

-- Databases where the realm already exists receive the upgrade immediately;
-- fresh databases no-op here and are covered by signup redemption.
select private.ensure_personal_realm_ai_policy();

commit;
