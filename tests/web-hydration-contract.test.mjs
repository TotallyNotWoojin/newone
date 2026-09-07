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
  '../apps/newone/src/app/settings.tsx',
  '../apps/newone/src/app/new-group.tsx',
  '../apps/newone/src/app/sign-in.tsx',
  '../apps/newone/src/features/admin/moderation-case-section.tsx',
];

test('responsive render branches reuse the static server viewport for web hydration', async () => {
  const [hook, ...surfaces] = await Promise.all([
    source('../apps/newone/src/hooks/use-hydration-safe-window-dimensions.ts'),
    ...responsiveSurfaces.map(source),
  ]);

  assert.match(hook, /width:\s*0/);
  assert.match(hook, /useSyncExternalStore\(/);
  assert.match(hook, /serverHydrationSnapshot = \(\) => Platform\.OS !== 'web'/);
  assert.match(hook, /clientHydrationSnapshot = \(\) => true/);
  assert.match(hook, /return hydrated \? dimensions : SERVER_WEB_DIMENSIONS/);

  for (const [index, contents] of surfaces.entries()) {
    assert.match(
      contents,
      /useHydrationSafeWindowDimensions\(\)/,
      `responsive surface bypasses the hydration-safe viewport: ${responsiveSurfaces[index]}`,
    );
    assert.doesNotMatch(
      contents,
      /\buseWindowDimensions\b/,
      `responsive surface reads the client viewport during hydration: ${responsiveSurfaces[index]}`,
    );
  }
});

test('web translation starts from the exported language before restoring device preference', async () => {
  const provider = await source('../apps/newone/src/i18n/provider.tsx');

  assert.match(provider, /Platform\.OS === 'web' \? 'en' : deviceLocale\(\)/);
  assert.match(
    provider,
    /setLocaleState\(saved === 'en' \|\| saved === 'ko' \|\| saved === 'es' \? saved : deviceLocale\(\)\)/,
  );
});
