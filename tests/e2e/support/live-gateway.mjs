// The browser half of the live web suite.
//
// Why a proxy exists at all: the exported web build runs in `direct` mode, so
// the browser calls the project's Edge Functions itself and the functions only
// answer a browser whose `Origin` is in the deployed `NEWONE_ALLOWED_WEB_ORIGINS`
// list. That list holds the two production hosts and nothing else, and this
// stream may not deploy, so a page served from `http://127.0.0.1:4173` is
// refused with `403 origin_not_allowed` before any application logic runs.
//
// What this does about it: every Edge Function call the app makes is re-issued
// from Node — where no CORS rule applies — carrying the production `Origin`,
// and the real answer is handed back to the page. The server, the session, the
// data and the app code are all real; the only thing standing in for
// production is the browser's own address. Nothing is stubbed, recorded, or
// invented, and a failing route fails the test.
import { request as playwrightRequest } from '@playwright/test';

/** A deployed, allow-listed browser origin (see docs/WEB.md). */
export const PRODUCTION_WEB_ORIGIN = 'https://newonechat.com';

/** True when the live half of the suite has been asked for explicitly. */
export function liveSuiteRequested() {
  return process.env.NEWONE_WEB_E2E_LIVE === '1';
}

/**
 * Routes `<project>.supabase.co/functions/v1/**` through Node with an
 * allow-listed Origin. Returns a disposer.
 */
export async function installGatewayProxy(context, { projectUrl, pageOrigin }) {
  const api = await playwrightRequest.newContext();
  const pattern = `${projectUrl}/functions/v1/**`;

  await context.route(pattern, async (route) => {
    const browserRequest = route.request();
    if (browserRequest.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': pageOrigin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS',
          'access-control-allow-headers':
            browserRequest.headers()['access-control-request-headers'] ?? '*',
          'access-control-max-age': '600',
        },
        body: '',
      });
      return;
    }

    const headers = { ...browserRequest.headers(), origin: PRODUCTION_WEB_ORIGIN, referer: `${PRODUCTION_WEB_ORIGIN}/` };
    delete headers.host;
    let upstream;
    try {
      upstream = await api.fetch(browserRequest.url(), {
        method: browserRequest.method(),
        headers,
        data: browserRequest.postDataBuffer() ?? undefined,
        maxRedirects: 0,
        timeout: 30_000,
      });
    } catch {
      await route.abort('failed');
      return;
    }
    const forwarded = {};
    for (const [name, value] of Object.entries(upstream.headers())) {
      if (name.startsWith('access-control-') || name === 'content-encoding' || name === 'content-length') continue;
      forwarded[name] = value;
    }
    forwarded['access-control-allow-origin'] = pageOrigin;
    forwarded['access-control-allow-credentials'] = 'true';
    await route.fulfill({
      status: upstream.status(),
      headers: forwarded,
      body: await upstream.body(),
    });
  });

  return async () => {
    await context.unroute(pattern);
    await api.dispose();
  };
}

/** Signs in through the real form and waits for Chats. */
export async function signInThroughTheForm(page, { email, password }) {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByTestId('sign-in-destination').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByTestId('password').waitFor({ state: 'visible', timeout: 30_000 });
  await page.getByTestId('password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 45_000 });
  await page.getByTestId('conversation-list').waitFor({ state: 'visible', timeout: 45_000 });
}
