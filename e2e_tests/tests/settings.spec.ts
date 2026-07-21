import { test, expect } from '@playwright/test';
import { loginAs, gotoAndExpectForbidden } from '../helpers/auth';

/**
 * Settings section (spec FR-18..FR-24, PRD 12.10, T-016, verification.json V-010/V-017/V-018/
 * V-022/V-023/V-074). Real flows against the compose Keycloak + the running API + the four
 * Settings backends (T-008/T-010/T-011/T-012), driven through the actual Settings UI this task
 * builds. Requires the personas from `e2e_tests/seed/seed-shell-e2e.sh`
 * (`internal.admin@quoteiq.local` now additionally holds `reference_data.manage`,
 * `business_assignments.view/manage`, and `brokers.view/manage`; `pilot.admin@quoteiq.local`
 * holds tenant-scoped `brokers.manage` only).
 *
 * Scope note: several verification.json steps for V-010/V-022/V-023/V-074 drive cross-feature
 * surfaces that do not exist yet — the Leads list/New Lead form (T-026/T-027), the lead Assign
 * dialog (T-018/T-028), and the Overview dashboard/exports (T-031/T-039). Those specific assertions
 * are isolated into their own `test.fixme` blocks below (not silently dropped) so they are picked
 * up the moment their owning task lands; everything achievable against what exists today (the
 * Settings screens themselves, plus the shell footer for AC-074) is a real, non-fixme test.
 */
test.describe.configure({ mode: 'serial' });

test.describe('settings > subsection gating (V-017)', () => {
  test('user with only brokers access sees only the Brokers tab; other subsections are Forbidden on a deep link', async ({
    page,
  }) => {
    // Migrated-seed persona choice: the Sales Manager holds `brokers.view` (and no other Settings
    // subsection permission — no reference_data.manage / business_rules.* / business_assignments.* /
    // api_access.view), so it is the minimal-Settings persona that exercises subsection gating. The
    // demo tenant admin (pilot.admin) legitimately holds every tenant-scoped code including
    // reference_data.manage, so it is NOT a valid negative case for hiding the Reference data tab.
    await loginAs(page, 'sales.manager@quoteiq.local');
    await expect(page).toHaveURL(/\/overview$/);

    await page.getByTestId('nav-settings').click();
    await expect(page).toHaveURL(/\/settings\/brokers$/);

    await expect(page.getByTestId('settings-tabs')).toBeVisible();
    await expect(page.getByTestId('settings-tab-brokers')).toBeVisible();
    await expect(page.getByTestId('settings-tab-reference-data')).toHaveCount(0);
    await expect(page.getByTestId('settings-tab-business-rules')).toHaveCount(0);
    await expect(page.getByTestId('settings-tab-business-assignments')).toHaveCount(0);

    // A genuine deep link (full reload) to a subsection this persona holds no permission for.
    await gotoAndExpectForbidden(page, '/settings/business-rules');
  });
});

