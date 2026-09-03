import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveApiUrl } from '../apps/newone/src/config/api-routing.mjs';

// Regression net for the class of bug where client code references an API
// path the routing table cannot resolve: the app then fails before any
// network call with a generic error, invisible to unit tests that mock the
// routing seam and to server-side smokes that bypass the client. Found in
// production TestFlight testing when signup paths were missing; this sweep
// runs the REAL routing module against every path literal in client source.
const CLIENT_SOURCES = [
  'apps/newone/src/lib/web-auth.ts',
  'apps/newone/src/data/repositories/web-read-repository.ts',
  'apps/newone/src/data/repositories/bff-command-repository.ts',
  'apps/newone/src/data/repositories/bff-search-repository.ts',
];

test('every client-referenced /v2 path resolves on web and native', () => {
  const paths = new Set();
  for (const source of CLIENT_SOURCES) {
    const text = readFileSync(source, 'utf8');
    for (const match of text.matchAll(/['"`](\/v2\/[a-z0-9/_-]+)['"`]/g)) {
      paths.add(match[1]);
    }
  }
  assert.ok(paths.size >= 10, `suspiciously few client paths extracted (${paths.size})`);
  const unrouted = [];
  for (const path of [...paths].sort()) {
    const nativeUrl = resolveApiUrl({
      path,
      platform: 'ios',
      apiBase: '/api',
      supabaseUrl: 'https://project.supabase.co',
    });
    const webUrl = resolveApiUrl({
      path,
      platform: 'web',
      apiBase: '/api',
      supabaseUrl: 'https://project.supabase.co',
    });
    if (!nativeUrl || !webUrl) unrouted.push(path);
  }
  assert.deepEqual(
    unrouted,
    [],
    `client references paths the routing table cannot resolve: ${unrouted.join(', ')}`,
  );
});
