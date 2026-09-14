import { expect, test } from '../support/live-fixtures.mjs';
import { signInThroughTheForm } from '../support/live-gateway.mjs';

test.describe.configure({ mode: 'serial' });

test('the person typing shows as a bubble with moving dots, and it goes when they stop', async ({
  chats,
  openPage,
  liveWorkspace,
}, testInfo) => {
  // Two real browsers on two real accounts: the friend types, the owner
  // watches. The owner was not sure the bubble ever showed for a peer on the
  // phone (Sep 14 2026); this is the same realtime path, end to end.
  await chats.getByRole('button', { name: new RegExp(`^${liveWorkspace.friend.displayName}:`) }).click();
  await expect(chats.getByTestId('composer-input')).toBeVisible();

  const friendPage = await openPage();
  await signInThroughTheForm(friendPage, liveWorkspace.friend);
  await friendPage.getByTestId('conversation-list').waitFor({ state: 'visible', timeout: 60_000 });
  await friendPage.getByRole('button', { name: /^Smoke owner:/ }).click();
  const composer = friendPage.getByTestId('composer-input');
  await composer.click();

  const typing = chats.getByLabel(`${liveWorkspace.friend.displayName} is typing…`, { exact: true });
  await expect(typing).toHaveCount(0);
  await friendPage.keyboard.type('typing something slowly so the dots are up', { delay: 120 });
  await expect(typing).toBeVisible({ timeout: 10_000 });
  await chats.screenshot({ path: testInfo.outputPath('typing-web.png') });

  // Once the friend stops, the bubble leaves within the local expiry.
  await expect(typing).toHaveCount(0, { timeout: 15_000 });

  // The bug's real trigger: the socket drops and comes back (a sleeping
  // laptop, a backgrounded app). Offline long enough for the heartbeat to
  // fail and the client to give up on the connection, then back online; the
  // channels rejoin with whatever token the socket holds. It used to be the
  // publishable key -- the server refused the rejoin and typing was gone for
  // good (Sep 14 2026). The bubble has to come back after the reconnect.
  await chats.context().setOffline(true);
  await chats.waitForTimeout(40_000);
  await chats.context().setOffline(false);
  await friendPage.keyboard.type(' and once more after the socket came back', { delay: 120 });
  await expect(typing).toBeVisible({ timeout: 25_000 });
  await chats.screenshot({ path: testInfo.outputPath('typing-after-reconnect.png') });
});
