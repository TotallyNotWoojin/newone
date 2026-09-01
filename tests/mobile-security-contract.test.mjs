import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appConfig = JSON.parse(readFileSync('apps/newone/app.json', 'utf8'));
const easConfig = JSON.parse(readFileSync('apps/newone/eas.json', 'utf8'));
const rootLayout = readFileSync('apps/newone/src/app/_layout.tsx', 'utf8');
const clientId = readFileSync('apps/newone/src/lib/client-id.ts', 'utf8');
const nativeCaptcha = readFileSync(
  'apps/newone/src/components/security/captcha-challenge.native.tsx',
  'utf8',
);
const nativeSecureStorage = readFileSync(
  'apps/newone/src/lib/secure-storage.native.ts',
  'utf8',
);

test('native release disables Android application backup', () => {
  assert.equal(appConfig.expo?.android?.allowBackup, false);
});

test('native build profiles bind push environments and default encrypted offline caching off', () => {
  for (const profile of ['development', 'preview', 'production']) {
    const environment = easConfig.build?.[profile]?.env;
    assert.equal(environment?.EXPO_PUBLIC_OFFLINE_CACHE_ENABLED, 'false');
    assert.equal(environment?.EXPO_PUBLIC_PUSH_ENVIRONMENT, profile);
  }
});

test('native media capture declares narrow, user-choice-scoped permission copy', () => {
  const imagePicker = appConfig.expo?.plugins?.find((plugin) => (
    Array.isArray(plugin) && plugin[0] === 'expo-image-picker'
  ));
  assert.ok(imagePicker);
  assert.match(imagePicker[1]?.photosPermission ?? '', /only the photos and videos you choose/i);
  assert.match(imagePicker[1]?.cameraPermission ?? '', /only when you choose/i);
  assert.match(imagePicker[1]?.microphonePermission ?? '', /only when you record/i);
  assert.match(
    appConfig.expo?.ios?.infoPlist?.NSMicrophoneUsageDescription ?? '',
    /only when you record/i,
  );
  assert.match(
    appConfig.expo?.ios?.infoPlist?.NSCameraUsageDescription ?? '',
    /only when you choose/i,
  );
});

test('native app switcher is covered by an opaque privacy shield', () => {
  assert.match(rootLayout, /Platform\.OS !== 'web'/);
  assert.match(rootLayout, /AppState\.addEventListener\('change'/);
  assert.match(rootLayout, /setPrivacyShielded\(state !== 'active'\)/);
  assert.match(rootLayout, /position: 'absolute'/);
  assert.match(rootLayout, /inset: 0/);
  assert.match(rootLayout, /backgroundColor: colors\.forest/);
});

test('client command identifiers use the platform cryptographic UUID generator', () => {
  assert.match(clientId, /from 'expo-crypto'/);
  assert.match(clientId, /return randomUUID\(\)/);
  assert.doesNotMatch(clientId, /Math\.random|Date\.now|fallbackCounter/);
});

test('native Turnstile is origin-bounded, nonce-CSP protected, and nonpersistent', () => {
  assert.match(nativeCaptcha, /script-src 'nonce-\$\{cspNonce\}' https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(nativeCaptcha, /unsafe-inline/);
  assert.match(nativeCaptcha, /cacheEnabled=\{false\}/);
  assert.match(nativeCaptcha, /cacheMode="LOAD_NO_CACHE"/);
  assert.match(nativeCaptcha, /incognito/);
  assert.match(nativeCaptcha, /sharedCookiesEnabled=\{false\}/);
  assert.match(nativeCaptcha, /url\.origin === configuredOrigin/);
});

test('native credential chunking is bounded before overwriting committed credentials', () => {
  assert.match(nativeSecureStorage, /const MAX_CHUNKS = 64/);
  assert.match(nativeSecureStorage, /if \(chunks\.length > MAX_CHUNKS\)/);
  assert.ok(
    nativeSecureStorage.indexOf('if (chunks.length > MAX_CHUNKS)')
      < nativeSecureStorage.indexOf('await this.removeItem(key)'),
  );
  assert.match(nativeSecureStorage, /STORAGE_KEY_PATTERN/);
});
