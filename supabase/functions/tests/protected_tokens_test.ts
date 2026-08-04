import { ProtectedTokenError, protectTokens, restoreTokens } from '../_shared/protected-tokens.ts';
import { assert, assertEquals, assertRejects } from './assert.ts';

Deno.test('protected tokens preserve IDs, tolerances, measurements, temperatures, and times exactly', () => {
  const source = 'Ajuste MX-1042 a ±0.25 mm antes de las 14:30; límite +85 °C y 0.30 mm.';
  const protectedText = protectTokens(source);
  assertEquals(protectedText.tokens.map((token) => token.value), [
    'MX-1042',
    '±0.25 mm',
    '14:30',
    '+85 °C',
    '0.30 mm',
  ]);
  for (const token of protectedText.tokens) {
    assert(protectedText.text.includes(token.placeholder));
    assert(!protectedText.text.includes(token.value));
  }

  const translated = `설비 ${protectedText.tokens[0]?.placeholder}를 ${
    protectedText.tokens[1]?.placeholder
  }로 조정하고 ${protectedText.tokens[2]?.placeholder} 전에 ${
    protectedText.tokens[3]?.placeholder
  } 및 ${protectedText.tokens[4]?.placeholder} 한계를 확인하세요.`;
  const restored = restoreTokens(translated, protectedText.tokens);
  for (const token of protectedText.tokens) assert(restored.includes(token.value));
  assert(!restored.includes('__NEWONE_PROTECTED_'));

  const hangulSuffixes = protectTokens(
    '압력을 2.5 bar로 유지하고 +85 °C까지 올린 뒤 1200 rpm으로 운전하세요.',
  );
  assertEquals(hangulSuffixes.tokens.map((token) => token.value), [
    '2.5 bar',
    '+85 °C',
    '1200 rpm',
  ]);
  assertEquals(protectTokens('The barometer reading is stable.').tokens, []);
});

Deno.test('protected token restoration fails closed on deletion, duplication, or injection', async () => {
  const protectedText = protectTokens('Use LINE-7 at ±0.25 mm by 08:30.');
  const placeholders = protectedText.tokens.map((token) => token.placeholder);

  await assertRejects(
    () => restoreTokens(placeholders.slice(1).join(' '), protectedText.tokens),
    (error) => error instanceof ProtectedTokenError,
  );
  await assertRejects(
    () => restoreTokens(`${placeholders.join(' ')} ${placeholders[0]}`, protectedText.tokens),
    (error) => error instanceof ProtectedTokenError,
  );
  await assertRejects(
    () =>
      restoreTokens(`${placeholders.join(' ')} __NEWONE_PROTECTED_9999__`, protectedText.tokens),
    (error) => error instanceof ProtectedTokenError,
  );
});
