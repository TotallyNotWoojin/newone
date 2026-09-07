import { expect, test } from '../support/live-fixtures.mjs';

// Group creation on one screen: three optional things at the top, everything
// else folded away, and the three-person rule said on the form.

test.describe.configure({ mode: 'serial' });

test('the form asks for a name, a description and a photo, all marked optional', async ({ chats }) => {
  await chats.goto('/new-group');
  await expect(chats.getByText('Create a group')).toBeVisible();

  await expect(chats.getByLabel('Group name (optional)')).toBeVisible();
  await expect(chats.getByLabel('Description (optional)')).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Add a photo (optional)' })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Create', exact: true })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Cancel group creation' })).toBeVisible();
});

test('everything else is folded into Advanced options, closed and summarised', async ({ chats }) => {
  await chats.goto('/new-group');
  const toggle = chats.getByRole('button', { name: 'Advanced options' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Closed, it still says what it holds.
  await expect(chats.getByText('Who can post')).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(chats.getByText('Who can post')).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Everyone', exact: true })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Admins only', exact: true })).toBeVisible();
  await expect(chats.getByText('Chat history for people added later')).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(chats.getByText('Who can post')).toHaveCount(0);
});

test('the three-person rule is stated, and the picker separates contacts from everyone', async ({
  chats,
  liveWorkspace,
}) => {
  await chats.goto('/new-group');
  await expect(chats.getByText('A group needs three people — you and two others.')).toBeVisible();

  await expect(chats.getByText('Your contacts')).toBeVisible();
  await expect(chats.getByText('Search everyone')).toBeVisible();

  // Both accepted contacts are offered without searching for them.
  for (const person of [liveWorkspace.friend, liveWorkspace.third]) {
    await expect(chats.getByRole('button', { name: `Add ${person.displayName}` })).toBeVisible();
  }

  await chats.getByRole('button', { name: `Add ${liveWorkspace.friend.displayName}` }).click();
  await expect(chats.getByText('1 selected')).toBeVisible();
  await expect(chats.getByRole('button', { name: `Remove ${liveWorkspace.friend.displayName}` })).toBeVisible();
});
