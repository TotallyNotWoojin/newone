import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routes = readFileSync('supabase/functions/newone-api/routes.ts', 'utf8');
const migration = readFileSync(
  'supabase/migrations/20260728031052_messenger_foundation.sql',
  'utf8',
);
const workspace = readFileSync('apps/newone/src/state/workspace.tsx', 'utf8');
const auth = readFileSync('apps/newone/src/state/auth.tsx', 'utf8');

test('current-session revocation reaches the same atomic server RPC as another session', () => {
  const routeCase = routes.slice(
    routes.indexOf("case 'session.revoke.self':", routes.indexOf('export async function executeCommand')),
    routes.indexOf("case 'member.list':", routes.indexOf('export async function executeCommand')),
  );
  assert.match(routeCase, /businessRpc[\s\S]*'bff_revoke_session'/);
  assert.doesNotMatch(routeCase, /targetSessionId === actor\.claims\.sessionId/);

  const revokeFunction = migration.slice(
    migration.indexOf('create or replace function private.bff_revoke_session_impl'),
    migration.indexOf('create or replace function private.bff_create_attachment_upload_impl'),
  );
  const operations = [
    'insert into private.session_revocations',
    'update private.session_installations',
    'update public.device_registrations',
    'perform private.enqueue_outbox_job_internal',
    'return private.finish_bff_command_internal',
  ].map((value) => revokeFunction.indexOf(value));
  assert(operations.every((index) => index >= 0));
  assert.deepEqual([...operations].sort((a, b) => a - b), operations);
});

test('client waits for server revocation before clearing channels, credentials, and cache', () => {
  const revokeClient = workspace.slice(
    workspace.indexOf('const revokeSession = useCallback'),
    workspace.indexOf('const loadAccountSettings'),
  );
  assert.match(
    revokeClient,
    /await executeImmediate[\s\S]*if \(result === null\)[\s\S]*if \(revokingCurrentSession\)[\s\S]*await auth\.signOut\(\)/,
  );
  assert.match(revokeClient, /setAccountSessions\(\[\]\)/);

  const signOut = auth.slice(auth.indexOf('signOut: async'), auth.indexOf('endAccess: async'));
  assert.match(signOut, /removeAllChannels/);
  assert.match(signOut, /signOutWebSession/);
  assert.match(signOut, /auth\.signOut\(\{ scope: 'local' \}\)/);
  assert.match(signOut, /clientStore\.purgeUser/);
});
