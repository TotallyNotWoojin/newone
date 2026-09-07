import { expect, test } from '../support/live-fixtures.mjs';

// The half of the sign-in flow that needs the gateway: the email is looked up,
// and only then is a password asked for. Everything the static bundle can show
// on its own is in tests/e2e/auth.spec.mjs.
//
// Each lookup here spends part of the gateway's rate-limit budget, so this
// file deliberately makes only two.

test('email, then password, with a way to the forgotten one and back to the email', async ({
  liveWorkspace,
  openPage,
}) => {
  const page = await openPage();
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByTestId('sign-in-destination').fill(liveWorkspace.owner.email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page.getByText('Enter your password to continue.')).toBeVisible();
  await expect(page.getByTestId('password')).toBeVisible();
  // The email that was looked up stays on screen, with both ways out.
  await expect(page.getByText(liveWorkspace.owner.email)).toBeVisible();
  await expect(page.getByText('Forgot password?')).toBeVisible();
  await expect(page.getByTestId('forgot-password')).toBeVisible();
  await expect(page.getByTestId('different-email')).toBeVisible();

  await page.getByTestId('password').fill('definitely-not-the-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('That email or password is incorrect.')).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByTestId('password').fill(liveWorkspace.owner.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 60_000 });
  await expect(page.getByTestId('conversation-list')).toBeVisible();
});

test('an email with no account is told so, and offered the way to make one', async ({ openPage }) => {
  const page = await openPage();
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByTestId('sign-in-destination').fill(`nobody-${Date.now()}@example.test`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page.getByText('There’s no account with that email.')).toBeVisible();
  await expect(page.getByTestId('create-account-shortcut')).toBeVisible();
  await expect(page.getByTestId('password')).toHaveCount(0);
});
