import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pane = readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8');
const reads = readFileSync('apps/newone/src/data/repositories/web-read-repository.ts', 'utf8');
const commands = readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8');
const routes = readFileSync('supabase/functions/newone-api/routes.ts', 'utf8');
const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');

test('message UI keeps the original primary and renders translation as a derived layer', () => {
  const originalPosition = pane.indexOf('{message.originalText}');
  const translationPosition = pane.indexOf('{message.translatedText}', originalPosition);
  assert(originalPosition >= 0);
  assert(translationPosition > originalPosition);
  assert.match(pane, /chat\.originalCanonical/);
  assert.match(pane, /chat\.translationBoundary/);
  assert.match(pane, /translation\.sourceBodySha256/);
  assert.match(pane, /translation\.provider/);
  assert.match(pane, /translation\.model/);
  assert.match(pane, /translation\.policyVersion/);
  assert.match(pane, /correction\?\.status === 'approved'/);
  assert.match(pane, /workspace\.hasCapability\('language\.review'\)/);
  assert.doesNotMatch(pane, /t\('chat\.autoTranslate'\)/);
});

test('translation reads select only the recipient target and honor reviewer-redacted corrections', () => {
  assert.match(reads, /translations\.find\(\(item\) => item\.targetLanguage === targetLanguage\)/);
  assert.doesNotMatch(reads, /translations\[0\]/);
  assert.match(reads, /translationCorrectionFromDto\(row\.latestCorrection\)/);
  assert.match(reads, /proposedByUserId === null/);
  assert.match(reads, /sourceBodySha256[\s\S]*\^\[0-9a-f\]\{64\}\$/);
  assert.match(reads, /Do not infer freshness client-side/);
  assert.match(reads, /approvedCorrection\?\.correctedText[\s\S]*selectedTranslation\?\.translatedText/);
});

test('translation retry and correction commands stay behind strict BFF routes', () => {
  assert.match(commands, /\/v2\/messages\/\$\{encodeURIComponent\(input\.messageId\)\}\/translations/);
  assert.match(commands, /typeof data\.retried !== 'boolean'/);
  assert.match(commands, /\/translations\/\$\{encodeURIComponent\(input\.targetLanguage\)\}\/corrections/);
  assert.match(commands, /\/v2\/translation-corrections\/\$\{encodeURIComponent\(input\.correctionId\)\}\/review/);
  assert.match(routes, /'bff_enqueue_translation'/);
  assert.match(routes, /'bff_propose_translation_correction'/);
  assert.match(routes, /'bff_review_translation_correction'/);
  assert.doesNotMatch(`${commands}\n${pane}`, /OPENROUTER_API_KEY|sk-or-v1/);
});

test('summary UI preserves draft boundaries, exact source links, provenance, and manual fallback', () => {
  assert.match(pane, /chat\.summaryBoundary/);
  assert.match(pane, /summary\.sourceMessageIds\.map/);
  assert.match(pane, /SourceMessageLink/);
  assert.match(pane, /workspace\.ensureMessageLoaded/);
  assert.match(pane, /summary\.sourceFingerprint/);
  assert.match(pane, /summary\.outputFingerprint/);
  assert.match(pane, /summary\.provenance\.processorType/);
  assert.match(pane, /summary\.sourceState === 'stale'/);
  assert.match(pane, /summary\.policyState === 'stale'/);
  assert.match(pane, /router\.push\('\/handoffs'\)/);
  assert.match(pane, /chat\.approveExactVersion/);
  assert.match(pane, /chat\.summaryHumanReviewRequired/);
});

test('summary DTOs validate immutable fingerprints and evidence subsets', () => {
  assert.match(reads, /sourceMessageIds\[0\] !== sourceFirstMessageId/);
  assert.match(reads, /sourceMessageIds\.at\(-1\) !== sourceLastMessageId/);
  assert.match(reads, /evidenceIds\.some\(\(id\) => !sourceIds\.has\(id\)\)/);
  assert.match(reads, /rawStatus === 'stale'[\s\S]*'superseded'/);
  assert.match(reads, /row\.processorProvenance/);
  assert.match(commands, /sourceFingerprint[\s\S]*\^\[0-9a-f\]\{64\}\$/);
  assert.match(commands, /data\.humanReviewed !== true/);
  assert.match(commands, /data\.automaticPublish !== false/);
});

test('translation and summary safety copy ships in English, Korean, and Spanish', () => {
  assert.match(catalog, /'chat\.translationBoundary': 'Automated translation/);
  assert.match(catalog, /'chat\.translationBoundary': '자동 번역/);
  assert.match(catalog, /'chat\.translationBoundary': 'La traducción automática/);
  assert.match(catalog, /'chat\.summaryBoundary': 'A conversation summary/);
  assert.match(catalog, /'chat\.summaryBoundary': '대화 요약/);
  assert.match(catalog, /'chat\.summaryBoundary': 'Un resumen de conversación/);
});
