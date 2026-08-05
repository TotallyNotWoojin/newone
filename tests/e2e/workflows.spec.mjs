import { expect, test } from '@playwright/test';

import {
  longPress,
  navigateTo,
  openConversation,
  openDemo,
  openSettings,
} from './helpers.mjs';

test('shows mixed direct, group, shift, and official chats with original-first multilingual messages', async ({ page }) => {
  await openDemo(page);
  for (const title of [
    'Packaging · Night shift',
    'Daniel Ruiz',
    'Safety · Plant 2',
    'Maintenance dispatch',
    'New starters · July',
  ]) await expect(page.getByRole('button', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first()).toBeVisible();

  await openConversation(page, 'Packaging · Night shift');
  await expect(page.getByText('La línea 3 se detuvo por una lectura irregular del sensor.', { exact: true })).toBeVisible();
  await expect(page.getByText('3번 라인이 센서 판독 이상으로 멈췄습니다.', { exact: true })).toBeVisible();
  await expect(page.getByText('센서 주변을 청소하고 다시 확인해 주세요. 안전 가드는 제거하지 마세요.', { exact: true })).toBeVisible();
  await expect(page.getByText(/ORIGINAL · ES/).first()).toBeVisible();
  await expect(page.getByText(/ORIGINAL · KO/).first()).toBeVisible();
  await expect(page.getByText(/TRANSLATION · KO/).first()).toBeVisible();
  await expect(page.getByText('Original is always preserved', { exact: true })).toBeVisible();
});

test('sends, reacts to, and replies to a server-confirmed demo message', async ({ page }) => {
  await openDemo(page);
  const composer = await openConversation(page, 'Packaging · Night shift');
  const original = `Fictional pressure check ${Date.now()}`;
  await composer.fill(original);
  await page.getByRole('button', { name: 'Send message' }).click();
  const sent = page.getByText(original, { exact: true });
  await expect(sent).toBeVisible();

  await longPress(sent, page);
  await expect(page.getByRole('heading', { name: 'Message actions' })).toBeVisible();
  await page.getByRole('button', { name: 'React 👍' }).click();
  await expect(page.getByText('👍', { exact: true }).last()).toBeVisible();

  await longPress(sent, page);
  await page.getByRole('button', { name: /Reply$/ }).click();
  await expect(page.getByText(/Replying to Woojin Lee/)).toBeVisible();
  const reply = `Fictional reply ${Date.now()}`;
  await composer.fill(reply);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(reply, { exact: true })).toBeVisible();
  await expect(page.getByText(original, { exact: true }).last()).toBeVisible();
});

