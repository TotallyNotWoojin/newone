import { expect, test } from '@playwright/test';

import {
  expectNoSevereAxeViolations,
  navigateTo,
  openDemo,
  openSettings,
} from './helpers.mjs';

test('major employee surfaces and responsive navigation have no serious or critical axe violations', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await openDemo(page);

  const mobile = testInfo.project.name.includes('mobile');
  await expect(page.getByRole('button', { name: 'Chats', exact: true }).first()).toBeVisible();
  if (mobile) {
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeVisible();
  }
  await expectNoSevereAxeViolations(page, 'Chats');

  for (const [label, path, context] of [
    ['People', /\/people$/, 'People'],
    ['Search', /\/search$/, 'Search'],
    ['Updates', /\/updates$/, 'Updates'],
    ['Handoffs', /\/handoffs$/, 'Handoffs'],
  ]) {
    await navigateTo(page, label, path);
    await expectNoSevereAxeViolations(page, context);
  }

  await openSettings(page);
  await expect(page.getByRole('button', { name: 'Close settings' })).toBeVisible();
  await expectNoSevereAxeViolations(page, 'Settings');
});
