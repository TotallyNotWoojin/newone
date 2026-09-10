import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const responsiveSurfaces = [
  '../apps/newone/src/components/navigation/app-scaffold.tsx',
  '../apps/newone/src/app/index.tsx',
  '../apps/newone/src/app/people.tsx',
  '../apps/newone/src/app/updates.tsx',
  '../apps/newone/src/app/handoffs.tsx',
  '../apps/newone/src/features/search/workspace-search-panel.tsx',
  '../apps/newone/src/app/admin.tsx',
  '../apps/newone/src/app/new-group.tsx',
  '../apps/newone/src/app/sign-in.tsx',
  '../apps/newone/src/features/admin/moderation-case-section.tsx',
];

// The screens this compared (updates, handoffs) are gone; the consumer
// screens' responsive branches are covered by the browser suite.

test('web translation starts from the exported language before restoring device preference', async () => {
  const provider = await source('../apps/newone/src/i18n/provider.tsx');

  assert.match(provider, /Platform\.OS === 'web' \? 'en' : deviceLocale\(\)/);
  assert.match(
    provider,
    /setLocaleState\(saved === 'en' \|\| saved === 'ko' \|\| saved === 'es' \? saved : deviceLocale\(\)\)/,
  );
});
