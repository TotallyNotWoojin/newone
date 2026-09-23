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
  // The chat is shared with the other specs, so look at the newest message
  // rather than counting: the list keeps the newest first in the page.
  const newest = () => pane.evaluate((root) => {
    const element = root.querySelector('[data-testid="attachment-awaiting"], [aria-label="Open image full screen"]');
    if (!element) return null;
    if (element.getAttribute('data-testid') === 'attachment-awaiting') return { kind: 'waiting', text: element.textContent };
    const image = element.querySelector('img');
    return { kind: 'photo', painted: Boolean(image && image.complete && image.naturalWidth > 0) };
  });

  const messageId = await startAttachment(keys, sessions.friend, conversationId, { label: 'pending-photo' });
  await expect.poll(newest, { timeout: 30_000 }).toMatchObject({ kind: 'waiting' });
  expect((await newest()).text).toContain('Photo or file on its way…');
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
  await expect.poll(newest, { timeout: 60_000 }).toEqual({ kind: 'photo', painted: true });
  await expect(row).toContainText('Photo');
  await chats.screenshot({ path: testInfo.outputPath('pending-attachment-arrived.png') });
});