test('creates a private group, sends an explicit mention, and completes eligible owner-transfer leave', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('button', { name: 'Start a conversation' }).click({ timeout: 8_000 });
  await expect(page.getByRole('heading', { name: 'Create a group' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose group photo' })).toBeVisible();
  await expect(page.getByText(/not shared until its secure scan succeeds/i)).toBeVisible();
  const groupName = `Fictional QA group ${Date.now()}`;
  await page.getByLabel('Group name').fill(groupName);
  await page.getByRole('checkbox', { name: 'Add Daniel Ruiz' }).click();
  await page.getByRole('checkbox', { name: 'Add Mina Park' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(groupName, { exact: true }).last()).toBeVisible();
  await expect(page.getByPlaceholder('Write a message…').last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Conversation settings' })).toBeVisible();

  await page.getByRole('button', { name: 'Mention people' }).click();
  await page.getByRole('checkbox', { name: /Daniel Ruiz/ }).click();
  await expect(page.getByLabel(/Selected: Daniel Ruiz/)).toBeVisible();
  const mentionedMessage = `Fictional tagged follow-up ${Date.now()}`;
  await page.getByPlaceholder('Write a message…').last().fill(mentionedMessage);
  await page.getByRole('button', { name: 'Send message' }).last().click();
  await expect(page.getByText(mentionedMessage, { exact: true }).last()).toBeVisible();
  await expect(page.getByLabel(/Mentioned: Daniel Ruiz/).last()).toBeVisible();

  await page.getByRole('button', { name: 'Conversation settings' }).click();
  await expect(page.getByText('Leave this group', { exact: true })).toBeVisible();
  await page.getByRole('radio', { name: /Daniel Ruiz/ }).click();
  await page.getByRole('checkbox', { name: /history is preserved and my future access ends/i }).click();
  await page.getByRole('button', { name: 'Leave group' }).click();
  await expect(page.getByText(groupName, { exact: true })).toHaveCount(0);
});

test('manages a fictional coworker connection request, saved contact, favorite, and block independently', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'People', /\/people$/);
  await page.getByPlaceholder('Search name, role, department, or site').fill('Luis Herrera');
  await expect(page.getByText('Luis Herrera', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Connect$/ }).click();
  await expect(page.getByRole('button', { name: /Cancel request$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Manage contact and privacy' }).click();
  await page.getByLabel('Private contact alias (optional)').fill('Fictional packaging contact');
  await page.getByRole('button', { name: 'Favorite contact' }).click();
  await page.getByRole('button', { name: 'Save contact' }).click();
  await page.getByRole('button', { name: 'Block this person' }).click();
  await expect(page.getByRole('button', { name: 'Unblock this person' })).toBeVisible();
});

test('unified search opens and focuses an exact authorized message', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'Search', /\/search$/);
  const search = page.getByPlaceholder('Search your workspace');
  await search.fill('lectura irregular');
  await search.press('Enter');
  const result = page.getByRole('button', { name: 'Open Daniel Ruiz' });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL((url) => (
    url.pathname === '/conversation/conv-packaging-night'
    && url.searchParams.get('messageId') === 'msg-p-1'
  ));
  await expect(page.getByText('La línea 3 se detuvo por una lectura irregular del sensor.', { exact: true }).last()).toBeVisible();
});

test('views and acknowledges an exact update version and exposes publisher controls', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'Updates', /\/updates$/);
  await expect(page.getByText('Safety guard verification · Line 3', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'I understand' }).first().click();
  await expect(page.getByRole('heading', { name: 'Acknowledge exact version' })).toBeVisible();
  await expect(page.getByText(/Version 1/).first()).toBeVisible();
  const attestation = page.getByRole('switch');
  await expect(attestation).toHaveCount(1);
  await attestation.click();
  await page.getByRole('button', { name: 'Acknowledge this version' }).click();
  await expect(page.getByText(/Acknowledgement recorded with attributable session evidence/)).toBeVisible();

  await expect(page.getByText('Publisher control center', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh publisher view' })).toBeVisible();
  await page.getByRole('button', { name: 'Create update' }).first().click();
  const title = `Fictional operations notice ${Date.now()}`;
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Message').fill('Fictional notice for automated demo validation only.');
  await page.getByRole('button', { name: 'Preview audience' }).click();
  await expect(page.getByText('Audience snapshot', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Publish update' }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
});

test('creates, corrects, and signs an exact source-linked handoff version', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'Handoffs', /\/handoffs$/);
  await page.getByRole('button', { name: 'Create handoff' }).first().click();
  const title = `Fictional shift handoff ${Date.now()}`;
  await page.getByLabel('Handoff title').fill(title);
  await page.getByLabel('Operational details').fill('Fictional Line 3 status with no operational authority.');
  await page.getByRole('checkbox').first().click();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Correct handoff' }).first().click();
  await expect(page.getByText('Exact version being corrected', { exact: true })).toBeVisible();
  await page.getByLabel('Correction reason').fill('Corrected fictional wording for the test record.');
  await page.getByRole('button', { name: 'Create corrected draft' }).click();
  await expect(page.getByText('Version 2', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Sign handoff' }).first().click();
  await expect(page.getByRole('button', { name: 'Sign handoff' })).toHaveCount(0);
});

test('acknowledges an incoming handoff through the exact-version discrepancy modal', async ({ page }) => {
  await openDemo(page);
  await navigateTo(page, 'Handoffs', /\/handoffs$/);
  const handoffCard = page.getByText('Packaging · Night to morning', { exact: true }).locator('..');
  const acknowledge = handoffCard.getByRole('button', { name: 'Acknowledge', exact: true });
  await expect(acknowledge).toBeVisible();
  await acknowledge.click();
  await expect(page.getByRole('heading', { name: 'Confirm handoff acknowledgement' })).toBeVisible();
  await page.getByLabel('Discrepancy note (optional)').fill('Fictional discrepancy for E2E validation.');
  await page.getByRole('button', { name: 'Acknowledge exact version' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm handoff acknowledgement' })).not.toBeVisible();
  await expect(handoffCard.getByText('Acknowledged', { exact: true })).toBeVisible();
  await expect(handoffCard.getByRole('button', { name: 'Acknowledge', exact: true })).toHaveCount(0);
});

test('exposes settings language, outbox, privacy, security, and session navigation', async ({ page }) => {
  await openDemo(page);
  await openSettings(page);
  for (const text of [
    'Language and translation',
    'Privacy and security',
    'Messages waiting to send',
    'Devices and sessions',
  ]) await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Display language: 한국어', exact: true }).click();
  await expect(page.getByRole('button', { name: '설정 닫기' })).toBeVisible();
  await expect(page.getByText(/모든 사람의 원문은 계속 확인할 수 있습니다/)).toBeVisible();
});

test('keeps attachment sending disabled until an allowed file is explicitly selected', async ({ page }) => {
  await openDemo(page);
  await openConversation(page, 'Packaging · Night shift');
  await page.getByRole('button', { name: 'Add attachment' }).click();
  await expect(page.getByRole('heading', { name: 'Add attachment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Photo library' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Camera' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose file' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send securely' })).toBeDisabled();
  await expect(page.getByText(/quarantined and scanned/i)).toBeVisible();
  await expect(page.getByText(/25 MB/).first()).toBeVisible();
});

test('shows scoped moderation consent and context controls when the demo fixture has reportable incoming content', async ({ page }) => {
  await openDemo(page);
  await openConversation(page, 'Packaging · Night shift');
  const incoming = page.getByText(
    'Este es un mensaje sintético para validar el reporte privado con consentimiento.',
    { exact: true },
  );
  await longPress(incoming, page);
  const report = page.getByText('Report privately', { exact: true });
  await expect(report).toBeVisible();
  await expect(page.getByText('Assigned evidence access', { exact: true })).toBeVisible();
  await expect(page.getByText('Share context before', { exact: true })).toBeVisible();
  await expect(page.getByText('Share context after', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '1 message' }).first().click();
  const consent = page.getByRole('checkbox', {
    name: 'I understand and consent to this limited disclosure.',
  });
  const submit = page.getByRole('button', { name: 'Submit report' });
  await expect(submit).toBeDisabled();
  await consent.click();
  await expect(submit).toBeEnabled();
});
