import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const migration = await readFile(
  new URL(
    '../supabase/migrations/20260804172500_gate_auth_tokens_by_lifecycle.sql',
    import.meta.url,
  ),
  'utf8',
);

test('public signup is disabled and the lifecycle token hook is enabled', () => {
  assert.match(config, /enable_signup\s*=\s*false/);
  assert.match(config, /enable_anonymous_sign_ins\s*=\s*false/);
  assert.match(
    config,
    /\[auth\.hook\.custom_access_token\][\s\S]*?enabled\s*=\s*true[\s\S]*?hook_newone_custom_access_token/,
  );
});

test('the token hook uses canonical membership or exact live invitation state', () => {
  assert.match(migration, /organization_membership_access_current/);
  assert.match(migration, /invitation\.invited_user_id = auth_user\.id/);
  assert.match(migration, /invitation\.revoked_at is null/);
  assert.match(migration, /invitation\.expires_at > now\(\)/);
  assert.match(migration, /organization\.allow_external_guests/);
  assert.match(migration, /invitation\.guest_sponsor_user_id/);
  assert.match(migration, /auth_user\.banned_until/);
});

test('the token hook is callable only by Supabase Auth', () => {
  assert.match(
    migration,
    /revoke all on function public\.hook_newone_custom_access_token\(jsonb\)[\s\S]*?from public, anon, authenticated, service_role/,
  );
  assert.match(
    migration,
    /grant usage on schema public to supabase_auth_admin/,
  );
  assert.match(
    migration,
    /grant execute on function public\.hook_newone_custom_access_token\(jsonb\)[\s\S]*?to supabase_auth_admin/,
  );
});
