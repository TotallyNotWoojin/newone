import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  buildLicenseReport,
  classifyLicense,
} from '../scripts/verify-license-policy.mjs';

const policy = JSON.parse(readFileSync('config/dependency-license-policy.json', 'utf8'));

test('license policy permits known permissive and explicitly selected dual-license expressions', () => {
  assert.equal(classifyLicense('MIT', policy).state, 'allowed');
  assert.equal(classifyLicense('MIT AND Apache-2.0', policy).state, 'allowed');
  assert.equal(classifyLicense('(BSD-3-Clause OR GPL-2.0)', policy).state, 'allowed');
});

test('license policy separates notice review from prohibited licenses', () => {
  assert.equal(classifyLicense('MPL-2.0', policy).state, 'review');
  assert.equal(classifyLicense('CC-BY-4.0', policy).state, 'review');
  assert.equal(classifyLicense('GPL-2.0-only', policy).state, 'denied');
  assert.equal(classifyLicense('AGPL-3.0-only', policy).state, 'denied');
  assert.equal(classifyLicense('LicenseRef-Proprietary', policy).state, 'denied');
  assert.equal(classifyLicense('Unknown-New-License', policy).state, 'review');
});

test('license report includes only production dependencies and preserves release identity', () => {
  const report = buildLicenseReport({
    sourceRevision: 'synthetic-revision',
    lockfiles: [{
      application: 'client',
      dependencies: [
        { name: 'safe', version: '1.0.0', license: 'MIT', production: true },
        { name: 'review', version: '2.0.0', license: 'MPL-2.0', production: true },
        { name: 'dev-only', version: '3.0.0', license: 'AGPL-3.0-only', production: false },
      ],
    }],
  }, policy);
  assert.equal(report.sourceRevision, 'synthetic-revision');
  assert.deepEqual(report.summary, {
    productionEntries: 2,
    allowed: 1,
    review: 1,
    denied: 0,
  });
});
