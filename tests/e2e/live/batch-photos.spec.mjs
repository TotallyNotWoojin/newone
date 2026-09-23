import { expect, test } from '../support/live-fixtures.mjs';
import { PERSONAL_REALM_ID, gatewayPost } from '../../hosted/smoke-lib.mjs';

// Twenty photos sent at once -- as many as the phone's photo picker takes --
// all arrive. Each photo is its own message, and the app's limits used to
// refuse the 11th message inside ten seconds and the 11th upload inside a
// minute (raised Sep 23 2026, "you can up rate limiting"). What arrives is
// read from the server, as the friend would see it.

const BATCH = 20;

test('twenty photos dropped and sent together all arrive', async ({ chats, liveWorkspace }) => {
  test.setTimeout(300_000);
  const { keys, sessions, conversationId, friend } = liveWorkspace;
  await chats.getByRole('button', { name: new RegExp(`^${friend.displayName}:`) }).click();
  await expect(chats.getByTestId('composer-input')).toBeVisible();

  const stamp = Date.now();
  const dataTransfer = await chats.evaluateHandle(({ count, prefix }) => {
    // A real 8x8 PNG per photo, each a different colour, drawn by the browser.
    const transfer = new DataTransfer();
    for (let index = 0; index < count; index += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = 8;
      canvas.height = 8;
      const context = canvas.getContext('2d');
      context.fillStyle = `hsl(${index * 18}, 80%, 50%)`;
      context.fillRect(0, 0, 8, 8);
      const binary = atob(canvas.toDataURL('image/png').split(',')[1]);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], `${prefix}-${String(index).padStart(2, '0')}.png`, { type: 'image/png' }));
    }
    return transfer;
  }, { count: BATCH, prefix: `batch-${stamp}` });
  await chats.dispatchEvent('body', 'drop', { dataTransfer });
  const send = chats.getByTestId('attachment-send');
  await expect(send).toHaveAccessibleName(`Send ${BATCH} files`, { timeout: 15_000 });
  await chats.keyboard.press('Enter');
  await expect(send).toHaveCount(0, { timeout: 120_000 });

  // Nothing refused along the way.
  await expect(chats.getByText('Too many requests were made. Wait a moment and try again.')).toHaveCount(0);
  await expect(chats.getByRole('button', { name: 'Retry upload' })).toHaveCount(0);

  // The friend's side of the server holds all twenty, clean.
  const arrived = async () => {
    const response = await gatewayPost('newone-read', `/v2/conversations/${conversationId}/messages/query`, keys, {
      installationId: sessions.friend.installationId,
      accessToken: sessions.friend.accessToken,
      body: { organizationId: PERSONAL_REALM_ID, limit: 100 },
    });
    const messages = (response.payload?.data ?? response.payload)?.messages ?? [];
    return messages
      .flatMap((message) => message.attachments ?? [])
      .filter((attachment) => String(attachment.fileName ?? '').startsWith(`batch-${stamp}-`)
        && attachment.scanStatus === 'clean')
      .length;
  };
  await expect.poll(arrived, { timeout: 180_000, intervals: [3_000] }).toBe(BATCH);
});