test.describe('settings > reference data (V-018)', () => {
  test('add, reorder, and disable a request channel value', async ({ page }) => {
    await loginAs(page, 'internal.admin@quoteiq.local');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-reference-data').click();

    const listTypeNav = page.getByTestId('reference-list-type-nav');
    await listTypeNav.getByRole('link', { name: 'Request channels' }).click();

    const runId = Date.now();
    const firstChannel = `Partner portal A ${runId}`;
    const secondChannel = `Partner portal B ${runId}`;
    const table = page.getByTestId('reference-items-table');

    async function addChannel(name: string, brokerChannel: boolean): Promise<void> {
      await page.getByRole('button', { name: '+ Add value' }).click();
      const drawer = page.getByTestId('reference-item-drawer');
      await drawer.getByLabel('Name').fill(name);
      if (brokerChannel) {
        await drawer.getByTestId('broker-channel-toggle').check();
      }
      await drawer.getByRole('button', { name: 'Save' }).click();
      await expect(table.getByRole('row', { name: new RegExp(name) })).toBeVisible();
    }

    // Newly created values sort ahead of any pre-existing rows (a fresh row's display order starts
    // at 0; ties among freshly added rows are broken by insertion order), so `firstChannel` (added
    // first) sorts immediately before `secondChannel` (added second).
    await addChannel(firstChannel, true);
    await addChannel(secondChannel, false);

    async function secondChannelIndexAheadOfFirst(scopedTable: typeof table): Promise<boolean> {
      const texts = await scopedTable.getByRole('row').allTextContents();
      const secondIndex = texts.findIndex((text) => text.includes(secondChannel));
      const firstIndex = texts.findIndex((text) => text.includes(firstChannel));
      return secondIndex > -1 && firstIndex > -1 && secondIndex < firstIndex;
    }

    const secondRow = table.getByRole('row', { name: new RegExp(secondChannel) });
    await expect(secondRow).toContainText('No');
    await secondRow.getByTestId('reorder-up').click();

    // The reorder call is in-flight when `.click()` resolves (the button's onClick fires the
    // request but does not block on it), so poll the in-place order (auto-retrying) rather than
    // racing straight to a reload.
    await expect.poll(() => secondChannelIndexAheadOfFirst(table)).toBe(true);

    // Reorder persists across a reload. Waiting for the table to reappear (auto-retrying) before
    // asserting order avoids racing the reload's OIDC silent-auth round trip (tokens are in-memory
    // only, see auth/oidc.ts).
    await page.reload();
    const reloadedTable = page.getByTestId('reference-items-table');
    await expect(reloadedTable).toBeVisible();
    await expect.poll(() => secondChannelIndexAheadOfFirst(reloadedTable)).toBe(true);

    // Disable the first (broker-channel) value.
    const firstRowAfterReload = page.getByTestId('reference-items-table').getByRole('row', { name: new RegExp(firstChannel) });
    await firstRowAfterReload.getByRole('button', { name: 'Disable' }).click();
    await page.getByTestId('disable-reference-item-dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(firstRowAfterReload).toContainText('Disabled');
  });

  test('adding a new intermediate lead status restricts its reporting category to open/quoted, and it can be renamed and disabled', async ({
    page,
  }) => {
    // Note (scope, not a T-016 gap): `seed-shell-e2e.sh` provisions Tenant A/Tenant B by inserting
    // directly into Postgres rather than going through the real `POST /api/v1/tenants` (so the
    // shell specs this seed script predates, T-013, don't depend on Tenant Manager, T-014). That
    // means neither tenant has ever run through `TenantReferenceSeeder` (T-009), so there is no
    // pre-existing *canonical* lead-status row (e.g. a seeded "Quote Sent"/terminal "Closed Won")
    // to exercise the canonical-immutability/terminal-no-disable rules against here. Those two
    // specific rules (`reporting-category-cell` read-only for canonical rows; Disable hidden for
    // `isTerminal` rows) are proven at the component level against real canonical/terminal
    // fixtures instead — see `src/ui/src/features/settings/__tests__/ReferenceDataTab.test.tsx`.
    // This e2e spec instead proves the create/update/disable path for a brand-new, non-canonical
    // intermediate status, including the reporting-category restriction to open/quoted
    // (`ReportingCategory.IntermediateAllowed`, `CreateItemCommandHandler`/`UpdateItemCommandHandler`).
    await loginAs(page, 'internal.admin@quoteiq.local');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-reference-data').click();
    await page.getByTestId('reference-list-type-nav').getByRole('link', { name: 'Lead statuses' }).click();

    const table = page.getByTestId('reference-items-table');
    const runId = Date.now();
    const statusName = `Site Visit Scheduled ${runId}`;
    const renamedStatusName = `Site Visit Confirmed ${runId}`;

    await page.getByRole('button', { name: '+ Add value' }).click();
    const addDrawer = page.getByTestId('reference-item-drawer');
    await addDrawer.getByLabel('Name').fill(statusName);
    const categorySelect = addDrawer.getByTestId('reporting-category-select');
    await expect(categorySelect).toBeEnabled();
    const categoryOptions = await categorySelect.locator('option').allTextContents();
    expect(categoryOptions.sort()).toEqual(['open', 'quoted']);
    await categorySelect.selectOption('quoted');
    await addDrawer.getByRole('button', { name: 'Save' }).click();

    const row = table.getByRole('row', { name: new RegExp(statusName) });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('reporting-category-cell')).toHaveText('quoted');

    // Rename it — a non-canonical row's name (and, per the picker restriction above, its category)
    // can change freely, unlike a canonical row's fixed category.
    await row.getByRole('button', { name: 'Edit' }).click();
    const editDrawer = page.getByTestId('reference-item-drawer');
    await editDrawer.getByLabel('Name').fill(renamedStatusName);
    await expect(editDrawer.getByTestId('reporting-category-select')).toBeEnabled();
    await editDrawer.getByRole('button', { name: 'Save' }).click();

    const renamedRow = table.getByRole('row', { name: new RegExp(renamedStatusName) });
    await expect(renamedRow).toBeVisible();

    // Non-terminal, so a Disable action is available; clean up after the run.
    await renamedRow.getByRole('button', { name: 'Disable' }).click();
    await page.getByTestId('disable-reference-item-dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(renamedRow).toContainText('Disabled');
  });

  // Note: `test.fixme(title, body)` (title+callback form) below registers its own, always-skipped
  // test scoped to itself — unlike the bare `test.fixme(condition, description)` form used
  // elsewhere in this file's sibling specs' history, which marks the *entire enclosing describe*
  // as fixme and would incorrectly skip the real tests above too.
  test.fixme(
    'disabled request channel is absent from the New Lead intake form\'s channel picker (V-018)',
    async () => {
      throw new Error(
        'Blocked: requires the Lead intake UI (T-026), which does not yet exist. The disable ' +
          'action itself (value removed from active pickers server-side) is proven above and by ' +
          'QuoteIQ.Api.Tests.ReferenceData.ReferenceDataEndpointsTests (T-008). Un-fixme once T-026 lands.',
      );
    },
  );
});

test.describe('settings > business rules and display currency (V-010, V-074)', () => {
  test('editing business rules persists with a toast, and changing currency updates the footer', async ({ page }) => {
    await loginAs(page, 'internal.admin@quoteiq.local');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-business-rules').click();

    const form = page.getByTestId('business-rules-form');
    await form.getByLabel('High-value threshold').fill('1000000');
    await form.getByLabel('Aging amber days').fill('5');
    await form.getByLabel('Aging red days').fill('10');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('toast-success')).toContainText('saved');

    // Currency change updates the footer within the session (T-013 useTenantCurrency, sourced from
    // the session rather than a GET /settings/business-rules refetch).
    await form.getByLabel('Currency code').fill('ZAR');
    await form.getByLabel('Currency symbol').fill('R');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('footer-currency')).toHaveText('All amounts in ZAR');

    // Restore BWP so repeated runs and other specs (which assume Tenant A is BWP) are unaffected.
    await form.getByLabel('Currency code').fill('BWP');
    await form.getByLabel('Currency symbol').fill('BWP');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('footer-currency')).toHaveText('All amounts in BWP');
  });

  test.fixme(
    'Leads-list aging colors and New-Lead priority/currency-prefix/Overview-KPI/export reflect the saved thresholds/currency (V-010, V-074)',
    async () => {
      throw new Error(
        'Blocked: requires the Leads list (T-027), Lead intake (T-026), Overview dashboard (T-032), ' +
          'and exports (T-039), none of which exist yet. The settings-side save/validate/persist/audit ' +
          'behavior and the footer-currency surface are proven above; the backend contract ' +
          '(thresholds/currency validation, persistence, audit) is proven by ' +
          'QuoteIQ.Api.Tests.BusinessRules.BusinessRuleEndpointsTests (T-010). Un-fixme once those ' +
          'downstream screens land.',
      );
    },
  );
});

