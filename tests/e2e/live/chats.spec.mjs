import { expect, test } from '../support/live-fixtures.mjs';

// The signed-in desktop Chats screen: the one search field, the "+" menu, the
// message actions a mouse gets instead of a swipe and a long press, and the
// two views that gather what a chat holds.

test.describe.configure({ mode: 'serial' });

async function openTheFriendChat(page, liveWorkspace) {
  await page.getByRole('button', { name: liveWorkspace.friend.displayName, exact: true }).click();
  const pane = page.getByTestId('keyboard-avoiding-screen');
  await expect(pane.getByText(liveWorkspace.hoverBody)).toBeVisible();
  return pane;
}

test('one field searches, a person becomes a chip, and the chip clears in one tap', async ({
  chats,
  liveWorkspace,
}) => {
  const field = chats.getByTestId('chat-search-field');
  await expect(field).toHaveAttribute('placeholder', 'Search chats, people and messages');

  await field.fill(liveWorkspace.friend.displayName);
  // The suggestions sit under the field, people first.
  const suggestions = chats.getByRole('list');
  const suggestion = suggestions.getByRole('button', {
    name: new RegExp(`^${liveWorkspace.friend.displayName}`),
  });
  await expect(suggestion.first()).toBeVisible();
  await expect(suggestions.getByText('People', { exact: true })).toBeVisible();

  // Tapping a person turns them into a chip and writes the comma, so the next
  // name can follow; the visible field is left holding only the unfinished tail.
  await suggestion.first().click();
  const chip = chats.getByRole('button', { name: `Remove ${liveWorkspace.friend.displayName}` });
  await expect(chip).toBeVisible();
  await expect(field).toHaveValue('');

  // A second name typed after the comma behaves the same way.
  await field.fill(liveWorkspace.third.displayName);
  await suggestions.getByRole('button', { name: new RegExp(`^${liveWorkspace.third.displayName}`) })
    .first().click();
  await expect(chats.getByRole('button', { name: `Remove ${liveWorkspace.third.displayName}` })).toBeVisible();
  await expect(chip).toBeVisible();

  // One tap clears a chip and leaves the other one alone.
  await chip.click();
  await expect(chip).toHaveCount(0);
  await expect(chats.getByRole('button', { name: `Remove ${liveWorkspace.third.displayName}` })).toBeVisible();
});

test('a name typed with its own comma makes the same chip', async ({ chats, liveWorkspace }) => {
  const field = chats.getByTestId('chat-search-field');
  await field.fill(`${liveWorkspace.friend.displayName}, `);
  await expect(chats.getByRole('button', { name: `Remove ${liveWorkspace.friend.displayName}` })).toBeVisible();
  await chats.getByRole('button', { name: 'Clear search' }).click();
  await expect(chats.getByRole('button', { name: `Remove ${liveWorkspace.friend.displayName}` })).toHaveCount(0);
});

test('the "+" menu holds two rows and nothing else', async ({ chats }) => {
  await chats.getByRole('button', { name: 'New', exact: true }).click();

  const menu = chats.locator('[aria-modal="true"]').last();
  await expect(menu.getByRole('button', { name: 'Add a friend' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'New group' })).toBeVisible();
  // Two rows and nothing else: the only other controls are the sheet's own two
  // ways to close it (the header button and the backdrop).
  await expect(menu.getByRole('button', { name: 'Close dialog' })).toHaveCount(2);
  await expect(menu.getByRole('button')).toHaveCount(4);

  await chats.getByRole('button', { name: 'New group' }).click();
  await chats.waitForURL((url) => url.pathname === '/new-group', { timeout: 30_000 });
});

