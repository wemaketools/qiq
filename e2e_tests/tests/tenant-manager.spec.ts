import { test, expect } from '@playwright/test';
import { loginAs, gotoAndExpectForbidden } from '../helpers/auth';

/**
 * Tenant Manager (spec FR-06/FR-07, PRD 5.5, AC-006, T-006/T-014, verification.json V-006):
 * create/edit/soft-remove/restore lifecycle against the real Tenant Manager UI and the real
 * `/api/v1/tenants` backend, plus the permission-gating checks from AC-016/V-015 as they apply to
 * this screen specifically. Requires the personas from `e2e_tests/seed/seed-shell-e2e.sh`
 * (`internal.admin@quoteiq.local` now holds the full `tenants.*` permission set; `rm.tebogo@quoteiq.local`
 * holds none of them).
 */
test.describe.configure({ mode: 'serial' });

test.describe('tenant manager - lifecycle (V-006)', () => {
  test('internal user creates, edits, soft-removes, and restores a tenant', async ({ page }) => {
    await loginAs(page, 'internal.admin@quoteiq.local');
    await expect(page).toHaveURL(/\/overview$/);
    // Client-side navigation via the sidebar link (rather than `page.goto`, which forces a full
    // reload): access/refresh tokens are kept in-memory only (oidc.ts), so a full reload would
    // force a fresh Keycloak round trip for every step of this test.
    await page.getByTestId('nav-tenant-manager').click();
    await expect(page.getByTestId('tenant-list')).toBeVisible();

    const runId = Date.now();
    const tenantName = `E2E Insurance ${runId}`;

    // Create
    await page.getByRole('button', { name: '+ New Tenant' }).click();
    await page.getByLabel('Name', { exact: true }).fill(tenantName);
    await page.getByLabel('Contact name').fill('Jane Doe');
    await page.getByLabel('Contact email').fill('jane.doe@example.test');
    await page.getByLabel('Contact phone').fill('+267-555-0100');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page).toHaveURL(/\/admin\/tenants$/);
    let row = page.getByRole('row', { name: new RegExp(tenantName) });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('status-chip')).toHaveText('Active');

    // Edit contact email; assert it persists in the list
    await row.getByRole('button', { name: 'Edit' }).click();
    const emailField = page.getByLabel('Contact email');
    await emailField.fill('');
    await emailField.fill('jane.doe.updated@example.test');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page).toHaveURL(/\/admin\/tenants$/);
    row = page.getByRole('row', { name: new RegExp(tenantName) });
    await expect(row).toContainText('jane.doe.updated@example.test');

    // Remove: danger dialog restates the soft-delete consequence; row disappears from the default list
    await row.getByRole('button', { name: 'Remove' }).click();
    const removeDialog = page.getByTestId('remove-tenant-dialog');
    await expect(removeDialog).toBeVisible();
    await expect(removeDialog).toContainText(`Remove tenant — ${tenantName}`);
    await expect(removeDialog).toContainText(/restored/i);
    await removeDialog.getByTestId('dialog-danger-button').click();

    await expect(page.getByRole('row', { name: new RegExp(tenantName) })).toHaveCount(0);

    // Include-removed toggle reveals it with a Removed chip
    await page.getByTestId('include-removed-toggle').locator('input').check();
    row = page.getByRole('row', { name: new RegExp(tenantName) });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('status-chip')).toHaveText('Removed');

    // Restore reactivates it
    await row.getByRole('button', { name: 'Restore' }).click();
    const restoreDialog = page.getByTestId('restore-tenant-dialog');
    await expect(restoreDialog).toBeVisible();
    await restoreDialog.getByTestId('dialog-primary-button').click();

    row = page.getByRole('row', { name: new RegExp(tenantName) });
    await expect(row.getByTestId('status-chip')).toHaveText('Active');

    // Teardown: leave the tenant removed so repeated runs don't accumulate active test tenants.
    await row.getByRole('button', { name: 'Remove' }).click();
    await page.getByTestId('remove-tenant-dialog').getByTestId('dialog-danger-button').click();
  });

  test('user without tenant permissions sees no Tenant Manager nav and gets Forbidden on a deep link (AC-016)', async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    // A Relationship Manager holds no dashboards.view_executive, so DefaultLanding resolves the
    // first permitted sidebar entry — the Leads list — not /overview.
    await expect(page).toHaveURL(/\/leads$/);

    await expect(page.getByTestId('nav-tenant-manager')).toHaveCount(0);

    // A genuine deep link: the migrated stack persists the session in localStorage, so a full
    // reload restores it in-process; `gotoAndExpectForbidden` asserts the Forbidden page renders
    // after navigating directly to the guarded route.
    await gotoAndExpectForbidden(page, '/admin/tenants');
  });
});

