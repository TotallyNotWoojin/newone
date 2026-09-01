begin;

-- Consumer signup verification happens before the personal-realm membership
-- exists: the gateway verifies the emailed code first and only then redeems
-- the reservation into a membership. The lifecycle hook therefore needs a
-- third, equally narrow issuance arm: the exact subject of a live signup
-- reservation for their own confirmed-or-pending email address. The arm
-- expires with the reservation (15 minutes), redemption replaces it with the
-- membership arm, and an abandoned signup fails closed again at the next
-- token refresh. A reservation-window JWT is otherwise inert: every RLS
-- predicate and BFF authorization still requires an active membership.
create or replace function public.hook_newone_custom_access_token(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_claims jsonb;
  v_allowed boolean := false;
begin
  if event is null
    or jsonb_typeof(event) <> 'object'
    or jsonb_typeof(event -> 'claims') <> 'object'
    or coalesce(event ->> 'user_id', '') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Authentication is not available for this account.'
      )
    );
  end if;

  v_user_id := (event ->> 'user_id')::uuid;
  v_claims := event -> 'claims';

  select exists (
    select 1
    from auth.users auth_user
    where auth_user.id = v_user_id
      and auth_user.deleted_at is null
      and (auth_user.banned_until is null or auth_user.banned_until <= now())
      and (
        exists (
          select 1
          from public.organization_memberships membership
          where membership.user_id = auth_user.id
            and private.organization_membership_access_current(
              membership.organization_id, membership.user_id, now()
            )
        )
        or exists (
          select 1
          from private.signup_reservations reservation
          where reservation.destination_type = 'email'
            and reservation.destination = lower(coalesce(auth_user.email, ''))
            and reservation.expires_at > now()
        )
        or exists (
          select 1
          from public.organization_invites invitation
          join public.organizations organization
            on organization.id = invitation.organization_id
          where invitation.invited_user_id = auth_user.id
            and invitation.revoked_at is null
            and invitation.accepted_at is null
            and invitation.use_count = 0
            and invitation.max_uses = 1
            and invitation.expires_at > now()
            and case invitation.membership_type
              when 'employee' then
                invitation.membership_access_expires_at is null
                and invitation.guest_sponsor_user_id is null
              when 'contractor' then
                invitation.membership_access_expires_at > now()
                and invitation.guest_sponsor_user_id is null
              when 'guest' then
                organization.allow_external_guests
                and invitation.membership_access_expires_at > now()
                and invitation.guest_sponsor_user_id is not null
                and private.organization_membership_access_current(
                  invitation.organization_id,
                  invitation.guest_sponsor_user_id,
                  now()
                )
                and exists (
                  select 1
                  from public.organization_memberships sponsor
                  where sponsor.organization_id = invitation.organization_id
                    and sponsor.user_id = invitation.guest_sponsor_user_id
                    and sponsor.membership_type <> 'guest'
                    and (
                      sponsor.access_expires_at is null
                      or sponsor.access_expires_at >=
                        invitation.membership_access_expires_at
                    )
                )
              else false
            end
        )
      )
  ) into v_allowed;

  if not v_allowed then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'Authentication is not available for this account.'
      )
    );
  end if;

  -- Preserve the complete GoTrue claim set. Workspace authorization remains
  -- server-derived on every BFF/data request; no tenant role is trusted from a
  -- client-visible JWT claim.
  return jsonb_build_object('claims', v_claims);
end;
$$;

commit;
