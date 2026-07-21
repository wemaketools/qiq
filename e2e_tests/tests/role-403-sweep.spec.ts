import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loginAsPersonaSession } from '../helpers/auth';
import { PERSONAS as DEMO_PERSONAS } from '../helpers/personas';

/**
 * Per-role 403 sweep (spec AC-083, verification.json V-083, T-044). Reproduces, as a committed and
 * repeatable Playwright spec, the ad-hoc crawl that originally surfaced the two authorization
 * failures T-044 fixed: (1) roles without `dashboards.view_executive` landing on the Forbidden page
 * because the index route hardcoded `/overview`, and (2) lookup READ endpoints (reference data,
 * business assignments, business rules, broker pickers) returning 403 to ordinary tenant members.
 *
 * For each seeded tenant-member persona this signs in, asserts the role-aware DefaultLanding
 * never drops the user on the Forbidden page, then crawls every routed screen that role's sidebar
 * actually exposes (plus a lead detail where the role can see leads), failing the test on ANY
 * `/api/v1` response with status >= 400 captured anywhere in the flow. The zero-membership case is
 * covered separately by `internal-cross-tenant.spec.ts` (AC-084/V-084).
 *
 * Personas come from the T-041 demo seed (`npm run db:seed:demo`, scripts/db/demo-data/catalog.ts).
 * The migrated catalog has five tenant roles (admin, sales_manager, relationship_manager,
 * underwriter, executive); the .NET-era "Sales Operations" role has no equivalent and is omitted.
 */
test.describe.configure({ mode: 'serial' });

interface Persona {
  role: string;
  email: string;
}

// One persona per migrated PURE tenant-member role. The demo 'admin' role (pilot.admin) is not
// listed here; this sweep samples the four non-admin tenant-member roles. NOTE: the earlier
// over-grant (F-043-2) that gave pilot.admin the Internal/global-only codes (tenants.*, global.*) —
// so it rendered the Internal-only Tenant Manager nav whose GET /api/v1/tenants the backend
// correctly 403s for a non-Internal caller — has been RESOLVED. The demo 'admin' role now holds
// `tenant_all`, which excludes those Internal-only prefixes (scripts/db/demo-data/catalog.ts), so
// pilot.admin no longer renders that nav and no longer trips the AC-083 nav/endpoint mismatch.
const PERSONAS: Persona[] = [
  { role: 'Sales Manager', email: DEMO_PERSONAS.salesHead },
  { role: 'Relationship Manager', email: DEMO_PERSONAS.relationshipManager },
  { role: 'Underwriter', email: DEMO_PERSONAS.underwriter },
  { role: 'Executive', email: DEMO_PERSONAS.executiveViewer },
];

// The full sidebar nav map (src/ui/src/components/shell/navConfig.ts, STANDARD then ADMIN order).
// The crawl visits only the entries a given persona's permissions actually render — each item hides
// itself in the DOM when unpermitted (Sidebar.tsx), so a `count() === 0` check tells us whether to
// visit it.
const NAV_TARGETS: { testId: string; path: string }[] = [
  { testId: 'nav-overview', path: '/overview' },
  { testId: 'nav-leads', path: '/leads' },
  { testId: 'nav-parties', path: '/parties' },
  { testId: 'nav-pipeline', path: '/pipeline' },
  { testId: 'nav-brokers', path: '/brokers' },
  { testId: 'nav-rm-performance', path: '/rm-performance' },
  { testId: 'nav-loss-analysis', path: '/loss-analysis' },
  { testId: 'nav-alerts', path: '/alerts' },
  { testId: 'nav-reports', path: '/reports' },
  { testId: 'nav-settings', path: '/settings' },
  { testId: 'nav-user-manager', path: '/admin/users' },
  { testId: 'nav-tenant-manager', path: '/admin/tenants' },
];

/**
 * Attaches a page-level response listener that records every app API (`/api/v1`) response with a
 * status >= 400. Non-API responses (favicon, Keycloak's own login/token endpoints on port 8080,
 * static assets) are ignored by the URL scope, matching V-083's "any >=400 API response" claim.
 */
function collectApiFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/api/v1') && response.status() >= 400) {
      failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  return failures;
}

for (const persona of PERSONAS) {
  test(`${persona.role} lands on a permitted screen and crawls every routed screen with zero >=400 API responses (V-083)`, async ({ page }) => {
    const apiFailures = collectApiFailures(page);

    await loginAsPersonaSession(page, persona.email);

    // Role-aware DefaultLanding (T-044): a tenant member must never land on the Forbidden page.
    await expect(page.getByTestId('sidebar-nav')).toBeVisible();
    await expect(page.getByTestId('forbidden-page')).toHaveCount(0);

    // Crawl every sidebar entry this role exposes. We gate on the nav item being present (its
    // permission-driven visibility is the point of V-083) but navigate via the router URL rather
    // than a raw click: a persona with a tenant-switcher can scroll the bottom admin nav item under
    // the fixed topbar, and the switcher <select> then intercepts the click — a scroll/overlay
    // actionability artifact, not the >=400 authorization contract this sweep exists to prove.
    for (const target of NAV_TARGETS) {
      if ((await page.getByTestId(target.testId).count()) === 0) {
        continue;
      }
      await page.goto(target.path);
      await page.waitForURL((url) => url.pathname.startsWith(target.path));
      await page.waitForLoadState('networkidle');
      await expect(page.getByTestId('forbidden-page')).toHaveCount(0);
    }

    // Plus a lead detail, where this role can see leads. Roles without `leads.view_all` see only
    // their own assignments, so guard on an actual row being present to keep the crawl deterministic
    // (an empty My-leads list is itself a valid, 403-free screen already asserted above).
    if ((await page.getByTestId('nav-leads').count()) > 0) {
      await page.getByTestId('nav-leads').click();
      await page.waitForURL((url) => url.pathname.startsWith('/leads'));
      await page.waitForLoadState('networkidle');
      if ((await page.getByTestId('lead-ref-link').count()) > 0) {
        await page.getByTestId('lead-ref-link').first().click();
        await page.waitForURL(/\/leads\/\d+/);
        await expect(page.getByTestId('lead-header')).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expect(page.getByTestId('forbidden-page')).toHaveCount(0);
      }
    }

    expect(apiFailures, `Unexpected >=400 API responses during the ${persona.role} crawl:\n${apiFailures.join('\n')}`).toEqual([]);
  });
}