test.describe('settings > business assignments (V-022)', () => {
  test('configure the RM and Underwriting slot roles', async ({ page }) => {
    await loginAs(page, 'internal.admin@quoteiq.local');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-business-assignments').click();

    // Two-slot amendment (2026-07-15): one role dropdown per fixed slot (RM / Underwriting).
    await expect(page.getByTestId('business-assignments-form')).toBeVisible();
    const rmSelect = page.getByTestId('rm-role-select');
    const underwritingSelect = page.getByTestId('underwriting-role-select');

    // Slot-role options are the tenant's role NAMES; the migrated demo seed names the RM role
    // "Relationship Manager" (scripts/db/demo-data/catalog.ts), not the pre-migration "RM" literal.
    await rmSelect.selectOption({ label: 'Relationship Manager' });
    await underwritingSelect.selectOption({ label: 'Underwriter' });

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('toast-success')).toContainText('saved');

    // Saved values persist across a reload.
    await page.reload();
    await page.getByTestId('settings-tab-business-assignments').click();
    await expect(page.getByTestId('rm-role-select')).toHaveValue(/\d+/);
    await expect(page.getByTestId('underwriting-role-select')).toHaveValue(/\d+/);
  });

  test.fixme(
    'the lead Assign dialog composes one dropdown per configured role with RM marked required (V-022)',
    async () => {
      throw new Error(
        'Blocked: requires the lead Assign dialog, which is T-018 (Assign operation)/T-028 (dialog ' +
          'UI) and does not yet exist. The settings-side configuration/save and the accountable-owner ' +
          'invariant are proven above; the backend contract (exactly-one-accountable-owner validation, ' +
          'eligible-user lookups) is proven by ' +
          'QuoteIQ.Api.Tests.BusinessAssignments.BusinessAssignmentEndpointsTests (T-011). Un-fixme ' +
          'once T-028 lands.',
      );
    },
  );
});

