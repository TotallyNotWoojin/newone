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

test('localized copy explains shared derived data and the higher organization AI gate', () => {
  assert.match(copy, /en:\s*\{/);
  assert.match(copy, /ko:\s*\{/);
  assert.match(copy, /es:\s*\{/);
  assert.match(copy, /shared translation may still exist/);
  assert.match(copy, /Company AI policy is still the higher-level egress gate/);
});

test('database derives targets from active automatic recipients and hides shared translations from opted-out users', () => {
  assert.match(migration, /conversation_preference\.translation_mode, 'automatic'\) = 'automatic'/);
  assert.match(migration, /private\.scrub_translation_array_for_user_internal/);
  assert.match(migration, /private\.require_translation_mode_automatic_internal/);
  assert.match(migration, /private\.filter_translation_search_for_user_internal/);
  assert.doesNotMatch(migration, /p_target_languages/);
});
