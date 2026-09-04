// Test-only helper: provisions the "Echo" account in the personal realm and
// sends a message request to a real username. Once accepted, the database
// trigger installed by migration 20260904140000 sends every text in that
// conversation straight back through the normal send path. Idempotent.
//   node tests/hosted/echo-account.mjs <username>
import { loadAccessToken, managementSql } from './smoke-lib.mjs';
const target = process.argv[2];
if (!target) { console.error('usage: node tests/hosted/echo-account.mjs <username>'); process.exit(2); }
const accessToken = loadAccessToken();
const rows = async (query) => { const r = await managementSql(accessToken, query); return Array.isArray(r) ? r : r?.result ?? []; };
const ORG = '11111111-1111-4111-8111-111111111111';
const ECHO_USER = 'ec000000-0000-4000-8000-00000000ec40';
const ECHO_SESSION = 'ec100000-0000-4000-8000-00000000ec40';
const ECHO_INSTALL = 'ec200000-0000-4000-8000-00000000ec40';
const [targetRow] = await rows(`select user_id from public.profiles where username = '${target.replace(/'/g, "''")}'`);
if (!targetRow) { console.error(`no profile with username ${target}`); process.exit(1); }
await rows(`
  do $$ begin
    if not exists (select 1 from auth.users where id = '${ECHO_USER}') then
      insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role)
      values ('${ECHO_USER}', 'echo@newone.test', now(), '{"provider":"email","providers":["email"]}', '{}', 'authenticated', 'authenticated');
    end if;
    perform set_config('app.bff_service_context', 'on', true);
    insert into public.profiles (user_id, username, display_name, preferred_language)
    values ('${ECHO_USER}', 'echo', 'Echo (test)', 'en')
    on conflict (user_id) do update set username = 'echo', display_name = 'Echo (test)', preferred_language = 'en';
    perform set_config('app.bff_service_context', 'off', true);
    insert into public.organization_memberships (organization_id, user_id, role, status, directory_visibility)
    values ('${ORG}', '${ECHO_USER}', 'member', 'active', 'private')
    on conflict (organization_id, user_id) do nothing;
    insert into public.organization_user_preferences (organization_id, user_id, ui_language)
    values ('${ORG}', '${ECHO_USER}', 'en')
    on conflict (organization_id, user_id) do nothing;
    if not exists (select 1 from auth.sessions where id = '${ECHO_SESSION}') then
      insert into auth.sessions (id, user_id, created_at, updated_at, aal) values ('${ECHO_SESSION}', '${ECHO_USER}', now(), now(), 'aal1');
    end if;
    if not exists (select 1 from private.session_installations where session_id = '${ECHO_SESSION}') then
      insert into private.session_installations (session_id, user_id, installation_id, platform, user_agent_hash, user_agent_family)
      values ('${ECHO_SESSION}', '${ECHO_USER}', '${ECHO_INSTALL}', 'ios', decode(repeat('ec', 32), 'hex'), 'iphone');
    end if;
  end $$;`);
console.log('echo account ready:', JSON.stringify((await rows(`select username, display_name from public.profiles where user_id = '${ECHO_USER}'`))[0]));
const existing = await rows(`select status from public.contact_connections where organization_id = '${ORG}' and member_low_user_id = least('${ECHO_USER}'::uuid, '${targetRow.user_id}'::uuid) and member_high_user_id = greatest('${ECHO_USER}'::uuid, '${targetRow.user_id}'::uuid)`);
if (existing[0]) { console.log(`connection with ${target} already ${existing[0].status}`); process.exit(0); }
await rows(`
  do $$ begin
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform public.bff_send_message_request('${ECHO_USER}', '${ORG}', '${ECHO_SESSION}', '${targetRow.user_id}',
      'Hi, I am Echo. Accept this and I will send back whatever you type. Handy for testing translation on your own.');
  end $$;`);
const [after] = await rows(`select status from public.contact_connections where organization_id = '${ORG}' and member_low_user_id = least('${ECHO_USER}'::uuid, '${targetRow.user_id}'::uuid) and member_high_user_id = greatest('${ECHO_USER}'::uuid, '${targetRow.user_id}'::uuid)`);
console.log(`message request sent to ${target}: connection ${after?.status ?? 'missing'}`);
