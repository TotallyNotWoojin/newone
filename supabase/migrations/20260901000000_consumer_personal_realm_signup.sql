-- Consumer pivot slice 1: the reserved personal realm, unique usernames, and
-- open email signup. Public GoTrue signup stays disabled; account creation
-- continues to flow only through the trusted Edge gateway, which calls the
-- service-only authorization and redemption functions added here. Consumer
-- memberships are created with private directory visibility so the personal
-- realm never exposes an organization-wide member directory.

create or replace function private.personal_realm_organization_id()
returns uuid
language sql
immutable
set search_path = ''
as $$
  select '11111111-1111-4111-8111-111111111111'::uuid
$$;

revoke all on function private.personal_realm_organization_id()
  from public, anon, authenticated;
grant execute on function private.personal_realm_organization_id()
  to anon, authenticated, service_role;
comment on function private.personal_realm_organization_id() is
  'Fixed identifier of the platform-managed consumer realm. Stable so RLS predicates and BFF logic can special-case consumer behavior without configuration lookups.';

-- Handles that may never be claimed by ordinary signups. Kept in the private
-- schema: reservations are policy data, not user data.
create table private.reserved_usernames (
  username extensions.citext primary key,
  reserved_reason text not null default 'platform',
  created_at timestamptz not null default now(),
  constraint reserved_usernames_reason_length check (
    char_length(btrim(reserved_reason)) between 1 and 120
  )
);

alter table private.reserved_usernames enable row level security;
revoke all on table private.reserved_usernames
  from public, anon, authenticated, service_role;

insert into private.reserved_usernames (username) values
  ('admin'), ('administrator'), ('newone'), ('official'), ('support'),
  ('help'), ('security'), ('moderator'), ('moderation'), ('system'),
  ('root'), ('staff'), ('team'), ('info'), ('api'), ('billing'),
  ('abuse'), ('postmaster'), ('webmaster'), ('noreply'), ('no_reply'),
  ('privacy'), ('legal'), ('trust'), ('safety'), ('verify'), ('verified'),
  ('account'), ('accounts'), ('settings'), ('everyone'), ('here');

-- Unique, case-insensitive public handle. Stored lowercase; citext keeps
-- uniqueness case-insensitive even if a privileged writer bypasses the
-- lowercase format constraint.
alter table public.profiles
  add column username extensions.citext;

alter table public.profiles
  add constraint profiles_username_format check (
    username is null
    or username::text ~ '^[a-z0-9][a-z0-9_]{2,28}[a-z0-9]$'
  );

create unique index profiles_username_key
  on public.profiles (username)
  where username is not null;

-- Username changes are gateway-owned: they must pass reservation, format,
-- and reserved-name checks that live in the signup flow. Direct PostgREST
-- profile updates keep working for the other self-service columns.
create or replace function private.guard_profile_username_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.username is distinct from old.username
    and coalesce(current_setting('app.bff_service_context', true), 'off') <> 'on' then
    raise exception 'usernames change only through the trusted gateway'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger profiles_15_guard_username_change
before update on public.profiles
for each row execute function private.guard_profile_username_change();

-- One in-flight signup per destination. The unique username index makes a
-- handle unavailable the moment any live signup holds it, so two concurrent
-- signups cannot both pass the availability check and collide at redemption.
create table private.signup_reservations (
  destination_type text not null,
  destination extensions.citext not null,
  username extensions.citext not null unique,
  display_name text not null,
  preferred_language text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  primary key (destination_type, destination),
  constraint signup_reservations_destination_type_allowed check (
    destination_type in ('email')
  ),
  constraint signup_reservations_destination_length check (
    char_length(destination::text) between 6 and 320
  ),
  constraint signup_reservations_username_format check (
    username::text ~ '^[a-z0-9][a-z0-9_]{2,28}[a-z0-9]$'
  ),
  constraint signup_reservations_display_name_length check (
    char_length(btrim(display_name)) between 1 and 120
  ),
  constraint signup_reservations_language_allowed check (
    preferred_language in ('en', 'es', 'ko')
  ),
  constraint signup_reservations_expiry_consistent check (
    expires_at > created_at
  )
);

alter table private.signup_reservations enable row level security;
revoke all on table private.signup_reservations
  from public, anon, authenticated, service_role;

