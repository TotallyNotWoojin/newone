-- Consumer pivot: automatic translation is on by default in the personal
-- realm. The consumer product decision enables en/es/ko translation for every
-- personal-realm conversation (the per-conversation off switch,
-- conversation_preferences.translation_mode, already exists), and the
-- published consumer privacy policy discloses zero-retention AI translation
-- processing. Tenant AI egress stays deny-by-default for every workspace
-- organization: only the platform-managed personal realm receives this
-- platform-approved policy row, and only for language detection and
-- translation. Summaries remain unapproved for consumers.
--
-- Constraint study (20260728031052 foundation):
--   * organization_ai_policies_approval_consistent demands, for an enabled
--     row: approved_by_user_id + approved_at present, no revocation fields,
--     non-empty approved_use_cases and provider_allowlist, and route_policy
--     'approved_zero_retention'.
--   * approved_by_user_id carries a composite foreign key to
--     public.organization_memberships (organization_id, user_id), so the
--     approver must hold a membership row in the realm itself. Memberships
--     are deactivated -- never deleted -- by account deletion, so the
--     restrict FK cannot block deletion later.
--   * The realm row is provisioned lazily by the first redeemed signup
--     (20260901000000), so at migration time on a fresh database neither the
--     realm organization nor any eligible approver exists yet.
--
-- Resolution: an idempotent private helper upserts the policy only when the
-- realm and a realm member exist. It runs here (covering databases where the
-- realm already exists) AND inside private.redeem_signup_impl after the
-- membership upsert (covering fresh databases), so the policy is guaranteed
-- present from the moment the realm has its first member. The helper never
-- overwrites an existing row: a later explicit revocation through the audited
-- v2 policy command is permanent and is never resurrected by signups.
--
-- private.ai_use_case_approved compares lower(provider) against the
-- allowlist, and the AI worker presents config/ai-route-policy.json's pinned
-- providerTag ('google-vertex/us-south1'), so that exact lowercase slug is
-- the single allowlisted provider.

create or replace function private.ensure_personal_realm_ai_policy()
returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_realm_id uuid := private.personal_realm_organization_id();
  v_approver_user_id uuid;
begin
  -- Fast path: any existing row -- enabled or revoked -- is authoritative.
  -- The conflict clause below makes this race-safe; this check only avoids
  -- needless membership lookups on every signup redemption.
  if exists (
    select 1 from public.organization_ai_policies policy
    where policy.organization_id = v_realm_id
  ) then
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
    v_realm_id, true, 1,
    array['language_detection', 'translation']::text[],
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
      'approved_use_cases',
        to_jsonb(array['language_detection', 'translation']::text[]),
      'provider_allowlist',
        to_jsonb(array['google-vertex/us-south1']::text[]),
      'route_policy', 'approved_zero_retention',
      'reason',
        'Platform default: consumer personal-realm translation between '
        || 'en/es/ko is enabled at signup per the published privacy policy. '
        || 'Members opt out per conversation via translation preferences.',
      'source', 'platform_consumer_default',
      'migration', '20260901040000_enable_realm_translation'
    )
  );
end;
$$;

revoke all on function private.ensure_personal_realm_ai_policy()
  from public, anon, authenticated, service_role;
comment on function private.ensure_personal_realm_ai_policy() is
  'Idempotently provisions the platform-approved personal-realm AI policy (language_detection + translation over the pinned zero-retention route) once the realm and its first member exist. Never overwrites an existing or revoked policy row.';

-- Recreate the signup redemption impl (20260901000000) adding exactly one
-- step: after the realm organization and the redeeming membership are
-- ensured, guarantee the platform consumer AI policy exists.
create or replace function private.redeem_signup_impl(
  p_user_id uuid,
  p_destination_type text,
  p_destination text
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_destination text := lower(btrim(coalesce(p_destination, '')));
  v_reservation private.signup_reservations%rowtype;
  v_realm_id uuid := private.personal_realm_organization_id();
  v_profile_rows integer := 0;
begin
  perform private.require_service_role();
  if p_user_id is null or p_destination_type <> 'email' then
    raise exception 'invalid signup redemption request' using errcode = '22023';
  end if;

  select * into v_reservation
  from private.signup_reservations reservation
  where reservation.destination_type = p_destination_type
    and reservation.destination = v_destination::extensions.citext
    and reservation.expires_at > now()
  for update;
  if not found then
    raise exception 'signup reservation is missing or expired'
      using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_user_id
      and auth_user.deleted_at is null
      and auth_user.email_confirmed_at is not null
      and lower(auth_user.email) = v_destination
  ) then
    raise exception 'signup destination is not a confirmed account'
      using errcode = '42501';
  end if;

  -- The realm row is provisioned lazily by the first redeemed signup so the
  -- migration never has to fabricate synthetic auth users. created_by is
  -- provenance only; consumer authority always comes from membership role,
  -- and every consumer membership is a plain private-directory member.
  insert into public.organizations (
    id, slug, name, default_language, allow_member_direct_messages,
    dm_policy, require_mfa_for_admins, created_by_user_id
  ) values (
    v_realm_id, 'personal-realm', 'Newone', 'en', true,
    'request_first', true, p_user_id
  )
  on conflict (id) do nothing;

  perform set_config('app.bff_service_context', 'on', true);
  begin
    update public.profiles profile set
      username = v_reservation.username,
      display_name = v_reservation.display_name,
      preferred_language = v_reservation.preferred_language
    where profile.user_id = p_user_id;
    get diagnostics v_profile_rows = row_count;
  exception when unique_violation then
    perform set_config('app.bff_service_context', 'off', true);
    raise exception 'username is no longer available' using errcode = '23505';
  end;
  perform set_config('app.bff_service_context', 'off', true);
  if v_profile_rows = 0 then
    raise exception 'signup profile is missing' using errcode = 'P0002';
  end if;

  insert into public.organization_memberships (
    organization_id, user_id, role, status, directory_visibility
  ) values (
    v_realm_id, p_user_id, 'member', 'active', 'private'
  )
  on conflict (organization_id, user_id) do nothing;

  -- Consumer default: personal-realm translation (en/es/ko, zero-retention
  -- route) is enabled by platform policy from the first membership onward.
  perform private.ensure_personal_realm_ai_policy();

  insert into public.organization_user_preferences (
    organization_id, user_id, ui_language
  ) values (
    v_realm_id, p_user_id, v_reservation.preferred_language
  )
  on conflict (organization_id, user_id) do update set
    ui_language = excluded.ui_language,
    updated_at = now();

  delete from private.signup_reservations reservation
  where reservation.destination_type = v_reservation.destination_type
    and reservation.destination = v_reservation.destination;

  return jsonb_build_object(
    'organization_id', v_realm_id,
    'user_id', p_user_id,
    'username', v_reservation.username::text,
    'display_name', v_reservation.display_name,
    'preferred_language', v_reservation.preferred_language
  );
end;
$$;

revoke all on function private.redeem_signup_impl(uuid, text, text)
  from public, anon, authenticated;
grant execute on function private.redeem_signup_impl(uuid, text, text)
  to service_role;

-- Databases where the realm already exists (any environment that has served
-- a consumer signup) receive the policy immediately; fresh databases no-op
-- here and are covered by the redemption path above.
select private.ensure_personal_realm_ai_policy();