/**
 * Tenant creation seeds reference data (spec FR-08, PRD 6.3/6.4, AC-007, T-009,
 * verification.json V-007).
 *
 * The reference-data seeding backend (T-009: `TenantReferenceSeeder` wired as
 * `ITenantProvisioningHook`, invoked from inside `CreateTenantCommandHandler`'s creation
 * transaction) is implemented and covered end-to-end — all eleven reference lists populated
 * transactionally from the current global default template, cover-type -> product-line linkage
 * resolved via `default_product_line_key`, terminal lead/quote statuses carrying `is_terminal`,
 * template edits affecting future tenants only, tenant isolation of seeded lists, the
 * `tenant.reference_seeded` audit entry with per-list counts, and rollback of the whole tenant
 * creation on a seeding failure — by:
 *   - src/api/tests/QuoteIQ.Infrastructure.Tests/Provisioning/TenantSeedingTests.cs
 *
 * Settings > Reference data (T-016) now exists, but this scenario stays `fixme` — investigated
 * during T-016 and found to be blocked on a *different*, pre-existing gap, not on T-016 itself:
 *   - `CreateTenantCommandHandler` (T-006) does not add a `user_tenants` row for the creating user;
 *   - the shell's `TenantSwitcher` (T-013) only ever lists `session.memberships`, itself populated
 *     once from `GET /me` at login — there is no "switch into a tenant I'm not an explicit member
 *     of" affordance anywhere in the UI (Tenant Manager's `TenantListPage` has no "Switch to
 *     tenant" action; the prior placeholder's reference to one was aspirational, not real code);
 *   - so even `internal.admin@quoteiq.local` (`global.view_any_tenant`, which grants *authorization*
 *     to act in any tenant once `X-Tenant-Id` is set, but not a switcher entry) cannot reach the
 *     newly created tenant's Settings > Reference data without a session/membership refresh
 *     mechanism this task does not introduce.
 * This is flagged as an open gap for a future task (most likely a T-013/T-014 follow-up: either
 * refetch `GET /me` after `POST /tenants` succeeds, or give Tenant Manager a "Switch to tenant"
 * action for `global.view_any_tenant` holders) rather than fabricated as passing against a flow
 * that does not exist. The steps/selectors below are unchanged from verification.json V-007 and
 * should be revisited once that follow-up lands.
 */
test.describe('tenant manager - reference data seeding', () => {
  test.fixme(
    true,
    'No UI path exists yet for a tenant creator to enter a brand-new tenant mid-session (no ' +
      '"Switch to tenant" action, and TenantSwitcher only lists login-time GET /me memberships) — ' +
      'a pre-existing gap surfaced while implementing T-016, not something T-016 itself can close. ' +
      'Reference-data seeding itself is proven by QuoteIQ.Infrastructure.Tests.Provisioning.TenantSeedingTests (T-009), ' +
      'and Settings > Reference data now exists and is covered directly by e2e_tests/tests/settings.spec.ts (T-016).',
  );

  test('newly created tenant has populated reference lists immediately (V-007)', async ({ page }) => {
    await page.goto('/admin/tenants');

    await page.getByRole('button', { name: '+ New Tenant' }).click();
    const runId = Date.now();
    const tenantName = `E2E Reference Seed Tenant ${runId}`;
    await page.getByLabel('Name', { exact: true }).fill(tenantName);
    await page.getByRole('button', { name: 'Save' }).click();

    const row = page.getByRole('row', { name: new RegExp(tenantName) });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Switch to tenant' }).click();
    await page.goto('/settings/reference-data');

    const listTypeNav = page.getByTestId('reference-list-type-nav');
    await listTypeNav.getByRole('link', { name: 'Request channels' }).click();
    await expect(page.getByTestId('reference-items-table').getByRole('row')).toHaveCount(9 + 1); // +1 header row

    await listTypeNav.getByRole('link', { name: 'Product lines' }).click();
    await expect(page.getByTestId('reference-items-table').getByRole('row')).toHaveCount(12 + 1);

    await listTypeNav.getByRole('link', { name: 'Lead statuses' }).click();
    await expect(page.getByTestId('reference-items-table').getByRole('row')).toHaveCount(11 + 1);
    const closedWonRow = page.getByRole('row', { name: /Closed Won/ });
    await expect(closedWonRow.getByRole('button', { name: 'Disable' })).toHaveCount(0);

    await listTypeNav.getByRole('link', { name: 'Lost reasons' }).click();
    await expect(page.getByTestId('reference-items-table').getByRole('row')).toHaveCount(14 + 1);
  });
});
