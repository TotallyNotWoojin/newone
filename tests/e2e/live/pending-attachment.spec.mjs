import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '../support/live-fixtures.mjs';
import { finishAttachment, startAttachment } from '../support/live-media.mjs';

// While someone's photo is still uploading -- or after their upload was
// refused and never retried -- the server already hands the message to
// everyone else, with no text and no file. It drew an empty bubble, and the
// Chats row said "No messages yet" (probed on the hosted backend, Sep 23
// 2026). The friend here does exactly what the app does: the message first,
// the file after.

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(HERE, '..', 'fixtures', 'copy-me.jpg');

test('a photo the other person is still sending says so, then turns into the photo', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  const { keys, sessions, conversationId, friend } = liveWorkspace;
  await chats.getByRole('button', { name: new RegExp(`^${friend.displayName}:`) }).click();
  await expect(chats.getByTestId('composer-input')).toBeVisible();
  const pane = chats.getByTestId('keyboard-avoiding-screen');
  const photos = pane.getByLabel('Open image full screen');
  const photosBefore = await photos.count();

  // The chat is shared with the other specs, so count rather than assume.
  const waiting = pane.getByTestId('attachment-awaiting');
  const waitingBefore = await waiting.count();
  const messageId = await startAttachment(keys, sessions.friend, conversationId, { label: 'pending-photo' });
  await expect(waiting).toHaveCount(waitingBefore + 1, { timeout: 30_000 });
  await expect(waiting.first()).toContainText('Photo or file on its way…');
  // The Chats row names it rather than claiming the chat is empty.
  const row = chats.getByRole('button', { name: new RegExp(`^${friend.displayName}:`) });
  await expect(row).toContainText('Attachment');
  await expect(row).not.toContainText('No messages yet');
  await chats.screenshot({ path: testInfo.outputPath('pending-attachment.png') });

  await finishAttachment(keys, sessions.friend, conversationId, messageId, {
    label: 'pending-photo',
    fileName: 'arrived.jpg',
    mimeType: 'image/jpeg',
    bytes: readFileSync(PHOTO),
  });
  await expect(photos).toHaveCount(photosBefore + 1, { timeout: 45_000 });
  await expect(waiting).toHaveCount(waitingBefore);
  await expect.poll(() => photos.last().evaluate((element) => {
    const image = element.querySelector('img');
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }), { timeout: 30_000 }).toBe(true);
  await expect(row).toContainText('Photo');
  await chats.screenshot({ path: testInfo.outputPath('pending-attachment-arrived.png') });
});