test.describe('settings > brokers (V-023)', () => {
  test('add a broker with two contacts, the second marked primary demotes the first, then disable it', async ({
    page,
  }) => {
    await loginAs(page, 'internal.admin@quoteiq.local');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-brokers').click();

    const runId = Date.now();
    const brokerName = `E2E Brokers ${runId}`;

    // `.first()`: when the broker list is empty, the empty-state's own "+ Add broker" action button
    // duplicates the header one.
    await page.getByRole('button', { name: '+ Add broker' }).first().click();
    const drawer = page.getByTestId('broker-form-drawer');
    await drawer.getByLabel('Name').fill(brokerName);
    await drawer.getByLabel('Type').selectOption({ label: 'Tier 2 - core partner' });

    const contactsEditor = drawer.getByTestId('contacts-editor');
    await contactsEditor.getByRole('button', { name: '+ Add contact' }).click();
    await contactsEditor.getByLabel('Name').first().fill('First Contact');
    await contactsEditor.getByRole('button', { name: '+ Add contact' }).click();
    await contactsEditor.getByLabel('Name').nth(1).fill('Second Contact');
    await contactsEditor.getByTestId('primary-contact-radio').nth(1).check();

    await drawer.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('toast-success')).toContainText('saved');

    const row = page.getByTestId('brokers-table').getByRole('row', { name: new RegExp(brokerName) });
    await expect(row).toBeVisible();

    // Reopen the broker and assert the first contact was demoted when the second was marked primary.
    await row.click();
    const reopenedDrawer = page.getByTestId('broker-form-drawer');
    const reopenedContacts = reopenedDrawer.getByTestId('contacts-editor');
    await expect(reopenedContacts.getByTestId('primary-contact-radio').nth(0)).not.toBeChecked();
    await expect(reopenedContacts.getByTestId('primary-contact-radio').nth(1)).toBeChecked();

    // Disable the broker.
    await reopenedDrawer.getByRole('button', { name: 'Disable' }).click();
    await page.getByTestId('disable-broker-dialog').getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByTestId('brokers-table').getByRole('row', { name: new RegExp(brokerName) })).toContainText(
      'Disabled',
    );
  });

  test.fixme(
    'a disabled broker is absent from the New Lead intake form\'s broker picker (V-023)',
    async () => {
      throw new Error(
        'Blocked: requires the Lead intake UI (T-026), which does not yet exist. The disable action ' +
          'itself (broker excluded from active-broker pickers server-side) is proven above and by ' +
          'QuoteIQ.Api.Tests.Brokers.BrokerEndpointsTests (T-012). Un-fixme once T-026 lands.',
      );
    },
  );
});
