import { test as base } from '@playwright/test';

import { E2E_BASE_URL } from './base-url.mjs';
import { createLiveWorkspace } from './live-account.mjs';
import { installGatewayProxy, signInThroughTheForm } from './live-gateway.mjs';

/**
 * `liveWorkspace` is built once per worker: three real signups, two accepted
 * contacts, a chat with three messages and one pin.
 *
 * `signedInPage` is worker-scoped on purpose. Every returning sign-in starts
 * with an account lookup, and the gateway rate-limits those per address and
 * per address-space (20 in fifteen minutes); signing in once per test would
 * spend that budget and turn the suite red for a quarter of an hour. So the
 * live specs share one signed-in page and each begins by putting it back on
 * Chats. `openPage` still hands out fresh, signed-out contexts for the specs
 * that need one.
 */
export const test = base.extend({
  liveWorkspace: [
    async ({}, use) => {
      await use(await createLiveWorkspace());
    },
    { scope: 'worker', timeout: 240_000 },
  ],

  signedInPage: [
    async ({ browser, liveWorkspace }, use) => {
      const context = await browser.newContext({
        baseURL: E2E_BASE_URL,
        viewport: { width: 1440, height: 1000 },
      });
      const stop = await installGatewayProxy(context, {
        projectUrl: liveWorkspace.projectUrl,
        pageOrigin: new URL(E2E_BASE_URL).origin,
      });
      const page = await context.newPage();
      await signInThroughTheForm(page, liveWorkspace.owner);
      await use(page);
      await stop().catch(() => {});
      await context.close().catch(() => {});
    },
    { scope: 'worker', timeout: 240_000 },
  ],

  openPage: async ({ browser, liveWorkspace }, use) => {
    const opened = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({
        baseURL: E2E_BASE_URL,
        viewport: { width: 1440, height: 1000 },
        ...options,
      });
      const stop = await installGatewayProxy(context, {
        projectUrl: liveWorkspace.projectUrl,
        pageOrigin: new URL(E2E_BASE_URL).origin,
      });
      opened.push({ context, stop });
      return await context.newPage();
    });
    for (const { context, stop } of opened) {
      await stop().catch(() => {});
      await context.close().catch(() => {});
    }
  },

  /** Puts the shared page back on a clean Chats screen before each test. */
  chats: async ({ signedInPage }, use) => {
    await signedInPage.emulateMedia({ colorScheme: 'light' });
    await signedInPage.goto('/');
    await signedInPage.getByTestId('conversation-list').waitFor({ state: 'visible', timeout: 60_000 });
    await use(signedInPage);
  },
});

export { expect } from '@playwright/test';