test('hovering a message reveals its Reply, and right-clicking opens the actions', async ({
  chats,
  liveWorkspace,
}) => {
  const pane = await openTheFriendChat(chats, liveWorkspace);
  const bubble = pane.getByText(liveWorkspace.hoverBody);

  // Nothing is revealed until a pointer is over the row.
  await expect(chats.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
  await bubble.hover();
  await expect(chats.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(1);

  // Right-click is the mouse's long press: the same sheet, not the browser's menu.
  await bubble.click({ button: 'right' });
  await expect(chats.getByText('Message actions')).toBeVisible();
  for (const emoji of ['👍', '❤️', '😂', '😮', '😢', '🙏']) {
    await expect(chats.getByRole('button', { name: `React ${emoji}` })).toBeVisible();
  }
  await expect(chats.getByRole('button', { name: 'More emoji' })).toBeVisible();
  for (const action of ['Reply', 'Copy', 'Pin', 'Forward']) {
    await expect(chats.getByRole('button', { name: action, exact: true })).toBeVisible();
  }
  // The message is the signed-in member's own, so it can still be taken back.
  await expect(chats.getByRole('button', { name: 'Delete for everyone' })).toBeVisible();
  // Nothing workplace-shaped is offered to a consumer.
  await expect(chats.getByRole('button', { name: /review/i })).toHaveCount(0);
  await expect(chats.getByRole('button', { name: /Delete for me/i })).toHaveCount(0);

  await chats.getByRole('button', { name: 'Close dialog' }).last().click();
  await expect(chats.getByText('Message actions')).toHaveCount(0);
});

/**
 * The rows themselves cannot be asserted yet: the deployed `newone-read` is the
 * version from 2026-09-05, which predates the pins-and-media reads in
 * supabase/functions/newone-read/handler.ts, so `/v2/pins/query` and
 * `/v2/conversations/<id>/media/query` both answer 404 on the hosted project —
 * on native as well as on the web. What can be asserted now is that the views
 * open and that the app asks the right function; a second, deliberately failing
 * test records what is still missing.
 */
function readRequests(page, pattern) {
  const seen = [];
  page.on('request', (request) => {
    if (pattern.test(request.url())) seen.push(request.url());
  });
  return seen;
}

test('the Pinned view opens from Chats and from a chat, and asks the read function', async ({
  chats,
  liveWorkspace,
}) => {
  // Across every chat the sheet is titled "Pinned messages"; one chat's own is
  // titled "Pinned".
  const everyChat = chats.getByRole('heading', { name: 'Pinned messages' });
  const oneChat = chats.getByRole('heading', { name: 'Pinned', exact: true });
  const pinReads = readRequests(chats, /\/v2\/pins\/query$/);

  // Across every chat, from the Chats header.
  await chats.getByRole('button', { name: 'Open pinned messages' }).click();
  await expect(everyChat).toBeVisible();
  await expect.poll(() => pinReads.length).toBeGreaterThan(0);
  await chats.getByRole('button', { name: 'Close dialog' }).last().click();
  await expect(everyChat).toHaveCount(0);

  // And for one chat, from its own settings.
  await openTheFriendChat(chats, liveWorkspace);
  await chats.getByRole('button', { name: 'Conversation settings' }).click();
  await chats.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(oneChat).toBeVisible();
  await expect.poll(() => pinReads.length).toBeGreaterThan(1);

  // Pins are a read, so they belong to newone-read; routing them to the command
  // function is what made this view answer 404 (fixed in api-routing.mjs).
  for (const url of pinReads) expect(url).toContain('/functions/v1/newone-read/');
});

test.fixme('the Pinned view lists the message that was pinned', async ({ chats, liveWorkspace }) => {
  // Blocked on deploying newone-read (and migration 20260908050000). Until then
  // /v2/pins/query answers 404 and the view shows its empty state instead.
  await chats.getByRole('button', { name: 'Open pinned messages' }).click();
  const sheet = chats.locator('[aria-modal="true"]').last();
  await expect(sheet.getByText(liveWorkspace.pinnedBody)).toBeVisible();
  await expect(chats.getByText('Pin a message and it shows up here')).toHaveCount(0);
});

test('Photos and files opens and asks the read function for the chat’s media', async ({
  chats,
  liveWorkspace,
}) => {
  const mediaReads = readRequests(chats, /\/media\/query$/);
  await openTheFriendChat(chats, liveWorkspace);
  await chats.getByRole('button', { name: 'Conversation settings' }).click();
  await chats.getByRole('button', { name: 'Photos and files', exact: true }).click();

  await expect(chats.getByRole('heading', { name: 'Photos and files' })).toBeVisible();
  await expect.poll(() => mediaReads.length).toBeGreaterThan(0);
  for (const url of mediaReads) expect(url).toContain('/functions/v1/newone-read/');
  // No tiles: this chat has carried only text, and the deployed read answers 404
  // anyway. A populated grid, and the arrow-key stepping through it, needs a
  // real upload and a scan pass — see docs/WEB.md.
  await expect(chats.getByTestId('shared-media-tile')).toHaveCount(0);
});