create or replace function private.bff_authorize_signup_otp_impl(
  p_destination_type text,
  p_destination text,
  p_username text,
  p_display_name text,
  p_language text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_destination text := lower(btrim(coalesce(p_destination, '')));
  v_username text := lower(btrim(coalesce(p_username, '')));
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_language text := lower(btrim(coalesce(p_language, '')));
  v_ip_key text := coalesce(p_ip_hash, 'invalid');
  v_installation_key text := coalesce(p_installation_hash, 'invalid');
  v_destination_allowed boolean;
  v_ip_allowed boolean;
  v_installation_allowed boolean;
  v_destination_limit integer;
  v_ip_limit integer;
  v_installation_limit integer;
  v_reason text := null;
  v_existing_member boolean := false;
begin
  perform private.require_service_role();
  if p_purpose not in ('request', 'verify') then
    raise exception 'invalid OTP authorization purpose' using errcode = '22023';
  end if;

  -- Same fixed-envelope discipline as the member/invite authorizers: consume
  -- every bucket before any eligibility answer so unknown and known
  -- destinations share one abuse and timing envelope.
  v_destination_limit := case p_purpose when 'request' then 3 else 10 end;
  v_ip_limit := case p_purpose when 'request' then 10 else 20 end;
  v_installation_limit := case p_purpose when 'request' then 5 else 15 end;
  v_destination_allowed := private.consume_rate_limit(
    'signup-otp-' || p_purpose || '-destination-15m',
    coalesce(p_destination_type, 'invalid') || ':' || v_destination,
    v_destination_limit, 900
  );
  v_ip_allowed := private.consume_rate_limit(
    'signup-otp-' || p_purpose || '-ip-15m', v_ip_key, v_ip_limit, 900
  );
  v_installation_allowed := private.consume_rate_limit(
    'signup-otp-' || p_purpose || '-installation-15m',
    v_installation_key, v_installation_limit, 900
  );

  if p_destination_type <> 'email'
    or v_destination !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(v_destination) > 320
    or coalesce(p_ip_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_installation_hash, '') !~ '^[0-9a-f]{64}$' then
    v_reason := 'invalid_destination';
  elsif exists (
    select 1
    from auth.users auth_user
    join public.organization_memberships membership
      on membership.user_id = auth_user.id
     and membership.status = 'active'
    where auth_user.deleted_at is null
      and auth_user.email_confirmed_at is not null
      and lower(auth_user.email) = v_destination
  ) then
    -- The Edge gateway silently downgrades to the member sign-in flow so the
    -- response envelope never confirms whether an address has an account.
    v_existing_member := true;
    v_reason := 'account_exists';
  elsif p_purpose = 'verify' then
    if not exists (
      select 1 from private.signup_reservations reservation
      where reservation.destination_type = p_destination_type
        and reservation.destination = v_destination::extensions.citext
        and reservation.expires_at > now()
    ) then
      v_reason := 'reservation_expired';
    end if;
  else
    if v_username !~ '^[a-z0-9][a-z0-9_]{2,28}[a-z0-9]$' then
      v_reason := 'invalid_username';
    elsif exists (
      select 1 from private.reserved_usernames reserved
      where reserved.username = v_username::extensions.citext
    ) then
      v_reason := 'username_reserved';
    elsif v_language not in ('en', 'es', 'ko') then
      v_reason := 'invalid_language';
    elsif char_length(v_display_name) not between 1 and 120 then
      v_reason := 'invalid_display_name';
    elsif exists (
      select 1 from public.profiles profile
      where profile.username = v_username::extensions.citext
    ) then
      v_reason := 'username_taken';
    else
      -- Release any expired reservation blocking this handle, then reserve.
      delete from private.signup_reservations reservation
      where reservation.expires_at <= now()
        and (
          reservation.username = v_username::extensions.citext
          or (
            reservation.destination_type = p_destination_type
            and reservation.destination = v_destination::extensions.citext
          )
        );
      begin
        insert into private.signup_reservations (
          destination_type, destination, username, display_name,
          preferred_language
        ) values (
          p_destination_type, v_destination::extensions.citext,
          v_username::extensions.citext, v_display_name, v_language
        )
        on conflict (destination_type, destination) do update set
          username = excluded.username,
          display_name = excluded.display_name,
          preferred_language = excluded.preferred_language,
          created_at = now(),
          expires_at = now() + interval '15 minutes';
      exception when unique_violation then
        v_reason := 'username_taken';
      end;
    end if;
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null
      and v_destination_allowed and v_ip_allowed and v_installation_allowed,
    'reason', case
      when not v_destination_allowed or not v_ip_allowed
        or not v_installation_allowed then 'rate_limited'
      else coalesce(v_reason, 'ok')
    end,
    'existing_member', v_existing_member,
    'channel_configured', true,
    'retry_after_seconds', case
      when not v_destination_allowed or not v_ip_allowed
        or not v_installation_allowed then 900
      when v_reason is not null and not v_existing_member then 60
      else 0
    end
  );
end;
$$;

revoke all on function private.bff_authorize_signup_otp_impl(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function private.bff_authorize_signup_otp_impl(
  text, text, text, text, text, text, text, text
) to service_role;

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

create or replace function public.bff_authorize_signup_otp(
  p_destination_type text,
  p_destination text,
  p_username text,
  p_display_name text,
  p_language text,
  p_ip_hash text,
  p_installation_hash text,
  p_purpose text default 'request'
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.bff_authorize_signup_otp_impl(
    p_destination_type, p_destination, p_username, p_display_name,
    p_language, p_ip_hash, p_installation_hash, p_purpose
  )
$$;

revoke all on function public.bff_authorize_signup_otp(
  text, text, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.bff_authorize_signup_otp(
  text, text, text, text, text, text, text, text
) to service_role;
comment on function public.bff_authorize_signup_otp(
  text, text, text, text, text, text, text, text
) is
  'Service-only signup OTP authorizer: fixed-envelope rate limiting, username validation, and a one-per-destination signup reservation.';

create or replace function public.bff_redeem_signup(
  p_user_id uuid,
  p_destination_type text,
  p_destination text
)
returns jsonb
language sql volatile security invoker set search_path = ''
as $$
  select private.redeem_signup_impl(p_user_id, p_destination_type, p_destination)
$$;

revoke all on function public.bff_redeem_signup(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.bff_redeem_signup(uuid, text, text)
  to service_role;
comment on function public.bff_redeem_signup(uuid, text, text) is
  'Service-only signup completion: claims the reserved username and provisions the private-directory personal-realm membership atomically.';
