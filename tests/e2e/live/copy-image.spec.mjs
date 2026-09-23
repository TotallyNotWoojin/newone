import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '../support/live-fixtures.mjs';
import { sendAttachment } from '../support/live-media.mjs';

// "Copying an image doesn't work" on the web (owner, Sep 23 2026). Three
// ways a person copies a photo, each checked by what actually lands on the
// clipboard: the message menu's Copy image, the photo viewer's own Copy
// button, and the browser's right-click menu inside the viewer, which the
// chat row used to swallow (the viewer is rendered from the row, so its
// right-click reached the row's handler, the browser's menu never opened, and
// the message actions opened out of sight behind the viewer). The copied
// picture is then pasted back with the keyboard into the composer.

test.describe.configure({ mode: 'serial' });

const HERE = dirname(fileURLToPath(import.meta.url));

async function clipboardTypes(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  return await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    return items.flatMap((item) => item.types);
  });
}

async function clearClipboard(page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate(() => navigator.clipboard.writeText('nothing yet'));
  // From here on only what Chrome gives the tab in front of the reader by
  // itself: writing the clipboard, never reading it. Playwright's Chromium
  // leaves even that ungranted, and its write then waits for ever.
  await page.context().clearPermissions();
  await page.context().grantPermissions(['clipboard-write'], { origin: new URL(page.url()).origin });
}

test('a friend\'s photo copies as a picture from the message menu, and pastes back as one', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  test.setTimeout(180_000);
  const { keys, sessions, conversationId } = liveWorkspace;
  await sendAttachment(keys, sessions.friend, conversationId, {
    label: 'copy-photo',
    fileName: 'copy-me.jpg',
    mimeType: 'image/jpeg',
    bytes: readFileSync(join(HERE, '../fixtures/copy-me.jpg')),
  });
  await chats.bringToFront();
  chats.on('console', (message) => {
    if (message.text().includes('copy image')) console.log(`page: ${message.text()}`);
  });
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}:`) }).click();
  // The friend's photo is the newest message; the chat may already hold
  // pictures pasted by earlier specs, so wait until every one has loaded.
  const pane = chats.getByTestId('keyboard-avoiding-screen');
  await expect(pane.getByRole('progressbar')).toHaveCount(0, { timeout: 60_000 });
  const photo = pane.getByLabel('Open image full screen').last();
  await expect(photo).toBeVisible({ timeout: 60_000 });
  await clearClipboard(chats);

  await photo.click({ button: 'right' });
  await chats.getByRole('button', { name: 'Copy image' }).click();
  // Either answer names itself; only one of them is a pass.
  await expect(chats.getByText(/^(Image copied|The image could not be copied\.)$/)).toBeVisible({ timeout: 20_000 });
  await expect(chats.getByText('Image copied')).toBeVisible();
  expect(await clipboardTypes(chats)).toContain('image/png');
  await chats.screenshot({ path: testInfo.outputPath('copy-from-menu.png') });

  // Paste it back with the keyboard: the composer offers it as a photo.
  await chats.getByTestId('composer-input').click();
  await chats.keyboard.press('ControlOrMeta+V');
  await expect(chats.getByLabel('Selected image preview')).toBeVisible({ timeout: 15_000 });
  await chats.screenshot({ path: testInfo.outputPath('paste-back.png') });
  await chats.getByRole('button', { name: 'Close dialog' }).last().click();
});

test('the photo viewer copies with its own button and leaves the browser\'s right-click menu alone', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  await chats.bringToFront();
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}:`) }).click();
  const pane = chats.getByTestId('keyboard-avoiding-screen');
  await expect(pane.getByRole('progressbar')).toHaveCount(0, { timeout: 60_000 });
  const photo = pane.getByLabel('Open image full screen').last();
  await expect(photo).toBeVisible({ timeout: 60_000 });
  await clearClipboard(chats);
  await photo.click();
  const copy = chats.getByTestId('image-viewer-copy');
  await expect(copy).toBeVisible();

  // The right-click inside the viewer reaches the browser: nothing cancels it,
  // and the message actions do not open behind the viewer.
  const prevented = await chats.evaluate(() => {
    const images = [...document.querySelectorAll('img')].filter((img) => img.getBoundingClientRect().width > 400);
    const image = images.at(-1);
    if (!image) return 'no viewer image';
    const box = image.getBoundingClientRect();
    const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2,
    });
    return target?.dispatchEvent(event) === false;
  });
  expect(prevented).toBe(false);
  await expect(chats.getByText('Message actions')).toHaveCount(0);

  await copy.click();
  await expect(chats.getByText(/^(Image copied|The image could not be copied\.)$/)).toBeVisible({ timeout: 20_000 });
  await expect(chats.getByText('Image copied')).toBeVisible();
  expect(await clipboardTypes(chats)).toContain('image/png');
  await chats.screenshot({ path: testInfo.outputPath('copy-from-viewer.png') });
  await chats.getByRole('button', { name: 'Close image' }).click();
});
