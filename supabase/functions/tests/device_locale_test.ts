import { assertEquals } from 'jsr:@std/assert@1';
import { normalizeLocaleTag } from '../newone-api/routes.ts';

Deno.test('device locale tags keep their core and drop Unicode extensions', () => {
  // A 24-hour clock or a calendar preference adds "-u-…" on the phone; the
  // registration must not be refused for it (owner report, Sep 6 2026).
  assertEquals(normalizeLocaleTag('en-US-u-hc-h23'), 'en-US');
  assertEquals(normalizeLocaleTag('ko-KR-u-ca-gregory-nu-latn'), 'ko-KR');
  assertEquals(normalizeLocaleTag('es-419'), 'es-419');
  assertEquals(normalizeLocaleTag('zh-Hant-TW'), 'zh-Hant-TW');
  assertEquals(normalizeLocaleTag('ko_KR'), 'ko-KR');
  assertEquals(normalizeLocaleTag('EN-us'), 'en-us');
  assertEquals(normalizeLocaleTag('x-private'), null);
  assertEquals(normalizeLocaleTag('e'), null);
  assertEquals(normalizeLocaleTag('en-US-x-lvariant-POSIX'), 'en-US');
  assertEquals(normalizeLocaleTag('!!'), null);
});
