import { expect, test } from '../support/live-fixtures.mjs';

// What a signed-in consumer is offered. The workplace routes used to be
// guarded here, turning a typed URL back to Chats; the removal of Sep 10 2026
// deleted the route files outright, so there is no page left to redirect and
// the static routes.spec pins them at a 404 instead. What remains live is the
// navigation itself, which needs an account to see.

test.describe.configure({ mode: 'serial' });

test('the navigation a consumer sees is Chats, Contacts and Settings', async ({ chats }) => {
  await expect(chats.getByRole('button', { name: 'Chats' })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Contacts' })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Open settings' })).toBeVisible();
  // The Search tab was folded into the field on Chats.
  await expect(chats.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
  await expect(chats.getByRole('button', { name: 'Updates' })).toHaveCount(0);
  await expect(chats.getByRole('button', { name: 'Handoffs' })).toHaveCount(0);
});
