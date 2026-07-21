import { test, expect } from '@playwright/test';
import { loginAs, E2E_PASSWORD, gotoAndExpectForbidden, setUserPasswordByEmail } from '../helpers/auth';
import { DEMO_TENANT_NAME } from '../helpers/personas';

/**
 * User Manager (spec §12.2, FR-13/FR-14/FR-16, PRD 20.1.1, AC-012/AC-013, T-007/T-015,
 * verification.json V-012/V-013) against the real User Manager UI (T-015) and the real
 * `/api/v1/users`, `/api/v1/roles`, `/api/v1/groups` backend (T-007), over the migrated
 * Supabase-Auth demo seed (`npm run db:seed:demo`). `internal.admin@quoteiq.local` holds the full
 * `users.*`/`roles.*`/`groups.*` set plus `leads.view`/`parties.view` themselves
 * (grant-no-higher-than-self: the caller must hold a permission before granting it via a
 * role/group/direct assignment).
 */

test.describe.configure({ mode: 'serial' });

test.describe('user manager (V-012/V-013)', () => {
  test('create a role with permissions, a group assigned that role, and a user with a direct permission + group membership; effective access shows the inherited permission', async ({ page }) => {
    // Long, multi-entity real-Keycloak flow (role -> group -> user -> deactivate -> fresh login
    // attempt as that user); the default 30s test timeout is too tight for this many real
    // navigation/network round trips.
    test.setTimeout(90000);
    await loginAs(page, 'internal.admin@quoteiq.local');
    // internal.admin holds dashboards.view_executive (tenant_all in the demo seed), so DefaultLanding
    // resolves /overview.
    await expect(page).toHaveURL(/\/overview$/, { timeout: 15000 });

    const runId = Date.now();
    const roleName = `E2E Role ${runId}`;
    const groupName = `E2E Group ${runId}`;

    // --- Create a role with a permission the caller (e2e-internal) itself holds (leads.view) ---
    await page.getByTestId('nav-user-manager').click();
    await expect(page.getByTestId('user-list')).toBeVisible();
    await page.getByTestId('user-manager-nav-roles').click();
    // The role list may legitimately be empty on a fresh environment (no roles created yet), so
    // wait for the page container rather than the `role-list` table, which only renders once
    // `roles.length > 0`.
    await expect(page.getByTestId('page-admin-roles')).toBeVisible();

    // `.first()`: the header "+ New Role" button and the empty-state's own copy of it both render
    // when the list is empty (a fresh environment has no roles yet).
    await page.getByRole('button', { name: '+ New Role' }).first().click();
    await page.getByLabel('Name').fill(roleName);
    await page.getByLabel(/^leads\.view($| )/).check();
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page).toHaveURL(/\/admin\/roles$/);
    const roleRow = page.getByRole('row', { name: new RegExp(roleName) });
    await expect(roleRow).toBeVisible();

    // --- Create a group and assign it that role ---
    await page.getByTestId('user-manager-nav-groups').click();
    await expect(page.getByTestId('page-admin-groups')).toBeVisible();

    await page.getByRole('button', { name: '+ New Group' }).first().click();
    await page.getByLabel('Name').fill(groupName);
    await page.getByRole('button', { name: 'Save' }).click();

    await expect(page).toHaveURL(/\/admin\/groups\/\d+$/);
    await expect(page.getByTestId('group-roles-section')).toBeVisible();
    await page.getByLabel(roleName).check();
    await page.getByRole('button', { name: 'Save roles' }).click();

    // --- Create a user assigned to a tenant, a direct permission, and the group ---
    await page.getByTestId('user-manager-nav-users').click();
    await expect(page.getByTestId('user-list')).toBeVisible();

    const userEmail = `e2e-access-${runId}@quoteiq.test`;
    await page.getByRole('button', { name: '+ New User' }).first().click();
    const form = page.getByTestId('user-form');
    await form.getByLabel('First name').fill('Access');
    await form.getByLabel('Last name').fill('Demo');
    await form.getByLabel('Email').fill(userEmail);
    await form.getByLabel('Tenant').selectOption({ label: DEMO_TENANT_NAME });
    await form.getByLabel('Direct permission').selectOption({ value: 'parties.view' });
    await form.getByLabel('Group').selectOption({ label: groupName });
    await page.getByRole('button', { name: 'Save' }).click();

    // Landed on the new user's detail page (T-015 UserFormPage navigates there on success)
    await expect(page).toHaveURL(/\/admin\/users\/\d+$/);
    await expect(page.getByTestId('user-detail-page')).toContainText(userEmail);

    // --- Effective access shows the direct permission, the group, and the inherited leads.view ---
    await page.getByTestId('tab-effective-access').click();
    await expect(page.getByTestId('direct-permissions-list')).toContainText('parties.view');
    await expect(page.getByTestId('groups-list')).toContainText(groupName);
    await expect(page.getByTestId('resolved-permissions')).toContainText('parties.view');
    await expect(page.getByTestId('resolved-permissions')).toContainText('leads.view');

    // --- Role usage dialog lists the group before disable ---
    await page.getByTestId('user-manager-nav-roles').click();
    const roleRowAgain = page.getByRole('row', { name: new RegExp(roleName) });
    await roleRowAgain.getByRole('button', { name: 'Disable' }).click();
    const usageDialog = page.getByTestId('role-usage-dialog');
    await expect(usageDialog).toBeVisible();
    await expect(usageDialog.getByTestId('role-usage-list')).toContainText(groupName);
    await usageDialog.getByRole('button', { name: 'Cancel' }).click();

    // --- Deactivate the user, then attempt a fresh login as that user (V-012) ---
    // The User Manager UI never reveals a newly-created user's initial credential (it is emailed, not
    // displayed), so a real login attempt as this exact user requires setting a known password on its
    // Supabase Auth identity first (see setUserPasswordByEmail). Deactivation then bans that identity
    // (auth.admin.updateUserById ban_duration, src/server/domains/users/auth-admin.ts), so the sign-in
    // must fail — keeping the "deactivated user cannot log in" leg a genuine, running assertion.
    await setUserPasswordByEmail(userEmail, E2E_PASSWORD);

    await page.getByTestId('user-manager-nav-users').click();
    const userRow = page.getByRole('row', { name: new RegExp(userEmail) });
    await expect(userRow).toBeVisible();
    await userRow.getByRole('button', { name: 'Deactivate' }).click();
    await page.getByTestId('deactivate-user-dialog').getByTestId('dialog-danger-button').click();
    await expect(userRow.getByText('Inactive')).toBeVisible();

    const freshContext = await page.context().browser()!.newContext();
    const freshPage = await freshContext.newPage();
    // Attempt a real sign-in through the SPA form (not the loginAs success helper, which waits for the
    // authenticated shell) — the banned identity is rejected, so the same generic error banner as any
    // failed login renders (AC-002/AC-032: existence/deactivation is never revealed).
    await freshPage.goto('/sign-in');
    await freshPage.getByTestId('sign-in-page').waitFor({ state: 'visible' });
    await freshPage.locator('#sign-in-email').fill(userEmail);
    await freshPage.locator('#sign-in-password').fill(E2E_PASSWORD);
    await freshPage.getByTestId('sign-in-submit').click();
    await expect(freshPage.getByTestId('sign-in-error')).toBeVisible({ timeout: 10000 });
    await freshContext.close();
  });

  test('user without User Manager permissions sees no User Manager nav and gets Forbidden on deep links', async ({ page }) => {
    await loginAs(page, 'rm.tebogo@quoteiq.local');
    // A Relationship Manager holds no dashboards.view_executive, so DefaultLanding resolves the Leads
    // list, not /overview.
    await expect(page).toHaveURL(/\/leads$/, { timeout: 15000 });

    await expect(page.getByTestId('nav-user-manager')).toHaveCount(0);

    // A genuine deep link: the migrated stack restores the localStorage session in-process on reload,
    // and `gotoAndExpectForbidden` asserts the Forbidden page renders at the guarded route.
    await gotoAndExpectForbidden(page, '/admin/users');
    await gotoAndExpectForbidden(page, '/admin/roles');
    await gotoAndExpectForbidden(page, '/admin/groups');
  });
});
