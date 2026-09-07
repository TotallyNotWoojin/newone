import { expectNoSeriousAccessibilityViolations } from '../support/axe.mjs';
import { expect, test } from '../support/live-fixtures.mjs';

// axe over the signed-in screens, in both colour schemes.

test.describe.configure({ mode: 'serial' });

for (const scheme of ['light', 'dark']) {
  test(`Chats, with a chat open, in ${scheme}`, async ({ chats, liveWorkspace }, testInfo) => {
    await chats.emulateMedia({ colorScheme: scheme });
    await chats.getByRole('button', { name: liveWorkspace.friend.displayName, exact: true }).click();
    await expect(
      chats.getByTestId('keyboard-avoiding-screen').getByText(liveWorkspace.hoverBody),
    ).toBeVisible();
    await expectNoSeriousAccessibilityViolations(chats, testInfo, `chats-${scheme}`);
  });

  test(`Contacts in ${scheme}`, async ({ chats }, testInfo) => {
    await chats.emulateMedia({ colorScheme: scheme });
    await chats.getByRole('button', { name: 'Contacts' }).click();
    await chats.waitForURL((url) => url.pathname === '/people', { timeout: 30_000 });
    await expectNoSeriousAccessibilityViolations(chats, testInfo, `contacts-${scheme}`);
  });

  test(`Creating a group in ${scheme}`, async ({ chats }, testInfo) => {
    await chats.emulateMedia({ colorScheme: scheme });
    await chats.goto('/new-group');
    await expect(chats.getByText('Create a group')).toBeVisible();
    await expectNoSeriousAccessibilityViolations(chats, testInfo, `new-group-${scheme}`);
  });
}
