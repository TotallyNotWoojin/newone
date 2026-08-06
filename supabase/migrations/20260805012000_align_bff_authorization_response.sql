-- Keep the canonical database authorization response aligned with the Edge
-- contract. The Edge layer deliberately verifies both the positive decision
-- and the active membership snapshot before continuing to rate limiting or a
-- business RPC.
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
  v_membership_role text;
  v_membership_status text;
  v_revocation_generation bigint;
begin
  if p_actor_user_id is null or p_organization_id is null or p_session_id is null
    or char_length(coalesce(p_operation, '')) not between 1 and 160
    or p_recent_auth_seconds not between 0 and 86400 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_request_context');
  end if;

  select membership.role, membership.status, membership.revocation_generation
    into v_membership_role, v_membership_status, v_revocation_generation
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

  -- A refresh must not extend this window. Sensitive commands require a new
  -- Auth session once the original authentication time is too old.
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
    'role', v_membership_role,
    'membership_status', v_membership_status,
    'revocation_generation', v_revocation_generation
  );
end;
$$;

comment on function private.authorize_bff_request_internal(
  uuid, uuid, uuid, text, boolean, integer
) is
  'Canonical trusted-server authorization. Positive results include the verified active membership role and status consumed by Edge authorization guards.';
