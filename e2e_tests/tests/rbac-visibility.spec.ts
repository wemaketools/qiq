import { test, expect } from '@playwright/test';
import { loginAsPersona } from '../helpers/personas';
import { gotoAndExpectForbidden } from '../helpers/auth';

/**
 * RBAC visibility gold-standard suite (spec FR-16/FR-17, AC-015/AC-016, V-015/V-016, T-042) over the
 * T-041 seeded "The Brittany" personas. Complements the already-running role-403-sweep.spec.ts
 * (which proves every role lands 403-free and crawls its nav) by asserting the *negative* visibility
 * contract V-015/V-016 describe: admin nav entries appear only with permission, workflow actions
 * render only when both permitted and legal (hidden, not disabled), an assigned-only RM never sees
 * the whole tenant's leads, and a read-only executive viewer sees no workflow buttons at all.
 *
 * ---------------------------------------------------------------------------------------------------
 * STATUS: committed real body, kept `test.describe.fixme` (see demo-journey.spec.ts' header for the
 * full rationale). The live compose stack + both seed scripts are required and unavailable in the
 * authoring environment; un-fixme once CI stands them up. The seed provides every persona and the
 * assigned/unassigned lead mix these assertions need (SeedUsers.RoleBundles + SeedLeads).
 * ---------------------------------------------------------------------------------------------------
 */
test.describe.configure({ mode: 'serial' });

test.describe.fixme('RBAC visibility (V-015/V-016) — committed real body, pending live stack', () => {
  test('admin nav entries appear only with permission', async ({ page }) => {
    // A Tenant Admin sees the admin surfaces its bundle grants (Settings, User Manager) but NOT the
    // Internal-only Tenant Manager (no global.view_any_tenant).
    await loginAsPersona(page, 'tenantAdmin');
    await expect(page.getByTestId('nav-settings')).toBeVisible();
    await expect(page.getByTestId('nav-user-manager')).toBeVisible();
    await expect(page.getByTestId('nav-tenant-manager')).toHaveCount(0);
    await gotoAndExpectForbidden(page, '/admin/tenants');
  });

  test('a Relationship Manager sees no admin nav at all', async ({ page }) => {
    await loginAsPersona(page, 'relationshipManager');
    await expect(page.getByTestId('sidebar-nav')).toBeVisible();
    await expect(page.getByTestId('nav-settings')).toHaveCount(0);
    await expect(page.getByTestId('nav-user-manager')).toHaveCount(0);
    await expect(page.getByTestId('nav-tenant-manager')).toHaveCount(0);
    // Deep links to admin surfaces are Forbidden, not silently rendered.
    await gotoAndExpectForbidden(page, '/settings/business-rules');
    await gotoAndExpectForbidden(page, '/admin/users');
  });

  test('an Internal user can reach Tenant Manager; a Tenant Admin cannot', async ({ page }) => {
    await loginAsPersona(page, 'internal');
    await expect(page.getByTestId('nav-tenant-manager')).toBeVisible();
    await page.getByTestId('nav-tenant-manager').click();
    await expect(page.getByTestId('tenant-list')).toBeVisible();
  });

  test('an assigned-only RM sees only their own leads, never the whole tenant', async ({ page }) => {
    // Relationship Manager holds leads.view but NOT leads.view_all (SeedUsers.RoleBundles), so the
    // Leads list is scoped to their assignments. The seeded tenant has 300 leads; an assigned-only
    // member must never see anything close to that.
    await loginAsPersona(page, 'relationshipManager');
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);

    const summary = page.getByTestId('pagination-summary');
    if ((await summary.count()) > 0) {
      // The total in "1-25 of N" is far below the full seeded lead count.
      const text = (await summary.textContent()) ?? '';
      const total = Number(text.replace(/.*of\s+/i, '').replace(/[^\d]/g, ''));
      expect(total).toBeLessThan(300);
    }
  });

  test('workflow actions render only when legal; an executive viewer sees none', async ({ page }) => {
    // Executive Viewer's bundle is dashboards + reports + alerts.view ONLY — no leads/quotes write,
    // no workflow. Opening a lead from an alert row (the one lead surface it can reach) shows read-only
    // detail with no primary workflow action and no More-actions menu.
    await loginAsPersona(page, 'executiveViewer');
    await page.goto('/alerts');
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);

    if ((await page.getByTestId('alert-row').count()) > 0) {
      await page.getByTestId('alert-row').first().click();
      await expect(page).toHaveURL(/\/leads\/\d+/);
      await expect(page.getByTestId('primary-workflow-action')).toHaveCount(0);
      await expect(page.getByTestId('more-actions-trigger')).toHaveCount(0);
      await expect(page.getByTestId('new-quote-button')).toHaveCount(0);
    }
  });

  test('a New lead offers only its legal operations to a permitted RM (illegal ops absent)', async ({ page }) => {
    await loginAsPersona(page, 'relationshipManager');
    await page.goto('/leads');
    const newLead = page.getByTestId('lead-row').filter({ hasText: 'New' }).first();
    if ((await newLead.count()) === 0) {
      return;
    }
    await newLead.click();

    // From New, the only contextual primary action is Assign; Reopen / Approve pricing are illegal
    // and therefore absent (hidden, not disabled — FR-17).
    await expect(page.getByTestId('primary-workflow-action')).toHaveText('Assign');
    await page.getByTestId('more-actions-trigger').click();
    const menu = page.getByTestId('more-actions-menu');
    await expect(menu.getByTestId('more-action-reopen')).toHaveCount(0);
    await expect(menu.getByTestId('more-action-approve-pricing')).toHaveCount(0);
  });
});
