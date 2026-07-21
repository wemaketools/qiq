import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loginAsPersona } from '../helpers/personas';

/**
 * Accessibility gold-standard suite (spec NFR-03, AC-069, V-069, T-042). Runs axe-core (WCAG 2.1 A/AA
 * rule tags) against the five key screens — Executive Overview, Leads list, Lead detail, the New Lead
 * intake form, and the Alerts center — in BOTH the light and dark themes, and fails on any violation
 * of `impact: 'critical'`. Also asserts the color-is-never-the-only-signal rule directly: every
 * status chip carries visible text, not just a palette color.
 *
 * Persona: Sales Head (`sales.manager@quoteiq.local`) — holds leads.view_all + all five dashboards +
 * alerts.view, so every one of the five screens renders fully populated from the T-041 seed (an empty
 * screen would hide exactly the components whose accessibility this gate must check).
 *
 * ---------------------------------------------------------------------------------------------------
 * STATUS: committed real body, kept `test.describe.fixme` (see demo-journey.spec.ts' header). Requires
 * the live compose stack + both seed scripts, unavailable while authoring. `@axe-core/playwright`
 * (MIT) is now a devDependency of e2e_tests/package.json. Un-fixme once CI stands up the stack.
 * ---------------------------------------------------------------------------------------------------
 */
type ThemeName = 'light' | 'dark';

async function setTheme(page: Page, theme: ThemeName): Promise<void> {
  // The theme is applied via html[data-theme] and persisted per user (NFR-04); set it directly so the
  // scan is deterministic regardless of the seeded default.
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator(`html[data-theme="${theme}"]`)).toHaveCount(1);
}

async function scanForCriticalViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const critical = results.violations.filter((violation) => violation.impact === 'critical');
  expect(
    critical,
    `Critical a11y violations:\n${critical.map((v) => `- ${v.id}: ${v.help} (${v.nodes.length} node(s))`).join('\n')}`,
  ).toEqual([]);
}

interface Screen {
  name: string;
  open: (page: Page) => Promise<void>;
}

const SCREENS: Screen[] = [
  {
    name: 'Executive Overview',
    open: async (page) => {
      await page.goto('/overview');
      await expect(page.getByTestId('kpi-row')).toBeVisible();
    },
  },
  {
    name: 'Leads list',
    open: async (page) => {
      await page.goto('/leads');
      await expect(page.getByTestId('leads-table')).toBeVisible();
    },
  },
  {
    name: 'Lead detail',
    open: async (page) => {
      await page.goto('/leads');
      await page.getByTestId('lead-row').first().click();
      await expect(page.getByTestId('lead-header')).toBeVisible();
    },
  },
  {
    name: 'New Lead intake form',
    open: async (page) => {
      await page.goto('/leads/new');
      await expect(page.getByTestId('lead-form')).toBeVisible();
    },
  },
  {
    name: 'Alerts center',
    open: async (page) => {
      await page.goto('/alerts');
      await expect(page.getByTestId('alert-category-card').first()).toBeVisible();
    },
  },
];

test.describe.fixme('accessibility WCAG 2.1 AA (V-069) — committed real body, pending live stack', () => {
  for (const screen of SCREENS) {
    for (const theme of ['light', 'dark'] as ThemeName[]) {
      test(`${screen.name} has zero critical axe violations in the ${theme} theme`, async ({ page }) => {
        await loginAsPersona(page, 'salesHead');
        await screen.open(page);
        await setTheme(page, theme);
        await scanForCriticalViolations(page);
      });
    }
  }

  test('status chips carry text, never color alone', async ({ page }) => {
    await loginAsPersona(page, 'salesHead');
    await page.goto('/leads');
    await expect(page.getByTestId('leads-table')).toBeVisible();

    const chips = page.getByTestId('status-chip');
    const count = await chips.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      await expect(chips.nth(i)).not.toHaveText('');
    }
  });
});
