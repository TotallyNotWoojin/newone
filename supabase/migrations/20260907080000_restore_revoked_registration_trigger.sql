-- Turning notifications on could not work on a phone that had ever signed out.
--
-- Signing out (or signing into another account on the same phone) revokes the
-- device registration. Registering again upserts the same row and clears
-- revoked_at, which migration 20260906050200 made the register function do on
-- purpose. The BEFORE UPDATE validation trigger still forbade exactly that, so
-- every attempt died with 22000 "revoked device registrations cannot be
-- restored", surfaced in the app as "Check the entered information and try
-- again" (owner report, Sep 6 2026; the earlier fix changed the function but
-- not the trigger, so it never took effect).
--
-- Restoring stays guarded: the identity columns are still immutable, and the
-- check below already refuses any row that becomes un-revoked without a live
-- session installation binding for this user, installation and platform. That
-- is the same binding the register function verifies, so a restore can only
-- happen for the person holding the current session on that device.

begin;

create or replace function private.validate_device_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.id is distinct from old.id
    or new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id
    or new.installation_id is distinct from old.installation_id
    or new.created_at is distinct from old.created_at then
    raise exception 'device registration identity fields are immutable' using errcode = '22000';
  end if;
  -- Auth owns the session row and deletes it asynchronously after a Newone
  -- revocation command. The FK uses ON DELETE SET NULL so that compliance
  -- records can retain their device reference; an unbound registration must
  -- nevertheless become permanently non-dispatchable in that same cascade.
  if old.session_id is not null and new.session_id is null then
    new.revoked_at := coalesce(new.revoked_at, now());
  end if;
  -- A registration that is live (or coming back to life) must carry an active
  -- binding for its own session, user, installation and platform.
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
$function$;

commit;
