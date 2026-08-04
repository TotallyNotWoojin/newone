begin;

-- Newone is an authenticated, multi-tenant workplace messenger. The public
-- schema is the explicit Data API surface; implementation helpers and rate
-- limit state live in a schema that PostgREST does not expose.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists unaccent with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
revoke create on schema public from public;

-- The unaccent dictionary is installation-owned and static for the lifetime of
-- a release. This immutable wrapper makes normalized search expressions safe
-- for indexes and keeps extension schema resolution explicit.
create or replace function private.normalize_search_text(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select regexp_replace(
    lower(extensions.unaccent(coalesce(p_value, ''))),
    '[[:punct:]_]+', ' ', 'g'
  )
$$;

create or replace function private.bounded_text_array(
  p_values text[], p_max_count integer, p_min_length integer, p_max_length integer
)
returns boolean
language sql immutable security invoker set search_path = ''
as $$
  select cardinality(p_values) between 0 and p_max_count
    and coalesce((select bool_and(char_length(btrim(value)) between p_min_length and p_max_length)
      from unnest(p_values) value), true)
$$;

create or replace function private.valid_acknowledgement_schema(p_schema jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_required boolean;
  v_prompt text;
  v_keys jsonb;
begin
  if jsonb_typeof(p_schema) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(p_schema) key
      where key not in (
        'schema_version', 'attestation_required', 'attestation_prompt',
        'required_keys', 'carry_forward_on_correction'
      )
    )
    or jsonb_typeof(p_schema -> 'schema_version') <> 'number'
    or (p_schema ->> 'schema_version')::integer <> 1
    or jsonb_typeof(p_schema -> 'attestation_required') <> 'boolean'
    or jsonb_typeof(p_schema -> 'carry_forward_on_correction') <> 'boolean'
    or jsonb_typeof(p_schema -> 'required_keys') <> 'array'
    or jsonb_array_length(p_schema -> 'required_keys') > 20 then
    return false;
  end if;
  v_required := (p_schema ->> 'attestation_required')::boolean;
  v_prompt := p_schema ->> 'attestation_prompt';
  v_keys := p_schema -> 'required_keys';
  if (not v_required and (v_prompt is not null or jsonb_array_length(v_keys) <> 0))
    or (v_required and (
      char_length(coalesce(v_prompt, '')) not between 3 and 500
      or jsonb_array_length(v_keys) = 0
    ))
    or exists (
      select 1 from jsonb_array_elements(v_keys) element
      where jsonb_typeof(element) <> 'string'
        or trim(both '"' from element::text) !~ '^[a-z][a-z0-9_]{0,63}$'
    )
    or (
      select count(*) <> count(distinct element #>> '{}')
      from jsonb_array_elements(v_keys) element
    )
    or (p_schema ->> 'carry_forward_on_correction')::boolean then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

create or replace function private.valid_reminder_policy(
  p_policy jsonb,
  p_publish_at timestamptz
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_deadline timestamptz;
  v_interval integer;
  v_maximum integer;
  v_escalate integer;
  v_sms boolean;
begin
  if jsonb_typeof(p_policy) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(p_policy) key
      where key not in (
        'enabled', 'deadline_at', 'interval_seconds', 'maximum_reminders',
        'escalate_after_seconds', 'sms_fallback'
      )
    )
    or jsonb_typeof(p_policy -> 'enabled') <> 'boolean'
    or jsonb_typeof(p_policy -> 'maximum_reminders') <> 'number'
    or jsonb_typeof(p_policy -> 'sms_fallback') <> 'boolean' then
    return false;
  end if;
  v_enabled := (p_policy ->> 'enabled')::boolean;
  v_deadline := nullif(p_policy ->> 'deadline_at', '')::timestamptz;
  v_interval := nullif(p_policy ->> 'interval_seconds', '')::integer;
  v_maximum := (p_policy ->> 'maximum_reminders')::integer;
  v_escalate := nullif(p_policy ->> 'escalate_after_seconds', '')::integer;
  v_sms := (p_policy ->> 'sms_fallback')::boolean;
  if not v_enabled then
    return v_deadline is null and v_interval is null and v_maximum = 0
      and v_escalate is null and not v_sms;
  end if;
  return p_publish_at is not null
    and v_deadline > p_publish_at
    and v_interval between 300 and 604800
    and v_maximum between 1 and 20
    and (v_escalate is null or (
      v_escalate between 900 and 2592000 and v_escalate >= v_interval
    ))
    and not v_sms;
exception when others then
  return false;
end;
$$;

create or replace function private.attestation_satisfies_schema(
  p_schema jsonb,
  p_attestation jsonb
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if not private.valid_acknowledgement_schema(p_schema)
    or jsonb_typeof(p_attestation) <> 'object'
    or octet_length(p_attestation::text) > 8192 then
    return false;
  end if;
  if not (p_schema ->> 'attestation_required')::boolean then
    return p_attestation = '{}'::jsonb;
  end if;
  return not exists (
      select 1 from jsonb_array_elements_text(p_schema -> 'required_keys') required(key)
      where not p_attestation ? required.key
        or p_attestation -> required.key = 'null'::jsonb
    )
    and not exists (
      select 1 from jsonb_object_keys(p_attestation) supplied(key)
      where not (p_schema -> 'required_keys') ? supplied.key
    );
exception when others then
  return false;
end;
$$;

alter default privileges for role postgres in schema public
  revoke select, insert, update, delete on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke usage, select on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke execute on functions from public, anon, authenticated, service_role;

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete restrict,
  display_name text not null,
  avatar_path text,
  status_message text,
  preferred_language text not null default 'en',
  time_zone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(btrim(display_name)) between 1 and 120),
  constraint profiles_avatar_path_length check (avatar_path is null or char_length(avatar_path) <= 1024),
  constraint profiles_status_message_length check (status_message is null or char_length(status_message) <= 280),
  constraint profiles_language_length check (char_length(preferred_language) between 2 and 35),
  constraint profiles_time_zone_length check (char_length(time_zone) between 1 and 100)
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  default_language text not null default 'en',
  message_retention_days integer not null default 365,
  allow_member_direct_messages boolean not null default true,
  dm_policy text not null default 'directory_open',
  require_mfa_for_admins boolean not null default true,
  shift_schedule_authoritative boolean not null default false,
  created_by_user_id uuid not null references public.profiles (user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) between 3 and 63),
  constraint organizations_name_length check (char_length(btrim(name)) between 1 and 160),
  constraint organizations_language_length check (char_length(default_language) between 2 and 35),
  constraint organizations_retention_range check (message_retention_days between 1 and 3650),
  constraint organizations_dm_policy_allowed check (
    dm_policy in ('directory_open', 'request_first', 'scoped_unit')
  )
);

create table public.organization_units (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  parent_unit_id uuid,
  kind text not null,
  name text not null,
  is_active boolean not null default true,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, parent_unit_id)
    references public.organization_units (organization_id, id) on delete restrict,
  constraint organization_units_kind_allowed check (kind in ('site', 'department', 'team', 'shift')),
  constraint organization_units_name_length check (char_length(btrim(name)) between 1 and 160),
  constraint organization_units_not_own_parent check (parent_unit_id is null or parent_unit_id <> id)
);

create table public.organization_memberships (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  user_id uuid not null references public.profiles (user_id) on delete restrict,
  role text not null default 'member',
  status text not null default 'active',
  employee_code text,
  job_title text,
  directory_visibility text not null default 'organization',
  invited_by_user_id uuid,
  joined_at timestamptz not null default now(),
  deactivated_at timestamptz,
  revocation_generation bigint not null default 0,
  security_changed_at timestamptz,
  security_changed_by_user_id uuid,
  status_change_reason text,
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, invited_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, security_changed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint organization_memberships_role_allowed check (role in ('owner', 'admin', 'manager', 'member')),
  constraint organization_memberships_status_allowed check (status in ('active', 'suspended', 'deactivated')),
  constraint organization_memberships_visibility_allowed check (directory_visibility in ('organization', 'unit', 'private')),
  constraint organization_memberships_employee_code_length check (employee_code is null or char_length(employee_code) <= 80),
  constraint organization_memberships_job_title_length check (job_title is null or char_length(job_title) <= 160),
  constraint organization_memberships_revocation_generation_nonnegative check (revocation_generation >= 0),
  constraint organization_memberships_status_reason_length check (
    status_change_reason is null or char_length(btrim(status_change_reason)) between 3 and 500
  ),
  constraint organization_memberships_security_change_consistent check (
    (security_changed_at is null and security_changed_by_user_id is null and status_change_reason is null)
    or (security_changed_at is not null and security_changed_by_user_id is not null and status_change_reason is not null)
  ),
  constraint organization_memberships_deactivation_consistent check (
    (status = 'deactivated' and deactivated_at is not null)
    or (status <> 'deactivated' and deactivated_at is null)
  )
);

alter table public.organization_units
  add constraint organization_units_created_by_membership_fkey
  foreign key (organization_id, created_by_user_id)
  references public.organization_memberships (organization_id, user_id) on delete restrict;

create table public.organization_unit_members (
  organization_id uuid not null,
  unit_id uuid not null,
  user_id uuid not null,
  is_lead boolean not null default false,
  added_at timestamptz not null default now(),
  primary key (organization_id, unit_id, user_id),
  foreign key (organization_id, unit_id)
    references public.organization_units (organization_id, id) on delete restrict,
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict
);

create table public.member_blocks (
  organization_id uuid not null,
  blocker_user_id uuid not null,
  blocked_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, blocker_user_id, blocked_user_id),
  foreign key (organization_id, blocker_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, blocked_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint member_blocks_distinct_users check (blocker_user_id <> blocked_user_id)
);

create table public.contact_connections (
  organization_id uuid not null,
  member_low_user_id uuid not null,
  member_high_user_id uuid not null,
  requested_by_user_id uuid not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, member_low_user_id, member_high_user_id),
  foreign key (organization_id, member_low_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, member_high_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, requested_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint contact_connections_canonical_pair check (member_low_user_id < member_high_user_id),
  constraint contact_connections_requester_participates check (
    requested_by_user_id in (member_low_user_id, member_high_user_id)
  ),
  constraint contact_connections_status_allowed check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  constraint contact_connections_response_consistent check (
    (status = 'pending' and responded_at is null)
    or (status <> 'pending' and responded_at is not null)
  )
);

create table public.conversations (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  kind text not null,
  name text,
  description text,
  avatar_path text,
  visibility text not null default 'invite_only',
  unit_id uuid,
  history_policy text not null default 'since_join',
  incident_severity text,
  incident_classification text,
  closed_at timestamptz,
  closed_by_user_id uuid,
  closure_reason text,
  member_limit integer not null default 500,
  created_by_user_id uuid not null,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, created_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, unit_id)
    references public.organization_units (organization_id, id) on delete restrict,
  foreign key (organization_id, closed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint conversations_kind_allowed check (kind in ('direct', 'group', 'team', 'announcement', 'shift', 'incident')),
  constraint conversations_visibility_allowed check (visibility in ('invite_only', 'unit', 'organization')),
  constraint conversations_history_policy_allowed check (history_policy in ('all', 'since_join')),
  constraint conversations_name_length check (name is null or char_length(btrim(name)) between 1 and 160),
  constraint conversations_description_length check (description is null or char_length(description) <= 2000),
  constraint conversations_avatar_path_length check (avatar_path is null or char_length(avatar_path) <= 1024),
  constraint conversations_member_limit_range check (member_limit between 2 and 5000),
  constraint conversations_unit_visibility_consistent check (visibility <> 'unit' or unit_id is not null),
  constraint conversations_direct_shape check (
    kind <> 'direct'
    or (name is null and description is null and visibility = 'invite_only' and member_limit = 2)
  ),
  constraint conversations_incident_shape check (
    (kind = 'incident'
      and incident_severity in ('low', 'medium', 'high', 'critical')
      and char_length(btrim(incident_classification)) between 1 and 120)
    or (kind <> 'incident' and incident_severity is null and incident_classification is null
      and closed_at is null and closed_by_user_id is null and closure_reason is null)
  ),
  constraint conversations_incident_closure_consistent check (
    (closed_at is null and closed_by_user_id is null and closure_reason is null)
    or (kind = 'incident' and closed_at is not null and closed_by_user_id is not null
      and char_length(btrim(closure_reason)) between 3 and 2000)
  )
);

create table public.direct_conversation_pairs (
  organization_id uuid not null,
  conversation_id uuid not null,
  member_low_user_id uuid not null,
  member_high_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, conversation_id),
  unique (organization_id, member_low_user_id, member_high_user_id),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, member_low_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, member_high_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint direct_conversation_pairs_canonical check (member_low_user_id < member_high_user_id)
);

create table public.conversation_members (
  organization_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  role text not null default 'member',
  status text not null default 'active',
  can_post boolean not null default true,
  notification_level text not null default 'all',
  muted_until timestamptz,
  joined_by_user_id uuid,
  joined_at timestamptz not null default now(),
  history_visible_from timestamptz,
  left_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, user_id),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, joined_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint conversation_members_role_allowed check (role in ('owner', 'admin', 'member')),
  constraint conversation_members_status_allowed check (status in ('active', 'left', 'removed')),
  constraint conversation_members_notification_allowed check (notification_level in ('all', 'mentions', 'none')),
  constraint conversation_members_left_consistent check (
    (status = 'active' and left_at is null)
    or (status <> 'active' and left_at is not null)
  )
);

create table public.messages (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  conversation_id uuid not null,
  sender_user_id uuid not null,
  client_nonce uuid not null default gen_random_uuid(),
  kind text not null default 'text',
  body text,
  -- language_code is an untrusted client hint retained for diagnostics only.
  -- Routing uses the trusted detection fields below.
  language_code text,
  detected_language text,
  language_detection_state text not null default 'pending',
  language_detection_method text,
  language_detection_confidence numeric(5,4),
  language_detected_at timestamptz,
  reply_to_message_id bigint,
  thread_root_message_id bigint,
  metadata jsonb not null default '{}'::jsonb,
  body_search tsvector generated always as (
    to_tsvector('simple', private.normalize_search_text(coalesce(body, '')))
  ) stored,
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by_user_id uuid,
  deletion_reason text,
  available_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (organization_id, conversation_id, id),
  unique (organization_id, conversation_id, sender_user_id, client_nonce),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, sender_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, conversation_id, reply_to_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, thread_root_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, deleted_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint messages_kind_allowed check (kind in ('text', 'attachment', 'system')),
  constraint messages_body_length check (body is null or char_length(body) <= 20000),
  constraint messages_language_length check (language_code is null or char_length(language_code) between 2 and 35),
  constraint messages_detected_language_length check (
    detected_language is null or char_length(detected_language) between 2 and 35
  ),
  constraint messages_language_detection_state_allowed check (
    language_detection_state in ('pending', 'completed', 'ambiguous', 'failed', 'not_applicable')
  ),
  constraint messages_language_detection_confidence check (
    language_detection_confidence is null or language_detection_confidence between 0 and 1
  ),
  constraint messages_language_detection_consistent check (
    (language_detection_state = 'pending'
      and detected_language is null and language_detection_method is null
      and language_detection_confidence is null and language_detected_at is null)
    or (language_detection_state = 'completed'
      and detected_language is not null and detected_language <> 'und'
      and language_detection_method is not null and language_detected_at is not null)
    or (language_detection_state = 'ambiguous'
      and detected_language = 'und' and language_detection_method is not null
      and language_detected_at is not null)
    or (language_detection_state = 'failed'
      and detected_language is null and language_detection_method is not null
      and language_detected_at is not null)
    or (language_detection_state = 'not_applicable'
      and detected_language is null and language_detected_at is not null)
  ),
  constraint messages_metadata_object check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  constraint messages_available_at_bounded check (available_at >= created_at - interval '1 second'),
  constraint messages_text_has_body check (deleted_at is not null or kind <> 'text' or char_length(btrim(coalesce(body, ''))) > 0),
  constraint messages_deletion_reason_allowed check (deletion_reason is null or deletion_reason in ('user', 'retention')),
  constraint messages_deletion_consistent check (
    (deleted_at is null and deleted_by_user_id is null and deletion_reason is null)
    or (
      deleted_at is not null
      and body is null
      and (
        (deletion_reason = 'user' and deleted_by_user_id is not null)
        or (deletion_reason = 'retention' and deleted_by_user_id is null)
      )
    )
  )
);

create table public.message_translations (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  source_language text not null,
  target_language text not null,
  source_body_sha256 bytea not null,
  status text not null default 'queued',
  translated_body text,
  translated_body_search tsvector generated always as (
    to_tsvector('simple', private.normalize_search_text(coalesce(translated_body, '')))
  ) stored,
  provider text,
  model text,
  confidence numeric(5,4),
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, conversation_id, message_id, target_language),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, reviewed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint message_translations_distinct_languages check (source_language <> target_language),
  constraint message_translations_source_hash_length check (octet_length(source_body_sha256) = 32),
  constraint message_translations_language_lengths check (
    char_length(source_language) between 2 and 35 and char_length(target_language) between 2 and 35
  ),
  constraint message_translations_status_allowed check (status in ('queued', 'processing', 'completed', 'failed', 'blocked')),
  constraint message_translations_body_length check (translated_body is null or char_length(translated_body) <= 20000),
  constraint message_translations_provider_length check (provider is null or char_length(provider) between 2 and 80),
  constraint message_translations_model_length check (model is null or char_length(model) between 2 and 200),
  constraint message_translations_failure_code_length check (failure_code is null or char_length(failure_code) <= 120),
  constraint message_translations_completion_consistent check (
    (status = 'completed' and translated_body is not null and provider is not null and model is not null)
    or (status <> 'completed' and translated_body is null)
  ),
  constraint message_translations_confidence_range check (confidence is null or confidence between 0 and 1),
  constraint message_translations_review_consistent check (
    (reviewed_at is null and reviewed_by_user_id is null)
    or (reviewed_at is not null and reviewed_by_user_id is not null)
  )
);

create table public.message_reactions (
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  user_id uuid not null,
  emoji text not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, message_id, user_id, emoji),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  constraint message_reactions_emoji_length check (char_length(emoji) between 1 and 32)
);

create table public.conversation_read_cursors (
  organization_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  last_read_message_id bigint,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, user_id),
  foreign key (organization_id, conversation_id, user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, conversation_id, last_read_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict
);

create table public.announcements (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  title text not null,
  priority text not null default 'normal',
  status text not null default 'published',
  requires_acknowledgement boolean not null default false,
  acknowledgement_schema jsonb not null default '{"schema_version":1,"attestation_required":false,"attestation_prompt":null,"required_keys":[],"carry_forward_on_correction":false}'::jsonb,
  notification_class text not null default 'routine',
  critical_category text,
  quiet_hours_override_reason text,
  reminder_policy jsonb not null default '{"enabled":false,"deadline_at":null,"interval_seconds":null,"maximum_reminders":0,"escalate_after_seconds":null,"sms_fallback":false}'::jsonb,
  scheduled_at timestamptz,
  published_at timestamptz default now(),
  expires_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by_user_id uuid,
  cancellation_reason text,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, conversation_id, message_id),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, created_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, cancelled_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint announcements_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint announcements_priority_allowed check (priority in ('normal', 'important', 'emergency')),
  constraint announcements_status_allowed check (status in ('draft', 'scheduled', 'published', 'cancelled', 'archived')),
  constraint announcements_notification_class_allowed check (notification_class in ('routine', 'urgent', 'critical')),
  constraint announcements_critical_override_consistent check (
    (notification_class = 'routine'
      and critical_category is null and quiet_hours_override_reason is null)
    or (notification_class in ('urgent', 'critical')
      and critical_category in ('safety', 'security', 'operations', 'weather', 'business_continuity')
      and char_length(btrim(quiet_hours_override_reason)) between 3 and 500)
  ),
  constraint announcements_ack_schema_object check (
    jsonb_typeof(acknowledgement_schema) = 'object' and octet_length(acknowledgement_schema::text) <= 8192
  ),
  constraint announcements_reminder_policy_object check (
    jsonb_typeof(reminder_policy) = 'object' and octet_length(reminder_policy::text) <= 8192
  ),
  constraint announcements_expiry_after_publish check (
    expires_at is null or expires_at > coalesce(published_at, scheduled_at, created_at)
  ),
  constraint announcements_schedule_consistent check (
    (status = 'scheduled' and scheduled_at is not null and published_at is null
      and cancelled_at is null and cancelled_by_user_id is null and cancellation_reason is null)
    or (status in ('published', 'archived') and published_at is not null
      and cancelled_at is null and cancelled_by_user_id is null and cancellation_reason is null)
    or (status = 'cancelled' and scheduled_at is not null and published_at is null
      and cancelled_at is not null and cancelled_by_user_id is not null)
    or (status = 'draft' and published_at is null and cancelled_at is null
      and cancelled_by_user_id is null and cancellation_reason is null)
  ),
  constraint announcements_cancellation_reason_length check (
    cancellation_reason is null or char_length(btrim(cancellation_reason)) between 3 and 2000
  )
);

create table public.announcement_recipients (
  organization_id uuid not null,
  announcement_id uuid not null,
  user_id uuid not null,
  delivered_at timestamptz,
  read_at timestamptz,
  reminder_count integer not null default 0,
  last_reminded_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (organization_id, announcement_id, user_id),
  foreign key (organization_id, announcement_id)
    references public.announcements (organization_id, id) on delete restrict,
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint announcement_recipients_read_after_delivery check (
    read_at is null or delivered_at is null or read_at >= delivered_at
  ),
  constraint announcement_recipients_reminder_count_nonnegative check (reminder_count between 0 and 20)
);

create table public.announcement_acknowledgements (
  organization_id uuid not null,
  announcement_id uuid not null,
  user_id uuid not null,
  acknowledged_at timestamptz not null default now(),
  session_id uuid,
  device_id uuid,
  attestation jsonb not null default '{}'::jsonb,
  role_snapshot text not null default 'member',
  scope_snapshot jsonb not null default '[]'::jsonb,
  primary key (organization_id, announcement_id, user_id),
  foreign key (organization_id, announcement_id, user_id)
    references public.announcement_recipients (organization_id, announcement_id, user_id) on delete restrict,
  foreign key (session_id) references auth.sessions (id) on delete set null,
  constraint announcement_acknowledgements_attestation_object check (
    jsonb_typeof(attestation) = 'object' and octet_length(attestation::text) <= 8192
  ),
  constraint announcement_acknowledgements_scope_array check (
    jsonb_typeof(scope_snapshot) = 'array' and octet_length(scope_snapshot::text) <= 16384
  )
);

create table public.shift_handoffs (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  author_user_id uuid not null,
  title text not null,
  details text not null,
  source_language text not null,
  status text not null default 'draft',
  shift_started_at timestamptz not null,
  shift_ended_at timestamptz not null,
  source_message_ids bigint[] not null default '{}'::bigint[],
  source_fingerprint bytea not null default extensions.digest(convert_to('', 'UTF8'), 'sha256'),
  acknowledgement_due_at timestamptz,
  submitted_at timestamptz,
  signed_session_id uuid,
  signed_device_id uuid,
  signed_role_snapshot text,
  signed_scope_snapshot jsonb,
  reminder_count integer not null default 0,
  last_reminded_at timestamptz,
  escalated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, conversation_id, author_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (signed_session_id) references auth.sessions (id) on delete set null,
  constraint shift_handoffs_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint shift_handoffs_details_length check (char_length(btrim(details)) between 1 and 30000),
  constraint shift_handoffs_language_length check (char_length(source_language) between 2 and 35),
  constraint shift_handoffs_status_allowed check (status in ('draft', 'submitted', 'closed')),
  constraint shift_handoffs_time_order check (shift_ended_at > shift_started_at),
  constraint shift_handoffs_due_after_shift check (
    acknowledgement_due_at is null or acknowledgement_due_at > shift_ended_at
  ),
  constraint shift_handoffs_source_ids_bounded check (
    cardinality(source_message_ids) between 0 and 500
  ),
  constraint shift_handoffs_source_fingerprint_length check (
    octet_length(source_fingerprint) = 32
  ),
  constraint shift_handoffs_reminder_count_nonnegative check (reminder_count between 0 and 20),
  constraint shift_handoffs_signed_scope_array check (
    signed_scope_snapshot is null or (jsonb_typeof(signed_scope_snapshot) = 'array'
      and octet_length(signed_scope_snapshot::text) <= 16384)
  ),
  constraint shift_handoffs_submission_consistent check (
    (status = 'draft' and submitted_at is null)
    or (status <> 'draft' and submitted_at is not null)
  )
);

create table public.handoff_acknowledgements (
  organization_id uuid not null,
  handoff_id uuid not null,
  user_id uuid not null,
  note text,
  acknowledged_at timestamptz not null default now(),
  session_id uuid,
  device_id uuid,
  role_snapshot text not null default 'member',
  scope_snapshot jsonb not null default '[]'::jsonb,
  primary key (organization_id, handoff_id, user_id),
  foreign key (organization_id, handoff_id)
    references public.shift_handoffs (organization_id, id) on delete restrict,
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (session_id) references auth.sessions (id) on delete set null,
  constraint handoff_acknowledgements_note_length check (note is null or char_length(note) <= 2000),
  constraint handoff_acknowledgements_scope_array check (
    jsonb_typeof(scope_snapshot) = 'array' and octet_length(scope_snapshot::text) <= 16384
  )
);

create table public.message_attachments (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  created_by_user_id uuid not null,
  bucket_id text not null default 'message-attachments',
  storage_path text not null,
  file_name text not null,
  file_name_search tsvector generated always as (
    to_tsvector('simple', private.normalize_search_text(file_name))
  ) stored,
  mime_type text not null,
  byte_size bigint not null,
  sha256_hex text,
  scan_status text not null default 'pending',
  scan_completed_at timestamptz,
  scanner_name text,
  scanner_version text,
  scan_failure_code text,
  detected_mime_type text,
  scan_policy_code text,
  purge_requested_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (bucket_id, storage_path),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, created_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  constraint message_attachments_bucket_fixed check (bucket_id = 'message-attachments'),
  constraint message_attachments_path_scoped check (
    storage_path like organization_id::text || '/' || conversation_id::text || '/' || created_by_user_id::text || '/' || id::text || '/%'
    and storage_path !~ '(^|/)\.\.(/|$)'
  ),
  constraint message_attachments_file_name_length check (char_length(file_name) between 1 and 255 and file_name !~ '[/\\]'),
  constraint message_attachments_mime_length check (char_length(mime_type) between 3 and 160),
  constraint message_attachments_byte_size_range check (byte_size between 1 and 26214400),
  constraint message_attachments_sha256_format check (sha256_hex is null or sha256_hex ~ '^[0-9a-f]{64}$'),
  constraint message_attachments_scan_status_allowed check (scan_status in ('pending', 'clean', 'quarantined', 'failed')),
  constraint message_attachments_scanner_lengths check (
    (scanner_name is null or char_length(scanner_name) between 2 and 120)
    and (scanner_version is null or char_length(scanner_version) between 1 and 120)
    and (scan_failure_code is null or char_length(scan_failure_code) between 1 and 120)
    and (detected_mime_type is null or char_length(detected_mime_type) between 3 and 160)
    and (scan_policy_code is null or char_length(scan_policy_code) between 1 and 120)
  ),
  constraint message_attachments_scan_provenance_consistent check (
    (
      scan_status = 'pending'
      and scan_completed_at is null
      and scanner_name is null
      and scanner_version is null
      and scan_failure_code is null
      and detected_mime_type is null
      and scan_policy_code is null
    )
    or (
      scan_status in ('clean', 'quarantined')
      and scan_completed_at is not null
      and scanner_name is not null
      and scanner_version is not null
      and scan_failure_code is null
      and detected_mime_type is not null
      and (
        scan_status = 'quarantined'
        or (detected_mime_type = mime_type and scan_policy_code is null)
      )
    )
    or (
      scan_status = 'failed'
      and scan_completed_at is not null
      and scanner_name is not null
      and scanner_version is not null
      and scan_failure_code is not null
      and scan_policy_code is null
    )
  ),
  constraint message_attachments_purge_consistent check (
    purge_requested_at is null or scan_status = 'quarantined'
  )
);

create table public.device_registrations (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  session_id uuid references auth.sessions (id) on delete set null,
  installation_id uuid not null,
  platform text not null,
  push_token_ciphertext text not null,
  push_token_type text not null,
  push_project_id uuid not null,
  push_environment text not null,
  app_version text,
  locale text,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, user_id, installation_id),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint device_registrations_platform_allowed check (platform in ('ios', 'android', 'web')),
  constraint device_registrations_push_token_type_allowed check (push_token_type = 'expo'),
  constraint device_registrations_push_environment_allowed check (
    push_environment in ('development', 'preview', 'production')
  ),
  constraint device_registrations_push_token_ciphertext_format check (
    char_length(push_token_ciphertext) between 20 and 8192
    and push_token_ciphertext ~ '^(kms|vault|ciphertext):'
  ),
  constraint device_registrations_app_version_length check (app_version is null or char_length(app_version) <= 80),
  constraint device_registrations_locale_length check (locale is null or char_length(locale) between 2 and 35)
);

alter table public.announcement_acknowledgements
  add foreign key (organization_id, device_id)
    references public.device_registrations (organization_id, id) on delete restrict;
alter table public.shift_handoffs
  add foreign key (organization_id, signed_device_id)
    references public.device_registrations (organization_id, id) on delete restrict;
alter table public.handoff_acknowledgements
  add foreign key (organization_id, device_id)
    references public.device_registrations (organization_id, id) on delete restrict;

-- Shift state is authoritative only after an organization explicitly enables
-- its schedule. Until then notification routing reports `currently_off_shift`
-- as unknown instead of suppressing operational traffic on missing data.
create table public.shift_assignments (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  unit_id uuid,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'assigned',
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, unit_id)
    references public.organization_units (organization_id, id) on delete restrict,
  foreign key (organization_id, created_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint shift_assignments_time_order check (ends_at > starts_at),
  constraint shift_assignments_status_allowed check (status in ('assigned', 'cancelled'))
);

create table public.organization_invites (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  email extensions.citext,
  destination_type text not null,
  destination extensions.citext not null,
  invited_user_id uuid references auth.users (id) on delete restrict,
  employee_code_hash bytea,
  activation_mode text not null default 'otp',
  token_hash bytea not null,
  role text not null default 'member',
  expires_at timestamptz not null,
  max_uses smallint not null default 1,
  use_count smallint not null default 0,
  accepted_by_user_id uuid,
  accepted_at timestamptz,
  created_by_user_id uuid not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, created_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, accepted_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint organization_invites_destination_type_allowed check (destination_type in ('email', 'phone')),
  constraint organization_invites_destination_shape check (
    (destination_type = 'email'
      and destination::text ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and email = destination)
    or (destination_type = 'phone' and destination::text ~ '^\+[1-9][0-9]{7,14}$' and email is null)
  ),
  constraint organization_invites_employee_code_hash_length check (
    employee_code_hash is null or octet_length(employee_code_hash) = 32
  ),
  constraint organization_invites_activation_mode_allowed check (activation_mode in ('otp', 'manual')),
  constraint organization_invites_activation_mode_consistent check (
    activation_mode <> 'manual' or employee_code_hash is not null
  ),
  constraint organization_invites_token_hash_length check (octet_length(token_hash) = 32),
  constraint organization_invites_role_allowed check (role in ('admin', 'manager', 'member')),
  constraint organization_invites_use_range check (max_uses = 1 and use_count between 0 and 1),
  constraint organization_invites_acceptance_consistent check (
    (accepted_at is null and accepted_by_user_id is null)
    or (
      accepted_at is not null
      and (invited_user_id is null or accepted_by_user_id = invited_user_id)
      and use_count > 0
    )
  )
);

create table public.audit_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  actor_user_id uuid,
  event_type text not null,
  target_type text not null,
  target_id text not null,
  request_id uuid,
  ip_hash bytea,
  user_agent_hash bytea,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint audit_events_event_type_length check (char_length(event_type) between 3 and 120),
  constraint audit_events_target_type_length check (char_length(target_type) between 2 and 80),
  constraint audit_events_target_id_length check (char_length(target_id) between 1 and 240),
  constraint audit_events_metadata_object check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  constraint audit_events_ip_hash_length check (ip_hash is null or octet_length(ip_hash) = 32),
  constraint audit_events_user_agent_hash_length check (user_agent_hash is null or octet_length(user_agent_hash) = 32)
);

create table private.rate_limit_buckets (
  scope text not null,
  key_hash bytea not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1,
  expires_at timestamptz not null,
  primary key (scope, key_hash, window_started_at),
  constraint rate_limit_buckets_scope_length check (char_length(scope) between 1 and 80),
  constraint rate_limit_buckets_key_hash_length check (octet_length(key_hash) = 32),
  constraint rate_limit_buckets_count_positive check (request_count > 0),
  constraint rate_limit_buckets_expiry_after_window check (expires_at > window_started_at)
);

create table private.api_idempotency_keys (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  actor_user_id uuid not null,
  route text not null,
  idempotency_key text not null,
  request_sha256 bytea not null,
  state text not null default 'in_progress',
  response_status integer,
  response_body jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, actor_user_id, route, idempotency_key),
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint api_idempotency_route_length check (char_length(route) between 1 and 160),
  constraint api_idempotency_key_length check (char_length(idempotency_key) between 8 and 200),
  constraint api_idempotency_request_hash_length check (octet_length(request_sha256) = 32),
  constraint api_idempotency_state_allowed check (state in ('in_progress', 'completed')),
  constraint api_idempotency_response_status_range check (
    response_status is null or response_status between 100 and 599
  ),
  constraint api_idempotency_response_size check (
    response_body is null or octet_length(response_body::text) <= 65536
  ),
  constraint api_idempotency_completion_consistent check (
    (state = 'in_progress' and response_status is null and response_body is null and completed_at is null)
    or (state = 'completed' and response_status is not null and response_body is not null and completed_at is not null)
  )
);

-- Bootstrap runs before an organization or membership exists, so it cannot use
-- the tenant-scoped idempotency table above. This narrow service-only ledger is
-- keyed to the pre-provisioned Auth principal instead.
create table private.bootstrap_idempotency_keys (
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  idempotency_key text not null,
  request_sha256 bytea not null,
  response_body jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_user_id, idempotency_key),
  constraint bootstrap_idempotency_key_length check (char_length(idempotency_key) between 8 and 200),
  constraint bootstrap_idempotency_hash_length check (octet_length(request_sha256) = 32),
  constraint bootstrap_idempotency_response_size check (
    response_body is null or (
      jsonb_typeof(response_body) = 'object'
      and octet_length(response_body::text) <= 16384
    )
  ),
  constraint bootstrap_idempotency_completion_consistent check (
    (response_body is null and completed_at is null)
    or (response_body is not null and completed_at is not null)
  )
);

create table private.outbox_jobs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  topic text not null,
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  claimed_by uuid,
  claimed_until timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (topic, dedupe_key),
  constraint outbox_jobs_topic_allowed check (
    topic in ('push', 'realtime_control', 'translation', 'language_detection', 'summary', 'storage_scan', 'storage_purge', 'session_revoke', 'retention', 'moderation', 'dynamic_group_sync')
  ),
  constraint outbox_jobs_dedupe_length check (char_length(dedupe_key) between 1 and 240),
  constraint outbox_jobs_payload_object check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 32768
  ),
  constraint outbox_jobs_status_allowed check (status in ('pending', 'processing', 'completed', 'failed', 'dead_letter')),
  constraint outbox_jobs_attempts_nonnegative check (attempts >= 0),
  constraint outbox_jobs_error_length check (last_error_code is null or char_length(last_error_code) <= 120),
  constraint outbox_jobs_claim_consistent check (
    (status = 'processing' and claimed_by is not null and claimed_until is not null and completed_at is null)
    or (status <> 'processing' and claimed_by is null and claimed_until is null)
  ),
  constraint outbox_jobs_completion_consistent check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

-- Raw push tokens remain only on encrypted device registrations and in the
-- short-lived worker response. This durable ledger stores one idempotent
-- delivery attempt per outbox job/device and keeps provider acceptance,
-- delivery receipts, application reads, and acknowledgements distinct.
create table private.push_delivery_attempts (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete restrict,
  outbox_job_id bigint not null references private.outbox_jobs (id) on delete restrict,
  device_id uuid not null,
  user_id uuid not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  provider_ticket_id text,
  provider_accepted_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  next_receipt_check_at timestamptz,
  receipt_claimed_by uuid,
  receipt_claimed_until timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outbox_job_id, device_id),
  unique (provider_ticket_id),
  foreign key (organization_id, device_id)
    references public.device_registrations (organization_id, id) on delete restrict,
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint push_delivery_attempts_status_allowed check (
    status in (
      'pending', 'retry_wait', 'provider_accepted', 'delivered',
      'permanent_failure', 'device_unregistered', 'receipt_expired'
    )
  ),
  constraint push_delivery_attempts_count_range check (attempt_count between 0 and 10),
  constraint push_delivery_attempts_ticket_length check (
    provider_ticket_id is null or char_length(provider_ticket_id) between 1 and 500
  ),
  constraint push_delivery_attempts_error_length check (
    last_error_code is null or char_length(last_error_code) between 1 and 120
  ),
  constraint push_delivery_attempts_claim_consistent check (
    (receipt_claimed_by is null and receipt_claimed_until is null)
    or (receipt_claimed_by is not null and receipt_claimed_until is not null)
  ),
  constraint push_delivery_attempts_provider_consistent check (
    (status in ('provider_accepted', 'delivered', 'receipt_expired')
      and provider_ticket_id is not null and provider_accepted_at is not null)
    or status not in ('provider_accepted', 'delivered', 'receipt_expired')
  ),
  constraint push_delivery_attempts_delivered_consistent check (
    (status = 'delivered' and delivered_at is not null and failed_at is null)
    or (status <> 'delivered' and delivered_at is null)
  ),
  constraint push_delivery_attempts_failed_consistent check (
    (status in ('permanent_failure', 'device_unregistered', 'receipt_expired') and failed_at is not null)
    or (status not in ('permanent_failure', 'device_unregistered', 'receipt_expired') and failed_at is null)
  )
);

create table private.session_revocations (
  organization_id uuid not null references public.organizations (id) on delete restrict,
  session_id uuid not null,
  user_id uuid not null,
  revoked_by_user_id uuid not null,
  reason text not null,
  revoked_at timestamptz not null default now(),
  primary key (organization_id, session_id),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, revoked_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint session_revocations_reason_length check (char_length(btrim(reason)) between 3 and 500)
);

-- Auth sessions are created by GoTrue before an organization can be selected
-- (and before a new invitee has membership), so installation attribution is
-- stored outside the tenant-scoped push table. Every Newone data-plane check
-- below requires one current, non-revoked binding. Web therefore has the same
-- attributable session inventory as native without fabricating a push token.
create table private.session_installations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid unique references auth.sessions (id) on delete set null,
  user_id uuid not null references auth.users (id) on delete restrict,
  installation_id uuid not null,
  platform text not null,
  app_version text,
  locale text,
  user_agent_hash bytea not null,
  user_agent_family text not null default 'unknown',
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_installations_platform_allowed check (
    platform in ('ios', 'android', 'web')
  ),
  constraint session_installations_app_version_length check (
    app_version is null or char_length(app_version) <= 80
  ),
  constraint session_installations_locale_length check (
    locale is null or char_length(locale) between 2 and 35
  ),
  constraint session_installations_user_agent_hash_length check (
    octet_length(user_agent_hash) = 32
  ),
  constraint session_installations_user_agent_family_allowed check (
    user_agent_family in ('iphone', 'ipad', 'android', 'mobile', 'desktop', 'unknown')
  ),
  constraint session_installations_revocation_consistent check (
    session_id is not null or revoked_at is not null
  )
);

create table private.message_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  reporter_user_id uuid not null,
  category text not null,
  details text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  unique (organization_id, conversation_id, message_id, reporter_user_id),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, reporter_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint message_reports_category_allowed check (category in ('harassment', 'threat', 'spam', 'privacy', 'misinformation', 'other')),
  constraint message_reports_details_length check (details is null or char_length(details) <= 4000),
  constraint message_reports_status_allowed check (status in ('open', 'reviewing', 'resolved', 'dismissed'))
);

-- Personal organization and trustworthy delivery state. Mutations are routed
-- through checked BFF commands; authenticated clients receive read access only.
create table public.conversation_preferences (
  organization_id uuid not null,
  conversation_id uuid not null,
  user_id uuid not null,
  is_favorite boolean not null default false,
  is_pinned boolean not null default false,
  is_hidden boolean not null default false,
  notification_level text not null default 'all',
  muted_until timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, user_id),
  foreign key (organization_id, conversation_id, user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  constraint conversation_preferences_notification_allowed check (
    notification_level in ('all', 'mentions', 'none')
  )
);

create table public.organization_user_preferences (
  organization_id uuid not null,
  user_id uuid not null,
  ui_language text not null default 'en',
  message_language text,
  time_zone text not null default 'UTC',
  quiet_hours_start time,
  quiet_hours_end time,
  quiet_days smallint[] not null default array[0,1,2,3,4,5,6]::smallint[],
  notification_preview text not null default 'generic',
  sound_enabled boolean not null default true,
  vibration_enabled boolean not null default true,
  shift_aware_suppression boolean not null default false,
  read_visibility text not null default 'everyone',
  updated_at timestamptz not null default now(),
  primary key (organization_id, user_id),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint organization_user_preferences_language_lengths check (
    char_length(ui_language) between 2 and 35
    and (message_language is null or char_length(message_language) between 2 and 35)
  ),
  constraint organization_user_preferences_time_zone_length check (char_length(time_zone) between 1 and 100),
  constraint organization_user_preferences_quiet_consistent check (
    (quiet_hours_start is null and quiet_hours_end is null)
    or (quiet_hours_start is not null and quiet_hours_end is not null)
  ),
  constraint organization_user_preferences_quiet_days check (
    cardinality(quiet_days) between 1 and 7
    and quiet_days <@ array[0,1,2,3,4,5,6]::smallint[]
  ),
  constraint organization_user_preferences_preview_allowed check (
    notification_preview in ('generic', 'hidden')
  ),
  constraint organization_user_preferences_read_visibility_allowed check (
    read_visibility in ('everyone', 'contacts', 'nobody')
  )
);

create table public.saved_contacts (
  organization_id uuid not null,
  owner_user_id uuid not null,
  contact_user_id uuid not null,
  alias text,
  is_favorite boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, owner_user_id, contact_user_id),
  foreign key (organization_id, owner_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, contact_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint saved_contacts_distinct_users check (owner_user_id <> contact_user_id),
  constraint saved_contacts_alias_length check (alias is null or char_length(btrim(alias)) between 1 and 120)
);

-- Additive, scoped administrative roles. The legacy membership role remains a
-- compatibility baseline, while privileged workflows can be delegated without
-- turning a site or language reviewer into an organization-wide administrator.
create table public.organization_roles (
  role_name text primary key,
  description text not null,
  sensitive boolean not null default false
);

create table public.organization_role_permissions (
  role_name text not null references public.organization_roles (role_name) on delete restrict,
  permission text not null,
  primary key (role_name, permission),
  constraint organization_role_permissions_name_length check (char_length(permission) between 3 and 120)
);

insert into public.organization_roles (role_name, description, sensitive) values
  ('security_admin', 'Membership security, session revocation, and role administration', true),
  ('people_admin', 'Directory and invitation administration', true),
  ('communications_publisher', 'Publish and correct official organization communications', true),
  ('site_admin', 'Manage a delegated organization unit and its conversations', true),
  ('language_reviewer', 'Review glossary and translation corrections', false),
  ('supervisor', 'Manage handoffs and confirm operational work', false),
  ('employee', 'Standard employee capability marker', false),
  ('designated_investigator', 'Review assigned safety reports without ambient private-content access', true);

insert into public.organization_role_permissions (role_name, permission) values
  ('security_admin', 'members.security'),
  ('security_admin', 'sessions.revoke'),
  ('security_admin', 'roles.manage'),
  ('security_admin', 'roles.read'),
  ('security_admin', 'audit.read'),
  ('security_admin', 'ai.policy.manage'),
  ('people_admin', 'directory.manage'),
  ('people_admin', 'directory.read'),
  ('people_admin', 'invites.manage'),
  ('communications_publisher', 'communications.publish'),
  ('site_admin', 'unit.manage'),
  ('site_admin', 'conversation.manage'),
  ('language_reviewer', 'language.review'),
  ('supervisor', 'handoff.manage'),
  ('supervisor', 'actions.confirm'),
  ('employee', 'employee.use'),
  ('designated_investigator', 'reports.investigate');

create table public.organization_role_assignments (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  user_id uuid not null,
  role_name text not null references public.organization_roles (role_name) on delete restrict,
  scope_type text not null default 'organization',
  unit_id uuid,
  granted_by_user_id uuid not null,
  grant_reason text not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  revocation_reason text,
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, unit_id)
    references public.organization_units (organization_id, id) on delete restrict,
  foreign key (organization_id, granted_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, revoked_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint organization_role_assignments_scope_allowed check (scope_type in ('organization', 'unit')),
  constraint organization_role_assignments_scope_consistent check (
    (scope_type = 'organization' and unit_id is null)
    or (scope_type = 'unit' and unit_id is not null)
  ),
  constraint organization_role_assignments_expiry_future check (expires_at is null or expires_at > granted_at),
  constraint organization_role_assignments_grant_reason_length check (
    char_length(btrim(grant_reason)) between 3 and 500
  ),
  constraint organization_role_assignments_revocation_consistent check (
    (revoked_at is null and revoked_by_user_id is null and revocation_reason is null)
    or (
      revoked_at is not null and revoked_by_user_id is not null
      and char_length(btrim(revocation_reason)) between 3 and 500
    )
  )
);

-- Tenant AI/processor egress is deny-by-default. Global runtime flags remain
-- an outer kill switch, but can never opt a tenant in without this record.
create table public.organization_ai_policies (
  organization_id uuid primary key references public.organizations (id) on delete restrict,
  enabled boolean not null default false,
  policy_version integer not null default 1,
  approved_use_cases text[] not null default array[]::text[],
  provider_allowlist text[] not null default array[]::text[],
  route_policy text not null default 'deny',
  approved_by_user_id uuid,
  approved_at timestamptz,
  revoked_by_user_id uuid,
  revoked_at timestamptz,
  revocation_reason text,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, approved_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, revoked_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint organization_ai_policies_version_positive check (policy_version > 0),
  constraint organization_ai_policies_use_cases check (
    cardinality(approved_use_cases) between 0 and 3
    and approved_use_cases <@ array['language_detection', 'translation', 'summary']::text[]
  ),
  constraint organization_ai_policies_provider_count check (
    cardinality(provider_allowlist) between 0 and 20
  ),
  constraint organization_ai_policies_route_allowed check (
    route_policy in ('deny', 'approved_zero_retention')
  ),
  constraint organization_ai_policies_approval_consistent check (
    (enabled and approved_by_user_id is not null and approved_at is not null
      and revoked_by_user_id is null and revoked_at is null and revocation_reason is null
      and cardinality(approved_use_cases) > 0 and cardinality(provider_allowlist) > 0
      and route_policy = 'approved_zero_retention')
    or (not enabled)
  ),
  constraint organization_ai_policies_revocation_consistent check (
    (revoked_at is null and revoked_by_user_id is null and revocation_reason is null)
    or (revoked_at is not null and revoked_by_user_id is not null
      and char_length(btrim(revocation_reason)) between 3 and 500)
  )
);

create table public.message_pins (
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  pinned_by_user_id uuid not null,
  pinned_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, message_id),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, pinned_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict
);

create table public.message_receipts (
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  user_id uuid not null,
  delivered_at timestamptz,
  read_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, message_id, user_id),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  constraint message_receipts_has_state check (delivered_at is not null or read_at is not null),
  constraint message_receipts_read_after_delivery check (
    read_at is null or (delivered_at is not null and read_at >= delivered_at)
  )
);

create table public.message_mentions (
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  mentioned_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, message_id, mentioned_user_id),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, mentioned_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict
);

-- Delete-for-me is a per-user projection only. It never changes the source
-- message, retention record, other recipients' history, or audit provenance.
create table public.message_user_visibility (
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  user_id uuid not null,
  hidden_at timestamptz not null default now(),
  primary key (organization_id, conversation_id, message_id, user_id),
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict
);

-- A forward is a new message plus server-authored immutable provenance. Clients
-- cannot set these columns through general message metadata.
create table public.message_forward_provenance (
  organization_id uuid not null,
  target_conversation_id uuid not null,
  target_message_id bigint not null,
  source_conversation_id uuid not null,
  source_message_id bigint not null,
  forwarded_by_user_id uuid not null,
  forwarded_at timestamptz not null default now(),
  primary key (organization_id, target_conversation_id, target_message_id),
  foreign key (organization_id, target_conversation_id, target_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, source_conversation_id, source_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, target_conversation_id, forwarded_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  constraint message_forward_distinct_message check (
    (target_conversation_id, target_message_id) <>
    (source_conversation_id, source_message_id)
  )
);

create table public.conversation_summary_policies (
  organization_id uuid not null,
  conversation_id uuid not null,
  mode text not null default 'manual',
  message_count_threshold integer,
  require_human_review boolean not null default true,
  updated_by_user_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, conversation_id),
  foreign key (organization_id, conversation_id, updated_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  constraint conversation_summary_policies_mode_allowed check (
    mode in ('manual', 'message_count', 'shift_close')
  ),
  constraint conversation_summary_policies_threshold_consistent check (
    (mode = 'message_count' and message_count_threshold between 10 and 500)
    or (mode <> 'message_count' and message_count_threshold is null)
  )
);

-- Each row is a version. Source IDs and fingerprint are immutable, AI output
-- lands as a draft, and only a separate human review can approve it for use.
create table public.conversation_summaries (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  version_number integer not null,
  correction_of_summary_id uuid,
  source_message_ids bigint[] not null,
  source_first_message_id bigint not null,
  source_last_message_id bigint not null,
  source_fingerprint bytea not null,
  output_fingerprint bytea,
  requested_by_user_id uuid not null,
  request_mode text not null default 'manual',
  language_code text not null,
  status text not null default 'queued',
  primary_topic text,
  summary_body text,
  key_topics text[],
  decisions jsonb,
  action_items jsonb,
  ambiguities text[],
  processor_type text,
  provider text,
  model text,
  processor_provenance jsonb not null default '{}'::jsonb,
  failure_code text,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, conversation_id, version_number),
  unique (organization_id, conversation_id, source_fingerprint, language_code, correction_of_summary_id),
  foreign key (organization_id, conversation_id, requested_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, conversation_id, source_first_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, source_last_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, correction_of_summary_id)
    references public.conversation_summaries (organization_id, id) on delete restrict,
  foreign key (organization_id, reviewed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint conversation_summaries_version_positive check (version_number > 0),
  constraint conversation_summaries_source_count check (cardinality(source_message_ids) between 1 and 500),
  constraint conversation_summaries_source_order check (
    source_first_message_id <= source_last_message_id
    and source_message_ids[1] = source_first_message_id
    and source_message_ids[cardinality(source_message_ids)] = source_last_message_id
  ),
  constraint conversation_summaries_fingerprint_length check (octet_length(source_fingerprint) = 32),
  constraint conversation_summaries_output_fingerprint_length check (
    output_fingerprint is null or octet_length(output_fingerprint) = 32
  ),
  constraint conversation_summaries_request_mode_allowed check (
    request_mode in ('manual', 'automatic_message_count', 'automatic_shift_close', 'manual_fallback', 'correction')
  ),
  constraint conversation_summaries_language_length check (char_length(language_code) between 2 and 35),
  constraint conversation_summaries_status_allowed check (
    status in ('queued', 'processing', 'draft', 'approved', 'failed', 'stale')
  ),
  constraint conversation_summaries_body_length check (
    summary_body is null or char_length(btrim(summary_body)) between 1 and 30000
  ),
  constraint conversation_summaries_primary_topic_length check (
    primary_topic is null or char_length(btrim(primary_topic)) between 1 and 240
  ),
  constraint conversation_summaries_key_topics_bounded check (
    key_topics is null or private.bounded_text_array(key_topics, 50, 1, 500)
  ),
  constraint conversation_summaries_ambiguities_bounded check (
    ambiguities is null or private.bounded_text_array(ambiguities, 50, 1, 2000)
  ),
  constraint conversation_summaries_structured_arrays check (
    (decisions is null or (jsonb_typeof(decisions) = 'array' and jsonb_array_length(decisions) <= 100 and octet_length(decisions::text) <= 32768))
    and (action_items is null or (jsonb_typeof(action_items) = 'array' and jsonb_array_length(action_items) <= 100 and octet_length(action_items::text) <= 32768))
  ),
  constraint conversation_summaries_failure_length check (
    failure_code is null or char_length(failure_code) between 1 and 120
  ),
  constraint conversation_summaries_provenance_object check (
    jsonb_typeof(processor_provenance) = 'object'
    and octet_length(processor_provenance::text) <= 16384
  ),
  constraint conversation_summaries_state_consistent check (
    (status in ('queued', 'processing') and primary_topic is null and summary_body is null
      and key_topics is null and decisions is null and action_items is null and ambiguities is null
      and output_fingerprint is null and failure_code is null)
    or (status in ('draft', 'approved') and primary_topic is not null and summary_body is not null
      and key_topics is not null and decisions is not null and action_items is not null and ambiguities is not null
      and output_fingerprint is not null and processor_type in ('ai', 'manual') and failure_code is null)
    or (status in ('failed', 'stale') and primary_topic is null and summary_body is null
      and key_topics is null and decisions is null and action_items is null and ambiguities is null
      and output_fingerprint is null and failure_code is not null)
  ),
  constraint conversation_summaries_review_consistent check (
    (status = 'approved' and reviewed_by_user_id is not null and reviewed_at is not null)
    or (status <> 'approved' and reviewed_by_user_id is null and reviewed_at is null)
  )
);

-- Announcements and handoffs retain an immutable content chain. Their base
-- rows are a current projection for compatibility; acknowledgements bind to a
-- specific immutable version so corrections cannot rewrite what was accepted.
create table public.announcement_versions (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  announcement_id uuid not null,
  conversation_id uuid not null,
  version_number integer not null,
  message_id bigint not null,
  title text not null,
  priority text not null,
  requires_acknowledgement boolean not null,
  acknowledgement_schema jsonb not null,
  notification_class text not null,
  critical_category text,
  quiet_hours_override_reason text,
  reminder_policy jsonb not null,
  scheduled_at timestamptz,
  published_at timestamptz,
  expires_at timestamptz,
  correction_of_version_id uuid,
  correction_reason text,
  created_by_user_id uuid not null,
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, announcement_id, id),
  unique (organization_id, announcement_id, version_number),
  unique (organization_id, announcement_id, message_id),
  foreign key (organization_id, announcement_id)
    references public.announcements (organization_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, created_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, announcement_id, correction_of_version_id)
    references public.announcement_versions (organization_id, announcement_id, id) on delete restrict,
  constraint announcement_versions_number_positive check (version_number > 0),
  constraint announcement_versions_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint announcement_versions_priority_allowed check (priority in ('normal', 'important', 'emergency')),
  constraint announcement_versions_notification_class_allowed check (
    notification_class in ('routine', 'urgent', 'critical')
  ),
  constraint announcement_versions_critical_override_consistent check (
    (notification_class = 'routine'
      and critical_category is null and quiet_hours_override_reason is null)
    or (notification_class in ('urgent', 'critical')
      and critical_category in ('safety', 'security', 'operations', 'weather', 'business_continuity')
      and char_length(btrim(quiet_hours_override_reason)) between 3 and 500)
  ),
  constraint announcement_versions_policy_objects check (
    jsonb_typeof(acknowledgement_schema) = 'object'
    and jsonb_typeof(reminder_policy) = 'object'
    and octet_length(acknowledgement_schema::text) <= 8192
    and octet_length(reminder_policy::text) <= 8192
  ),
  constraint announcement_versions_reason_length check (
    correction_reason is null or char_length(btrim(correction_reason)) between 3 and 2000
  ),
  constraint announcement_versions_correction_consistent check (
    (version_number = 1 and correction_of_version_id is null and correction_reason is null)
    or (version_number > 1 and correction_of_version_id is not null and correction_reason is not null)
  ),
  constraint announcement_versions_expiry_after_publish check (
    expires_at is null or expires_at > coalesce(published_at, scheduled_at)
  )
);

alter table public.announcement_acknowledgements
  add column announcement_version_id uuid not null;
alter table public.announcement_acknowledgements
  drop constraint announcement_acknowledgements_pkey,
  add primary key (organization_id, announcement_id, announcement_version_id, user_id),
  add foreign key (organization_id, announcement_id, announcement_version_id)
    references public.announcement_versions (organization_id, announcement_id, id) on delete restrict;

create table public.handoff_versions (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  handoff_id uuid not null,
  conversation_id uuid not null,
  version_number integer not null,
  title text not null,
  details text not null,
  source_language text not null,
  shift_started_at timestamptz not null,
  shift_ended_at timestamptz not null,
  source_message_ids bigint[] not null default '{}'::bigint[],
  source_fingerprint bytea not null,
  acknowledgement_due_at timestamptz,
  correction_of_version_id uuid,
  correction_reason text,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, handoff_id, id),
  unique (organization_id, handoff_id, version_number),
  foreign key (organization_id, handoff_id)
    references public.shift_handoffs (organization_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, created_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, handoff_id, correction_of_version_id)
    references public.handoff_versions (organization_id, handoff_id, id) on delete restrict,
  constraint handoff_versions_number_positive check (version_number > 0),
  constraint handoff_versions_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint handoff_versions_details_length check (char_length(btrim(details)) between 1 and 30000),
  constraint handoff_versions_language_length check (char_length(source_language) between 2 and 35),
  constraint handoff_versions_time_order check (shift_ended_at > shift_started_at),
  constraint handoff_versions_source_ids_bounded check (
    cardinality(source_message_ids) between 0 and 500
  ),
  constraint handoff_versions_source_fingerprint_length check (
    octet_length(source_fingerprint) = 32
  ),
  constraint handoff_versions_due_after_shift check (
    acknowledgement_due_at is null or acknowledgement_due_at > shift_ended_at
  ),
  constraint handoff_versions_reason_length check (
    correction_reason is null or char_length(btrim(correction_reason)) between 3 and 2000
  ),
  constraint handoff_versions_correction_consistent check (
    (version_number = 1 and correction_of_version_id is null and correction_reason is null)
    or (version_number > 1 and correction_of_version_id is not null and correction_reason is not null)
  )
);

alter table public.shift_handoffs add column submitted_version_id uuid;
alter table public.shift_handoffs
  add foreign key (organization_id, id, submitted_version_id)
    references public.handoff_versions (organization_id, handoff_id, id) on delete restrict;

alter table public.handoff_acknowledgements add column handoff_version_id uuid not null;
alter table public.handoff_acknowledgements
  drop constraint handoff_acknowledgements_pkey,
  add primary key (organization_id, handoff_id, handoff_version_id, user_id),
  add foreign key (organization_id, handoff_id, handoff_version_id)
    references public.handoff_versions (organization_id, handoff_id, id) on delete restrict;

-- Translation improvements are proposals with explicit reviewer provenance;
-- the model-produced translation is never silently overwritten.
create table public.glossary_terms (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete restrict,
  source_language text not null,
  target_language text not null,
  source_term text not null,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, created_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint glossary_terms_distinct_languages check (source_language <> target_language),
  constraint glossary_terms_language_lengths check (
    char_length(source_language) between 2 and 35 and char_length(target_language) between 2 and 35
  ),
  constraint glossary_terms_source_length check (char_length(btrim(source_term)) between 1 and 500)
);

create table public.glossary_term_versions (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  term_id uuid not null,
  version_number integer not null,
  translated_term text not null,
  definition text,
  correction_of_version_id uuid,
  change_reason text,
  created_by_user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, term_id, id),
  unique (organization_id, term_id, version_number),
  foreign key (organization_id, term_id)
    references public.glossary_terms (organization_id, id) on delete restrict,
  foreign key (organization_id, term_id, correction_of_version_id)
    references public.glossary_term_versions (organization_id, term_id, id) on delete restrict,
  foreign key (organization_id, created_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint glossary_term_versions_number_positive check (version_number > 0),
  constraint glossary_term_versions_translation_length check (char_length(btrim(translated_term)) between 1 and 2000),
  constraint glossary_term_versions_definition_length check (definition is null or char_length(definition) <= 8000),
  constraint glossary_term_versions_reason_length check (
    change_reason is null or char_length(btrim(change_reason)) between 3 and 2000
  ),
  constraint glossary_term_versions_correction_consistent check (
    (version_number = 1 and correction_of_version_id is null)
    or (version_number > 1 and correction_of_version_id is not null and change_reason is not null)
  )
);

create table public.glossary_reviews (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  term_id uuid not null,
  term_version_id uuid not null,
  reviewer_user_id uuid not null,
  decision text not null,
  note text,
  reviewed_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, term_version_id, reviewer_user_id),
  foreign key (organization_id, term_id, term_version_id)
    references public.glossary_term_versions (organization_id, term_id, id) on delete restrict,
  foreign key (organization_id, reviewer_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint glossary_reviews_decision_allowed check (decision in ('approved', 'rejected', 'changes_requested')),
  constraint glossary_reviews_note_length check (note is null or char_length(note) <= 4000)
);

create table public.translation_corrections (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  message_id bigint not null,
  target_language text not null,
  corrected_body text not null,
  rationale text,
  proposed_by_user_id uuid not null,
  status text not null default 'pending',
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, conversation_id, message_id, target_language)
    references public.message_translations (organization_id, conversation_id, message_id, target_language) on delete restrict,
  foreign key (organization_id, conversation_id, proposed_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, reviewed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint translation_corrections_body_length check (char_length(btrim(corrected_body)) between 1 and 20000),
  constraint translation_corrections_rationale_length check (rationale is null or char_length(rationale) <= 4000),
  constraint translation_corrections_status_allowed check (status in ('pending', 'approved', 'rejected', 'changes_requested')),
  constraint translation_corrections_review_note_length check (review_note is null or char_length(review_note) <= 4000),
  constraint translation_corrections_review_consistent check (
    (status = 'pending' and reviewed_by_user_id is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by_user_id is not null and reviewed_at is not null)
  )
);

-- AI or human suggestions become operational work only after a person
-- confirms ownership. The append-only event stream records every transition.
create table public.operational_actions (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  source_message_id bigint,
  title text not null,
  details text,
  status text not null default 'proposed',
  proposed_by_user_id uuid not null,
  confirmed_by_user_id uuid,
  confirmed_at timestamptz,
  assignee_user_id uuid,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, source_message_id)
    references public.messages (organization_id, conversation_id, id) on delete restrict,
  foreign key (organization_id, conversation_id, proposed_by_user_id)
    references public.conversation_members (organization_id, conversation_id, user_id) on delete restrict,
  foreign key (organization_id, assignee_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, confirmed_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint operational_actions_title_length check (char_length(btrim(title)) between 1 and 240),
  constraint operational_actions_details_length check (details is null or char_length(details) <= 10000),
  constraint operational_actions_status_allowed check (status in ('proposed', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  constraint operational_actions_confirmation_consistent check (
    (status = 'proposed' and confirmed_by_user_id is null and confirmed_at is null and assignee_user_id is null and due_at is null)
    or (status <> 'proposed' and confirmed_by_user_id is not null and confirmed_at is not null and assignee_user_id is not null)
  ),
  constraint operational_actions_completion_consistent check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  )
);

create table public.operational_action_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  action_id uuid not null,
  actor_user_id uuid not null,
  event_type text not null,
  from_status text,
  to_status text not null,
  note text,
  occurred_at timestamptz not null default now(),
  foreign key (organization_id, action_id)
    references public.operational_actions (organization_id, id) on delete restrict,
  foreign key (organization_id, actor_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint operational_action_events_type_allowed check (event_type in ('proposed', 'confirmed', 'transitioned')),
  constraint operational_action_events_status_allowed check (
    (from_status is null or from_status in ('proposed', 'confirmed', 'in_progress', 'completed', 'cancelled'))
    and to_status in ('proposed', 'confirmed', 'in_progress', 'completed', 'cancelled')
  ),
  constraint operational_action_events_note_length check (note is null or char_length(note) <= 4000)
);

-- Dynamic membership policies intentionally expose a small typed predicate
-- language (unit plus organization roles), never arbitrary SQL or JSON rules.
create table public.dynamic_group_policies (
  id uuid not null default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid not null,
  unit_id uuid,
  member_roles text[] not null default array['member']::text[],
  include_unit_descendants boolean not null default false,
  status text not null default 'draft',
  version integer not null default 1,
  created_by_user_id uuid not null,
  approved_by_user_id uuid,
  approved_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id),
  unique (organization_id, id),
  unique (organization_id, conversation_id),
  foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id) on delete restrict,
  foreign key (organization_id, unit_id)
    references public.organization_units (organization_id, id) on delete restrict,
  foreign key (organization_id, created_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  foreign key (organization_id, approved_by_user_id)
    references public.organization_memberships (organization_id, user_id) on delete restrict,
  constraint dynamic_group_policies_roles_nonempty check (
    cardinality(member_roles) between 1 and 4
    and member_roles <@ array['owner', 'admin', 'manager', 'member']::text[]
  ),
  constraint dynamic_group_policies_status_allowed check (status in ('draft', 'active', 'paused')),
  constraint dynamic_group_policies_version_positive check (version > 0),
  constraint dynamic_group_policies_approval_consistent check (
    (status = 'draft' and approved_by_user_id is null and approved_at is null)
    or (status <> 'draft' and approved_by_user_id is not null and approved_at is not null)
  )
);

alter table public.conversation_members add column managed_by_policy_id uuid;
alter table public.conversation_members
  add foreign key (organization_id, managed_by_policy_id)
    references public.dynamic_group_policies (organization_id, id) on delete restrict;

-- Foreign keys do not create indexes in Postgres. These indexes also match the
-- tenant-first filters used by RLS and cursor pagination.
create index organization_units_parent_idx on public.organization_units (organization_id, parent_unit_id)
  where parent_unit_id is not null;
create index organizations_created_by_idx on public.organizations (created_by_user_id);
create index organization_units_created_by_idx on public.organization_units (organization_id, created_by_user_id);
create index organization_memberships_user_active_idx on public.organization_memberships (user_id, organization_id)
  where status = 'active';
create index organization_memberships_org_status_role_idx on public.organization_memberships (organization_id, status, role, user_id);
create index organization_memberships_invited_by_idx on public.organization_memberships (organization_id, invited_by_user_id)
  where invited_by_user_id is not null;
create index organization_unit_members_user_idx on public.organization_unit_members (organization_id, user_id, unit_id);
create index member_blocks_blocked_idx on public.member_blocks (organization_id, blocked_user_id, blocker_user_id);
create index contact_connections_high_status_idx on public.contact_connections (organization_id, member_high_user_id, status, updated_at desc);
create index contact_connections_low_status_idx on public.contact_connections (organization_id, member_low_user_id, status, updated_at desc);
create index contact_connections_requested_by_idx on public.contact_connections (organization_id, requested_by_user_id);
create index conversations_org_updated_idx on public.conversations (organization_id, is_archived, updated_at desc, id);
create index conversations_created_by_idx on public.conversations (organization_id, created_by_user_id);
create index conversations_unit_idx on public.conversations (organization_id, unit_id, updated_at desc)
  where unit_id is not null;
create index direct_conversation_pairs_low_idx on public.direct_conversation_pairs (organization_id, member_low_user_id);
create index direct_conversation_pairs_high_idx on public.direct_conversation_pairs (organization_id, member_high_user_id);
create index conversation_members_user_active_idx on public.conversation_members (organization_id, user_id, updated_at desc, conversation_id)
  where status = 'active';
create index conversation_members_conversation_status_idx on public.conversation_members (organization_id, conversation_id, status, user_id);
create index conversation_members_joined_by_idx on public.conversation_members (organization_id, joined_by_user_id)
  where joined_by_user_id is not null;
create index messages_conversation_cursor_idx on public.messages (organization_id, conversation_id, created_at desc, id desc);
create index messages_sender_idx on public.messages (organization_id, sender_user_id, created_at desc, id desc);
create index messages_deleted_by_idx on public.messages (organization_id, deleted_by_user_id)
  where deleted_by_user_id is not null;
create index messages_reply_idx on public.messages (organization_id, conversation_id, reply_to_message_id)
  where reply_to_message_id is not null;
create index messages_thread_idx on public.messages (organization_id, conversation_id, thread_root_message_id, created_at, id)
  where thread_root_message_id is not null;
create index messages_body_search_idx on public.messages using gin (body_search);
create index message_translations_message_idx on public.message_translations (organization_id, conversation_id, message_id);
create index message_translations_reviewed_by_idx on public.message_translations (organization_id, reviewed_by_user_id)
  where reviewed_by_user_id is not null;
create index message_translations_pending_idx on public.message_translations (created_at, id)
  where status in ('queued', 'processing');
create index message_translations_completed_search_idx
  on public.message_translations using gin (translated_body_search)
  where status = 'completed';
create index message_reactions_user_idx on public.message_reactions (organization_id, user_id, created_at desc);
create index message_reactions_conversation_user_idx on public.message_reactions (organization_id, conversation_id, user_id);
create index conversation_read_cursors_message_idx on public.conversation_read_cursors (organization_id, conversation_id, last_read_message_id)
  where last_read_message_id is not null;
create index announcements_conversation_published_idx on public.announcements (organization_id, conversation_id, published_at desc, id);
create index announcements_created_by_idx on public.announcements (organization_id, conversation_id, created_by_user_id);
create index announcements_active_idx on public.announcements (organization_id, expires_at, published_at desc)
  where status = 'published';
create index announcement_recipients_user_idx on public.announcement_recipients (organization_id, user_id, created_at desc);
create index announcement_recipients_unread_idx on public.announcement_recipients (organization_id, announcement_id, user_id)
  where read_at is null;
create index announcement_acknowledgements_user_idx on public.announcement_acknowledgements (organization_id, user_id, acknowledged_at desc);
create index shift_handoffs_conversation_idx on public.shift_handoffs (organization_id, conversation_id, shift_ended_at desc, id);
create index shift_handoffs_author_idx on public.shift_handoffs (organization_id, conversation_id, author_user_id);
create index shift_handoffs_submitted_idx on public.shift_handoffs (organization_id, submitted_at desc, id)
  where status in ('submitted', 'closed');
create index handoff_acknowledgements_user_idx on public.handoff_acknowledgements (organization_id, user_id, acknowledged_at desc);
create index message_attachments_message_idx on public.message_attachments (organization_id, conversation_id, message_id);
create index message_attachments_created_by_idx on public.message_attachments (organization_id, conversation_id, created_by_user_id);
create index message_attachments_pending_scan_idx on public.message_attachments (created_at, id)
  where scan_status = 'pending';
create index message_attachments_clean_file_search_idx
  on public.message_attachments using gin (file_name_search)
  where scan_status = 'clean';
create unique index device_registrations_active_push_token_idx on public.device_registrations (push_token_ciphertext)
  where revoked_at is null;
create index device_registrations_user_active_idx on public.device_registrations (organization_id, user_id, last_seen_at desc)
  where revoked_at is null;
create index device_registrations_session_idx on public.device_registrations (organization_id, user_id, session_id, last_seen_at desc)
  where session_id is not null;
create index shift_assignments_active_user_time_idx
  on public.shift_assignments (organization_id, user_id, starts_at, ends_at)
  where status = 'assigned';
create index shift_assignments_active_unit_time_idx
  on public.shift_assignments (organization_id, unit_id, starts_at, ends_at)
  where status = 'assigned' and unit_id is not null;
create unique index organization_invites_active_destination_idx
  on public.organization_invites (organization_id, destination_type, destination)
  where revoked_at is null and accepted_at is null;
create unique index organization_invites_active_principal_idx on public.organization_invites (organization_id, invited_user_id)
  where invited_user_id is not null and revoked_at is null and accepted_at is null;
create index organization_invites_token_hash_idx on public.organization_invites (token_hash)
  where revoked_at is null and accepted_at is null;
create index organization_invites_expiry_idx on public.organization_invites (organization_id, expires_at)
  where revoked_at is null and accepted_at is null;
create index organization_invites_created_by_idx on public.organization_invites (organization_id, created_by_user_id);
create index organization_invites_accepted_by_idx on public.organization_invites (organization_id, accepted_by_user_id)
  where accepted_by_user_id is not null;
create index audit_events_org_cursor_idx on public.audit_events (organization_id, occurred_at desc, id desc);
create index audit_events_actor_idx on public.audit_events (organization_id, actor_user_id, occurred_at desc)
  where actor_user_id is not null;
create index audit_events_target_idx on public.audit_events (organization_id, target_type, target_id, occurred_at desc);
create index rate_limit_buckets_expiry_idx on private.rate_limit_buckets (expires_at);
create index api_idempotency_expiry_idx on private.api_idempotency_keys (updated_at)
  where state = 'in_progress';
create index outbox_jobs_claim_idx on private.outbox_jobs (available_at, id)
  where status in ('pending', 'failed');
create index outbox_jobs_lease_idx on private.outbox_jobs (claimed_until, id)
  where status = 'processing';
create index outbox_jobs_org_idx on private.outbox_jobs (organization_id, created_at desc, id desc);
create index push_delivery_attempts_dispatch_idx
  on private.push_delivery_attempts (outbox_job_id, status, next_attempt_at, id);
create index push_delivery_attempts_receipt_idx
  on private.push_delivery_attempts (next_receipt_check_at, id)
  where status = 'provider_accepted';
create index push_delivery_attempts_claim_idx
  on private.push_delivery_attempts (receipt_claimed_until, id)
  where receipt_claimed_by is not null;
create index session_revocations_user_idx on private.session_revocations (organization_id, user_id, revoked_at desc);
create index session_installations_user_active_idx
  on private.session_installations (user_id, last_seen_at desc, id)
  where session_id is not null and revoked_at is null;
create index session_installations_installation_idx
  on private.session_installations (user_id, installation_id, last_seen_at desc);
create index message_reports_org_status_idx on private.message_reports (organization_id, status, created_at, id);
create index conversation_preferences_user_idx
  on public.conversation_preferences (organization_id, user_id, is_pinned desc, is_favorite desc, updated_at desc);
create index organization_user_preferences_language_idx
  on public.organization_user_preferences (organization_id, ui_language, message_language);
create index saved_contacts_owner_idx
  on public.saved_contacts (organization_id, owner_user_id, is_favorite desc, updated_at desc, contact_user_id);
create unique index organization_role_assignments_active_unique_idx
  on public.organization_role_assignments (
    organization_id, user_id, role_name, scope_type,
    coalesce(unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where revoked_at is null;
create index organization_role_assignments_user_idx
  on public.organization_role_assignments (organization_id, user_id, revoked_at, expires_at, role_name);
create index organization_role_assignments_unit_idx
  on public.organization_role_assignments (organization_id, unit_id, role_name, user_id)
  where unit_id is not null and revoked_at is null;
create index message_pins_conversation_idx
  on public.message_pins (organization_id, conversation_id, pinned_at desc, message_id desc);
create index message_receipts_user_idx
  on public.message_receipts (organization_id, user_id, updated_at desc, message_id desc);
create index message_receipts_message_idx
  on public.message_receipts (organization_id, conversation_id, message_id, read_at, delivered_at);
create index message_mentions_user_idx
  on public.message_mentions (organization_id, mentioned_user_id, created_at desc, message_id desc);
create index message_user_visibility_user_idx
  on public.message_user_visibility (organization_id, user_id, hidden_at desc, message_id desc);
create index message_forward_source_idx
  on public.message_forward_provenance (
    organization_id, source_conversation_id, source_message_id, forwarded_at desc
  );
create unique index conversation_summaries_source_version_unique_idx
  on public.conversation_summaries (
    organization_id, conversation_id, source_fingerprint, language_code,
    coalesce(correction_of_summary_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index conversation_summaries_conversation_idx
  on public.conversation_summaries (
    organization_id, conversation_id, created_at desc, version_number desc
  );
create index conversation_summaries_status_idx
  on public.conversation_summaries (status, updated_at, id)
  where status in ('queued', 'processing');
create index announcement_versions_cursor_idx
  on public.announcement_versions (organization_id, announcement_id, version_number desc);
create index announcement_versions_message_idx
  on public.announcement_versions (organization_id, conversation_id, message_id);
create index announcement_acknowledgements_version_idx
  on public.announcement_acknowledgements (organization_id, announcement_version_id, acknowledged_at desc);
create index handoff_versions_cursor_idx
  on public.handoff_versions (organization_id, handoff_id, version_number desc);
create index handoff_versions_creator_idx
  on public.handoff_versions (organization_id, conversation_id, created_by_user_id, created_at desc);
create index handoff_acknowledgements_version_idx
  on public.handoff_acknowledgements (organization_id, handoff_version_id, acknowledged_at desc);
create unique index glossary_terms_active_key_idx
  on public.glossary_terms (
    organization_id, source_language, target_language, lower(btrim(source_term))
  ) where archived_at is null;
create index glossary_term_versions_cursor_idx
  on public.glossary_term_versions (organization_id, term_id, version_number desc);
create index glossary_reviews_version_idx
  on public.glossary_reviews (organization_id, term_version_id, reviewed_at desc);
create index translation_corrections_review_queue_idx
  on public.translation_corrections (organization_id, status, created_at, id);
create index translation_corrections_message_idx
  on public.translation_corrections (organization_id, conversation_id, message_id, target_language, created_at desc);
create index operational_actions_conversation_idx
  on public.operational_actions (organization_id, conversation_id, status, due_at, created_at desc);
create index operational_actions_assignee_idx
  on public.operational_actions (organization_id, assignee_user_id, status, due_at)
  where assignee_user_id is not null;
create index operational_action_events_action_idx
  on public.operational_action_events (organization_id, action_id, occurred_at, id);
create index dynamic_group_policies_org_status_idx
  on public.dynamic_group_policies (organization_id, status, updated_at desc);
create index conversation_members_managed_policy_idx
  on public.conversation_members (organization_id, managed_by_policy_id, user_id)
  where managed_by_policy_id is not null;
create index profiles_search_idx on public.profiles using gin (
  to_tsvector('simple', private.normalize_search_text(
    coalesce(display_name, '') || ' ' || coalesce(status_message, '')
  ))
);
create index profiles_display_name_search_idx on public.profiles using gin (
  to_tsvector('simple', private.normalize_search_text(display_name))
);
create index organization_memberships_job_search_idx on public.organization_memberships using gin (
  to_tsvector('simple', private.normalize_search_text(
    coalesce(job_title, '') || ' ' || coalesce(employee_code, '')
  ))
);
create index conversations_search_idx on public.conversations using gin (
  to_tsvector('simple', private.normalize_search_text(
    coalesce(name, '') || ' ' || coalesce(description, '')
  ))
);
create index announcement_versions_search_idx on public.announcement_versions using gin (
  to_tsvector('simple', private.normalize_search_text(title))
);
create index handoff_versions_search_idx on public.handoff_versions using gin (
  to_tsvector('simple', private.normalize_search_text(title || ' ' || details))
);

-- Foreign keys do not create indexes on their referencing side. Cover every
-- application-owned FK with a valid, ready, non-partial left-prefix index so
-- parent updates/deletes and tenant offboarding never devolve into full scans.
create index message_reports_organization_id_reporter_user_id_fk_idx on private.message_reports (organization_id, reporter_user_id);
create index push_delivery_attempts_organization_id_device_id_fk_idx on private.push_delivery_attempts (organization_id, device_id);
create index push_delivery_attempts_organization_id_user_id_fk_idx on private.push_delivery_attempts (organization_id, user_id);
create index session_revocations_organization_id_revoked_by_user_id_fk_idx on private.session_revocations (organization_id, revoked_by_user_id);
create index announcement_acknowledgements_organization_id_an_728049_fk_idx on public.announcement_acknowledgements (organization_id, announcement_id, user_id);
create index announcement_acknowledgements_organization_id_device_id_fk_idx on public.announcement_acknowledgements (organization_id, device_id);
create index announcement_acknowledgements_session_id_fk_idx on public.announcement_acknowledgements (session_id);
create index announcement_versions_organization_id_an_3d380d_fk_idx on public.announcement_versions (organization_id, announcement_id, correction_of_version_id);
create index announcement_versions_organization_id_co_6ea721_fk_idx on public.announcement_versions (organization_id, conversation_id, created_by_user_id);
create index announcements_organization_id_cancelled_by_user_id_fk_idx on public.announcements (organization_id, cancelled_by_user_id);
create index audit_events_organization_id_actor_user_id_fk_idx on public.audit_events (organization_id, actor_user_id);
create index conversation_members_organization_id_joined_by_user_id_fk_idx on public.conversation_members (organization_id, joined_by_user_id);
create index conversation_members_organization_id_ma_2a8e04_fk_idx on public.conversation_members (organization_id, managed_by_policy_id);
create index conversation_members_organization_id_user_id_fk_idx on public.conversation_members (organization_id, user_id);
create index conversation_read_cursors_organization_id_co_086e03_fk_idx on public.conversation_read_cursors (organization_id, conversation_id, last_read_message_id);
create index conversation_summaries_organization_id_co_527e13_fk_idx on public.conversation_summaries (organization_id, conversation_id, requested_by_user_id);
create index conversation_summaries_organization_id_co_1da76e_fk_idx on public.conversation_summaries (organization_id, conversation_id, source_first_message_id);
create index conversation_summaries_organization_id_co_a96c00_fk_idx on public.conversation_summaries (organization_id, conversation_id, source_last_message_id);
create index conversation_summaries_organization_id_co_54fd96_fk_idx on public.conversation_summaries (organization_id, correction_of_summary_id);
create index conversation_summaries_organization_id_re_3b6505_fk_idx on public.conversation_summaries (organization_id, reviewed_by_user_id);
create index conversation_summary_policies_organization_id_co_b6bf89_fk_idx on public.conversation_summary_policies (organization_id, conversation_id, updated_by_user_id);
create index conversations_organization_id_closed_by_user_id_fk_idx on public.conversations (organization_id, closed_by_user_id);
create index conversations_organization_id_unit_id_fk_idx on public.conversations (organization_id, unit_id);
create index device_registrations_session_id_fk_idx on public.device_registrations (session_id);
create index dynamic_group_policies_organization_id_ap_62a6ae_fk_idx on public.dynamic_group_policies (organization_id, approved_by_user_id);
create index dynamic_group_policies_organization_id_cr_6cee09_fk_idx on public.dynamic_group_policies (organization_id, created_by_user_id);
create index dynamic_group_policies_organization_id_unit_id_fk_idx on public.dynamic_group_policies (organization_id, unit_id);
create index glossary_reviews_organization_id_reviewer_user_id_fk_idx on public.glossary_reviews (organization_id, reviewer_user_id);
create index glossary_reviews_organization_id_term_id_term_version_id_fk_idx on public.glossary_reviews (organization_id, term_id, term_version_id);
create index glossary_term_versions_organization_id_cr_6cee09_fk_idx on public.glossary_term_versions (organization_id, created_by_user_id);
create index glossary_term_versions_organization_id_te_5f974d_fk_idx on public.glossary_term_versions (organization_id, term_id, correction_of_version_id);
create index glossary_terms_organization_id_created_by_user_id_fk_idx on public.glossary_terms (organization_id, created_by_user_id);
create index handoff_acknowledgements_organization_id_device_id_fk_idx on public.handoff_acknowledgements (organization_id, device_id);
create index handoff_acknowledgements_session_id_fk_idx on public.handoff_acknowledgements (session_id);
create index handoff_versions_organization_id_ha_273f81_fk_idx on public.handoff_versions (organization_id, handoff_id, correction_of_version_id);
create index message_forward_provenance_organization_id_ta_156f9c_fk_idx on public.message_forward_provenance (organization_id, target_conversation_id, forwarded_by_user_id);
create index message_mentions_organization_id_co_81b627_fk_idx on public.message_mentions (organization_id, conversation_id, mentioned_user_id);
create index message_pins_organization_id_co_4b30d3_fk_idx on public.message_pins (organization_id, conversation_id, pinned_by_user_id);
create index message_receipts_organization_id_conversation_id_user_id_fk_idx on public.message_receipts (organization_id, conversation_id, user_id);
create index message_translations_organization_id_reviewed_by_user_id_fk_idx on public.message_translations (organization_id, reviewed_by_user_id);
create index message_user_visibility_organization_id_co_c83884_fk_idx on public.message_user_visibility (organization_id, conversation_id, user_id);
create index messages_organization_id_co_73bdcb_fk_idx on public.messages (organization_id, conversation_id, reply_to_message_id);
create index messages_organization_id_co_cb836b_fk_idx on public.messages (organization_id, conversation_id, thread_root_message_id);
create index messages_organization_id_deleted_by_user_id_fk_idx on public.messages (organization_id, deleted_by_user_id);
create index operational_action_events_organization_id_actor_user_id_fk_idx on public.operational_action_events (organization_id, actor_user_id);
create index operational_actions_organization_id_assignee_user_id_fk_idx on public.operational_actions (organization_id, assignee_user_id);
create index operational_actions_organization_id_confirmed_by_user_id_fk_idx on public.operational_actions (organization_id, confirmed_by_user_id);
create index operational_actions_organization_id_co_f1bac7_fk_idx on public.operational_actions (organization_id, conversation_id, proposed_by_user_id);
create index operational_actions_organization_id_co_832dca_fk_idx on public.operational_actions (organization_id, conversation_id, source_message_id);
create index organization_ai_policies_organization_id_ap_62a6ae_fk_idx on public.organization_ai_policies (organization_id, approved_by_user_id);
create index organization_ai_policies_organization_id_re_1d9502_fk_idx on public.organization_ai_policies (organization_id, revoked_by_user_id);
create index organization_invites_invited_user_id_fk_idx on public.organization_invites (invited_user_id);
create index organization_invites_organization_id_accepted_by_user_id_fk_idx on public.organization_invites (organization_id, accepted_by_user_id);
create index organization_memberships_organization_id_in_476d2f_fk_idx on public.organization_memberships (organization_id, invited_by_user_id);
create index organization_memberships_organization_id_se_fcc2de_fk_idx on public.organization_memberships (organization_id, security_changed_by_user_id);
create index organization_memberships_user_id_fk_idx on public.organization_memberships (user_id);
create index organization_role_assignments_organization_id_gr_284683_fk_idx on public.organization_role_assignments (organization_id, granted_by_user_id);
create index organization_role_assignments_organization_id_re_1d9502_fk_idx on public.organization_role_assignments (organization_id, revoked_by_user_id);
create index organization_role_assignments_organization_id_unit_id_fk_idx on public.organization_role_assignments (organization_id, unit_id);
create index organization_role_assignments_role_name_fk_idx on public.organization_role_assignments (role_name);
create index organization_units_organization_id_parent_unit_id_fk_idx on public.organization_units (organization_id, parent_unit_id);
create index saved_contacts_organization_id_contact_user_id_fk_idx on public.saved_contacts (organization_id, contact_user_id);
create index shift_assignments_organization_id_created_by_user_id_fk_idx on public.shift_assignments (organization_id, created_by_user_id);
create index shift_assignments_organization_id_unit_id_fk_idx on public.shift_assignments (organization_id, unit_id);
create index shift_assignments_organization_id_user_id_fk_idx on public.shift_assignments (organization_id, user_id);
create index shift_handoffs_organization_id_id_submitted_version_id_fk_idx on public.shift_handoffs (organization_id, id, submitted_version_id);
create index shift_handoffs_organization_id_signed_device_id_fk_idx on public.shift_handoffs (organization_id, signed_device_id);
create index shift_handoffs_signed_session_id_fk_idx on public.shift_handoffs (signed_session_id);
create index translation_corrections_organization_id_co_f1bac7_fk_idx on public.translation_corrections (organization_id, conversation_id, proposed_by_user_id);
create index translation_corrections_organization_id_re_3b6505_fk_idx on public.translation_corrections (organization_id, reviewed_by_user_id);

-- Direct client-facing surfaces (Realtime and Storage) must bind the JWT to a
-- still-live Auth session. Organization membership alone is not sufficient:
-- an explicitly revoked device/session must stop authorizing immediately even
-- while its access token has not expired yet.
create or replace function private.current_session_active_for_org(
  p_organization_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_session_claim text := (select auth.jwt() ->> 'session_id');
  v_session_id uuid;
begin
  if v_user_id is null
    or coalesce(v_session_claim, '') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_session_id := v_session_claim::uuid;
  return exists (
    select 1
    from auth.sessions session
    join auth.users auth_user on auth_user.id = session.user_id
    join private.session_installations binding
      on binding.session_id = session.id
     and binding.user_id = session.user_id
     and binding.revoked_at is null
    join public.organization_memberships membership
      on membership.organization_id = p_organization_id
     and membership.user_id = session.user_id
     and membership.status = 'active'
    where session.id = v_session_id
      and session.user_id = v_user_id
      and (session.not_after is null or session.not_after > now())
      and (auth_user.banned_until is null or auth_user.banned_until <= now())
      and not exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = p_organization_id
          and revocation.session_id = session.id
      )
  );
exception when invalid_text_representation then
  return false;
end;
$$;

create or replace function private.is_org_member(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return private.current_session_active_for_org(p_organization_id) and exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = v_user_id
      and membership.status = 'active'
  );
end;
$$;

create or replace function private.is_org_admin(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return private.current_session_active_for_org(p_organization_id) and exists (
    select 1
    from public.organization_memberships membership
    join public.organizations organization
      on organization.id = membership.organization_id
    where membership.organization_id = p_organization_id
      and membership.user_id = v_user_id
      and membership.status = 'active'
      and membership.role in ('owner', 'admin')
      and (
        not organization.require_mfa_for_admins
        or coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
      )
  );
end;
$$;

create or replace function private.is_org_owner(p_organization_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = v_user_id
      and membership.status = 'active'
      and membership.role = 'owner'
  );
end;
$$;

create or replace function private.actor_has_permission(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_permission text,
  p_unit_id uuid default null
)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_legacy_role text;
begin
  select membership.role into v_legacy_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  if not found then return false; end if;
  -- Owner remains the non-delegable break-glass authority. Legacy admin keeps
  -- compatibility during migration; new grants are additive and scope-aware.
  if v_legacy_role in ('owner', 'admin') then return true; end if;
  return exists (
    select 1
    from public.organization_role_assignments assignment
    join public.organization_role_permissions permission
      on permission.role_name = assignment.role_name
     and permission.permission = p_permission
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_actor_user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
      and (
        assignment.scope_type = 'organization'
        or (
          p_unit_id is not null
          and assignment.scope_type = 'unit'
          and exists (
            with recursive scoped_units(id) as (
              select assignment.unit_id
              union
              select child.id
              from public.organization_units child
              join scoped_units parent on child.parent_unit_id = parent.id
              where child.organization_id = p_organization_id
            )
            select 1 from scoped_units where scoped_units.id = p_unit_id
          )
        )
      )
  );
end;
$$;

create or replace function private.current_user_has_permission(
  p_organization_id uuid,
  p_permission text,
  p_unit_id uuid default null
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select private.actor_has_permission(
    (select auth.uid()), p_organization_id, p_permission, p_unit_id
  )
$$;

create or replace function private.is_conversation_member(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.conversation_members conversation_member
    join public.organization_memberships organization_member
      on organization_member.organization_id = conversation_member.organization_id
     and organization_member.user_id = conversation_member.user_id
     and organization_member.status = 'active'
    where conversation_member.organization_id = p_organization_id
      and conversation_member.conversation_id = p_conversation_id
      and conversation_member.user_id = v_user_id
      and conversation_member.status = 'active'
  );
end;
$$;

create or replace function private.is_conversation_admin(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return private.current_session_active_for_org(p_organization_id) and exists (
    select 1
    from public.conversation_members conversation_member
    join public.organization_memberships organization_member
      on organization_member.organization_id = conversation_member.organization_id
     and organization_member.user_id = conversation_member.user_id
     and organization_member.status = 'active'
    where conversation_member.organization_id = p_organization_id
      and conversation_member.conversation_id = p_conversation_id
      and conversation_member.user_id = v_user_id
      and conversation_member.status = 'active'
      and conversation_member.role in ('owner', 'admin')
  );
end;
$$;

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
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
      and p_first_user_id <> p_second_user_id
      and exists (
        select 1 from public.organization_memberships first_member
        join public.organization_memberships second_member
          on second_member.organization_id = first_member.organization_id
         and second_member.user_id = p_second_user_id
         and second_member.status = 'active'
        where first_member.organization_id = p_organization_id
          and first_member.user_id = p_first_user_id
          and first_member.status = 'active'
      )
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
        when 'request_first' then exists (
          select 1 from public.contact_connections connection
          where connection.organization_id = p_organization_id
            and connection.member_low_user_id = least(p_first_user_id, p_second_user_id)
            and connection.member_high_user_id = greatest(p_first_user_id, p_second_user_id)
            and connection.status = 'accepted'
        )
        when 'scoped_unit' then exists (
          select 1
          from public.organization_unit_members first_unit
          join public.organization_unit_members second_unit
            on second_unit.organization_id = first_unit.organization_id
           and second_unit.unit_id = first_unit.unit_id
           and second_unit.user_id = p_second_user_id
          join public.organization_units unit
            on unit.organization_id = first_unit.organization_id
           and unit.id = first_unit.unit_id
           and unit.is_active
          where first_unit.organization_id = p_organization_id
            and first_unit.user_id = p_first_user_id
        )
        else false
      end
  )
$$;

create or replace function private.ai_use_case_approved(
  p_organization_id uuid,
  p_use_case text,
  p_provider text default null
)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.organization_ai_policies policy
    where policy.organization_id = p_organization_id
      and policy.enabled
      and policy.revoked_at is null
      and policy.route_policy = 'approved_zero_retention'
      and p_use_case = any(policy.approved_use_cases)
      and (p_provider is null or lower(p_provider) = any(policy.provider_allowlist))
  )
$$;

create or replace function private.currently_off_shift_internal(
  p_organization_id uuid,
  p_user_id uuid,
  p_at timestamptz default now()
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not coalesce((
      select organization.shift_schedule_authoritative
      from public.organizations organization
      where organization.id = p_organization_id
    ), false) then null::boolean
    else not exists (
      select 1
      from public.shift_assignments assignment
      where assignment.organization_id = p_organization_id
        and assignment.user_id = p_user_id
        and assignment.status = 'assigned'
        and assignment.starts_at <= p_at
        and assignment.ends_at > p_at
    )
  end
$$;

create or replace function private.can_post_to_conversation(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.conversations conversation
    join public.conversation_members conversation_member
      on conversation_member.organization_id = conversation.organization_id
     and conversation_member.conversation_id = conversation.id
     and conversation_member.user_id = v_user_id
     and conversation_member.status = 'active'
     and conversation_member.can_post
    join public.organization_memberships organization_member
      on organization_member.organization_id = conversation.organization_id
     and organization_member.user_id = v_user_id
     and organization_member.status = 'active'
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and not conversation.is_archived
      and conversation.closed_at is null
      and (
        conversation.kind <> 'announcement'
        or conversation_member.role in ('owner', 'admin')
        or organization_member.role in ('owner', 'admin')
      )
      and (
        conversation.kind <> 'direct'
        or exists (
          select 1 from public.direct_conversation_pairs pair
          where pair.organization_id = conversation.organization_id
            and pair.conversation_id = conversation.id
            and private.direct_pair_policy_permitted(
              pair.organization_id, pair.member_low_user_id, pair.member_high_user_id
            )
        )
      )
  );
end;
$$;

create or replace function private.can_view_org_member(
  p_organization_id uuid,
  p_target_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  if v_user_id = p_target_user_id then
    return true;
  end if;

  if exists (
    select 1
    from public.organization_memberships viewer
    join public.organization_memberships target
      on target.organization_id = viewer.organization_id
     and target.user_id = p_target_user_id
    where viewer.organization_id = p_organization_id
      and viewer.user_id = v_user_id
      and viewer.status = 'active'
      and viewer.role in ('owner', 'admin')
  ) then
    return true;
  end if;

  return exists (
    select 1
    from public.organization_memberships viewer
    join public.organization_memberships target
      on target.organization_id = viewer.organization_id
     and target.user_id = p_target_user_id
     and target.status = 'active'
    where viewer.organization_id = p_organization_id
      and viewer.user_id = v_user_id
      and viewer.status = 'active'
      and target.directory_visibility <> 'private'
      and not exists (
        select 1
        from public.member_blocks block
        where block.organization_id = p_organization_id
          and (
            (block.blocker_user_id = v_user_id and block.blocked_user_id = p_target_user_id)
            or (block.blocker_user_id = p_target_user_id and block.blocked_user_id = v_user_id)
          )
      )
      and (
        target.directory_visibility = 'organization'
        or exists (
          select 1
          from public.organization_unit_members viewer_unit
          join public.organization_unit_members target_unit
            on target_unit.organization_id = viewer_unit.organization_id
           and target_unit.unit_id = viewer_unit.unit_id
           and target_unit.user_id = p_target_user_id
          where viewer_unit.organization_id = p_organization_id
            and viewer_unit.user_id = v_user_id
        )
      )
  );
end;
$$;

create or replace function private.can_view_profile(p_target_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  if v_user_id = p_target_user_id then
    return true;
  end if;

  return exists (
    select 1
    from public.organization_memberships viewer
    where viewer.user_id = v_user_id
      and viewer.status = 'active'
      and (select private.can_view_org_member(viewer.organization_id, p_target_user_id))
  );
end;
$$;

create or replace function private.is_message_sender(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  return exists (
    select 1
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_message_id
      and message.sender_user_id = v_user_id
      and message.deleted_at is null
  );
end;
$$;

create or replace function private.realtime_topic_authorized(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_match text[];
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  begin
    v_user_match := regexp_match(
      p_topic,
      '^org:([0-9a-fA-F-]{36}):user:([0-9a-fA-F-]{36}):(inbox|control)$'
    );
    if v_user_match is null or v_user_match[2]::uuid <> v_user_id then
      return false;
    end if;
    return private.current_session_active_for_org(v_user_match[1]::uuid)
      and exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = v_user_match[1]::uuid
        and membership.user_id = v_user_id
        and membership.status = 'active'
    );
  exception when invalid_text_representation then
    return false;
  end;
end;
$$;

create or replace function private.storage_upload_authorized(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_match text[];
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;

  v_match := regexp_match(
    p_name,
    '^([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/([0-9a-fA-F-]{36})/[^/]+$'
  );

  if v_match is null or lower(v_match[3]) <> lower(v_user_id::text) then
    return false;
  end if;

  begin
    return private.current_session_active_for_org(v_match[1]::uuid)
      and exists (
        select 1
        from public.conversation_members membership
        join public.organization_memberships organization_membership
          on organization_membership.organization_id = membership.organization_id
         and organization_membership.user_id = membership.user_id
         and organization_membership.status = 'active'
        join public.message_attachments attachment
          on attachment.organization_id = membership.organization_id
         and attachment.conversation_id = membership.conversation_id
         and attachment.created_by_user_id = membership.user_id
         and attachment.bucket_id = 'message-attachments'
         and attachment.storage_path = p_name
         and attachment.scan_status = 'pending'
        where membership.organization_id = v_match[1]::uuid
          and membership.conversation_id = v_match[2]::uuid
          and membership.user_id = v_user_id
          and membership.status = 'active'
      );
  exception when invalid_text_representation then
    return false;
  end;
end;
$$;

-- Storage RLS must not depend on end-user table grants. This narrow predicate
-- performs the complete authorization check behind a SECURITY DEFINER boundary:
-- a current Auth session, an active tenant/conversation membership, an
-- undeleted source message, a clean scan, and the member's history boundary.
create or replace function private.storage_download_authorized(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null or char_length(coalesce(p_name, '')) not between 1 and 1024 then
    return false;
  end if;

  return exists (
    select 1
    from public.message_attachments attachment
    join public.messages source_message
      on source_message.organization_id = attachment.organization_id
     and source_message.conversation_id = attachment.conversation_id
     and source_message.id = attachment.message_id
     and source_message.deleted_at is null
    join public.conversation_members membership
      on membership.organization_id = attachment.organization_id
     and membership.conversation_id = attachment.conversation_id
     and membership.user_id = v_user_id
     and membership.status = 'active'
    join public.organization_memberships organization_membership
      on organization_membership.organization_id = membership.organization_id
     and organization_membership.user_id = membership.user_id
     and organization_membership.status = 'active'
    where attachment.bucket_id = 'message-attachments'
      and attachment.storage_path = p_name
      and attachment.scan_status = 'clean'
      and private.current_session_active_for_org(attachment.organization_id)
      and (
        membership.history_visible_from is null
        or source_message.created_at >= membership.history_visible_from
      )
      and not exists (
        select 1
        from public.message_user_visibility visibility
        where visibility.organization_id = attachment.organization_id
          and visibility.conversation_id = attachment.conversation_id
          and visibility.message_id = attachment.message_id
          and visibility.user_id = v_user_id
      )
  );
end;
$$;

create or replace function private.consume_rate_limit(
  p_scope text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_now timestamptz;
  v_key_hash bytea;
  v_window_start timestamptz;
  v_count integer;
begin
  if v_user_id is null and v_jwt_role <> 'service_role' then
    return false;
  end if;

  if p_limit not between 1 and 10000 or p_window_seconds not between 1 and 86400 then
    raise exception 'invalid rate limit configuration' using errcode = '22023';
  end if;

  v_key_hash := extensions.digest(p_key, 'sha256');

  -- Serialize a scope/key pair before locating its active bucket. Buckets are
  -- anchored to the first request instead of wall-clock boundaries, preventing
  -- a caller from doubling its burst allowance by straddling an epoch edge.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_scope || pg_catalog.chr(31) || p_key, 0)
  );
  -- A waiter may have spent most or all of a window behind the lock. Read the
  -- clock only after admission so it never evaluates buckets with stale time.
  v_now := clock_timestamp();

  select bucket.window_started_at
  into v_window_start
  from private.rate_limit_buckets bucket
  where bucket.scope = p_scope
    and bucket.key_hash = v_key_hash
    and bucket.window_started_at > v_now - make_interval(secs => p_window_seconds)
    and bucket.expires_at = bucket.window_started_at
      + make_interval(secs => p_window_seconds * 2)
  order by bucket.window_started_at desc
  limit 1
  for update;

  if found then
    update private.rate_limit_buckets bucket
    set request_count = bucket.request_count + 1
    where bucket.scope = p_scope
      and bucket.key_hash = v_key_hash
      and bucket.window_started_at = v_window_start
    returning bucket.request_count into v_count;
  else
    v_window_start := v_now;
    insert into private.rate_limit_buckets (
      scope,
      key_hash,
      window_started_at,
      request_count,
      expires_at
    ) values (
      p_scope,
      v_key_hash,
      v_window_start,
      1,
      v_window_start + make_interval(secs => p_window_seconds * 2)
    )
    returning request_count into v_count;
  end if;

  return v_count <= p_limit;
end;
$$;

create or replace function private.require_service_role()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role' then
    raise exception 'trusted BFF service role required' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.authorize_bff_request_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_require_aal2 boolean,
  p_recent_auth_seconds integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_aal text;
  v_session_created_at timestamptz;
  v_not_after timestamptz;
  v_banned_until timestamptz;
  v_revocation_generation bigint;
begin
  if p_actor_user_id is null or p_organization_id is null or p_session_id is null
    or char_length(coalesce(p_operation, '')) not between 1 and 160
    or p_recent_auth_seconds not between 0 and 86400 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_request_context');
  end if;

  select membership.revocation_generation
    into v_revocation_generation
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';

  if not found then
    return jsonb_build_object('allowed', false, 'reason', 'inactive_membership');
  end if;

  select session.aal::text, session.created_at, session.not_after, auth_user.banned_until
    into v_aal, v_session_created_at, v_not_after, v_banned_until
  from auth.sessions session
  join auth.users auth_user on auth_user.id = session.user_id
  join private.session_installations binding
    on binding.session_id = session.id
   and binding.user_id = session.user_id
   and binding.revoked_at is null
  where session.id = p_session_id
    and session.user_id = p_actor_user_id;

  if not found
    or (v_not_after is not null and v_not_after <= now())
    or (v_banned_until is not null and v_banned_until > now())
    or exists (
      select 1
      from private.session_revocations revocation
      where revocation.organization_id = p_organization_id
        and revocation.session_id = p_session_id
    ) then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_session');
  end if;

  if p_require_aal2 and v_aal <> 'aal2' then
    return jsonb_build_object('allowed', false, 'reason', 'aal2_required');
  end if;

  -- A conservative recent-auth check uses the Auth session creation time. A
  -- refresh never extends this window; sensitive commands require a new login.
  if p_recent_auth_seconds > 0
    and v_session_created_at < now() - make_interval(secs => p_recent_auth_seconds) then
    return jsonb_build_object('allowed', false, 'reason', 'recent_auth_required');
  end if;

  return jsonb_build_object(
    'allowed', true,
    'actor_user_id', p_actor_user_id,
    'organization_id', p_organization_id,
    'session_id', p_session_id,
    'aal', v_aal,
    'revocation_generation', v_revocation_generation
  );
end;
$$;

create or replace function private.assert_bff_request_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_require_aal2 boolean default false,
  p_recent_auth_seconds integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
begin
  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_operation,
    p_require_aal2,
    p_recent_auth_seconds
  );
  if not coalesce((v_authorization ->> 'allowed')::boolean, false) then
    raise exception 'request authorization denied' using errcode = '42501';
  end if;
  return v_authorization;
end;
$$;

create or replace function private.set_bff_actor_context_internal(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_aal text,
  p_operation text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_headers jsonb;
  v_request_id uuid := gen_random_uuid();
begin
  -- This function is private and is reached only after require_service_role().
  -- Capture the BFF-supplied request UUID before swapping JWT claims to the
  -- end-user identity. Arbitrary Data API callers therefore cannot forge a
  -- correlated privileged audit entry with their own x-request-id header.
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  if coalesce(v_headers ->> 'x-request-id', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_request_id := (v_headers ->> 'x-request-id')::uuid;
  end if;
  perform set_config('app.bff_service_context', 'on', true);
  perform set_config('app.audit_request_id', v_request_id::text, true);
  perform set_config('app.audit_operation', left(coalesce(p_operation, 'bff.command'), 120), true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', p_actor_user_id,
      'session_id', p_session_id,
      'aal', p_aal
    )::text,
    true
  );
end;
$$;

create or replace function private.clear_bff_actor_context_internal()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform set_config('app.bff_service_context', 'off', true);
  perform set_config('app.audit_request_id', '', true);
  perform set_config('app.audit_operation', '', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
end;
$$;

create or replace function private.begin_idempotency_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_route text,
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
  v_request_hash bytea;
  v_row private.api_idempotency_keys%rowtype;
  v_inserted boolean := false;
begin
  if char_length(coalesce(p_route, '')) not between 1 and 160
    or char_length(coalesce(p_idempotency_key, '')) not between 8 and 200
    or coalesce(p_request_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid idempotency metadata' using errcode = '22023';
  end if;
  v_request_hash := decode(p_request_sha256, 'hex');

  insert into private.api_idempotency_keys (
    organization_id,
    actor_user_id,
    route,
    idempotency_key,
    request_sha256
  ) values (
    p_organization_id,
    p_actor_user_id,
    p_route,
    p_idempotency_key,
    v_request_hash
  )
  on conflict (organization_id, actor_user_id, route, idempotency_key) do nothing
  returning true into v_inserted;

  select * into v_row
  from private.api_idempotency_keys idempotency
  where idempotency.organization_id = p_organization_id
    and idempotency.actor_user_id = p_actor_user_id
    and idempotency.route = p_route
    and idempotency.idempotency_key = p_idempotency_key
  for update;

  if v_row.request_sha256 <> v_request_hash then
    return jsonb_build_object('state', 'conflict');
  end if;
  if v_row.state = 'completed' then
    return jsonb_build_object(
      'state', 'replay',
      'status_code', v_row.response_status,
      'response', v_row.response_body,
      'response_status', v_row.response_status,
      'response_body', v_row.response_body
    );
  end if;
  if v_inserted then
    return jsonb_build_object('state', 'started');
  end if;

  if v_row.updated_at < now() - interval '5 minutes' then
    update private.api_idempotency_keys idempotency
    set started_at = now(), updated_at = now()
    where idempotency.organization_id = p_organization_id
      and idempotency.actor_user_id = p_actor_user_id
      and idempotency.route = p_route
      and idempotency.idempotency_key = p_idempotency_key;
    return jsonb_build_object('state', 'started', 'reclaimed', true);
  end if;

  return jsonb_build_object('state', 'in_progress');
end;
$$;

create or replace function private.complete_idempotency_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_route text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_status integer,
  p_response jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_status not between 100 and 599
    or jsonb_typeof(p_response) <> 'object'
    or octet_length(p_response::text) > 65536 then
    raise exception 'invalid idempotency response' using errcode = '22023';
  end if;

  update private.api_idempotency_keys idempotency
  set state = 'completed',
      response_status = p_status,
      response_body = p_response,
      completed_at = now(),
      updated_at = now()
  where idempotency.organization_id = p_organization_id
    and idempotency.actor_user_id = p_actor_user_id
    and idempotency.route = p_route
    and idempotency.idempotency_key = p_idempotency_key
    and idempotency.request_sha256 = decode(p_request_sha256, 'hex')
    and idempotency.state = 'in_progress';

  if not found then
    raise exception 'idempotency claim not found or already completed' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.enqueue_outbox_job_internal(
  p_organization_id uuid,
  p_topic text,
  p_dedupe_key text,
  p_payload jsonb,
  p_available_at timestamptz default now()
)
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job_id bigint;
begin
  insert into private.outbox_jobs (
    organization_id,
    topic,
    dedupe_key,
    payload,
    available_at
  ) values (
    p_organization_id,
    p_topic,
    p_dedupe_key,
    coalesce(p_payload, '{}'::jsonb),
    coalesce(p_available_at, now())
  )
  on conflict (topic, dedupe_key) do update
    set available_at = least(private.outbox_jobs.available_at, excluded.available_at)
  returning id into v_job_id;
  return v_job_id;
end;
$$;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_user_id uuid := (select auth.uid());
  v_display_name text;
begin
  if v_request_user_id is not null and v_request_user_id <> new.id then
    raise exception 'cannot provision a profile for another user' using errcode = '42501';
  end if;

  v_display_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'Newone member'
  );

  insert into public.profiles (user_id, display_name)
  values (new.id, left(v_display_name, 120))
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create or replace function private.validate_profile_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'profile identity fields are immutable' using errcode = '22000';
  end if;
  return new;
end;
$$;

create or replace function private.validate_organization_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if new.id is distinct from old.id
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'organization identity fields are immutable' using errcode = '22000';
  end if;

  if (
      new.require_mfa_for_admins is distinct from old.require_mfa_for_admins
      or new.dm_policy is distinct from old.dm_policy
    )
    and v_jwt_role <> 'service_role' then
    if v_actor_id is null
      or coalesce((select auth.jwt() ->> 'aal'), 'aal1') <> 'aal2'
      or not exists (
        select 1
        from public.organization_memberships membership
        where membership.organization_id = old.id
          and membership.user_id = v_actor_id
          and membership.status = 'active'
          and membership.role = 'owner'
      ) then
      raise exception 'only an AAL2 organization owner may change the admin MFA policy' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.validate_unit_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'organization unit identity fields are immutable' using errcode = '22000';
  end if;
  return new;
end;
$$;

create or replace function private.validate_membership_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_actor_role text;
begin
  if new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.joined_at is distinct from old.joined_at then
    raise exception 'membership identity fields are immutable' using errcode = '22000';
  end if;

  if new.status = 'deactivated' and old.status <> 'deactivated' then
    new.deactivated_at := coalesce(new.deactivated_at, now());
  elsif new.status <> 'deactivated' then
    new.deactivated_at := null;
  end if;

  if new.revocation_generation is distinct from old.revocation_generation
    or new.security_changed_at is distinct from old.security_changed_at
    or new.security_changed_by_user_id is distinct from old.security_changed_by_user_id
    or new.status_change_reason is distinct from old.status_change_reason then
    if current_setting('app.bff_service_context', true) <> 'on'
      or v_actor_id is null then
      raise exception 'membership security state requires the trusted BFF workflow' using errcode = '42501';
    end if;
  end if;

  if new.status is distinct from old.status then
    if current_setting('app.bff_service_context', true) <> 'on' then
      raise exception 'membership status changes require the trusted BFF workflow' using errcode = '42501';
    end if;
    if char_length(btrim(coalesce(new.status_change_reason, ''))) not between 3 and 500 then
      raise exception 'membership status change reason is required' using errcode = '22023';
    end if;
    new.revocation_generation := old.revocation_generation + 1;
    new.security_changed_at := now();
    new.security_changed_by_user_id := v_actor_id;
  elsif new.revocation_generation is distinct from old.revocation_generation
    or new.security_changed_at is distinct from old.security_changed_at
    or new.security_changed_by_user_id is distinct from old.security_changed_by_user_id
    or new.status_change_reason is distinct from old.status_change_reason then
    raise exception 'membership security state changes only with status' using errcode = '22000';
  end if;

  if v_actor_id is null and v_jwt_role = 'service_role' then
    -- Service workflows still cannot remove the final active owner below.
    null;
  elsif v_actor_id = old.user_id then
    if new.role is distinct from old.role
      or new.status is distinct from old.status
      or new.employee_code is distinct from old.employee_code
      or new.job_title is distinct from old.job_title
      or new.invited_by_user_id is distinct from old.invited_by_user_id
      or new.joined_at is distinct from old.joined_at
      or new.deactivated_at is distinct from old.deactivated_at then
      raise exception 'members may only change their own directory visibility' using errcode = '42501';
    end if;
  else
    select membership.role into v_actor_role
    from public.organization_memberships membership
    where membership.organization_id = old.organization_id
      and membership.user_id = v_actor_id
      and membership.status = 'active';

    if v_actor_role = 'owner' then
      null;
    elsif v_actor_role = 'admin' then
      if new.role is distinct from old.role
        or old.role in ('owner', 'admin')
        or new.role in ('owner', 'admin') then
        raise exception 'only owners may change roles or manage owners and admins' using errcode = '42501';
      end if;
    else
      raise exception 'organization administrator permission required' using errcode = '42501';
    end if;
  end if;

  if old.role = 'owner' and old.status = 'active'
    and (new.role <> 'owner' or new.status <> 'active') then
    -- Serialize owner changes so two concurrent demotions cannot both observe
    -- another owner and leave the tenant ownerless.
    perform 1
    from public.organizations organization
    where organization.id = old.organization_id
    for update;

    if not exists (
      select 1
      from public.organization_memberships other_owner
      where other_owner.organization_id = old.organization_id
        and other_owner.user_id <> old.user_id
        and other_owner.role = 'owner'
        and other_owner.status = 'active'
    ) then
      raise exception 'an organization must retain at least one active owner' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.validate_contact_connection_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_recipient_id uuid;
begin
  if tg_op = 'INSERT' then
    if v_actor_id is null or new.requested_by_user_id <> v_actor_id then
      raise exception 'contact requester must be the signed-in user' using errcode = '42501';
    end if;
    if new.status <> 'pending' or new.responded_at is not null then
      raise exception 'new contact requests must be pending' using errcode = '22000';
    end if;
    if not exists (
      select 1
      from public.organization_memberships low_member
      join public.organization_memberships high_member
        on high_member.organization_id = low_member.organization_id
       and high_member.user_id = new.member_high_user_id
       and high_member.status = 'active'
      where low_member.organization_id = new.organization_id
        and low_member.user_id = new.member_low_user_id
        and low_member.status = 'active'
    ) then
      raise exception 'contact requests require two active organization members' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.member_blocks block
      where block.organization_id = new.organization_id
        and (
          (block.blocker_user_id = new.member_low_user_id and block.blocked_user_id = new.member_high_user_id)
          or (block.blocker_user_id = new.member_high_user_id and block.blocked_user_id = new.member_low_user_id)
        )
    ) then
      raise exception 'contact request is not permitted' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.organization_id is distinct from old.organization_id
    or new.member_low_user_id is distinct from old.member_low_user_id
    or new.member_high_user_id is distinct from old.member_high_user_id
    or new.requested_by_user_id is distinct from old.requested_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'contact connection identity fields are immutable' using errcode = '22000';
  end if;

  if coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and old.status in ('declined', 'cancelled')
    and old.responded_at <= now() - interval '7 days'
    and new.status = 'pending'
    and new.responded_at is null
    and v_actor_id = old.requested_by_user_id then
    return new;
  elsif v_actor_id is null and v_jwt_role = 'service_role' then
    null;
  elsif old.status <> 'pending' then
    raise exception 'resolved contact requests are immutable' using errcode = '22000';
  elsif v_actor_id = old.requested_by_user_id then
    if new.status <> 'cancelled' then
      raise exception 'requesters may only cancel pending requests' using errcode = '42501';
    end if;
  else
    v_recipient_id := case
      when old.requested_by_user_id = old.member_low_user_id then old.member_high_user_id
      else old.member_low_user_id
    end;
    if v_actor_id <> v_recipient_id or new.status not in ('accepted', 'declined') then
      raise exception 'only the recipient may accept or decline' using errcode = '42501';
    end if;
  end if;

  new.responded_at := coalesce(new.responded_at, now());
  return new;
end;
$$;

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

  return new;
end;
$$;

create or replace function private.validate_direct_pair_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  select conversation.kind into v_kind
  from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id;

  if v_kind is distinct from 'direct' then
    raise exception 'direct pair must reference a direct conversation' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.organization_memberships low_member
    join public.organization_memberships high_member
      on high_member.organization_id = low_member.organization_id
     and high_member.user_id = new.member_high_user_id
     and high_member.status = 'active'
    where low_member.organization_id = new.organization_id
      and low_member.user_id = new.member_low_user_id
      and low_member.status = 'active'
  ) then
    raise exception 'direct conversations require two active organization members' using errcode = '42501';
  end if;

  if exists (
    select 1 from public.member_blocks block
    where block.organization_id = new.organization_id
      and (
        (block.blocker_user_id = new.member_low_user_id and block.blocked_user_id = new.member_high_user_id)
        or (block.blocker_user_id = new.member_high_user_id and block.blocked_user_id = new.member_low_user_id)
      )
  ) then
    raise exception 'direct conversation is not permitted' using errcode = '42501';
  end if;

  return new;
end;
$$;

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
  v_member_limit integer;
  v_conversation_creator uuid;
  v_existing_member_count integer;
  v_offboarding boolean :=
    coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.member_offboarding_context', true), 'off') = 'on';
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1
      from public.organization_memberships membership
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
      select 1
      from public.direct_conversation_pairs pair
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

    if v_actor_id is null and v_jwt_role = 'service_role' then
      return new;
    end if;
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
      if v_actor_id <> v_conversation_creator
        or new.user_id <> v_actor_id
        or new.role <> 'owner' then
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

    if v_actor_conversation_role not in ('owner', 'admin') then
      raise exception 'conversation administrator permission required' using errcode = '42501';
    end if;
    if new.role = 'owner' and v_actor_conversation_role <> 'owner' then
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
    if new.user_id = v_actor_id
      and new.status = 'active' and new.role = 'owner'
      and new.left_at is null then
      return new;
    end if;
    if old.user_id <> v_actor_id
      and old.status = 'active' and new.status = 'removed'
      and new.role = (case when old.role = 'owner' then 'member' else old.role end)
      and new.can_post = false
      and new.left_at is not null
      and new.notification_level is not distinct from old.notification_level
      and new.muted_until is not distinct from old.muted_until
      and new.managed_by_policy_id is not distinct from old.managed_by_policy_id
      and new.history_visible_from is not distinct from old.history_visible_from then
      return new;
    end if;
  end if;

  if old.status <> 'active' and new.status = 'active' and v_jwt_role <> 'service_role' then
    raise exception 'left or removed members require a service workflow to rejoin' using errcode = '42501';
  end if;

  if new.status = 'active' then
    new.left_at := null;
  else
    new.left_at := coalesce(new.left_at, now());
  end if;

  if v_actor_id is null and v_jwt_role = 'service_role' then
    return new;
  end if;

  if v_actor_id = old.user_id then
    if new.role is distinct from old.role
      or new.can_post is distinct from old.can_post
      or (
        new.status is distinct from old.status
        and not (old.status = 'active' and new.status = 'left')
      ) then
      raise exception 'members may only change preferences or leave' using errcode = '42501';
    end if;
    return new;
  end if;

  select conversation_member.role into v_actor_conversation_role
  from public.conversation_members conversation_member
  where conversation_member.organization_id = old.organization_id
    and conversation_member.conversation_id = old.conversation_id
    and conversation_member.user_id = v_actor_id
    and conversation_member.status = 'active';

  if v_actor_conversation_role not in ('owner', 'admin') then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;

  if v_actor_conversation_role <> 'owner'
    and (new.role is distinct from old.role or old.role = 'owner' or new.role = 'owner') then
    raise exception 'only conversation owners may manage owner roles' using errcode = '42501';
  end if;

  if old.role = 'owner' and old.status = 'active'
    and (new.role <> 'owner' or new.status <> 'active') then
    -- Serialize owner changes for the same conversation.
    perform 1
    from public.conversations conversation
    where conversation.organization_id = old.organization_id
      and conversation.id = old.conversation_id
    for update;

    if not exists (
      select 1
      from public.conversation_members other_owner
      where other_owner.organization_id = old.organization_id
        and other_owner.conversation_id = old.conversation_id
        and other_owner.user_id <> old.user_id
        and other_owner.role = 'owner'
        and other_owner.status = 'active'
    ) then
      raise exception 'a managed conversation must retain an active owner' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.mark_message_summaries_stale_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_failure_code text default 'source_deleted'
)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform set_config('app.summary_stale_context', 'on', true);
  update public.conversation_summaries summary
  set status = 'stale', primary_topic = null, summary_body = null,
      key_topics = null, decisions = null, action_items = null, ambiguities = null,
      output_fingerprint = null,
      processor_type = null, provider = null, model = null,
      processor_provenance = '{}'::jsonb,
      failure_code = p_failure_code, reviewed_by_user_id = null,
      reviewed_at = null, review_note = null, updated_at = now()
  where summary.organization_id = p_organization_id
    and summary.conversation_id = p_conversation_id
    and p_message_id = any(summary.source_message_ids)
    and summary.status <> 'stale';
  perform set_config('app.summary_stale_context', 'off', true);
end;
$$;

create or replace function private.delete_message_translations_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  -- Corrections reference a target translation with ON DELETE RESTRICT so its
  -- human-review history cannot be orphaned accidentally. Source edits and
  -- deletion intentionally invalidate that entire derived chain in FK order.
  delete from public.translation_corrections correction
  where correction.organization_id = p_organization_id
    and correction.conversation_id = p_conversation_id
    and correction.message_id = p_message_id;

  delete from public.message_translations translation
  where translation.organization_id = p_organization_id
    and translation.conversation_id = p_conversation_id
    and translation.message_id = p_message_id;
end;
$$;

create or replace function private.validate_message_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
      raise exception 'message edit window has expired' using errcode = '42501';
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
$$;

create or replace function private.validate_translation_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source_body text;
  v_deleted_at timestamptz;
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.message_id is distinct from old.message_id
    or (
      new.source_language is distinct from old.source_language
      and not (
        coalesce(current_setting('app.language_detection_context', true), 'off') = 'on'
        and old.source_language = 'und'
        and new.source_language <> 'und'
      )
    )
    or new.target_language is distinct from old.target_language
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'translation identity fields are immutable' using errcode = '22000';
  end if;

  select message.body, message.deleted_at
    into v_source_body, v_deleted_at
  from public.messages message
  where message.organization_id = new.organization_id
    and message.conversation_id = new.conversation_id
    and message.id = new.message_id;

  if v_source_body is null or v_deleted_at is not null then
    raise exception 'translations require an undeleted source message' using errcode = '23514';
  end if;

  new.source_body_sha256 := extensions.digest(convert_to(v_source_body, 'UTF8'), 'sha256');
  return new;
end;
$$;

create or replace function private.validate_read_cursor_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous_created_at timestamptz;
  v_next_created_at timestamptz;
begin
  if tg_op = 'UPDATE' and (
    new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.user_id is distinct from old.user_id
  ) then
    raise exception 'read cursor identity fields are immutable' using errcode = '22000';
  end if;

  if not exists (
    select 1
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = new.organization_id
      and member.conversation_id = new.conversation_id
      and member.user_id = new.user_id
      and member.status = 'active'
  ) then
    raise exception 'active conversation membership required' using errcode = '42501';
  end if;

  if new.last_read_message_id is not null then
    select message.created_at into v_next_created_at
    from public.messages message
    join public.conversation_members member
      on member.organization_id = message.organization_id
     and member.conversation_id = message.conversation_id
     and member.user_id = new.user_id
     and member.status = 'active'
    where message.organization_id = new.organization_id
      and message.conversation_id = new.conversation_id
      and message.id = new.last_read_message_id
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = new.user_id
      );
    if not found then
      raise exception 'read cursor target is not readable' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE'
    and old.last_read_message_id is not null
    and new.last_read_message_id is not null
    and new.last_read_message_id <> old.last_read_message_id then
    select message.created_at into v_previous_created_at
    from public.messages message
    where message.organization_id = old.organization_id
      and message.conversation_id = old.conversation_id
      and message.id = old.last_read_message_id;

    if (v_next_created_at, new.last_read_message_id) < (v_previous_created_at, old.last_read_message_id) then
      raise exception 'read cursors cannot move backwards' using errcode = '22000';
    end if;
  end if;

  new.last_read_at := now();
  return new;
end;
$$;

create or replace function private.validate_announcement_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_conversation_kind text;
  v_message_sender uuid;
begin
  select conversation.kind into v_conversation_kind
  from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id;

  select message.sender_user_id into v_message_sender
  from public.messages message
  where message.organization_id = new.organization_id
    and message.conversation_id = new.conversation_id
    and message.id = new.message_id;

  if v_conversation_kind is distinct from 'announcement'
    or v_message_sender is distinct from new.created_by_user_id then
    raise exception 'announcement must reference its creator message in an announcement conversation' using errcode = '23514';
  end if;

  if not private.valid_acknowledgement_schema(new.acknowledgement_schema)
    or not private.valid_reminder_policy(
      new.reminder_policy, coalesce(new.scheduled_at, new.published_at)
    )
    or (
      not new.requires_acknowledgement
      and (
        (new.acknowledgement_schema ->> 'attestation_required')::boolean
        or (new.reminder_policy ->> 'enabled')::boolean
      )
    ) then
    raise exception 'invalid announcement acknowledgement or reminder policy'
      using errcode = '22023';
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id
      or new.organization_id is distinct from old.organization_id
      or new.conversation_id is distinct from old.conversation_id
      or new.message_id is distinct from old.message_id
      or new.title is distinct from old.title
      or new.priority is distinct from old.priority
      or new.requires_acknowledgement is distinct from old.requires_acknowledgement
      or new.acknowledgement_schema is distinct from old.acknowledgement_schema
      or new.notification_class is distinct from old.notification_class
      or new.critical_category is distinct from old.critical_category
      or new.quiet_hours_override_reason is distinct from old.quiet_hours_override_reason
      or new.reminder_policy is distinct from old.reminder_policy
      or new.scheduled_at is distinct from old.scheduled_at
      or new.expires_at is distinct from old.expires_at
      or new.created_by_user_id is distinct from old.created_by_user_id
      or new.created_at is distinct from old.created_at
      or not (
        (old.status = 'scheduled' and new.status = 'published'
          and old.published_at is null and new.published_at is not null
          and new.cancelled_at is null and new.cancelled_by_user_id is null
          and new.cancellation_reason is null)
        or (old.status = 'scheduled' and new.status = 'cancelled'
          and old.published_at is null and new.published_at is null
          and new.cancelled_at is not null and new.cancelled_by_user_id is not null)
        or (old.status = 'published' and new.status = 'archived'
          and new.published_at = old.published_at
          and new.cancelled_at is null and new.cancelled_by_user_id is null
          and new.cancellation_reason is null)
      ) then
      raise exception 'announcement state transition is not permitted' using errcode = '22000';
    end if;
  end if;

  return new;
end;
$$;

create or replace function private.snapshot_announcement_recipients()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is not null and v_actor_id <> new.created_by_user_id then
    raise exception 'announcement creator does not match request user' using errcode = '42501';
  end if;
  if v_actor_id is null and v_jwt_role not in ('', 'service_role') then
    raise exception 'announcement recipient snapshot is not authorized' using errcode = '42501';
  end if;

  if new.status <> 'published' then
    return new;
  end if;

  insert into public.announcement_recipients (organization_id, announcement_id, user_id)
  select member.organization_id, new.id, member.user_id
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = new.organization_id
    and member.conversation_id = new.conversation_id
    and member.status = 'active'
  on conflict (organization_id, announcement_id, user_id) do nothing;

  return new;
end;
$$;

create or replace function private.validate_handoff_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_is_admin boolean;
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.author_user_id is distinct from old.author_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'handoff identity fields are immutable' using errcode = '22000';
  end if;

  if v_actor_id is null and v_jwt_role = 'service_role' then
    if old.status = 'draft' and new.status <> 'draft' then
      new.submitted_at := coalesce(new.submitted_at, now());
    end if;
    return new;
  end if;

  select exists (
    select 1
    from public.conversation_members member
    where member.organization_id = old.organization_id
      and member.conversation_id = old.conversation_id
      and member.user_id = v_actor_id
      and member.status = 'active'
      and member.role in ('owner', 'admin')
  ) into v_is_admin;

  if current_setting('app.bff_service_context', true) = 'on'
    and v_is_admin
    and new.status = 'draft'
    and new.submitted_at is null
    and new.submitted_version_id is null then
    return new;
  end if;

  if old.status = 'draft' and v_actor_id = old.author_user_id then
    if new.status not in ('draft', 'submitted') then
      raise exception 'authors may submit but not close handoffs' using errcode = '42501';
    end if;
    if new.status = 'submitted' then
      new.submitted_at := coalesce(new.submitted_at, now());
    end if;
    return new;
  end if;

  if old.status = 'submitted' and new.status = 'closed' and v_is_admin then
    if new.title is distinct from old.title
      or new.details is distinct from old.details
      or new.source_language is distinct from old.source_language
      or new.shift_started_at is distinct from old.shift_started_at
      or new.shift_ended_at is distinct from old.shift_ended_at
      or new.submitted_at is distinct from old.submitted_at then
      raise exception 'submitted handoff content is immutable' using errcode = '22000';
    end if;
    return new;
  end if;

  raise exception 'handoff update is not permitted' using errcode = '42501';
end;
$$;

create or replace function private.validate_device_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.installation_id is distinct from old.installation_id
    or new.created_at is distinct from old.created_at then
    raise exception 'device registration identity fields are immutable' using errcode = '22000';
  end if;
  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'revoked device registrations cannot be restored' using errcode = '22000';
  end if;
  -- Auth owns the session row and deletes it asynchronously after a Newone
  -- revocation command. The FK uses ON DELETE SET NULL so that compliance
  -- records can retain their device reference; an unbound registration must
  -- nevertheless become permanently non-dispatchable in that same cascade.
  if old.session_id is not null and new.session_id is null then
    new.revoked_at := coalesce(new.revoked_at, now());
  end if;
  if new.revoked_at is null and (
    new.session_id is null
    or not exists (
      select 1
      from auth.sessions session
      join private.session_installations binding
        on binding.session_id = session.id
       and binding.user_id = session.user_id
       and binding.installation_id = new.installation_id
       and binding.platform = new.platform
       and binding.revoked_at is null
      where session.id = new.session_id and session.user_id = new.user_id
    )
  ) then
    raise exception 'active bound device session required' using errcode = '23514';
  end if;
  new.last_seen_at := now();
  return new;
end;
$$;

create or replace function private.validate_session_installation_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (
    new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.installation_id is distinct from old.installation_id
    or new.platform is distinct from old.platform
    or new.created_at is distinct from old.created_at
    or (old.session_id is null and new.session_id is not null)
    or (old.session_id is not null and new.session_id is distinct from old.session_id
      and new.session_id is not null)
  ) then
    raise exception 'session installation identity fields are immutable' using errcode = '22000';
  end if;
  if tg_op = 'UPDATE' and old.revoked_at is not null and new.revoked_at is null then
    raise exception 'revoked session installations cannot be restored' using errcode = '22000';
  end if;
  if tg_op = 'UPDATE' and old.session_id is not null and new.session_id is null then
    new.revoked_at := coalesce(new.revoked_at, now());
  end if;
  if new.revoked_at is null and (
    new.session_id is null
    or not exists (
      select 1 from auth.sessions session
      where session.id = new.session_id
        and session.user_id = new.user_id
        and (session.not_after is null or session.not_after > now())
    )
  ) then
    raise exception 'active session does not belong to installation user' using errcode = '23514';
  end if;
  new.last_seen_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.apply_device_revocation_side_effects()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.revoked_at is null and new.revoked_at is not null then
    -- A target page may have been resolved immediately before revocation.
    -- Close every not-yet-submitted attempt so a push job cannot remain stuck
    -- behind an orphaned pending row and cannot retry a revoked registration.
    update private.push_delivery_attempts attempt
    set status = 'device_unregistered',
        failed_at = coalesce(attempt.failed_at, now()),
        last_error_code = coalesce(attempt.last_error_code, 'device_session_revoked'),
        receipt_claimed_by = null,
        receipt_claimed_until = null,
        updated_at = now()
    where attempt.organization_id = new.organization_id
      and attempt.device_id = new.id
      and attempt.status in ('pending', 'retry_wait');
  end if;
  return new;
end;
$$;

create or replace function private.apply_membership_status_side_effects()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'active' and new.status <> 'active' then
    -- The active-membership join in every content predicate cuts database,
    -- Storage, and new Realtime authorization immediately. Revoke all push
    -- installations in the same transaction so notification workers also
    -- stop selecting this organization membership.
    update public.device_registrations device
    set revoked_at = coalesce(device.revoked_at, now())
    where device.organization_id = new.organization_id
      and device.user_id = new.user_id
      and device.revoked_at is null;

    perform private.enqueue_outbox_job_internal(
      new.organization_id,
      'session_revoke',
      'membership:' || new.organization_id::text || ':' || new.user_id::text || ':' || new.revocation_generation::text,
      jsonb_build_object(
        'organization_id', new.organization_id,
        'user_id', new.user_id,
        'revocation_generation', new.revocation_generation
      )
    );
    perform private.enqueue_outbox_job_internal(
      new.organization_id,
      'realtime_control',
      'membership:' || new.organization_id::text || ':' || new.user_id::text || ':' || new.revocation_generation::text,
      jsonb_build_object(
        'schema_version', 1,
        'event_id', gen_random_uuid(),
        'event', 'membership.revoked',
        'control_topic', 'org:' || new.organization_id::text || ':user:' || new.user_id::text || ':control',
        'organization_id', new.organization_id,
        'occurred_at', now(),
        'user_id', new.user_id,
        'revocation_generation', new.revocation_generation
      )
    );
  end if;
  return new;
end;
$$;

create or replace function private.validate_invite_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.email is distinct from old.email
    or new.destination_type is distinct from old.destination_type
    or new.destination is distinct from old.destination
    or new.invited_user_id is distinct from old.invited_user_id
    or new.employee_code_hash is distinct from old.employee_code_hash
    or new.activation_mode is distinct from old.activation_mode
    or new.token_hash is distinct from old.token_hash
    or new.role is distinct from old.role
    or new.expires_at is distinct from old.expires_at
    or new.max_uses is distinct from old.max_uses
    or new.created_by_user_id is distinct from old.created_by_user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'invitation identity fields are immutable' using errcode = '22000';
  end if;

  if v_actor_id is null and v_jwt_role = 'service_role' then
    return new;
  end if;

  if current_setting('app.invite_redemption_context', true) = 'on'
    and v_actor_id is not null
    and new.accepted_by_user_id = v_actor_id
    and old.use_count = 0
    and new.use_count = 1
    and old.accepted_at is null
    and new.accepted_at is not null
    and old.revoked_at is null
    and new.revoked_at is null then
    return new;
  end if;

  if new.use_count is distinct from old.use_count
    or new.accepted_by_user_id is distinct from old.accepted_by_user_id
    or new.accepted_at is distinct from old.accepted_at
    or old.revoked_at is not null
    or new.revoked_at is null then
    raise exception 'administrators may only revoke an active invitation' using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function private.prevent_audit_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'supabase_admin')
    and current_setting('app.allow_audit_maintenance', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  raise exception 'audit events are append-only' using errcode = '55000';
end;
$$;

create or replace function private.write_audit_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_headers jsonb;
  v_hash_salt text := current_setting('app.audit_hash_salt', true);
  v_request_id uuid;
  v_bff_operation text;
  v_ip text;
  v_user_agent text;
begin
  if v_actor_id is null and v_jwt_role not in ('', 'service_role') then
    raise exception 'audit writer is not authorized' using errcode = '42501';
  end if;

  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;

  -- Only the service-only BFF context may supply correlation. A client can
  -- choose arbitrary HTTP headers, so request.headers is not itself an audit
  -- trust boundary for direct authenticated table writes.
  if coalesce(current_setting('app.bff_service_context', true), 'off') = 'on'
    and coalesce(current_setting('app.audit_request_id', true), '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_request_id := current_setting('app.audit_request_id', true)::uuid;
    v_bff_operation := nullif(current_setting('app.audit_operation', true), '');
  end if;
  v_ip := split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1);
  v_user_agent := v_headers ->> 'user-agent';

  insert into public.audit_events (
    organization_id,
    actor_user_id,
    event_type,
    target_type,
    target_id,
    request_id,
    ip_hash,
    user_agent_hash,
    metadata
  ) values (
    (v_row ->> 'organization_id')::uuid,
    v_actor_id,
    tg_argv[0] || '.' || lower(tg_op),
    tg_argv[0],
    coalesce(nullif(v_row ->> tg_argv[1], ''), 'unknown'),
    v_request_id,
    case when nullif(v_hash_salt, '') is null or nullif(v_ip, '') is null
      then null else extensions.digest(v_hash_salt || ':' || v_ip, 'sha256') end,
    case when nullif(v_hash_salt, '') is null or nullif(v_user_agent, '') is null
      then null else extensions.digest(v_hash_salt || ':' || v_user_agent, 'sha256') end,
    jsonb_strip_nulls(jsonb_build_object(
      'operation', lower(tg_op),
      'bff_operation', v_bff_operation,
      -- Audit rows are transactional: a later RPC failure rolls this row back.
      -- A persisted trigger event therefore represents a committed result.
      'result', 'committed'
    ))
  );

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function private.broadcast_message_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_recipient record;
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
begin
  if v_actor_id is null and v_jwt_role not in ('', 'service_role') then
    raise exception 'message broadcast is not authorized' using errcode = '42501';
  end if;
  if new.available_at > now() then
    return null;
  end if;

  -- Realtime authorization is cached for an existing socket. Publishing to a
  -- shared conversation topic would therefore continue leaking IDs/timing to
  -- a member removed after subscribing. Fan out content-free invalidations to
  -- inboxes selected from *current* active membership at commit time instead.
  for v_recipient in
    select member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = new.organization_id
      and member.conversation_id = new.conversation_id
      and member.status = 'active'
  loop
    perform realtime.send(
      jsonb_build_object(
        'schema_version', 1,
        'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'organization_id', new.organization_id,
        'occurred_at', v_occurred_at,
        'conversation_id', new.conversation_id,
        'entity_type', 'message',
        'entity_id', new.id::text,
        'version_id', null,
        'reason', 'message_changed'
      ),
      'workspace.invalidated',
      'org:' || new.organization_id::text || ':user:'
        || v_recipient.user_id::text || ':inbox',
      true
    );
  end loop;
  return null;
end;
$$;

create or replace function private.broadcast_receipt_invalidation_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_message_id bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_recipient record;
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
begin
  -- Receipt state is private. Realtime carries only a content-free hint that
  -- tells current members to reconcile the conversation through the BFF.
  -- realtime.send rows are transactional and become observable only if the
  -- enclosing receipt command commits.
  if coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'receipt invalidation requires trusted BFF context'
      using errcode = '42501';
  end if;
  for v_recipient in
    select member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.status = 'active'
  loop
    perform realtime.send(
      jsonb_build_object(
        'schema_version', 1,
        'event_id', v_event_id,
        'event', 'workspace.invalidated',
        'organization_id', p_organization_id,
        'occurred_at', v_occurred_at,
        'conversation_id', p_conversation_id,
        'entity_type', 'receipt',
        'entity_id', p_message_id::text,
        'version_id', null,
        'reason', 'receipt_changed'
      ),
      'workspace.invalidated',
      'org:' || p_organization_id::text || ':user:'
        || v_recipient.user_id::text || ':inbox',
      true
    );
  end loop;
end;
$$;

create or replace function private.maybe_queue_automatic_summary()
returns trigger
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_policy public.conversation_summary_policies%rowtype;
  v_last_source_id bigint := 0;
  v_source_ids bigint[];
  v_fingerprint bytea;
  v_version integer;
  v_summary_id uuid;
  v_language text;
begin
  if new.deleted_at is not null or new.body is null or new.available_at > now() then return null; end if;
  if not private.ai_use_case_approved(new.organization_id, 'summary', null) then return null; end if;
  select policy.* into v_policy
  from public.conversation_summary_policies policy
  join public.conversation_members member
    on member.organization_id = policy.organization_id
   and member.conversation_id = policy.conversation_id
   and member.user_id = policy.updated_by_user_id
   and member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where policy.organization_id = new.organization_id
    and policy.conversation_id = new.conversation_id
    and policy.mode = 'message_count';
  if not found then return null; end if;
  select coalesce(max(summary.source_last_message_id), 0) into v_last_source_id
  from public.conversation_summaries summary
  where summary.organization_id = new.organization_id
    and summary.conversation_id = new.conversation_id
    and summary.request_mode = 'automatic_message_count';
  select array_agg(candidate.id order by candidate.id) into v_source_ids
  from (
    select message.id
    from public.messages message
    where message.organization_id = new.organization_id
      and message.conversation_id = new.conversation_id
      and message.id > v_last_source_id
      and message.deleted_at is null
      and message.available_at <= now()
      and message.body is not null
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = v_policy.updated_by_user_id
      )
    order by message.id
    limit v_policy.message_count_threshold
  ) candidate;
  if cardinality(v_source_ids) < v_policy.message_count_threshold then return null; end if;
  select extensions.digest(convert_to(string_agg(
      message.id::text || ':' || encode(extensions.digest(convert_to(
        coalesce(message.body, '') || ':' || message.metadata::text || ':'
        || coalesce(message.edited_at::text, ''), 'UTF8'
      ), 'sha256'), 'hex'), ',' order by message.id
    ), 'UTF8'), 'sha256') into v_fingerprint
  from public.messages message
  where message.organization_id = new.organization_id
    and message.conversation_id = new.conversation_id
    and message.id = any(v_source_ids);
  select lower(coalesce(preference.message_language, profile.preferred_language, organization.default_language, 'en'))
    into v_language
  from public.organizations organization
  join public.profiles profile on profile.user_id = v_policy.updated_by_user_id
  left join public.organization_user_preferences preference
    on preference.organization_id = organization.id
   and preference.user_id = v_policy.updated_by_user_id
  where organization.id = new.organization_id;
  perform 1 from public.conversations conversation
  where conversation.organization_id = new.organization_id
    and conversation.id = new.conversation_id for update;
  select coalesce(max(summary.version_number), 0) + 1 into v_version
  from public.conversation_summaries summary
  where summary.organization_id = new.organization_id
    and summary.conversation_id = new.conversation_id;
  insert into public.conversation_summaries (
    organization_id, conversation_id, version_number, source_message_ids,
    source_first_message_id, source_last_message_id, source_fingerprint,
    requested_by_user_id, request_mode, language_code
  ) values (
    new.organization_id, new.conversation_id, v_version, v_source_ids,
    v_source_ids[1], v_source_ids[cardinality(v_source_ids)], v_fingerprint,
    v_policy.updated_by_user_id, 'automatic_message_count', v_language
  ) on conflict do nothing returning id into v_summary_id;
  if v_summary_id is not null then
    perform private.enqueue_outbox_job_internal(
      new.organization_id, 'summary', 'summary:' || v_summary_id::text,
      jsonb_build_object(
        'summary_id', v_summary_id,
        'organization_id', new.organization_id,
        'conversation_id', new.conversation_id,
        'source_message_ids', to_jsonb(v_source_ids),
        'source_fingerprint', encode(v_fingerprint, 'hex'),
        'language_code', v_language,
        'request_mode', 'automatic_message_count',
        'human_review_required', true
      )
    );
  end if;
  return null;
end;
$$;

create or replace function private.create_direct_conversation(
  p_organization_id uuid,
  p_other_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_low_user_id uuid;
  v_high_user_id uuid;
  v_conversation_id uuid;
begin
  if v_user_id is null or v_user_id = p_other_user_id then
    raise exception 'a different signed-in member is required' using errcode = '22023';
  end if;
  if not (select private.is_org_member(p_organization_id))
    or not exists (
      select 1 from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = p_other_user_id
        and membership.status = 'active'
    ) then
    raise exception 'both users must be active organization members' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations organization
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
  ) then
    raise exception 'direct messages are disabled for this organization' using errcode = '42501';
  end if;
  if not private.direct_pair_policy_permitted(
    p_organization_id, v_user_id, p_other_user_id
  ) then
    raise exception 'direct conversation is not permitted by organization policy' using errcode = '42501';
  end if;

  v_low_user_id := least(v_user_id, p_other_user_id);
  v_high_user_id := greatest(v_user_id, p_other_user_id);

  select pair.conversation_id into v_conversation_id
  from public.direct_conversation_pairs pair
  where pair.organization_id = p_organization_id
    and pair.member_low_user_id = v_low_user_id
    and pair.member_high_user_id = v_high_user_id;

  if v_conversation_id is not null then
    return v_conversation_id;
  end if;

  if not (select private.consume_rate_limit(
    'create-direct-hour',
    p_organization_id::text || ':' || v_user_id::text,
    10,
    3600
  )) then
    raise exception 'direct-conversation rate limit exceeded' using errcode = 'P0001';
  end if;

  v_conversation_id := gen_random_uuid();

  insert into public.conversations (
    id,
    organization_id,
    kind,
    visibility,
    history_policy,
    member_limit,
    created_by_user_id
  ) values (
    v_conversation_id,
    p_organization_id,
    'direct',
    'invite_only',
    'all',
    2,
    v_user_id
  );

  insert into public.direct_conversation_pairs (
    organization_id,
    conversation_id,
    member_low_user_id,
    member_high_user_id
  ) values (
    p_organization_id,
    v_conversation_id,
    v_low_user_id,
    v_high_user_id
  );

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id
  ) values
    (p_organization_id, v_conversation_id, v_user_id, 'member', v_user_id);

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id
  ) values
    (p_organization_id, v_conversation_id, p_other_user_id, 'member', v_user_id);

  return v_conversation_id;
exception when unique_violation then
  select pair.conversation_id into v_conversation_id
  from public.direct_conversation_pairs pair
  where pair.organization_id = p_organization_id
    and pair.member_low_user_id = v_low_user_id
    and pair.member_high_user_id = v_high_user_id;
  if v_conversation_id is null then
    raise;
  end if;
  return v_conversation_id;
end;
$$;

create or replace function private.create_group_conversation(
  p_organization_id uuid,
  p_name text,
  p_member_user_ids uuid[] default array[]::uuid[],
  p_kind text default 'group',
  p_unit_id uuid default null,
  p_history_policy text default 'since_join',
  p_incident_severity text default null,
  p_incident_classification text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_conversation_id uuid;
  v_member_count integer;
begin
  if v_user_id is null or not (select private.is_org_member(p_organization_id)) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  if p_kind not in ('group', 'team', 'shift', 'announcement', 'incident') then
    raise exception 'unsupported group conversation kind' using errcode = '22023';
  end if;
  if p_kind in ('announcement', 'incident')
    and not (select private.is_org_admin(p_organization_id)) then
    raise exception 'organization administrator permission required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 160 then
    raise exception 'conversation name is required' using errcode = '22023';
  end if;
  if p_history_policy not in ('all', 'since_join')
    or ((p_kind = 'incident') is distinct from (
      p_incident_severity in ('low', 'medium', 'high', 'critical')
      and char_length(btrim(coalesce(p_incident_classification, ''))) between 1 and 120
    )) then
    raise exception 'invalid conversation history or incident policy' using errcode = '22023';
  end if;
  if not (select private.consume_rate_limit(
    'create-group-day',
    p_organization_id::text || ':' || v_user_id::text,
    5,
    86400
  )) then
    raise exception 'group-conversation rate limit exceeded' using errcode = 'P0001';
  end if;

  select count(distinct member_id) into v_member_count
  from unnest(array_append(coalesce(p_member_user_ids, array[]::uuid[]), v_user_id)) member_id;
  if v_member_count > 500 then
    raise exception 'initial conversation membership exceeds 500' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_member_user_ids, array[]::uuid[])) requested_user_id
    where not exists (
      select 1
      from public.organization_memberships membership
      where membership.organization_id = p_organization_id
        and membership.user_id = requested_user_id
        and membership.status = 'active'
    )
  ) then
    raise exception 'all conversation members must be active organization members' using errcode = '23514';
  end if;

  v_conversation_id := gen_random_uuid();

  insert into public.conversations (
    id,
    organization_id,
    kind,
    name,
    visibility,
    unit_id,
    history_policy,
    incident_severity,
    incident_classification,
    member_limit,
    created_by_user_id
  ) values (
    v_conversation_id,
    p_organization_id,
    p_kind,
    btrim(p_name),
    case when p_unit_id is null then 'invite_only' else 'unit' end,
    p_unit_id,
    p_history_policy,
    p_incident_severity,
    case when p_incident_classification is null then null else btrim(p_incident_classification) end,
    case when p_kind = 'announcement' then 5000 else 500 end,
    v_user_id
  );

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id,
    v_conversation_id,
    v_user_id,
    'owner',
    v_user_id,
    case when p_history_policy = 'since_join' then now() else null end
  );

  insert into public.conversation_members (
    organization_id,
    conversation_id,
    user_id,
    role,
    joined_by_user_id,
    history_visible_from
  )
  select
    p_organization_id,
    v_conversation_id,
    member_id,
    'member',
    v_user_id,
    case when p_history_policy = 'since_join' then now() else null end
  from (
    select distinct member_id
    from unnest(coalesce(p_member_user_ids, array[]::uuid[])) member_id
    where member_id <> v_user_id
  ) members;

  return v_conversation_id;
end;
$$;

create or replace function private.send_message(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_kind text default 'text',
  p_body text default null,
  p_language_code text default null,
  p_reply_to_message_id bigint default null,
  p_thread_root_message_id bigint default null,
  p_metadata jsonb default '{}'::jsonb,
  p_available_at timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_message_id bigint;
  v_rate_key text;
  v_expected_thread_root bigint;
begin
  if v_user_id is null
    or not (select private.can_post_to_conversation(p_organization_id, p_conversation_id)) then
    raise exception 'active conversation membership with posting access is required' using errcode = '42501';
  end if;
  if p_kind not in ('text', 'attachment') then
    raise exception 'client message kind is not permitted' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(coalesce(p_metadata, '{}'::jsonb)) metadata_key
      where metadata_key <> 'mentionUserIds'
    ) then
    raise exception 'client message metadata only permits mentionUserIds' using errcode = '22023';
  end if;
  if p_reply_to_message_id is not null then
    select coalesce(message.thread_root_message_id, message.id)
      into v_expected_thread_root
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_reply_to_message_id
      and message.deleted_at is null;
    if not found then
      raise exception 'reply source is not readable in the target conversation' using errcode = '22023';
    end if;
    if p_thread_root_message_id is not null
      and p_thread_root_message_id <> v_expected_thread_root then
      raise exception 'thread root does not match reply source' using errcode = '22023';
    end if;
  end if;
  if p_thread_root_message_id is not null and not exists (
    select 1 from public.messages root_message
    where root_message.organization_id = p_organization_id
      and root_message.conversation_id = p_conversation_id
      and root_message.id = p_thread_root_message_id
      and root_message.deleted_at is null
  ) then
    raise exception 'thread root is not readable in the target conversation' using errcode = '22023';
  end if;
  if p_metadata ? 'mentionUserIds' then
    if jsonb_typeof(p_metadata -> 'mentionUserIds') <> 'array'
      or jsonb_array_length(p_metadata -> 'mentionUserIds') > 50
      or exists (
        select 1
        from jsonb_array_elements_text(p_metadata -> 'mentionUserIds') mentioned(value)
        where mentioned.value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or not exists (
            select 1 from public.conversation_members member
            join public.organization_memberships organization_member
              on organization_member.organization_id = member.organization_id
             and organization_member.user_id = member.user_id
             and organization_member.status = 'active'
            where member.organization_id = p_organization_id
              and member.conversation_id = p_conversation_id
              and member.user_id = mentioned.value::uuid
              and member.status = 'active'
          )
      ) then
      raise exception 'mentions must reference active conversation members' using errcode = '22023';
    end if;
  end if;

  select message.id into v_message_id
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.sender_user_id = v_user_id
    and message.client_nonce = p_client_nonce;
  if v_message_id is not null then
    return v_message_id;
  end if;

  v_rate_key := p_organization_id::text || ':' || v_user_id::text;
  if not (select private.consume_rate_limit('message-burst-10s', v_rate_key, 10, 10))
    or not (select private.consume_rate_limit('message-minute', v_rate_key, 60, 60))
    or not (select private.consume_rate_limit('message-hour', v_rate_key, 1000, 3600)) then
    raise exception 'message rate limit exceeded' using errcode = 'P0001';
  end if;

  insert into public.messages (
    organization_id,
    conversation_id,
    sender_user_id,
    client_nonce,
    kind,
    body,
    language_code,
    language_detection_state,
    language_detected_at,
    reply_to_message_id,
    thread_root_message_id,
    metadata,
    available_at
  ) values (
    p_organization_id,
    p_conversation_id,
    v_user_id,
    p_client_nonce,
    p_kind,
    p_body,
    p_language_code,
    case when p_body is null then 'not_applicable' else 'pending' end,
    case when p_body is null then now() else null end,
    p_reply_to_message_id,
    p_thread_root_message_id,
    -- Mentions are normalized below; arbitrary client JSON never persists on
    -- the message row. Server provenance lives in dedicated version/forward
    -- tables rather than sharing this untrusted bag.
    '{}'::jsonb,
    p_available_at
  )
  on conflict (organization_id, conversation_id, sender_user_id, client_nonce)
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select message.id into v_message_id
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.sender_user_id = v_user_id
      and message.client_nonce = p_client_nonce;
  end if;

  if p_metadata ? 'mentionUserIds' then
    insert into public.message_mentions (
      organization_id, conversation_id, message_id, mentioned_user_id
    )
    select p_organization_id, p_conversation_id, v_message_id, mentioned.value::uuid
    from (
      select distinct value
      from jsonb_array_elements_text(p_metadata -> 'mentionUserIds') mention(value)
    ) mentioned
    on conflict do nothing;
  end if;

  return v_message_id;
end;
$$;

create or replace function private.prepare_bff_command_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_require_aal2 boolean,
  p_recent_auth_seconds integer,
  p_route text,
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
  v_authorization jsonb;
  v_idempotency jsonb;
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_operation,
    p_require_aal2,
    p_recent_auth_seconds
  );
  v_idempotency := private.begin_idempotency_internal(
    p_actor_user_id,
    p_organization_id,
    p_route,
    p_idempotency_key,
    p_request_sha256
  );

  if v_idempotency ->> 'state' = 'replay' then
    return v_idempotency;
  end if;
  if v_idempotency ->> 'state' <> 'started' then
    raise exception 'idempotency key is unavailable' using errcode = '55000';
  end if;

  perform private.set_bff_actor_context_internal(
    p_actor_user_id,
    p_session_id,
    v_authorization ->> 'aal',
    p_operation
  );
  return jsonb_build_object('state', 'started', 'authorization', v_authorization);
end;
$$;

create or replace function private.finish_bff_command_internal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_route text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_response jsonb,
  p_status integer default 200
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.complete_idempotency_internal(
    p_actor_user_id,
    p_organization_id,
    p_route,
    p_idempotency_key,
    p_request_sha256,
    p_status,
    p_response
  );
  perform private.clear_bff_actor_context_internal();
  return p_response;
end;
$$;

create or replace function private.bff_authorize_request_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_require_aal2 boolean,
  p_recent_auth_seconds integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  return private.authorize_bff_request_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    p_operation,
    p_require_aal2,
    p_recent_auth_seconds
  );
end;
$$;

create or replace function private.bff_consume_rate_limit_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_ip_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_limit integer;
  v_window_seconds integer;
  v_retry_at timestamptz;
  v_user_allowed boolean;
  v_session_allowed boolean;
  v_network_allowed boolean := true;
  v_allowed boolean;
begin
  perform private.require_service_role();
  v_authorization := private.authorize_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id, p_operation, false, 0
  );
  if not coalesce((v_authorization ->> 'allowed')::boolean, false) then
    return jsonb_build_object('allowed', false, 'retry_after_seconds', 0, 'reason', 'unauthorized');
  end if;
  if p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid IP hash' using errcode = '22023';
  end if;

  select limits.request_limit, limits.window_seconds
    into v_limit, v_window_seconds
  from (values
    ('message.send', 60, 60),
    ('conversation.direct.create', 10, 3600),
    ('conversation.group.create', 5, 86400),
    ('attachment.upload.create', 10, 60),
    -- `message.translate` is the public Edge route kind while
    -- `translation.enqueue` is the durable command/audit operation. Keep both
    -- aliases on the same authoritative launch budget.
    ('message.translate', 30, 60),
    ('translation.enqueue', 30, 60),
    ('message.report', 10, 3600),
    ('invite.issue', 20, 3600),
    ('member.suspend', 20, 3600)
  ) as limits(operation, request_limit, window_seconds)
  where limits.operation = p_operation;
  v_limit := coalesce(v_limit, 120);
  v_window_seconds := coalesce(v_window_seconds, 60);

  -- Client/network metadata never participates in the trusted identity key.
  -- Rotating X-Forwarded-For therefore cannot reset either account bucket.
  v_user_allowed := private.consume_rate_limit(
    'bff-user:' || left(p_operation, 71),
    p_organization_id::text || ':' || p_actor_user_id::text,
    v_limit, v_window_seconds
  );
  v_session_allowed := private.consume_rate_limit(
    'bff-session:' || left(p_operation, 68),
    p_organization_id::text || ':' || p_actor_user_id::text || ':' || p_session_id::text,
    v_limit, v_window_seconds
  );
  if p_ip_hash is not null then
    -- The network bucket is supplemental and deliberately roomier for shared
    -- office/NAT egress. It can only make a decision stricter, never looser.
    v_network_allowed := private.consume_rate_limit(
      'bff-network:' || left(p_operation, 68),
      p_organization_id::text || ':' || p_ip_hash,
      least(v_limit * 10, 10000), v_window_seconds
    );
  end if;
  v_allowed := v_user_allowed and v_session_allowed and v_network_allowed;

  if not v_allowed then
    -- `consume_rate_limit` uses first-request-anchored windows. Derive the
    -- Retry-After value from those same durable buckets instead of an epoch
    -- boundary, which could otherwise tell a throttled client to retry early.
    select max(
      bucket.window_started_at + make_interval(secs => v_window_seconds)
    ) into v_retry_at
    from private.rate_limit_buckets bucket
    where bucket.window_started_at
        > clock_timestamp() - make_interval(secs => v_window_seconds)
      and (
        (
          bucket.scope = 'bff-user:' || left(p_operation, 71)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_actor_user_id::text, 'sha256'
          )
          and bucket.request_count > v_limit
        )
        or (
          bucket.scope = 'bff-session:' || left(p_operation, 68)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_actor_user_id::text || ':'
              || p_session_id::text,
            'sha256'
          )
          and bucket.request_count > v_limit
        )
        or (
          p_ip_hash is not null
          and bucket.scope = 'bff-network:' || left(p_operation, 68)
          and bucket.key_hash = extensions.digest(
            p_organization_id::text || ':' || p_ip_hash, 'sha256'
          )
          and bucket.request_count > least(v_limit * 10, 10000)
        )
      );
  end if;

  return jsonb_build_object(
    'allowed', v_allowed,
    'retry_after_seconds', case when v_allowed then 0 else greatest(1, ceil(
      extract(epoch from (
        coalesce(v_retry_at, clock_timestamp() + make_interval(secs => v_window_seconds))
        - clock_timestamp()
      ))
    )::integer) end,
    'user_bucket_allowed', v_user_allowed,
    'session_bucket_allowed', v_session_allowed,
    'network_bucket_allowed', v_network_allowed
  );
end;
$$;

create or replace function private.bff_begin_idempotency_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_route text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
  ) then
    raise exception 'active organization membership required' using errcode = '42501';
  end if;
  return private.begin_idempotency_internal(
    p_actor_user_id, p_organization_id, p_route, p_idempotency_key, p_request_sha256
  );
end;
$$;

create or replace function private.bff_complete_idempotency_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_route text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_status integer,
  p_response jsonb
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  perform private.complete_idempotency_internal(
    p_actor_user_id, p_organization_id, p_route, p_idempotency_key,
    p_request_sha256, p_status, p_response
  );
end;
$$;

create or replace function private.bff_create_direct_conversation_impl(
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
  v_conversation_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.direct.create', false, 0, '/v2/conversations/direct',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  v_conversation_id := private.create_direct_conversation(p_organization_id, p_other_user_id);
  v_response := jsonb_build_object('conversation_id', v_conversation_id);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/direct',
    p_idempotency_key, p_request_sha256, v_response, 200
  );
end;
$$;

create or replace function private.bff_create_group_conversation_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_name text,
  p_member_user_ids uuid[],
  p_kind text,
  p_unit_id uuid,
  p_history_policy text,
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
  v_conversation_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.group.create', false, 0, '/v2/conversations/group',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  v_conversation_id := private.create_group_conversation(
    p_organization_id, p_name, coalesce(p_member_user_ids, array[]::uuid[]), p_kind, p_unit_id,
    p_history_policy, p_incident_severity, p_incident_classification
  );
  v_response := jsonb_build_object(
    'conversation_id', v_conversation_id,
    'kind', p_kind,
    'history_policy', p_history_policy,
    'incident_severity', p_incident_severity,
    'incident_classification', p_incident_classification,
    'is_read_only', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/group',
    p_idempotency_key, p_request_sha256, v_response, 201
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
  -- Recipient language is server-owned. The client may display a preview, but
  -- message delivery derives every required target from current active member
  -- preferences. Client language is only a hint: every recipient target is
  -- staged behind trusted language detection so a forged hint cannot suppress
  -- or misroute required translations. Model failure cannot block the original.
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
      where member.organization_id = p_organization_id
        and member.conversation_id = p_conversation_id
        and member.status = 'active'
        and member.user_id <> p_actor_user_id
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

create or replace function private.bff_hide_message_for_me_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_hidden_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.hide_for_me', false, 0, '/v2/messages/:id/hide',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id)
    or not exists (
      select 1 from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.id = p_message_id
        and message.deleted_at is null
    ) then
    raise exception 'readable message not found' using errcode = '42501';
  end if;
  insert into public.message_user_visibility (
    organization_id, conversation_id, message_id, user_id
  ) values (
    p_organization_id, p_conversation_id, p_message_id, p_actor_user_id
  )
  on conflict (organization_id, conversation_id, message_id, user_id) do nothing
  returning hidden_at into v_hidden_at;
  if v_hidden_at is null then
    select visibility.hidden_at into v_hidden_at
    from public.message_user_visibility visibility
    where visibility.organization_id = p_organization_id
      and visibility.conversation_id = p_conversation_id
      and visibility.message_id = p_message_id
      and visibility.user_id = p_actor_user_id;
  end if;
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'message_id', p_message_id,
    'hidden_for_user', true,
    'hidden_at', v_hidden_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/hide',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_forward_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_source_conversation_id uuid,
  p_source_message_id bigint,
  p_target_conversation_id uuid,
  p_client_nonce uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_source public.messages%rowtype;
  v_target_message_id bigint;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.forward', false, 0, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_source_conversation_id) then
    raise exception 'readable source message not found' using errcode = '42501';
  end if;
  select * into v_source
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_source_conversation_id
    and message.id = p_source_message_id
    and message.deleted_at is null
    and message.kind = 'text'
    and message.body is not null;
  if not found then
    raise exception 'readable forwardable source message not found' using errcode = '42501';
  end if;
  v_target_message_id := private.send_message(
    p_organization_id, p_target_conversation_id, p_client_nonce, 'text',
    v_source.body, v_source.language_code, null, null, '{}'::jsonb
  );
  insert into public.message_forward_provenance (
    organization_id, target_conversation_id, target_message_id,
    source_conversation_id, source_message_id, forwarded_by_user_id
  ) values (
    p_organization_id, p_target_conversation_id, v_target_message_id,
    p_source_conversation_id, p_source_message_id, p_actor_user_id
  ) on conflict (organization_id, target_conversation_id, target_message_id) do nothing;
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'push',
    'message:' || p_organization_id::text || ':' || p_target_conversation_id::text || ':' || v_target_message_id::text,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', p_target_conversation_id,
      'message_id', v_target_message_id
    )
  );
  v_response := jsonb_build_object(
    'message_id', v_target_message_id,
    'client_nonce', p_client_nonce,
    'forwarded', true,
    'source', jsonb_build_object(
      'conversation_id', p_source_conversation_id,
      'message_id', p_source_message_id
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/forward',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.summary_source_snapshot_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_source_message_ids bigint[]
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_ids bigint[];
  v_fingerprint bytea;
  v_visible_from timestamptz;
begin
  if cardinality(p_source_message_ids) not between 1 and 500
    then
    raise exception 'authorized summary sources required' using errcode = '42501';
  end if;
  select member.history_visible_from into v_visible_from
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.user_id = p_actor_user_id
    and member.status = 'active';
  if not found then
    raise exception 'authorized summary sources required' using errcode = '42501';
  end if;
  select array_agg(message.id order by message.id),
         extensions.digest(convert_to(string_agg(
           message.id::text || ':' || encode(extensions.digest(convert_to(
             coalesce(message.body, '') || ':' || message.metadata::text || ':'
             || coalesce(message.edited_at::text, ''), 'UTF8'
           ), 'sha256'), 'hex'), ',' order by message.id
         ), 'UTF8'), 'sha256')
    into v_ids, v_fingerprint
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = any(p_source_message_ids)
    and message.deleted_at is null
    and message.available_at <= now()
    and (v_visible_from is null or message.created_at >= v_visible_from)
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = message.organization_id
        and visibility.conversation_id = message.conversation_id
        and visibility.message_id = message.id
        and visibility.user_id = p_actor_user_id
    );
  if cardinality(v_ids) is distinct from cardinality(p_source_message_ids)
    or cardinality(v_ids) is distinct from cardinality(array(
      select distinct source_id from unnest(p_source_message_ids) source_id
    )) then
    raise exception 'summary source is missing, duplicated, deleted, or unauthorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'source_message_ids', to_jsonb(v_ids),
    'source_first_message_id', v_ids[1],
    'source_last_message_id', v_ids[cardinality(v_ids)],
    'source_fingerprint', encode(v_fingerprint, 'hex')
  );
end;
$$;

create or replace function private.summary_source_is_current_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_source_message_ids bigint[],
  p_source_fingerprint bytea
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select count(*) = cardinality(p_source_message_ids)
      and array_agg(message.id order by message.id) = p_source_message_ids
      and extensions.digest(convert_to(string_agg(
        message.id::text || ':' || encode(extensions.digest(convert_to(
          coalesce(message.body, '') || ':' || message.metadata::text || ':'
          || coalesce(message.edited_at::text, ''), 'UTF8'
        ), 'sha256'), 'hex'), ',' order by message.id
      ), 'UTF8'), 'sha256') = p_source_fingerprint
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = any(p_source_message_ids)
      and message.deleted_at is null
      and message.available_at <= now()
  ), false)
$$;

create or replace function private.bff_request_conversation_summary_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_source_message_ids bigint[], p_language_code text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb; v_source jsonb; v_summary_id uuid; v_version integer;
  v_job_id bigint; v_status text; v_created boolean := false; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'summary.request', false, 0, '/v2/conversations/:id/summaries',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if coalesce(p_language_code, '') !~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
    or not private.ai_use_case_approved(p_organization_id, 'summary', null) then
    raise exception 'valid tenant-approved summary request required' using errcode = '42501';
  end if;
  v_source := private.summary_source_snapshot_internal(
    p_organization_id, p_conversation_id, p_actor_user_id, p_source_message_ids
  );
  if not private.consume_rate_limit(
      'summary-handoff-conversation-hour',
      p_organization_id::text || ':' || p_conversation_id::text,
      5, 3600
    )
    or not private.consume_rate_limit(
      'summary-handoff-actor-day',
      p_organization_id::text || ':' || p_actor_user_id::text,
      20, 86400
    ) then
    raise exception 'summary/handoff draft rate limit exceeded'
      using errcode = 'P0001';
  end if;
  perform 1 from public.conversations conversation
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
  for update;
  select coalesce(max(summary.version_number), 0) + 1 into v_version
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id
    and summary.conversation_id = p_conversation_id;
  insert into public.conversation_summaries (
    organization_id, conversation_id, version_number, source_message_ids,
    source_first_message_id, source_last_message_id, source_fingerprint,
    requested_by_user_id, request_mode, language_code
  ) values (
    p_organization_id, p_conversation_id, v_version,
    array(select jsonb_array_elements_text(v_source -> 'source_message_ids')::bigint),
    (v_source ->> 'source_first_message_id')::bigint,
    (v_source ->> 'source_last_message_id')::bigint,
    decode(v_source ->> 'source_fingerprint', 'hex'), p_actor_user_id,
    'manual', lower(p_language_code)
  ) on conflict do nothing returning id, status into v_summary_id, v_status;
  v_created := v_summary_id is not null;
  if v_created then
    v_job_id := private.enqueue_outbox_job_internal(
      p_organization_id, 'summary', 'summary:' || v_summary_id::text,
      jsonb_build_object(
        'summary_id', v_summary_id,
        'organization_id', p_organization_id,
        'conversation_id', p_conversation_id,
        'source_message_ids', v_source -> 'source_message_ids',
        'source_fingerprint', v_source ->> 'source_fingerprint',
        'language_code', lower(p_language_code),
        'request_mode', 'manual',
        'human_review_required', true
      )
    );
  else
    select summary.id, summary.version_number, summary.status
      into v_summary_id, v_version, v_status
    from public.conversation_summaries summary
    where summary.organization_id = p_organization_id
      and summary.conversation_id = p_conversation_id
      and summary.source_fingerprint = decode(v_source ->> 'source_fingerprint', 'hex')
      and summary.language_code = lower(p_language_code)
      and summary.correction_of_summary_id is null
    order by summary.version_number desc limit 1;
    select job.id into v_job_id from private.outbox_jobs job
    where job.topic = 'summary' and job.dedupe_key = 'summary:' || v_summary_id::text;
  end if;
  v_response := jsonb_build_object(
    'summary_id', v_summary_id, 'version_number', v_version,
    'status', coalesce(v_status, 'queued'), 'summary_job_id', v_job_id,
    'source_fingerprint', v_source ->> 'source_fingerprint',
    'deduplicated', not v_created,
    'human_review_required', true, 'originals_unaffected', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/summaries',
    p_idempotency_key, p_request_sha256, v_response, 202
  );
end;
$$;

create or replace function private.bff_create_manual_summary_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_source_message_ids bigint[], p_language_code text,
  p_primary_topic text, p_summary_body text,
  p_key_topics text[], p_decisions jsonb, p_action_items jsonb, p_ambiguities text[],
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_command jsonb; v_source jsonb; v_summary_id uuid; v_correction_id uuid;
  v_version integer; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'summary.manual.create', false, 0, '/v2/conversations/:id/summaries/manual',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if char_length(btrim(coalesce(p_primary_topic, ''))) not between 1 and 240
    or char_length(btrim(coalesce(p_summary_body, ''))) not between 1 and 30000
    or not private.bounded_text_array(coalesce(p_key_topics, array[]::text[]), 50, 1, 500)
    or not private.bounded_text_array(coalesce(p_ambiguities, array[]::text[]), 50, 1, 2000)
    or jsonb_typeof(coalesce(p_decisions, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_decisions, '[]'::jsonb)) > 100
    or jsonb_typeof(coalesce(p_action_items, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_action_items, '[]'::jsonb)) > 100
    or coalesce(p_language_code, '') !~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$' then
    raise exception 'valid manual summary required' using errcode = '22023';
  end if;
  v_source := private.summary_source_snapshot_internal(
    p_organization_id, p_conversation_id, p_actor_user_id, p_source_message_ids
  );
  if not private.consume_rate_limit(
      'summary-handoff-conversation-hour',
      p_organization_id::text || ':' || p_conversation_id::text,
      5, 3600
    )
    or not private.consume_rate_limit(
      'summary-handoff-actor-day',
      p_organization_id::text || ':' || p_actor_user_id::text,
      20, 86400
    ) then
    raise exception 'summary/handoff draft rate limit exceeded'
      using errcode = 'P0001';
  end if;
  perform 1 from public.conversations conversation
  where conversation.organization_id = p_organization_id and conversation.id = p_conversation_id for update;
  select coalesce(max(summary.version_number), 0) + 1 into v_version
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id and summary.conversation_id = p_conversation_id;
  select summary.id into v_correction_id
  from public.conversation_summaries summary
  where summary.organization_id = p_organization_id
    and summary.conversation_id = p_conversation_id
    and summary.source_fingerprint = decode(v_source ->> 'source_fingerprint', 'hex')
    and summary.language_code = lower(p_language_code)
  order by summary.version_number desc limit 1;
  insert into public.conversation_summaries (
    organization_id, conversation_id, version_number, correction_of_summary_id, source_message_ids,
    source_first_message_id, source_last_message_id, source_fingerprint,
    requested_by_user_id, request_mode, language_code, status, primary_topic, summary_body,
    key_topics, decisions, action_items, ambiguities,
    output_fingerprint,
    processor_type, processor_provenance
  ) values (
    p_organization_id, p_conversation_id, v_version, v_correction_id,
    array(select jsonb_array_elements_text(v_source -> 'source_message_ids')::bigint),
    (v_source ->> 'source_first_message_id')::bigint,
    (v_source ->> 'source_last_message_id')::bigint,
    decode(v_source ->> 'source_fingerprint', 'hex'), p_actor_user_id,
    'manual_fallback', lower(p_language_code), 'draft', btrim(p_primary_topic), btrim(p_summary_body),
    coalesce(p_key_topics, array[]::text[]), coalesce(p_decisions, '[]'::jsonb),
    coalesce(p_action_items, '[]'::jsonb), coalesce(p_ambiguities, array[]::text[]),
    extensions.digest(convert_to(
      v_source ->> 'source_fingerprint' || ':' || btrim(p_primary_topic) || ':' || btrim(p_summary_body)
        || ':' || to_jsonb(coalesce(p_key_topics, array[]::text[]))::text
        || ':' || coalesce(p_decisions, '[]'::jsonb)::text
        || ':' || coalesce(p_action_items, '[]'::jsonb)::text
        || ':' || to_jsonb(coalesce(p_ambiguities, array[]::text[]))::text,
      'UTF8'
    ), 'sha256'),
    'manual', jsonb_build_object('ai_used', false)
  ) returning id into v_summary_id;
  v_response := jsonb_build_object(
    'summary_id', v_summary_id, 'version_number', v_version,
    'status', 'draft', 'human_review_required', true,
    'primary_topic', btrim(p_primary_topic),
    'key_topics', to_jsonb(coalesce(p_key_topics, array[]::text[])),
    'decisions', coalesce(p_decisions, '[]'::jsonb),
    'action_items', coalesce(p_action_items, '[]'::jsonb),
    'ambiguities', to_jsonb(coalesce(p_ambiguities, array[]::text[])),
    'output_fingerprint', encode(extensions.digest(convert_to(
      v_source ->> 'source_fingerprint' || ':' || btrim(p_primary_topic) || ':' || btrim(p_summary_body)
        || ':' || to_jsonb(coalesce(p_key_topics, array[]::text[]))::text
        || ':' || coalesce(p_decisions, '[]'::jsonb)::text
        || ':' || coalesce(p_action_items, '[]'::jsonb)::text
        || ':' || to_jsonb(coalesce(p_ambiguities, array[]::text[]))::text,
      'UTF8'
    ), 'sha256'), 'hex'),
    'ai_used', false, 'originals_unaffected', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/summaries/manual',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_review_conversation_summary_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_summary_id uuid, p_decision text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_command jsonb; v_summary public.conversation_summaries%rowtype; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'summary.review', false, 0, '/v2/summaries/:id/review',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select * into v_summary from public.conversation_summaries summary
  where summary.organization_id = p_organization_id and summary.id = p_summary_id for update;
  if not found or v_summary.status <> 'draft'
    or not private.is_conversation_admin(p_organization_id, v_summary.conversation_id)
    or p_decision not in ('approve', 'reject')
    or (p_decision = 'reject' and char_length(btrim(coalesce(p_note, ''))) not between 3 and 4000) then
    raise exception 'authorized summary review required' using errcode = '42501';
  end if;
  if p_decision = 'approve' then
    update public.conversation_summaries summary
    set status = 'approved', reviewed_by_user_id = p_actor_user_id,
        reviewed_at = now(), review_note = p_note, updated_at = now()
    where summary.id = p_summary_id;
  else
    update public.conversation_summaries summary
    set status = 'failed', primary_topic = null, summary_body = null,
        key_topics = null, decisions = null, action_items = null, ambiguities = null,
        output_fingerprint = null, processor_type = null,
        provider = null, model = null, processor_provenance = '{}'::jsonb,
        failure_code = 'human_rejected', updated_at = now()
    where summary.id = p_summary_id;
  end if;
  v_response := jsonb_build_object(
    'summary_id', p_summary_id,
    'status', case when p_decision = 'approve' then 'approved' else 'failed' end,
    'human_reviewed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/summaries/:id/review',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_set_summary_policy_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_mode text, p_message_count_threshold integer,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_command jsonb; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'summary.policy.set', false, 0, '/v2/conversations/:id/summary-policy',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id)
    or p_mode not in ('manual', 'message_count', 'shift_close')
    or (p_mode = 'message_count' and p_message_count_threshold not between 10 and 500)
    or (p_mode <> 'message_count' and p_message_count_threshold is not null) then
    raise exception 'authorized valid summary policy required' using errcode = '42501';
  end if;
  insert into public.conversation_summary_policies (
    organization_id, conversation_id, mode, message_count_threshold,
    require_human_review, updated_by_user_id
  ) values (
    p_organization_id, p_conversation_id, p_mode, p_message_count_threshold,
    true, p_actor_user_id
  ) on conflict (organization_id, conversation_id) do update
  set mode = excluded.mode,
      message_count_threshold = excluded.message_count_threshold,
      require_human_review = true,
      updated_by_user_id = excluded.updated_by_user_id,
      updated_at = now();
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id, 'mode', p_mode,
    'message_count_threshold', p_message_count_threshold,
    'human_review_required', true,
    'automatic_publish', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/summary-policy',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_update_conversation_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_patch jsonb,
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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.update', false, 0, '/v2/conversations/:id',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_patch) <> 'object'
    or exists (
      select 1 from jsonb_object_keys(p_patch) patch_key
      where patch_key not in ('name', 'description', 'avatar_path', 'is_archived')
    )
    or (p_patch ? 'is_archived' and jsonb_typeof(p_patch -> 'is_archived') <> 'boolean') then
    raise exception 'invalid conversation patch' using errcode = '22023';
  end if;

  update public.conversations conversation
  set name = case when p_patch ? 'name' then p_patch ->> 'name' else conversation.name end,
      description = case when p_patch ? 'description' then p_patch ->> 'description' else conversation.description end,
      avatar_path = case when p_patch ? 'avatar_path' then p_patch ->> 'avatar_path' else conversation.avatar_path end,
      is_archived = case when p_patch ? 'is_archived' then (p_patch ->> 'is_archived')::boolean else conversation.is_archived end
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id;
  if not found then raise exception 'conversation not found' using errcode = 'P0002'; end if;

  v_response := jsonb_build_object('conversation_id', p_conversation_id, 'updated', true);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_close_incident_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
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
  v_closed_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'incident.close', false, 0, '/v2/conversations/:id/incident/close',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 2000
    or not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'incident administrator and closure reason required' using errcode = '42501';
  end if;
  update public.conversations conversation
  set closed_at = now(), closed_by_user_id = p_actor_user_id,
      closure_reason = btrim(p_reason)
  where conversation.organization_id = p_organization_id
    and conversation.id = p_conversation_id
    and conversation.kind = 'incident'
    and conversation.closed_at is null
  returning conversation.closed_at into v_closed_at;
  if not found then
    raise exception 'open incident not found' using errcode = 'P0002';
  end if;
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'push',
    'incident:' || p_conversation_id::text || ':closed',
    jsonb_build_object(
      'organization_id', p_organization_id,
      'conversation_id', p_conversation_id,
      'state', 'closed'
    )
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'closed_at', v_closed_at,
    'closed_by_user_id', p_actor_user_id,
    'closure_reason', btrim(p_reason),
    'is_read_only', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/incident/close',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.add', false, 0, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'admin', 'member') then
    raise exception 'invalid conversation role' using errcode = '22023';
  end if;

  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    history_visible_from
  ) values (
    p_organization_id, p_conversation_id, p_target_user_id, p_role, p_actor_user_id,
    case when exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.history_policy = 'since_join'
    ) then now() else null end
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'role', p_role,
    'history_disclosure', (
      select jsonb_build_object(
        'policy', conversation.history_policy,
        'visible_from', membership.history_visible_from,
        'label_key', case when conversation.history_policy = 'all'
          then 'conversation.history.all' else 'conversation.history.since_join' end
      )
      from public.conversations conversation
      join public.conversation_members membership
        on membership.organization_id = conversation.organization_id
       and membership.conversation_id = conversation.id
       and membership.user_id = p_target_user_id
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
    )
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/members',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_remove_conversation_member_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'conversation.member.remove', false, 0,
    '/v2/conversations/:id/members/:membershipId',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;

  update public.conversation_members membership
  set status = 'removed', left_at = now()
  where membership.organization_id = p_organization_id
    and membership.conversation_id = p_conversation_id
    and membership.user_id = p_target_user_id
    and membership.status = 'active';
  if not found then raise exception 'active conversation member not found' using errcode = 'P0002'; end if;
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'user_id', p_target_user_id,
    'removed', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/conversations/:id/members/:membershipId',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_report_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_category text,
  p_details text,
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
  v_report_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.report', false, 0, '/v2/messages/:id/report',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id)
    or not exists (
      select 1 from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.id = p_message_id
    ) then
    raise exception 'message is not available' using errcode = '42501';
  end if;

  insert into private.message_reports (
    organization_id, conversation_id, message_id, reporter_user_id, category, details
  ) values (
    p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, p_category, p_details
  )
  on conflict (organization_id, conversation_id, message_id, reporter_user_id)
  do update set details = excluded.details
  returning id into v_report_id;
  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'moderation',
    'report:' || v_report_id::text,
    jsonb_build_object('report_id', v_report_id)
  );
  v_response := jsonb_build_object('report_id', v_report_id, 'status', 'open');
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/report',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_acknowledge_announcement_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_version_id uuid,
  p_device_id uuid,
  p_attestation jsonb,
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
  v_announcement_id uuid;
  v_acknowledged_at timestamptz;
  v_ack_schema jsonb;
  v_attestation_required boolean;
  v_role_snapshot text;
  v_scope_snapshot jsonb;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.acknowledge', false, 0,
    '/v2/updates/:versionId/acknowledgements',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;

  -- Resolve the parent, then lock it using the same ordering as correction.
  -- The final latest-version check runs in a fresh READ COMMITTED statement
  -- after any concurrent correction has committed.
  select version.announcement_id into v_announcement_id
  from public.announcement_versions version
  where version.organization_id = p_organization_id
    and version.id = p_announcement_version_id;
  if not found then
    raise exception 'announcement version was superseded or not found'
      using errcode = '40001';
  end if;
  perform 1
  from public.announcements announcement
  where announcement.organization_id = p_organization_id
    and announcement.id = v_announcement_id
  for update;
  if not found then
    raise exception 'announcement version was superseded or not found'
      using errcode = '40001';
  end if;
  select version.acknowledgement_schema
    into v_ack_schema
  from public.announcement_versions version
  join public.announcements announcement
    on announcement.organization_id = version.organization_id
   and announcement.id = version.announcement_id
  where version.organization_id = p_organization_id
    and version.id = p_announcement_version_id
    and version.announcement_id = v_announcement_id
    and announcement.status in ('published', 'archived')
    and version.requires_acknowledgement
    and not exists (
      select 1 from public.announcement_versions newer
      where newer.organization_id = version.organization_id
        and newer.announcement_id = version.announcement_id
        and newer.version_number > version.version_number
    )
    and exists (
      select 1 from public.announcement_recipients recipient
      where recipient.organization_id = version.organization_id
        and recipient.announcement_id = version.announcement_id
        and recipient.user_id = p_actor_user_id
    );
  if not found then
    raise exception 'announcement version was superseded or not found'
      using errcode = '40001';
  end if;
  v_attestation_required := (v_ack_schema ->> 'attestation_required')::boolean;
  if not private.attestation_satisfies_schema(
      v_ack_schema, coalesce(p_attestation, '{}'::jsonb)
    )
    or (v_attestation_required and p_device_id is null)
    or (p_device_id is not null and not exists (
      select 1 from public.device_registrations device
      join auth.sessions device_session
        on device_session.id = device.session_id
       and device_session.user_id = device.user_id
      join private.session_installations session_binding
        on session_binding.session_id = device_session.id
       and session_binding.user_id = device.user_id
       and session_binding.installation_id = device.installation_id
       and session_binding.platform = device.platform
       and session_binding.revoked_at is null
      where device.organization_id = p_organization_id
        and device.id = p_device_id
        and device.user_id = p_actor_user_id
        and device.session_id = p_session_id
        and device.revoked_at is null
        and (device_session.not_after is null or device_session.not_after > now())
        and not exists (
          select 1 from private.session_revocations revocation
          where revocation.organization_id = device.organization_id
            and revocation.session_id = device_session.id
        )
    )) then
    raise exception 'valid acknowledgement attestation and device required'
      using errcode = '42501';
  end if;
  select membership.role into v_role_snapshot
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  v_scope_snapshot := private.effective_scopes_internal(p_actor_user_id, p_organization_id);
  insert into public.announcement_acknowledgements (
    organization_id, announcement_id, announcement_version_id, user_id,
    session_id, device_id, attestation, role_snapshot, scope_snapshot
  ) values (
    p_organization_id, v_announcement_id, p_announcement_version_id, p_actor_user_id,
    p_session_id, p_device_id, coalesce(p_attestation, '{}'::jsonb),
    v_role_snapshot, v_scope_snapshot
  )
  on conflict (organization_id, announcement_id, announcement_version_id, user_id) do nothing;
  select acknowledgement.acknowledged_at into v_acknowledged_at
  from public.announcement_acknowledgements acknowledgement
  where acknowledgement.organization_id = p_organization_id
    and acknowledgement.announcement_id = v_announcement_id
    and acknowledgement.announcement_version_id = p_announcement_version_id
    and acknowledgement.user_id = p_actor_user_id;
  if not found then raise exception 'announcement recipient not found' using errcode = '42501'; end if;
  v_response := jsonb_build_object(
    'announcement_id', v_announcement_id,
    'announcement_version_id', p_announcement_version_id,
    'acknowledged_at', v_acknowledged_at,
    'session_id', p_session_id,
    'device_id', p_device_id,
    'role_snapshot', v_role_snapshot,
    'scope_snapshot', v_scope_snapshot
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/updates/:versionId/acknowledgements',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_create_announcement_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_language_code text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_scheduled_at timestamptz,
  p_acknowledgement_schema jsonb,
  p_notification_class text,
  p_critical_category text,
  p_quiet_hours_override_reason text,
  p_reminder_policy jsonb,
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
  v_announcement_id uuid;
  v_announcement_version_id uuid;
  v_recipient_count integer;
  v_status text;
  v_publish_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.publish', true, 900, '/v2/updates',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'communications.publish', null
  ) then
    raise exception 'organization administrator permission required' using errcode = '42501';
  end if;

  v_status := case when p_scheduled_at is null then 'published' else 'scheduled' end;
  v_publish_at := coalesce(p_scheduled_at, now());
  if p_priority not in ('normal', 'important', 'emergency')
    or p_notification_class not in ('routine', 'urgent', 'critical')
    or (
      (p_notification_class = 'routine' and (
        p_critical_category is not null or p_quiet_hours_override_reason is not null
      ))
      or (p_notification_class in ('urgent', 'critical') and (
        p_critical_category not in (
          'safety', 'security', 'operations', 'weather', 'business_continuity'
        )
        or char_length(btrim(coalesce(p_quiet_hours_override_reason, ''))) not between 3 and 500
      ))
    )
    or (p_scheduled_at is not null and p_scheduled_at <= now())
    or (p_expires_at is not null and p_expires_at <= v_publish_at)
    or not private.valid_acknowledgement_schema(p_acknowledgement_schema)
    or not private.valid_reminder_policy(p_reminder_policy, v_publish_at)
    or (
      not p_requires_acknowledgement
      and (
        (p_acknowledgement_schema ->> 'attestation_required')::boolean
        or (p_reminder_policy ->> 'enabled')::boolean
      )
    ) then
    raise exception 'invalid announcement schedule or acknowledgement policy'
      using errcode = '22023';
  end if;

  v_message_id := private.send_message(
    p_organization_id, p_conversation_id, p_client_nonce, 'text', p_body,
    p_language_code, null, null, '{}'::jsonb, v_publish_at
  );
  insert into public.announcements (
    organization_id, conversation_id, message_id, title, priority,
    status, requires_acknowledgement, acknowledgement_schema,
    notification_class, critical_category, quiet_hours_override_reason,
    reminder_policy, scheduled_at, published_at,
    expires_at, created_by_user_id
  ) values (
    p_organization_id, p_conversation_id, v_message_id, p_title, p_priority,
    v_status, p_requires_acknowledgement, p_acknowledgement_schema,
    p_notification_class, p_critical_category,
    case when p_quiet_hours_override_reason is null then null
      else btrim(p_quiet_hours_override_reason) end,
    p_reminder_policy, p_scheduled_at,
    case when v_status = 'published' then now() else null end,
    p_expires_at, p_actor_user_id
  ) returning id into v_announcement_id;
  select version.id into v_announcement_version_id
  from public.announcement_versions version
  where version.organization_id = p_organization_id
    and version.announcement_id = v_announcement_id
    and version.version_number = 1;
  select count(*) into v_recipient_count
  from public.announcement_recipients recipient
  where recipient.organization_id = p_organization_id
    and recipient.announcement_id = v_announcement_id;
  if v_status = 'published' then
    perform private.enqueue_outbox_job_internal(
      p_organization_id,
      'push',
      'announcement:' || v_announcement_id::text || ':published',
      jsonb_build_object(
        'organization_id', p_organization_id,
        'conversation_id', p_conversation_id,
        'announcement_id', v_announcement_id,
        'announcement_version_id', v_announcement_version_id,
        'message_id', v_message_id,
        'state', 'published',
        'notification_class', p_notification_class,
        'critical_category', p_critical_category,
        'quiet_hours_override_reason', p_quiet_hours_override_reason
      )
    );
  end if;
  v_response := jsonb_build_object(
    'announcement_id', v_announcement_id,
    'announcement_version_id', v_announcement_version_id,
    'message_id', v_message_id,
    'status', v_status,
    'scheduled_at', p_scheduled_at,
    'recipient_count', v_recipient_count,
    'published_at', case when v_status = 'published' then now() else null end,
    'notification_class', p_notification_class,
    'critical_category', p_critical_category,
    'quiet_hours_override', p_notification_class in ('urgent', 'critical'),
    'quiet_hours_override_reason', case when p_quiet_hours_override_reason is null
      then null else btrim(p_quiet_hours_override_reason) end,
    'sms_fallback_available', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/updates',
    p_idempotency_key, p_request_sha256, v_response,
    case when v_status = 'scheduled' then 202 else 201 end
  );
end;
$$;

create or replace function private.bff_preview_announcement_audience_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_excluded integer;
  v_preview jsonb;
  v_languages jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.preview', true, 900
  );
  if p_limit not between 1 and 200
    or not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'communications.publish', null
    )
    or not exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.kind = 'announcement'
        and not conversation.is_archived
    ) then
    raise exception 'announcement audience preview is not permitted' using errcode = '42501';
  end if;
  select count(*) filter (
      where member.status = 'active' and organization_member.status = 'active'
    ),
    count(*) filter (
      where member.status <> 'active' or organization_member.status <> 'active'
    )
    into v_total, v_excluded
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id;
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', candidate.user_id,
      'display_name', candidate.display_name,
      'preferred_language', candidate.preferred_language
    ) order by candidate.display_name, candidate.user_id), '[]'::jsonb)
    into v_preview
  from (
    select member.user_id, profile.display_name,
      lower(coalesce(preference.message_language, profile.preferred_language)) as preferred_language
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    join public.profiles profile on profile.user_id = member.user_id
    left join public.organization_user_preferences preference
      on preference.organization_id = member.organization_id
     and preference.user_id = member.user_id
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.status = 'active'
    order by profile.display_name, member.user_id
    limit p_limit
  ) candidate;
  select coalesce(jsonb_agg(language order by language), '[]'::jsonb)
    into v_languages
  from (
    select distinct lower(coalesce(preference.message_language, profile.preferred_language)) as language
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    join public.profiles profile on profile.user_id = member.user_id
    left join public.organization_user_preferences preference
      on preference.organization_id = member.organization_id
     and preference.user_id = member.user_id
    where member.organization_id = p_organization_id
      and member.conversation_id = p_conversation_id
      and member.status = 'active'
  ) languages;
  return jsonb_build_object(
    'conversation_id', p_conversation_id,
    'total_count', v_total,
    'preview', v_preview,
    'excluded_count', v_excluded,
    'notification_languages', v_languages,
    'reconcile_after', now()
  );
end;
$$;

create or replace function private.bff_cancel_scheduled_announcement_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_id uuid,
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
  v_message_id bigint;
  v_cancelled_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.cancel', true, 900, '/v2/updates/:id/cancel',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'communications.publish', null
    ) or (p_reason is not null and char_length(btrim(p_reason)) not between 3 and 2000) then
    raise exception 'scheduled announcement cancellation is not permitted'
      using errcode = '42501';
  end if;
  update public.announcements announcement
  set status = 'cancelled', cancelled_at = now(),
      cancelled_by_user_id = p_actor_user_id,
      cancellation_reason = case when p_reason is null then null else btrim(p_reason) end
  where announcement.organization_id = p_organization_id
    and announcement.id = p_announcement_id
    and announcement.status = 'scheduled'
    and announcement.scheduled_at > now()
  returning announcement.message_id, announcement.cancelled_at
    into v_message_id, v_cancelled_at;
  if not found then
    raise exception 'future scheduled announcement not found' using errcode = 'P0002';
  end if;
  perform set_config('app.scheduled_announcement_cancel_context', 'on', true);
  update public.messages message
  set deleted_at = now()
  where message.organization_id = p_organization_id
    and message.id = v_message_id
    and message.available_at > now()
    and message.deleted_at is null;
  perform set_config('app.scheduled_announcement_cancel_context', 'off', true);
  v_response := jsonb_build_object(
    'announcement_id', p_announcement_id,
    'status', 'cancelled',
    'cancelled_at', v_cancelled_at,
    'cancellation_reason', case when p_reason is null then null else btrim(p_reason) end
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/updates/:id/cancel',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_promote_due_announcements_impl(
  p_worker_id uuid,
  p_limit integer default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_announcement record;
  v_version record;
  v_ids uuid[] := array[]::uuid[];
  v_promoted integer := 0;
begin
  perform private.require_service_role();
  if p_worker_id is null or p_limit not between 1 and 200 then
    raise exception 'valid scheduler worker and limit required' using errcode = '22023';
  end if;
  for v_announcement in
    select announcement.*
    from public.announcements announcement
    where announcement.status = 'scheduled'
      and announcement.scheduled_at <= now()
      and (announcement.expires_at is null or announcement.expires_at > now())
    order by announcement.scheduled_at, announcement.id
    limit p_limit
    for update skip locked
  loop
    update public.announcements announcement
    set status = 'published', published_at = now()
    where announcement.organization_id = v_announcement.organization_id
      and announcement.id = v_announcement.id
      and announcement.status = 'scheduled';
    if not found then continue; end if;
    insert into public.announcement_recipients (
      organization_id, announcement_id, user_id
    )
    select member.organization_id, v_announcement.id, member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = v_announcement.organization_id
      and member.conversation_id = v_announcement.conversation_id
      and member.status = 'active'
    on conflict do nothing;
    select version.* into v_version
    from public.announcement_versions version
    where version.organization_id = v_announcement.organization_id
      and version.announcement_id = v_announcement.id
    order by version.version_number desc
    limit 1;
    perform private.enqueue_outbox_job_internal(
      v_announcement.organization_id, 'push',
      'announcement:' || v_announcement.id::text || ':published',
      jsonb_build_object(
        'organization_id', v_announcement.organization_id,
        'conversation_id', v_announcement.conversation_id,
        'announcement_id', v_announcement.id,
        'announcement_version_id', v_version.id,
        'message_id', v_version.message_id,
        'state', 'published',
        'notification_class', v_version.notification_class,
        'critical_category', v_version.critical_category,
        'quiet_hours_override_reason', v_version.quiet_hours_override_reason,
        'scheduler_worker_id', p_worker_id
      )
    );
    v_ids := array_append(v_ids, v_announcement.id);
    v_promoted := v_promoted + 1;
  end loop;
  return jsonb_build_object(
    'processed', v_promoted,
    'promoted', v_promoted,
    'announcement_ids', to_jsonb(v_ids)
  );
end;
$$;

create or replace function private.bff_process_announcement_obligations_impl(
  p_worker_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_processed integer := 0;
  v_reminders integer := 0;
  v_escalations integer := 0;
  v_keys jsonb := '[]'::jsonb;
  v_deadline timestamptz;
  v_interval integer;
  v_maximum integer;
  v_escalate integer;
  v_should_escalate boolean;
  v_should_remind boolean;
begin
  perform private.require_service_role();
  if p_worker_id is null or p_limit not between 1 and 100 then
    raise exception 'valid scheduler worker and limit required' using errcode = '22023';
  end if;
  for v_item in
    select recipient.*, announcement.conversation_id, announcement.published_at,
      version.id as announcement_version_id, version.notification_class,
      version.critical_category, version.quiet_hours_override_reason,
      version.reminder_policy
    from public.announcement_recipients recipient
    join public.announcements announcement
      on announcement.organization_id = recipient.organization_id
     and announcement.id = recipient.announcement_id
     and announcement.status = 'published'
    join lateral (
      select candidate.* from public.announcement_versions candidate
      where candidate.organization_id = announcement.organization_id
        and candidate.announcement_id = announcement.id
      order by candidate.version_number desc
      limit 1
    ) version on version.requires_acknowledgement
    where (version.reminder_policy ->> 'enabled')::boolean
      and not exists (
        select 1 from public.announcement_acknowledgements acknowledgement
        where acknowledgement.organization_id = recipient.organization_id
          and acknowledgement.announcement_id = recipient.announcement_id
          and acknowledgement.announcement_version_id = version.id
          and acknowledgement.user_id = recipient.user_id
      )
    order by announcement.published_at, recipient.announcement_id, recipient.user_id
    limit p_limit
    for update of recipient skip locked
  loop
    v_processed := v_processed + 1;
    v_deadline := (v_item.reminder_policy ->> 'deadline_at')::timestamptz;
    v_interval := (v_item.reminder_policy ->> 'interval_seconds')::integer;
    v_maximum := (v_item.reminder_policy ->> 'maximum_reminders')::integer;
    v_escalate := nullif(v_item.reminder_policy ->> 'escalate_after_seconds', '')::integer;
    v_should_escalate := v_item.escalated_at is null and (
      now() >= v_deadline
      or (v_escalate is not null
        and now() >= v_item.published_at + make_interval(secs => v_escalate))
    );
    v_should_remind := not v_should_escalate
      and now() < v_deadline
      and v_item.reminder_count < v_maximum
      and coalesce(v_item.last_reminded_at, v_item.published_at)
        + make_interval(secs => v_interval) <= now();
    if v_should_escalate then
      update public.announcement_recipients recipient
      set escalated_at = now()
      where recipient.organization_id = v_item.organization_id
        and recipient.announcement_id = v_item.announcement_id
        and recipient.user_id = v_item.user_id;
      perform private.enqueue_outbox_job_internal(
        v_item.organization_id, 'push',
        'announcement:' || v_item.announcement_id::text || ':recipient:'
          || v_item.user_id::text || ':escalated',
        jsonb_build_object(
          'organization_id', v_item.organization_id,
          'conversation_id', v_item.conversation_id,
          'announcement_id', v_item.announcement_id,
          'announcement_version_id', v_item.announcement_version_id,
          'target_user_id', v_item.user_id,
          'state', 'acknowledgement_escalated',
          'notification_class', case when v_item.notification_class = 'routine'
            then 'urgent' else v_item.notification_class end,
          'critical_category', coalesce(v_item.critical_category, 'operations'),
          'quiet_hours_override_reason', coalesce(
            v_item.quiet_hours_override_reason,
            'Acknowledgement deadline or escalation threshold reached'
          ),
          'scheduler_worker_id', p_worker_id
        )
      );
      v_escalations := v_escalations + 1;
      v_keys := v_keys || jsonb_build_array(
        v_item.announcement_id::text || ':' || v_item.user_id::text || ':escalated'
      );
    elsif v_should_remind then
      update public.announcement_recipients recipient
      set reminder_count = recipient.reminder_count + 1, last_reminded_at = now()
      where recipient.organization_id = v_item.organization_id
        and recipient.announcement_id = v_item.announcement_id
        and recipient.user_id = v_item.user_id;
      perform private.enqueue_outbox_job_internal(
        v_item.organization_id, 'push',
        'announcement:' || v_item.announcement_id::text || ':recipient:'
          || v_item.user_id::text || ':reminder:' || (v_item.reminder_count + 1)::text,
        jsonb_build_object(
          'organization_id', v_item.organization_id,
          'conversation_id', v_item.conversation_id,
          'announcement_id', v_item.announcement_id,
          'announcement_version_id', v_item.announcement_version_id,
          'target_user_id', v_item.user_id,
          'state', 'acknowledgement_reminder',
          'notification_class', v_item.notification_class,
          'critical_category', v_item.critical_category,
          'quiet_hours_override_reason', v_item.quiet_hours_override_reason,
          'reminder_number', v_item.reminder_count + 1,
          'scheduler_worker_id', p_worker_id
        )
      );
      v_reminders := v_reminders + 1;
      v_keys := v_keys || jsonb_build_array(
        v_item.announcement_id::text || ':' || v_item.user_id::text
          || ':reminder:' || (v_item.reminder_count + 1)::text
      );
    end if;
  end loop;
  return jsonb_build_object(
    'processed', v_processed,
    'reminders_enqueued', v_reminders,
    'escalations_enqueued', v_escalations,
    'sms_fallback_available', false,
    'announcement_recipient_keys', v_keys
  );
end;
$$;

-- Pilot handoff obligations use a deliberately fixed, auditable policy:
-- remind at most three times at fifteen-minute intervals after the deadline,
-- then escalate at sixty minutes. SMS remains unavailable until a separately
-- verified provider and consent policy are deployed.
create or replace function private.bff_process_overdue_handoffs_impl(
  p_worker_id uuid,
  p_limit integer default 100
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_item record;
  v_processed integer := 0;
  v_reminders integer := 0;
  v_escalations integer := 0;
  v_keys jsonb := '[]'::jsonb;
  v_source_current boolean;
begin
  perform private.require_service_role();
  if p_worker_id is null or p_limit not between 1 and 100 then
    raise exception 'valid scheduler worker and limit required' using errcode = '22023';
  end if;
  for v_item in
    select handoff.*, version.id as handoff_version_id,
      version.source_message_ids as version_source_message_ids,
      version.source_fingerprint as version_source_fingerprint
    from public.shift_handoffs handoff
    join public.handoff_versions version
      on version.organization_id = handoff.organization_id
     and version.handoff_id = handoff.id
     and version.id = handoff.submitted_version_id
    where handoff.status = 'submitted'
      and handoff.acknowledgement_due_at is not null
      and handoff.acknowledgement_due_at <= now()
      and not exists (
        select 1 from public.handoff_acknowledgements acknowledgement
        where acknowledgement.organization_id = handoff.organization_id
          and acknowledgement.handoff_id = handoff.id
          and acknowledgement.handoff_version_id = handoff.submitted_version_id
      )
      and (
        handoff.escalated_at is null
        or (
          handoff.reminder_count < 3
          and coalesce(handoff.last_reminded_at, handoff.acknowledgement_due_at)
            + interval '15 minutes' <= now()
        )
      )
    order by handoff.acknowledgement_due_at, handoff.id
    limit p_limit
    for update of handoff skip locked
  loop
    v_processed := v_processed + 1;
    v_source_current := private.handoff_source_is_current_internal(
      v_item.organization_id, v_item.conversation_id,
      v_item.version_source_message_ids, v_item.version_source_fingerprint
    );
    if v_item.escalated_at is null and (
      not v_source_current
      or now() >= v_item.acknowledgement_due_at + interval '60 minutes'
    ) then
      update public.shift_handoffs handoff
      set escalated_at = now()
      where handoff.organization_id = v_item.organization_id
        and handoff.id = v_item.id
        and handoff.status = 'submitted'
        and handoff.escalated_at is null;
      if not found then continue; end if;
      perform private.enqueue_outbox_job_internal(
        v_item.organization_id, 'push',
        'handoff:' || v_item.id::text || ':escalated',
        jsonb_build_object(
          'organization_id', v_item.organization_id,
          'conversation_id', v_item.conversation_id,
          'handoff_id', v_item.id,
          'handoff_version_id', v_item.handoff_version_id,
          'state', 'acknowledgement_escalated',
          'source_state', case when v_source_current then 'current' else 'stale' end,
          'notification_class', 'urgent',
          'critical_category', 'operations',
          'quiet_hours_override_reason', case when v_source_current
            then 'Handoff acknowledgement is at least sixty minutes overdue'
            else 'Handoff source messages changed before acknowledgement'
          end,
          'scheduler_worker_id', p_worker_id
        )
      );
      v_escalations := v_escalations + 1;
      v_keys := v_keys || jsonb_build_array(v_item.id::text || ':escalated');
    elsif v_item.reminder_count < 3
      and coalesce(v_item.last_reminded_at, v_item.acknowledgement_due_at)
        + interval '15 minutes' <= now() then
      update public.shift_handoffs handoff
      set reminder_count = handoff.reminder_count + 1,
          last_reminded_at = now()
      where handoff.organization_id = v_item.organization_id
        and handoff.id = v_item.id
        and handoff.status = 'submitted';
      if not found then continue; end if;
      perform private.enqueue_outbox_job_internal(
        v_item.organization_id, 'push',
        'handoff:' || v_item.id::text || ':reminder:'
          || (v_item.reminder_count + 1)::text,
        jsonb_build_object(
          'organization_id', v_item.organization_id,
          'conversation_id', v_item.conversation_id,
          'handoff_id', v_item.id,
          'handoff_version_id', v_item.handoff_version_id,
          'state', 'acknowledgement_reminder',
          'source_state', 'current',
          'notification_class', 'routine',
          'reminder_number', v_item.reminder_count + 1,
          'scheduler_worker_id', p_worker_id
        )
      );
      v_reminders := v_reminders + 1;
      v_keys := v_keys || jsonb_build_array(
        v_item.id::text || ':reminder:' || (v_item.reminder_count + 1)::text
      );
    end if;
  end loop;
  return jsonb_build_object(
    'processed', v_processed,
    'reminders_enqueued', v_reminders,
    'escalations_enqueued', v_escalations,
    'sms_fallback_available', false,
    'handoff_keys', v_keys
  );
end;
$$;

create or replace function private.handoff_source_snapshot_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_source_message_ids bigint[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ids bigint[] := array[]::bigint[];
  v_fingerprint bytea;
  v_visible_from timestamptz;
begin
  if cardinality(coalesce(p_source_message_ids, array[]::bigint[])) > 500 then
    raise exception 'handoff source set exceeds 500 messages' using errcode = '22023';
  end if;
  select membership.history_visible_from into v_visible_from
  from public.conversation_members membership
  join public.organization_memberships organization_membership
    on organization_membership.organization_id = membership.organization_id
   and organization_membership.user_id = membership.user_id
   and organization_membership.status = 'active'
  where membership.organization_id = p_organization_id
    and membership.conversation_id = p_conversation_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  if not found then
    raise exception 'active conversation membership required' using errcode = '42501';
  end if;
  select coalesce(array_agg(message.id order by message.id), array[]::bigint[]),
    extensions.digest(convert_to(coalesce(string_agg(
      message.id::text || ':' || message.kind || ':'
        || coalesce(encode(extensions.digest(convert_to(message.body, 'UTF8'), 'sha256'), 'hex'), '')
        || ':' || coalesce(message.edited_at::text, '')
        || ':' || coalesce(message.deleted_at::text, ''),
      '|' order by message.id
    ), ''), 'UTF8'), 'sha256')
  into v_ids, v_fingerprint
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = any(coalesce(p_source_message_ids, array[]::bigint[]))
    and message.deleted_at is null
    and message.available_at <= now()
    and (v_visible_from is null or message.created_at >= v_visible_from)
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = message.organization_id
        and visibility.conversation_id = message.conversation_id
        and visibility.message_id = message.id
        and visibility.user_id = p_actor_user_id
    );
  if cardinality(v_ids) <> cardinality(coalesce(p_source_message_ids, array[]::bigint[]))
    or v_ids <> (
      select coalesce(array_agg(distinct source_id order by source_id), array[]::bigint[])
      from unnest(coalesce(p_source_message_ids, array[]::bigint[])) source_id
    ) then
    raise exception 'handoff sources must be unique, current, visible messages in one conversation'
      using errcode = '42501';
  end if;
  return jsonb_build_object(
    'source_message_ids', to_jsonb(v_ids),
    'source_fingerprint', encode(v_fingerprint, 'hex')
  );
end;
$$;

create or replace function private.handoff_source_is_current_internal(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_source_message_ids bigint[],
  p_source_fingerprint bytea
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select count(*) = cardinality(p_source_message_ids)
      and extensions.digest(convert_to(coalesce(string_agg(
        message.id::text || ':' || message.kind || ':'
          || coalesce(encode(extensions.digest(convert_to(message.body, 'UTF8'), 'sha256'), 'hex'), '')
          || ':' || coalesce(message.edited_at::text, '')
          || ':' || coalesce(message.deleted_at::text, ''),
        '|' order by message.id
      ), ''), 'UTF8'), 'sha256') = p_source_fingerprint
    from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = any(p_source_message_ids)
      and message.deleted_at is null
      and message.available_at <= now()
  ), false)
$$;

create or replace function private.bff_create_handoff_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_title text,
  p_details text,
  p_source_language text,
  p_shift_started_at timestamptz,
  p_shift_ended_at timestamptz,
  p_source_message_ids bigint[],
  p_acknowledgement_due_at timestamptz,
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
  v_handoff_id uuid;
  v_handoff_version_id uuid;
  v_source_snapshot jsonb;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'handoff.create', false, 0, '/v2/handoffs',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation supervisor permission required' using errcode = '42501';
  end if;
  if p_shift_ended_at <= p_shift_started_at
    or (p_acknowledgement_due_at is not null
      and p_acknowledgement_due_at <= p_shift_ended_at) then
    raise exception 'valid handoff shift and acknowledgement deadline required'
      using errcode = '22023';
  end if;
  v_source_snapshot := private.handoff_source_snapshot_internal(
    p_organization_id, p_conversation_id, p_actor_user_id,
    coalesce(p_source_message_ids, array[]::bigint[])
  );
  if not private.consume_rate_limit(
      'summary-handoff-conversation-hour',
      p_organization_id::text || ':' || p_conversation_id::text,
      5, 3600
    )
    or not private.consume_rate_limit(
      'summary-handoff-actor-day',
      p_organization_id::text || ':' || p_actor_user_id::text,
      20, 86400
    ) then
    raise exception 'summary/handoff draft rate limit exceeded'
      using errcode = 'P0001';
  end if;
  insert into public.shift_handoffs (
    organization_id, conversation_id, author_user_id, title, details,
    source_language, shift_started_at, shift_ended_at, source_message_ids,
    source_fingerprint, acknowledgement_due_at
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id, p_title, p_details,
    p_source_language, p_shift_started_at, p_shift_ended_at,
    array(select jsonb_array_elements_text(v_source_snapshot -> 'source_message_ids')::bigint),
    decode(v_source_snapshot ->> 'source_fingerprint', 'hex'),
    p_acknowledgement_due_at
  ) returning id into v_handoff_id;
  select version.id into v_handoff_version_id
  from public.handoff_versions version
  where version.organization_id = p_organization_id
    and version.handoff_id = v_handoff_id
    and version.version_number = 1;
  v_response := jsonb_build_object(
    'handoff_id', v_handoff_id,
    'handoff_version_id', v_handoff_version_id,
    'status', 'draft',
    'source_message_ids', v_source_snapshot -> 'source_message_ids',
    'source_fingerprint', v_source_snapshot ->> 'source_fingerprint',
    'source_state', 'current',
    'acknowledgement_due_at', p_acknowledgement_due_at,
    'reminder_state', case when p_acknowledgement_due_at is null then 'not_due' else 'not_due' end,
    'escalation_state', 'not_due',
    'sms_fallback_available', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/handoffs',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_sign_handoff_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_version_id uuid,
  p_device_id uuid,
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
  v_submitted_at timestamptz;
  v_handoff_id uuid;
  v_version public.handoff_versions%rowtype;
  v_role_snapshot text;
  v_scope_snapshot jsonb;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'handoff.sign', false, 0, '/v2/handoffs/:versionId/sign',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select version.* into v_version
  from public.handoff_versions version
  where version.organization_id = p_organization_id
    and version.id = p_handoff_version_id;
  if not found then
    raise exception 'handoff version was superseded or is not signable'
      using errcode = '40001';
  end if;
  v_handoff_id := v_version.handoff_id;
  perform 1 from public.shift_handoffs handoff
  where handoff.organization_id = p_organization_id
    and handoff.id = v_handoff_id
    and handoff.author_user_id = p_actor_user_id
    and handoff.status = 'draft'
  for update;
  if not found then
    raise exception 'handoff version was superseded or is not signable'
      using errcode = '40001';
  end if;
  perform 1 from public.handoff_versions version
  where version.organization_id = p_organization_id
    and version.handoff_id = v_handoff_id
    and version.id = p_handoff_version_id
    and not exists (
      select 1 from public.handoff_versions newer
      where newer.organization_id = version.organization_id
        and newer.handoff_id = version.handoff_id
        and newer.version_number > version.version_number
    );
  if not found then
    raise exception 'handoff version was superseded or is not signable'
      using errcode = '40001';
  end if;
  if not private.handoff_source_is_current_internal(
      p_organization_id, v_version.conversation_id,
      v_version.source_message_ids, v_version.source_fingerprint
    ) then
    raise exception 'handoff source messages were edited or deleted'
      using errcode = '40001';
  end if;
  if p_device_id is not null and not exists (
    select 1 from public.device_registrations device
    join private.session_installations session_binding
      on session_binding.session_id = device.session_id
     and session_binding.user_id = device.user_id
     and session_binding.installation_id = device.installation_id
     and session_binding.platform = device.platform
     and session_binding.revoked_at is null
    where device.organization_id = p_organization_id
      and device.id = p_device_id
      and device.user_id = p_actor_user_id
      and device.session_id = p_session_id
      and device.revoked_at is null
  ) then
    raise exception 'active signing device is not bound to this session'
      using errcode = '42501';
  end if;
  select membership.role into v_role_snapshot
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  v_scope_snapshot := private.effective_scopes_internal(p_actor_user_id, p_organization_id);
  update public.shift_handoffs handoff
  set status = 'submitted', submitted_version_id = p_handoff_version_id,
      signed_session_id = p_session_id, signed_device_id = p_device_id,
      signed_role_snapshot = v_role_snapshot,
      signed_scope_snapshot = v_scope_snapshot
  where handoff.organization_id = p_organization_id
    and handoff.id = v_handoff_id
  returning handoff.submitted_at into v_submitted_at;
  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'push',
    'handoff:' || v_handoff_id::text || ':submitted',
    jsonb_build_object(
      'handoff_id', v_handoff_id,
      'handoff_version_id', p_handoff_version_id,
      'state', 'submitted',
      'conversation_id', v_version.conversation_id,
      'notification_class', 'routine'
    )
  );
  v_response := jsonb_build_object(
    'handoff_id', v_handoff_id,
    'handoff_version_id', p_handoff_version_id,
    'status', 'submitted',
    'submitted_at', v_submitted_at,
    'session_id', p_session_id,
    'device_id', p_device_id,
    'role_snapshot', v_role_snapshot,
    'scope_snapshot', v_scope_snapshot,
    'source_state', 'current'
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/handoffs/:versionId/sign',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_acknowledge_handoff_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_version_id uuid,
  p_note text,
  p_device_id uuid,
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
  v_conversation_id uuid;
  v_author_user_id uuid;
  v_handoff_id uuid;
  v_acknowledged_at timestamptz;
  v_version public.handoff_versions%rowtype;
  v_role_snapshot text;
  v_scope_snapshot jsonb;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'handoff.acknowledge', false, 0,
    '/v2/handoffs/:versionId/acknowledge',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select version.* into v_version
  from public.handoff_versions version
  where version.organization_id = p_organization_id
    and version.id = p_handoff_version_id;
  if not found then
    raise exception 'handoff version was superseded or not submitted'
      using errcode = '40001';
  end if;
  v_handoff_id := v_version.handoff_id;
  perform 1
  from public.shift_handoffs handoff
  where handoff.organization_id = p_organization_id
    and handoff.id = v_handoff_id
  for update;
  select handoff.conversation_id, handoff.author_user_id
    into v_conversation_id, v_author_user_id
  from public.shift_handoffs handoff
  where handoff.organization_id = p_organization_id
    and handoff.id = v_handoff_id
    and handoff.submitted_version_id = p_handoff_version_id
    and handoff.status in ('submitted', 'closed');
  if not found
    or v_author_user_id = p_actor_user_id
    or not private.is_conversation_admin(p_organization_id, v_conversation_id) then
    raise exception 'incoming supervisor acknowledgement required' using errcode = '42501';
  end if;
  if not private.handoff_source_is_current_internal(
      p_organization_id, v_version.conversation_id,
      v_version.source_message_ids, v_version.source_fingerprint
    ) then
    raise exception 'handoff source messages were edited or deleted'
      using errcode = '40001';
  end if;
  if p_device_id is not null and not exists (
    select 1 from public.device_registrations device
    join private.session_installations session_binding
      on session_binding.session_id = device.session_id
     and session_binding.user_id = device.user_id
     and session_binding.installation_id = device.installation_id
     and session_binding.platform = device.platform
     and session_binding.revoked_at is null
    where device.organization_id = p_organization_id
      and device.id = p_device_id
      and device.user_id = p_actor_user_id
      and device.session_id = p_session_id
      and device.revoked_at is null
  ) then
    raise exception 'active acknowledgement device is not bound to this session'
      using errcode = '42501';
  end if;
  select membership.role into v_role_snapshot
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  v_scope_snapshot := private.effective_scopes_internal(p_actor_user_id, p_organization_id);
  insert into public.handoff_acknowledgements (
    organization_id, handoff_id, handoff_version_id, user_id, note,
    session_id, device_id, role_snapshot, scope_snapshot
  ) values (
    p_organization_id, v_handoff_id, p_handoff_version_id, p_actor_user_id, p_note,
    p_session_id, p_device_id, v_role_snapshot, v_scope_snapshot
  ) on conflict (organization_id, handoff_id, handoff_version_id, user_id) do nothing;
  select acknowledgement.acknowledged_at into v_acknowledged_at
  from public.handoff_acknowledgements acknowledgement
  where acknowledgement.organization_id = p_organization_id
    and acknowledgement.handoff_id = v_handoff_id
    and acknowledgement.handoff_version_id = p_handoff_version_id
    and acknowledgement.user_id = p_actor_user_id;
  update public.shift_handoffs handoff
  set status = 'closed'
  where handoff.organization_id = p_organization_id
    and handoff.id = v_handoff_id
    and handoff.status = 'submitted'
    and handoff.submitted_version_id = p_handoff_version_id;
  v_response := jsonb_build_object(
    'handoff_id', v_handoff_id,
    'handoff_version_id', p_handoff_version_id,
    'acknowledged_at', v_acknowledged_at,
    'status', 'closed',
    'session_id', p_session_id,
    'device_id', p_device_id,
    'role_snapshot', v_role_snapshot,
    'scope_snapshot', v_scope_snapshot,
    'source_state', 'current'
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/handoffs/:versionId/acknowledge',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_suspend_member_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
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
  v_generation bigint;
  v_actor_role text;
  v_target_role text;
  v_owned_conversation record;
  v_transferred_conversations integer := 0;
  v_removed_conversations integer := 0;
  v_revoked_devices integer := 0;
  v_revoked_sessions integer := 0;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'member.suspend', true, 900, '/v2/admin/members/:id/suspend',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_target_user_id = p_actor_user_id or not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'members.security', null
  ) then
    raise exception 'organization administrator permission required' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'suspension reason is required' using errcode = '22023';
  end if;

  perform 1 from public.organizations organization
  where organization.id = p_organization_id for update;
  select membership.role into v_actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  select membership.role into v_target_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_target_user_id
    and membership.status = 'active';
  if not found then raise exception 'active member not found' using errcode = 'P0002'; end if;
  if v_target_role in ('owner', 'admin') and v_actor_role <> 'owner' then
    raise exception 'only an organization owner may suspend an owner or administrator'
      using errcode = '42501';
  end if;

  perform set_config('app.member_offboarding_context', 'on', true);
  for v_owned_conversation in
    select conversation.id, conversation.history_policy
    from public.conversations conversation
    join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = p_target_user_id
     and member.status = 'active'
     and member.role = 'owner'
    where conversation.organization_id = p_organization_id
      and conversation.kind in ('group', 'incident')
    order by conversation.id
    for update of conversation
  loop
    insert into public.conversation_members (
      organization_id, conversation_id, user_id, role, status, can_post,
      joined_by_user_id, history_visible_from
    ) values (
      p_organization_id, v_owned_conversation.id, p_actor_user_id,
      'owner', 'active', true, p_actor_user_id,
      case when v_owned_conversation.history_policy = 'all' then null else now() end
    )
    on conflict (organization_id, conversation_id, user_id) do update
    set role = 'owner', status = 'active', can_post = true, left_at = null,
        history_visible_from = case
          when public.conversation_members.status = 'active'
            then public.conversation_members.history_visible_from
          when v_owned_conversation.history_policy = 'all' then null
          else now()
        end;
    v_transferred_conversations := v_transferred_conversations + 1;
  end loop;

  update public.conversation_members member
  set status = 'removed',
      role = case when member.role = 'owner' then 'member' else member.role end,
      can_post = false,
      left_at = now()
  where member.organization_id = p_organization_id
    and member.user_id = p_target_user_id
    and member.status = 'active';
  get diagnostics v_removed_conversations = row_count;

  select count(*) into v_revoked_devices
  from public.device_registrations device
  where device.organization_id = p_organization_id
    and device.user_id = p_target_user_id
    and device.revoked_at is null;
  update public.organization_memberships membership
  set status = 'suspended', status_change_reason = btrim(p_reason)
  where membership.organization_id = p_organization_id
    and membership.user_id = p_target_user_id
    and membership.status = 'active'
  returning membership.revocation_generation into v_generation;
  if not found then raise exception 'active member not found' using errcode = 'P0002'; end if;

  insert into private.session_revocations (
    organization_id, session_id, user_id, revoked_by_user_id, reason
  )
  select p_organization_id, session.id, p_target_user_id, p_actor_user_id, btrim(p_reason)
  from auth.sessions session
  where session.user_id = p_target_user_id
  on conflict (organization_id, session_id) do nothing;
  get diagnostics v_revoked_sessions = row_count;
  perform set_config('app.member_offboarding_context', 'off', true);
  v_response := jsonb_build_object(
    'user_id', p_target_user_id,
    'status', 'suspended',
    'revocation_generation', v_generation,
    'auth_revocation_pending', true,
    'conversation_ownership_transfers', v_transferred_conversations,
    'conversation_memberships_removed', v_removed_conversations,
    'devices_revoked', v_revoked_devices,
    'sessions_queued_for_revocation', v_revoked_sessions,
    'history_preserved', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/members/:id/suspend',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_revoke_session_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_session_id uuid,
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
  v_target_user_id uuid;
  v_sensitive_authorization jsonb;
  v_revoked_devices integer := 0;
  v_revoked_bindings integer := 0;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'session.revoke', false, 0, '/v2/auth/sessions/:id/revoke',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select session.user_id into v_target_user_id
  from auth.sessions session
  where session.id = p_target_session_id;
  if not found or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = v_target_user_id
  ) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_target_user_id <> p_actor_user_id then
    v_sensitive_authorization := private.authorize_bff_request_internal(
      p_actor_user_id, p_organization_id, p_session_id, 'session.revoke.other', true, 900
    );
    if not coalesce((v_sensitive_authorization ->> 'allowed')::boolean, false)
      or not private.actor_has_permission(
        p_actor_user_id, p_organization_id, 'sessions.revoke', null
      ) then
      raise exception 'organization administrator permission required' using errcode = '42501';
    end if;
  end if;
  insert into private.session_revocations (
    organization_id, session_id, user_id, revoked_by_user_id, reason
  ) values (
    p_organization_id, p_target_session_id, v_target_user_id, p_actor_user_id, btrim(p_reason)
  ) on conflict (organization_id, session_id) do nothing;
  update private.session_installations binding
  set revoked_at = coalesce(binding.revoked_at, now())
  where binding.session_id = p_target_session_id
    and binding.user_id = v_target_user_id
    and binding.revoked_at is null;
  get diagnostics v_revoked_bindings = row_count;
  -- Push authorization is cut synchronously. Auth session deletion remains an
  -- asynchronous cleanup step and cannot be the security boundary because its
  -- FK deliberately preserves device provenance with ON DELETE SET NULL.
  update public.device_registrations device
  set revoked_at = coalesce(device.revoked_at, now())
  where device.organization_id = p_organization_id
    and device.user_id = v_target_user_id
    and device.session_id = p_target_session_id
    and device.revoked_at is null;
  get diagnostics v_revoked_devices = row_count;
  perform private.enqueue_outbox_job_internal(
    p_organization_id,
    'session_revoke',
    'session:' || p_target_session_id::text,
    jsonb_build_object('session_id', p_target_session_id, 'user_id', v_target_user_id)
  );
  v_response := jsonb_build_object(
    'session_id', p_target_session_id,
    'revoked', true,
    'session_bindings_revoked', v_revoked_bindings,
    'devices_revoked', v_revoked_devices,
    'auth_revocation_pending', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/auth/sessions/:id/revoke',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_create_attachment_upload_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256_hex text,
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
  v_attachment_id uuid := gen_random_uuid();
  v_storage_path text;
  v_hour_bytes bigint;
  v_rate_key text;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.upload.create', false, 0, '/v2/attachments/grants',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_message_sender(p_organization_id, p_conversation_id, p_message_id) then
    raise exception 'attachment message sender permission required' using errcode = '42501';
  end if;
  if p_mime_type not in (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/ogg'
  ) then
    raise exception 'attachment MIME type is not permitted' using errcode = '22023';
  end if;
  if p_byte_size not between 1 and 26214400
    or coalesce(p_sha256_hex, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid attachment size or digest' using errcode = '22023';
  end if;
  v_rate_key := p_organization_id::text || ':' || p_actor_user_id::text;
  if not private.consume_rate_limit('upload-minute', v_rate_key, 10, 60) then
    raise exception 'attachment upload rate limit exceeded' using errcode = 'P0001';
  end if;
  select coalesce(sum(attachment.byte_size), 0) into v_hour_bytes
  from public.message_attachments attachment
  where attachment.organization_id = p_organization_id
    and attachment.created_by_user_id = p_actor_user_id
    and attachment.created_at >= now() - interval '1 hour';
  if v_hour_bytes + p_byte_size > 262144000 then
    raise exception 'attachment hourly byte quota exceeded' using errcode = 'P0001';
  end if;

  v_storage_path := p_organization_id::text || '/' || p_conversation_id::text || '/'
    || p_actor_user_id::text || '/' || v_attachment_id::text || '/upload';
  insert into public.message_attachments (
    id, organization_id, conversation_id, message_id, created_by_user_id,
    storage_path, file_name, mime_type, byte_size, sha256_hex
  ) values (
    v_attachment_id, p_organization_id, p_conversation_id, p_message_id,
    p_actor_user_id, v_storage_path, p_file_name, p_mime_type, p_byte_size,
    p_sha256_hex
  );
  v_response := jsonb_build_object(
    'attachment_id', v_attachment_id,
    'bucket_id', 'message-attachments',
    'storage_path', v_storage_path,
    'scan_status', 'pending'
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/attachments/grants',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_enqueue_translation_impl(
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
security definer
set search_path = ''
as $$
declare
  v_command jsonb;
  v_source_language text;
  v_source_body text;
  v_detection_state text;
  v_current_hash bytea;
  v_translation_id bigint;
  v_translation_status text;
  v_translation_source_hash bytea;
  v_translation_created boolean := false;
  v_job_id bigint;
  v_job_status text;
  v_job_payload jsonb;
  v_retried boolean := false;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'translation.enqueue', false, 0, '/v2/messages/:id/translations',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id) then
    raise exception 'conversation membership required' using errcode = '42501';
  end if;
  select message.detected_language, message.language_detection_state, message.body
    into v_source_language, v_detection_state, v_source_body
  from public.messages message
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
    and message.deleted_at is null
    and message.body is not null;
  if not found or v_detection_state <> 'completed'
    or v_source_language is null or v_source_language = p_target_language then
    raise exception 'translation language pair is not valid' using errcode = '22023';
  end if;
  v_current_hash := extensions.digest(convert_to(v_source_body, 'UTF8'), 'sha256');
  if not private.consume_rate_limit(
    'translation-minute', p_organization_id::text || ':' || p_actor_user_id::text, 30, 60
  ) then
    raise exception 'translation rate limit exceeded' using errcode = 'P0001';
  end if;

  insert into public.message_translations (
    organization_id, conversation_id, message_id, source_language,
    target_language, source_body_sha256
  ) values (
    p_organization_id, p_conversation_id, p_message_id, v_source_language,
    p_target_language, v_current_hash
  )
  on conflict (organization_id, conversation_id, message_id, target_language) do nothing
  returning id, status, source_body_sha256
    into v_translation_id, v_translation_status, v_translation_source_hash;
  v_translation_created := v_translation_id is not null;
  v_job_payload := jsonb_build_object(
    'organization_id', p_organization_id,
    'conversation_id', p_conversation_id,
    'message_id', p_message_id,
    'target_language', p_target_language,
    'requested_by_user_id', p_actor_user_id
  );

  if not v_translation_created then
    select translation.id, translation.status, translation.source_body_sha256
      into v_translation_id, v_translation_status, v_translation_source_hash
    from public.message_translations translation
    where translation.organization_id = p_organization_id
      and translation.conversation_id = p_conversation_id
      and translation.message_id = p_message_id
      and translation.target_language = p_target_language;
    if not found then
      raise exception 'translation state changed during enqueue'
        using errcode = '40001';
    end if;
    if v_translation_source_hash is distinct from v_current_hash then
      raise exception 'translation source changed; refresh before retrying'
        using errcode = '55000';
    end if;
    if v_translation_status in ('failed', 'blocked') then
      -- Workers acquire the durable job before the translation projection.
      -- Match that order here so a retry or duplicate can never form the
      -- inverse translation -> outbox lock cycle.
      select job.id, job.status into v_job_id, v_job_status
      from private.outbox_jobs job
      where job.topic = 'translation'
        and job.dedupe_key = 'translation:' || v_translation_id::text
        and job.organization_id = p_organization_id
      for update;

      select translation.status, translation.source_body_sha256
        into v_translation_status, v_translation_source_hash
      from public.message_translations translation
      where translation.id = v_translation_id
        and translation.organization_id = p_organization_id
        and translation.conversation_id = p_conversation_id
        and translation.message_id = p_message_id
        and translation.target_language = p_target_language
      for update;
      if not found then
        raise exception 'translation state changed during retry'
          using errcode = '40001';
      end if;
      if v_translation_source_hash is distinct from v_current_hash then
        raise exception 'translation source changed; refresh before retrying'
          using errcode = '55000';
      end if;
    end if;
    if v_translation_status in ('failed', 'blocked') then
      -- A terminal retry is a new provider-egress attempt, so tenant policy is
      -- reauthorized before either the public projection or durable job moves.
      if not private.ai_use_case_approved(
        p_organization_id, 'translation', null
      ) then
        raise exception 'tenant-approved translation policy required for retry'
          using errcode = '42501';
      end if;
      if v_job_id is not null
        and v_job_status not in ('completed', 'failed', 'dead_letter') then
        raise exception 'translation retry job is not in a terminal state'
          using errcode = '55000';
      end if;
      update public.message_translations translation
      set status = 'queued',
          translated_body = null,
          provider = null,
          model = null,
          confidence = null,
          reviewed_by_user_id = null,
          reviewed_at = null,
          failure_code = null
      where translation.id = v_translation_id
        and translation.status in ('failed', 'blocked')
      returning translation.status into v_translation_status;
      if not found then
        raise exception 'terminal translation changed during retry'
          using errcode = '40001';
      end if;
      v_retried := true;
      if v_job_id is not null then
        update private.outbox_jobs job
        set payload = v_job_payload,
            status = 'pending',
            attempts = 0,
            available_at = now(),
            claimed_by = null,
            claimed_until = null,
            completed_at = null,
            last_error_code = null,
            updated_at = now()
        where job.id = v_job_id
          and job.status in ('completed', 'failed', 'dead_letter');
        if not found then
          raise exception 'translation retry job changed state'
            using errcode = '40001';
        end if;
      end if;
    end if;
  end if;

  if v_retried and v_job_id is null then
    v_job_id := private.enqueue_outbox_job_internal(
      p_organization_id,
      'translation',
      'translation:' || v_translation_id::text,
      v_job_payload
    );
  elsif v_translation_created then
    v_job_id := private.enqueue_outbox_job_internal(
      p_organization_id,
      'translation',
      'translation:' || v_translation_id::text,
      v_job_payload
    );
  elsif v_translation_status in ('queued', 'processing') then
    -- An active duplicate is read-only when its durable job exists. This is
    -- both cheaper and preserves the worker's outbox -> translation lock order.
    select job.id, job.status into v_job_id, v_job_status
    from private.outbox_jobs job
    where job.topic = 'translation'
      and job.dedupe_key = 'translation:' || v_translation_id::text
      and job.organization_id = p_organization_id;
    if v_job_id is null then
      v_job_id := private.enqueue_outbox_job_internal(
        p_organization_id,
        'translation',
        'translation:' || v_translation_id::text,
        v_job_payload
      );
    elsif v_job_status not in ('pending', 'processing', 'failed') then
      -- The worker may have completed atomically after the projection was read
      -- above but before this job lookup. Reconcile that benign race instead
      -- of returning a false invariant failure to a duplicate client.
      select translation.status, translation.source_body_sha256
        into v_translation_status, v_translation_source_hash
      from public.message_translations translation
      where translation.id = v_translation_id
        and translation.organization_id = p_organization_id
        and translation.conversation_id = p_conversation_id
        and translation.message_id = p_message_id
        and translation.target_language = p_target_language;
      if not found
        or v_translation_source_hash is distinct from v_current_hash
        or v_translation_status not in ('completed', 'failed', 'blocked') then
        raise exception 'active translation has no active durable job'
          using errcode = '55000';
      end if;
    end if;
  end if;
  v_response := jsonb_build_object(
    'translation_id', v_translation_id,
    'status', v_translation_status,
    'retried', v_retried
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/translations',
    p_idempotency_key, p_request_sha256, v_response, 202
  );
end;
$$;

create or replace function private.bff_resolve_invite_principal_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_destination_type text,
  p_destination text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_destination text := case
    when p_destination_type = 'email' then lower(btrim(coalesce(p_destination, '')))
    else btrim(coalesce(p_destination, ''))
  end;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id,
    p_organization_id,
    p_session_id,
    'invite.resolve_principal',
    true,
    900
  );

  if not private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'invites.manage', null
  ) then
    raise exception 'organization administrator required' using errcode = '42501';
  end if;
  if p_destination_type not in ('email', 'phone')
    or (p_destination_type = 'email'
      and v_destination !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or (p_destination_type = 'phone'
      and v_destination !~ '^\+[1-9][0-9]{7,14}$') then
    raise exception 'invalid invitation destination' using errcode = '22023';
  end if;

  select auth_user.id into v_user_id
  from auth.users auth_user
  where ((
      p_destination_type = 'email'
      and lower(auth_user.email) = v_destination
    ) or (
      p_destination_type = 'phone'
      and auth_user.phone = v_destination
    ))
    and auth_user.deleted_at is null
  order by auth_user.created_at, auth_user.id
  limit 1;

  return jsonb_build_object(
    'authorized', true,
    'user_id', to_jsonb(v_user_id),
    'destination_type', p_destination_type
  );
end;
$$;

create or replace function private.bff_issue_organization_invite_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_destination_type text,
  p_destination text,
  p_invited_user_id uuid,
  p_employee_code text,
  p_activation_mode text,
  p_role text,
  p_expires_in_seconds integer,
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
  v_actor_role text;
  v_invite_id uuid;
  v_raw_token text;
  v_destination text := case
    when p_destination_type = 'email' then lower(btrim(coalesce(p_destination, '')))
    else btrim(coalesce(p_destination, ''))
  end;
  v_employee_code_hash bytea;
  v_expires_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'invite.issue', true, 900, '/v2/admin/invitations',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select membership.role into v_actor_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  if not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'invites.manage', null
    )
    or (p_role = 'admin' and v_actor_role <> 'owner')
    or p_role not in ('admin', 'manager', 'member') then
    raise exception 'invitation role is not permitted' using errcode = '42501';
  end if;
  if p_destination_type is null
    or p_destination_type not in ('email', 'phone')
    or (p_destination_type = 'email'
      and v_destination !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    or (p_destination_type = 'phone'
      and v_destination !~ '^\+[1-9][0-9]{7,14}$')
    or p_activation_mode is null
    or p_activation_mode not in ('otp', 'manual')
    or (p_employee_code is not null
      and p_employee_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$')
    or (p_activation_mode = 'manual' and p_employee_code is null)
    or p_expires_in_seconds not between 900 and 2592000 then
    raise exception 'invalid invitation destination, activation, employee code, or expiry'
      using errcode = '22023';
  end if;
  v_employee_code_hash := case when p_employee_code is null then null
    else extensions.digest(convert_to(p_employee_code, 'UTF8'), 'sha256') end;
  if p_invited_user_id is null or not exists (
    select 1
    from auth.users auth_user
    where auth_user.id = p_invited_user_id
      and auth_user.deleted_at is null
      and case p_destination_type
        when 'email' then lower(auth_user.email) = v_destination
        when 'phone' then auth_user.phone = v_destination
        else false
      end
  ) then
    raise exception 'invitation principal does not match destination' using errcode = '22023';
  end if;
  if exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_invited_user_id
  ) then
    raise exception 'invitation principal already belongs to organization' using errcode = '23505';
  end if;
  if not private.consume_rate_limit(
    'invite-hour', p_organization_id::text || ':' || p_actor_user_id::text, 20, 3600
  ) then
    raise exception 'invitation rate limit exceeded' using errcode = 'P0001';
  end if;

  update public.organization_invites invitation
  set revoked_at = now()
  where invitation.organization_id = p_organization_id
    and (
      (invitation.destination_type = p_destination_type
        and invitation.destination = v_destination::extensions.citext)
      or invitation.invited_user_id = p_invited_user_id
    )
    and invitation.revoked_at is null
    and invitation.accepted_at is null;
  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_expires_at := now() + make_interval(secs => p_expires_in_seconds);
  insert into public.organization_invites (
    organization_id, email, destination_type, destination, invited_user_id,
    employee_code_hash, activation_mode, token_hash, role, expires_at,
    created_by_user_id
  ) values (
    p_organization_id,
    case when p_destination_type = 'email'
      then v_destination::extensions.citext else null end,
    p_destination_type,
    v_destination::extensions.citext,
    p_invited_user_id,
    v_employee_code_hash,
    p_activation_mode,
    extensions.digest(convert_to(v_raw_token, 'UTF8'), 'sha256'),
    p_role,
    v_expires_at,
    p_actor_user_id
  ) returning id into v_invite_id;
  v_response := jsonb_build_object(
    'invite_id', v_invite_id,
    'token', v_raw_token,
    'expires_at', v_expires_at,
    'single_use', true,
    'destination_type', p_destination_type,
    'activation_mode', p_activation_mode,
    'channel_configured', p_destination_type = 'email',
    'token_available', true
  );
  -- The raw invitation token is returned exactly once and is never persisted,
  -- including in the generic idempotency response cache.
  perform private.complete_idempotency_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/invitations',
    p_idempotency_key, p_request_sha256, 201,
    jsonb_build_object(
      'invite_id', v_invite_id,
      'expires_at', v_expires_at,
      'single_use', true,
      'destination_type', p_destination_type,
      'activation_mode', p_activation_mode,
      'channel_configured', p_destination_type = 'email',
      'token_available', false
    )
  );
  perform private.clear_bff_actor_context_internal();
  return v_response;
end;
$$;

create or replace function private.bff_authorize_invite_otp_impl(
  p_invite_token text,
  p_destination_type text,
  p_destination text,
  p_employee_code text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_destination text := case
    when p_destination_type = 'email' then lower(btrim(coalesce(p_destination, '')))
    else btrim(coalesce(p_destination, ''))
  end;
  v_token_key text := coalesce(p_invite_token, 'invalid');
  v_ip_key text := coalesce(p_ip_hash, 'invalid');
  v_installation_key text := coalesce(p_installation_hash, 'invalid');
  v_token_allowed boolean;
  v_destination_allowed boolean;
  v_ip_allowed boolean;
  v_installation_allowed boolean;
  v_invite_valid boolean := false;
  v_channel_configured boolean := p_destination_type = 'email';
  v_token_limit integer;
  v_destination_limit integer;
  v_ip_limit integer;
  v_installation_limit integer;
begin
  perform private.require_service_role();
  if p_purpose not in ('request', 'verify') then
    raise exception 'invalid OTP authorization purpose' using errcode = '22023';
  end if;
  v_token_limit := case p_purpose when 'request' then 5 else 10 end;
  v_destination_limit := case p_purpose when 'request' then 5 else 10 end;
  v_ip_limit := case p_purpose when 'request' then 20 else 30 end;
  v_installation_limit := case p_purpose when 'request' then 10 else 20 end;
  -- Consume every bucket before checking eligibility so invalid tokens do not
  -- create a cheaper timing or abuse path than valid invitations. Request and
  -- verification attempts use independent budgets so resends cannot exhaust
  -- the code-entry budget (or vice versa).
  v_token_allowed := private.consume_rate_limit(
    'invite-otp-' || p_purpose || '-token-15m', v_token_key, v_token_limit, 900
  );
  v_destination_allowed := private.consume_rate_limit(
    'invite-otp-' || p_purpose || '-destination-15m',
    coalesce(p_destination_type, 'invalid') || ':' || v_destination,
    v_destination_limit, 900
  );
  v_ip_allowed := private.consume_rate_limit(
    'invite-otp-' || p_purpose || '-ip-15m', v_ip_key, v_ip_limit, 900
  );
  v_installation_allowed := private.consume_rate_limit(
    'invite-otp-' || p_purpose || '-installation-15m',
    v_installation_key, v_installation_limit, 900
  );

  if p_invite_token ~ '^[0-9a-f]{64}$'
    and p_destination_type in ('email', 'phone')
    and (
      (p_destination_type = 'email'
        and v_destination ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
      or (p_destination_type = 'phone'
        and v_destination ~ '^\+[1-9][0-9]{7,14}$')
    )
    and (p_employee_code is null
      or p_employee_code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$')
    and coalesce(p_ip_hash, '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_installation_hash, '') ~ '^[0-9a-f]{64}$' then
    select exists (
      select 1
      from public.organization_invites invitation
      join auth.users invited_user
        on invited_user.id = invitation.invited_user_id
       and invited_user.deleted_at is null
      where invitation.token_hash = extensions.digest(convert_to(p_invite_token, 'UTF8'), 'sha256')
        and invitation.activation_mode in ('otp', 'manual')
        and invitation.destination_type = p_destination_type
        and invitation.destination = v_destination::extensions.citext
        and case p_destination_type
          when 'email' then lower(invited_user.email) = v_destination
            and invited_user.email_confirmed_at is not null
          when 'phone' then invited_user.phone = v_destination
            and invited_user.phone_confirmed_at is not null
          else false
        end
        and (
          (invitation.employee_code_hash is null and p_employee_code is null)
          or (
            invitation.employee_code_hash is not null
            and p_employee_code is not null
            and invitation.employee_code_hash = extensions.digest(
              convert_to(p_employee_code, 'UTF8'), 'sha256'
            )
          )
        )
        and invitation.revoked_at is null
        and invitation.accepted_at is null
        and invitation.use_count = 0
        and invitation.max_uses = 1
        and invitation.expires_at > now()
    ) into v_invite_valid;
  end if;

  return jsonb_build_object(
    'allowed', v_invite_valid and v_token_allowed and v_destination_allowed
      and v_ip_allowed and v_installation_allowed,
    'channel_configured', v_channel_configured,
    'retry_after_seconds', case
      when not v_token_allowed or not v_destination_allowed
        or not v_ip_allowed or not v_installation_allowed then 900
      when not v_invite_valid then 60
      else 0
    end
  );
end;
$$;

create or replace function private.bff_authorize_member_otp_impl(
  p_destination_type text,
  p_destination text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_destination text := case
    when p_destination_type = 'email' then lower(btrim(coalesce(p_destination, '')))
    else btrim(coalesce(p_destination, ''))
  end;
  v_ip_key text := coalesce(p_ip_hash, 'invalid');
  v_installation_key text := coalesce(p_installation_hash, 'invalid');
  v_destination_allowed boolean;
  v_ip_allowed boolean;
  v_installation_allowed boolean;
  v_member_valid boolean := false;
  v_channel_configured boolean := p_destination_type = 'email';
  v_destination_limit integer;
  v_ip_limit integer;
  v_installation_limit integer;
begin
  perform private.require_service_role();
  if p_purpose not in ('request', 'verify') then
    raise exception 'invalid OTP authorization purpose' using errcode = '22023';
  end if;
  v_destination_limit := case p_purpose when 'request' then 5 else 10 end;
  v_ip_limit := case p_purpose when 'request' then 20 else 30 end;
  v_installation_limit := case p_purpose when 'request' then 10 else 20 end;
  -- Consume both independent buckets before eligibility checks so unknown,
  -- suspended, and active addresses have the same abuse and timing envelope.
  -- Request and verification attempts intentionally do not share counters.
  v_destination_allowed := private.consume_rate_limit(
    'member-otp-' || p_purpose || '-destination-15m',
    coalesce(p_destination_type, 'invalid') || ':' || v_destination,
    v_destination_limit, 900
  );
  v_ip_allowed := private.consume_rate_limit(
    'member-otp-' || p_purpose || '-ip-15m', v_ip_key, v_ip_limit, 900
  );
  v_installation_allowed := private.consume_rate_limit(
    'member-otp-' || p_purpose || '-installation-15m',
    v_installation_key, v_installation_limit, 900
  );
  if p_destination_type in ('email', 'phone')
    and (
      (p_destination_type = 'email'
        and v_destination ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
      or (p_destination_type = 'phone'
        and v_destination ~ '^\+[1-9][0-9]{7,14}$')
    )
    and coalesce(p_ip_hash, '') ~ '^[0-9a-f]{64}$'
    and coalesce(p_installation_hash, '') ~ '^[0-9a-f]{64}$' then
    select exists (
      select 1
      from auth.users auth_user
      join public.organization_memberships membership
        on membership.user_id = auth_user.id
       and membership.status = 'active'
      where auth_user.deleted_at is null
        and case p_destination_type
          when 'email' then auth_user.email_confirmed_at is not null
            and lower(auth_user.email) = v_destination
          when 'phone' then auth_user.phone_confirmed_at is not null
            and auth_user.phone = v_destination
          else false
        end
    ) into v_member_valid;
  end if;
  return jsonb_build_object(
    'allowed', v_member_valid and v_destination_allowed
      and v_ip_allowed and v_installation_allowed,
    'channel_configured', v_channel_configured,
    'retry_after_seconds', case
      when not v_destination_allowed or not v_ip_allowed
        or not v_installation_allowed then 900
      when not v_member_valid then 60
      else 0
    end
  );
end;
$$;

create or replace function private.redeem_organization_invite_impl(
  p_token text,
  p_employee_code text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_email text;
  v_phone text;
  v_email_verified boolean;
  v_phone_verified boolean;
  v_invitation public.organization_invites%rowtype;
begin
  if v_user_id is null
    or coalesce(p_token, '') !~ '^[0-9a-f]{64}$'
    or (p_employee_code is not null
      and p_employee_code !~ '^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$') then
    raise exception 'valid signed-in invitation redemption required' using errcode = '42501';
  end if;
  select lower(auth_user.email), auth_user.phone,
    auth_user.email_confirmed_at is not null,
    auth_user.phone_confirmed_at is not null
    into v_email, v_phone, v_email_verified, v_phone_verified
  from auth.users auth_user
  where auth_user.id = v_user_id
    and auth_user.deleted_at is null;
  if not found then
    raise exception 'verified invitation identity required' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invites invitation
  where invitation.token_hash = extensions.digest(convert_to(p_token, 'UTF8'), 'sha256')
  for update;
  if not found
    or v_invitation.invited_user_id is distinct from v_user_id
    or not coalesce(case v_invitation.destination_type
      when 'email' then v_email_verified
        and v_invitation.destination = v_email::extensions.citext
      when 'phone' then v_phone_verified
        and v_invitation.destination = v_phone::extensions.citext
      else false
    end, false)
    or not (
      (v_invitation.employee_code_hash is null and p_employee_code is null)
      or (
        v_invitation.employee_code_hash is not null
        and p_employee_code is not null
        and v_invitation.employee_code_hash = extensions.digest(
          convert_to(p_employee_code, 'UTF8'), 'sha256'
        )
      )
    )
    or v_invitation.revoked_at is not null
    or v_invitation.accepted_at is not null
    or v_invitation.use_count <> 0
    or v_invitation.max_uses <> 1
    or v_invitation.expires_at <= now() then
    raise exception 'invitation is invalid or expired' using errcode = '42501';
  end if;

  insert into public.organization_memberships (
    organization_id, user_id, role, status, invited_by_user_id
  ) values (
    v_invitation.organization_id, v_user_id, v_invitation.role, 'active',
    v_invitation.created_by_user_id
  );
  perform set_config('app.invite_redemption_context', 'on', true);
  update public.organization_invites invitation
  set use_count = 1, accepted_by_user_id = v_user_id, accepted_at = now()
  where invitation.id = v_invitation.id;
  return jsonb_build_object(
    'organization_id', v_invitation.organization_id,
    'user_id', v_user_id,
    'role', v_invitation.role,
    'redeemed', true
  );
end;
$$;

create or replace function private.claim_outbox_jobs_internal(
  p_worker_id uuid,
  p_limit integer,
  p_lease_seconds integer,
  p_topic text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_jobs jsonb;
begin
  if p_worker_id is null or p_limit not between 1 and 100
    or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid outbox claim parameters' using errcode = '22023';
  end if;
  if p_topic is not null and p_topic not in (
    'push', 'realtime_control', 'translation', 'language_detection', 'summary',
    'storage_scan', 'storage_purge', 'session_revoke', 'retention', 'moderation',
    'dynamic_group_sync'
  ) then
    raise exception 'invalid outbox topic' using errcode = '22023';
  end if;

  with candidates as (
    select job.id
    from private.outbox_jobs job
    where (p_topic is null or job.topic = p_topic)
      and (
        (job.status in ('pending', 'failed') and job.available_at <= now())
        or (job.status = 'processing' and job.claimed_until <= now())
      )
    order by job.available_at, job.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.outbox_jobs job
    set status = 'processing',
        attempts = job.attempts + 1,
        claimed_by = p_worker_id,
        claimed_until = now() + make_interval(secs => p_lease_seconds),
        last_error_code = null,
        updated_at = now()
    from candidates
    where job.id = candidates.id
    returning job.id, job.organization_id, job.topic, job.payload, job.attempts
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', claimed.id,
        'organization_id', claimed.organization_id,
        'topic', claimed.topic,
        'payload', claimed.payload,
        'attempts', claimed.attempts
      ) order by claimed.id
    ),
    '[]'::jsonb
  ) into v_jobs
  from claimed;
  return jsonb_build_object('jobs', v_jobs);
end;
$$;

create or replace function private.bff_claim_outbox_jobs_impl(
  p_worker_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  return private.claim_outbox_jobs_internal(p_worker_id, p_limit, p_lease_seconds, null);
end;
$$;

create or replace function private.bff_claim_translation_jobs_impl(
  p_worker_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  return private.claim_outbox_jobs_internal(p_worker_id, p_limit, p_lease_seconds, 'translation');
end;
$$;

create or replace function private.bff_claim_language_detection_jobs_impl(
  p_worker_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  return private.claim_outbox_jobs_internal(
    p_worker_id, p_limit, p_lease_seconds, 'language_detection'
  );
end;
$$;

create or replace function private.complete_outbox_job_internal(
  p_worker_id uuid,
  p_job_id bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update private.outbox_jobs job
  set status = 'completed',
      claimed_by = null,
      claimed_until = null,
      completed_at = now(),
      updated_at = now()
  where job.id = p_job_id
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now();
  if not found then
    raise exception 'active outbox lease not found' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.bff_complete_outbox_job_impl(
  p_worker_id uuid,
  p_job_id bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
end;
$$;

create or replace function private.bff_fail_outbox_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_error_code text,
  p_retry_seconds integer
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_service_role();
  if char_length(coalesce(p_error_code, '')) not between 1 and 120
    or p_retry_seconds not between 1 and 86400 then
    raise exception 'invalid outbox failure parameters' using errcode = '22023';
  end if;
  update private.outbox_jobs job
  set status = case when job.attempts >= 10 then 'dead_letter' else 'failed' end,
      available_at = now() + make_interval(secs => p_retry_seconds),
      claimed_by = null,
      claimed_until = null,
      last_error_code = p_error_code,
      updated_at = now()
  where job.id = p_job_id
    and job.status = 'processing'
    and job.claimed_by = p_worker_id;
  if not found then
    raise exception 'outbox lease not found' using errcode = '55000';
  end if;
end;
$$;

create or replace function private.bff_claim_summary_jobs_impl(
  p_worker_id uuid, p_limit integer, p_lease_seconds integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_claim jsonb;
begin
  perform private.require_service_role();
  v_claim := private.claim_outbox_jobs_internal(p_worker_id, p_limit, p_lease_seconds, 'summary');
  update public.conversation_summaries summary
  set status = 'processing', updated_at = now()
  where summary.id in (
    select (job -> 'payload' ->> 'summary_id')::uuid
    from jsonb_array_elements(v_claim -> 'jobs') job
  ) and summary.status = 'queued';
  return v_claim;
end;
$$;

create or replace function private.bff_resolve_summary_job_sources_impl(
  p_worker_id uuid, p_job_id bigint, p_provider text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype; v_summary public.conversation_summaries%rowtype;
  v_messages jsonb; v_count integer; v_fingerprint bytea; v_invalid boolean;
  v_policy_version integer; v_route_policy text;
begin
  perform private.require_service_role();
  if coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$' then
    raise exception 'valid summary provider required' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'summary'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now() for update;
  if not found then raise exception 'active summary lease required' using errcode = '55000'; end if;
  select * into v_summary from public.conversation_summaries summary
  where summary.organization_id = v_job.organization_id
    and summary.id = (v_job.payload ->> 'summary_id')::uuid
    and summary.status in ('queued', 'processing') for update;
  if not found then raise exception 'queued summary version not found' using errcode = '55000'; end if;
  select
    count(*),
    coalesce(bool_or(
      message.deleted_at is not null
      or message.available_at > now()
      or visibility.user_id is not null
      or exists (
        select 1 from public.conversation_members requester_membership
        where requester_membership.organization_id = message.organization_id
          and requester_membership.conversation_id = message.conversation_id
          and requester_membership.user_id = v_summary.requested_by_user_id
          and requester_membership.history_visible_from is not null
          and message.created_at < requester_membership.history_visible_from
      )
    ), true),
    extensions.digest(convert_to(string_agg(
      message.id::text || ':' || encode(extensions.digest(convert_to(
        coalesce(message.body, '') || ':' || message.metadata::text || ':'
        || coalesce(message.edited_at::text, ''), 'UTF8'
      ), 'sha256'), 'hex'), ',' order by message.id
    ), 'UTF8'), 'sha256'),
    coalesce(jsonb_agg(jsonb_build_object(
      'message_id', message.id,
      'sender_user_id', message.sender_user_id,
      'body', message.body,
      'detected_language', message.detected_language,
      'created_at', message.created_at,
      'edited_at', message.edited_at
    ) order by message.id), '[]'::jsonb)
  into v_count, v_invalid, v_fingerprint, v_messages
  from public.messages message
  left join public.message_user_visibility visibility
    on visibility.organization_id = message.organization_id
   and visibility.conversation_id = message.conversation_id
   and visibility.message_id = message.id
   and visibility.user_id = v_summary.requested_by_user_id
  where message.organization_id = v_summary.organization_id
    and message.conversation_id = v_summary.conversation_id
    and message.id = any(v_summary.source_message_ids);
  if not exists (
      select 1 from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      where member.organization_id = v_summary.organization_id
        and member.conversation_id = v_summary.conversation_id
        and member.user_id = v_summary.requested_by_user_id
        and member.status = 'active'
    )
    or v_count <> cardinality(v_summary.source_message_ids)
    or v_invalid
    or v_fingerprint <> v_summary.source_fingerprint
    or not private.ai_use_case_approved(v_summary.organization_id, 'summary', lower(p_provider)) then
    perform set_config('app.summary_stale_context', 'on', true);
    update public.conversation_summaries summary
    set status = 'stale', primary_topic = null, summary_body = null,
        key_topics = null, decisions = null, action_items = null, ambiguities = null,
        output_fingerprint = null, processor_type = null, provider = null, model = null,
        processor_provenance = '{}'::jsonb,
        failure_code = case when not private.ai_use_case_approved(
          v_summary.organization_id, 'summary', lower(p_provider)
        ) then 'tenant_ai_policy_denied' else 'requester_or_source_unauthorized' end,
        reviewed_by_user_id = null, reviewed_at = null, review_note = null,
        updated_at = now()
    where summary.id = v_summary.id;
    perform set_config('app.summary_stale_context', 'off', true);
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'authorized', false, 'summary_id', v_summary.id,
      'reason', case when not private.ai_use_case_approved(
        v_summary.organization_id, 'summary', lower(p_provider)
      ) then 'tenant_ai_policy_denied' else 'requester_or_source_unauthorized' end,
      'provider_egress_allowed', false
    );
  end if;
  select policy.policy_version, policy.route_policy
    into v_policy_version, v_route_policy
  from public.organization_ai_policies policy
  where policy.organization_id = v_summary.organization_id
    and policy.enabled and policy.revoked_at is null;
  update private.outbox_jobs job
  set payload = job.payload || jsonb_build_object(
        'resolved_provider', lower(p_provider),
        'ai_policy_version', v_policy_version,
        'source_resolved_at', now()
      ),
      updated_at = now()
  where job.id = p_job_id;
  return jsonb_build_object(
    'authorized', true,
    'summary_id', v_summary.id,
    'organization_id', v_summary.organization_id,
    'conversation_id', v_summary.conversation_id,
    'requested_by_user_id', v_summary.requested_by_user_id,
    'language_code', v_summary.language_code,
    'source_fingerprint', encode(v_summary.source_fingerprint, 'hex'),
    'messages', v_messages,
    'provider_egress_allowed', true,
    'processor_id', lower(p_provider),
    'ai_policy_version', v_policy_version,
    'route_policy', v_route_policy,
    'provider_route_policy', 'zero_retention_only',
    'required_output', jsonb_build_object(
      'primary_topic', 'text <= 240 chars',
      'summary_body', 'text <= 30000 chars',
      'key_topics', 'text[] <= 50',
      'decisions', 'json array <= 100',
      'action_items', 'json array <= 100',
      'ambiguities', 'text[] <= 50'
    )
  );
end;
$$;

create or replace function private.bff_complete_summary_job_impl(
  p_worker_id uuid, p_job_id bigint, p_source_fingerprint text,
  p_primary_topic text, p_summary_body text,
  p_key_topics text[], p_decisions jsonb, p_action_items jsonb, p_ambiguities text[],
  p_provider text, p_model text, p_provenance jsonb
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype; v_summary public.conversation_summaries%rowtype;
  v_current_fingerprint bytea; v_count integer; v_invalid boolean;
begin
  perform private.require_service_role();
  if coalesce(p_source_fingerprint, '') !~ '^[0-9a-f]{64}$'
    or char_length(btrim(coalesce(p_primary_topic, ''))) not between 1 and 240
    or char_length(btrim(coalesce(p_summary_body, ''))) not between 1 and 30000
    or not private.bounded_text_array(coalesce(p_key_topics, array[]::text[]), 50, 1, 500)
    or not private.bounded_text_array(coalesce(p_ambiguities, array[]::text[]), 50, 1, 2000)
    or jsonb_typeof(coalesce(p_decisions, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_decisions, '[]'::jsonb)) > 100
    or jsonb_typeof(coalesce(p_action_items, '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_action_items, '[]'::jsonb)) > 100
    or coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$'
    or char_length(coalesce(p_model, '')) not between 2 and 200
    or jsonb_typeof(coalesce(p_provenance, '{}'::jsonb)) <> 'object'
    or octet_length(coalesce(p_provenance, '{}'::jsonb)::text) > 16384 then
    raise exception 'invalid summary completion payload' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'summary'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now() for update;
  if not found then raise exception 'active summary lease required' using errcode = '55000'; end if;
  select * into v_summary from public.conversation_summaries summary
  where summary.organization_id = v_job.organization_id
    and summary.id = (v_job.payload ->> 'summary_id')::uuid
    and summary.status in ('queued', 'processing') for update;
  if not found then raise exception 'queued summary version not found' using errcode = '55000'; end if;
  select count(*),
    coalesce(bool_or(message.deleted_at is not null or visibility.user_id is not null), true),
    extensions.digest(convert_to(string_agg(
      message.id::text || ':' || encode(extensions.digest(convert_to(
        coalesce(message.body, '') || ':' || message.metadata::text || ':'
        || coalesce(message.edited_at::text, ''), 'UTF8'
      ), 'sha256'), 'hex'), ',' order by message.id
    ), 'UTF8'), 'sha256')
    into v_count, v_invalid, v_current_fingerprint
  from public.messages message
  left join public.message_user_visibility visibility
    on visibility.organization_id = message.organization_id
   and visibility.conversation_id = message.conversation_id
   and visibility.message_id = message.id
   and visibility.user_id = v_summary.requested_by_user_id
  where message.organization_id = v_summary.organization_id
    and message.conversation_id = v_summary.conversation_id
    and message.id = any(v_summary.source_message_ids);
  if not exists (
      select 1
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      where member.organization_id = v_summary.organization_id
        and member.conversation_id = v_summary.conversation_id
        and member.user_id = v_summary.requested_by_user_id
        and member.status = 'active'
    )
    or v_count <> cardinality(v_summary.source_message_ids)
    or v_invalid
    or v_current_fingerprint <> v_summary.source_fingerprint
    or v_current_fingerprint <> decode(p_source_fingerprint, 'hex')
    or coalesce(v_job.payload ->> 'resolved_provider', '') <> lower(p_provider)
    or not private.ai_use_case_approved(
      v_summary.organization_id, 'summary', lower(p_provider)
    )
    or not exists (
      select 1 from public.organization_ai_policies policy
      where policy.organization_id = v_summary.organization_id
        and policy.policy_version = (v_job.payload ->> 'ai_policy_version')::integer
        and policy.route_policy = 'approved_zero_retention'
    ) then
    perform set_config('app.summary_stale_context', 'on', true);
    update public.conversation_summaries summary
    set status = 'stale', primary_topic = null, summary_body = null,
        key_topics = null, decisions = null, action_items = null, ambiguities = null,
        output_fingerprint = null, processor_type = null, provider = null,
        model = null, processor_provenance = '{}'::jsonb,
        failure_code = case
          when not private.ai_use_case_approved(
            v_summary.organization_id, 'summary', lower(p_provider)
          ) then 'tenant_ai_policy_denied'
          else 'requester_or_source_unauthorized'
        end,
        reviewed_by_user_id = null, reviewed_at = null, review_note = null,
        updated_at = now()
    where summary.id = v_summary.id;
    perform set_config('app.summary_stale_context', 'off', true);
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'summary_id', v_summary.id, 'status', 'stale',
      'reason', case
        when not private.ai_use_case_approved(
          v_summary.organization_id, 'summary', lower(p_provider)
        ) then 'tenant_ai_policy_denied'
        else 'requester_or_source_unauthorized'
      end,
      'published', false, 'originals_unaffected', true
    );
  end if;
  update public.conversation_summaries summary
  set status = 'draft', primary_topic = btrim(p_primary_topic),
      summary_body = btrim(p_summary_body),
      key_topics = coalesce(p_key_topics, array[]::text[]),
      decisions = coalesce(p_decisions, '[]'::jsonb),
      action_items = coalesce(p_action_items, '[]'::jsonb),
      ambiguities = coalesce(p_ambiguities, array[]::text[]),
      output_fingerprint = extensions.digest(convert_to(
        encode(v_summary.source_fingerprint, 'hex') || ':' || btrim(p_primary_topic)
        || ':' || btrim(p_summary_body)
        || ':' || to_jsonb(coalesce(p_key_topics, array[]::text[]))::text
        || ':' || coalesce(p_decisions, '[]'::jsonb)::text
        || ':' || coalesce(p_action_items, '[]'::jsonb)::text
        || ':' || to_jsonb(coalesce(p_ambiguities, array[]::text[]))::text, 'UTF8'
      ), 'sha256'),
      processor_type = 'ai', provider = lower(p_provider), model = p_model,
      processor_provenance = coalesce(p_provenance, '{}'::jsonb),
      failure_code = null, updated_at = now()
  where summary.id = v_summary.id;
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
  return jsonb_build_object(
    'summary_id', v_summary.id, 'status', 'draft',
    'primary_topic', btrim(p_primary_topic),
    'key_topics', to_jsonb(coalesce(p_key_topics, array[]::text[])),
    'decisions', coalesce(p_decisions, '[]'::jsonb),
    'action_items', coalesce(p_action_items, '[]'::jsonb),
    'ambiguities', to_jsonb(coalesce(p_ambiguities, array[]::text[])),
    'output_fingerprint', encode(extensions.digest(convert_to(
      encode(v_summary.source_fingerprint, 'hex') || ':' || btrim(p_primary_topic)
      || ':' || btrim(p_summary_body)
      || ':' || to_jsonb(coalesce(p_key_topics, array[]::text[]))::text
      || ':' || coalesce(p_decisions, '[]'::jsonb)::text
      || ':' || coalesce(p_action_items, '[]'::jsonb)::text
      || ':' || to_jsonb(coalesce(p_ambiguities, array[]::text[]))::text, 'UTF8'
    ), 'sha256'), 'hex'),
    'human_review_required', true, 'published', false,
    'originals_unaffected', true
  );
end;
$$;

create or replace function private.bff_fail_summary_job_impl(
  p_worker_id uuid, p_job_id bigint, p_failure_code text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_job private.outbox_jobs%rowtype; v_summary_id uuid;
begin
  perform private.require_service_role();
  if char_length(coalesce(p_failure_code, '')) not between 1 and 120 then
    raise exception 'invalid summary failure code' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'summary'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now() for update;
  if not found then raise exception 'active summary lease required' using errcode = '55000'; end if;
  v_summary_id := (v_job.payload ->> 'summary_id')::uuid;
  update public.conversation_summaries summary
  set status = 'failed', primary_topic = null, summary_body = null,
      key_topics = null, decisions = null, action_items = null, ambiguities = null,
      output_fingerprint = null, processor_type = null,
      provider = null, model = null, processor_provenance = '{}'::jsonb,
      failure_code = p_failure_code, updated_at = now()
  where summary.organization_id = v_job.organization_id
    and summary.id = v_summary_id and summary.status in ('queued', 'processing');
  if not found then raise exception 'queued summary version not found' using errcode = '55000'; end if;
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
  return jsonb_build_object(
    'summary_id', v_summary_id, 'status', 'failed',
    'failure_code', p_failure_code, 'manual_fallback_available', true,
    'originals_unaffected', true
  );
end;
$$;

create or replace function private.bff_resolve_language_detection_job_source_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_provider text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_message public.messages%rowtype;
  v_current_hash bytea;
  v_expected_hash bytea;
  v_policy_version integer;
  v_route_policy text;
  v_reason text;
begin
  perform private.require_service_role();
  if coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$' then
    raise exception 'valid canonical processor id required' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'language_detection'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then
    raise exception 'active language detection lease required' using errcode = '55000';
  end if;
  begin
    v_expected_hash := decode(v_job.payload ->> 'source_sha256', 'hex');
  exception when others then
    raise exception 'invalid language detection job payload' using errcode = '22023';
  end;
  select message.* into v_message
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = (v_job.payload ->> 'message_id')::bigint;
  if found and v_message.body is not null then
    v_current_hash := extensions.digest(convert_to(v_message.body, 'UTF8'), 'sha256');
  end if;
  if v_message.id is null or v_message.deleted_at is not null or v_message.body is null
    or v_current_hash is distinct from v_expected_hash
    or v_message.language_detection_state <> 'pending' then
    v_reason := 'source_stale_or_deleted';
  elsif not private.ai_use_case_approved(
      v_job.organization_id, 'language_detection', lower(p_provider)
    ) then
    v_reason := 'tenant_ai_policy_denied';
  end if;
  if v_reason is not null then
    -- Do not overwrite the state of a newly edited message when retiring its
    -- old hash's job. Only a still-current source receives the policy failure.
    if v_message.id is not null and v_message.deleted_at is null
      and v_message.body is not null and v_current_hash = v_expected_hash
      and v_message.language_detection_state = 'pending' then
      perform set_config('app.language_detection_context', 'on', true);
      update public.messages message
      set detected_language = null,
          language_detection_state = 'failed',
          language_detection_method = case when v_reason = 'tenant_ai_policy_denied'
            then 'tenant-policy-denied' else 'source-no-longer-eligible' end,
          language_detection_confidence = null,
          language_detected_at = now()
      where message.organization_id = v_job.organization_id
        and message.conversation_id = v_message.conversation_id
        and message.id = v_message.id;
      update public.message_translations translation
      set status = 'blocked', failure_code = v_reason
      where translation.organization_id = v_job.organization_id
        and translation.conversation_id = v_message.conversation_id
        and translation.message_id = v_message.id
        and translation.status in ('queued', 'processing');
      perform set_config('app.language_detection_context', 'off', true);
    end if;
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'authorized', false,
      'provider_egress_allowed', false,
      'reason', v_reason,
      'message_id', v_job.payload ->> 'message_id'
    );
  end if;
  select policy.policy_version, policy.route_policy
    into v_policy_version, v_route_policy
  from public.organization_ai_policies policy
  where policy.organization_id = v_job.organization_id
    and policy.enabled and policy.revoked_at is null;
  update private.outbox_jobs job
  set payload = job.payload || jsonb_build_object(
        'resolved_provider', lower(p_provider),
        'ai_policy_version', v_policy_version,
        'source_resolved_at', now()
      ),
      updated_at = now()
  where job.id = p_job_id;
  return jsonb_build_object(
    'authorized', true,
    'provider_egress_allowed', true,
    'organization_id', v_job.organization_id,
    'conversation_id', v_message.conversation_id,
    'message_id', v_message.id,
    'source_body', v_message.body,
    'source_sha256', encode(v_current_hash, 'hex'),
    'client_language_hint', v_job.payload ->> 'client_language_hint',
    'required_target_languages', coalesce(
      v_job.payload -> 'required_target_languages', '[]'::jsonb
    ),
    'processor_id', lower(p_provider),
    'ai_policy_version', v_policy_version,
    'route_policy', v_route_policy,
    'provider_route_policy', 'zero_retention_only'
  );
end;
$$;

create or replace function private.bff_complete_language_detection_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_detection_state text,
  p_detected_language text,
  p_method text,
  p_confidence numeric
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_current_hash bytea;
  v_translation record;
  v_message_id bigint;
  v_translation_allowed boolean := false;
begin
  perform private.require_service_role();
  if coalesce(p_source_sha256, '') !~ '^[0-9a-f]{64}$'
    or p_detection_state not in ('completed', 'ambiguous')
    or char_length(coalesce(p_method, '')) not between 2 and 120
    or (p_confidence is not null and p_confidence not between 0 and 1)
    or (p_detection_state = 'completed' and (
      coalesce(p_detected_language, '') = 'und'
      or coalesce(p_detected_language, '') !~ '^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$'
    ))
    or (p_detection_state = 'ambiguous' and p_detected_language is distinct from 'und') then
    raise exception 'invalid language detection completion' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'language_detection'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then raise exception 'active language detection lease required' using errcode = '55000'; end if;
  select message.id, extensions.digest(convert_to(message.body, 'UTF8'), 'sha256')
    into v_message_id, v_current_hash
  from public.messages message
  where message.organization_id = (v_job.payload ->> 'organization_id')::uuid
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = (v_job.payload ->> 'message_id')::bigint
    and message.deleted_at is null
    and message.body is not null;
  if not found or v_current_hash <> decode(p_source_sha256, 'hex')
    or v_current_hash <> decode(v_job.payload ->> 'source_sha256', 'hex') then
    raise exception 'language detection source is stale or deleted' using errcode = '55000';
  end if;
  if coalesce(v_job.payload ->> 'resolved_provider', '') = ''
    or not private.ai_use_case_approved(
      v_job.organization_id, 'language_detection', v_job.payload ->> 'resolved_provider'
    )
    or not exists (
      select 1 from public.organization_ai_policies policy
      where policy.organization_id = v_job.organization_id
        and policy.policy_version = (v_job.payload ->> 'ai_policy_version')::integer
        and policy.route_policy = 'approved_zero_retention'
    ) then
    perform set_config('app.language_detection_context', 'on', true);
    update public.messages message
    set detected_language = null, language_detection_state = 'failed',
        language_detection_method = 'tenant-policy-changed',
        language_detection_confidence = null, language_detected_at = now()
    where message.organization_id = v_job.organization_id
      and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
      and message.id = v_message_id;
    update public.message_translations translation
    set status = 'blocked', failure_code = 'tenant_ai_policy_changed'
    where translation.organization_id = v_job.organization_id
      and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
      and translation.message_id = v_message_id
      and translation.status in ('queued', 'processing');
    perform set_config('app.language_detection_context', 'off', true);
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'message_id', v_message_id, 'state', 'failed',
      'error_code', 'tenant_ai_policy_changed',
      'translations_released', false, 'original_unaffected', true
    );
  end if;
  v_translation_allowed := private.ai_use_case_approved(
    v_job.organization_id, 'translation', v_job.payload ->> 'resolved_provider'
  );
  perform set_config('app.language_detection_context', 'on', true);
  update public.messages message
  set detected_language = case when p_detection_state = 'completed'
        then lower(p_detected_language) else 'und' end,
      language_detection_state = p_detection_state,
      language_detection_method = p_method,
      language_detection_confidence = p_confidence,
      language_detected_at = now()
  where message.organization_id = (v_job.payload ->> 'organization_id')::uuid
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = v_message_id;
  if p_detection_state = 'completed' then
    delete from public.message_translations translation
    where translation.organization_id = (v_job.payload ->> 'organization_id')::uuid
      and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
      and translation.message_id = v_message_id
      and translation.target_language = lower(p_detected_language);
    update public.message_translations translation
    set source_language = lower(p_detected_language)
    where translation.organization_id = (v_job.payload ->> 'organization_id')::uuid
      and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
      and translation.message_id = v_message_id
      and translation.source_language = 'und';
    if v_translation_allowed then
      for v_translation in
        select translation.id, translation.target_language
        from public.message_translations translation
        where translation.organization_id = (v_job.payload ->> 'organization_id')::uuid
          and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
          and translation.message_id = v_message_id
          and translation.status = 'queued'
      loop
        perform private.enqueue_outbox_job_internal(
          v_job.organization_id, 'translation', 'translation:' || v_translation.id::text,
          jsonb_build_object(
            'organization_id', v_job.organization_id,
            'conversation_id', (v_job.payload ->> 'conversation_id')::uuid,
            'message_id', v_message_id,
            'target_language', v_translation.target_language
          )
        );
      end loop;
    else
      update public.message_translations translation
      set status = 'blocked', failure_code = 'tenant_translation_policy_disabled'
      where translation.organization_id = v_job.organization_id
        and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
        and translation.message_id = v_message_id
        and translation.status = 'queued';
    end if;
  else
    update public.message_translations translation
    set status = 'blocked', failure_code = 'language_ambiguous'
    where translation.organization_id = v_job.organization_id
      and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
      and translation.message_id = v_message_id
      and translation.status = 'queued';
  end if;
  perform set_config('app.language_detection_context', 'off', true);
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
  return jsonb_build_object(
    'message_id', v_message_id,
    'state', p_detection_state,
    'detected_language', case when p_detection_state = 'completed'
      then lower(p_detected_language) else 'und' end,
    'client_hint_authoritative', false,
    'translations_released', p_detection_state = 'completed' and v_translation_allowed
  );
end;
$$;

create or replace function private.bff_fail_language_detection_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_method text,
  p_error_code text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_job private.outbox_jobs%rowtype; v_current_hash bytea; v_message_id bigint;
begin
  perform private.require_service_role();
  if coalesce(p_source_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(p_method, '')) not between 2 and 120
    or char_length(coalesce(p_error_code, '')) not between 1 and 120 then
    raise exception 'invalid language detection failure' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'language_detection'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then raise exception 'active language detection lease required' using errcode = '55000'; end if;
  select message.id, extensions.digest(convert_to(message.body, 'UTF8'), 'sha256')
    into v_message_id, v_current_hash
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = (v_job.payload ->> 'message_id')::bigint
    and message.deleted_at is null and message.body is not null;
  if not found or v_current_hash <> decode(p_source_sha256, 'hex') then
    raise exception 'language detection source is stale or deleted' using errcode = '55000';
  end if;
  perform set_config('app.language_detection_context', 'on', true);
  update public.messages message
  set detected_language = null, language_detection_state = 'failed',
      language_detection_method = p_method, language_detection_confidence = null,
      language_detected_at = now()
  where message.organization_id = v_job.organization_id
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = v_message_id;
  update public.message_translations translation
  set status = 'blocked', failure_code = p_error_code
  where translation.organization_id = v_job.organization_id
    and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and translation.message_id = v_message_id
    and translation.status = 'queued';
  perform set_config('app.language_detection_context', 'off', true);
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
  return jsonb_build_object(
    'message_id', v_message_id, 'state', 'failed',
    'error_code', p_error_code, 'original_unaffected', true
  );
end;
$$;

create or replace function private.bff_resolve_translation_job_for_egress_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_provider text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_message public.messages%rowtype;
  v_translation public.message_translations%rowtype;
  v_current_hash bytea;
  v_has_demand boolean := false;
  v_policy_version integer;
  v_route_policy text;
  v_reason text;
begin
  perform private.require_service_role();
  if coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$' then
    raise exception 'valid canonical processor id required' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id and job.topic = 'translation'
    and job.status = 'processing' and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then
    raise exception 'active translation lease required' using errcode = '55000';
  end if;
  select message.* into v_message
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = (v_job.payload ->> 'message_id')::bigint;
  if found and v_message.body is not null then
    v_current_hash := extensions.digest(convert_to(v_message.body, 'UTF8'), 'sha256');
  end if;
  select translation.* into v_translation
  from public.message_translations translation
  where translation.organization_id = v_job.organization_id
    and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and translation.message_id = (v_job.payload ->> 'message_id')::bigint
    and translation.target_language = lower(v_job.payload ->> 'target_language')
  for update;
  if v_message.id is null or v_translation.id is null
    or v_message.deleted_at is not null or v_message.body is null
    or v_message.language_detection_state <> 'completed'
    or v_message.detected_language is null
    or v_translation.source_language <> v_message.detected_language
    or v_translation.source_body_sha256 is distinct from v_current_hash
    or v_translation.status not in ('queued', 'processing') then
    v_reason := 'source_stale_or_deleted';
  elsif not private.ai_use_case_approved(
      v_job.organization_id, 'translation', lower(p_provider)
    ) then
    v_reason := 'tenant_ai_policy_denied';
  else
    select exists (
      select 1
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      join public.profiles profile on profile.user_id = member.user_id
      left join public.organization_user_preferences preference
        on preference.organization_id = member.organization_id
       and preference.user_id = member.user_id
      left join public.message_user_visibility visibility
        on visibility.organization_id = member.organization_id
       and visibility.conversation_id = member.conversation_id
       and visibility.message_id = v_message.id
       and visibility.user_id = member.user_id
      where member.organization_id = v_job.organization_id
        and member.conversation_id = v_message.conversation_id
        and member.status = 'active'
        and visibility.user_id is null
        and (
          lower(coalesce(preference.message_language, profile.preferred_language))
            = v_translation.target_language
          or member.user_id::text = coalesce(v_job.payload ->> 'requested_by_user_id', '')
        )
    ) into v_has_demand;
    if not v_has_demand then v_reason := 'no_active_recipient_demand'; end if;
  end if;
  if v_reason is not null then
    if v_translation.id is not null and v_message.id is not null
      and v_message.deleted_at is null and v_message.body is not null then
      update public.message_translations translation
      set status = 'blocked', translated_body = null, provider = null,
          model = null, confidence = null, failure_code = v_reason
      where translation.id = v_translation.id
        and translation.status in ('queued', 'processing');
    end if;
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return jsonb_build_object(
      'authorized', false, 'provider_egress_allowed', false,
      'reason', v_reason, 'message_id', v_job.payload ->> 'message_id',
      'target_language', v_job.payload ->> 'target_language'
    );
  end if;
  select policy.policy_version, policy.route_policy
    into v_policy_version, v_route_policy
  from public.organization_ai_policies policy
  where policy.organization_id = v_job.organization_id
    and policy.enabled and policy.revoked_at is null;
  update public.message_translations translation
  set status = 'processing', failure_code = null
  where translation.id = v_translation.id;
  update private.outbox_jobs job
  set payload = job.payload || jsonb_build_object(
        'resolved_provider', lower(p_provider),
        'ai_policy_version', v_policy_version,
        'translation_id', v_translation.id,
        'source_resolved_at', now()
      ),
      updated_at = now()
  where job.id = p_job_id;
  return jsonb_build_object(
    'authorized', true, 'provider_egress_allowed', true,
    'translation_id', v_translation.id,
    'organization_id', v_job.organization_id,
    'conversation_id', v_message.conversation_id,
    'message_id', v_message.id,
    'source_body', v_message.body,
    'source_language', v_message.detected_language,
    'target_language', v_translation.target_language,
    'source_sha256', encode(v_current_hash, 'hex'),
    'processor_id', lower(p_provider),
    'ai_policy_version', v_policy_version,
    'route_policy', v_route_policy,
    'provider_route_policy', 'zero_retention_only'
  );
end;
$$;

create or replace function private.bff_complete_translation_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_translated_body text,
  p_provider text,
  p_model text,
  p_confidence numeric
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_current_hash bytea;
  v_has_demand boolean := false;
  v_source_found boolean := false;
begin
  perform private.require_service_role();
  if coalesce(p_source_sha256, '') !~ '^[0-9a-f]{64}$'
    or char_length(coalesce(p_translated_body, '')) not between 1 and 20000
    or coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$'
    or char_length(coalesce(p_model, '')) not between 2 and 200
    or (p_confidence is not null and p_confidence not between 0 and 1) then
    raise exception 'invalid translation completion payload' using errcode = '22023';
  end if;
  select * into v_job
  from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'translation'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then raise exception 'active translation lease not found' using errcode = '55000'; end if;

  select extensions.digest(convert_to(message.body, 'UTF8'), 'sha256')
    into v_current_hash
  from public.messages message
  where message.organization_id = (v_job.payload ->> 'organization_id')::uuid
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = (v_job.payload ->> 'message_id')::bigint
    and message.deleted_at is null
    and message.body is not null;
  v_source_found := found;
  if v_source_found then
    select exists (
      select 1
      from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      join public.profiles profile on profile.user_id = member.user_id
      left join public.organization_user_preferences preference
        on preference.organization_id = member.organization_id
       and preference.user_id = member.user_id
      left join public.message_user_visibility visibility
        on visibility.organization_id = member.organization_id
       and visibility.conversation_id = member.conversation_id
       and visibility.message_id = (v_job.payload ->> 'message_id')::bigint
       and visibility.user_id = member.user_id
      where member.organization_id = v_job.organization_id
        and member.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
        and member.status = 'active'
        and visibility.user_id is null
        and (
          lower(coalesce(preference.message_language, profile.preferred_language))
            = lower(v_job.payload ->> 'target_language')
          or member.user_id::text = coalesce(v_job.payload ->> 'requested_by_user_id', '')
        )
    ) into v_has_demand;
  end if;
  if not v_source_found
    or v_current_hash <> decode(p_source_sha256, 'hex')
    or coalesce(v_job.payload ->> 'resolved_provider', '') <> lower(p_provider)
    or not private.ai_use_case_approved(
      v_job.organization_id, 'translation', lower(p_provider)
    )
    or not exists (
      select 1 from public.organization_ai_policies policy
      where policy.organization_id = v_job.organization_id
        and policy.policy_version = (v_job.payload ->> 'ai_policy_version')::integer
        and policy.route_policy = 'approved_zero_retention'
    )
    or not v_has_demand then
    if v_current_hash is not null then
      update public.message_translations translation
      set status = 'blocked', translated_body = null, provider = null,
          model = null, confidence = null,
          failure_code = case when not v_has_demand
            then 'no_active_recipient_demand' else 'tenant_ai_policy_changed' end
      where translation.organization_id = v_job.organization_id
        and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
        and translation.message_id = (v_job.payload ->> 'message_id')::bigint
        and translation.target_language = lower(v_job.payload ->> 'target_language')
        and translation.status = 'processing';
    end if;
    perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
    return;
  end if;

  update public.message_translations translation
  set status = 'completed',
      translated_body = p_translated_body,
      provider = lower(p_provider),
      model = p_model,
      confidence = p_confidence,
      failure_code = null
  where translation.organization_id = (v_job.payload ->> 'organization_id')::uuid
    and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and translation.message_id = (v_job.payload ->> 'message_id')::bigint
    and translation.target_language = v_job.payload ->> 'target_language'
    and translation.source_body_sha256 = v_current_hash
    and translation.status = 'processing'
    and translation.id = (v_job.payload ->> 'translation_id')::bigint;
  if not found then raise exception 'translation request not found' using errcode = '55000'; end if;
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
end;
$$;

create or replace function private.bff_fail_translation_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_provider text,
  p_error_code text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_current_hash bytea;
  v_source_current boolean := false;
  v_policy_current boolean := false;
  v_terminal_status text;
  v_terminal_code text;
  v_translation_id bigint;
begin
  perform private.require_service_role();
  if coalesce(p_source_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_provider, '') !~ '^[a-z0-9][a-z0-9._/-]{1,159}$'
    or char_length(coalesce(p_error_code, '')) not between 1 and 120 then
    raise exception 'invalid terminal translation failure' using errcode = '22023';
  end if;
  select * into v_job
  from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'translation'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then
    raise exception 'active translation lease required' using errcode = '55000';
  end if;
  if coalesce(v_job.payload ->> 'resolved_provider', '') <> lower(p_provider) then
    raise exception 'translation provider does not match resolved egress policy'
      using errcode = '42501';
  end if;

  select extensions.digest(convert_to(message.body, 'UTF8'), 'sha256')
    into v_current_hash
  from public.messages message
  where message.organization_id = v_job.organization_id
    and message.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and message.id = (v_job.payload ->> 'message_id')::bigint
    and message.deleted_at is null
    and message.body is not null;
  v_source_current := found
    and v_current_hash = decode(p_source_sha256, 'hex');
  select exists (
    select 1 from public.organization_ai_policies policy
    where policy.organization_id = v_job.organization_id
      and policy.enabled
      and policy.revoked_at is null
      and policy.policy_version = (v_job.payload ->> 'ai_policy_version')::integer
      and policy.route_policy = 'approved_zero_retention'
      and lower(p_provider) = any(policy.provider_allowlist)
      and 'translation' = any(policy.approved_use_cases)
  ) into v_policy_current;
  v_terminal_status := case when v_source_current and v_policy_current
    then 'failed' else 'blocked' end;
  v_terminal_code := case
    when not v_source_current then 'source_stale_or_deleted'
    when not v_policy_current then 'tenant_ai_policy_changed'
    else p_error_code
  end;
  update public.message_translations translation
  set status = v_terminal_status,
      translated_body = null,
      provider = null,
      model = null,
      confidence = null,
      failure_code = v_terminal_code
  where translation.organization_id = v_job.organization_id
    and translation.conversation_id = (v_job.payload ->> 'conversation_id')::uuid
    and translation.message_id = (v_job.payload ->> 'message_id')::bigint
    and translation.target_language = lower(v_job.payload ->> 'target_language')
    and translation.id = (v_job.payload ->> 'translation_id')::bigint
    and translation.status in ('queued', 'processing')
  returning translation.id into v_translation_id;
  if v_translation_id is null then
    raise exception 'terminal translation row not found' using errcode = '55000';
  end if;
  update private.outbox_jobs job
  set status = 'dead_letter',
      claimed_by = null,
      claimed_until = null,
      completed_at = null,
      last_error_code = v_terminal_code,
      updated_at = now()
  where job.id = p_job_id;
  return jsonb_build_object(
    'translation_id', v_translation_id,
    'translation_status', v_terminal_status,
    'error_code', v_terminal_code,
    'job_status', 'dead_letter',
    'original_unaffected', true
  );
end;
$$;

create or replace function private.bff_scrub_retention_impl(p_batch_size integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_scrubbed integer;
begin
  perform private.require_service_role();
  if p_batch_size not between 1 and 5000 then
    raise exception 'invalid retention batch size' using errcode = '22023';
  end if;
  with candidates as (
    select message.id
    from public.messages message
    join public.organizations organization on organization.id = message.organization_id
    where message.deleted_at is null
      and message.created_at < now() - make_interval(days => organization.message_retention_days)
    order by message.created_at, message.id
    for update of message skip locked
    limit p_batch_size
  ), scrubbed as (
    update public.messages message
    set deleted_at = now()
    from candidates
    where message.id = candidates.id
    returning message.id
  )
  select count(*) into v_scrubbed from scrubbed;
  return jsonb_build_object('scrubbed_messages', v_scrubbed);
end;
$$;

create or replace function private.bff_bind_session_installation_impl(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_platform text,
  p_app_version text,
  p_locale text,
  p_user_agent_hash text,
  p_user_agent_family text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_binding_id uuid;
begin
  perform private.require_service_role();
  if p_actor_user_id is null or p_session_id is null or p_installation_id is null
    or p_platform not in ('ios', 'android', 'web')
    or (p_app_version is not null and char_length(p_app_version) > 80)
    or (p_locale is not null and char_length(p_locale) not between 2 and 35)
    or coalesce(p_user_agent_hash, '') !~ '^[0-9a-f]{64}$'
    or p_user_agent_family not in (
      'iphone', 'ipad', 'android', 'mobile', 'desktop', 'unknown'
    ) then
    raise exception 'invalid session installation attribution' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from auth.sessions session
    join auth.users auth_user on auth_user.id = session.user_id
    where session.id = p_session_id
      and session.user_id = p_actor_user_id
      and (session.not_after is null or session.not_after > now())
      and (auth_user.banned_until is null or auth_user.banned_until <= now())
  ) then
    raise exception 'active Auth session required' using errcode = '42501';
  end if;
  insert into private.session_installations (
    session_id, user_id, installation_id, platform, app_version, locale,
    user_agent_hash, user_agent_family
  ) values (
    p_session_id, p_actor_user_id, p_installation_id, p_platform,
    p_app_version, p_locale, decode(p_user_agent_hash, 'hex'), p_user_agent_family
  )
  on conflict (session_id) do update
  set app_version = excluded.app_version,
      locale = excluded.locale,
      user_agent_hash = excluded.user_agent_hash,
      user_agent_family = excluded.user_agent_family,
      last_seen_at = now(),
      updated_at = now()
  where private.session_installations.user_id = excluded.user_id
    and private.session_installations.installation_id = excluded.installation_id
    and private.session_installations.platform = excluded.platform
    and private.session_installations.revoked_at is null
  returning id into v_binding_id;
  if v_binding_id is null then
    raise exception 'session installation binding conflict' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'session_id', p_session_id,
    'installation_id', p_installation_id,
    'platform', p_platform,
    'bound', true
  );
end;
$$;

create or replace function private.bff_register_device_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_platform text,
  p_push_token_ciphertext text,
  p_push_token_type text,
  p_push_project_id uuid,
  p_push_environment text,
  p_app_version text,
  p_locale text,
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
  v_device_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'device.register', false, 0, '/v2/devices',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_platform not in ('ios', 'android')
    or p_push_token_type <> 'expo'
    or p_push_project_id is null
    or p_push_environment not in ('development', 'preview', 'production')
    or char_length(coalesce(p_push_token_ciphertext, '')) not between 20 and 8192
    or p_push_token_ciphertext !~ '^(kms|vault|ciphertext):' then
    raise exception 'invalid protected push registration' using errcode = '22023';
  end if;
  if not exists (
    select 1 from private.session_installations binding
    where binding.session_id = p_session_id
      and binding.user_id = p_actor_user_id
      and binding.installation_id = p_installation_id
      and binding.platform = p_platform
      and binding.revoked_at is null
  ) then
    raise exception 'active session installation binding required' using errcode = '42501';
  end if;

  insert into public.device_registrations (
    organization_id, user_id, session_id, installation_id, platform,
    push_token_ciphertext, push_token_type, push_project_id, push_environment,
    app_version, locale
  ) values (
    p_organization_id, p_actor_user_id, p_session_id, p_installation_id, p_platform,
    p_push_token_ciphertext, p_push_token_type, p_push_project_id, p_push_environment,
    p_app_version, p_locale
  )
  on conflict (organization_id, user_id, installation_id)
  do update set
    session_id = excluded.session_id,
    platform = excluded.platform,
    push_token_ciphertext = excluded.push_token_ciphertext,
    push_token_type = excluded.push_token_type,
    push_project_id = excluded.push_project_id,
    push_environment = excluded.push_environment,
    app_version = excluded.app_version,
    locale = excluded.locale
  where device_registrations.revoked_at is null
  returning id into v_device_id;
  if v_device_id is null then
    raise exception 'revoked installation cannot be restored' using errcode = '42501';
  end if;
  v_response := jsonb_build_object(
    'device_id', v_device_id,
    'installation_id', p_installation_id,
    'platform', p_platform,
    'push_token_type', p_push_token_type,
    'push_project_id', p_push_project_id,
    'push_environment', p_push_environment,
    'registered', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/devices',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_list_sessions_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_current_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sessions jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_current_session_id,
    'session.list', false, 0
  );
  select coalesce(jsonb_agg(session_row.payload order by session_row.created_at desc), '[]'::jsonb)
    into v_sessions
  from (
    select session.created_at, jsonb_build_object(
      'session_id', session.id,
      'current', session.id = p_current_session_id,
      'device', jsonb_build_object(
        'installation_id', binding.installation_id,
        'platform', binding.platform,
        'app_version', coalesce(device.app_version, binding.app_version)
      ),
      'platform', binding.platform,
      'created_at', session.created_at,
      'last_used_at', greatest(
        session.updated_at, binding.last_seen_at,
        coalesce(device.last_seen_at, binding.last_seen_at)
      ),
      'expires_at', session.not_after,
      'revoked', revocation.session_id is not null or binding.revoked_at is not null,
      'aal', session.aal::text,
      'signal', jsonb_build_object(
        'same_network_as_current', session.ip is not distinct from current_session.ip,
        'client_family', binding.user_agent_family
      )
    ) as payload
    from auth.sessions session
    join auth.sessions current_session
      on current_session.id = p_current_session_id
     and current_session.user_id = p_actor_user_id
    join private.session_installations binding
      on binding.session_id = session.id
     and binding.user_id = session.user_id
    left join private.session_revocations revocation
      on revocation.organization_id = p_organization_id
     and revocation.session_id = session.id
    left join lateral (
      select registration.*
      from public.device_registrations registration
      where registration.organization_id = p_organization_id
        and registration.user_id = p_actor_user_id
        and registration.session_id = session.id
      order by registration.last_seen_at desc
      limit 1
    ) device on true
    where session.user_id = p_actor_user_id
    order by session.created_at desc
    limit 100
  ) session_row;
  return jsonb_build_object('sessions', v_sessions);
end;
$$;

create or replace function private.bff_list_admin_members_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_after_user_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_members jsonb;
begin
  perform private.require_service_role();
  if p_limit not between 1 and 100 then
    raise exception 'invalid member page size' using errcode = '22023';
  end if;
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'admin.member.list', true, 900
  );
  if not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and membership.role in ('owner', 'admin')
  ) then
    raise exception 'organization administrator permission required' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(member_row.payload order by member_row.user_id), '[]'::jsonb)
    into v_members
  from (
    select membership.user_id, jsonb_build_object(
      'user_id', membership.user_id,
      'display_name', profile.display_name,
      'role', membership.role,
      'status', membership.status,
      'job_title', membership.job_title,
      'revocation_generation', membership.revocation_generation,
      'updated_at', membership.updated_at
    ) as payload
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and (p_after_user_id is null or membership.user_id > p_after_user_id)
    order by membership.user_id
    limit p_limit
  ) member_row;
  return jsonb_build_object('members', v_members);
end;
$$;

create or replace function private.bff_get_attachment_state_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_attachment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.state.read', false, 0
  );
  select jsonb_build_object(
    'attachment_id', attachment.id,
    'message_id', attachment.message_id,
    'scan_status', attachment.scan_status,
    'byte_size', attachment.byte_size,
    'mime_type', attachment.mime_type,
    'created_at', attachment.created_at,
    'purge_requested_at', attachment.purge_requested_at
  ) into v_result
  from public.message_attachments attachment
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
    and (
      attachment.created_by_user_id = p_actor_user_id
      or exists (
        select 1
        from public.conversation_members conversation_member
        join public.messages message
          on message.organization_id = conversation_member.organization_id
         and message.conversation_id = conversation_member.conversation_id
         and message.id = attachment.message_id
         and message.deleted_at is null
         and message.available_at <= now()
        join public.organization_memberships organization_member
          on organization_member.organization_id = conversation_member.organization_id
         and organization_member.user_id = conversation_member.user_id
         and organization_member.status = 'active'
        where conversation_member.organization_id = attachment.organization_id
          and conversation_member.conversation_id = attachment.conversation_id
          and conversation_member.user_id = p_actor_user_id
          and conversation_member.status = 'active'
          and (conversation_member.history_visible_from is null
            or message.created_at >= conversation_member.history_visible_from)
          and attachment.scan_status = 'clean'
          and not exists (
            select 1 from public.message_user_visibility visibility
            where visibility.organization_id = message.organization_id
              and visibility.conversation_id = message.conversation_id
              and visibility.message_id = message.id
              and visibility.user_id = p_actor_user_id
          )
      )
    );
  if not found then return jsonb_build_object('found', false); end if;
  return jsonb_build_object('found', true, 'attachment', v_result);
end;
$$;

create or replace function private.bff_edit_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_body text,
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
  v_edited_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.edit', false, 0, '/v2/messages/:id',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.consume_rate_limit(
    'message-edit-minute', p_organization_id::text || ':' || p_actor_user_id::text, 30, 60
  ) then
    raise exception 'message edit rate limit exceeded' using errcode = 'P0001';
  end if;
  update public.messages message
  set body = p_body
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
  returning message.edited_at into v_edited_at;
  if not found then raise exception 'editable message not found' using errcode = 'P0002'; end if;
  v_response := jsonb_build_object('message_id', p_message_id, 'edited_at', v_edited_at);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_delete_message_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
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
  v_deleted_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.delete', false, 0, '/v2/messages/:id/delete',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.consume_rate_limit(
    'message-delete-minute', p_organization_id::text || ':' || p_actor_user_id::text, 30, 60
  ) then
    raise exception 'message delete rate limit exceeded' using errcode = 'P0001';
  end if;
  update public.messages message
  set deleted_at = now()
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
  returning message.deleted_at into v_deleted_at;
  if not found then raise exception 'deletable message not found' using errcode = 'P0002'; end if;
  v_response := jsonb_build_object(
    'message_id', p_message_id, 'deleted', true, 'deleted_at', v_deleted_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/delete',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_set_message_reaction_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_emoji text,
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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.reaction.set', false, 0, '/v2/messages/:id/reactions',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if char_length(coalesce(p_emoji, '')) not between 1 and 32
    or not private.is_conversation_member(p_organization_id, p_conversation_id)
    or not exists (
      select 1 from public.messages message
      where message.organization_id = p_organization_id
        and message.conversation_id = p_conversation_id
        and message.id = p_message_id
        and message.deleted_at is null
    ) then
    raise exception 'reaction is not permitted' using errcode = '42501';
  end if;
  insert into public.message_reactions (
    organization_id, conversation_id, message_id, user_id, emoji
  ) values (
    p_organization_id, p_conversation_id, p_message_id, p_actor_user_id, p_emoji
  ) on conflict do nothing;
  v_response := jsonb_build_object(
    'message_id', p_message_id, 'emoji', p_emoji, 'reacted', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/reactions',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_remove_message_reaction_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_emoji text,
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
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.reaction.remove', false, 0, '/v2/messages/:id/reactions/:emoji',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id) then
    raise exception 'conversation membership required' using errcode = '42501';
  end if;
  delete from public.message_reactions reaction
  where reaction.organization_id = p_organization_id
    and reaction.conversation_id = p_conversation_id
    and reaction.message_id = p_message_id
    and reaction.user_id = p_actor_user_id
    and reaction.emoji = p_emoji;
  v_response := jsonb_build_object(
    'message_id', p_message_id, 'emoji', p_emoji, 'reacted', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/reactions/:emoji',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

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

create or replace function private.bff_respond_contact_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_other_user_id uuid,
  p_status text,
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
  v_responded_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'contact.respond', false, 0, '/v2/contacts/:id/respond',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_status not in ('accepted', 'declined') then
    raise exception 'invalid contact response' using errcode = '22023';
  end if;
  update public.contact_connections connection
  set status = p_status
  where connection.organization_id = p_organization_id
    and connection.member_low_user_id = v_low
    and connection.member_high_user_id = v_high
    and connection.status = 'pending'
  returning connection.responded_at into v_responded_at;
  if not found then raise exception 'pending contact request not found' using errcode = 'P0002'; end if;
  v_response := jsonb_build_object(
    'member_low_user_id', v_low,
    'member_high_user_id', v_high,
    'status', p_status,
    'responded_at', v_responded_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/contacts/:id/respond',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

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
    and connection.member_high_user_id = v_high;
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

create or replace function private.bff_authorize_attachment_download_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_attachment_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_result jsonb;
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'attachment.download.authorize', false, 0
  );
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal'
  );
  select jsonb_build_object(
    'authorized', true,
    'attachment_id', attachment.id,
    'bucket_id', attachment.bucket_id,
    'storage_path', attachment.storage_path,
    'file_name', attachment.file_name,
    'mime_type', attachment.mime_type,
    'byte_size', attachment.byte_size
  ) into v_result
  from public.message_attachments attachment
  join public.messages message
    on message.organization_id = attachment.organization_id
   and message.conversation_id = attachment.conversation_id
   and message.id = attachment.message_id
   and message.deleted_at is null
   and message.available_at <= now()
  join public.conversation_members member
    on member.organization_id = attachment.organization_id
   and member.conversation_id = attachment.conversation_id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
   and (member.history_visible_from is null
     or message.created_at >= member.history_visible_from)
  where attachment.organization_id = p_organization_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'clean'
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = message.organization_id
        and visibility.conversation_id = message.conversation_id
        and visibility.message_id = message.id
        and visibility.user_id = p_actor_user_id
    );
  if not found then
    perform private.clear_bff_actor_context_internal();
    return jsonb_build_object('authorized', false);
  end if;
  perform private.clear_bff_actor_context_internal();
  return v_result;
end;
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
      where key not in ('is_favorite', 'is_pinned', 'is_hidden', 'notification_level', 'muted_until')
    )
    or exists (
      select 1 from (values ('is_favorite'), ('is_pinned'), ('is_hidden')) boolean_key(name)
      where p_patch ? boolean_key.name
        and jsonb_typeof(p_patch -> boolean_key.name) <> 'boolean'
    )
    or (
      p_patch ? 'notification_level'
      and p_patch ->> 'notification_level' not in ('all', 'mentions', 'none')
    ) then
    raise exception 'invalid conversation preference patch' using errcode = '22023';
  end if;

  insert into public.conversation_preferences (
    organization_id, conversation_id, user_id, is_favorite, is_pinned,
    is_hidden, notification_level, muted_until
  ) values (
    p_organization_id, p_conversation_id, p_actor_user_id,
    case when p_patch ? 'is_favorite' then (p_patch ->> 'is_favorite')::boolean else false end,
    case when p_patch ? 'is_pinned' then (p_patch ->> 'is_pinned')::boolean else false end,
    case when p_patch ? 'is_hidden' then (p_patch ->> 'is_hidden')::boolean else false end,
    case when p_patch ? 'notification_level' then p_patch ->> 'notification_level' else 'all' end,
    case when p_patch ? 'muted_until' and p_patch -> 'muted_until' <> 'null'::jsonb
      then (p_patch ->> 'muted_until')::timestamptz else null end
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
      updated_at = now()
  returning * into v_preference;
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'is_favorite', v_preference.is_favorite,
    'is_pinned', v_preference.is_pinned,
    'is_hidden', v_preference.is_hidden,
    'notification_level', v_preference.notification_level,
    'muted_until', v_preference.muted_until,
    'updated_at', v_preference.updated_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/conversations/:id/preferences',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_set_message_pin_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_pinned boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_pinned_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.pin.set', false, 0, '/v2/messages/:id/pin',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_admin(p_organization_id, p_conversation_id) then
    raise exception 'conversation administrator permission required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.messages message
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.id = p_message_id
      and message.deleted_at is null
  ) then
    raise exception 'message not found' using errcode = 'P0002';
  end if;
  if p_pinned then
    insert into public.message_pins (
      organization_id, conversation_id, message_id, pinned_by_user_id
    ) values (
      p_organization_id, p_conversation_id, p_message_id, p_actor_user_id
    )
    on conflict (organization_id, conversation_id, message_id) do update
      set pinned_by_user_id = excluded.pinned_by_user_id,
          pinned_at = now()
    returning pinned_at into v_pinned_at;
  else
    delete from public.message_pins pin
    where pin.organization_id = p_organization_id
      and pin.conversation_id = p_conversation_id
      and pin.message_id = p_message_id;
  end if;
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'message_id', p_message_id,
    'pinned', p_pinned,
    'pinned_at', v_pinned_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/pin',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_mark_message_receipt_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_state text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_receipt public.message_receipts%rowtype;
  v_target_created_at timestamptz;
  v_previous_read_message_id bigint;
  v_previous_read_created_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'message.receipt.mark', false, 0, '/v2/messages/:id/receipt',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_state not in ('delivered', 'read') then
    raise exception 'invalid receipt state' using errcode = '22023';
  end if;
  select message.created_at into v_target_created_at
  from public.messages message
  join public.conversation_members member
    on member.organization_id = message.organization_id
   and member.conversation_id = message.conversation_id
   and member.user_id = p_actor_user_id
   and member.status = 'active'
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where message.organization_id = p_organization_id
    and message.conversation_id = p_conversation_id
    and message.id = p_message_id
    and message.sender_user_id <> p_actor_user_id
    and message.deleted_at is null
    and message.available_at <= now()
    and (member.history_visible_from is null
      or message.created_at >= member.history_visible_from)
    and not exists (
      select 1 from public.message_user_visibility visibility
      where visibility.organization_id = message.organization_id
        and visibility.conversation_id = message.conversation_id
        and visibility.message_id = message.id
        and visibility.user_id = p_actor_user_id
    );
  if not found then
    raise exception 'readable message not found' using errcode = '42501';
  end if;

  if p_state = 'read' then
    -- Serialize against the existing cursor when present. A read transition
    -- covers every still-readable incoming message after that boundary through
    -- the target, so earlier sender aggregates cannot remain stale merely
    -- because the client acknowledged only the visible range endpoint.
    select cursor.last_read_message_id, previous_message.created_at
      into v_previous_read_message_id, v_previous_read_created_at
    from public.conversation_read_cursors cursor
    join public.messages previous_message
      on previous_message.organization_id = cursor.organization_id
     and previous_message.conversation_id = cursor.conversation_id
     and previous_message.id = cursor.last_read_message_id
    where cursor.organization_id = p_organization_id
      and cursor.conversation_id = p_conversation_id
      and cursor.user_id = p_actor_user_id
    for update of cursor;

    insert into public.message_receipts (
      organization_id, conversation_id, message_id, user_id,
      delivered_at, read_at
    )
    select p_organization_id, p_conversation_id, message.id, p_actor_user_id,
      now(), now()
    from public.messages message
    join public.conversation_members member
      on member.organization_id = message.organization_id
     and member.conversation_id = message.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where message.organization_id = p_organization_id
      and message.conversation_id = p_conversation_id
      and message.sender_user_id <> p_actor_user_id
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and (
        v_previous_read_message_id is null
        or (message.created_at, message.id)
          > (v_previous_read_created_at, v_previous_read_message_id)
      )
      and (message.created_at, message.id)
        <= (v_target_created_at, p_message_id)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
    on conflict (organization_id, conversation_id, message_id, user_id) do update
    set delivered_at = coalesce(
          public.message_receipts.delivered_at, excluded.delivered_at
        ),
        read_at = coalesce(public.message_receipts.read_at, excluded.read_at),
        updated_at = now();

    insert into public.conversation_read_cursors (
      organization_id, conversation_id, user_id, last_read_message_id
    ) values (
      p_organization_id, p_conversation_id, p_actor_user_id, p_message_id
    )
    on conflict (organization_id, conversation_id, user_id) do update
    set last_read_message_id = greatest(
          public.conversation_read_cursors.last_read_message_id,
          excluded.last_read_message_id
        ),
        last_read_at = now()
    where public.conversation_read_cursors.last_read_message_id is null
      or excluded.last_read_message_id
        > public.conversation_read_cursors.last_read_message_id;
  else
    -- Delivered is intentionally target-only: clients emit it for each loaded
    -- message, while read acknowledges a contiguous visible range.
    insert into public.message_receipts (
      organization_id, conversation_id, message_id, user_id,
      delivered_at, read_at
    ) values (
      p_organization_id, p_conversation_id, p_message_id, p_actor_user_id,
      now(), null
    )
    on conflict (organization_id, conversation_id, message_id, user_id) do update
    set delivered_at = coalesce(
          public.message_receipts.delivered_at, excluded.delivered_at
        ),
        updated_at = now();
  end if;

  select receipt.* into v_receipt
  from public.message_receipts receipt
  where receipt.organization_id = p_organization_id
    and receipt.conversation_id = p_conversation_id
    and receipt.message_id = p_message_id
    and receipt.user_id = p_actor_user_id;

  perform private.broadcast_receipt_invalidation_internal(
    p_organization_id, p_conversation_id, p_message_id
  );
  v_response := jsonb_build_object(
    'conversation_id', p_conversation_id,
    'message_id', p_message_id,
    'scope', 'self',
    'delivered_at', v_receipt.delivered_at,
    'read_at', v_receipt.read_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/messages/:id/receipt',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_correct_announcement_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_reason text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_announcement public.announcements%rowtype;
  v_previous_version_id uuid;
  v_previous_version_number integer;
  v_language_code text;
  v_acknowledgement_schema jsonb;
  v_notification_class text;
  v_critical_category text;
  v_quiet_hours_override_reason text;
  v_reminder_policy jsonb;
  v_message_id bigint;
  v_version_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'announcement.correct', true, 900, '/v2/updates/:id/corrections',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'communications.publish', null
    )
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 2000 then
    raise exception 'authorized correction reason required' using errcode = '42501';
  end if;
  select * into v_announcement
  from public.announcements announcement
  where announcement.organization_id = p_organization_id
    and announcement.id = p_announcement_id
    and announcement.status = 'published'
  for update;
  if not found then raise exception 'published announcement not found' using errcode = 'P0002'; end if;
  select version.id, version.version_number, message.language_code,
      version.acknowledgement_schema, version.notification_class,
      version.critical_category, version.quiet_hours_override_reason,
      version.reminder_policy
    into v_previous_version_id, v_previous_version_number, v_language_code,
      v_acknowledgement_schema, v_notification_class, v_critical_category,
      v_quiet_hours_override_reason, v_reminder_policy
  from public.announcement_versions version
  join public.messages message
    on message.organization_id = version.organization_id
   and message.conversation_id = version.conversation_id
   and message.id = version.message_id
  where version.organization_id = p_organization_id
    and version.announcement_id = p_announcement_id
  order by version.version_number desc
  limit 1;
  v_message_id := private.send_message(
    p_organization_id, v_announcement.conversation_id, p_client_nonce, 'text',
    p_body, v_language_code, null, null, '{}'::jsonb
  );
  insert into public.announcement_versions (
    organization_id, announcement_id, conversation_id, version_number,
    message_id, title, priority, requires_acknowledgement,
    acknowledgement_schema, notification_class, critical_category,
    quiet_hours_override_reason, reminder_policy,
    scheduled_at, published_at, expires_at,
    correction_of_version_id, correction_reason, created_by_user_id
  ) values (
    p_organization_id, p_announcement_id, v_announcement.conversation_id,
    v_previous_version_number + 1, v_message_id, p_title, p_priority,
    p_requires_acknowledgement,
    case when p_requires_acknowledgement then v_acknowledgement_schema
      else '{"schema_version":1,"attestation_required":false,"attestation_prompt":null,"required_keys":[],"carry_forward_on_correction":false}'::jsonb end,
    v_notification_class, v_critical_category, v_quiet_hours_override_reason,
    case when p_requires_acknowledgement then v_reminder_policy
      else '{"enabled":false,"deadline_at":null,"interval_seconds":null,"maximum_reminders":0,"escalate_after_seconds":null,"sms_fallback":false}'::jsonb end,
    null, now(), p_expires_at, v_previous_version_id,
    p_reason, p_actor_user_id
  ) returning id into v_version_id;
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'push', 'announcement-version:' || v_version_id::text,
    jsonb_build_object(
      'announcement_id', p_announcement_id,
      'announcement_version_id', v_version_id,
      'message_id', v_message_id,
      'conversation_id', v_announcement.conversation_id,
      'state', 'corrected',
      'notification_class', v_notification_class,
      'critical_category', v_critical_category,
      'quiet_hours_override_reason', v_quiet_hours_override_reason
    )
  );
  v_response := jsonb_build_object(
    'announcement_id', p_announcement_id,
    'announcement_version_id', v_version_id,
    'version_number', v_previous_version_number + 1,
    'message_id', v_message_id,
    'corrected', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/updates/:id/corrections',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_correct_handoff_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_id uuid,
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
language plpgsql volatile security definer set search_path = ''
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
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'handoff.correct', false, 0, '/v2/handoffs/:id/corrections',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select * into v_handoff
  from public.shift_handoffs handoff
  where handoff.organization_id = p_organization_id
    and handoff.id = p_handoff_id
  for update;
  if not found or not private.is_conversation_admin(p_organization_id, v_handoff.conversation_id) then
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
  v_source_snapshot := private.handoff_source_snapshot_internal(
    p_organization_id, v_handoff.conversation_id, p_actor_user_id,
    coalesce(p_source_message_ids, array[]::bigint[])
  );
  select version.id, version.version_number
    into v_previous_version_id, v_previous_version_number
  from public.handoff_versions version
  where version.organization_id = p_organization_id
    and version.handoff_id = p_handoff_id
  order by version.version_number desc
  limit 1;
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
  where handoff.organization_id = p_organization_id and handoff.id = p_handoff_id;
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

create or replace function private.bff_propose_glossary_term_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_term_id uuid,
  p_source_language text,
  p_target_language text,
  p_source_term text,
  p_translated_term text,
  p_definition text,
  p_reason text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_term_id uuid := p_term_id;
  v_previous_version_id uuid;
  v_previous_version_number integer;
  v_version_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'glossary.propose', false, 0, '/v2/glossary/proposals',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_source_language = p_target_language
    or char_length(coalesce(p_source_language, '')) not between 2 and 35
    or char_length(coalesce(p_target_language, '')) not between 2 and 35 then
    raise exception 'invalid glossary language pair' using errcode = '22023';
  end if;
  if not private.consume_rate_limit(
    'glossary-proposal-hour', p_organization_id::text || ':' || p_actor_user_id::text, 60, 3600
  ) then
    raise exception 'glossary proposal rate limit exceeded' using errcode = 'P0001';
  end if;

  if v_term_id is null then
    select term.id into v_term_id
    from public.glossary_terms term
    where term.organization_id = p_organization_id
      and term.source_language = p_source_language
      and term.target_language = p_target_language
      and lower(btrim(term.source_term)) = lower(btrim(p_source_term))
      and term.archived_at is null
    for update;
    if not found then
      insert into public.glossary_terms (
        organization_id, source_language, target_language, source_term,
        created_by_user_id
      ) values (
        p_organization_id, p_source_language, p_target_language,
        btrim(p_source_term), p_actor_user_id
      ) returning id into v_term_id;
    end if;
  else
    perform 1 from public.glossary_terms term
    where term.organization_id = p_organization_id
      and term.id = v_term_id
      and term.archived_at is null
      and term.source_language = p_source_language
      and term.target_language = p_target_language
      and lower(btrim(term.source_term)) = lower(btrim(p_source_term))
    for update;
    if not found then raise exception 'glossary term not found' using errcode = 'P0002'; end if;
  end if;

  select version.id, version.version_number
    into v_previous_version_id, v_previous_version_number
  from public.glossary_term_versions version
  where version.organization_id = p_organization_id
    and version.term_id = v_term_id
  order by version.version_number desc
  limit 1;
  if v_previous_version_id is not null
    and char_length(btrim(coalesce(p_reason, ''))) not between 3 and 2000 then
    raise exception 'glossary correction reason required' using errcode = '22023';
  end if;
  insert into public.glossary_term_versions (
    organization_id, term_id, version_number, translated_term, definition,
    correction_of_version_id, change_reason, created_by_user_id
  ) values (
    p_organization_id, v_term_id, coalesce(v_previous_version_number, 0) + 1,
    p_translated_term, p_definition, v_previous_version_id, p_reason,
    p_actor_user_id
  ) returning id into v_version_id;
  v_response := jsonb_build_object(
    'term_id', v_term_id,
    'term_version_id', v_version_id,
    'version_number', coalesce(v_previous_version_number, 0) + 1,
    'review_status', 'pending'
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/glossary/proposals',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_review_glossary_version_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_term_version_id uuid,
  p_decision text,
  p_note text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_term_id uuid;
  v_review_id uuid;
  v_reviewed_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'glossary.review', true, 900, '/v2/glossary/versions/:id/review',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'language.review', null
    )
    or p_decision not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'authorized glossary decision required' using errcode = '42501';
  end if;
  select version.term_id into v_term_id
  from public.glossary_term_versions version
  where version.organization_id = p_organization_id
    and version.id = p_term_version_id;
  if not found then raise exception 'glossary version not found' using errcode = 'P0002'; end if;
  insert into public.glossary_reviews (
    organization_id, term_id, term_version_id, reviewer_user_id, decision, note
  ) values (
    p_organization_id, v_term_id, p_term_version_id, p_actor_user_id,
    p_decision, p_note
  ) returning id, reviewed_at into v_review_id, v_reviewed_at;
  v_response := jsonb_build_object(
    'review_id', v_review_id,
    'term_id', v_term_id,
    'term_version_id', p_term_version_id,
    'decision', p_decision,
    'reviewed_at', v_reviewed_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/glossary/versions/:id/review',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_propose_translation_correction_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_target_language text,
  p_corrected_body text,
  p_rationale text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_correction_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'translation.correction.propose', false, 0,
    '/v2/messages/:id/translations/:language/corrections',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id)
    or not exists (
      select 1 from public.message_translations translation
      where translation.organization_id = p_organization_id
        and translation.conversation_id = p_conversation_id
        and translation.message_id = p_message_id
        and translation.target_language = p_target_language
        and translation.status = 'completed'
    ) then
    raise exception 'completed translation not found' using errcode = '42501';
  end if;
  if not private.consume_rate_limit(
    'translation-correction-hour', p_organization_id::text || ':' || p_actor_user_id::text, 60, 3600
  ) then
    raise exception 'translation correction rate limit exceeded' using errcode = 'P0001';
  end if;
  insert into public.translation_corrections (
    organization_id, conversation_id, message_id, target_language,
    corrected_body, rationale, proposed_by_user_id
  ) values (
    p_organization_id, p_conversation_id, p_message_id, p_target_language,
    p_corrected_body, p_rationale, p_actor_user_id
  ) returning id into v_correction_id;
  v_response := jsonb_build_object('correction_id', v_correction_id, 'status', 'pending');
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/messages/:id/translations/:language/corrections',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_review_translation_correction_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_correction_id uuid,
  p_decision text,
  p_note text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_unit_id uuid;
  v_reviewed_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'translation.correction.review', true, 900,
    '/v2/translation-corrections/:id/review',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select conversation.unit_id into v_unit_id
  from public.translation_corrections correction
  join public.conversations conversation
    on conversation.organization_id = correction.organization_id
   and conversation.id = correction.conversation_id
  where correction.organization_id = p_organization_id
    and correction.id = p_correction_id;
  if not found
    or not private.actor_has_permission(
      p_actor_user_id, p_organization_id, 'language.review', v_unit_id
    )
    or p_decision not in ('approved', 'rejected', 'changes_requested') then
    raise exception 'authorized correction decision required' using errcode = '42501';
  end if;
  update public.translation_corrections correction
  set status = p_decision,
      reviewed_by_user_id = p_actor_user_id,
      reviewed_at = now(),
      review_note = p_note
  where correction.organization_id = p_organization_id
    and correction.id = p_correction_id
    and correction.status = 'pending'
  returning correction.reviewed_at into v_reviewed_at;
  if not found then raise exception 'pending correction not found' using errcode = 'P0002'; end if;
  v_response := jsonb_build_object(
    'correction_id', p_correction_id,
    'decision', p_decision,
    'reviewed_at', v_reviewed_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id,
    '/v2/translation-corrections/:id/review',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_set_organization_ai_policy_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_enabled boolean, p_approved_use_cases text[], p_provider_allowlist text[],
  p_route_policy text, p_reason text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_command jsonb; v_version integer; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'ai.policy.set', true, 900, '/v2/admin/ai-policy',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.actor_has_permission(p_actor_user_id, p_organization_id, 'ai.policy.manage', null)
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500
    or cardinality(coalesce(p_approved_use_cases, array[]::text[])) not between 0 and 3
    or not (coalesce(p_approved_use_cases, array[]::text[]) <@
      array['language_detection', 'translation', 'summary']::text[])
    or cardinality(coalesce(p_provider_allowlist, array[]::text[])) not between 0 and 20
    or (p_enabled and (
      cardinality(p_approved_use_cases) = 0 or cardinality(p_provider_allowlist) = 0
      or p_route_policy <> 'approved_zero_retention'
    ))
    or (not p_enabled and p_route_policy <> 'deny')
    or exists (
      select 1 from unnest(coalesce(p_provider_allowlist, array[]::text[])) provider
      where provider !~ '^[a-z0-9][a-z0-9._/-]{1,159}$'
    ) then
    raise exception 'authorized valid tenant AI policy required' using errcode = '42501';
  end if;
  select coalesce(policy.policy_version, 0) + 1 into v_version
  from (select 1) seed
  left join public.organization_ai_policies policy
    on policy.organization_id = p_organization_id;
  insert into public.organization_ai_policies (
    organization_id, enabled, policy_version, approved_use_cases,
    provider_allowlist, route_policy, approved_by_user_id, approved_at,
    revoked_by_user_id, revoked_at, revocation_reason
  ) values (
    p_organization_id, p_enabled, v_version,
    case when p_enabled then array(select distinct lower(value) from unnest(p_approved_use_cases) value order by 1)
      else array[]::text[] end,
    case when p_enabled then array(select distinct lower(value) from unnest(p_provider_allowlist) value order by 1)
      else array[]::text[] end,
    p_route_policy,
    case when p_enabled then p_actor_user_id else null end,
    case when p_enabled then now() else null end,
    case when p_enabled then null else p_actor_user_id end,
    case when p_enabled then null else now() end,
    case when p_enabled then null else btrim(p_reason) end
  ) on conflict (organization_id) do update
  set enabled = excluded.enabled, policy_version = excluded.policy_version,
      approved_use_cases = excluded.approved_use_cases,
      provider_allowlist = excluded.provider_allowlist,
      route_policy = excluded.route_policy,
      approved_by_user_id = excluded.approved_by_user_id,
      approved_at = excluded.approved_at,
      revoked_by_user_id = excluded.revoked_by_user_id,
      revoked_at = excluded.revoked_at,
      revocation_reason = excluded.revocation_reason,
      updated_at = now();
  v_response := jsonb_build_object(
    'organization_id', p_organization_id, 'enabled', p_enabled,
    'policy_version', v_version,
    'approved_use_cases', case when p_enabled then to_jsonb(p_approved_use_cases) else '[]'::jsonb end,
    'provider_allowlist', case when p_enabled then to_jsonb(p_provider_allowlist) else '[]'::jsonb end,
    'route_policy', p_route_policy,
    'tenant_approved', p_enabled,
    'global_kill_switch_still_required', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/ai-policy',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_get_organization_preferences_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'organization.preferences.read', false, 0
  );
  select jsonb_build_object(
    'organization_id', p_organization_id,
    'user_id', p_actor_user_id,
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
    'read_visibility', coalesce(preference.read_visibility, 'everyone'),
    'updated_at', preference.updated_at
  ) into v_result
  from public.profiles profile
  left join public.organization_user_preferences preference
    on preference.organization_id = p_organization_id
   and preference.user_id = p_actor_user_id
  where profile.user_id = p_actor_user_id;
  return v_result;
end;
$$;

create or replace function private.bff_update_organization_preferences_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_patch jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_existing public.organization_user_preferences%rowtype;
  v_result public.organization_user_preferences%rowtype;
  v_quiet_days smallint[];
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'organization.preferences.update', false, 0,
    '/v2/preferences/organization', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
    or exists (
      select 1 from jsonb_object_keys(p_patch) key
      where key not in (
        'ui_language', 'message_language', 'time_zone', 'quiet_hours_start',
        'quiet_hours_end', 'quiet_days', 'notification_preview',
        'sound_enabled', 'vibration_enabled', 'shift_aware_suppression',
        'read_visibility'
      )
    )
    or ((p_patch ? 'quiet_hours_start') <> (p_patch ? 'quiet_hours_end'))
    or (p_patch ? 'notification_preview'
      and p_patch ->> 'notification_preview' not in ('generic', 'hidden'))
    or exists (
      select 1 from (values ('sound_enabled'), ('vibration_enabled'), ('shift_aware_suppression')) boolean_key(name)
      where p_patch ? boolean_key.name
        and jsonb_typeof(p_patch -> boolean_key.name) <> 'boolean'
    )
    or (p_patch ? 'quiet_days' and jsonb_typeof(p_patch -> 'quiet_days') <> 'array') then
    raise exception 'invalid organization preference patch' using errcode = '22023';
  end if;
  if p_patch ? 'time_zone' and not exists (
    select 1 from pg_catalog.pg_timezone_names zone
    where zone.name = p_patch ->> 'time_zone'
  ) then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;
  if p_patch ? 'quiet_days' then
    begin
      select array_agg(distinct day_value::smallint order by day_value::smallint)
        into v_quiet_days
      from jsonb_array_elements_text(p_patch -> 'quiet_days') day_value;
    exception when others then
      raise exception 'invalid quiet days' using errcode = '22023';
    end;
  end if;
  select * into v_existing
  from public.organization_user_preferences preference
  where preference.organization_id = p_organization_id
    and preference.user_id = p_actor_user_id;
  insert into public.organization_user_preferences (
    organization_id, user_id, ui_language, message_language, time_zone,
    quiet_hours_start, quiet_hours_end, quiet_days, notification_preview,
    sound_enabled, vibration_enabled, shift_aware_suppression, read_visibility
  ) values (
    p_organization_id, p_actor_user_id,
    case when p_patch ? 'ui_language' then p_patch ->> 'ui_language'
      else coalesce(v_existing.ui_language, 'en') end,
    case when p_patch ? 'message_language' then nullif(p_patch ->> 'message_language', '')
      else v_existing.message_language end,
    case when p_patch ? 'time_zone' then p_patch ->> 'time_zone'
      else coalesce(v_existing.time_zone, 'UTC') end,
    case when p_patch ? 'quiet_hours_start' and p_patch -> 'quiet_hours_start' <> 'null'::jsonb
      then (p_patch ->> 'quiet_hours_start')::time else v_existing.quiet_hours_start end,
    case when p_patch ? 'quiet_hours_end' and p_patch -> 'quiet_hours_end' <> 'null'::jsonb
      then (p_patch ->> 'quiet_hours_end')::time else v_existing.quiet_hours_end end,
    coalesce(v_quiet_days, v_existing.quiet_days, array[0,1,2,3,4,5,6]::smallint[]),
    case when p_patch ? 'notification_preview' then p_patch ->> 'notification_preview'
      else coalesce(v_existing.notification_preview, 'generic') end,
    case when p_patch ? 'sound_enabled' then (p_patch ->> 'sound_enabled')::boolean
      else coalesce(v_existing.sound_enabled, true) end,
    case when p_patch ? 'vibration_enabled' then (p_patch ->> 'vibration_enabled')::boolean
      else coalesce(v_existing.vibration_enabled, true) end,
    case when p_patch ? 'shift_aware_suppression' then (p_patch ->> 'shift_aware_suppression')::boolean
      else coalesce(v_existing.shift_aware_suppression, false) end,
    case when p_patch ? 'read_visibility' then p_patch ->> 'read_visibility'
      else coalesce(v_existing.read_visibility, 'everyone') end
  )
  on conflict (organization_id, user_id) do update set
    ui_language = excluded.ui_language,
    message_language = excluded.message_language,
    time_zone = excluded.time_zone,
    quiet_hours_start = case when p_patch ? 'quiet_hours_start'
      then case when p_patch -> 'quiet_hours_start' = 'null'::jsonb then null else excluded.quiet_hours_start end
      else public.organization_user_preferences.quiet_hours_start end,
    quiet_hours_end = case when p_patch ? 'quiet_hours_end'
      then case when p_patch -> 'quiet_hours_end' = 'null'::jsonb then null else excluded.quiet_hours_end end
      else public.organization_user_preferences.quiet_hours_end end,
    quiet_days = excluded.quiet_days,
    notification_preview = excluded.notification_preview,
    sound_enabled = excluded.sound_enabled,
    vibration_enabled = excluded.vibration_enabled,
    shift_aware_suppression = excluded.shift_aware_suppression,
    read_visibility = excluded.read_visibility,
    updated_at = now()
  returning * into v_result;
  v_response := to_jsonb(v_result) - 'organization_id' - 'user_id';
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/preferences/organization',
    p_idempotency_key, p_request_sha256,
    jsonb_build_object('organization_id', p_organization_id, 'user_id', p_actor_user_id) || v_response
  );
end;
$$;

create or replace function private.bff_update_saved_contact_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_contact_user_id uuid, p_patch jsonb, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_contact public.saved_contacts%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'saved_contact.update', false, 0, '/v2/contacts/saved/:id',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_contact_user_id = p_actor_user_id
    or not private.can_view_org_member(p_organization_id, p_contact_user_id)
    or jsonb_typeof(p_patch) <> 'object'
    or exists (select 1 from jsonb_object_keys(p_patch) key where key not in ('alias', 'is_favorite'))
    or (p_patch ? 'is_favorite' and jsonb_typeof(p_patch -> 'is_favorite') <> 'boolean') then
    raise exception 'visible saved contact and valid patch required' using errcode = '42501';
  end if;
  insert into public.saved_contacts (
    organization_id, owner_user_id, contact_user_id, alias, is_favorite
  ) values (
    p_organization_id, p_actor_user_id, p_contact_user_id,
    case when p_patch ? 'alias' then nullif(btrim(p_patch ->> 'alias'), '') else null end,
    case when p_patch ? 'is_favorite' then (p_patch ->> 'is_favorite')::boolean else false end
  ) on conflict (organization_id, owner_user_id, contact_user_id) do update set
    alias = case when p_patch ? 'alias' then nullif(btrim(p_patch ->> 'alias'), '')
      else public.saved_contacts.alias end,
    is_favorite = case when p_patch ? 'is_favorite' then (p_patch ->> 'is_favorite')::boolean
      else public.saved_contacts.is_favorite end,
    updated_at = now()
  returning * into v_contact;
  v_response := jsonb_build_object(
    'contact_user_id', p_contact_user_id,
    'alias', v_contact.alias,
    'is_favorite', v_contact.is_favorite,
    'saved', true,
    'updated_at', v_contact.updated_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/contacts/saved/:id',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_remove_saved_contact_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_contact_user_id uuid, p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_command jsonb; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'saved_contact.remove', false, 0, '/v2/contacts/saved/:id/delete',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  delete from public.saved_contacts contact
  where contact.organization_id = p_organization_id
    and contact.owner_user_id = p_actor_user_id
    and contact.contact_user_id = p_contact_user_id;
  v_response := jsonb_build_object('contact_user_id', p_contact_user_id, 'removed', true);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/contacts/saved/:id/delete',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_set_member_block_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_target_user_id uuid, p_blocked boolean, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_command jsonb; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'member.block.set', false, 0, '/v2/people/:id/block',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if p_target_user_id = p_actor_user_id or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_target_user_id
      and membership.status = 'active'
  ) then
    raise exception 'active block target required' using errcode = '42501';
  end if;
  if p_blocked then
    insert into public.member_blocks (organization_id, blocker_user_id, blocked_user_id)
    values (p_organization_id, p_actor_user_id, p_target_user_id)
    on conflict do nothing;
  else
    delete from public.member_blocks block
    where block.organization_id = p_organization_id
      and block.blocker_user_id = p_actor_user_id
      and block.blocked_user_id = p_target_user_id;
  end if;
  v_response := jsonb_build_object('target_user_id', p_target_user_id, 'blocked', p_blocked);
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/people/:id/block',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_grant_role_assignment_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_target_user_id uuid, p_role_name text, p_scope_type text,
  p_unit_id uuid, p_expires_at timestamptz, p_reason text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_actor_legacy_role text;
  v_assignment_id uuid;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'role_assignment.grant', true, 900, '/v2/admin/role-assignments',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select membership.role into v_actor_legacy_role
  from public.organization_memberships membership
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';
  if not private.actor_has_permission(p_actor_user_id, p_organization_id, 'roles.manage', null)
    or not exists (
      select 1 from public.organization_memberships target
      where target.organization_id = p_organization_id
        and target.user_id = p_target_user_id
        and target.status = 'active'
    )
    or not exists (select 1 from public.organization_roles role where role.role_name = p_role_name)
    or p_scope_type not in ('organization', 'unit')
    or ((p_scope_type = 'organization') <> (p_unit_id is null))
    or (p_unit_id is not null and not exists (
      select 1 from public.organization_units unit
      where unit.organization_id = p_organization_id and unit.id = p_unit_id and unit.is_active
    ))
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500
    or (p_expires_at is not null and p_expires_at <= now()) then
    raise exception 'valid scoped role grant required' using errcode = '42501';
  end if;
  if p_role_name in ('security_admin', 'people_admin', 'communications_publisher', 'designated_investigator')
    and (v_actor_legacy_role <> 'owner' or p_scope_type <> 'organization') then
    raise exception 'only an owner may grant sensitive organization roles' using errcode = '42501';
  end if;
  if p_role_name = 'site_admin' and p_scope_type <> 'unit' then
    raise exception 'site administrator must be unit-scoped' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_role_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_target_user_id
      and assignment.role_name = p_role_name
      and assignment.scope_type = p_scope_type
      and assignment.unit_id is not distinct from p_unit_id
      and assignment.revoked_at is null
  ) then
    raise exception 'active role assignment already exists' using errcode = '23505';
  end if;
  insert into public.organization_role_assignments (
    organization_id, user_id, role_name, scope_type, unit_id,
    granted_by_user_id, grant_reason, expires_at
  ) values (
    p_organization_id, p_target_user_id, p_role_name, p_scope_type,
    p_unit_id, p_actor_user_id, btrim(p_reason), p_expires_at
  ) returning id into v_assignment_id;
  v_response := jsonb_build_object(
    'assignment_id', v_assignment_id,
    'user_id', p_target_user_id,
    'role_name', p_role_name,
    'scope_type', p_scope_type,
    'unit_id', p_unit_id,
    'expires_at', p_expires_at,
    'active', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/role-assignments',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_revoke_role_assignment_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_assignment_id uuid, p_reason text, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_command jsonb; v_role_name text; v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'role_assignment.revoke', true, 900, '/v2/admin/role-assignments/:id/revoke',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.actor_has_permission(p_actor_user_id, p_organization_id, 'roles.manage', null)
    or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'role revocation permission and reason required' using errcode = '42501';
  end if;
  update public.organization_role_assignments assignment
  set revoked_at = now(), revoked_by_user_id = p_actor_user_id,
      revocation_reason = btrim(p_reason)
  where assignment.organization_id = p_organization_id
    and assignment.id = p_assignment_id
    and assignment.revoked_at is null
  returning assignment.role_name into v_role_name;
  if not found then raise exception 'active role assignment not found' using errcode = 'P0002'; end if;
  v_response := jsonb_build_object(
    'assignment_id', p_assignment_id, 'role_name', v_role_name, 'active', false
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/admin/role-assignments/:id/revoke',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_list_role_assignments_impl(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_target_user_id uuid, p_limit integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_assignments jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'role_assignment.list', true, 900
  );
  if p_limit not between 1 and 100
    or not (
      p_target_user_id = p_actor_user_id
      or private.actor_has_permission(p_actor_user_id, p_organization_id, 'roles.read', null)
    ) then
    raise exception 'role assignment read not permitted' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'assignment_id', assignment.id,
    'user_id', assignment.user_id,
    'role_name', assignment.role_name,
    'scope_type', assignment.scope_type,
    'unit_id', assignment.unit_id,
    'granted_at', assignment.granted_at,
    'expires_at', assignment.expires_at,
    'revoked_at', assignment.revoked_at,
    'active', assignment.revoked_at is null and (assignment.expires_at is null or assignment.expires_at > now())
  ) order by assignment.granted_at desc), '[]'::jsonb)
  into v_assignments
  from (
    select * from public.organization_role_assignments assignment
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_target_user_id
    order by assignment.granted_at desc
    limit p_limit
  ) assignment;
  return jsonb_build_object('assignments', v_assignments);
end;
$$;

create or replace function private.bff_resolve_push_job_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_after_device_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_deliveries jsonb;
  v_has_more boolean;
  v_next_device_id uuid;
  v_event jsonb;
  v_quiet_hours_override boolean := false;
begin
  perform private.require_service_role();
  if p_limit not between 1 and 1000 then
    raise exception 'invalid push delivery page size' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'push'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now();
  if not found then raise exception 'active push lease required' using errcode = '42501'; end if;
  if v_job.payload ? 'announcement_id' and v_job.payload ? 'announcement_version_id' then
    select exists (
      select 1
      from public.announcements announcement
      join public.announcement_versions version
        on version.organization_id = announcement.organization_id
       and version.announcement_id = announcement.id
      where announcement.organization_id = v_job.organization_id
        and announcement.id = nullif(v_job.payload ->> 'announcement_id', '')::uuid
        and announcement.status in ('published', 'archived')
        and version.id = nullif(v_job.payload ->> 'announcement_version_id', '')::uuid
        and version.notification_class in ('urgent', 'critical')
        and version.critical_category
          in ('safety', 'security', 'operations', 'weather', 'business_continuity')
        and char_length(btrim(coalesce(version.quiet_hours_override_reason, '')))
          between 3 and 500
        and v_job.payload ->> 'notification_class' = version.notification_class
        and v_job.payload ->> 'critical_category' = version.critical_category
        and v_job.payload ->> 'quiet_hours_override_reason' =
          version.quiet_hours_override_reason
        and not exists (
          select 1
          from public.announcement_versions newer
          where newer.organization_id = version.organization_id
            and newer.announcement_id = version.announcement_id
            and newer.version_number > version.version_number
        )
    ) into v_quiet_hours_override;
  end if;
  v_event := jsonb_strip_nulls(jsonb_build_object(
    'event_type', case
      when v_job.payload ? 'announcement_id' then 'announcement.changed'
      when v_job.payload ? 'handoff_id' then 'handoff.changed'
      when v_job.payload ? 'message_id' then 'message.changed'
      when v_job.payload ? 'conversation_id' then 'conversation.changed'
      else 'organization.changed'
    end,
    'organization_id', v_job.organization_id,
    'conversation_id', v_job.payload -> 'conversation_id',
    'message_id', v_job.payload -> 'message_id',
    'announcement_id', v_job.payload -> 'announcement_id',
    'announcement_version_id', v_job.payload -> 'announcement_version_id',
    'handoff_id', v_job.payload -> 'handoff_id',
    'state', v_job.payload -> 'state'
  ));
  with eligible_users as (
    select member.user_id
    from public.conversation_members member
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where member.organization_id = v_job.organization_id
      and member.status = 'active'
      and member.conversation_id = nullif(v_job.payload ->> 'conversation_id', '')::uuid
    union
    select recipient.user_id
    from public.announcement_recipients recipient
    join public.organization_memberships organization_member
      on organization_member.organization_id = recipient.organization_id
     and organization_member.user_id = recipient.user_id
     and organization_member.status = 'active'
    where recipient.organization_id = v_job.organization_id
      and recipient.announcement_id = nullif(v_job.payload ->> 'announcement_id', '')::uuid
      and (
        not (v_job.payload ? 'target_user_id')
        or recipient.user_id = nullif(v_job.payload ->> 'target_user_id', '')::uuid
      )
    union
    select member.user_id
    from public.shift_handoffs handoff
    join public.conversation_members member
      on member.organization_id = handoff.organization_id
     and member.conversation_id = handoff.conversation_id
     and member.status = 'active'
    join public.organization_memberships organization_member
      on organization_member.organization_id = member.organization_id
     and organization_member.user_id = member.user_id
     and organization_member.status = 'active'
    where handoff.organization_id = v_job.organization_id
      and handoff.id = nullif(v_job.payload ->> 'handoff_id', '')::uuid
  ), candidate_devices as (
    select device.*, preference.notification_preview, preference.sound_enabled,
      preference.vibration_enabled, preference.shift_aware_suppression,
      preference.time_zone, preference.quiet_hours_start,
      preference.quiet_hours_end, preference.quiet_days
    from public.device_registrations device
    join eligible_users eligible on eligible.user_id = device.user_id
    join auth.sessions device_session
      on device_session.id = device.session_id
     and device_session.user_id = device.user_id
    join auth.users device_user on device_user.id = device_session.user_id
    join private.session_installations session_binding
      on session_binding.session_id = device_session.id
     and session_binding.user_id = device.user_id
     and session_binding.installation_id = device.installation_id
     and session_binding.platform = device.platform
     and session_binding.revoked_at is null
    left join private.push_delivery_attempts existing_attempt
      on existing_attempt.outbox_job_id = p_job_id
     and existing_attempt.device_id = device.id
    left join private.session_revocations session_revocation
      on session_revocation.organization_id = device.organization_id
     and session_revocation.session_id = device_session.id
    left join public.organization_user_preferences preference
      on preference.organization_id = device.organization_id
     and preference.user_id = device.user_id
    where device.organization_id = v_job.organization_id
      and device.revoked_at is null
      and session_revocation.session_id is null
      and (device_session.not_after is null or device_session.not_after > now())
      and (device_user.banned_until is null or device_user.banned_until <= now())
      and (
        nullif(v_job.payload ->> 'conversation_id', '') is null
        or v_quiet_hours_override
        or exists (
          select 1
          from public.conversation_members notification_member
          join public.conversations notification_conversation
            on notification_conversation.organization_id = notification_member.organization_id
           and notification_conversation.id = notification_member.conversation_id
          left join public.conversation_preferences notification_preference
            on notification_preference.organization_id = notification_member.organization_id
           and notification_preference.conversation_id = notification_member.conversation_id
           and notification_preference.user_id = notification_member.user_id
          where notification_member.organization_id = v_job.organization_id
            and notification_member.conversation_id =
              nullif(v_job.payload ->> 'conversation_id', '')::uuid
            and notification_member.user_id = device.user_id
            and notification_member.status = 'active'
            and coalesce(
              notification_preference.notification_level,
              notification_member.notification_level,
              'all'
            ) <> 'none'
            and (
              case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end is null
              or case when notification_preference.user_id is not null
                then notification_preference.muted_until
                else notification_member.muted_until
              end <= now()
            )
            and (
              coalesce(
                notification_preference.notification_level,
                notification_member.notification_level,
                'all'
              ) <> 'mentions'
              or (
                v_job.payload ? 'message_id'
                and not (v_job.payload ? 'announcement_id')
                and not (v_job.payload ? 'handoff_id')
                and (
                  notification_conversation.kind = 'direct'
                  or exists (
                    select 1
                    from public.message_mentions mention
                    where mention.organization_id = v_job.organization_id
                      and mention.conversation_id = notification_member.conversation_id
                      and mention.message_id = (v_job.payload ->> 'message_id')::bigint
                      and mention.mentioned_user_id = device.user_id
                  )
                )
              )
            )
            and (
              not (v_job.payload ? 'message_id')
              or v_job.payload ? 'announcement_id'
              or v_job.payload ? 'handoff_id'
              or exists (
                select 1
                from public.messages pushed_message
                where pushed_message.organization_id = v_job.organization_id
                  and pushed_message.conversation_id = notification_member.conversation_id
                  and pushed_message.id = (v_job.payload ->> 'message_id')::bigint
                  and pushed_message.sender_user_id <> device.user_id
              )
            )
        )
      )
      and (
        existing_attempt.id is null
        or existing_attempt.status = 'pending'
        or (
          existing_attempt.status = 'retry_wait'
          and existing_attempt.next_attempt_at <= now()
        )
      )
      and (p_after_device_id is null or device.id > p_after_device_id)
    order by device.id
    limit p_limit + 1
  ), inserted_attempts as (
    insert into private.push_delivery_attempts (
      organization_id, outbox_job_id, device_id, user_id
    )
    select v_job.organization_id, p_job_id, candidate.id, candidate.user_id
    from candidate_devices candidate
    on conflict (outbox_job_id, device_id) do nothing
    returning id, device_id, status, next_attempt_at
  ), attempt_rows as (
    select inserted.id, inserted.device_id, inserted.status, inserted.next_attempt_at
    from inserted_attempts inserted
    union all
    select attempt.id, attempt.device_id, attempt.status, attempt.next_attempt_at
    from private.push_delivery_attempts attempt
    join candidate_devices candidate on candidate.id = attempt.device_id
    where attempt.outbox_job_id = p_job_id
      and not exists (
        select 1 from inserted_attempts inserted where inserted.device_id = attempt.device_id
      )
  ), page as (
    select candidate.*, attempt.id as attempt_id, attempt.status as dispatch_status,
      attempt.next_attempt_at
    from candidate_devices candidate
    join attempt_rows attempt on attempt.device_id = candidate.id
  ), numbered as (
    select page.*, row_number() over (order by page.id) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'device_id', numbered.id,
      'attempt_id', numbered.attempt_id,
      'dispatch_status', numbered.dispatch_status,
      'dispatchable', true,
      'next_attempt_at', numbered.next_attempt_at,
      'user_id', numbered.user_id,
      'installation_id', numbered.installation_id,
      'platform', numbered.platform,
      'push_token_ciphertext', numbered.push_token_ciphertext,
      'push_token_type', numbered.push_token_type,
      'push_project_id', numbered.push_project_id,
      'push_environment', numbered.push_environment,
      'locale', numbered.locale,
      'app_version', numbered.app_version,
      'currently_off_shift', private.currently_off_shift_internal(
        v_job.organization_id, numbered.user_id, now()
      ),
      'notification_class', case when v_quiet_hours_override
        then v_job.payload ->> 'notification_class' else 'routine' end,
      'critical_category', case when v_quiet_hours_override
        then v_job.payload ->> 'critical_category' else null end,
      'quiet_hours_override', v_quiet_hours_override,
      'quiet_hours_override_reason', case
        when v_quiet_hours_override
          then v_job.payload ->> 'quiet_hours_override_reason'
        else null
      end,
      'preferences', jsonb_build_object(
        'notification_preview', coalesce(numbered.notification_preview, 'generic'),
        'sound_enabled', coalesce(numbered.sound_enabled, true),
        'vibration_enabled', coalesce(numbered.vibration_enabled, true),
        'shift_aware_suppression', coalesce(numbered.shift_aware_suppression, false),
        'time_zone', coalesce(numbered.time_zone, 'UTC'),
        'quiet_hours_start', numbered.quiet_hours_start,
        'quiet_hours_end', numbered.quiet_hours_end,
        'quiet_days', coalesce(to_jsonb(numbered.quiet_days), '[0,1,2,3,4,5,6]'::jsonb)
      )
    ) order by numbered.id) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    (array_agg(numbered.id order by numbered.id)
      filter (where numbered.row_number = p_limit))[1]
  into v_deliveries, v_has_more, v_next_device_id
  from numbered;
  if not v_has_more then
    update private.outbox_jobs job
    set payload = job.payload || jsonb_build_object(
          'fanout_resolved', true,
          'fanout_count', (
            select count(*) from private.push_delivery_attempts attempt
            where attempt.outbox_job_id = p_job_id
          )
        ),
        updated_at = now()
    where job.id = p_job_id
      and job.claimed_by = p_worker_id
      and job.status = 'processing';
  end if;
  return jsonb_build_object(
    'job_id', p_job_id,
    'event', v_event,
    'deliveries', v_deliveries,
    'has_more', v_has_more,
    'next_device_id', case when v_has_more then v_next_device_id else null end
  );
end;
$$;

create or replace function private.bff_record_push_submission_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_attempt_id bigint,
  p_result text,
  p_provider_ticket_id text,
  p_error_code text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_attempt private.push_delivery_attempts%rowtype;
  v_next_status text;
begin
  perform private.require_service_role();
  if p_result not in ('accepted', 'transient_failure', 'permanent_failure', 'device_not_registered')
    or (p_result = 'accepted' and char_length(coalesce(p_provider_ticket_id, '')) not between 1 and 500)
    or (p_result <> 'accepted' and char_length(coalesce(p_error_code, '')) not between 1 and 120) then
    raise exception 'invalid push submission result' using errcode = '22023';
  end if;
  select attempt.* into v_attempt
  from private.push_delivery_attempts attempt
  join private.outbox_jobs job on job.id = attempt.outbox_job_id
  where attempt.id = p_attempt_id
    and attempt.outbox_job_id = p_job_id
    and job.topic = 'push'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update of attempt;
  if not found then raise exception 'active push attempt lease required' using errcode = '42501'; end if;
  if v_attempt.status in ('provider_accepted', 'delivered')
    and p_result = 'accepted'
    and v_attempt.provider_ticket_id = p_provider_ticket_id then
    return jsonb_build_object(
      'attempt_id', v_attempt.id,
      'status', v_attempt.status,
      'provider_accepted', true,
      'delivered', v_attempt.status = 'delivered'
    );
  end if;
  if v_attempt.status not in ('pending', 'retry_wait')
    or (v_attempt.status = 'retry_wait' and v_attempt.next_attempt_at > now()) then
    raise exception 'push attempt is not dispatchable' using errcode = '55000';
  end if;
  v_next_status := case p_result
    when 'accepted' then 'provider_accepted'
    when 'device_not_registered' then 'device_unregistered'
    when 'permanent_failure' then 'permanent_failure'
    when 'transient_failure' then
      case when v_attempt.attempt_count + 1 >= 5 then 'permanent_failure' else 'retry_wait' end
  end;
  update private.push_delivery_attempts attempt
  set status = v_next_status,
      attempt_count = attempt.attempt_count + 1,
      provider_ticket_id = case when p_result = 'accepted' then p_provider_ticket_id else null end,
      provider_accepted_at = case when p_result = 'accepted' then now() else null end,
      next_attempt_at = case when v_next_status = 'retry_wait'
        then now() + make_interval(secs => least(300, 5 * (2 ^ least(attempt.attempt_count, 6))::integer))
        else attempt.next_attempt_at end,
      next_receipt_check_at = case when p_result = 'accepted' then now() + interval '15 minutes' else null end,
      failed_at = case when v_next_status in ('permanent_failure', 'device_unregistered') then now() else null end,
      last_error_code = case when p_result = 'accepted' then null else p_error_code end,
      receipt_claimed_by = null,
      receipt_claimed_until = null,
      updated_at = now()
  where attempt.id = p_attempt_id
  returning * into v_attempt;
  if v_next_status = 'device_unregistered' then
    update public.device_registrations device
    set revoked_at = coalesce(device.revoked_at, now()), updated_at = now()
    where device.organization_id = v_attempt.organization_id
      and device.id = v_attempt.device_id;
  end if;
  return jsonb_build_object(
    'attempt_id', v_attempt.id,
    'status', v_attempt.status,
    'attempt_count', v_attempt.attempt_count,
    'provider_accepted', v_attempt.status = 'provider_accepted',
    'delivered', false,
    'retry_at', case when v_attempt.status = 'retry_wait' then v_attempt.next_attempt_at else null end,
    'device_revoked', v_attempt.status = 'device_unregistered'
  );
end;
$$;

create or replace function private.bff_claim_push_receipts_impl(
  p_worker_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare v_receipts jsonb;
begin
  perform private.require_service_role();
  if p_worker_id is null or p_limit not between 1 and 500
    or p_lease_seconds not between 15 and 300 then
    raise exception 'invalid push receipt claim' using errcode = '22023';
  end if;
  with candidates as (
    select attempt.id
    from private.push_delivery_attempts attempt
    where attempt.status = 'provider_accepted'
      and attempt.next_receipt_check_at <= now()
      and (attempt.receipt_claimed_until is null or attempt.receipt_claimed_until <= now())
    order by attempt.next_receipt_check_at, attempt.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.push_delivery_attempts attempt
    set receipt_claimed_by = p_worker_id,
        receipt_claimed_until = now() + make_interval(secs => p_lease_seconds),
        updated_at = now()
    from candidates
    where attempt.id = candidates.id
    returning attempt.id, attempt.organization_id, attempt.outbox_job_id,
      attempt.device_id, attempt.provider_ticket_id, attempt.provider_accepted_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'attempt_id', claimed.id,
    'organization_id', claimed.organization_id,
    'job_id', claimed.outbox_job_id,
    'device_id', claimed.device_id,
    'provider_ticket_id', claimed.provider_ticket_id,
    'provider_accepted_at', claimed.provider_accepted_at
  ) order by claimed.id), '[]'::jsonb)
  into v_receipts from claimed;
  return jsonb_build_object('receipts', v_receipts);
end;
$$;

create or replace function private.bff_record_push_receipt_impl(
  p_worker_id uuid,
  p_attempt_id bigint,
  p_result text,
  p_error_code text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_attempt private.push_delivery_attempts%rowtype;
  v_status text;
begin
  perform private.require_service_role();
  if p_result not in ('delivered', 'pending', 'permanent_failure', 'device_not_registered', 'expired')
    or (p_result in ('permanent_failure', 'device_not_registered', 'expired')
      and char_length(coalesce(p_error_code, '')) not between 1 and 120) then
    raise exception 'invalid push receipt result' using errcode = '22023';
  end if;
  select * into v_attempt from private.push_delivery_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.status = 'provider_accepted'
    and attempt.receipt_claimed_by = p_worker_id
    and attempt.receipt_claimed_until > now()
  for update;
  if not found then raise exception 'active push receipt lease required' using errcode = '42501'; end if;
  v_status := case p_result
    when 'delivered' then 'delivered'
    when 'pending' then 'provider_accepted'
    when 'permanent_failure' then 'permanent_failure'
    when 'device_not_registered' then 'device_unregistered'
    when 'expired' then 'receipt_expired'
  end;
  update private.push_delivery_attempts attempt
  set status = v_status,
      next_receipt_check_at = case when p_result = 'pending' then now() + interval '60 seconds' else null end,
      delivered_at = case when p_result = 'delivered' then now() else null end,
      failed_at = case when p_result in ('permanent_failure', 'device_not_registered', 'expired') then now() else null end,
      last_error_code = case when p_result in ('permanent_failure', 'device_not_registered', 'expired') then p_error_code else null end,
      receipt_claimed_by = null,
      receipt_claimed_until = null,
      updated_at = now()
  where attempt.id = p_attempt_id
  returning * into v_attempt;
  if v_status = 'device_unregistered' then
    update public.device_registrations device
    set revoked_at = coalesce(device.revoked_at, now()), updated_at = now()
    where device.organization_id = v_attempt.organization_id
      and device.id = v_attempt.device_id;
  end if;
  return jsonb_build_object(
    'attempt_id', v_attempt.id,
    'status', v_attempt.status,
    'provider_accepted', v_attempt.provider_accepted_at is not null,
    'delivered', v_attempt.status = 'delivered',
    'device_revoked', v_attempt.status = 'device_unregistered',
    'next_receipt_check_at', v_attempt.next_receipt_check_at
  );
end;
$$;

create or replace function private.bff_complete_push_dispatch_job_impl(
  p_worker_id uuid,
  p_job_id bigint
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_counts jsonb;
begin
  perform private.require_service_role();
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'push'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then raise exception 'active push lease required' using errcode = '42501'; end if;
  -- Reconcile the narrow race where a page was resolved before a session or
  -- device was revoked. This keeps completion fail-closed without leaving the
  -- job permanently blocked by an attempt that may no longer be dispatched.
  update private.push_delivery_attempts attempt
  set status = 'device_unregistered',
      failed_at = coalesce(attempt.failed_at, now()),
      last_error_code = coalesce(attempt.last_error_code, 'device_session_revoked'),
      receipt_claimed_by = null,
      receipt_claimed_until = null,
      updated_at = now()
  where attempt.outbox_job_id = p_job_id
    and attempt.status in ('pending', 'retry_wait')
    and not exists (
      select 1
      from public.device_registrations device
      join auth.sessions device_session
        on device_session.id = device.session_id
       and device_session.user_id = device.user_id
      join auth.users device_user on device_user.id = device_session.user_id
      join private.session_installations session_binding
        on session_binding.session_id = device_session.id
       and session_binding.user_id = device.user_id
       and session_binding.installation_id = device.installation_id
       and session_binding.platform = device.platform
       and session_binding.revoked_at is null
      where device.organization_id = attempt.organization_id
        and device.id = attempt.device_id
        and device.user_id = attempt.user_id
        and device.revoked_at is null
        and (device_session.not_after is null or device_session.not_after > now())
        and (device_user.banned_until is null or device_user.banned_until <= now())
        and not exists (
          select 1 from private.session_revocations revocation
          where revocation.organization_id = device.organization_id
            and revocation.session_id = device_session.id
        )
    );
  if coalesce((v_job.payload ->> 'fanout_resolved')::boolean, false) is not true
    or exists (
      select 1 from private.push_delivery_attempts attempt
      where attempt.outbox_job_id = p_job_id
        and attempt.status in ('pending', 'retry_wait')
    ) then
    raise exception 'push dispatch is not complete' using errcode = '55000';
  end if;
  select coalesce(jsonb_object_agg(status, count), '{}'::jsonb) into v_counts
  from (
    select attempt.status, count(*)::integer as count
    from private.push_delivery_attempts attempt
    where attempt.outbox_job_id = p_job_id
    group by attempt.status
  ) grouped;
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
  return jsonb_build_object(
    'job_id', p_job_id,
    'dispatch_completed', true,
    'provider_delivery_pending', coalesce((v_counts ->> 'provider_accepted')::integer, 0),
    'counts', v_counts
  );
end;
$$;

create or replace function private.bff_execute_session_revoke_job_impl(
  p_worker_id uuid,
  p_job_id bigint
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_revoked integer := 0;
  v_devices_revoked integer := 0;
  v_bindings_revoked integer := 0;
begin
  perform private.require_service_role();
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'session_revoke'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
  for update;
  if not found then raise exception 'active session-revocation lease required' using errcode = '42501'; end if;
  if v_job.payload ? 'session_id' then
    update private.session_installations binding
    set revoked_at = coalesce(binding.revoked_at, now())
    where binding.session_id = (v_job.payload ->> 'session_id')::uuid
      and binding.revoked_at is null;
    get diagnostics v_bindings_revoked = row_count;
    update public.device_registrations device
    set revoked_at = coalesce(device.revoked_at, now())
    where device.organization_id = v_job.organization_id
      and device.session_id = (v_job.payload ->> 'session_id')::uuid
      and device.revoked_at is null;
    get diagnostics v_devices_revoked = row_count;
    delete from auth.sessions session
    where session.id = (v_job.payload ->> 'session_id')::uuid;
    get diagnostics v_revoked = row_count;
  elsif v_job.payload ? 'user_id' then
    update private.session_installations binding
    set revoked_at = coalesce(binding.revoked_at, now())
    where binding.user_id = (v_job.payload ->> 'user_id')::uuid
      and binding.revoked_at is null
      and exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = v_job.organization_id
          and revocation.user_id = binding.user_id
          and revocation.session_id = binding.session_id
      );
    get diagnostics v_bindings_revoked = row_count;
    update public.device_registrations device
    set revoked_at = coalesce(device.revoked_at, now())
    where device.organization_id = v_job.organization_id
      and device.user_id = (v_job.payload ->> 'user_id')::uuid
      and device.revoked_at is null
      and exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = v_job.organization_id
          and revocation.user_id = device.user_id
          and revocation.session_id = device.session_id
      );
    get diagnostics v_devices_revoked = row_count;
    delete from auth.sessions session
    using private.session_revocations revocation
    where revocation.organization_id = v_job.organization_id
      and revocation.user_id = (v_job.payload ->> 'user_id')::uuid
      and session.id = revocation.session_id;
    get diagnostics v_revoked = row_count;
  else
    raise exception 'invalid session-revocation payload' using errcode = '22023';
  end if;
  perform private.complete_outbox_job_internal(p_worker_id, p_job_id);
  return jsonb_build_object(
    'job_id', p_job_id,
    'revoked_session_count', v_revoked,
    'revoked_binding_count', v_bindings_revoked,
    'revoked_device_count', v_devices_revoked,
    'completed', true
  );
end;
$$;

create or replace function private.bff_claim_outbox_topics_impl(
  p_worker_id uuid,
  p_topics text[],
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_topics text[];
  v_jobs jsonb;
begin
  perform private.require_service_role();
  select array_agg(distinct topic order by topic) into v_topics
  from unnest(coalesce(p_topics, array[]::text[])) topic;
  if p_worker_id is null
    or p_limit not between 1 and 100
    or p_lease_seconds not between 15 and 900
    or cardinality(v_topics) not between 1 and 11
    or not (v_topics <@ array[
      'push', 'realtime_control', 'translation', 'language_detection', 'summary',
      'storage_scan', 'storage_purge', 'session_revoke', 'retention', 'moderation',
      'dynamic_group_sync'
    ]::text[]) then
    raise exception 'invalid topic-filtered outbox claim' using errcode = '22023';
  end if;
  with candidates as (
    select job.id
    from private.outbox_jobs job
    where job.topic = any(v_topics)
      and (
        (job.status in ('pending', 'failed') and job.available_at <= now())
        or (job.status = 'processing' and job.claimed_until <= now())
      )
    order by job.available_at, job.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update private.outbox_jobs job
    set status = 'processing',
        attempts = job.attempts + 1,
        claimed_by = p_worker_id,
        claimed_until = now() + make_interval(secs => p_lease_seconds),
        last_error_code = null,
        updated_at = now()
    from candidates
    where job.id = candidates.id
    returning job.id, job.organization_id, job.topic, job.payload, job.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', claimed.id,
    'organization_id', claimed.organization_id,
    'topic', claimed.topic,
    'payload', claimed.payload,
    'attempts', claimed.attempts
  ) order by claimed.id), '[]'::jsonb)
  into v_jobs from claimed;
  return jsonb_build_object('jobs', v_jobs, 'topics', to_jsonb(v_topics));
end;
$$;

create or replace function private.bff_search_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_query text,
  p_types text[],
  p_cursor text,
  p_limit integer,
  p_sender_user_id uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_types text[];
  v_query tsquery;
  v_query_hash text;
  v_types_hash text;
  v_filters_hash text;
  v_cursor_json jsonb;
  v_cursor_at timestamptz;
  v_cursor_type text;
  v_cursor_id text;
  v_results jsonb;
  v_has_more boolean;
  v_last_at timestamptz;
  v_last_type text;
  v_last_id text;
  v_next_cursor text;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'search.read', false, 0
  );
  if char_length(btrim(coalesce(p_query, ''))) not between 2 and 200
    or p_limit not between 1 and 50
    or (p_date_from is not null and p_date_to is not null and (
      p_date_to < p_date_from or p_date_to - p_date_from > interval '10 years'
    )) then
    raise exception 'invalid search request' using errcode = '22023';
  end if;
  select array_agg(distinct requested_type order by requested_type)
    into v_types
  from unnest(coalesce(
    p_types,
    array['people', 'conversations', 'messages', 'announcements', 'handoffs']::text[]
  )) requested_type;
  if cardinality(v_types) not between 1 and 5
    or not (v_types <@ array['people', 'conversations', 'messages', 'announcements', 'handoffs']::text[]) then
    raise exception 'invalid search entity types' using errcode = '22023';
  end if;
  v_query := websearch_to_tsquery(
    'simple', private.normalize_search_text(btrim(p_query))
  );
  if numnode(v_query) = 0 then
    raise exception 'search query has no searchable terms' using errcode = '22023';
  end if;
  v_query_hash := encode(
    extensions.digest(convert_to(lower(btrim(p_query)), 'UTF8'), 'sha256'), 'hex'
  );
  v_types_hash := encode(
    extensions.digest(convert_to(array_to_string(v_types, ','), 'UTF8'), 'sha256'), 'hex'
  );
  v_filters_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'sender_user_id', p_sender_user_id,
    'date_from', p_date_from,
    'date_to', p_date_to
  )::text, 'UTF8'), 'sha256'), 'hex');

  if p_cursor is not null then
    begin
      v_cursor_json := convert_from(decode(p_cursor, 'base64'), 'UTF8')::jsonb;
      v_cursor_at := (v_cursor_json ->> 'at')::timestamptz;
      v_cursor_type := v_cursor_json ->> 'type';
      v_cursor_id := v_cursor_json ->> 'id';
      if v_cursor_json ->> 'query_hash' <> v_query_hash
        or v_cursor_json ->> 'types_hash' <> v_types_hash
        or v_cursor_json ->> 'filters_hash' <> v_filters_hash
        or v_cursor_type is null or v_cursor_id is null then
        raise exception 'cursor binding mismatch';
      end if;
    exception when others then
      raise exception 'invalid search cursor' using errcode = '22023';
    end;
  end if;

  with searchable as (
    select
      'people'::text as entity_type,
      membership.user_id::text as entity_id,
      profile.display_name as title,
      left(coalesce(membership.job_title, profile.status_message, ''), 240) as snippet,
      'profile'::text as matched_source,
      profile.preferred_language as matched_language,
      null::uuid as conversation_id,
      membership.updated_at as occurred_at
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where 'people' = any(v_types)
      and p_sender_user_id is null
      and membership.organization_id = p_organization_id
      and membership.status = 'active'
      and (
        to_tsvector('simple', private.normalize_search_text(
          coalesce(profile.display_name, '') || ' ' || coalesce(profile.status_message, '')
        )) @@ v_query
        or to_tsvector('simple', private.normalize_search_text(
          coalesce(membership.job_title, '') || ' ' || coalesce(membership.employee_code, '')
        )) @@ v_query
      )
      and (
        membership.user_id = p_actor_user_id
        or exists (
          select 1 from public.organization_memberships viewer
          where viewer.organization_id = p_organization_id
            and viewer.user_id = p_actor_user_id
            and viewer.status = 'active'
            and viewer.role in ('owner', 'admin')
        )
        or (
          membership.directory_visibility <> 'private'
          and not exists (
            select 1 from public.member_blocks block
            where block.organization_id = p_organization_id
              and (
                (block.blocker_user_id = p_actor_user_id and block.blocked_user_id = membership.user_id)
                or (block.blocker_user_id = membership.user_id and block.blocked_user_id = p_actor_user_id)
              )
          )
          and (
            membership.directory_visibility = 'organization'
            or exists (
              select 1
              from public.organization_unit_members viewer_unit
              join public.organization_unit_members target_unit
                on target_unit.organization_id = viewer_unit.organization_id
               and target_unit.unit_id = viewer_unit.unit_id
               and target_unit.user_id = membership.user_id
              where viewer_unit.organization_id = p_organization_id
                and viewer_unit.user_id = p_actor_user_id
            )
          )
        )
      )
    union all
    select
      'conversations', conversation.id::text,
      coalesce(conversation.name, 'Direct conversation'),
      left(coalesce(conversation.description, ''), 240),
      'conversation', null::text,
      conversation.id, conversation.updated_at
    from public.conversations conversation
    join public.conversation_members member
      on member.organization_id = conversation.organization_id
     and member.conversation_id = conversation.id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where 'conversations' = any(v_types)
      and p_sender_user_id is null
      and conversation.organization_id = p_organization_id
      and to_tsvector('simple', private.normalize_search_text(
        coalesce(conversation.name, '') || ' ' || coalesce(conversation.description, '')
      )) @@ v_query
    union all
    select
      'messages', message.id::text, sender.display_name,
      left(case
        when message.body_search @@ v_query then message.body
        when matched_translation.translated_body is not null
          then matched_translation.translated_body
        when matched_attachment.file_name is not null then matched_attachment.file_name
        else sender.display_name
      end, 240),
      case
        when message.body_search @@ v_query then 'original'
        when matched_translation.translated_body is not null then 'translation'
        when matched_attachment.file_name is not null then 'attachment_filename'
        else 'sender'
      end,
      case
        when message.body_search @@ v_query
          then coalesce(message.detected_language, message.language_code)
        when matched_translation.translated_body is not null
          then matched_translation.target_language
        else null
      end,
      message.conversation_id, message.created_at
    from public.messages message
    join public.conversation_members member
      on member.organization_id = message.organization_id
     and member.conversation_id = message.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    join public.profiles sender on sender.user_id = message.sender_user_id
    left join lateral (
      select translation.translated_body, translation.target_language
      from public.message_translations translation
      where translation.organization_id = message.organization_id
        and translation.conversation_id = message.conversation_id
        and translation.message_id = message.id
        and translation.status = 'completed'
        and translation.source_body_sha256 = extensions.digest(
          convert_to(message.body, 'UTF8'), 'sha256'
        )
        and translation.translated_body_search @@ v_query
      order by translation.target_language, translation.id
      limit 1
    ) matched_translation on true
    left join lateral (
      select attachment.file_name
      from public.message_attachments attachment
      where attachment.organization_id = message.organization_id
        and attachment.conversation_id = message.conversation_id
        and attachment.message_id = message.id
        and attachment.scan_status = 'clean'
        and attachment.file_name_search @@ v_query
      order by attachment.id
      limit 1
    ) matched_attachment on true
    where 'messages' = any(v_types)
      and message.organization_id = p_organization_id
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and (p_sender_user_id is null or message.sender_user_id = p_sender_user_id)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
      and (
        message.body_search @@ v_query
        or to_tsvector('simple', private.normalize_search_text(sender.display_name)) @@ v_query
        or matched_translation.translated_body is not null
        or matched_attachment.file_name is not null
      )
    union all
    select
      'announcements', announcement.id::text, version.title,
      left(case when message.body_search @@ v_query then message.body else version.title end, 240),
      'announcement',
      coalesce(message.detected_language, message.language_code),
      announcement.conversation_id, version.published_at
    from public.announcements announcement
    join public.announcement_versions version
      on version.organization_id = announcement.organization_id
     and version.announcement_id = announcement.id
    join public.messages message
      on message.organization_id = version.organization_id
     and message.conversation_id = version.conversation_id
     and message.id = version.message_id
    join public.conversation_members member
      on member.organization_id = announcement.organization_id
     and member.conversation_id = announcement.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where 'announcements' = any(v_types)
      and p_sender_user_id is null
      and announcement.organization_id = p_organization_id
      and announcement.status in ('published', 'archived')
      and message.deleted_at is null
      and message.available_at <= now()
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
      and not exists (
        select 1 from public.announcement_versions newer
        where newer.organization_id = version.organization_id
          and newer.announcement_id = version.announcement_id
          and newer.version_number > version.version_number
      )
      and (
        to_tsvector('simple', private.normalize_search_text(version.title)) @@ v_query
        or message.body_search @@ v_query
      )
    union all
    select
      'handoffs', handoff.id::text, version.title,
      left(version.details, 240), 'handoff', version.source_language,
      handoff.conversation_id, version.created_at
    from public.shift_handoffs handoff
    join public.handoff_versions version
      on version.organization_id = handoff.organization_id
     and version.handoff_id = handoff.id
    join public.conversation_members member
      on member.organization_id = handoff.organization_id
     and member.conversation_id = handoff.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where 'handoffs' = any(v_types)
      and p_sender_user_id is null
      and handoff.organization_id = p_organization_id
      and (member.history_visible_from is null
        or version.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.handoff_versions newer
        where newer.organization_id = version.organization_id
          and newer.handoff_id = version.handoff_id
          and newer.version_number > version.version_number
      )
      and to_tsvector('simple', private.normalize_search_text(
        version.title || ' ' || version.details
      )) @@ v_query
  ), page as (
    select searchable.*
    from searchable
    where (p_date_from is null or searchable.occurred_at >= p_date_from)
      and (p_date_to is null or searchable.occurred_at <= p_date_to)
      and (
        p_cursor is null
        or (searchable.occurred_at, searchable.entity_type, searchable.entity_id)
          < (v_cursor_at, v_cursor_type, v_cursor_id)
      )
    order by searchable.occurred_at desc, searchable.entity_type desc, searchable.entity_id desc
    limit p_limit + 1
  ), numbered as (
    select page.*, row_number() over (
      order by page.occurred_at desc, page.entity_type desc, page.entity_id desc
    ) as row_number
    from page
  )
  select
    coalesce(jsonb_agg(
      jsonb_build_object(
        'type', numbered.entity_type,
        'id', numbered.entity_id,
        'title', numbered.title,
        'snippet', numbered.snippet,
        'matched_source', numbered.matched_source,
        'matched_language', numbered.matched_language,
        'conversation_id', numbered.conversation_id,
        'occurred_at', numbered.occurred_at
      ) order by numbered.occurred_at desc, numbered.entity_type desc, numbered.entity_id desc
    ) filter (where numbered.row_number <= p_limit), '[]'::jsonb),
    count(*) > p_limit,
    max(numbered.occurred_at) filter (where numbered.row_number = p_limit),
    max(numbered.entity_type) filter (where numbered.row_number = p_limit),
    max(numbered.entity_id) filter (where numbered.row_number = p_limit)
  into v_results, v_has_more, v_last_at, v_last_type, v_last_id
  from numbered;

  if v_has_more then
    v_next_cursor := replace(encode(convert_to(jsonb_build_object(
      'at', v_last_at,
      'type', v_last_type,
      'id', v_last_id,
      'query_hash', v_query_hash,
      'types_hash', v_types_hash,
      'filters_hash', v_filters_hash
    )::text, 'UTF8'), 'base64'), E'\n', '');
  end if;
  return jsonb_build_object(
    'results', v_results,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more
  );
end;
$$;

create or replace function private.bff_bootstrap_messaging_state_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
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
    order by coalesce(preference.is_pinned, false) desc,
      coalesce(preference.is_favorite, false) desc,
      conversation.updated_at desc, conversation.id
    limit p_conversation_limit
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
    coalesce(rows.is_favorite, false) desc, rows.updated_at desc, rows.id), '[]'::jsonb),
    coalesce(p_selected_conversation_id, (array_agg(rows.id order by
      coalesce(rows.is_pinned, false) desc, coalesce(rows.is_favorite, false) desc,
      rows.updated_at desc, rows.id))[1])
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
      'system_event', case when numbered.kind <> 'system' then null else jsonb_build_object(
        'event_type', numbered.metadata ->> 'event_type',
        'target_user_id', numbered.metadata ->> 'target_user_id'
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
    )) order by numbered.created_at, numbered.id) filter (where numbered.row_number <= p_timeline_limit), '[]'::jsonb),
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
$$;

-- Canonical, session-aware principal resolution. The Edge read service calls
-- this before selecting an organization; it never reads membership tables
-- through an end-user JWT.
create or replace function private.effective_capabilities_internal(
  p_actor_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with membership as (
    select member.role
    from public.organization_memberships member
    where member.organization_id = p_organization_id
      and member.user_id = p_actor_user_id
      and member.status = 'active'
  ), effective(capability) as (
    select capability from (values
      ('messaging.read'), ('message.send'), ('contacts.manage'),
      ('summary.request'), ('actions.propose'), ('attachments.upload')
    ) base(capability)
    where exists (select 1 from membership)
    union
    select 'conversation.direct.create'
    from public.organizations organization
    where organization.id = p_organization_id
      and organization.allow_member_direct_messages
      and exists (select 1 from membership)
    union
    select permission.permission
    from public.organization_role_assignments assignment
    join public.organization_role_permissions permission
      on permission.role_name = assignment.role_name
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_actor_user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
    union
    select permission.permission
    from public.organization_role_permissions permission
    where exists (select 1 from membership where role in ('owner', 'admin'))
  )
  select coalesce(jsonb_agg(capability order by capability), '[]'::jsonb)
  from (select distinct capability from effective) deduplicated
$$;

create or replace function private.effective_scopes_internal(
  p_actor_user_id uuid,
  p_organization_id uuid
)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with membership as (
    select member.role
    from public.organization_memberships member
    where member.organization_id = p_organization_id
      and member.user_id = p_actor_user_id
      and member.status = 'active'
  ), assigned as (
    select assignment.id as assignment_id,
      assignment.role_name,
      assignment.scope_type,
      assignment.unit_id,
      assignment.expires_at,
      coalesce(jsonb_agg(permission.permission order by permission.permission), '[]'::jsonb) as permissions
    from public.organization_role_assignments assignment
    join public.organization_role_permissions permission
      on permission.role_name = assignment.role_name
    where assignment.organization_id = p_organization_id
      and assignment.user_id = p_actor_user_id
      and assignment.revoked_at is null
      and (assignment.expires_at is null or assignment.expires_at > now())
    group by assignment.id, assignment.role_name, assignment.scope_type,
      assignment.unit_id, assignment.expires_at
  ), scopes as (
    select jsonb_build_object(
      'assignment_id', assigned.assignment_id,
      'role_name', assigned.role_name,
      'scope_type', assigned.scope_type,
      'unit_id', assigned.unit_id,
      'permissions', assigned.permissions,
      'expires_at', assigned.expires_at
    ) as scope, assigned.role_name, assigned.assignment_id
    from assigned
    union all
    select jsonb_build_object(
      'assignment_id', null,
      'role_name', 'legacy_' || membership.role,
      'scope_type', 'organization',
      'unit_id', null,
      'permissions', (
        select coalesce(jsonb_agg(permission.permission order by permission.permission), '[]'::jsonb)
        from public.organization_role_permissions permission
      ),
      'expires_at', null
    ), 'legacy_' || membership.role, null::uuid
    from membership where membership.role in ('owner', 'admin')
  )
  select coalesce(jsonb_agg(scope order by role_name, assignment_id nulls first), '[]'::jsonb)
  from scopes
$$;

create or replace function private.bff_resolve_principal_context_impl(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_requested_organization_id uuid
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_selected_organization_id uuid;
  v_user jsonb;
  v_organizations jsonb;
  v_not_after timestamptz;
  v_banned_until timestamptz;
begin
  perform private.require_service_role();
  if p_actor_user_id is null or p_session_id is null then
    raise exception 'principal and session are required' using errcode = '22023';
  end if;
  select session.not_after, auth_user.banned_until
    into v_not_after, v_banned_until
  from auth.sessions session
  join auth.users auth_user on auth_user.id = session.user_id
  join private.session_installations binding
    on binding.session_id = session.id
   and binding.user_id = session.user_id
   and binding.revoked_at is null
  where session.id = p_session_id and session.user_id = p_actor_user_id;
  if not found
    or (v_not_after is not null and v_not_after <= now())
    or (v_banned_until is not null and v_banned_until > now()) then
    raise exception 'active Auth session required' using errcode = '42501';
  end if;

  if p_requested_organization_id is not null then
    select membership.organization_id into v_selected_organization_id
    from public.organization_memberships membership
    where membership.organization_id = p_requested_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and not exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = membership.organization_id
          and revocation.session_id = p_session_id
      );
    if not found then
      raise exception 'organization is not available to this session' using errcode = '42501';
    end if;
  else
    select membership.organization_id into v_selected_organization_id
    from public.organization_memberships membership
    where membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and not exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = membership.organization_id
          and revocation.session_id = p_session_id
      )
    order by membership.joined_at, membership.organization_id
    limit 1;
  end if;

  select jsonb_strip_nulls(jsonb_build_object(
    'user_id', profile.user_id,
    'display_name', profile.display_name,
    'avatar_path', profile.avatar_path,
    'status_message', profile.status_message,
    'preferred_language', profile.preferred_language,
    'time_zone', profile.time_zone
  )) into v_user
  from public.profiles profile where profile.user_id = p_actor_user_id;
  v_user := coalesce(v_user, jsonb_build_object('user_id', p_actor_user_id));

  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id', authorized.organization_id,
    'slug', authorized.slug,
    'name', authorized.name,
    'default_language', authorized.default_language,
    'membership_role', authorized.membership_role,
    'job_title', authorized.job_title,
    'joined_at', authorized.joined_at,
    'revocation_generation', authorized.revocation_generation,
    'capabilities', private.effective_capabilities_internal(
      p_actor_user_id, authorized.organization_id
    ),
    'scopes', private.effective_scopes_internal(
      p_actor_user_id, authorized.organization_id
    )
  ) order by authorized.joined_at, authorized.organization_id), '[]'::jsonb)
  into v_organizations
  from (
    select organization.id as organization_id, organization.slug,
      organization.name, organization.default_language,
      membership.role as membership_role, membership.job_title,
      membership.joined_at, membership.revocation_generation
    from public.organization_memberships membership
    join public.organizations organization on organization.id = membership.organization_id
    where membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and not exists (
        select 1 from private.session_revocations revocation
        where revocation.organization_id = membership.organization_id
          and revocation.session_id = p_session_id
      )
    order by membership.joined_at, membership.organization_id
    limit 20
  ) authorized;

  return jsonb_build_object(
    'schema_version', 1,
    'user', v_user,
    'organizations', v_organizations,
    'selected_organization_id', v_selected_organization_id,
    'realtime', case when v_selected_organization_id is null then null else jsonb_build_object(
      'inbox_topic', 'org:' || v_selected_organization_id::text || ':user:'
        || p_actor_user_id::text || ':inbox',
      'control_topic', 'org:' || v_selected_organization_id::text || ':user:'
        || p_actor_user_id::text || ':control'
    ) end,
    'reconcile_after', now()
  );
end;
$$;

-- Enrich the bounded messaging bootstrap without reopening raw table access.
-- The original helper remains the single canonical message-page assembler;
-- this wrapper adds organization, directory, governance, and immutable-version
-- projections needed by the universal client.
create or replace function private.bff_bootstrap_messaging_state_v2_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_selected_conversation_id uuid,
  p_before_message_id bigint,
  p_conversation_limit integer,
  p_timeline_limit integer
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_base jsonb;
  v_organization jsonb;
  v_current_user jsonb;
  v_capabilities jsonb;
  v_scopes jsonb;
  v_units jsonb;
  v_directory jsonb;
  v_connections jsonb;
  v_conversations jsonb;
  v_updates jsonb;
  v_handoffs jsonb;
  v_summaries jsonb;
  v_actions jsonb;
  v_moderation_reports jsonb := '[]'::jsonb;
  v_audit_events jsonb := '[]'::jsonb;
  v_selected uuid;
begin
  perform private.require_service_role();
  v_base := private.bff_bootstrap_messaging_state_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_selected_conversation_id, p_before_message_id,
    p_conversation_limit, p_timeline_limit
  );
  v_selected := nullif(v_base ->> 'selected_conversation_id', '')::uuid;
  v_capabilities := private.effective_capabilities_internal(
    p_actor_user_id, p_organization_id
  );
  v_scopes := private.effective_scopes_internal(
    p_actor_user_id, p_organization_id
  );

  select jsonb_build_object(
    'organization_id', organization.id,
    'slug', organization.slug,
    'name', organization.name,
    'default_language', organization.default_language,
    'message_retention_days', organization.message_retention_days,
    'allow_member_direct_messages', organization.allow_member_direct_messages,
    'dm_policy', organization.dm_policy,
    'require_mfa_for_admins', organization.require_mfa_for_admins
  ) into v_organization
  from public.organizations organization where organization.id = p_organization_id;

  select jsonb_strip_nulls(jsonb_build_object(
    'user_id', profile.user_id,
    'display_name', profile.display_name,
    'avatar_path', profile.avatar_path,
    'status_message', profile.status_message,
    'preferred_language', profile.preferred_language,
    'time_zone', profile.time_zone,
    'membership_role', membership.role,
    'job_title', membership.job_title,
    'directory_visibility', membership.directory_visibility,
    'revocation_generation', membership.revocation_generation
  )) into v_current_user
  from public.organization_memberships membership
  join public.profiles profile on profile.user_id = membership.user_id
  where membership.organization_id = p_organization_id
    and membership.user_id = p_actor_user_id
    and membership.status = 'active';

  select coalesce(jsonb_agg(jsonb_build_object(
    'unit_id', visible.id,
    'parent_unit_id', visible.parent_unit_id,
    'kind', visible.kind,
    'name', visible.name,
    'is_lead', visible.is_lead
  ) order by visible.kind, visible.name, visible.id), '[]'::jsonb)
  into v_units
  from (
    select unit.id, unit.parent_unit_id, unit.kind, unit.name,
      coalesce(bool_or(unit_member.user_id = p_actor_user_id and unit_member.is_lead), false) as is_lead
    from public.organization_units unit
    left join public.organization_unit_members unit_member
      on unit_member.organization_id = unit.organization_id
     and unit_member.unit_id = unit.id
    where unit.organization_id = p_organization_id
      and unit.is_active
      and (
        private.actor_has_permission(p_actor_user_id, p_organization_id, 'directory.read', unit.id)
        or exists (
          select 1 from public.organization_unit_members viewer_unit
          where viewer_unit.organization_id = unit.organization_id
            and viewer_unit.unit_id = unit.id
            and viewer_unit.user_id = p_actor_user_id
        )
      )
    group by unit.id, unit.parent_unit_id, unit.kind, unit.name
    order by unit.kind, unit.name, unit.id
    limit 500
  ) visible;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'user_id', visible.user_id,
    'display_name', visible.display_name,
    'avatar_path', visible.avatar_path,
    'status_message', visible.status_message,
    'preferred_language', visible.preferred_language,
    'time_zone', visible.time_zone,
    'membership_role', visible.membership_role,
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
      membership.role as membership_role, membership.job_title,
      membership.directory_visibility,
      (select coalesce(jsonb_agg(unit_member.unit_id order by unit_member.unit_id), '[]'::jsonb)
       from public.organization_unit_members unit_member
       where unit_member.organization_id = membership.organization_id
         and unit_member.user_id = membership.user_id) as unit_ids,
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
      (select jsonb_build_object(
        'status', connection.status,
        'requested_by_user_id', connection.requested_by_user_id,
        'created_at', connection.created_at,
        'responded_at', connection.responded_at,
        'updated_at', connection.updated_at
      ) from public.contact_connections connection
      where connection.organization_id = membership.organization_id
        and p_actor_user_id in (connection.member_low_user_id, connection.member_high_user_id)
        and membership.user_id in (connection.member_low_user_id, connection.member_high_user_id)
        and membership.user_id <> p_actor_user_id) as connection
    from public.organization_memberships membership
    join public.profiles profile on profile.user_id = membership.user_id
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and (
        membership.user_id = p_actor_user_id
        or (
          membership.directory_visibility <> 'private'
          and not exists (
            select 1 from public.member_blocks block
            where block.organization_id = membership.organization_id
              and (
                (block.blocker_user_id = p_actor_user_id and block.blocked_user_id = membership.user_id)
                or (block.blocker_user_id = membership.user_id and block.blocked_user_id = p_actor_user_id)
              )
          )
          and (
            membership.directory_visibility = 'organization'
            or exists (
              select 1
              from public.organization_unit_members viewer_unit
              join public.organization_unit_members target_unit
                on target_unit.organization_id = viewer_unit.organization_id
               and target_unit.unit_id = viewer_unit.unit_id
               and target_unit.user_id = membership.user_id
              where viewer_unit.organization_id = p_organization_id
                and viewer_unit.user_id = p_actor_user_id
            )
          )
        )
      )
    order by profile.display_name, membership.user_id
    limit 500
  ) visible;

  select coalesce(jsonb_agg(jsonb_build_object(
    'counterpart_user_id', connection.counterpart_user_id,
    'status', connection.status,
    'requested_by_user_id', connection.requested_by_user_id,
    'created_at', connection.created_at,
    'responded_at', connection.responded_at,
    'updated_at', connection.updated_at
  ) order by connection.updated_at desc, connection.counterpart_user_id), '[]'::jsonb)
  into v_connections
  from (
    select case when raw.member_low_user_id = p_actor_user_id
        then raw.member_high_user_id else raw.member_low_user_id end as counterpart_user_id,
      raw.status, raw.requested_by_user_id, raw.created_at, raw.responded_at, raw.updated_at
    from public.contact_connections raw
    where raw.organization_id = p_organization_id
      and p_actor_user_id in (raw.member_low_user_id, raw.member_high_user_id)
    order by raw.updated_at desc
    limit 500
  ) connection;

  select coalesce(jsonb_agg(enriched.item order by enriched.ordinality), '[]'::jsonb)
  into v_conversations
  from (
    select item.ordinality,
      item.value || jsonb_build_object(
        'direct_counterpart_user_id', case when item.value ->> 'kind' = 'direct' then (
          select case when pair.member_low_user_id = p_actor_user_id
            then pair.member_high_user_id else pair.member_low_user_id end
          from public.direct_conversation_pairs pair
          where pair.organization_id = p_organization_id
            and pair.conversation_id = (item.value ->> 'conversation_id')::uuid
            and p_actor_user_id in (pair.member_low_user_id, pair.member_high_user_id)
        ) else null end,
        'member_count', (
          select count(*) from public.conversation_members member
          join public.organization_memberships organization_member
            on organization_member.organization_id = member.organization_id
           and organization_member.user_id = member.user_id
           and organization_member.status = 'active'
          where member.organization_id = p_organization_id
            and member.conversation_id = (item.value ->> 'conversation_id')::uuid
            and member.status = 'active'
        ),
        'members', case
          when (item.value ->> 'conversation_id')::uuid = v_selected
            or item.value ->> 'kind' = 'direct'
          then (
            select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
              'user_id', listed.user_id,
              'display_name', listed.display_name,
              'avatar_path', listed.avatar_path,
              'role', listed.role,
              'can_post', listed.can_post,
              'notification_level', listed.notification_level,
              'muted_until', listed.muted_until
            )) order by listed.display_name, listed.user_id), '[]'::jsonb)
            from (
              select member.user_id, profile.display_name, profile.avatar_path,
                member.role, member.can_post, member.notification_level, member.muted_until
              from public.conversation_members member
              join public.organization_memberships organization_member
                on organization_member.organization_id = member.organization_id
               and organization_member.user_id = member.user_id
               and organization_member.status = 'active'
              join public.profiles profile on profile.user_id = member.user_id
              where member.organization_id = p_organization_id
                and member.conversation_id = (item.value ->> 'conversation_id')::uuid
                and member.status = 'active'
              order by profile.display_name, member.user_id
              limit 500
            ) listed
          ) else '[]'::jsonb end
      ) as item
    from jsonb_array_elements(coalesce(v_base -> 'conversations', '[]'::jsonb))
      with ordinality as item(value, ordinality)
  ) enriched;

  select coalesce(jsonb_agg(row.payload order by row.published_at desc, row.announcement_id), '[]'::jsonb)
  into v_updates
  from (
    select announcement.id as announcement_id, version.published_at,
      jsonb_strip_nulls(jsonb_build_object(
        'announcement_id', announcement.id,
        'announcement_version_id', version.id,
        'version_number', version.version_number,
        'conversation_id', version.conversation_id,
        'message_id', version.message_id,
        'title', version.title,
        'priority', version.priority,
        'requires_acknowledgement', version.requires_acknowledgement,
        'acknowledgement_schema', version.acknowledgement_schema,
        'notification_class', version.notification_class,
        'critical_category', version.critical_category,
        'quiet_hours_override_reason', version.quiet_hours_override_reason,
        'reminder_policy', version.reminder_policy,
        'status', announcement.status,
        'scheduled_at', version.scheduled_at,
        'published_at', version.published_at,
        'expires_at', version.expires_at,
        'body', message.body,
        'client_language_hint', message.language_code,
        'detected_language', message.detected_language,
        'language_detection_state', message.language_detection_state,
        'translations', (select coalesce(jsonb_agg(jsonb_build_object(
          'target_language', translation.target_language,
          'translated_body', translation.translated_body,
          'status', translation.status,
          'confidence', translation.confidence
        ) order by translation.target_language), '[]'::jsonb)
        from public.message_translations translation
        where translation.organization_id = version.organization_id
          and translation.conversation_id = version.conversation_id
          and translation.message_id = version.message_id
          and translation.source_body_sha256 = extensions.digest(
            convert_to(message.body, 'UTF8'), 'sha256'
          )),
        'delivered_at', recipient.delivered_at,
        'read_at', recipient.read_at,
        'reminder_count', recipient.reminder_count,
        'last_reminded_at', recipient.last_reminded_at,
        'escalated_at', recipient.escalated_at,
        'acknowledged_at', acknowledgement.acknowledged_at,
        'acknowledgement_device_id', acknowledgement.device_id,
        'acknowledgement_role_snapshot', acknowledgement.role_snapshot,
        'acknowledgement_scope_snapshot', acknowledgement.scope_snapshot
      )) as payload
    from public.announcements announcement
    join lateral (
      select candidate.* from public.announcement_versions candidate
      where candidate.organization_id = announcement.organization_id
        and candidate.announcement_id = announcement.id
      order by candidate.version_number desc limit 1
    ) version on true
    join public.messages message
      on message.organization_id = version.organization_id
     and message.conversation_id = version.conversation_id
     and message.id = version.message_id
     and message.deleted_at is null
     and message.available_at <= now()
    join public.announcement_recipients recipient
      on recipient.organization_id = announcement.organization_id
     and recipient.announcement_id = announcement.id
     and recipient.user_id = p_actor_user_id
    join public.conversation_members member
      on member.organization_id = version.organization_id
     and member.conversation_id = version.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    left join public.announcement_acknowledgements acknowledgement
      on acknowledgement.organization_id = version.organization_id
     and acknowledgement.announcement_id = version.announcement_id
     and acknowledgement.announcement_version_id = version.id
     and acknowledgement.user_id = p_actor_user_id
    where announcement.organization_id = p_organization_id
      and announcement.status = 'published'
      and (member.history_visible_from is null
        or message.created_at >= member.history_visible_from)
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = message.organization_id
          and visibility.conversation_id = message.conversation_id
          and visibility.message_id = message.id
          and visibility.user_id = p_actor_user_id
      )
    order by version.published_at desc, announcement.id
    limit 200
  ) row;

  select coalesce(jsonb_agg(row.payload order by row.created_at desc, row.handoff_id), '[]'::jsonb)
  into v_handoffs
  from (
    select handoff.id as handoff_id, version.created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'handoff_id', handoff.id,
        'handoff_version_id', version.id,
        'version_number', version.version_number,
        'conversation_id', version.conversation_id,
        'title', version.title,
        'details', version.details,
        'source_language', version.source_language,
        'translations', '[]'::jsonb,
        'status', handoff.status,
        'shift_started_at', version.shift_started_at,
        'shift_ended_at', version.shift_ended_at,
        'submitted_at', handoff.submitted_at,
        'acknowledgement_due_at', version.acknowledgement_due_at,
        'overdue', handoff.status = 'submitted'
          and version.acknowledgement_due_at is not null
          and version.acknowledgement_due_at <= now()
          and acknowledgement.acknowledged_at is null,
        'reminder_state', case
          when handoff.status <> 'submitted' or version.acknowledgement_due_at is null
            or version.acknowledgement_due_at > now() then 'not_due'
          when handoff.reminder_count >= 3 then 'exhausted'
          when handoff.reminder_count > 0 then 'sent'
          else 'due'
        end,
        'reminder_count', handoff.reminder_count,
        'last_reminded_at', handoff.last_reminded_at,
        'escalation_state', case
          when handoff.escalated_at is not null then 'escalated'
          when handoff.status = 'submitted' and version.acknowledgement_due_at is not null
            and now() >= version.acknowledgement_due_at + interval '60 minutes' then 'due'
          else 'not_due'
        end,
        'escalated_at', handoff.escalated_at,
        'sms_fallback_available', false,
        'source_message_ids', to_jsonb(version.source_message_ids),
        'source_fingerprint', encode(version.source_fingerprint, 'hex'),
        'source_state', case when private.handoff_source_is_current_internal(
          version.organization_id, version.conversation_id,
          version.source_message_ids, version.source_fingerprint
        ) then 'current' else 'stale' end,
        'stale_reason', case when private.handoff_source_is_current_internal(
          version.organization_id, version.conversation_id,
          version.source_message_ids, version.source_fingerprint
        ) then null else 'source_edited_or_deleted' end,
        'author_user_id', handoff.author_user_id,
        'signed_session_id', handoff.signed_session_id,
        'signed_device_id', handoff.signed_device_id,
        'signed_role_snapshot', handoff.signed_role_snapshot,
        'signed_scope_snapshot', handoff.signed_scope_snapshot,
        'is_submitted_version', handoff.submitted_version_id = version.id,
        'acknowledged_at', acknowledgement.acknowledged_at,
        'acknowledgement_session_id', acknowledgement.session_id,
        'acknowledgement_device_id', acknowledgement.device_id,
        'acknowledgement_role_snapshot', acknowledgement.role_snapshot,
        'acknowledgement_scope_snapshot', acknowledgement.scope_snapshot,
        'note', acknowledgement.note
      )) as payload
    from public.shift_handoffs handoff
    join lateral (
      select candidate.* from public.handoff_versions candidate
      where candidate.organization_id = handoff.organization_id
        and candidate.handoff_id = handoff.id
      order by candidate.version_number desc limit 1
    ) version on true
    join public.conversation_members member
      on member.organization_id = handoff.organization_id
     and member.conversation_id = handoff.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    left join public.handoff_acknowledgements acknowledgement
      on acknowledgement.organization_id = version.organization_id
     and acknowledgement.handoff_id = version.handoff_id
     and acknowledgement.handoff_version_id = version.id
     and acknowledgement.user_id = p_actor_user_id
    where handoff.organization_id = p_organization_id
      and (member.history_visible_from is null
        or version.created_at >= member.history_visible_from)
      and (handoff.status <> 'draft' or handoff.author_user_id = p_actor_user_id
        or private.actor_has_permission(p_actor_user_id, p_organization_id, 'handoff.manage', null))
    order by version.created_at desc, handoff.id
    limit 200
  ) row;

  select coalesce(jsonb_agg(row.payload order by row.created_at desc, row.summary_id), '[]'::jsonb)
  into v_summaries
  from (
    select summary.id as summary_id, summary.created_at,
      jsonb_build_object(
        'summary_id', summary.id,
        'version_number', summary.version_number,
        'conversation_id', summary.conversation_id,
        'correction_of_summary_id', summary.correction_of_summary_id,
        'status', summary.status,
        'primary_topic', summary.primary_topic,
        'summary_body', summary.summary_body,
        'key_topics', summary.key_topics,
        'decisions', summary.decisions,
        'action_items', summary.action_items,
        'ambiguities', summary.ambiguities,
        'language_code', summary.language_code,
        'source_message_ids', summary.source_message_ids,
        'source_first_message_id', summary.source_first_message_id,
        'source_last_message_id', summary.source_last_message_id,
        'source_fingerprint', encode(summary.source_fingerprint, 'hex'),
        'source_fingerprint_hex', encode(summary.source_fingerprint, 'hex'),
        'output_fingerprint', case when summary.output_fingerprint is null
          then null else encode(summary.output_fingerprint, 'hex') end,
        'requested_by_user_id', summary.requested_by_user_id,
        'request_mode', summary.request_mode,
        'processor_type', summary.processor_type,
        'provider', summary.provider,
        'model', summary.model,
        -- Never return prompts, token counts, generation identifiers, or the
        -- detailed source map stored for audit. Clients receive only routing
        -- policy provenance required to explain whether an output is current.
        'processor_provenance', jsonb_strip_nulls(jsonb_build_object(
          'organization_ai_policy_version', coalesce(
            summary.processor_provenance -> 'organizationAiPolicyVersion',
            summary.processor_provenance -> 'organization_ai_policy_version'
          ),
          'route_policy_version', coalesce(
            summary.processor_provenance -> 'routePolicyVersion',
            summary.processor_provenance -> 'route_policy_version'
          ),
          'provider_route', coalesce(
            summary.processor_provenance -> 'providerRoute',
            summary.processor_provenance -> 'provider_route'
          )
        )),
        'failure_code', summary.failure_code,
        'reviewed_by_user_id', summary.reviewed_by_user_id,
        'reviewed_at', summary.reviewed_at,
        'review_note', summary.review_note,
        'source_state', case
          when summary.status = 'stale'
            or not private.summary_source_is_current_internal(
              summary.organization_id,
              summary.conversation_id,
              summary.source_message_ids,
              summary.source_fingerprint
            ) then 'stale'
          else 'current'
        end,
        'policy_state', case
          when summary.processor_type is distinct from 'ai' then 'not_applicable'
          when ai_policy.organization_id is not null
            and ai_policy.enabled
            and ai_policy.revoked_at is null
            and ai_policy.route_policy = 'approved_zero_retention'
            and 'summary' = any(ai_policy.approved_use_cases)
            and summary.provider = any(ai_policy.provider_allowlist)
            and coalesce(
              summary.processor_provenance ->> 'organizationAiPolicyVersion',
              summary.processor_provenance ->> 'organization_ai_policy_version'
            ) = ai_policy.policy_version::text then 'current'
          else 'stale'
        end,
        'created_at', summary.created_at,
        'updated_at', summary.updated_at
      ) as payload
    from public.conversation_summaries summary
    join public.conversation_members member
      on member.organization_id = summary.organization_id
     and member.conversation_id = summary.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    left join public.organization_ai_policies ai_policy
      on ai_policy.organization_id = summary.organization_id
    where summary.organization_id = p_organization_id
      and not exists (
        select 1 from unnest(summary.source_message_ids) source_id
        join public.messages source_message
          on source_message.organization_id = summary.organization_id
         and source_message.conversation_id = summary.conversation_id
         and source_message.id = source_id
        where source_message.deleted_at is not null
          or source_message.available_at > now()
          or (member.history_visible_from is not null
            and source_message.created_at < member.history_visible_from)
      )
      and not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = summary.organization_id
          and visibility.conversation_id = summary.conversation_id
          and visibility.message_id = any(summary.source_message_ids)
          and visibility.user_id = p_actor_user_id
      )
    order by summary.created_at desc, summary.id
    limit 100
  ) row;

  select coalesce(jsonb_agg(row.payload order by row.created_at desc, row.action_id), '[]'::jsonb)
  into v_actions
  from (
    select action.id as action_id, action.created_at,
      jsonb_strip_nulls(jsonb_build_object(
        'action_id', action.id,
        'conversation_id', action.conversation_id,
        'source_message_id', action.source_message_id,
        'title', action.title,
        'details', action.details,
        'status', action.status,
        'proposed_by_user_id', action.proposed_by_user_id,
        'confirmed_by_user_id', action.confirmed_by_user_id,
        'assignee_user_id', action.assignee_user_id,
        'due_at', action.due_at,
        'completed_at', action.completed_at,
        'created_at', action.created_at,
        'updated_at', action.updated_at
      )) as payload
    from public.operational_actions action
    join public.conversation_members member
      on member.organization_id = action.organization_id
     and member.conversation_id = action.conversation_id
     and member.user_id = p_actor_user_id
     and member.status = 'active'
    where action.organization_id = p_organization_id
      and (action.source_message_id is null or not exists (
        select 1 from public.message_user_visibility visibility
        where visibility.organization_id = action.organization_id
          and visibility.conversation_id = action.conversation_id
          and visibility.message_id = action.source_message_id
          and visibility.user_id = p_actor_user_id
      ))
    order by action.created_at desc, action.id
    limit 200
  ) row;

  if private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'reports.investigate', null
  ) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'report_id', report.id,
      'conversation_id', report.conversation_id,
      'message_id', report.message_id,
      'category', report.category,
      'status', report.status,
      'created_at', report.created_at
    ) order by report.created_at desc, report.id), '[]'::jsonb)
    into v_moderation_reports
    from (
      select * from private.message_reports report
      where report.organization_id = p_organization_id
      order by report.created_at desc, report.id
      limit 100
    ) report;
  end if;
  if private.actor_has_permission(
    p_actor_user_id, p_organization_id, 'audit.read', null
  ) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'audit_event_id', event.id,
      'actor_user_id', event.actor_user_id,
      'event_type', event.event_type,
      'target_type', event.target_type,
      'target_id', event.target_id,
      'request_id', event.request_id,
      'metadata', event.metadata,
      'occurred_at', event.occurred_at
    ) order by event.occurred_at desc, event.id desc), '[]'::jsonb)
    into v_audit_events
    from (
      select * from public.audit_events event
      where event.organization_id = p_organization_id
      order by event.occurred_at desc, event.id desc
      limit 100
    ) event;
  end if;

  return v_base || jsonb_build_object(
    'schema_version', 1,
    'organization', v_organization,
    'current_user', v_current_user,
    'capabilities', v_capabilities,
    'scopes', v_scopes,
    'realtime', jsonb_build_object(
      'inbox_topic', 'org:' || p_organization_id::text || ':user:'
        || p_actor_user_id::text || ':inbox',
      'control_topic', 'org:' || p_organization_id::text || ':user:'
        || p_actor_user_id::text || ':control'
    ),
    'units', v_units,
    'directory', v_directory,
    'connections', v_connections,
    'conversations', v_conversations,
    'updates', v_updates,
    'handoffs', v_handoffs,
    'summaries', v_summaries,
    'actions', v_actions,
    'moderation_reports', v_moderation_reports,
    'audit_events', v_audit_events,
    'reconcile_after', now()
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
    'messages', coalesce(v_bootstrap #> '{timeline,messages}', '[]'::jsonb),
    'has_more', coalesce((v_bootstrap #>> '{timeline,has_more}')::boolean, false),
    'next_before_message_id', v_bootstrap #> '{timeline,next_before_message_id}',
    'reconcile_after', now()
  );
end;
$$;

create or replace function private.bff_resolve_realtime_fanout_impl(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_event text,
  p_entity_type text,
  p_entity_id text,
  p_version_id text,
  p_reason text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_event_id uuid := gen_random_uuid();
  v_occurred_at timestamptz := now();
  v_deliveries jsonb;
begin
  perform private.require_service_role();
  if p_event <> 'workspace.invalidated'
    or p_entity_type not in (
      'conversation', 'message', 'reaction', 'translation', 'receipt',
      'attachment', 'membership', 'announcement', 'handoff', 'summary', 'action'
    )
    or char_length(coalesce(p_entity_id, '')) not between 1 and 240
    or (p_version_id is not null and char_length(p_version_id) > 240)
    or (p_reason is not null and char_length(p_reason) > 160) then
    raise exception 'invalid realtime fanout envelope' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
  ) then
    raise exception 'conversation not found' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'topic', 'org:' || member.organization_id::text || ':user:'
      || member.user_id::text || ':inbox',
    'event', 'workspace.invalidated',
    'payload', jsonb_strip_nulls(jsonb_build_object(
      'schema_version', 1,
      'event_id', v_event_id,
      'event', 'workspace.invalidated',
      'organization_id', member.organization_id,
      'occurred_at', v_occurred_at,
      'conversation_id', member.conversation_id,
      'entity_type', p_entity_type,
      'entity_id', p_entity_id,
      'version_id', p_version_id,
      'reason', p_reason
    ))
  ) order by member.user_id), '[]'::jsonb)
  into v_deliveries
  from public.conversation_members member
  join public.organization_memberships organization_member
    on organization_member.organization_id = member.organization_id
   and organization_member.user_id = member.user_id
   and organization_member.status = 'active'
  where member.organization_id = p_organization_id
    and member.conversation_id = p_conversation_id
    and member.status = 'active';
  return jsonb_build_object('schema_version', 1, 'deliveries', v_deliveries);
end;
$$;

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

create or replace function private.bff_claim_attachment_scan_jobs_impl(
  p_worker_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  perform private.require_service_role();
  return private.claim_outbox_jobs_internal(
    p_worker_id, p_limit, p_lease_seconds, 'storage_scan'
  );
end;
$$;

create or replace function private.bff_complete_attachment_scan_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_attachment_id uuid,
  p_scan_result text,
  p_detected_mime_type text,
  p_policy_code text,
  p_scanner_name text,
  p_scanner_version text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
  v_storage_path text;
  v_declared_mime_type text;
  v_detected_allowed boolean;
  v_requires_quarantine boolean;
  v_response jsonb;
begin
  perform private.require_service_role();
  if p_scan_result not in ('clean', 'quarantined')
    or char_length(coalesce(p_detected_mime_type, '')) not between 3 and 160
    or (p_policy_code is not null and char_length(p_policy_code) not between 1 and 120)
    or char_length(coalesce(p_scanner_name, '')) not between 2 and 120
    or char_length(coalesce(p_scanner_version, '')) not between 1 and 120 then
    raise exception 'invalid attachment scan result' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'storage_scan'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
    and job.payload ->> 'attachment_id' = p_attachment_id::text
  for update;
  if not found then raise exception 'active attachment scan lease required' using errcode = '42501'; end if;
  v_declared_mime_type := lower(v_job.payload ->> 'declared_mime_type');
  v_detected_allowed := lower(p_detected_mime_type) = any(array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/ogg'
  ]::text[]);
  v_requires_quarantine := not v_detected_allowed
    or lower(p_detected_mime_type) is distinct from v_declared_mime_type;
  if (v_requires_quarantine and p_scan_result <> 'quarantined')
    or (v_requires_quarantine and p_policy_code is null)
    or (p_scan_result = 'clean' and p_policy_code is not null) then
    raise exception 'detected media policy requires quarantine' using errcode = '22023';
  end if;
  update public.message_attachments attachment
  set scan_status = p_scan_result,
      scan_completed_at = now(),
      scanner_name = p_scanner_name,
      scanner_version = p_scanner_version,
      scan_failure_code = null,
      detected_mime_type = lower(p_detected_mime_type),
      scan_policy_code = p_policy_code,
      purge_requested_at = case when p_scan_result = 'quarantined' then now() else null end
  where attachment.organization_id = v_job.organization_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'pending'
  returning attachment.storage_path into v_storage_path;
  if not found then raise exception 'pending attachment scan not found' using errcode = 'P0002'; end if;
  update private.outbox_jobs job
  set status = 'completed', claimed_by = null, claimed_until = null,
      completed_at = now(), updated_at = now()
  where job.id = p_job_id;
  if p_scan_result = 'quarantined' then
    perform private.enqueue_outbox_job_internal(
      v_job.organization_id, 'storage_purge',
      'attachment:' || p_attachment_id::text,
      jsonb_build_object(
        'attachment_id', p_attachment_id,
        'bucket_id', 'message-attachments',
        'storage_path', v_storage_path,
        'reason', 'scanner_quarantine'
      )
    );
  end if;
  v_response := jsonb_build_object(
    'attachment_id', p_attachment_id,
    'scan_status', p_scan_result,
    'detected_mime_type', lower(p_detected_mime_type),
    'policy_code', p_policy_code,
    'scan_completed', true,
    'purge_queued', p_scan_result = 'quarantined'
  );
  return v_response;
end;
$$;

create or replace function private.bff_fail_attachment_scan_impl(
  p_worker_id uuid,
  p_job_id bigint,
  p_attachment_id uuid,
  p_failure_code text,
  p_scanner_name text,
  p_scanner_version text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_job private.outbox_jobs%rowtype;
begin
  perform private.require_service_role();
  if char_length(coalesce(p_failure_code, '')) not between 1 and 120
    or char_length(coalesce(p_scanner_name, '')) not between 2 and 120
    or char_length(coalesce(p_scanner_version, '')) not between 1 and 120 then
    raise exception 'invalid attachment scan failure' using errcode = '22023';
  end if;
  select * into v_job from private.outbox_jobs job
  where job.id = p_job_id
    and job.topic = 'storage_scan'
    and job.status = 'processing'
    and job.claimed_by = p_worker_id
    and job.claimed_until > now()
    and job.payload ->> 'attachment_id' = p_attachment_id::text
  for update;
  if not found then raise exception 'active attachment scan lease required' using errcode = '42501'; end if;
  update public.message_attachments attachment
  set scan_status = 'failed',
      scan_completed_at = now(),
      scanner_name = p_scanner_name,
      scanner_version = p_scanner_version,
      scan_failure_code = p_failure_code,
      detected_mime_type = null,
      scan_policy_code = null,
      purge_requested_at = null
  where attachment.organization_id = v_job.organization_id
    and attachment.id = p_attachment_id
    and attachment.scan_status = 'pending';
  if not found then raise exception 'pending attachment scan not found' using errcode = 'P0002'; end if;
  update private.outbox_jobs job
  set status = 'completed', claimed_by = null, claimed_until = null,
      completed_at = now(), last_error_code = p_failure_code, updated_at = now()
  where job.id = p_job_id;
  return jsonb_build_object(
    'attachment_id', p_attachment_id,
    'scan_status', 'failed',
    'failure_code', p_failure_code,
    'scan_completed', true
  );
end;
$$;

create or replace function private.bff_bootstrap_organization_impl(
  p_owner_user_id uuid,
  p_name text,
  p_slug text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_request_hash bytea;
  v_existing_hash bytea;
  v_existing_response jsonb;
  v_owner_email text;
  v_owner_display_name text;
  v_organization_id uuid;
  v_root_unit_id uuid;
  v_headers jsonb;
  v_request_id uuid := gen_random_uuid();
  v_response jsonb;
begin
  perform private.require_service_role();
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    v_headers := null;
  end;
  if coalesce(v_headers ->> 'x-request-id', '')
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    v_request_id := (v_headers ->> 'x-request-id')::uuid;
  end if;
  if p_owner_user_id is null
    or char_length(coalesce(p_idempotency_key, '')) not between 8 and 200
    or coalesce(p_request_sha256, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_slug, '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(p_slug) not between 3 and 63
    or char_length(btrim(coalesce(p_name, ''))) not between 1 and 160 then
    raise exception 'invalid organization bootstrap request' using errcode = '22023';
  end if;
  v_request_hash := decode(p_request_sha256, 'hex');
  insert into private.bootstrap_idempotency_keys (
    owner_user_id, idempotency_key, request_sha256
  ) values (
    p_owner_user_id, p_idempotency_key, v_request_hash
  ) on conflict (owner_user_id, idempotency_key) do nothing;
  select bootstrap.request_sha256, bootstrap.response_body
    into v_existing_hash, v_existing_response
  from private.bootstrap_idempotency_keys bootstrap
  where bootstrap.owner_user_id = p_owner_user_id
    and bootstrap.idempotency_key = p_idempotency_key
  for update;
  if v_existing_hash <> v_request_hash then
    raise exception 'idempotency key request digest conflict' using errcode = '23505';
  end if;
  if v_existing_response is not null then return v_existing_response; end if;

  select auth_user.email,
         left(coalesce(
           nullif(btrim(auth_user.raw_user_meta_data ->> 'display_name'), ''),
           nullif(split_part(auth_user.email, '@', 1), ''),
           'Workspace owner'
         ), 120)
    into v_owner_email, v_owner_display_name
  from auth.users auth_user
  where auth_user.id = p_owner_user_id
    and auth_user.deleted_at is null
    and auth_user.email is not null;
  if not found then
    raise exception 'pre-provisioned owner principal required' using errcode = '42501';
  end if;

  insert into public.profiles (user_id, display_name)
  values (p_owner_user_id, v_owner_display_name)
  on conflict (user_id) do nothing;
  insert into public.organizations (
    slug, name, created_by_user_id
  ) values (
    p_slug, btrim(p_name), p_owner_user_id
  ) returning id into v_organization_id;
  insert into public.organization_memberships (
    organization_id, user_id, role, status
  ) values (
    v_organization_id, p_owner_user_id, 'owner', 'active'
  );
  insert into public.organization_units (
    organization_id, kind, name, created_by_user_id
  ) values (
    v_organization_id, 'site', left(btrim(p_name), 152) || ' General',
    p_owner_user_id
  ) returning id into v_root_unit_id;
  insert into public.audit_events (
    organization_id, actor_user_id, event_type, target_type, target_id,
    request_id, metadata
  ) values (
    v_organization_id, p_owner_user_id, 'organization.bootstrap',
    'organization', v_organization_id::text, v_request_id,
    jsonb_build_object(
      'slug', p_slug,
      'owner_user_id', p_owner_user_id,
      'root_unit_id', v_root_unit_id,
      'owner_email_domain', split_part(v_owner_email, '@', 2),
      'bff_operation', 'organization.bootstrap',
      'result', 'committed'
    )
  );
  v_response := jsonb_build_object(
    'organization_id', v_organization_id,
    'owner_user_id', p_owner_user_id,
    'membership_role', 'owner',
    'membership_status', 'active',
    'root_unit_id', v_root_unit_id,
    'bootstrapped', true
  );
  update private.bootstrap_idempotency_keys bootstrap
  set response_body = v_response, completed_at = now(), updated_at = now()
  where bootstrap.owner_user_id = p_owner_user_id
    and bootstrap.idempotency_key = p_idempotency_key;
  return v_response;
end;
$$;

create or replace function private.bff_propose_operational_action_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_source_message_id bigint,
  p_title text,
  p_details text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_action_id uuid;
  v_created_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'operational_action.propose', false, 0, '/v2/actions/proposals',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  if not private.is_conversation_member(p_organization_id, p_conversation_id)
    or (
      p_source_message_id is not null
      and not exists (
        select 1 from public.messages message
        where message.organization_id = p_organization_id
          and message.conversation_id = p_conversation_id
          and message.id = p_source_message_id
          and message.deleted_at is null
      )
    ) then
    raise exception 'conversation message access required' using errcode = '42501';
  end if;
  insert into public.operational_actions (
    organization_id, conversation_id, source_message_id, title, details,
    proposed_by_user_id
  ) values (
    p_organization_id, p_conversation_id, p_source_message_id, p_title,
    p_details, p_actor_user_id
  ) returning id, created_at into v_action_id, v_created_at;
  insert into public.operational_action_events (
    organization_id, action_id, actor_user_id, event_type, to_status
  ) values (
    p_organization_id, v_action_id, p_actor_user_id, 'proposed', 'proposed'
  );
  v_response := jsonb_build_object(
    'action_id', v_action_id,
    'status', 'proposed',
    'created_at', v_created_at,
    'requires_confirmation', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/actions/proposals',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_confirm_operational_action_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_action_id uuid,
  p_assignee_user_id uuid,
  p_due_at timestamptz,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_action public.operational_actions%rowtype;
  v_confirmed_at timestamptz;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'operational_action.confirm', false, 0, '/v2/actions/:id/confirm',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select * into v_action
  from public.operational_actions action
  where action.organization_id = p_organization_id
    and action.id = p_action_id
  for update;
  if not found
    or v_action.status <> 'proposed'
    or not private.is_conversation_admin(p_organization_id, v_action.conversation_id)
    or not exists (
      select 1 from public.conversation_members member
      join public.organization_memberships organization_member
        on organization_member.organization_id = member.organization_id
       and organization_member.user_id = member.user_id
       and organization_member.status = 'active'
      where member.organization_id = p_organization_id
        and member.conversation_id = v_action.conversation_id
        and member.user_id = p_assignee_user_id
        and member.status = 'active'
    ) then
    raise exception 'confirmable action and active assignee required' using errcode = '42501';
  end if;
  update public.operational_actions action
  set status = 'confirmed',
      confirmed_by_user_id = p_actor_user_id,
      confirmed_at = now(),
      assignee_user_id = p_assignee_user_id,
      due_at = p_due_at
  where action.organization_id = p_organization_id and action.id = p_action_id
  returning action.confirmed_at into v_confirmed_at;
  insert into public.operational_action_events (
    organization_id, action_id, actor_user_id, event_type,
    from_status, to_status
  ) values (
    p_organization_id, p_action_id, p_actor_user_id, 'confirmed',
    'proposed', 'confirmed'
  );
  v_response := jsonb_build_object(
    'action_id', p_action_id,
    'status', 'confirmed',
    'assignee_user_id', p_assignee_user_id,
    'due_at', p_due_at,
    'confirmed_at', v_confirmed_at
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/actions/:id/confirm',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_transition_operational_action_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_action_id uuid,
  p_status text,
  p_note text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_action public.operational_actions%rowtype;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'operational_action.transition', false, 0, '/v2/actions/:id/status',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select * into v_action
  from public.operational_actions action
  where action.organization_id = p_organization_id
    and action.id = p_action_id
  for update;
  if not found
    or not (
      (v_action.status = 'confirmed' and p_status in ('in_progress', 'completed', 'cancelled'))
      or (v_action.status = 'in_progress' and p_status in ('completed', 'cancelled'))
    )
    or not (
      v_action.assignee_user_id = p_actor_user_id
      or private.is_conversation_admin(p_organization_id, v_action.conversation_id)
    ) then
    raise exception 'operational action transition is not permitted' using errcode = '42501';
  end if;
  update public.operational_actions action
  set status = p_status,
      completed_at = case when p_status = 'completed' then now() else null end
  where action.organization_id = p_organization_id and action.id = p_action_id;
  insert into public.operational_action_events (
    organization_id, action_id, actor_user_id, event_type,
    from_status, to_status, note
  ) values (
    p_organization_id, p_action_id, p_actor_user_id, 'transitioned',
    v_action.status, p_status, p_note
  );
  v_response := jsonb_build_object(
    'action_id', p_action_id,
    'from_status', v_action.status,
    'status', p_status,
    'transitioned', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/actions/:id/status',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function private.bff_save_dynamic_group_policy_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_policy_id uuid,
  p_unit_id uuid,
  p_member_roles text[],
  p_include_unit_descendants boolean,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_policy_id uuid := p_policy_id;
  v_roles text[];
  v_version integer;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'dynamic_group.policy.save', true, 900,
    '/v2/dynamic-groups/policies', p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select array_agg(distinct role_name order by role_name) into v_roles
  from unnest(coalesce(p_member_roles, array[]::text[])) role_name;
  if not exists (
      select 1 from public.conversations authorized_conversation
      where authorized_conversation.organization_id = p_organization_id
        and authorized_conversation.id = p_conversation_id
        and authorized_conversation.kind in ('group', 'team', 'shift')
        and private.actor_has_permission(
          p_actor_user_id, p_organization_id, 'unit.manage', authorized_conversation.unit_id
        )
    )
    or cardinality(v_roles) not between 1 and 4
    or not (v_roles <@ array['owner', 'admin', 'manager', 'member']::text[])
    or not exists (
      select 1 from public.conversations conversation
      where conversation.organization_id = p_organization_id
        and conversation.id = p_conversation_id
        and conversation.kind in ('group', 'team', 'shift')
    )
    or (
      p_unit_id is not null
      and not exists (
        select 1 from public.organization_units unit
        where unit.organization_id = p_organization_id
          and unit.id = p_unit_id and unit.is_active
      )
    ) then
    raise exception 'valid dynamic-group administrator policy required' using errcode = '42501';
  end if;
  if v_policy_id is null then
    insert into public.dynamic_group_policies (
      organization_id, conversation_id, unit_id, member_roles,
      include_unit_descendants, created_by_user_id
    ) values (
      p_organization_id, p_conversation_id, p_unit_id, v_roles,
      p_include_unit_descendants, p_actor_user_id
    ) returning id, version into v_policy_id, v_version;
  else
    update public.dynamic_group_policies policy
    set unit_id = p_unit_id,
        member_roles = v_roles,
        include_unit_descendants = p_include_unit_descendants,
        status = 'draft',
        approved_by_user_id = null,
        approved_at = null,
        version = policy.version + 1
    where policy.organization_id = p_organization_id
      and policy.id = v_policy_id
      and policy.conversation_id = p_conversation_id
    returning policy.version into v_version;
    if not found then raise exception 'dynamic-group policy not found' using errcode = 'P0002'; end if;
  end if;
  v_response := jsonb_build_object(
    'policy_id', v_policy_id,
    'conversation_id', p_conversation_id,
    'version', v_version,
    'status', 'draft',
    'requires_preview', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/dynamic-groups/policies',
    p_idempotency_key, p_request_sha256, v_response, 201
  );
end;
$$;

create or replace function private.bff_preview_dynamic_group_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_policy public.dynamic_group_policies%rowtype;
  v_total bigint;
  v_user_ids jsonb;
begin
  perform private.require_service_role();
  perform private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'dynamic_group.preview', true, 900
  );
  if p_limit not between 1 and 200 or not exists (
    select 1 from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and membership.role in ('owner', 'admin')
  ) then
    raise exception 'dynamic-group preview is not permitted' using errcode = '42501';
  end if;
  select * into v_policy from public.dynamic_group_policies policy
  where policy.organization_id = p_organization_id and policy.id = p_policy_id;
  if not found then raise exception 'dynamic-group policy not found' using errcode = 'P0002'; end if;

  with recursive eligible_units(id) as (
    select v_policy.unit_id where v_policy.unit_id is not null
    union
    select child.id
    from public.organization_units child
    join eligible_units parent on child.parent_unit_id = parent.id
    where child.organization_id = p_organization_id
      and child.is_active and v_policy.include_unit_descendants
  ), eligible as (
    select membership.user_id
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.role = any(v_policy.member_roles)
      and (
        v_policy.unit_id is null
        or exists (
          select 1 from public.organization_unit_members unit_member
          where unit_member.organization_id = p_organization_id
            and unit_member.user_id = membership.user_id
            and unit_member.unit_id in (select id from eligible_units)
        )
      )
  )
  select count(*), coalesce(
    (select jsonb_agg(sample.user_id order by sample.user_id)
     from (select user_id from eligible order by user_id limit p_limit) sample),
    '[]'::jsonb
  ) into v_total, v_user_ids
  from eligible;
  return jsonb_build_object(
    'policy_id', p_policy_id,
    'policy_version', v_policy.version,
    'eligible_count', v_total,
    'sample_user_ids', v_user_ids,
    'sample_truncated', v_total > p_limit
  );
end;
$$;

create or replace function private.bff_sync_dynamic_group_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_policy_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_command jsonb;
  v_policy public.dynamic_group_policies%rowtype;
  v_added integer := 0;
  v_removed integer := 0;
  v_response jsonb;
begin
  v_command := private.prepare_bff_command_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'dynamic_group.sync', true, 900, '/v2/dynamic-groups/:id/sync',
    p_idempotency_key, p_request_sha256
  );
  if v_command ->> 'state' = 'replay' then return v_command -> 'response'; end if;
  select * into v_policy from public.dynamic_group_policies policy
  where policy.organization_id = p_organization_id and policy.id = p_policy_id
  for update;
  if not found
    or not exists (
      select 1 from public.conversations authorized_conversation
      where authorized_conversation.organization_id = p_organization_id
        and authorized_conversation.id = v_policy.conversation_id
        and private.actor_has_permission(
          p_actor_user_id, p_organization_id, 'unit.manage', authorized_conversation.unit_id
        )
    ) then
    raise exception 'dynamic-group synchronization is not permitted' using errcode = '42501';
  end if;

  with recursive eligible_units(id) as (
    select v_policy.unit_id where v_policy.unit_id is not null
    union
    select child.id
    from public.organization_units child
    join eligible_units parent on child.parent_unit_id = parent.id
    where child.organization_id = p_organization_id
      and child.is_active and v_policy.include_unit_descendants
  ), eligible as (
    select membership.user_id
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.role = any(v_policy.member_roles)
      and (
        v_policy.unit_id is null
        or exists (
          select 1 from public.organization_unit_members unit_member
          where unit_member.organization_id = p_organization_id
            and unit_member.user_id = membership.user_id
            and unit_member.unit_id in (select id from eligible_units)
        )
      )
  )
  insert into public.conversation_members (
    organization_id, conversation_id, user_id, role, joined_by_user_id,
    managed_by_policy_id
  )
  select p_organization_id, v_policy.conversation_id, eligible.user_id,
    'member', p_actor_user_id, p_policy_id
  from eligible
  on conflict (organization_id, conversation_id, user_id) do nothing;
  get diagnostics v_added = row_count;

  with recursive eligible_units(id) as (
    select v_policy.unit_id where v_policy.unit_id is not null
    union
    select child.id
    from public.organization_units child
    join eligible_units parent on child.parent_unit_id = parent.id
    where child.organization_id = p_organization_id
      and child.is_active and v_policy.include_unit_descendants
  ), eligible as (
    select membership.user_id
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.status = 'active'
      and membership.role = any(v_policy.member_roles)
      and (
        v_policy.unit_id is null
        or exists (
          select 1 from public.organization_unit_members unit_member
          where unit_member.organization_id = p_organization_id
            and unit_member.user_id = membership.user_id
            and unit_member.unit_id in (select id from eligible_units)
        )
      )
  )
  update public.conversation_members member
  set status = 'removed', left_at = now()
  where member.organization_id = p_organization_id
    and member.conversation_id = v_policy.conversation_id
    and member.managed_by_policy_id = p_policy_id
    and member.status = 'active'
    and not exists (select 1 from eligible where eligible.user_id = member.user_id);
  get diagnostics v_removed = row_count;

  update public.dynamic_group_policies policy
  set status = 'active',
      approved_by_user_id = p_actor_user_id,
      approved_at = coalesce(policy.approved_at, now()),
      last_synced_at = now()
  where policy.organization_id = p_organization_id and policy.id = p_policy_id;
  perform private.enqueue_outbox_job_internal(
    p_organization_id, 'dynamic_group_sync',
    'dynamic-group:' || p_policy_id::text || ':version:' || v_policy.version::text,
    jsonb_build_object(
      'policy_id', p_policy_id,
      'conversation_id', v_policy.conversation_id,
      'policy_version', v_policy.version,
      'added_count', v_added,
      'removed_count', v_removed
    )
  );
  v_response := jsonb_build_object(
    'policy_id', p_policy_id,
    'policy_version', v_policy.version,
    'status', 'active',
    'added_count', v_added,
    'removed_count', v_removed,
    'synced', true
  );
  return private.finish_bff_command_internal(
    p_actor_user_id, p_organization_id, '/v2/dynamic-groups/:id/sync',
    p_idempotency_key, p_request_sha256, v_response
  );
end;
$$;

create or replace function public.bff_grant_role_assignment(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_target_user_id uuid, p_role_name text, p_scope_type text,
  p_unit_id uuid, p_expires_at timestamptz, p_reason text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_grant_role_assignment_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_target_user_id,
  p_role_name, p_scope_type, p_unit_id, p_expires_at, p_reason,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_revoke_role_assignment(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_assignment_id uuid, p_reason text, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_revoke_role_assignment_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_assignment_id,
  p_reason, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_list_role_assignments(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_target_user_id uuid, p_limit integer default 50
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_list_role_assignments_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_target_user_id, p_limit
) $$;

create or replace function public.bff_set_organization_ai_policy(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_enabled boolean, p_approved_use_cases text[], p_provider_allowlist text[],
  p_route_policy text, p_reason text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_set_organization_ai_policy_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_enabled,
  p_approved_use_cases, p_provider_allowlist, p_route_policy, p_reason,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_get_organization_preferences(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_get_organization_preferences_impl(
  p_actor_user_id, p_organization_id, p_session_id
) $$;

create or replace function public.bff_update_organization_preferences(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_patch jsonb, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_update_organization_preferences_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_patch,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_update_saved_contact(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_contact_user_id uuid, p_patch jsonb, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_update_saved_contact_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_contact_user_id,
  p_patch, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_remove_saved_contact(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_contact_user_id uuid, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_remove_saved_contact_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_contact_user_id,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_set_member_block(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_target_user_id uuid, p_blocked boolean, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_set_member_block_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_target_user_id,
  p_blocked, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_claim_outbox_topics(
  p_worker_id uuid, p_topics text[], p_limit integer default 20,
  p_lease_seconds integer default 60
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_claim_outbox_topics_impl(
  p_worker_id, p_topics, p_limit, p_lease_seconds
) $$;

create or replace function public.bff_resolve_push_job(
  p_worker_id uuid, p_job_id bigint, p_after_device_id uuid default null,
  p_limit integer default 500
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_resolve_push_job_impl(
  p_worker_id, p_job_id, p_after_device_id, p_limit
) $$;

create or replace function public.bff_record_push_submission(
  p_worker_id uuid, p_job_id bigint, p_attempt_id bigint,
  p_result text, p_provider_ticket_id text default null,
  p_error_code text default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_record_push_submission_impl(
  p_worker_id, p_job_id, p_attempt_id, p_result,
  p_provider_ticket_id, p_error_code
) $$;

create or replace function public.bff_claim_push_receipts(
  p_worker_id uuid, p_limit integer default 100,
  p_lease_seconds integer default 60
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_claim_push_receipts_impl(
  p_worker_id, p_limit, p_lease_seconds
) $$;

create or replace function public.bff_record_push_receipt(
  p_worker_id uuid, p_attempt_id bigint, p_result text,
  p_error_code text default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_record_push_receipt_impl(
  p_worker_id, p_attempt_id, p_result, p_error_code
) $$;

create or replace function public.bff_complete_push_dispatch_job(
  p_worker_id uuid, p_job_id bigint
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_complete_push_dispatch_job_impl(
  p_worker_id, p_job_id
) $$;

create or replace function public.bff_execute_session_revoke_job(
  p_worker_id uuid, p_job_id bigint
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_execute_session_revoke_job_impl(
  p_worker_id, p_job_id
) $$;

create or replace function public.bff_search(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_query text, p_types text[], p_cursor text default null,
  p_limit integer default 20, p_sender_user_id uuid default null,
  p_date_from timestamptz default null, p_date_to timestamptz default null
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_search_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_query,
  p_types, p_cursor, p_limit, p_sender_user_id, p_date_from, p_date_to
) $$;

create or replace function public.bff_bootstrap_messaging_state(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_selected_conversation_id uuid default null,
  p_before_message_id bigint default null,
  p_conversation_limit integer default 100,
  p_timeline_limit integer default 50
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_bootstrap_messaging_state_v2_impl(
  p_actor_user_id, p_organization_id, p_session_id,
  p_selected_conversation_id, p_before_message_id,
  p_conversation_limit, p_timeline_limit
) $$;

create or replace function public.bff_resolve_principal_context(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_requested_organization_id uuid default null
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_resolve_principal_context_impl(
  p_actor_user_id, p_session_id, p_requested_organization_id
) $$;

create or replace function public.bff_read_conversation_page(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_before_message_id bigint default null,
  p_limit integer default 50
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_read_conversation_page_impl(
  p_actor_user_id, p_organization_id, p_session_id,
  p_conversation_id, p_before_message_id, p_limit
) $$;

create or replace function public.bff_resolve_realtime_fanout(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_event text,
  p_entity_type text,
  p_entity_id text,
  p_version_id text default null,
  p_reason text default null
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_resolve_realtime_fanout_impl(
  p_organization_id, p_conversation_id, p_event, p_entity_type,
  p_entity_id, p_version_id, p_reason
) $$;

create or replace function public.bff_finalize_attachment_upload(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_attachment_id uuid, p_bucket_id text, p_storage_path text,
  p_object_byte_size bigint, p_object_sha256_hex text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_finalize_attachment_upload_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_attachment_id,
  p_bucket_id, p_storage_path, p_object_byte_size, p_object_sha256_hex,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_claim_attachment_scan_jobs(
  p_worker_id uuid, p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_claim_attachment_scan_jobs_impl(
  p_worker_id, p_limit, p_lease_seconds
) $$;

create or replace function public.bff_complete_attachment_scan(
  p_worker_id uuid, p_job_id bigint, p_attachment_id uuid,
  p_scan_result text, p_detected_mime_type text, p_policy_code text,
  p_scanner_name text, p_scanner_version text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_complete_attachment_scan_impl(
  p_worker_id, p_job_id, p_attachment_id, p_scan_result,
  p_detected_mime_type, p_policy_code, p_scanner_name, p_scanner_version
) $$;

create or replace function public.bff_fail_attachment_scan(
  p_worker_id uuid, p_job_id bigint, p_attachment_id uuid,
  p_failure_code text, p_scanner_name text, p_scanner_version text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_fail_attachment_scan_impl(
  p_worker_id, p_job_id, p_attachment_id, p_failure_code,
  p_scanner_name, p_scanner_version
) $$;

create or replace function public.bff_bootstrap_organization(
  p_owner_user_id uuid, p_name text, p_slug text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_bootstrap_organization_impl(
  p_owner_user_id, p_name, p_slug, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_propose_operational_action(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_source_message_id bigint, p_title text,
  p_details text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_propose_operational_action_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_source_message_id, p_title, p_details, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_confirm_operational_action(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_action_id uuid, p_assignee_user_id uuid, p_due_at timestamptz,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_confirm_operational_action_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_action_id,
  p_assignee_user_id, p_due_at, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_transition_operational_action(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_action_id uuid, p_status text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_transition_operational_action_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_action_id,
  p_status, p_note, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_save_dynamic_group_policy(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_policy_id uuid, p_unit_id uuid,
  p_member_roles text[], p_include_unit_descendants boolean,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_save_dynamic_group_policy_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_policy_id, p_unit_id, p_member_roles, p_include_unit_descendants,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_preview_dynamic_group(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_policy_id uuid, p_limit integer default 100
)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select private.bff_preview_dynamic_group_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_policy_id, p_limit
) $$;

create or replace function public.bff_sync_dynamic_group(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_policy_id uuid, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_sync_dynamic_group_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_policy_id,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_propose_glossary_term(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_term_id uuid, p_source_language text, p_target_language text,
  p_source_term text, p_translated_term text, p_definition text,
  p_reason text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_propose_glossary_term_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_term_id,
  p_source_language, p_target_language, p_source_term, p_translated_term,
  p_definition, p_reason, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_review_glossary_version(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_term_version_id uuid, p_decision text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_review_glossary_version_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_term_version_id,
  p_decision, p_note, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_propose_translation_correction(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_target_language text,
  p_corrected_body text, p_rationale text, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_propose_translation_correction_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_message_id, p_target_language, p_corrected_body, p_rationale,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_review_translation_correction(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_correction_id uuid, p_decision text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_review_translation_correction_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_correction_id,
  p_decision, p_note, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_update_conversation_preferences(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_patch jsonb, p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_update_conversation_preferences_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_patch, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_set_message_pin(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_pinned boolean,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_set_message_pin_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_message_id, p_pinned, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_mark_message_receipt(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_message_id bigint, p_state text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_mark_message_receipt_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_message_id, p_state, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_correct_announcement(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_announcement_id uuid, p_client_nonce uuid, p_title text, p_body text,
  p_priority text, p_requires_acknowledgement boolean, p_expires_at timestamptz,
  p_reason text, p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_correct_announcement_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_announcement_id,
  p_client_nonce, p_title, p_body, p_priority, p_requires_acknowledgement,
  p_expires_at, p_reason, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_correct_handoff(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_handoff_id uuid, p_title text, p_details text, p_source_language text,
  p_shift_started_at timestamptz, p_shift_ended_at timestamptz,
  p_source_message_ids bigint[], p_acknowledgement_due_at timestamptz,
  p_reason text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_correct_handoff_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_handoff_id, p_title,
  p_details, p_source_language, p_shift_started_at, p_shift_ended_at,
  p_source_message_ids, p_acknowledgement_due_at, p_reason,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_bind_session_installation(
  p_actor_user_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_platform text,
  p_app_version text,
  p_locale text,
  p_user_agent_hash text,
  p_user_agent_family text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_bind_session_installation_impl(
    p_actor_user_id, p_session_id, p_installation_id, p_platform,
    p_app_version, p_locale, p_user_agent_hash, p_user_agent_family
  )
$$;

create or replace function public.bff_register_device(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_installation_id uuid,
  p_platform text,
  p_push_token_ciphertext text,
  p_push_token_type text,
  p_push_project_id uuid,
  p_push_environment text,
  p_app_version text,
  p_locale text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_register_device_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_installation_id,
    p_platform, p_push_token_ciphertext, p_push_token_type, p_push_project_id,
    p_push_environment, p_app_version, p_locale,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_list_sessions(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_current_session_id uuid
)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select private.bff_list_sessions_impl(
    p_actor_user_id, p_organization_id, p_current_session_id
  )
$$;

create or replace function public.bff_list_admin_members(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_after_user_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select private.bff_list_admin_members_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_after_user_id, p_limit
  )
$$;

create or replace function public.bff_get_attachment_state(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_attachment_id uuid
)
returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select private.bff_get_attachment_state_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_attachment_id
  )
$$;

create or replace function public.bff_edit_message(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_body text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_edit_message_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_body, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_delete_message(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_delete_message_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_set_message_reaction(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_emoji text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_set_message_reaction_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_emoji, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_remove_message_reaction(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_emoji text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_remove_message_reaction_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_emoji, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_request_contact(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_request_contact_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_target_user_id,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_respond_contact(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_other_user_id uuid,
  p_status text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_respond_contact_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_other_user_id,
    p_status, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_remove_contact(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_other_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_remove_contact_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_other_user_id,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_authorize_attachment_download(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_attachment_id uuid
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_authorize_attachment_download_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_attachment_id
  )
$$;

create or replace function public.bff_authorize_request(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_require_aal2 boolean,
  p_recent_auth_seconds integer
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_authorize_request_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_operation,
    p_require_aal2, p_recent_auth_seconds
  )
$$;

create or replace function public.bff_consume_rate_limit(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_operation text,
  p_ip_hash text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_consume_rate_limit_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_operation, p_ip_hash
  )
$$;

create or replace function public.bff_begin_idempotency(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_route text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_begin_idempotency_impl(
    p_actor_user_id, p_organization_id, p_route, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_complete_idempotency(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_route text,
  p_idempotency_key text,
  p_request_sha256 text,
  p_status integer,
  p_response jsonb
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_complete_idempotency_impl(
    p_actor_user_id, p_organization_id, p_route, p_idempotency_key,
    p_request_sha256, p_status, p_response
  )
$$;

create or replace function public.bff_create_direct_conversation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_other_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_direct_conversation_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_other_user_id,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_create_group_conversation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_name text,
  p_member_user_ids uuid[],
  p_kind text,
  p_unit_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_group_conversation_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_name,
    p_member_user_ids, p_kind, p_unit_id, 'since_join', null, null,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_create_group_conversation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_name text,
  p_member_user_ids uuid[],
  p_kind text,
  p_unit_id uuid,
  p_history_policy text,
  p_incident_severity text,
  p_incident_classification text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_group_conversation_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_name,
    p_member_user_ids, p_kind, p_unit_id, p_history_policy,
    p_incident_severity, p_incident_classification,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_close_incident(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
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
  select private.bff_close_incident_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_reason, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_send_message(
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
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_send_message_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_kind, p_body, p_language_code, p_reply_to_message_id,
    p_thread_root_message_id, p_metadata, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_hide_message_for_me(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_hide_message_for_me_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_message_id, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_forward_message(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_source_conversation_id uuid,
  p_source_message_id bigint,
  p_target_conversation_id uuid,
  p_client_nonce uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_forward_message_impl(
  p_actor_user_id, p_organization_id, p_session_id,
  p_source_conversation_id, p_source_message_id, p_target_conversation_id,
  p_client_nonce, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_request_conversation_summary(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_source_message_ids bigint[], p_language_code text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_request_conversation_summary_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_source_message_ids, p_language_code, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_create_manual_summary(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_source_message_ids bigint[], p_language_code text,
  p_primary_topic text, p_summary_body text,
  p_key_topics text[], p_decisions jsonb, p_action_items jsonb, p_ambiguities text[],
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_create_manual_summary_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_source_message_ids, p_language_code, p_primary_topic, p_summary_body,
  p_key_topics, p_decisions, p_action_items, p_ambiguities,
  p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_review_conversation_summary(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_summary_id uuid, p_decision text, p_note text,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_review_conversation_summary_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_summary_id,
  p_decision, p_note, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_set_summary_policy(
  p_actor_user_id uuid, p_organization_id uuid, p_session_id uuid,
  p_conversation_id uuid, p_mode text, p_message_count_threshold integer,
  p_idempotency_key text, p_request_sha256 text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_set_summary_policy_impl(
  p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
  p_mode, p_message_count_threshold, p_idempotency_key, p_request_sha256
) $$;

create or replace function public.bff_update_conversation(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_patch jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_update_conversation_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_patch, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_add_conversation_member(
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
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_add_conversation_member_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_target_user_id, p_role, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_remove_conversation_member(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_target_user_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_remove_conversation_member_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_target_user_id, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_report_message(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_category text,
  p_details text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_report_message_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_category, p_details, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_publish_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_language_code text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_title, p_body, p_language_code, p_priority,
    p_requires_acknowledgement, p_expires_at, null,
    '{"schema_version":1,"attestation_required":false,"attestation_prompt":null,"required_keys":[],"carry_forward_on_correction":false}'::jsonb,
    'routine', null, null,
    '{"enabled":false,"deadline_at":null,"interval_seconds":null,"maximum_reminders":0,"escalate_after_seconds":null,"sms_fallback":false}'::jsonb,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_create_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_client_nonce uuid,
  p_title text,
  p_body text,
  p_language_code text,
  p_priority text,
  p_requires_acknowledgement boolean,
  p_expires_at timestamptz,
  p_scheduled_at timestamptz,
  p_acknowledgement_schema jsonb,
  p_notification_class text,
  p_critical_category text,
  p_quiet_hours_override_reason text,
  p_reminder_policy jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_client_nonce, p_title, p_body, p_language_code, p_priority,
    p_requires_acknowledgement, p_expires_at, p_scheduled_at,
    p_acknowledgement_schema, p_notification_class, p_critical_category,
    p_quiet_hours_override_reason, p_reminder_policy,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_preview_announcement_audience(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_limit integer default 25
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_preview_announcement_audience_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id, p_limit
  )
$$;

create or replace function public.bff_cancel_scheduled_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_id uuid,
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
  select private.bff_cancel_scheduled_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_announcement_id,
    p_reason, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_acknowledge_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_version_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_acknowledge_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_announcement_version_id,
    null, '{}'::jsonb,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_acknowledge_announcement(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_announcement_version_id uuid,
  p_device_id uuid,
  p_attestation jsonb,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_acknowledge_announcement_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_announcement_version_id,
    p_device_id, p_attestation, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_promote_due_announcements(
  p_worker_id uuid,
  p_limit integer default 50
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_promote_due_announcements_impl(p_worker_id, p_limit)
$$;

create or replace function public.bff_process_announcement_obligations(
  p_worker_id uuid,
  p_limit integer default 100
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_process_announcement_obligations_impl(p_worker_id, p_limit)
$$;

create or replace function public.bff_process_overdue_handoffs(
  p_worker_id uuid,
  p_limit integer default 100
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_process_overdue_handoffs_impl(p_worker_id, p_limit)
$$;

create or replace function public.bff_create_handoff(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_title text,
  p_details text,
  p_source_language text,
  p_shift_started_at timestamptz,
  p_shift_ended_at timestamptz,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_handoff_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_title, p_details, p_source_language, p_shift_started_at, p_shift_ended_at,
    array[]::bigint[], null,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_create_handoff(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_title text,
  p_details text,
  p_source_language text,
  p_shift_started_at timestamptz,
  p_shift_ended_at timestamptz,
  p_source_message_ids bigint[],
  p_acknowledgement_due_at timestamptz,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_handoff_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_title, p_details, p_source_language, p_shift_started_at, p_shift_ended_at,
    p_source_message_ids, p_acknowledgement_due_at,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_sign_handoff(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_version_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_sign_handoff_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_handoff_version_id,
    null, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_sign_handoff(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_version_id uuid,
  p_device_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_sign_handoff_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_handoff_version_id,
    p_device_id, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_acknowledge_handoff(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_version_id uuid,
  p_note text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_acknowledge_handoff_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_handoff_version_id, p_note,
    null, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_acknowledge_handoff(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_handoff_version_id uuid,
  p_note text,
  p_device_id uuid,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_acknowledge_handoff_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_handoff_version_id, p_note,
    p_device_id, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_suspend_member(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_user_id uuid,
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
  select private.bff_suspend_member_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_target_user_id,
    p_reason, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_revoke_session(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_target_session_id uuid,
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
  select private.bff_revoke_session_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_target_session_id,
    p_reason, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_create_attachment_upload(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_conversation_id uuid,
  p_message_id bigint,
  p_file_name text,
  p_mime_type text,
  p_byte_size bigint,
  p_sha256_hex text,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_create_attachment_upload_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_file_name, p_mime_type, p_byte_size, p_sha256_hex,
    p_idempotency_key, p_request_sha256
  )
$$;

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
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_enqueue_translation_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_conversation_id,
    p_message_id, p_target_language, p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_resolve_invite_principal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_destination_type text,
  p_destination text
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select private.bff_resolve_invite_principal_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_destination_type, p_destination
  )
$$;

create or replace function public.bff_issue_organization_invite(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_destination_type text,
  p_destination text,
  p_invited_user_id uuid,
  p_employee_code text,
  p_activation_mode text,
  p_role text,
  p_expires_in_seconds integer,
  p_idempotency_key text,
  p_request_sha256 text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_issue_organization_invite_impl(
    p_actor_user_id, p_organization_id, p_session_id,
    p_destination_type, p_destination, p_invited_user_id,
    p_employee_code, p_activation_mode, p_role, p_expires_in_seconds,
    p_idempotency_key, p_request_sha256
  )
$$;

create or replace function public.bff_authorize_invite_otp(
  p_invite_token text,
  p_destination_type text,
  p_destination text,
  p_employee_code text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_authorize_invite_otp_impl(
    p_invite_token, p_destination_type, p_destination, p_employee_code,
    p_ip_hash, p_installation_hash, p_purpose
  )
$$;

create or replace function public.bff_authorize_member_otp(
  p_destination_type text,
  p_destination text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_authorize_member_otp_impl(
    p_destination_type, p_destination, p_ip_hash, p_installation_hash, p_purpose
  )
$$;

create or replace function public.redeem_organization_invite(
  p_token text,
  p_employee_code text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.redeem_organization_invite_impl(p_token, p_employee_code)
$$;

create or replace function public.bff_claim_outbox_jobs(
  p_worker_id uuid,
  p_limit integer default 20,
  p_lease_seconds integer default 60
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_claim_outbox_jobs_impl(p_worker_id, p_limit, p_lease_seconds)
$$;

create or replace function public.bff_claim_translation_jobs(
  p_worker_id uuid,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_claim_translation_jobs_impl(p_worker_id, p_limit, p_lease_seconds)
$$;

create or replace function public.bff_claim_language_detection_jobs(
  p_worker_id uuid,
  p_limit integer default 10,
  p_lease_seconds integer default 60
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_claim_language_detection_jobs_impl(
    p_worker_id, p_limit, p_lease_seconds
  )
$$;

create or replace function public.bff_complete_outbox_job(
  p_worker_id uuid,
  p_job_id bigint
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_complete_outbox_job_impl(p_worker_id, p_job_id)
$$;

create or replace function public.bff_fail_outbox_job(
  p_worker_id uuid,
  p_job_id bigint,
  p_error_code text,
  p_retry_seconds integer default 60
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_fail_outbox_job_impl(
    p_worker_id, p_job_id, p_error_code, p_retry_seconds
  )
$$;

create or replace function public.bff_claim_summary_jobs(
  p_worker_id uuid, p_limit integer default 10,
  p_lease_seconds integer default 300
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_claim_summary_jobs_impl(
  p_worker_id, p_limit, p_lease_seconds
) $$;

create or replace function public.bff_resolve_summary_job_sources(
  p_worker_id uuid, p_job_id bigint, p_provider text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_resolve_summary_job_sources_impl(
  p_worker_id, p_job_id, p_provider
) $$;

create or replace function public.bff_complete_summary_job(
  p_worker_id uuid, p_job_id bigint, p_source_fingerprint text,
  p_primary_topic text, p_summary_body text,
  p_key_topics text[], p_decisions jsonb, p_action_items jsonb, p_ambiguities text[],
  p_provider text, p_model text, p_provenance jsonb
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_complete_summary_job_impl(
  p_worker_id, p_job_id, p_source_fingerprint, p_primary_topic,
  p_summary_body, p_key_topics, p_decisions, p_action_items, p_ambiguities,
  p_provider, p_model, p_provenance
) $$;

create or replace function public.bff_fail_summary_job(
  p_worker_id uuid, p_job_id bigint, p_failure_code text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_fail_summary_job_impl(
  p_worker_id, p_job_id, p_failure_code
) $$;

create or replace function public.bff_resolve_language_detection_job_source(
  p_worker_id uuid,
  p_job_id bigint,
  p_provider text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_resolve_language_detection_job_source_impl(
  p_worker_id, p_job_id, p_provider
) $$;

create or replace function public.bff_complete_language_detection_job(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_detection_state text,
  p_detected_language text,
  p_method text,
  p_confidence numeric
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_complete_language_detection_job_impl(
  p_worker_id, p_job_id, p_source_sha256, p_detection_state,
  p_detected_language, p_method, p_confidence
) $$;

create or replace function public.bff_fail_language_detection_job(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_method text,
  p_error_code text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_fail_language_detection_job_impl(
  p_worker_id, p_job_id, p_source_sha256, p_method, p_error_code
) $$;

create or replace function public.bff_resolve_translation_job_for_egress(
  p_worker_id uuid,
  p_job_id bigint,
  p_provider text
)
returns jsonb language sql volatile security invoker set search_path = ''
as $$ select private.bff_resolve_translation_job_for_egress_impl(
  p_worker_id, p_job_id, p_provider
) $$;

create or replace function public.bff_complete_translation_job(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_translated_body text,
  p_provider text,
  p_model text,
  p_confidence numeric
)
returns void
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_complete_translation_job_impl(
    p_worker_id, p_job_id, p_source_sha256, p_translated_body,
    p_provider, p_model, p_confidence
  )
$$;

create or replace function public.bff_fail_translation_job(
  p_worker_id uuid,
  p_job_id bigint,
  p_source_sha256 text,
  p_provider text,
  p_error_code text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_fail_translation_job_impl(
    p_worker_id, p_job_id, p_source_sha256, p_provider, p_error_code
  )
$$;

create or replace function public.bff_scrub_retention(p_batch_size integer default 500)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_scrub_retention_impl(p_batch_size)
$$;

create or replace function private.validate_conversation_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is null and v_jwt_role <> 'service_role' then
    raise exception 'signed-in user required' using errcode = '42501';
  end if;
  if v_actor_id is not null and new.created_by_user_id <> v_actor_id then
    raise exception 'conversation creator must match signed-in user' using errcode = '42501';
  end if;
  if new.is_archived then
    raise exception 'new conversations cannot be archived' using errcode = '22000';
  end if;
  if new.kind = 'announcement'
    and v_jwt_role <> 'service_role'
    and not (select private.is_org_admin(new.organization_id)) then
    raise exception 'organization administrator permission required' using errcode = '42501';
  end if;
  if new.kind = 'direct'
    and v_jwt_role <> 'service_role'
    and not exists (
      select 1
      from public.organizations organization
      where organization.id = new.organization_id
        and organization.allow_member_direct_messages
    ) then
    raise exception 'direct messages are disabled for this organization' using errcode = '42501';
  end if;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.validate_message_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is null and v_jwt_role <> 'service_role' then
    raise exception 'signed-in user required' using errcode = '42501';
  end if;
  if v_actor_id is not null and new.sender_user_id <> v_actor_id then
    raise exception 'message sender must match signed-in user' using errcode = '42501';
  end if;
  if v_jwt_role <> 'service_role' and new.kind = 'system' then
    raise exception 'system messages require a service workflow' using errcode = '42501';
  end if;
  if new.edited_at is not null
    or new.deleted_at is not null
    or new.deleted_by_user_id is not null
    or new.deletion_reason is not null then
    raise exception 'new messages cannot be edited or deleted' using errcode = '22000';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create or replace function private.validate_announcement_recipient_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if new.organization_id is distinct from old.organization_id
    or new.announcement_id is distinct from old.announcement_id
    or new.user_id is distinct from old.user_id
    or new.created_at is distinct from old.created_at then
    raise exception 'announcement recipient identity fields are immutable' using errcode = '22000';
  end if;
  if v_actor_id is not null then
    if new.user_id <> v_actor_id then
      raise exception 'recipients may update only their own state' using errcode = '42501';
    end if;
    if new.delivered_at is distinct from old.delivered_at then
      raise exception 'delivery timestamps are assigned by the trusted delivery service' using errcode = '42501';
    end if;
    if new.read_at is distinct from old.read_at then
      if old.read_at is not null or new.read_at is null then
        raise exception 'read state cannot move backwards' using errcode = '22000';
      end if;
      new.read_at := now();
      new.delivered_at := coalesce(old.delivered_at, new.read_at);
    end if;
  elsif v_jwt_role <> 'service_role' then
    raise exception 'announcement recipient update is not authorized' using errcode = '42501';
  end if;
  if old.delivered_at is not null and new.delivered_at is null then
    raise exception 'delivery state cannot move backwards' using errcode = '22000';
  end if;
  if old.read_at is not null and new.read_at is null then
    raise exception 'read state cannot move backwards' using errcode = '22000';
  end if;
  if new.read_at is not null then
    new.delivered_at := coalesce(new.delivered_at, new.read_at);
  end if;
  return new;
end;
$$;

create or replace function private.validate_acknowledgement_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is not null then
    if new.user_id <> v_actor_id then
      raise exception 'acknowledgement actor must match signed-in user' using errcode = '42501';
    end if;
    new.acknowledged_at := now();
  elsif v_jwt_role <> 'service_role' then
    raise exception 'acknowledgement is not authorized' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function private.snapshot_announcement_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.announcement_versions (
    organization_id, announcement_id, conversation_id, version_number,
    message_id, title, priority, requires_acknowledgement,
    acknowledgement_schema, notification_class, critical_category,
    quiet_hours_override_reason, reminder_policy,
    scheduled_at, published_at, expires_at, created_by_user_id
  ) values (
    new.organization_id, new.id, new.conversation_id, 1,
    new.message_id, new.title, new.priority, new.requires_acknowledgement,
    new.acknowledgement_schema, new.notification_class, new.critical_category,
    new.quiet_hours_override_reason, new.reminder_policy,
    new.scheduled_at, new.published_at, new.expires_at, new.created_by_user_id
  );
  return new;
end;
$$;

create or replace function private.bind_announcement_ack_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.announcement_version_id is null then
    select version.id into new.announcement_version_id
    from public.announcement_versions version
    where version.organization_id = new.organization_id
      and version.announcement_id = new.announcement_id
    order by version.version_number desc
    limit 1;
  end if;
  if new.announcement_version_id is null then
    raise exception 'announcement version is required' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.snapshot_handoff_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.handoff_versions (
    organization_id, handoff_id, conversation_id, version_number, title,
    details, source_language, shift_started_at, shift_ended_at,
    source_message_ids, source_fingerprint, acknowledgement_due_at,
    created_by_user_id
  ) values (
    new.organization_id, new.id, new.conversation_id, 1, new.title,
    new.details, new.source_language, new.shift_started_at,
    new.shift_ended_at, new.source_message_ids, new.source_fingerprint,
    new.acknowledgement_due_at, new.author_user_id
  );
  return new;
end;
$$;

create or replace function private.bind_handoff_ack_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.handoff_version_id is null then
    select coalesce(handoff.submitted_version_id, version.id)
      into new.handoff_version_id
    from public.shift_handoffs handoff
    join lateral (
      select candidate.id
      from public.handoff_versions candidate
      where candidate.organization_id = handoff.organization_id
        and candidate.handoff_id = handoff.id
      order by candidate.version_number desc
      limit 1
    ) version on true
    where handoff.organization_id = new.organization_id
      and handoff.id = new.handoff_id;
  end if;
  if new.handoff_version_id is null then
    raise exception 'handoff version is required' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function private.validate_conversation_summary_update()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.conversation_id is distinct from old.conversation_id
    or new.version_number is distinct from old.version_number
    or new.correction_of_summary_id is distinct from old.correction_of_summary_id
    or new.source_message_ids is distinct from old.source_message_ids
    or new.source_first_message_id is distinct from old.source_first_message_id
    or new.source_last_message_id is distinct from old.source_last_message_id
    or new.source_fingerprint is distinct from old.source_fingerprint
    or new.requested_by_user_id is distinct from old.requested_by_user_id
    or new.request_mode is distinct from old.request_mode
    or new.language_code is distinct from old.language_code
    or new.created_at is distinct from old.created_at then
    raise exception 'summary version identity and sources are immutable' using errcode = '22000';
  end if;
  if coalesce(current_setting('app.summary_stale_context', true), 'off') = 'on'
    and new.status = 'stale'
    and new.primary_topic is null and new.summary_body is null
    and new.output_fingerprint is null
    and new.failure_code in (
      'source_deleted', 'source_changed', 'source_stale_or_deleted',
      'requester_or_source_unauthorized', 'tenant_ai_policy_denied'
    ) then
    new.updated_at := now();
    return new;
  end if;
  if old.status in ('approved', 'failed', 'stale') then
    raise exception 'terminal summary versions are immutable' using errcode = '22000';
  end if;
  if old.status in ('queued', 'processing')
    and v_jwt_role <> 'service_role' then
    raise exception 'summary processing state is worker-owned' using errcode = '42501';
  end if;
  if old.status = 'draft'
    and coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'summary review requires checked BFF context' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.prevent_immutable_record_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'immutable records cannot be updated or deleted' using errcode = '22000';
end;
$$;

create or replace function private.validate_handoff_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is null and v_jwt_role <> 'service_role' then
    raise exception 'signed-in user required' using errcode = '42501';
  end if;
  if v_actor_id is not null and new.author_user_id <> v_actor_id then
    raise exception 'handoff author must match signed-in user' using errcode = '42501';
  end if;
  if v_jwt_role <> 'service_role' and (new.status <> 'draft' or new.submitted_at is not null) then
    raise exception 'new handoffs must be drafts' using errcode = '22000';
  end if;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function private.validate_attachment_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
  v_message_kind text;
begin
  if v_actor_id is null and v_jwt_role <> 'service_role' then
    raise exception 'signed-in user required' using errcode = '42501';
  end if;
  if v_actor_id is not null then
    if new.created_by_user_id <> v_actor_id
      or not (select private.is_message_sender(new.organization_id, new.conversation_id, new.message_id)) then
      raise exception 'attachments may only be registered by the message sender' using errcode = '42501';
    end if;
    if new.scan_status <> 'pending' then
      raise exception 'client attachments must await malware scanning' using errcode = '42501';
    end if;
  end if;
  select message.kind into v_message_kind
  from public.messages message
  where message.organization_id = new.organization_id
    and message.conversation_id = new.conversation_id
    and message.id = new.message_id;
  if v_message_kind is distinct from 'attachment' then
    raise exception 'attachment metadata must reference an attachment message' using errcode = '23514';
  end if;
  new.created_at := now();
  return new;
end;
$$;

create or replace function private.validate_device_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_jwt_role text := coalesce((select auth.jwt() ->> 'role'), '');
begin
  if v_actor_id is null and v_jwt_role <> 'service_role' then
    raise exception 'signed-in user required' using errcode = '42501';
  end if;
  if v_actor_id is not null and (new.user_id <> v_actor_id or new.revoked_at is not null) then
    raise exception 'invalid device registration owner or state' using errcode = '42501';
  end if;
  if new.session_id is null or not exists (
    select 1
    from auth.sessions session
    join private.session_installations binding
      on binding.session_id = session.id
     and binding.user_id = session.user_id
     and binding.installation_id = new.installation_id
     and binding.platform = new.platform
     and binding.revoked_at is null
    where session.id = new.session_id and session.user_id = new.user_id
  ) then
    raise exception 'active bound device session required' using errcode = '23514';
  end if;
  new.created_at := now();
  new.updated_at := now();
  new.last_seen_at := now();
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_auth_user();

create trigger profiles_10_validate_update
before update on public.profiles
for each row execute function private.validate_profile_update();
create trigger profiles_90_touch_updated_at
before update on public.profiles
for each row execute function private.touch_updated_at();

create trigger organizations_10_validate_update
before update on public.organizations
for each row execute function private.validate_organization_update();
create trigger organizations_90_touch_updated_at
before update on public.organizations
for each row execute function private.touch_updated_at();

create trigger organization_units_10_validate_update
before update on public.organization_units
for each row execute function private.validate_unit_update();
create trigger organization_units_90_touch_updated_at
before update on public.organization_units
for each row execute function private.touch_updated_at();

create trigger organization_memberships_10_validate_update
before update on public.organization_memberships
for each row execute function private.validate_membership_update();
create trigger organization_memberships_90_touch_updated_at
before update on public.organization_memberships
for each row execute function private.touch_updated_at();
create trigger organization_memberships_95_apply_status_side_effects
after update of status on public.organization_memberships
for each row execute function private.apply_membership_status_side_effects();

create trigger contact_connections_10_validate_write
before insert or update on public.contact_connections
for each row execute function private.validate_contact_connection_write();
create trigger contact_connections_90_touch_updated_at
before update on public.contact_connections
for each row execute function private.touch_updated_at();

create trigger conversations_10_validate_insert
before insert on public.conversations
for each row execute function private.validate_conversation_insert();
create trigger conversations_10_validate_update
before update on public.conversations
for each row execute function private.validate_conversation_update();
create trigger conversations_90_touch_updated_at
before update on public.conversations
for each row execute function private.touch_updated_at();

create trigger direct_conversation_pairs_10_validate_insert
before insert on public.direct_conversation_pairs
for each row execute function private.validate_direct_pair_insert();

create trigger conversation_members_10_validate_write
before insert or update on public.conversation_members
for each row execute function private.validate_conversation_member_write();
create trigger conversation_members_90_touch_updated_at
before update on public.conversation_members
for each row execute function private.touch_updated_at();

create trigger messages_10_validate_insert
before insert on public.messages
for each row execute function private.validate_message_insert();
create trigger messages_10_validate_update
before update on public.messages
for each row execute function private.validate_message_update();
create trigger messages_80_broadcast_change
after insert or update on public.messages
for each row execute function private.broadcast_message_change();
create trigger messages_85_maybe_auto_summary
after insert on public.messages
for each row execute function private.maybe_queue_automatic_summary();

create trigger message_translations_90_touch_updated_at
before update on public.message_translations
for each row execute function private.touch_updated_at();
create trigger message_translations_10_validate_write
before insert or update on public.message_translations
for each row execute function private.validate_translation_write();

create trigger conversation_read_cursors_10_validate_write
before insert or update on public.conversation_read_cursors
for each row execute function private.validate_read_cursor_write();
create trigger conversation_read_cursors_90_touch_updated_at
before update on public.conversation_read_cursors
for each row execute function private.touch_updated_at();

create trigger announcements_10_validate_write
before insert or update on public.announcements
for each row execute function private.validate_announcement_write();
create trigger announcements_80_snapshot_recipients
after insert on public.announcements
for each row execute function private.snapshot_announcement_recipients();
create trigger announcements_85_snapshot_version
after insert on public.announcements
for each row execute function private.snapshot_announcement_version();

create trigger announcement_recipients_10_validate_update
before update on public.announcement_recipients
for each row execute function private.validate_announcement_recipient_update();

create trigger announcement_acknowledgements_05_bind_version
before insert on public.announcement_acknowledgements
for each row execute function private.bind_announcement_ack_version();
create trigger announcement_acknowledgements_10_validate_insert
before insert on public.announcement_acknowledgements
for each row execute function private.validate_acknowledgement_insert();

create trigger shift_handoffs_10_validate_insert
before insert on public.shift_handoffs
for each row execute function private.validate_handoff_insert();
create trigger shift_handoffs_10_validate_update
before update on public.shift_handoffs
for each row execute function private.validate_handoff_update();
create trigger shift_handoffs_90_touch_updated_at
before update on public.shift_handoffs
for each row execute function private.touch_updated_at();
create trigger shift_handoffs_95_snapshot_version
after insert on public.shift_handoffs
for each row execute function private.snapshot_handoff_version();

create trigger handoff_acknowledgements_05_bind_version
before insert on public.handoff_acknowledgements
for each row execute function private.bind_handoff_ack_version();
create trigger handoff_acknowledgements_10_validate_insert
before insert on public.handoff_acknowledgements
for each row execute function private.validate_acknowledgement_insert();

create trigger announcement_versions_immutable
before update or delete on public.announcement_versions
for each row execute function private.prevent_immutable_record_mutation();
create trigger handoff_versions_immutable
before update or delete on public.handoff_versions
for each row execute function private.prevent_immutable_record_mutation();
create trigger glossary_term_versions_immutable
before update or delete on public.glossary_term_versions
for each row execute function private.prevent_immutable_record_mutation();
create trigger glossary_reviews_immutable
before update or delete on public.glossary_reviews
for each row execute function private.prevent_immutable_record_mutation();
create trigger operational_action_events_immutable
before update or delete on public.operational_action_events
for each row execute function private.prevent_immutable_record_mutation();
create trigger message_mentions_immutable
before update or delete on public.message_mentions
for each row execute function private.prevent_immutable_record_mutation();
create trigger message_user_visibility_immutable
before update or delete on public.message_user_visibility
for each row execute function private.prevent_immutable_record_mutation();
create trigger message_forward_provenance_immutable
before update or delete on public.message_forward_provenance
for each row execute function private.prevent_immutable_record_mutation();
create trigger conversation_summary_policies_90_touch_updated_at
before update on public.conversation_summary_policies
for each row execute function private.touch_updated_at();
create trigger conversation_summaries_10_validate_update
before update on public.conversation_summaries
for each row execute function private.validate_conversation_summary_update();
create trigger conversation_summaries_immutable_delete
before delete on public.conversation_summaries
for each row execute function private.prevent_immutable_record_mutation();

create trigger message_attachments_10_validate_insert
before insert on public.message_attachments
for each row execute function private.validate_attachment_insert();

create trigger session_installations_10_validate_write
before insert or update on private.session_installations
for each row execute function private.validate_session_installation_write();

create trigger device_registrations_10_validate_insert
before insert on public.device_registrations
for each row execute function private.validate_device_insert();
create trigger device_registrations_10_validate_update
before update on public.device_registrations
for each row execute function private.validate_device_update();
create trigger device_registrations_20_apply_revocation
after update of revoked_at, session_id on public.device_registrations
for each row execute function private.apply_device_revocation_side_effects();
create trigger device_registrations_90_touch_updated_at
before update on public.device_registrations
for each row execute function private.touch_updated_at();

create trigger organization_invites_10_validate_update
before update on public.organization_invites
for each row execute function private.validate_invite_update();
create trigger organization_invites_90_touch_updated_at
before update on public.organization_invites
for each row execute function private.touch_updated_at();

create trigger conversation_preferences_90_touch_updated_at
before update on public.conversation_preferences
for each row execute function private.touch_updated_at();
create trigger organization_user_preferences_90_touch_updated_at
before update on public.organization_user_preferences
for each row execute function private.touch_updated_at();
create trigger organization_ai_policies_90_touch_updated_at
before update on public.organization_ai_policies
for each row execute function private.touch_updated_at();
create trigger saved_contacts_90_touch_updated_at
before update on public.saved_contacts
for each row execute function private.touch_updated_at();
create trigger message_receipts_90_touch_updated_at
before update on public.message_receipts
for each row execute function private.touch_updated_at();
create trigger translation_corrections_90_touch_updated_at
before update on public.translation_corrections
for each row execute function private.touch_updated_at();
create trigger operational_actions_90_touch_updated_at
before update on public.operational_actions
for each row execute function private.touch_updated_at();
create trigger dynamic_group_policies_90_touch_updated_at
before update on public.dynamic_group_policies
for each row execute function private.touch_updated_at();
create trigger shift_assignments_90_touch_updated_at
before update on public.shift_assignments
for each row execute function private.touch_updated_at();

create trigger audit_events_immutable
before update or delete on public.audit_events
for each row execute function private.prevent_audit_mutation();

create trigger audit_memberships
after insert or update on public.organization_memberships
for each row execute function private.write_audit_event('organization_membership', 'user_id');
create trigger audit_contacts
after insert or update on public.contact_connections
for each row execute function private.write_audit_event('contact_connection', 'requested_by_user_id');
create trigger audit_blocks
after insert or delete on public.member_blocks
for each row execute function private.write_audit_event('member_block', 'blocked_user_id');
create trigger audit_conversations
after insert or update on public.conversations
for each row execute function private.write_audit_event('conversation', 'id');
create trigger audit_conversation_members
after insert or update on public.conversation_members
for each row execute function private.write_audit_event('conversation_member', 'user_id');
create trigger audit_messages
after insert or update on public.messages
for each row execute function private.write_audit_event('message', 'id');
create trigger audit_announcements
after insert or update on public.announcements
for each row execute function private.write_audit_event('announcement', 'id');
create trigger audit_handoffs
after insert or update on public.shift_handoffs
for each row execute function private.write_audit_event('shift_handoff', 'id');
create trigger audit_attachments
after insert or update on public.message_attachments
for each row execute function private.write_audit_event('message_attachment', 'id');
create trigger audit_devices
after insert or update or delete on public.device_registrations
for each row execute function private.write_audit_event('device_registration', 'id');
create trigger audit_shift_assignments
after insert or update on public.shift_assignments
for each row execute function private.write_audit_event('shift_assignment', 'id');
create trigger audit_invites
after insert or update on public.organization_invites
for each row execute function private.write_audit_event('organization_invite', 'id');
create trigger audit_translation_corrections
after insert or update on public.translation_corrections
for each row execute function private.write_audit_event('translation_correction', 'id');
create trigger audit_glossary_reviews
after insert on public.glossary_reviews
for each row execute function private.write_audit_event('glossary_review', 'id');
create trigger audit_operational_actions
after insert or update on public.operational_actions
for each row execute function private.write_audit_event('operational_action', 'id');
create trigger audit_dynamic_group_policies
after insert or update on public.dynamic_group_policies
for each row execute function private.write_audit_event('dynamic_group_policy', 'id');
create trigger audit_role_assignments
after insert or update on public.organization_role_assignments
for each row execute function private.write_audit_event('organization_role_assignment', 'id');
create trigger audit_organization_ai_policies
after insert or update on public.organization_ai_policies
for each row execute function private.write_audit_event('organization_ai_policy', 'organization_id');

create or replace function private.is_conversation_creator(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    return false;
  end if;
  return exists (
    select 1
    from public.conversations conversation
    where conversation.organization_id = p_organization_id
      and conversation.id = p_conversation_id
      and conversation.created_by_user_id = v_user_id
  );
end;
$$;

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.organizations enable row level security;
alter table public.organizations force row level security;
alter table public.organization_units enable row level security;
alter table public.organization_units force row level security;
alter table public.organization_memberships enable row level security;
alter table public.organization_memberships force row level security;
alter table public.organization_unit_members enable row level security;
alter table public.organization_unit_members force row level security;
alter table public.member_blocks enable row level security;
alter table public.member_blocks force row level security;
alter table public.contact_connections enable row level security;
alter table public.contact_connections force row level security;
alter table public.conversations enable row level security;
alter table public.conversations force row level security;
alter table public.direct_conversation_pairs enable row level security;
alter table public.direct_conversation_pairs force row level security;
alter table public.conversation_members enable row level security;
alter table public.conversation_members force row level security;
alter table public.messages enable row level security;
alter table public.messages force row level security;
alter table public.message_translations enable row level security;
alter table public.message_translations force row level security;
alter table public.message_reactions enable row level security;
alter table public.message_reactions force row level security;
alter table public.conversation_read_cursors enable row level security;
alter table public.conversation_read_cursors force row level security;
alter table public.announcements enable row level security;
alter table public.announcements force row level security;
alter table public.announcement_recipients enable row level security;
alter table public.announcement_recipients force row level security;
alter table public.announcement_acknowledgements enable row level security;
alter table public.announcement_acknowledgements force row level security;
alter table public.shift_handoffs enable row level security;
alter table public.shift_handoffs force row level security;
alter table public.handoff_acknowledgements enable row level security;
alter table public.handoff_acknowledgements force row level security;
alter table public.message_attachments enable row level security;
alter table public.message_attachments force row level security;
alter table public.device_registrations enable row level security;
alter table public.device_registrations force row level security;
alter table public.shift_assignments enable row level security;
alter table public.shift_assignments force row level security;
alter table public.organization_invites enable row level security;
alter table public.organization_invites force row level security;
alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;
alter table public.conversation_preferences enable row level security;
alter table public.conversation_preferences force row level security;
alter table public.organization_user_preferences enable row level security;
alter table public.organization_user_preferences force row level security;
alter table public.saved_contacts enable row level security;
alter table public.saved_contacts force row level security;
alter table public.organization_roles enable row level security;
alter table public.organization_roles force row level security;
alter table public.organization_role_permissions enable row level security;
alter table public.organization_role_permissions force row level security;
alter table public.organization_role_assignments enable row level security;
alter table public.organization_role_assignments force row level security;
alter table public.organization_ai_policies enable row level security;
alter table public.organization_ai_policies force row level security;
alter table public.message_pins enable row level security;
alter table public.message_pins force row level security;
alter table public.message_receipts enable row level security;
alter table public.message_receipts force row level security;
alter table public.message_mentions enable row level security;
alter table public.message_mentions force row level security;
alter table public.message_user_visibility enable row level security;
alter table public.message_user_visibility force row level security;
alter table public.message_forward_provenance enable row level security;
alter table public.message_forward_provenance force row level security;
alter table public.conversation_summary_policies enable row level security;
alter table public.conversation_summary_policies force row level security;
alter table public.conversation_summaries enable row level security;
alter table public.conversation_summaries force row level security;
alter table public.announcement_versions enable row level security;
alter table public.announcement_versions force row level security;
alter table public.handoff_versions enable row level security;
alter table public.handoff_versions force row level security;
alter table public.glossary_terms enable row level security;
alter table public.glossary_terms force row level security;
alter table public.glossary_term_versions enable row level security;
alter table public.glossary_term_versions force row level security;
alter table public.glossary_reviews enable row level security;
alter table public.glossary_reviews force row level security;
alter table public.translation_corrections enable row level security;
alter table public.translation_corrections force row level security;
alter table public.operational_actions enable row level security;
alter table public.operational_actions force row level security;
alter table public.operational_action_events enable row level security;
alter table public.operational_action_events force row level security;
alter table public.dynamic_group_policies enable row level security;
alter table public.dynamic_group_policies force row level security;

create policy profiles_select_visible
on public.profiles for select
to authenticated
using ((select private.can_view_profile(user_id)));

create policy profiles_update_self
on public.profiles for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy organizations_select_member
on public.organizations for select
to authenticated
using ((select private.is_org_member(id)));

create policy organizations_update_admin
on public.organizations for update
to authenticated
using ((select private.is_org_admin(id)))
with check ((select private.is_org_admin(id)));

create policy organization_units_select_member
on public.organization_units for select
to authenticated
using ((select private.is_org_member(organization_id)));

create policy organization_units_insert_admin
on public.organization_units for insert
to authenticated
with check (
  (select private.is_org_admin(organization_id))
  and created_by_user_id = (select auth.uid())
);

create policy organization_units_update_admin
on public.organization_units for update
to authenticated
using ((select private.is_org_admin(organization_id)))
with check ((select private.is_org_admin(organization_id)));

create policy organization_memberships_select_directory
on public.organization_memberships for select
to authenticated
using ((select private.can_view_org_member(organization_id, user_id)));

create policy organization_memberships_update_self_or_admin
on public.organization_memberships for update
to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_org_admin(organization_id))
)
with check (
  user_id = (select auth.uid())
  or (select private.is_org_admin(organization_id))
);

create policy organization_unit_members_select_visible
on public.organization_unit_members for select
to authenticated
using (
  (select private.is_org_member(organization_id))
  and (select private.can_view_org_member(organization_id, user_id))
);

create policy organization_unit_members_insert_admin
on public.organization_unit_members for insert
to authenticated
with check ((select private.is_org_admin(organization_id)));

create policy organization_unit_members_update_admin
on public.organization_unit_members for update
to authenticated
using ((select private.is_org_admin(organization_id)))
with check ((select private.is_org_admin(organization_id)));

create policy organization_unit_members_delete_admin
on public.organization_unit_members for delete
to authenticated
using ((select private.is_org_admin(organization_id)));

create policy member_blocks_select_own
on public.member_blocks for select
to authenticated
using (
  blocker_user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy member_blocks_insert_own
on public.member_blocks for insert
to authenticated
with check (
  blocker_user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy member_blocks_delete_own
on public.member_blocks for delete
to authenticated
using (
  blocker_user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy contact_connections_select_participant
on public.contact_connections for select
to authenticated
using (
  (select auth.uid()) in (member_low_user_id, member_high_user_id)
  and (select private.is_org_member(organization_id))
);

create policy contact_connections_insert_requester
on public.contact_connections for insert
to authenticated
with check (
  requested_by_user_id = (select auth.uid())
  and (select auth.uid()) in (member_low_user_id, member_high_user_id)
  and (select private.is_org_member(organization_id))
);

create policy contact_connections_update_participant
on public.contact_connections for update
to authenticated
using (
  (select auth.uid()) in (member_low_user_id, member_high_user_id)
  and (select private.is_org_member(organization_id))
)
with check (
  (select auth.uid()) in (member_low_user_id, member_high_user_id)
  and (select private.is_org_member(organization_id))
);

create policy conversations_select_member
on public.conversations for select
to authenticated
using ((select private.is_conversation_member(organization_id, id)));

create policy conversations_insert_member
on public.conversations for insert
to authenticated
with check (
  created_by_user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
  and (
    kind in ('direct', 'group', 'team', 'shift')
    or (kind in ('announcement', 'incident')
      and (select private.is_org_admin(organization_id)))
  )
  and (
    kind <> 'direct'
    or exists (
      select 1 from public.organizations organization
      where organization.id = conversations.organization_id
        and organization.allow_member_direct_messages
    )
  )
);

create policy conversations_update_admin
on public.conversations for update
to authenticated
using ((select private.is_conversation_admin(organization_id, id)))
with check ((select private.is_conversation_admin(organization_id, id)));

create policy direct_conversation_pairs_select_member
on public.direct_conversation_pairs for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy direct_conversation_pairs_insert_creator
on public.direct_conversation_pairs for insert
to authenticated
with check (
  (select private.is_conversation_creator(organization_id, conversation_id))
  and (select auth.uid()) in (member_low_user_id, member_high_user_id)
);

create policy conversation_members_select_member
on public.conversation_members for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy conversation_members_insert_admin_or_creator
on public.conversation_members for insert
to authenticated
with check (
  (select private.is_org_member(organization_id))
  and (
    (select private.is_conversation_admin(organization_id, conversation_id))
    or (select private.is_conversation_creator(organization_id, conversation_id))
  )
);

create policy conversation_members_update_self_or_admin
on public.conversation_members for update
to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_conversation_admin(organization_id, conversation_id))
)
with check (
  user_id = (select auth.uid())
  or (select private.is_conversation_admin(organization_id, conversation_id))
);

create policy messages_select_member
on public.messages for select
to authenticated
using (
  (select private.is_conversation_member(organization_id, conversation_id))
  and not exists (
    select 1 from public.message_user_visibility visibility
    where visibility.organization_id = messages.organization_id
      and visibility.conversation_id = messages.conversation_id
      and visibility.message_id = messages.id
      and visibility.user_id = (select auth.uid())
  )
);

create policy messages_insert_sender
on public.messages for insert
to authenticated
with check (
  sender_user_id = (select auth.uid())
  and (select private.can_post_to_conversation(organization_id, conversation_id))
);

create policy messages_update_sender_or_admin
on public.messages for update
to authenticated
using (
  (
    sender_user_id = (select auth.uid())
    and (select private.is_conversation_member(organization_id, conversation_id))
  )
  or (select private.is_conversation_admin(organization_id, conversation_id))
)
with check (
  (
    sender_user_id = (select auth.uid())
    and (select private.is_conversation_member(organization_id, conversation_id))
  )
  or (select private.is_conversation_admin(organization_id, conversation_id))
);

create policy message_translations_select_member
on public.message_translations for select
to authenticated
using (
  (select private.is_conversation_member(organization_id, conversation_id))
  and exists (
    select 1
    from public.messages source_message
    where source_message.organization_id = message_translations.organization_id
      and source_message.conversation_id = message_translations.conversation_id
      and source_message.id = message_translations.message_id
      and source_message.deleted_at is null
      and message_translations.source_body_sha256 = extensions.digest(
        convert_to(source_message.body, 'UTF8'),
        'sha256'
      )
  )
);

create policy message_reactions_select_member
on public.message_reactions for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy message_reactions_insert_self
on public.message_reactions for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy message_reactions_delete_self
on public.message_reactions for delete
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy conversation_read_cursors_select_member
on public.conversation_read_cursors for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy conversation_read_cursors_insert_self
on public.conversation_read_cursors for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy conversation_read_cursors_update_self
on public.conversation_read_cursors for update
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
)
with check (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy announcements_select_member
on public.announcements for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy announcements_insert_admin
on public.announcements for insert
to authenticated
with check (
  created_by_user_id = (select auth.uid())
  and (select private.is_conversation_admin(organization_id, conversation_id))
);

create policy announcements_update_admin
on public.announcements for update
to authenticated
using ((select private.is_conversation_admin(organization_id, conversation_id)))
with check ((select private.is_conversation_admin(organization_id, conversation_id)));

create policy announcement_recipients_select_self_or_admin
on public.announcement_recipients for select
to authenticated
using (
  (
    user_id = (select auth.uid())
    and (select private.is_org_member(organization_id))
  )
  or exists (
    select 1
    from public.announcements announcement
    where announcement.organization_id = announcement_recipients.organization_id
      and announcement.id = announcement_recipients.announcement_id
      and (select private.is_conversation_admin(announcement.organization_id, announcement.conversation_id))
  )
);

create policy announcement_recipients_update_self
on public.announcement_recipients for update
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
)
with check (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy announcement_acknowledgements_select_member
on public.announcement_acknowledgements for select
to authenticated
using (
  exists (
    select 1
    from public.announcements announcement
    where announcement.organization_id = announcement_acknowledgements.organization_id
      and announcement.id = announcement_acknowledgements.announcement_id
      and (select private.is_conversation_member(announcement.organization_id, announcement.conversation_id))
  )
);

create policy announcement_acknowledgements_insert_self
on public.announcement_acknowledgements for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.announcement_recipients recipient
    where recipient.organization_id = announcement_acknowledgements.organization_id
      and recipient.announcement_id = announcement_acknowledgements.announcement_id
      and recipient.user_id = (select auth.uid())
  )
  and exists (
    select 1
    from public.announcements announcement
    where announcement.organization_id = announcement_acknowledgements.organization_id
      and announcement.id = announcement_acknowledgements.announcement_id
      and (select private.is_conversation_member(announcement.organization_id, announcement.conversation_id))
  )
);

create policy shift_handoffs_select_member
on public.shift_handoffs for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy shift_handoffs_insert_author
on public.shift_handoffs for insert
to authenticated
with check (
  author_user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy shift_handoffs_update_author_or_admin
on public.shift_handoffs for update
to authenticated
using (
  (
    author_user_id = (select auth.uid())
    and (select private.is_conversation_member(organization_id, conversation_id))
  )
  or (select private.is_conversation_admin(organization_id, conversation_id))
)
with check (
  (
    author_user_id = (select auth.uid())
    and (select private.is_conversation_member(organization_id, conversation_id))
  )
  or (select private.is_conversation_admin(organization_id, conversation_id))
);

create policy handoff_acknowledgements_select_member
on public.handoff_acknowledgements for select
to authenticated
using (
  exists (
    select 1
    from public.shift_handoffs handoff
    where handoff.organization_id = handoff_acknowledgements.organization_id
      and handoff.id = handoff_acknowledgements.handoff_id
      and (select private.is_conversation_member(handoff.organization_id, handoff.conversation_id))
  )
);

create policy handoff_acknowledgements_insert_self
on public.handoff_acknowledgements for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1
    from public.shift_handoffs handoff
    where handoff.organization_id = handoff_acknowledgements.organization_id
      and handoff.id = handoff_acknowledgements.handoff_id
      and handoff.status in ('submitted', 'closed')
      and (select private.is_conversation_member(handoff.organization_id, handoff.conversation_id))
  )
);

create policy message_attachments_select_member
on public.message_attachments for select
to authenticated
using (
  (select private.is_conversation_member(organization_id, conversation_id))
  and scan_status = 'clean'
  and exists (
    select 1
    from public.messages source_message
    where source_message.organization_id = message_attachments.organization_id
      and source_message.conversation_id = message_attachments.conversation_id
      and source_message.id = message_attachments.message_id
      and source_message.deleted_at is null
  )
);

create policy message_attachments_insert_sender
on public.message_attachments for insert
to authenticated
with check (
  created_by_user_id = (select auth.uid())
  and scan_status = 'pending'
  and (select private.is_conversation_member(organization_id, conversation_id))
  and (select private.is_message_sender(organization_id, conversation_id, message_id))
);

create policy device_registrations_select_self
on public.device_registrations for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy device_registrations_insert_self
on public.device_registrations for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy device_registrations_update_self
on public.device_registrations for update
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
)
with check (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy device_registrations_delete_self
on public.device_registrations for delete
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy shift_assignments_select_self_or_admin
on public.shift_assignments for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select private.is_org_admin(organization_id))
);

create policy shift_assignments_insert_admin
on public.shift_assignments for insert
to authenticated
with check (
  (select private.is_org_admin(organization_id))
  and created_by_user_id = (select auth.uid())
);

create policy shift_assignments_update_admin
on public.shift_assignments for update
to authenticated
using ((select private.is_org_admin(organization_id)))
with check ((select private.is_org_admin(organization_id)));

create policy organization_invites_select_admin
on public.organization_invites for select
to authenticated
using ((select private.is_org_admin(organization_id)));

create policy organization_invites_update_admin
on public.organization_invites for update
to authenticated
using ((select private.is_org_admin(organization_id)))
with check ((select private.is_org_admin(organization_id)));

create policy audit_events_select_admin
on public.audit_events for select
to authenticated
using ((select private.is_org_admin(organization_id)));

create policy conversation_preferences_select_self
on public.conversation_preferences for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy organization_user_preferences_select_self
on public.organization_user_preferences for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy saved_contacts_select_self
on public.saved_contacts for select
to authenticated
using (
  owner_user_id = (select auth.uid())
  and (select private.is_org_member(organization_id))
);

create policy organization_roles_select_authenticated
on public.organization_roles for select
to authenticated
using (true);

create policy organization_role_permissions_select_authenticated
on public.organization_role_permissions for select
to authenticated
using (true);

create policy organization_role_assignments_select_scoped
on public.organization_role_assignments for select
to authenticated
using (
  user_id = (select auth.uid())
  or (select private.current_user_has_permission(organization_id, 'roles.read', null))
);

create policy organization_ai_policies_select_admin
on public.organization_ai_policies for select
to authenticated
using (
  (select private.current_user_has_permission(organization_id, 'ai.policy.manage', null))
  or (select private.current_user_has_permission(organization_id, 'audit.read', null))
);

create policy message_pins_select_member
on public.message_pins for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy message_receipts_select_participant
on public.message_receipts for select
to authenticated
using (
  (select private.is_conversation_member(organization_id, conversation_id))
  and user_id = (select auth.uid())
);

create policy message_mentions_select_member
on public.message_mentions for select
to authenticated
using (
  (select private.is_conversation_member(organization_id, conversation_id))
  and exists (
    select 1 from public.messages message
    where message.organization_id = message_mentions.organization_id
      and message.conversation_id = message_mentions.conversation_id
      and message.id = message_mentions.message_id
      and message.deleted_at is null
  )
);

create policy message_user_visibility_select_self
on public.message_user_visibility for select
to authenticated
using (
  user_id = (select auth.uid())
  and (select private.is_conversation_member(organization_id, conversation_id))
);

create policy message_forward_provenance_select_authorized
on public.message_forward_provenance for select
to authenticated
using (
  (select private.is_conversation_member(organization_id, target_conversation_id))
  and (select private.is_conversation_member(organization_id, source_conversation_id))
  and exists (
    select 1 from public.messages target_message
    where target_message.organization_id = message_forward_provenance.organization_id
      and target_message.conversation_id = message_forward_provenance.target_conversation_id
      and target_message.id = message_forward_provenance.target_message_id
      and target_message.deleted_at is null
  )
  and exists (
    select 1 from public.messages source_message
    where source_message.organization_id = message_forward_provenance.organization_id
      and source_message.conversation_id = message_forward_provenance.source_conversation_id
      and source_message.id = message_forward_provenance.source_message_id
      and source_message.deleted_at is null
  )
);

create policy conversation_summary_policies_select_member
on public.conversation_summary_policies for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy conversation_summaries_select_member
on public.conversation_summaries for select
to authenticated
using (
  (select private.is_conversation_member(organization_id, conversation_id))
  and not exists (
    select 1 from unnest(source_message_ids) source_id
    join public.messages source_message
      on source_message.organization_id = conversation_summaries.organization_id
     and source_message.conversation_id = conversation_summaries.conversation_id
     and source_message.id = source_id
    where source_message.deleted_at is not null
  )
  and not exists (
    select 1 from public.message_user_visibility visibility
    where visibility.organization_id = conversation_summaries.organization_id
      and visibility.conversation_id = conversation_summaries.conversation_id
      and visibility.message_id = any(conversation_summaries.source_message_ids)
      and visibility.user_id = (select auth.uid())
  )
);

create policy announcement_versions_select_member
on public.announcement_versions for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy handoff_versions_select_member
on public.handoff_versions for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy glossary_terms_select_member
on public.glossary_terms for select
to authenticated
using ((select private.is_org_member(organization_id)));

create policy glossary_term_versions_select_member
on public.glossary_term_versions for select
to authenticated
using ((select private.is_org_member(organization_id)));

create policy glossary_reviews_select_member
on public.glossary_reviews for select
to authenticated
using ((select private.is_org_member(organization_id)));

create policy translation_corrections_select_proposer_or_admin
on public.translation_corrections for select
to authenticated
using (
  proposed_by_user_id = (select auth.uid())
  or (select private.is_conversation_admin(organization_id, conversation_id))
  or (select private.is_org_admin(organization_id))
);

create policy operational_actions_select_member
on public.operational_actions for select
to authenticated
using ((select private.is_conversation_member(organization_id, conversation_id)));

create policy operational_action_events_select_member
on public.operational_action_events for select
to authenticated
using (
  exists (
    select 1 from public.operational_actions action
    where action.organization_id = operational_action_events.organization_id
      and action.id = operational_action_events.action_id
      and (select private.is_conversation_member(action.organization_id, action.conversation_id))
  )
);

create policy dynamic_group_policies_select_admin
on public.dynamic_group_policies for select
to authenticated
using ((select private.is_org_admin(organization_id)));

-- The Data API is opt-in. Anonymous clients receive no table privileges.
revoke all on table
  public.profiles,
  public.organizations,
  public.organization_units,
  public.organization_memberships,
  public.organization_unit_members,
  public.member_blocks,
  public.contact_connections,
  public.conversations,
  public.direct_conversation_pairs,
  public.conversation_members,
  public.messages,
  public.message_translations,
  public.message_reactions,
  public.conversation_read_cursors,
  public.announcements,
  public.announcement_recipients,
  public.announcement_acknowledgements,
  public.shift_handoffs,
  public.handoff_acknowledgements,
  public.message_attachments,
  public.device_registrations,
  public.shift_assignments,
  public.organization_invites,
  public.audit_events,
  public.conversation_preferences,
  public.organization_user_preferences,
  public.saved_contacts,
  public.organization_roles,
  public.organization_role_permissions,
  public.organization_role_assignments,
  public.organization_ai_policies,
  public.message_pins,
  public.message_receipts,
  public.message_mentions,
  public.message_user_visibility,
  public.message_forward_provenance,
  public.conversation_summary_policies,
  public.conversation_summaries,
  public.announcement_versions,
  public.handoff_versions,
  public.glossary_terms,
  public.glossary_term_versions,
  public.glossary_reviews,
  public.translation_corrections,
  public.operational_actions,
  public.operational_action_events,
  public.dynamic_group_policies
from anon, authenticated, service_role;

grant usage on schema public to authenticated, service_role;

grant select, update on table public.profiles to authenticated;
grant select, update on table public.organizations to authenticated;
grant select, insert, update on table public.organization_units to authenticated;
grant select, update on table public.organization_memberships to authenticated;
grant select, insert, update, delete on table public.organization_unit_members to authenticated;
grant select, insert, delete on table public.member_blocks to authenticated;
grant select, insert, update on table public.contact_connections to authenticated;
grant select on table public.conversations to authenticated;
grant select on table public.direct_conversation_pairs to authenticated;
grant select, update on table public.conversation_members to authenticated;
grant select, update on table public.messages to authenticated;
grant select on table public.message_translations to authenticated;
grant select, insert, delete on table public.message_reactions to authenticated;
grant select, insert, update on table public.conversation_read_cursors to authenticated;
grant select on table public.announcements to authenticated;
grant select, update on table public.announcement_recipients to authenticated;
grant select on table public.announcement_acknowledgements to authenticated;
grant select on table public.shift_handoffs to authenticated;
grant select on table public.handoff_acknowledgements to authenticated;
grant select on table public.message_attachments to authenticated;
grant select on table public.device_registrations to authenticated;
grant select, update on table public.organization_invites to authenticated;
grant select on table public.audit_events to authenticated;
grant select on table
  public.conversation_preferences,
  public.organization_user_preferences,
  public.saved_contacts,
  public.organization_roles,
  public.organization_role_permissions,
  public.organization_role_assignments,
  public.organization_ai_policies,
  public.message_pins,
  public.message_receipts,
  public.message_mentions,
  public.message_user_visibility,
  public.message_forward_provenance,
  public.conversation_summary_policies,
  public.conversation_summaries,
  public.announcement_versions,
  public.handoff_versions,
  public.glossary_terms,
  public.glossary_term_versions,
  public.glossary_reviews,
  public.translation_corrections,
  public.operational_actions,
  public.operational_action_events,
  public.dynamic_group_policies
to authenticated;

grant select on table
  public.profiles,
  public.organizations,
  public.organization_units,
  public.organization_memberships,
  public.organization_unit_members,
  public.member_blocks,
  public.contact_connections,
  public.conversations,
  public.direct_conversation_pairs,
  public.conversation_members,
  public.messages,
  public.message_translations,
  public.message_reactions,
  public.conversation_read_cursors,
  public.announcements,
  public.announcement_recipients,
  public.announcement_acknowledgements,
  public.shift_handoffs,
  public.handoff_acknowledgements,
  public.message_attachments,
  public.device_registrations,
  public.shift_assignments,
  public.organization_invites,
  public.audit_events,
  public.conversation_preferences,
  public.organization_user_preferences,
  public.saved_contacts,
  public.organization_roles,
  public.organization_role_permissions,
  public.organization_role_assignments,
  public.organization_ai_policies,
  public.message_pins,
  public.message_receipts,
  public.message_mentions,
  public.message_user_visibility,
  public.message_forward_provenance,
  public.conversation_summary_policies,
  public.conversation_summaries,
  public.announcement_versions,
  public.handoff_versions,
  public.glossary_terms,
  public.glossary_term_versions,
  public.glossary_reviews,
  public.translation_corrections,
  public.operational_actions,
  public.operational_action_events,
  public.dynamic_group_policies
to service_role;

grant insert, update, delete on table
  public.conversation_preferences,
  public.organization_user_preferences,
  public.saved_contacts,
  public.organization_role_assignments,
  public.organization_ai_policies,
  public.message_pins,
  public.message_receipts,
  public.message_mentions,
  public.message_user_visibility,
  public.message_forward_provenance,
  public.conversation_summary_policies,
  public.conversation_summaries,
  public.announcement_versions,
  public.handoff_versions,
  public.glossary_terms,
  public.glossary_term_versions,
  public.glossary_reviews,
  public.translation_corrections,
  public.operational_actions,
  public.operational_action_events,
  public.dynamic_group_policies
to service_role;

grant insert, update on table
  public.profiles,
  public.organizations,
  public.organization_units,
  public.organization_memberships,
  public.contact_connections,
  public.conversations,
  public.conversation_members,
  public.messages,
  public.message_translations,
  public.conversation_read_cursors,
  public.announcements,
  public.announcement_recipients,
  public.shift_handoffs,
  public.message_attachments,
  public.device_registrations,
  public.shift_assignments,
  public.organization_invites
to service_role;

grant insert on table
  public.direct_conversation_pairs,
  public.announcement_acknowledgements,
  public.handoff_acknowledgements
to service_role;

grant insert, delete on table public.member_blocks, public.message_reactions to service_role;
grant insert, update, delete on table public.organization_unit_members, public.device_registrations to service_role;

-- The application data plane is RPC-only. RLS remains defense in depth for
-- owners and trusted service code, but end-user JWTs receive no raw table or
-- sequence privileges. This closes the window where a revoked Auth session
-- could keep reading through PostgREST until its access token expired.
revoke all privileges on all tables in schema public from authenticated;
revoke all privileges on all sequences in schema public from authenticated;

revoke all on sequence public.messages_id_seq,
  public.message_translations_id_seq,
  public.audit_events_id_seq,
  public.operational_action_events_id_seq
from anon, authenticated, service_role;
grant usage, select on sequence public.messages_id_seq,
  public.message_translations_id_seq,
  public.audit_events_id_seq,
  public.operational_action_events_id_seq
to service_role;

revoke execute on all functions in schema public from public, anon, authenticated, service_role;

-- Public BFF wrappers are SECURITY INVOKER and callable only with the service
-- role. Elevated implementations remain in the non-exposed private schema.
do $grant_bff_public$
declare
  v_function record;
begin
  for v_function in
    select function.oid::regprocedure as signature
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'public'
      and function.proname like 'bff\_%' escape '\'
  loop
    execute format('grant execute on function %s to service_role', v_function.signature);
  end loop;
end;
$grant_bff_public$;

grant execute on function public.redeem_organization_invite(text, text) to authenticated;

revoke all on all tables in schema private from public, anon, authenticated, service_role;
revoke execute on all functions in schema private from public, anon, authenticated, service_role;

-- These read-only predicates are needed while RLS executes as `authenticated`.
-- The private schema is not in api.schemas, so they cannot be invoked as RPCs.
grant usage on schema private to anon, authenticated, service_role;
grant execute on function private.is_org_member(uuid),
  private.is_org_admin(uuid),
  private.is_org_owner(uuid),
  private.is_conversation_member(uuid, uuid),
  private.is_conversation_admin(uuid, uuid),
  private.can_post_to_conversation(uuid, uuid),
  private.can_view_org_member(uuid, uuid),
  private.can_view_profile(uuid),
  private.is_message_sender(uuid, uuid, bigint),
  private.realtime_topic_authorized(text),
  private.storage_upload_authorized(text),
  private.storage_download_authorized(text),
  private.is_conversation_creator(uuid, uuid)
to authenticated;

grant execute on function private.redeem_organization_invite_impl(text, text)
  to authenticated;

do $grant_bff_private$
declare
  v_function record;
begin
  for v_function in
    select function.oid::regprocedure as signature
    from pg_proc function
    join pg_namespace namespace on namespace.oid = function.pronamespace
    where namespace.nspname = 'private'
      and function.proname like 'bff\_%\_impl' escape '\'
  loop
    execute format('grant execute on function %s to service_role', v_function.signature);
  end loop;
end;
$grant_bff_private$;

-- Private object storage. A client can only create a never-overwritten object
-- below its own org/conversation/user prefix. Download visibility requires an
-- undeleted attachment row and a completed clean malware scan for every user,
-- including the uploader.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-attachments',
  'message-attachments',
  false,
  26214400,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic',
    'application/pdf', 'text/plain', 'text/csv',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'audio/mpeg', 'audio/mp4', 'audio/ogg'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists newone_attachments_select on storage.objects;
create policy newone_attachments_select
on storage.objects for select
to authenticated
using (
  bucket_id = 'message-attachments'
  and (select private.storage_download_authorized(name))
);

drop policy if exists newone_attachments_insert on storage.objects;
create policy newone_attachments_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'message-attachments'
  and (select private.storage_upload_authorized(name))
);

-- Realtime topics are private and tenant-scoped. Database triggers publish
-- durable message changes; clients may only publish Presence state.
drop policy if exists newone_realtime_receive on realtime.messages;
create policy newone_realtime_receive
on realtime.messages for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and (select private.realtime_topic_authorized((select realtime.topic())))
);

drop policy if exists newone_realtime_presence on realtime.messages;
create policy newone_realtime_presence
on realtime.messages for insert
to authenticated
with check (
  realtime.messages.extension = 'presence'
  and (select private.realtime_topic_authorized((select realtime.topic())))
);

comment on table public.audit_events is
  'Append-only security and governance event metadata. Message bodies and raw network identifiers are never copied here.';
comment on column public.organization_invites.token_hash is
  'SHA-256 hash of a high-entropy invitation token. Never store the raw token.';
comment on table private.rate_limit_buckets is
  'Atomic first-request-anchored window counters for trusted server workflows. Not exposed through the Data API.';
comment on function private.consume_rate_limit(text, text, integer, integer) is
  'Trusted-server primitive. It is intentionally not executable by Data API roles.';

commit;
