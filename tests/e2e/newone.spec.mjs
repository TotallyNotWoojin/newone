import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { openSettings } from './helpers.mjs';

async function openDemo(page) {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: /open the fictional local product demo/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/fictional local product demo/i).first()).toBeVisible();
}

test('uses an independent company-scoped sign-in surface', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByText('Sign in to your workplace')).toBeVisible();
  await expect(page.getByRole('button', { name: 'First-time enrollment' })).toBeVisible();
  await expect(page.getByLabel('Company email')).toBeVisible();
  await expect(page.getByText(/work data belong only to your company/i)).toBeVisible();
  await expect(page.getByText(/ChatGPT/i)).toHaveCount(0);
});

test('requires a verified security challenge before requesting a one-time code', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Company email').fill('employee@example.com');
  await page.getByRole('button', { name: 'Continue securely' }).click();
  await expect(page.getByText(/Complete the security challenge before continuing/i)).toBeVisible();
  await expect(page.getByLabel('One-time verification code')).toHaveCount(0);
});

test('navigates the complete employee information architecture', async ({ page }) => {
  await openDemo(page);

  for (const destination of [
    ['People', /\/people$/],
    ['Updates', /\/updates$/],
    ['Handoffs', /\/handoffs$/],
    ['Chats', /\/$/],
  ]) {
    await page.getByRole('button', { name: new RegExp(`${destination[0]}$`) }).first().click();
    await expect(page).toHaveURL(destination[1]);
  }
});

test('sends an original message through the demo outbox', async ({ page }) => {
  await openDemo(page);
  const composer = page.getByPlaceholder('Write a message…');
  if (!(await composer.isVisible())) {
    await page.getByText('Packaging · Night shift', { exact: true }).click();
  }
  await expect(composer).toBeVisible();
  const text = `Synthetic reconnect test ${Date.now()} B-14 5 bar`;
  await composer.fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
});

test('changes product language without hiding originals', async ({ page }) => {
  await openDemo(page);
  await openSettings(page);
  await page.getByRole('button', { name: 'Display language: 한국어', exact: true }).click();
  await expect(page.getByRole('button', { name: '설정 닫기' })).toBeVisible();
  await expect(page.getByText(/모든 사람의 원문은 계속 확인할 수 있습니다/)).toBeVisible();
});

test('has no serious or critical automated accessibility violations', async ({ page }) => {
  await openDemo(page);
  const results = await new AxeBuilder({ page }).analyze();
  const severe = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(severe, JSON.stringify(severe, null, 2)).toEqual([]);
});
