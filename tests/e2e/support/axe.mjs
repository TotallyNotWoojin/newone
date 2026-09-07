import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BLOCKING = new Set(['serious', 'critical']);

/**
 * Runs axe over the current page and fails on anything axe calls serious or
 * critical. Minor and moderate findings are reported in the attachment so a
 * regression is visible without turning every cosmetic nit into a red run.
 */
export async function expectNoSeriousAccessibilityViolations(page, testInfo, label) {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  await testInfo.attach(`axe-${label}.json`, {
    body: JSON.stringify(
      results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      })),
      null,
      2,
    ),
    contentType: 'application/json',
  });
  const blocking = results.violations.filter((violation) => BLOCKING.has(violation.impact ?? ''));
  expect(
    blocking.map((violation) => `${violation.impact} ${violation.id} (${violation.nodes.length}): ${violation.help}`),
    `serious or critical accessibility violations on ${label}`,
  ).toEqual([]);
}
