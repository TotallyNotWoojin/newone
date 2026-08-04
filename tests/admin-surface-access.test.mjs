import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('admin page and both navigation layouts share one capability gate', async () => {
  const [access, scaffold, admin] = await Promise.all([
    source('../apps/newone/src/features/admin/admin-access.ts'),
    source('../apps/newone/src/components/navigation/app-scaffold.tsx'),
    source('../apps/newone/src/app/admin.tsx'),
  ]);

  for (const capability of [
    'unit.manage',
    'conversation.manage',
    'message.preservation.manage',
    'ai.policy.manage',
    'reports.investigate',
    'recovery.manage',
  ]) {
    assert.ok(access.includes(`'${capability}'`), `missing admin capability ${capability}`);
  }
  assert.equal((scaffold.match(/canAccessAdminSurface\(workspace\.capabilities\)/g) ?? []).length, 2);
  assert.equal((admin.match(/canAccessAdminSurface\(workspace\.capabilities\)/g) ?? []).length, 1);
  assert.doesNotMatch(scaffold, /const canOpenAdmin = \[/);
  assert.doesNotMatch(admin, /const canOpenAdmin = \[/);
});

test('site-admin grants and client gates include the dynamic-group control path', async () => {
  const [migration, admin, section] = await Promise.all([
    source('../supabase/migrations/20260728031052_messenger_foundation.sql'),
    source('../apps/newone/src/app/admin.tsx'),
    source('../apps/newone/src/features/admin/dynamic-group-section.tsx'),
  ]);

  assert.match(migration, /\('site_admin', 'unit\.manage'\)/);
  assert.match(admin, /hasCapability\('unit\.manage'\)[\s\S]*DynamicGroupSection/);
  assert.match(section, /const canManage = workspace\.hasCapability\('unit\.manage'\)/);
});
