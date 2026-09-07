import { expect, test } from '../support/live-fixtures.mjs';

// Dark mode on a signed-in screen: first following the browser, then the
// Settings override that stops it following.

test.describe.configure({ mode: 'serial' });

const LIGHT_CANVAS = 'rgb(243, 245, 241)';
const DARK_CANVAS = 'rgb(14, 20, 18)';

const canvas = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('Chats follows the browser into dark and back', async ({ chats }) => {
  expect(await canvas(chats)).toBe(LIGHT_CANVAS);

  await chats.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => canvas(chats)).toBe(DARK_CANVAS);
  await expect(chats.getByTestId('conversation-list')).toBeVisible();

  await chats.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => canvas(chats)).toBe(LIGHT_CANVAS);
});

test('the Settings override wins over the browser, and System hands it back', async ({ chats }) => {
  await chats.getByRole('button', { name: 'Open settings' }).click();
  await expect(chats.getByTestId('setting-appearance')).toBeVisible();

  const choose = async (option) => {
    await chats.getByTestId('setting-appearance').click();
    await chats.getByRole('button', { name: option, exact: true }).click();
  };

  // A light browser, told to be dark.
  await choose('Dark');
  await expect.poll(() => canvas(chats)).toBe(DARK_CANVAS);

  // A dark browser, told to be light.
  await chats.emulateMedia({ colorScheme: 'dark' });
  await choose('Light');
  await expect.poll(() => canvas(chats)).toBe(LIGHT_CANVAS);

  // Back to following the browser, which is still dark.
  await choose('System');
  await expect.poll(() => canvas(chats)).toBe(DARK_CANVAS);

  await chats.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => canvas(chats)).toBe(LIGHT_CANVAS);
});
