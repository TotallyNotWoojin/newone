import { test as base } from '@playwright/test';

import { createLiveWorkspace } from './live-account.mjs';
import { installGatewayProxy, signInThroughTheForm } from './live-gateway.mjs';

/**
 * `liveWorkspace` is built once per worker: three real signups, two accepted
 * contacts, a chat with three messages and one pin. `openSignedIn` gives a
 * browser context that reaches the real gateway and is already signed in as
 * that account's owner.
 */
export const test = base.extend({
  liveWorkspace: [
    async ({}, use) => {
      const workspace = await createLiveWorkspace();
      await use(workspace);
    },
    { scope: 'worker', timeout: 180_000 },
  ],

  openSignedIn: async ({ browser, liveWorkspace, baseURL }, use) => {
    const opened = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        ...options,
      });
      const stop = await installGatewayProxy(context, {
        projectUrl: liveWorkspace.projectUrl,
        pageOrigin: new URL(baseURL).origin,
      });
      const page = await context.newPage();
      opened.push({ context, stop });
      await signInThroughTheForm(page, liveWorkspace.owner);
      return page;
    });
    for (const { context, stop } of opened) {
      await stop().catch(() => {});
      await context.close().catch(() => {});
    }
  },

  /** The common case: one signed-in desktop page in the viewer's own scheme. */
  signedInPage: async ({ openSignedIn }, use) => {
    await use(await openSignedIn());
  },
});

export { expect } from '@playwright/test';
