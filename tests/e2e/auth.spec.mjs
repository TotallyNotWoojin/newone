import { expect, test } from '@playwright/test';

import { navigateTo, openDemo } from './helpers.mjs';

test('independent auth surface separates returning, first-use invitation, and recovery modes', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByText('Sign in to your workplace')).toBeVisible();
  await page.getByRole('button', { name: 'First-time enrollment' }).click();
  await expect(page.getByLabel('Single-use invitation token')).toBeVisible();
  await expect(page.getByLabel('Employee code (when provided)')).toBeVisible();
  await page.getByRole('button', { name: 'Recover access' }).click();
  await expect(page.getByText(/immediately revokes every other active Newone session/i)).toBeVisible();
  await page.getByRole('button', { name: 'Phone', exact: true }).click();
  await expect(page.getByLabel('Verified work phone')).toBeVisible();
  await expect(page.getByPlaceholder('+52 81 5555 0192')).toBeVisible();
  await page.getByRole('button', { name: 'Email', exact: true }).click();
  await expect(page.getByLabel('Company email')).toBeVisible();
  await expect(page.getByText(/ChatGPT/i)).toHaveCount(0);
});

test('administrator can prepare a phone-bound invitation without claiming SMS delivery', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'Admin', /\/admin$/);
  await page.getByRole('button', { name: 'Invite member' }).click();
  await page.getByRole('button', { name: 'Phone', exact: true }).click();
  await expect(page.getByLabel('Exact verified phone')).toBeVisible();
  await expect(page.getByPlaceholder('+52 81 5555 0192')).toBeVisible();
  await expect(page.getByText(/never claims email or SMS delivery unless that provider is configured/i)).toBeVisible();
  await page.getByRole('button', { name: 'External guest' }).click();
  await expect(page.getByText(/External guests always join as members/)).toBeVisible();
  await expect(page.getByText(/active internal sponsor/)).toBeVisible();
  await expect(page.getByText('Guest sponsor', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Woojin Lee' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Luis Herrera' })).toHaveCount(0);
});

test('owner demo can save, preview, publish, and pause a dynamic group on desktop and mobile', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'Admin', /\/admin$/);
  await expect(page.getByTestId('dynamic-group-section')).toBeVisible();
  await page.getByRole('button', { name: 'New policy' }).click();
  await page.getByRole('button', { name: 'Maintenance dispatch' }).click();
  await page.getByRole('button', { name: 'Line · Line 3' }).click();
  await page.getByRole('button', { name: 'Manager', exact: true }).click();
  await page.getByLabel('Operational role text').fill('supervisor, quality lead');
  await page.getByRole('button', { name: 'Current shift' }).click();
  await page.getByLabel('Maximum members').fill('20');
  await page.getByRole('button', { name: 'Save draft & preview' }).click();

  await expect(page.getByTestId('dynamic-group-preview')).toBeVisible();
  await expect(page.getByText('Fresh membership preview')).toBeVisible();
  await expect(page.getByText(/Draft saved and previewed/)).toBeVisible();
  await page.getByRole('button', { name: 'Publish exact preview' }).click();
  await expect(page.getByText(/Automated membership is active/)).toBeVisible();
  const publishedPolicy = page.getByRole('button', {
    name: /^Maintenance dispatch, Version \d+$/,
  });
  await expect(publishedPolicy.getByText('Active', { exact: true })).toBeVisible();

  await page.getByLabel('Pause reason').fill('Roster source is under scheduled maintenance');
  await page.getByRole('button', { name: 'Pause policy' }).click();
  await expect(page.getByText(/Automated membership was paused/)).toBeVisible();
  await expect(publishedPolicy.getByText('Paused', { exact: true })).toBeVisible();
});
