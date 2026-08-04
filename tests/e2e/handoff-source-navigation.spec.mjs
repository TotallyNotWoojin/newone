import { expect, test } from '@playwright/test';

import { navigateTo, openDemo } from './helpers.mjs';

test('opens an exact handoff source message through an authorized conversation route', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'Handoffs', /\/handoffs$/);

  await page.getByRole('button', { name: 'Open source message: Daniel Ruiz' }).click();

  await expect(page).toHaveURL(/\/conversation\/conv-packaging-night.*messageId=msg-p-1/);
  await expect(
    page.getByText('La línea 3 se detuvo por una lectura irregular del sensor.').last(),
  ).toBeVisible();
});
