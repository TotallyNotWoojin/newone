import { expect, test } from '@playwright/test';

import { navigateTo, openDemo } from './helpers.mjs';

test('the default build writes no user-scoped offline workspace records', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'People', /\/people$/);

  const userScopedRecords = await page.evaluate(async () => {
    const metadata = typeof indexedDB.databases === 'function'
      ? await indexedDB.databases()
      : [];
    if (!metadata.some((database) => database.name === 'newone-secure-client')) return [];

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('newone-secure-client');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const request = database.transaction('records', 'readonly').objectStore('records').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();

    const emptyOwnerDigest = [...new Uint8Array(await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(''),
    ))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return records.filter((record) => (
      record?.kind === 'cache' && record.ownerHash !== emptyOwnerDigest
    ));
  });

  expect(userScopedRecords).toEqual([]);
});
