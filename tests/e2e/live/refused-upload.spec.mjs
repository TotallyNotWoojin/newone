import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '../support/live-fixtures.mjs';
import { spendUploadBudget } from '../support/live-media.mjs';

// A photo the server refuses used to leave a blank bubble of the sender's own:
// the refresh that followed the send swapped the local message for the
// server's row, which has no file yet, so the photo, the reason and Retry
// were gone, and every later update had nothing to land on (full live run,
// Sep 23 2026). The refusal here is the server's own: an account may start
// 60 uploads a minute (10 until the same day), and this one has just spent
// them from another device of theirs.

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'fixtures', 'copy-me.jpg');
const UPLOAD_WINDOW_MS = 60_000;
const UPLOADS_PER_MINUTE = 60;

test('a photo the server refuses keeps its bubble with the reason and Retry, and Retry sends it', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  test.setTimeout(300_000);
  const { keys, sessions, groupConversationId } = liveWorkspace;
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}:`) }).click();
  await expect(chats.getByTestId('composer-input')).toBeVisible();
  const pane = chats.getByTestId('keyboard-avoiding-screen');

  // The minute's upload budget, spent in the group; the next request is refused.
  const budgetStartedAt = Date.now();
  expect(await spendUploadBudget(keys, sessions.owner, groupConversationId, UPLOADS_PER_MINUTE)).toBe(429);
  expect(Date.now() - budgetStartedAt).toBeLessThan(UPLOAD_WINDOW_MS - 20_000);

  await chats.getByRole('button', { name: 'Add attachment' }).click();
  const [chooser] = await Promise.all([
    chats.waitForEvent('filechooser'),
    chats.getByRole('button', { name: 'Choose file' }).click(),
  ]);
  await chooser.setFiles(PHOTO);
  await chats.getByTestId('attachment-send').click();

  const retry = pane.getByRole('button', { name: 'Retry upload' });
  await expect(retry).toBeVisible({ timeout: 30_000 });
  // The reason sits in the bubble, beside Retry (the banner over the chat
  // says it too).
  await expect(pane.locator('div')
    .filter({ has: chats.getByRole('button', { name: 'Retry upload' }) })
    .filter({ hasText: 'Too many requests were made. Wait a moment and try again.' })
    .last()).toBeVisible();
  // The photo itself stays in the bubble, dimmed behind the controls.
  await expect(pane.getByRole('img', { name: 'Uploading' })).toBeVisible();
  // It holds through the reconciles that follow (the realtime refetch and the
  // polling), which is where it used to be wiped.
  await chats.waitForTimeout(12_000);
  await expect(retry).toBeVisible();
  await expect(pane.getByRole('img', { name: 'Uploading' })).toBeVisible();
  await chats.screenshot({ path: testInfo.outputPath('refused-upload.png') });

  // Once the minute is over, Retry sends it.
  const wait = budgetStartedAt + UPLOAD_WINDOW_MS + 3_000 - Date.now();
  if (wait > 0) await chats.waitForTimeout(wait);
  await retry.click();
  await expect(retry).toHaveCount(0, { timeout: 45_000 });
  await expectNewestPhotoPainted(pane);
  await chats.screenshot({ path: testInfo.outputPath('refused-upload-retried.png') });

  // And it is the server's photo now, not a leftover on this page.
  await chats.reload();
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}:`) }).click();
  await expectNewestPhotoPainted(pane);
  await chats.screenshot({ path: testInfo.outputPath('refused-upload-reloaded.png') });
});

/**
 * The newest photo-or-upload in the chat is a photo whose picture has loaded,
 * not only the button that opens it. The list keeps the newest message first
 * in the page, and a photo still uploading is labelled "Uploading", so an
 * older photo can never stand in for this one.
 */
async function expectNewestPhotoPainted(pane) {
  await expect.poll(() => pane.evaluate((root) => {
    const element = root.querySelector(
      '[aria-label="Open image full screen"], [aria-label="Uploading"], [data-testid="attachment-awaiting"]',
    );
    if (element?.getAttribute('aria-label') !== 'Open image full screen') return false;
    const image = element.querySelector('img');
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }), { timeout: 60_000 }).toBe(true);
}
