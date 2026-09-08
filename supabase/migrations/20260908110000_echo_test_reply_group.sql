-- Test-only: more than one Echo account, so a group can be tested alone.
-- Owner request, Sep 7 2026. Any profile whose username is `echo` or `echoN`
-- replies to a text sent in a personal-realm conversation it belongs to, each
-- through the same command path the app uses.
--
-- Two bots in one group would answer each other forever, so a message from any
-- echo account is never echoed: the bots only ever answer a person.

create or replace function private.echo_test_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select profile.user_id
  from public.profiles profile
  where profile.username ~ '^echo[0-9]*$'
$$;

revoke all on function private.echo_test_user_ids() from public;

create or replace function private.echo_test_reply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_echo uuid;
  v_session uuid;
  v_prior_claims text;
  v_prior_service_context text;
  v_prior_detection_context text;
  v_key text;
begin
  if new.kind <> 'text'
    or new.body is null
    or new.deleted_at is not null
    or new.organization_id <> private.personal_realm_organization_id()
    or new.sender_user_id in (select private.echo_test_user_ids())
    or not exists (select 1 from private.echo_test_user_ids())
  then
    return null;
  end if;

  v_prior_claims := current_setting('request.jwt.claims', true);
  v_prior_service_context := current_setting('app.bff_service_context', true);
  v_prior_detection_context := current_setting('app.language_detection_context', true);

  for v_echo in
    select member.user_id
    from public.conversation_members member
    where member.organization_id = new.organization_id
      and member.conversation_id = new.conversation_id
      and member.status = 'active'
      and member.user_id in (select private.echo_test_user_ids())
    order by member.user_id
  loop
    select binding.session_id into v_session
    from private.session_installations binding
    join auth.sessions session on session.id = binding.session_id
    where binding.user_id = v_echo
      and binding.revoked_at is null
      and (session.not_after is null or session.not_after > now())
    order by binding.session_id
    limit 1;
    if v_session is null then
      raise warning 'echo test reply skipped: no live session for echo account %', v_echo;
      continue;
    end if;
    v_key := 'echo:' || v_echo::text || ':' || new.id::text;
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
      raise warning 'echo test reply failed for message % as %: % (%)', new.id, v_echo, sqlerrm, sqlstate;
    end;
  end loop;

  perform set_config('request.jwt.claims', coalesce(v_prior_claims, ''), true);
  perform set_config('app.bff_service_context', coalesce(v_prior_service_context, ''), true);
  perform set_config('app.language_detection_context', coalesce(v_prior_detection_context, ''), true);
  return null;
end;
$$;

revoke all on function private.echo_test_reply() from public;
