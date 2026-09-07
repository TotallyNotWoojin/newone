import { expect, test } from '@playwright/test';

// Dark mode as a browser sees it. The app follows the operating system unless
// Settings overrides it, so the scheme the browser reports is the only input
// this half of the suite needs. The Settings override is signed-in and is
// covered by tests/e2e/live/appearance.spec.mjs.

/** The palette's two canvases (apps/newone/src/theme/palette.ts). */
const LIGHT_CANVAS = 'rgb(243, 245, 241)';
const DARK_CANVAS = 'rgb(14, 20, 18)';

async function pageColours(page) {
  return await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    root: getComputedStyle(document.documentElement).backgroundColor,
    themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
  }));
}

test.describe('light', () => {
  test.use({ colorScheme: 'light' });

  test('a light browser gets the light canvas', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByText('Create your account')).toBeVisible();
    const colours = await pageColours(page);
    expect(colours.body).toBe(LIGHT_CANVAS);
    expect(colours.root).toBe(LIGHT_CANVAS);
  });

  test('the help screen is light too', async ({ page }) => {
    await page.goto('/help');
    await expect(page.getByText('Help and recovery')).toBeVisible();
    expect((await pageColours(page)).body).toBe(LIGHT_CANVAS);
  });
});

test.describe('dark', () => {
  test.use({ colorScheme: 'dark' });

  test('a dark browser gets the dark canvas and a matching theme colour', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByText('Create your account')).toBeVisible();
    const colours = await pageColours(page);
    expect(colours.body).toBe(DARK_CANVAS);
    expect(colours.root).toBe(DARK_CANVAS);
    // The browser chrome is told about it too, so a dark tab has no light bar.
    expect(colours.themeColor?.toUpperCase()).toBe('#0E1412');
  });

  test('the help screen is dark too, and its text stays readable', async ({ page }) => {
    await page.goto('/help');
    const heading = page.getByText('Help and recovery');
    await expect(heading).toBeVisible();
    expect((await pageColours(page)).body).toBe(DARK_CANVAS);
    // Ink on a dark canvas has to be light ink, not the light theme's near-black.
    const ink = await heading.evaluate((node) => getComputedStyle(node).color);
    const [red, green, blue] = ink.match(/\d+/g).map(Number);
    expect(red + green + blue).toBeGreaterThan(3 * 128);
  });
});

test('the same screen differs between the two schemes', async ({ browser, baseURL }) => {
  const shots = {};
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ baseURL, colorScheme: scheme, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await page.goto('/sign-in');
    await expect(page.getByText('Create your account')).toBeVisible();
    shots[scheme] = (await pageColours(page)).body;
    await context.close();
  }
  expect(shots.light).not.toBe(shots.dark);
});
