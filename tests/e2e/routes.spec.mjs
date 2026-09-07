import { expect, test } from '@playwright/test';

// Every route is also a file on a static host, so anyone can type one. Signed
// out, everything but the two public screens must land on sign-in rather than
// render an empty app shell.

const PROTECTED = ['/', '/people', '/new-group', '/settings', '/updates', '/handoffs', '/admin'];

for (const path of PROTECTED) {
  test(`${path} sends a signed-out visitor to sign-in`, async ({ page }) => {
    await page.goto(path);
    await page.waitForURL((url) => url.pathname === '/sign-in', { timeout: 20_000 });
    await expect(page.getByText('Create your account')).toBeVisible();
  });
}

test('help is public and needs no account', async ({ page }) => {
  await page.goto('/help');
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByText('Help and recovery')).toBeVisible();
});

// A conversation deep link has no file of its own on a static host: the export
// writes `conversation/[id].html`, and the id in the URL is filled in by the
// client. GitHub Pages therefore needs the repo-root 404.html described in
// docs/WEB.md to hand the path back to the app. This test pins the shape that
// makes that necessary; the 404.html hand-back itself lives in the Pages repo
// and is not exercised here.
test('a conversation deep link has no file of its own, but its route does', async ({ request }) => {
  const deepLink = await request.get('/conversation/00000000-0000-4000-8000-000000000000');
  expect(deepLink.status()).toBe(404);
  const route = await request.get('/conversation/%5Bid%5D.html');
  expect(route.status()).toBe(200);
});
