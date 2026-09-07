import { expect, test } from '@playwright/test';

import { expectNoSeriousAccessibilityViolations } from './support/axe.mjs';

// axe over the screens a signed-out visitor can reach, in both colour schemes.
// Serious and critical findings fail the run; the full list is attached.

for (const scheme of ['light', 'dark']) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('sign-in, creating an account', async ({ page }, testInfo) => {
      await page.goto('/sign-in');
      await expect(page.getByText('Create your account')).toBeVisible();
      await expectNoSeriousAccessibilityViolations(page, testInfo, `sign-in-signup-${scheme}`);
    });

    test('sign-in, returning', async ({ page }, testInfo) => {
      await page.goto('/sign-in');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Sign in to your account')).toBeVisible();
      await expectNoSeriousAccessibilityViolations(page, testInfo, `sign-in-returning-${scheme}`);
    });

    test('help and recovery', async ({ page }, testInfo) => {
      await page.goto('/help');
      await expect(page.getByText('Help and recovery')).toBeVisible();
      await expectNoSeriousAccessibilityViolations(page, testInfo, `help-${scheme}`);
    });
  });
}
