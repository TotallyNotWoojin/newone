import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

export async function openDemo(page) {
  await page.goto('/sign-in');
  await page.getByRole('button', { name: /open the fictional local product demo/i }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText(/fictional local product demo/i).first()).toBeVisible();
}

export async function navigateTo(page, label, pathPattern) {
  const controls = page.getByRole('button', { name: new RegExp(`^${label}(?: tab)?$`, 'i') });
  const mobile = (page.viewportSize()?.width ?? 1_024) < 768;
  await (mobile ? controls.last() : controls.first()).click();
  await expect(page).toHaveURL(pathPattern);
}

export async function openSettings(page) {
  const mobile = (page.viewportSize()?.width ?? 1_024) < 768;
  if (mobile) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/settings$/);
}

export async function openConversation(page, title) {
  const composer = page.getByPlaceholder('Write a message…');
  if (!(await composer.isVisible().catch(() => false))) {
    const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page.getByRole('button', { name: new RegExp(escapedTitle) }).first().click();
  }
  await expect(composer).toBeVisible();
  return composer;
}

export async function longPress(locator, page) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Cannot long-press a message without a visible bounding box.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(650);
  await page.mouse.up();
}

export async function expectNoSevereAxeViolations(page, context) {
  const results = await new AxeBuilder({ page }).analyze();
  const severe = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(severe, `${context}: ${JSON.stringify(severe, null, 2)}`).toEqual([]);
}
