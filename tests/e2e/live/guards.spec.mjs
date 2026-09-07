import { expect, test } from '../support/live-fixtures.mjs';

// Every route is a file on a static host, so a consumer can type the two
// workplace ones. They must turn them away rather than render an empty
// workplace surface.

test.describe.configure({ mode: 'serial' });

for (const path of ['/updates', '/handoffs']) {
  test(`${path} turns a consumer back to Chats`, async ({ chats }) => {
    await chats.goto(path);
    await chats.waitForURL((url) => url.pathname === '/', { timeout: 30_000 });
    await expect(chats.getByTestId('conversation-list')).toBeVisible();
    // Nothing workplace-shaped was drawn on the way past.
    await expect(chats.locator('body')).not.toContainText('Company communications');
    await expect(chats.locator('body')).not.toContainText('Shift continuity');
  });
}

test('the navigation a consumer sees is Chats, Contacts and Settings', async ({ chats }) => {
  await expect(chats.getByRole('button', { name: 'Chats' })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Contacts' })).toBeVisible();
  await expect(chats.getByRole('button', { name: 'Open settings' })).toBeVisible();
  // The Search tab was folded into the field on Chats.
  await expect(chats.getByRole('button', { name: 'Search', exact: true })).toHaveCount(0);
  await expect(chats.getByRole('button', { name: 'Updates' })).toHaveCount(0);
  await expect(chats.getByRole('button', { name: 'Handoffs' })).toHaveCount(0);
});
