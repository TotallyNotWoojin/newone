import { expect, test } from '@playwright/test';

// These checks cover only the exported, unauthenticated sign-in surface. They
// are not hosted authentication, employee-workflow, or release-acceptance proof.

test('static sign-in surface separates returning, first-use invitation, and recovery modes', async ({ page }) => {
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

test('static sign-in surface is company-scoped and does not present ChatGPT identity', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByText('Sign in to your workplace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'First-time enrollment' })).toBeVisible();
  await expect(page.getByLabel('Company email')).toBeVisible();
  await expect(page.getByText(/work data belong only to your company/i)).toBeVisible();
  await expect(page.getByText(/ChatGPT/i)).toHaveCount(0);
});

test('static sign-in validation does not advance without the security challenge', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Company email').fill('employee@example.com');
  await page.getByRole('button', { name: 'Continue securely' }).click();
  await expect(page.getByText(/Complete the security challenge before continuing/i)).toBeVisible();
  await expect(page.getByLabel('One-time verification code')).toHaveCount(0);
});
