import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const screen = await readFile(
  new URL('../apps/newone/src/app/handoffs.tsx', import.meta.url),
  'utf8',
);
const copy = await readFile(
  new URL('../apps/newone/src/features/handoffs/handoff-correction-copy.ts', import.meta.url),
  'utf8',
);

test('handoff evidence links preserve the exact conversation and message identity', () => {
  assert.match(screen, /workspace\.selectConversation\(handoff\.conversationId\)/);
  assert.match(screen, /params: \{ id: handoff\.conversationId, messageId \}/);
  assert.match(screen, /accessibilityRole="button"/);
});

test('handoff source navigation is labeled in every supported interface language', () => {
  assert.match(copy, /openSource: 'Open source message'/);
  assert.match(copy, /openSource: '출처 메시지 열기'/);
  assert.match(copy, /openSource: 'Abrir mensaje fuente'/);
});
