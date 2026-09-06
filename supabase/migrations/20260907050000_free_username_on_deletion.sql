-- Usernames are freed immediately on account deletion (backlog 27).
--
-- The deletion tombstone from 20260901030000 (redefined in 20260903030000)
-- quarantined the released handle by inserting a 'post-deletion-quarantine'
-- row into private.reserved_usernames, so a deleted name could never be
-- registered again, by the same person or anyone else. The owner decided
-- (Sep 6 2026) that deleting an account must free the username right away:
-- someone who deletes and signs up again expects the same handle back, and
-- the quarantine bought no real protection. The profile is anonymized to
-- 'Deleted account', every membership is deactivated, and message history
-- renders under that tombstone, so a re-registered handle never inherits the
-- old account's history, contacts, or chats.
--
-- private.delete_account_impl below is the live definition with only the
-- quarantine insert (and its now-unused v_username variable) removed; the
-- profile anonymization, membership deactivation, and push-registration
-- cleanup are unchanged. Existing quarantine rows are deleted so names
-- released by earlier deletions free up as well; platform reservations
-- (reserved_reason = 'platform') stay.

CREATE OR REPLACE FUNCTION private.delete_account_impl(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
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

  -- (a) The released handle is freed immediately: nulling profile.username
  -- in step (b) is the whole release, and nothing is written to
  -- private.reserved_usernames (owner decision, Sep 6 2026, backlog 27). The
  -- username is nulled through the same service context the signup
  -- redemption uses to satisfy the username guard trigger.

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
$function$
;

revoke all on function private.delete_account_impl(uuid)
  from public, anon, authenticated;
grant execute on function private.delete_account_impl(uuid) to service_role;
comment on function private.delete_account_impl(uuid) is
  'Service-only account-deletion tombstone: frees the username, anonymizes the profile, deactivates every membership, and deletes push registrations in one transaction. Never removes message history.';

-- Names quarantined by earlier deletions free up too.
delete from private.reserved_usernames
where reserved_reason = 'post-deletion-quarantine';
