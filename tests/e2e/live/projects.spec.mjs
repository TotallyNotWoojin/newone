import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '../support/live-fixtures.mjs';
import { signInThroughTheForm } from '../support/live-gateway.mjs';
import { sendText } from '../support/live-media.mjs';

// Projects inside a chat, as the owner's father drew them (Sep 23 2026):
// right-click "Projects" under the open chat to make one, and what you send
// while it is selected lands in its drawers — the link and the file typed and
// picked here, and the summary asked for here, saved with the AI's name and
// its date. The other member sees the same projects and takes the summary out
// too. Every step goes through the page the way a person would: clicks, the
// keyboard, the file chooser, the download.

test.describe.configure({ mode: 'serial' });

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_PDF = join(HERE, '../../device/fixtures/newone-sample.pdf');
const DATE = /\(\d{4}-\d{2}-\d{2}\)/;

async function openGroup(page, liveWorkspace) {
  await page.getByRole('button', { name: new RegExp(`^${liveWorkspace.groupName}:`) }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  return page.getByTestId('projects-panel').first();
}

test('right-clicking Projects under the open chat makes a project, and it becomes the one being saved into', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  const panel = await openGroup(chats, liveWorkspace);
  await expect(panel.getByTestId('projects-header')).toBeVisible();
  await panel.getByTestId('projects-header').click({ button: 'right' });
  await expect(chats.getByRole('heading', { name: 'New project' })).toBeVisible();
  const field = chats.getByTestId('project-name-input');
  await field.click();
  await chats.keyboard.type('HDG');
  await chats.getByTestId('project-name-save').click();
  await expect(panel.getByRole('button', { name: '1. HDG' })).toBeVisible();
  await expect(panel.getByText('Saving here')).toBeVisible();
  await expect(chats.getByTestId('active-project-bar')).toContainText('Saving to 1. HDG');

  // A second project through the + button; the chat refuses the same name twice.
  await panel.getByRole('button', { name: 'New project' }).click();
  await chats.getByTestId('project-name-input').click();
  await chats.keyboard.type('hdg');
  await chats.getByTestId('project-name-save').click();
  await expect(chats.getByText('This chat already has a project with that name.')).toBeVisible();
  await chats.getByTestId('project-name-input').fill('');
  await chats.getByTestId('project-name-input').click();
  await chats.keyboard.type('Maintenance');
  await chats.getByTestId('project-name-save').click();
  await expect(panel.getByRole('button', { name: '2. Maintenance' })).toBeVisible();
  await expect(chats.getByTestId('active-project-bar')).toContainText('Saving to 2. Maintenance');

  // Back to HDG from its own row.
  await panel.getByRole('button', { name: 'Save here: HDG' }).click();
  await expect(chats.getByTestId('active-project-bar')).toContainText('Saving to 1. HDG');
  await chats.screenshot({ path: testInfo.outputPath('projects-created.png') });
});

test('a link typed and a file picked while HDG is selected land in its drawers', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  const panel = await openGroup(chats, liveWorkspace);
  await expect(chats.getByTestId('active-project-bar')).toContainText('Saving to 1. HDG');
  const composer = chats.getByTestId('composer-input');
  await composer.click();
  await chats.keyboard.type('The site is www.newoneinc.com, contract below.');
  await chats.keyboard.press('Enter');
  await expect(chats.getByTestId('keyboard-avoiding-screen').getByText(/The site is/)).toBeVisible();

  await chats.getByRole('button', { name: 'Add attachment' }).click();
  const [chooser] = await Promise.all([
    chats.waitForEvent('filechooser'),
    chats.getByRole('button', { name: 'Choose file' }).click(),
  ]);
  await chooser.setFiles(SAMPLE_PDF);
  await chats.getByTestId('attachment-send').click();

  await expect(panel.getByRole('button', { name: /HDG · Links \(1\)/ })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText('www.newoneinc.com')).toBeVisible();
  await expect(panel.getByRole('button', { name: /HDG · Uploads \(1\)/ })).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText('newone-sample.pdf')).toBeVisible();
  await chats.screenshot({ path: testInfo.outputPath('projects-filed.png') });
});

