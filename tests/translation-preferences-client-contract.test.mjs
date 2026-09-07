import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const files = await Promise.all([
  readFile(new URL('../apps/newone/src/data/repositories/bff-command-repository.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/data/repositories/web-read-repository.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/state/workspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/features/chat/conversation-pane.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../apps/newone/src/features/chat/translation-preference-copy.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260804120850_add_translation_preferences.sql', import.meta.url), 'utf8'),
]);

const [commands, reads, workspace, pane, copy, migration] = files;

test('client persists an exact per-conversation translation mode through the BFF', () => {
  assert.match(commands, /translationMode: input\.translationMode/);
  assert.match(reads, /preferences\.translationMode === 'off'/);
  assert.match(workspace, /translationMode\?: 'automatic' \| 'off'/);
  assert.match(pane, /onUpdateTranslationMode\('automatic'\)/);
  assert.match(pane, /onUpdateTranslationMode\('off'\)/);
});

test('opting out clears cached derived text and gates render and request controls while preserving originals', () => {
  assert.match(workspace, /patch\.translationMode === 'off'/);
  assert.match(workspace, /translationState: 'not_requested'/);
  assert.match(pane, /const translation = translationEnabled \? message\.translation : undefined/);
  assert.match(pane, /translationEnabled\s*&& message\.serverId/);
  assert.match(pane, /message\.originalText/);
});

// Two lines went with the consumer rewrite in d7854dd (2026-09-05,
// "Terminology: consumer copy reads like a texting app, not a workplace tool"):
//   - "Company AI policy is still the higher-level egress gate" described an
//     organization AI policy that no consumer realm has.
//   - "shared translation may still exist" warned that turning translation off
//     does not retract translations others already hold. The copy no longer
//     claims otherwise (it now scopes itself: "Translates messages in this chat
//     for you"), and the server-side guarantee is stronger than the warning
//     was: the migration test below still pins
//     private.scrub_translation_array_for_user_internal, which hides shared
//     translations from opted-out readers.
// The property kept here is the one the switch cannot get wrong: the original
// is never replaced, said in all three locales, with matching keys throughout.
test('localized copy promises the original survives, in every locale', () => {
  const blocks = [...copy.matchAll(/\b(en|ko|es): \{([\s\S]*?)\n  \}/g)];
  assert.equal(blocks.length, 3);
  const keysFor = (block) => [...block.matchAll(/^\s{4}([a-zA-Z]+):/gm)].map((m) => m[1]).sort();
  const [en, ko, es] = blocks.map((block) => keysFor(block[2]));
  assert.ok(en.length >= 6, `suspiciously few translation preference keys (${en.length})`);
  assert.deepEqual(ko, en);
  assert.deepEqual(es, en);
  assert.match(copy, /Originals always stay\./);
  assert.match(copy, /원문은 항상 남습니다\./);
  assert.match(copy, /Los originales siempre se conservan\./);
});

test('database derives targets from active automatic recipients and hides shared translations from opted-out users', () => {
  assert.match(migration, /conversation_preference\.translation_mode, 'automatic'\) = 'automatic'/);
  assert.match(migration, /private\.scrub_translation_array_for_user_internal/);
  assert.match(migration, /private\.require_translation_mode_automatic_internal/);
  assert.match(migration, /private\.filter_translation_search_for_user_internal/);
  assert.doesNotMatch(migration, /p_target_languages/);
});
