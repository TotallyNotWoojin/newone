import { expect, test } from '../support/live-fixtures.mjs';

test.describe.configure({ mode: 'serial' });

// The owner's father's summary (Sep 14 2026): a header with the date and
// hours covered and who took part, a few short numbered lines that open with
// a name, no decisions or to-do sections, and PDF and Word buttons that put
// a real file in the downloads folder instead of opening the print window.
test('a summary shows its header and short lines, and PDF and Word download real files', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  test.setTimeout(360_000);
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}:`) }).click();
  await expect(chats.getByTestId('composer-input')).toBeVisible();
  await chats.getByRole('button', { name: 'Summarize' }).click();
  const sheet = chats.getByRole('heading', { name: 'Summary' });
  await expect(sheet).toBeVisible();
  await chats.getByRole('button', { name: 'Summarize conversation' }).click();
  await expect(chats.getByText(/Generating/)).toBeVisible({ timeout: 30_000 });
  await expect(chats.getByText(/Generating/)).toHaveCount(0, { timeout: 240_000 });

  // Header: a date with a clock time, and the participants.
  await expect(chats.getByText(/20\d\d.*\d:\d\d/).first()).toBeVisible();
  await expect(chats.getByText(new RegExp(`^Participants: .*${liveWorkspace.friend.displayName}`))).toBeVisible();
  // Lines: numbered, opening with a name, at most ten, and no lists.
  const lines = await chats.getByText(/^\d{1,2}[.)] /).allTextContents();
  expect(lines.length).toBeGreaterThanOrEqual(1);
  expect(lines.length).toBeLessThanOrEqual(10);
  for (const line of lines) expect(line).toMatch(/^\d{1,2}[.)] [^:]{1,40}: /);
  await expect(chats.getByText('Decisions')).toHaveCount(0);
  await expect(chats.getByText('To-do')).toHaveCount(0);
  await chats.screenshot({ path: testInfo.outputPath('summary-sheet.png') });

  const firstBytes = async (download, count) => {
    const stream = await download.createReadStream();
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      stream.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= count) {
          stream.destroy();
          resolve(Buffer.concat(chunks).subarray(0, count));
        }
      });
      stream.on('end', () => resolve(Buffer.concat(chunks).subarray(0, count)));
      stream.on('error', reject);
    });
  };

  const [pdf] = await Promise.all([
    chats.waitForEvent('download', { timeout: 60_000 }),
    chats.getByRole('button', { name: 'PDF' }).click(),
  ]);
  expect(pdf.suggestedFilename()).toMatch(/^Gist summary – .* – \d{4}-\d{2}-\d{2}\.pdf$/);
  expect((await firstBytes(pdf, 5)).toString('latin1')).toBe('%PDF-');

  const [word] = await Promise.all([
    chats.waitForEvent('download', { timeout: 60_000 }),
    chats.getByRole('button', { name: 'Word' }).click(),
  ]);
  expect(word.suggestedFilename()).toMatch(/\.docx$/);
  expect((await firstBytes(word, 2)).toString('latin1')).toBe('PK');
  // No print window opened: the page is still the chat with the sheet up.
  await expect(sheet).toBeVisible();
});
