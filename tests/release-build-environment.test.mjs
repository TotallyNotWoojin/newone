import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyReleaseBuildEnvironment } from '../scripts/verify-release-build-environment.mjs';

const valid = {
  NEWONE_RELEASE_BUILD: 'true',
  EXPO_PUBLIC_API_URL: '/api',
  EXPO_PUBLIC_OFFLINE_CACHE_ENABLED: 'false',
  EXPO_PUBLIC_SUPABASE_URL: 'https://example-project.supabase.co',
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_project_1234567890',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_example_project_1234567890',
  NEWONE_WEB_GATEWAY_SHARED_SECRET: 'independent-web-gateway-secret-value-0001',
  NEWONE_SUPABASE_FUNCTIONS_ORIGIN:
    'https://example-project.supabase.co/functions/v1',
  EXPO_PUBLIC_TURNSTILE_SITE_KEY: 'turnstile-public-site-key',
  EXPO_PUBLIC_TURNSTILE_CHALLENGE_ORIGIN: 'https://app.acme-corp.com/',
  EXPO_PUBLIC_SUPPORT_CONTACT_LABEL: 'Acme support desk',
  EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'https://support.acme-corp.com/',
};

test('hosted release environment accepts a same-project BFF and public client configuration', () => {
  assert.deepEqual(verifyReleaseBuildEnvironment(valid, {
    headers: [{
      source: '/(.*)',
      headers: [{
        key: 'Content-Security-Policy',
        value:
          "default-src 'self'; connect-src 'self' https://example-project.supabase.co wss://example-project.supabase.co",
      }],
    }],
  }), {
    releaseBuild: true,
    supabaseOrigin: 'https://example-project.supabase.co',
    challengeOrigin: 'https://app.acme-corp.com',
  });
});

test('ordinary local builds can remain intentionally unconfigured', () => {
  assert.deepEqual(verifyReleaseBuildEnvironment({}), { releaseBuild: false });
});

test('hosted release environment rejects demo mode, direct APIs, secret classes, and project drift', () => {
  for (const patch of [
    { EXPO_PUBLIC_DEMO_MODE: 'true' },
    { EXPO_PUBLIC_DEMO_MODE: 'false' },
    { EXPO_PUBLIC_API_URL: 'https://example-project.supabase.co/functions/v1' },
    { EXPO_PUBLIC_OFFLINE_CACHE_ENABLED: '' },
    { EXPO_PUBLIC_OFFLINE_CACHE_ENABLED: 'sometimes' },
    { [['EXPO', 'PUBLIC', 'OPENROUTER', 'API', 'KEY'].join('_')]: 'forbidden' },
    { SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_different_project_1234567890' },
    { NEWONE_WEB_GATEWAY_SHARED_SECRET: '' },
    { NEWONE_WEB_GATEWAY_SHARED_SECRET: 'too-short' },
    { NEWONE_WEB_GATEWAY_SHARED_SECRET: `${'x'.repeat(32)}\ninvalid` },
    { NEWONE_WEB_GATEWAY_SHARED_SECRET: ` ${'x'.repeat(32)}` },
    { NEWONE_SUPABASE_FUNCTIONS_ORIGIN: 'https://other-project.supabase.co/functions/v1' },
    { EXPO_PUBLIC_SUPABASE_URL: 'https://nested.example-project.supabase.co' },
    { EXPO_PUBLIC_SUPABASE_URL: 'https://example-project.supabase.co/project' },
    { EXPO_PUBLIC_SUPABASE_URL: 'https://example-project.supabase.co:444' },
    { NEWONE_SUPABASE_FUNCTIONS_ORIGIN: 'https://example-project.supabase.co/evil/functions/v1' },
    { EXPO_PUBLIC_SUPPORT_CONTACT_URL: 'https://support.example.com/newone' },
  ]) {
    assert.throws(() => verifyReleaseBuildEnvironment({ ...valid, ...patch }));
  }

  assert.throws(() => verifyReleaseBuildEnvironment(valid, {
    headers: [{
      source: '/(.*)',
      headers: [{ key: 'Content-Security-Policy', value: "default-src 'self'" }],
    }],
  }));
});
