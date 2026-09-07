import { expect, test } from '@playwright/test';

// The exported, unauthenticated sign-in surface. Everything asserted here
// renders from the static bundle alone, so this file needs no backend.
//
// v3.2 replaced the workplace sign-in with a consumer one: two modes (create
// an account, sign in), email first, then a password. The password step and
// the "Forgot password?" link that lives on it need an account lookup from the
// gateway, so they are covered by tests/e2e/live/sign-in.spec.mjs instead.

const WORKPLACE_WORDS = [
  'Sign in to your workplace',
  'First-time enrollment',
  'Company email',
  'Employee code',
  'Activate your workplace account',
];

test.beforeEach(async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeVisible();
});

test('opens on create-account, asking for an email, a username, a name and a password', async ({ page }) => {
  await expect(page.getByText('Create your account')).toBeVisible();
  await expect(page.getByText('Pick a username, then verify your email.')).toBeVisible();

  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveAttribute('placeholder', 'you@example.com');
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Display name')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
});

test('switches between create-account and sign-in, and sign-in asks only for the email', async ({ page }) => {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  await expect(page.getByText('Sign in to your account')).toBeVisible();
  await expect(page.getByText('Enter the email you signed up with.')).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
  // A returning member gives the email and nothing else; the password is asked
  // for on the next step, once the account is known.
  await expect(page.getByLabel('Username')).toHaveCount(0);
  await expect(page.getByLabel('Display name')).toHaveCount(0);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByText('Create your account')).toBeVisible();
});

test('offers no phone option anywhere on the surface', async ({ page }) => {
  for (const mode of ['Create account', 'Sign in']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Phone', exact: true })).toHaveCount(0);
    await expect(page.getByLabel(/phone/i)).toHaveCount(0);
    await expect(page.getByText(/phone number/i)).toHaveCount(0);
    await expect(page.getByPlaceholder('+52 81 5555 0192')).toHaveCount(0);
  }
});

test('says nothing about workplaces, companies or employees', async ({ page }) => {
  const surface = page.locator('body');
  for (const mode of ['Create account', 'Sign in']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    for (const word of WORKPLACE_WORDS) {
      await expect(surface).not.toContainText(word);
    }
    await expect(surface).not.toContainText(/your company/i);
    await expect(surface).not.toContainText(/ChatGPT/i);
  }
});

test('refuses an address that is not an email before any code is sent', async ({ page }) => {
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByTestId('sign-in-destination').fill('not-an-email');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  await expect(page.getByLabel('One-time verification code')).toHaveCount(0);
  await expect(page.getByTestId('password')).toHaveCount(0);
});

test('carries the three interface languages and a way to ask for help', async ({ page }) => {
  for (const language of ['English', 'Español', '한국어']) {
    await expect(page.getByRole('button', { name: language, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '한국어', exact: true }).click();
  await expect(page.getByText('사용자 이름을 정하고 이메일을 인증하세요.')).toBeVisible();
  await page.getByRole('button', { name: 'Español', exact: true }).click();
  await expect(page.getByText('Elige un nombre de usuario y verifica tu correo.')).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByText('Create your account')).toBeVisible();

  await expect(page.getByText('Need help signing in or recovering access?')).toBeVisible();
});