test('a summary asked for here is saved into HDG under the AI\'s name and its date, and downloads under that name', async ({
  chats,
  liveWorkspace,
}, testInfo) => {
  test.setTimeout(360_000);
  const { keys, sessions, groupConversationId } = liveWorkspace;
  // The other two talk, so there is enough conversation for a recap.
  await sendText(keys, sessions.friend, groupConversationId, 'p-f1',
    'The wood was only placed to size the surface; we will cut it and finish the edges so it looks presentable.');
  await sendText(keys, sessions.third, groupConversationId, 'p-t1',
    'Please paint the whole base white and send the original PowerPoint file by email today.');
  await sendText(keys, sessions.friend, groupConversationId, 'p-f2',
    'The acid delivery arrives at Otay on Friday; Francisco will confirm when it is in the warehouse.');

  const panel = await openGroup(chats, liveWorkspace);
  await chats.getByRole('button', { name: 'Summarize' }).click();
  await expect(chats.getByTestId('summary-project-note')).toHaveText('The summary will be saved to 1. HDG.');
  const summarize = chats.getByRole('button', { name: 'Summarize conversation' });
  await expect(summarize).toBeEnabled();
  await summarize.click();
  await expect(chats.getByText(/Generating/)).toBeVisible({ timeout: 30_000 });
  await expect(chats.getByText(/Generating/)).toHaveCount(0, { timeout: 240_000 });
  await expect(chats.getByTestId('summary-saved-in')).toHaveText('Saved in HDG', { timeout: 30_000 });
  await chats.getByRole('button', { name: 'Close dialog' }).last().click();

  const summaryRow = panel.getByText(/ #1 \(\d{4}-\d{2}-\d{2}\)$/);
  await expect(summaryRow).toBeVisible({ timeout: 30_000 });
  const label = ((await summaryRow.textContent()) ?? '').trim();
  expect(label).toMatch(DATE);
  await chats.screenshot({ path: testInfo.outputPath('projects-summary.png') });

  const [download] = await Promise.all([
    chats.waitForEvent('download', { timeout: 60_000 }),
    panel.getByRole('button', { name: `PDF: ${label}` }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${label}.pdf`);
  const stream = await download.createReadStream();
  const head = await new Promise((resolve, reject) => {
    stream.once('data', (chunk) => {
      stream.destroy();
      resolve(chunk.subarray(0, 5).toString('latin1'));
    });
    stream.once('error', reject);
  });
  expect(head).toBe('%PDF-');

  // And it reads right there, without a download (owner, Sep 24 2026): the
  // model's own lines, in the app, with the files one tap away.
  await summaryRow.click();
  const preview = chats.getByTestId('summary-preview');
  await expect(preview).toBeVisible({ timeout: 30_000 });
  const lines = chats.getByTestId('summary-preview-line');
  await expect(lines.first()).toBeVisible({ timeout: 30_000 });
  expect(await lines.count()).toBeGreaterThan(0);
  await expect(chats.getByRole('button', { name: `Word: ${label}` }).last()).toBeVisible();
  await chats.screenshot({ path: testInfo.outputPath('projects-summary-preview.png') });
  await chats.getByRole('button', { name: 'Close dialog' }).last().click();
  await expect(preview).toHaveCount(0);
});

test('a summary file is renamed by hand and keeps its date', async ({ chats, liveWorkspace }) => {
  const panel = await openGroup(chats, liveWorkspace);
  const summaryRow = panel.getByText(/ #1 \(\d{4}-\d{2}-\d{2}\)$/);
  await expect(summaryRow).toBeVisible({ timeout: 30_000 });
  const date = ((await summaryRow.textContent()) ?? '').match(DATE)?.[0];
  // Right-click the file: its menu, as on the project rows.
  await summaryRow.click({ button: 'right' });
  await chats.getByRole('button', { name: 'Rename file' }).click();
  const field = chats.getByTestId('project-name-input');
  await expect(chats.getByText('The date stays after the name.')).toBeVisible();
  await field.click();
  await chats.keyboard.press('ControlOrMeta+A');
  await chats.keyboard.type('Acid summary for Luis');
  await chats.getByTestId('project-name-save').click();
  await expect(panel.getByText(`Acid summary for Luis ${date}`, { exact: true })).toBeVisible({ timeout: 15_000 });
});

test('찾기 names the chat a word came up in and opens it there', async ({ chats, liveWorkspace }) => {
  await chats.getByRole('button', { name: 'Find by keyword' }).click();
  await expect(chats.getByRole('heading', { name: 'Find by keyword' })).toBeVisible();
  const field = chats.getByTestId('keyword-find-input');
  await field.click();
  await chats.keyboard.type('Otay');
  const result = chats.getByRole('button', { name: new RegExp(`^Open ${liveWorkspace.groupName}\\.`) });
  await expect(result).toBeVisible({ timeout: 15_000 });
  await expect(result).toContainText('1 message');
  await result.click();
  // The search opens the chat's own page, over the list, at the message.
  await expect(chats.getByText(/The acid delivery arrives at Otay/).last()).toBeVisible({ timeout: 15_000 });

  await chats.goto('/');
  await chats.getByRole('button', { name: 'Find by keyword' }).click();
  await chats.getByTestId('keyword-find-input').click();
  await chats.keyboard.type('hdg');
  await expect(chats.getByRole('button', { name: new RegExp(`^Open ${liveWorkspace.groupName}\\..*Project HDG`) }))
    .toBeVisible({ timeout: 15_000 });
});

test('the other member sees the same projects from the header and takes the summary out too', async ({
  openPage,
  liveWorkspace,
}, testInfo) => {
  const page = await openPage();
  await signInThroughTheForm(page, { email: liveWorkspace.friend.email, password: liveWorkspace.friend.password });
  await page.getByRole('button', { name: new RegExp(`^${liveWorkspace.groupName}:`) }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  // The friend has no project selected, so no "Saving to" bar.
  await expect(page.getByTestId('active-project-bar')).toHaveCount(0);
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  const sheet = page.getByRole('heading', { name: 'Projects', exact: true });
  await expect(sheet).toBeVisible();
  const summaryRow = page.getByText(/^Acid summary for Luis \(\d{4}-\d{2}-\d{2}\)$/).last();
  await expect(summaryRow).toBeVisible({ timeout: 30_000 });
  const label = ((await summaryRow.textContent()) ?? '').trim();
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: `Word: ${label}` }).last().click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${label}.docx`);
  await page.screenshot({ path: testInfo.outputPath('projects-other-member.png') });
});
