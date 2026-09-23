import { expect, test } from '../support/live-fixtures.mjs';

// Reloading or closing the page mid-upload used to abandon the file without a
// word: its message was already sent, so the other side waited on a file that
// never came, and this side had nothing left to retry (a full live web run,
// Sep 23 2026). While an upload runs, the browser now asks first; staying
// keeps the upload going. A slow connection (Chrome's own throttling, not a
// mock) keeps it running long enough to try.

test('reloading while a file is still uploading asks first, and staying lets it finish', async ({
  chats,
  liveWorkspace,
}) => {
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}:`) }).click();
  await expect(chats.getByTestId('composer-input')).toBeVisible();

  const cdp = await chats.context().newCDPSession(chats);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 150, downloadThroughput: 500_000, uploadThroughput: 25_000,
  });

  const fileName = `slow-${Date.now()}.pdf`;
  const dataTransfer = await chats.evaluateHandle((name) => {
    const transfer = new DataTransfer();
    const body = `%PDF-1.4\n% the web suite uploads this slowly\n${'0'.repeat(300_000)}\n%%EOF\n`;
    transfer.items.add(new File([body], name, { type: 'application/pdf' }));
    return transfer;
  }, fileName);
  await chats.dispatchEvent('body', 'drop', { dataTransfer });
  const send = chats.getByTestId('attachment-send');
  await expect(send).toBeVisible({ timeout: 10_000 });
  await chats.keyboard.press('Enter');
  const uploading = chats.getByLabel(`${fileName}, Uploading`);
  await expect(uploading).toBeVisible({ timeout: 60_000 });

  const dialogs = [];
  const onDialog = (dialog) => {
    dialogs.push(dialog.type());
    void dialog.dismiss();
  };
  chats.on('dialog', onDialog);
  await chats.evaluate(() => { window.location.reload(); }).catch(() => undefined);
  await expect.poll(() => dialogs, { timeout: 10_000 }).toContain('beforeunload');
  chats.off('dialog', onDialog);

  // Stayed: the same page, the upload still going.
  await expect(chats.getByTestId('composer-input')).toBeVisible();
  await expect(uploading).toBeVisible();

  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
  });
  await expect(chats.getByLabel(`${fileName}, Ready`)).toBeVisible({ timeout: 90_000 });
  await cdp.detach();
});
