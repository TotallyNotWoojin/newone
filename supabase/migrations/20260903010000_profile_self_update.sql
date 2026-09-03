-- Consumer self-service profile edits: display name and status message.
--
-- The foundation migration grants select/update on public.profiles to
-- authenticated and then revokes every table privilege from that role, so the
-- profiles_update_self RLS policy is unreachable through PostgREST and no
-- gateway command served display-name edits. This adds the trusted-gateway
-- path: a service-only, actor-authorized RPC that updates exactly two
-- self-service columns on the actor's own profile. Username stays
-- gateway-owned and is never touched here, so the username guard trigger
-- keeps its full authority.

begin;

create or replace function private.bff_update_profile_impl(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_display_name text,
  p_status_message text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_authorization jsonb;
  v_display_name text := btrim(coalesce(p_display_name, ''));
  v_status_message text := nullif(btrim(coalesce(p_status_message, '')), '');
  v_result jsonb;
begin
  perform private.require_service_role();
  v_authorization := private.assert_bff_request_internal(
    p_actor_user_id, p_organization_id, p_session_id,
    'profile.update', false, 0
  );

  if char_length(v_display_name) not between 1 and 120 then
    raise exception 'display name must be 1 to 120 characters'
      using errcode = '22023';
  end if;
  if v_status_message is not null and char_length(v_status_message) > 280 then
    raise exception 'status message must be at most 280 characters'
      using errcode = '22023';
  end if;

  -- The write runs under the service context with the end-user identity, the
  -- same way every other BFF command path authorizes its row triggers.
  perform private.set_bff_actor_context_internal(
    p_actor_user_id, p_session_id, v_authorization ->> 'aal', 'profile.update'
  );

  -- Only the two self-service columns change. The username column is not in
  -- the SET list, so profiles_15_guard_username_change never sees a change.
  update public.profiles profile
  set display_name = v_display_name,
      status_message = v_status_message
  where profile.user_id = p_actor_user_id
  returning jsonb_build_object(
    'user_id', profile.user_id,
    'display_name', profile.display_name,
    'status_message', profile.status_message
  ) into v_result;

  perform private.clear_bff_actor_context_internal();

  if v_result is null then
    raise exception 'profile unavailable' using errcode = '42501';
  end if;

  return v_result;
end;
$$;

create or replace function public.bff_update_profile(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_session_id uuid,
  p_display_name text,
  p_status_message text
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $$
  select private.bff_update_profile_impl(
    p_actor_user_id, p_organization_id, p_session_id, p_display_name, p_status_message
  )
$$;

revoke all on function private.bff_update_profile_impl(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function private.bff_update_profile_impl(
  uuid, uuid, uuid, text, text
) to service_role;

revoke all on function public.bff_update_profile(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.bff_update_profile(
  uuid, uuid, uuid, text, text
) to service_role;

comment on function public.bff_update_profile(
  uuid, uuid, uuid, text, text
) is
  'Service-only, actor-authorized self-service update of the actor''s own display name and status message; username is gateway-owned and untouched.';

commit;
