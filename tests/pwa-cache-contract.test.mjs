import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const worker = readFileSync('apps/newone/public/service-worker.js', 'utf8');

test('service worker keeps API and cross-origin traffic network-only with no-store', () => {
  assert.match(worker, /url\.origin !== self\.location\.origin[\s\S]*networkOnlyNoStore\(request\)/);
  assert.match(worker, /url\.pathname === '\/api'[\s\S]*networkOnlyNoStore\(request\)/);
});

test('offline boot caches only the public Expo shell and hashed release assets', () => {
  assert.match(worker, /credentials: 'omit'/);
  assert.match(worker, /await caches\.match\('\/'\)/);
  assert.match(worker, /url\.pathname\.startsWith\('\/_expo\/'\)/);
  assert.match(worker, /\['script', 'style', 'font', 'image'\]/);
  assert.doesNotMatch(worker, /cache\.put\(request[\s\S]*url\.pathname\.startsWith\('\/api/);
});
