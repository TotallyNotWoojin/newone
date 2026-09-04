-- Test-only "Echo" account: any text sent in a conversation that includes the
-- profile whose username is `echo` is sent straight back by that account,
-- through the same command path the app uses (detection, translation
-- targets, pushes, and invalidations included). Owner request, Sep 4 2026,
-- for testing alone on a phone. Nothing in the app knows about it; without
-- an `echo` profile the trigger does nothing.
--
-- The reply runs as a deferred constraint trigger, at commit of the sender's
-- transaction, so it never interleaves with the sender's own command
-- bookkeeping; a failing echo raises a warning and never fails the send.

create or replace function private.echo_test_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select profile.user_id from public.profiles profile where profile.username = 'echo' limit 1
$$;

revoke all on function private.echo_test_user_id() from public;

create or replace function private.echo_test_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_echo uuid := private.echo_test_user_id();
  v_session uuid;
  v_prior_claims text;
  v_prior_service_context text;
  v_prior_detection_context text;
  v_key text;
begin
  if v_echo is null
    or new.kind <> 'text'
    or new.body is null
    or new.deleted_at is not null
    or new.sender_user_id = v_echo
    or new.organization_id <> private.personal_realm_organization_id()
    or not exists (
      select 1 from public.conversation_members member
      where member.organization_id = new.organization_id
        and member.conversation_id = new.conversation_id
        and member.user_id = v_echo
        and member.status = 'active'
    ) then
    return null;
  end if;
  select binding.session_id into v_session
  from private.session_installations binding
  join auth.sessions session on session.id = binding.session_id
  where binding.user_id = v_echo
    and binding.revoked_at is null
    and (session.not_after is null or session.not_after > now())
  order by binding.session_id
  limit 1;
  if v_session is null then
    raise warning 'echo test reply skipped: no live session for the echo account';
    return null;
  end if;
  v_prior_claims := current_setting('request.jwt.claims', true);
  v_prior_service_context := current_setting('app.bff_service_context', true);
  v_prior_detection_context := current_setting('app.language_detection_context', true);
  v_key := 'echo:' || new.id::text;
  begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform set_config('app.bff_service_context', 'off', true);
    perform set_config('app.language_detection_context', 'off', true);
    perform private.bff_send_message_impl(
      v_echo, new.organization_id, v_session, new.conversation_id,
      gen_random_uuid(), 'text', new.body, new.language_code, null, null, '{}'::jsonb,
      v_key, encode(extensions.digest(convert_to(v_key, 'UTF8'), 'sha256'), 'hex')
    );
  exception when others then
    raise warning 'echo test reply failed for message %: % (%)', new.id, sqlerrm, sqlstate;
  end;
  perform set_config('request.jwt.claims', coalesce(v_prior_claims, ''), true);
  perform set_config('app.bff_service_context', coalesce(v_prior_service_context, ''), true);
  perform set_config('app.language_detection_context', coalesce(v_prior_detection_context, ''), true);
  return null;
end;
$$;

revoke all on function private.echo_test_reply() from public;

drop trigger if exists messages_99_echo_test_reply on public.messages;
create constraint trigger messages_99_echo_test_reply
  after insert on public.messages
  deferrable initially deferred
  for each row execute function private.echo_test_reply();
