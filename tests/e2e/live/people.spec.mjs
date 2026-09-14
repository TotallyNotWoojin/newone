import { expect, test } from '../support/live-fixtures.mjs';

test.describe.configure({ mode: 'serial' });

test('a friend is found by their exact email, and never by a piece of it', async ({ chats, liveWorkspace }) => {
  // Put back on Sep 14 2026 (owner). Whole address only: a fragment must find
  // nobody, or the member list could be walked one letter at a time.
  await chats.goto('/people');
  await chats.getByRole('button', { name: 'Add a friend', exact: true }).click();
  const field = chats.getByTestId('add-friend-search');
  await field.click();
  // The contacts list behind the sheet already names the friend, so only the
  // sheet's own results count.
  const results = chats.getByTestId('add-friend-results');
  await chats.keyboard.type(liveWorkspace.friend.email);
  await expect(results.getByText(liveWorkspace.friend.displayName)).toBeVisible({ timeout: 15_000 });

  await field.fill('');
  await chats.keyboard.type(liveWorkspace.friend.email.slice(0, -3));
  await expect(chats.getByTestId('add-friend-empty')).toBeVisible({ timeout: 15_000 });
  await expect(results).toHaveCount(0);
});
