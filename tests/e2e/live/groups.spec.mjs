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
  // Closed: posting mode and history are not on the form.
  await expect(chats.getByText('Who can post')).toHaveCount(0);
  await expect(chats.getByText('Chat history for people added later')).toHaveCount(0);

  await toggle.click();
  await expect(chats.getByText('Who can post')).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Everyone', exact: true })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Admins only', exact: true })).toBeVisible();
  await expect(chats.getByText('Chat history for people added later')).toBeVisible();

  await toggle.click();
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

  // Both accepted contacts are offered without searching for them; each row is
  // a checkbox, because picking people is choosing, not navigating.
  for (const person of [liveWorkspace.friend, liveWorkspace.third]) {
    await expect(chats.getByRole('checkbox', { name: `Add ${person.displayName}` })).toBeVisible();
  }

  // Picking someone flips the row from adding to removing, and the count follows.
  await chats.getByRole('checkbox', { name: `Add ${liveWorkspace.friend.displayName}` }).click();
  await expect(chats.getByText('1 selected')).toBeVisible();
  await expect(
    chats.getByRole('checkbox', { name: `Remove ${liveWorkspace.friend.displayName}` }),
  ).toBeVisible();
  await expect(
    chats.getByRole('checkbox', { name: `Add ${liveWorkspace.friend.displayName}` }),
  ).toHaveCount(0);
});
