import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pane = readFileSync('apps/newone/src/features/chat/conversation-pane.tsx', 'utf8');
// The summary moved out of the message list into a sheet opened from the
// conversation header (524a2c8, 2026-09-05).
const summarySheet = readFileSync('apps/newone/src/features/chat/summary-sheet.tsx', 'utf8');
const reads = readFileSync('apps/newone/src/data/repositories/web-read-repository.ts', 'utf8');
const commands = readFileSync('apps/newone/src/data/repositories/bff-command-repository.ts', 'utf8');
const routes = readFileSync('supabase/functions/newone-api/routes.ts', 'utf8');
const catalog = readFileSync('apps/newone/src/i18n/catalog.ts', 'utf8');

test('message UI keeps the original primary and renders translation as a derived layer', () => {
  const originalPosition = pane.indexOf('{message.originalText}');
  const translationPosition = pane.indexOf('{message.translatedText}', originalPosition);
  assert(originalPosition >= 0);
  assert(translationPosition > originalPosition);
  // The bubble carries no "Canonical original" label any more (3e56060,
  // 2026-09-05: compact bubbles). The property it defended — the original is
  // never replaced, only ever layered over — now rides on the toggle that
  // reveals the original whenever the translation is shown on its own.
  assert.match(pane, /originalOpen \? 'chat\.hideOriginal' : 'chat\.showOriginal'/);
  assert.match(pane, /originalOpen \? \([\s\S]{0,200}\{message\.originalText\}/);
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

test('summary UI marks stale drafts, gates review, and keeps the manual fallback', () => {
  // The summary sheet, not the message list, owns this UI now (524a2c8).
  // A stale draft must say so rather than read as current.
  assert.match(summarySheet, /readySummary\.sourceState === 'stale'/);
  assert.match(summarySheet, /chat\.summarySuperseded/);
  // Correction and review are offered only on a draft still tied to its
  // sources, and only to someone who may manage the conversation.
  assert.match(summarySheet, /canManage && readySummary\.sourceState === 'current'/);
  assert.match(summarySheet, /chat\.correctSummary/);
  assert.match(summarySheet, /chat\.reviewSummary/);
  // A draft is reportable only once it has an immutable output fingerprint to
  // report against.
  assert.match(summarySheet, /readySummary\.outputFingerprint \?/);
  // When generation fails, the manual handoff stays reachable.
  assert.match(summarySheet, /chat\.createManualHandoff/);
  assert.match(summarySheet, /router\.push\('\/handoffs'\)/);
  assert.match(summarySheet, /chat\.approveExactVersion/);
  assert.match(summarySheet, /chat\.summaryHumanReviewRequired/);
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

// chat.summaryBoundary ("A conversation summary is a derived draft, not a
// shift handoff, acknowledgement, work assignment, or decision") was deleted
// from all three locales on 2026-09-06 (3677121, "Consumer copy: no workplace
// wording on the screens people actually see") along with the rest of the
// shift-handoff vocabulary. apps/newone/tests/conversation-ui.test.tsx now
// asserts the key is never rendered, so the disclosure is gone from the
// product, not merely relocated. The translation boundary survived and stays
// under test.
test('translation safety copy ships in English, Korean, and Spanish', () => {
  assert.match(catalog, /'chat\.translationBoundary': 'Automated translation/);
  assert.match(catalog, /'chat\.translationBoundary': '자동 번역/);
  assert.match(catalog, /'chat\.translationBoundary': 'La traducción automática/);
});
