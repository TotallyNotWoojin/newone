import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [contracts, repository, workspace, pane, admin, catalog, navigation, adminAccess] = await Promise.all([
  readFile(new URL('../apps/newone/src/data/repositories/contracts.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/data/repositories/bff-command-repository.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/state/workspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/features/chat/conversation-pane.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/features/admin/ai-quality-review-section.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/i18n/catalog.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/components/navigation/app-scaffold.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/features/admin/admin-access.ts', import.meta.url), 'utf8'),
]);

test('strict repository exposes reporter and AAL2 reviewer contracts', () => {
  for (const method of [
    'reportAiOutputError',
    'listMyAiOutputErrorReports',
    'listAiOutputErrorReportsForReview',
    'readAiOutputErrorReport',
    'reviewAiOutputErrorReport',
    'proposeAiRegressionExample',
    'decideAiRegressionExample',
  ]) {
    assert.match(contracts, new RegExp(`${method}\\(`));
    assert.match(repository, new RegExp(`async ${method}\\(`));
  }
  assert.match(repository, /hasOnlyKeys\(row/);
  assert.match(repository, /parseAiOutputErrorReport/);
  assert.match(repository, /parseAiRegressionExample/);
  assert.match(repository, /RESPONSE_UUID_PATTERN/);
  assert.match(repository, /snapshot\.translatedBody/);
  assert.match(repository, /snapshot\.summaryBody/);
  assert.match(repository, /originalsUnchanged !== true/);
});

test('chat offers separate translation and summary error reports with optional quality consent', () => {
  assert.match(pane, /chat\.reportTranslationError/);
  assert.match(pane, /chat\.reportSummaryError/);
  assert.match(pane, /qualityUseConsent/);
  assert.match(pane, /Consent is optional|quality\.consentExplanation/);
  assert.match(pane, /quality\.originalsUnchanged/);
  assert.match(workspace, /quality-use-consent-v1/);
});

test('review console requires human attestation and preserves service-only export boundary', () => {
  assert.match(admin, /deidentificationAttestation/);
  assert.match(admin, /attested/);
  assert.match(workspace, /deidentificationAttested: true/);
  assert.match(workspace, /human-deidentification-v1/);
  assert.match(admin, /quality\.serviceExport/);
  assert.doesNotMatch(admin, /claimAiRegression|exportAiRegression/);
  assert.match(adminAccess, /'language\.review'/);
  assert.match(navigation, /canAccessAdminSurface\(workspace\.capabilities\)/);
});

test('all AI quality interface strings are present in English, Korean, and Spanish', () => {
  const occurrences = [...catalog.matchAll(/'((?:chat\.report(?:Translation|Summary)Error|quality\.[^']+))':/g)]
    .map((match) => match[1]);
  const counts = new Map();
  for (const key of occurrences) counts.set(key, (counts.get(key) ?? 0) + 1);
  assert(counts.size >= 50, 'expected the complete AI quality copy surface');
  for (const [key, count] of counts) {
    assert.equal(count, 3, key);
  }
});
