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
  const suggestion = chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}`) });
  await expect(suggestion.first()).toBeVisible();
  await expect(chats.getByText('People', { exact: true })).toBeVisible();

  // Tapping a person turns them into a chip and writes the comma, so the next
  // name can follow; the visible field is left holding only the unfinished tail.
  await suggestion.first().click();
  const chip = chats.getByRole('button', { name: `Remove ${liveWorkspace.friend.displayName}` });
  await expect(chip).toBeVisible();
  await expect(field).toHaveValue('');

  // A second name typed after the comma behaves the same way.
  await field.fill(liveWorkspace.third.displayName);
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.third.displayName}`) }).first().click();
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

  const menu = chats.getByRole('dialog').filter({ hasText: 'New' }).last();
  await expect(chats.getByRole('button', { name: 'Add a friend' })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'New group' })).toBeVisible();
  await expect(menu.getByRole('button')).toHaveCount(3); // the two rows plus Close

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

test('the Pinned view gathers what was pinned, in the chat and across chats', async ({
  chats,
  liveWorkspace,
}) => {
  // Across every chat, from the Chats header.
  await chats.getByRole('button', { name: 'Open pinned messages' }).click();
  await expect(chats.getByText('Pinned messages')).toBeVisible();
  await expect(chats.getByText(liveWorkspace.pinnedBody)).toBeVisible();
  await expect(chats.getByText('Pin a message and it shows up here')).toHaveCount(0);
  await chats.getByRole('button', { name: 'Close dialog' }).last().click();

  // And for one chat, from its own settings.
  await openTheFriendChat(chats, liveWorkspace);
  await chats.getByRole('button', { name: 'Conversation settings' }).click();
  await chats.getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(chats.getByText('Pinned messages')).toBeVisible();
  await expect(chats.getByText(liveWorkspace.pinnedBody)).toBeVisible();
});

test('Photos and files opens the shared-media view for the chat', async ({ chats, liveWorkspace }) => {
  await openTheFriendChat(chats, liveWorkspace);
  await chats.getByRole('button', { name: 'Conversation settings' }).click();
  await chats.getByRole('button', { name: 'Photos and files', exact: true }).click();

  const dialog = chats.getByRole('dialog').filter({ hasText: 'Photos and files' }).last();
  await expect(dialog).toBeVisible();
  // This chat has carried only text, so the grid is honestly empty. A grid with
  // tiles in it, and the arrow-key stepping through them, needs a real upload
  // and a scan pass — see docs/WEB.md for what that leaves uncovered.
  await expect(chats.getByText('Nothing shared yet')).toBeVisible();
  await expect(chats.getByTestId('shared-media-tile')).toHaveCount(0);
});
