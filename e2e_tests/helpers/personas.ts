import type { Page } from '@playwright/test';
import { loginAsPersonaSession } from './auth';

/**
 * Seeded demo personas the e2e suite runs against, provisioned by the T-041 demo seed
 * (`npm run db:seed:demo`, scripts/db/demo-data/catalog.ts). They are real Supabase Auth
 * identities with the one shared demo password (see helpers/auth.ts `E2E_PASSWORD`).
 *
 * The KEYS below are deliberately unchanged from the earlier .NET/Keycloak persona set so the
 * lifted spec bodies (`loginAsPersona(page, 'tenantAdmin')`, etc.) keep working unedited — only the
 * emails/roles they resolve to were repointed to the migrated demo seed (T-043, the T-041-N1
 * carry-forward).
 *
 * Demo tenants (scripts/db/demo-data/catalog.ts `TENANTS`):
 *   - tenant 1: "Kalahari Insurance (Pilot)"  (the data-rich pilot tenant every dashboard/alert/
 *     lead/quote spec targets; 195 leads, high-value threshold 500000)
 *   - tenant 2: "Okavango Risk Partners"       (the second fully-seeded tenant used for the
 *     cross-tenant/internal-mode probes; 105 leads)
 *
 * Role → permission bundles come from `TENANT_ROLES`/`INTERNAL_ROLE` in the catalog:
 *   - internal          : global.view_any_tenant + tenants.* ; also 'admin' in BOTH demo tenants
 *                         (internal.admin is member of tenant 1 & 2). The Tenant-Manager / cross-tenant
 *                         persona.
 *   - tenantAdmin       : the 'admin' role (whole permission catalog) scoped to tenant 1 only, with
 *                         NO global grants — so it sees User Manager/Settings but NOT Tenant Manager.
 *   - salesHead         : the 'sales_manager' role — leads.view_all + all five dashboards +
 *                         reports.view/export + alerts.view/assign/resolve + brokers.view/performance.
 *                         The broad leadership/read persona for dashboards, alerts, reports, exports.
 *                         (Member of both tenants; lands in tenant 1.)
 *   - relationshipManager (+2) : the 'relationship_manager' role — leads.view (NO view_all =>
 *                         assigned-only), leads.create/update, quotes create/update/revise/mark_sent,
 *                         parties, dashboards.pipeline, alerts.view. Intake/workflow + the
 *                         "assigned-only" RBAC case.
 *   - underwriter       : the 'underwriter' role — leads.view/view_all/update, quotes.view/update/
 *                         revise, pricing.request/approve/reject, dashboards.pipeline, alerts.view.
 *   - salesOperations   : NO dedicated sales-operations role exists in the migrated catalog; mapped
 *                         to the closest broad operational persona (sales_manager, which carries
 *                         leads/quotes/parties + reports.view/export). Specs asserting a *narrower*
 *                         ops bundle should be reconciled against the migrated role set.
 *   - executiveViewer   : the 'executive' role — all five dashboards + reports.view + alerts.view +
 *                         audit.view ONLY, no leads/quotes/parties write, no workflow. The read-only
 *                         executive persona.
 */
export const PERSONAS = {
  internal: 'internal.admin@quoteiq.local',
  tenantAdmin: 'pilot.admin@quoteiq.local',
  salesHead: 'sales.manager@quoteiq.local',
  relationshipManager: 'rm.tebogo@quoteiq.local',
  relationshipManager2: 'rm.lorato@quoteiq.local',
  underwriter: 'uw.thabo@quoteiq.local',
  salesOperations: 'sales.manager@quoteiq.local',
  executiveViewer: 'executive@quoteiq.local',
} as const;

export type PersonaKey = keyof typeof PERSONAS;

/** The data-rich demo tenant (tenant 1) every persona above (except a pure-internal probe) lands in. */
export const DEMO_TENANT_NAME = 'Kalahari Insurance (Pilot)';

/** The second fully-seeded demo tenant, used for cross-tenant / internal-mode assertions. */
export const SECOND_TENANT_NAME = 'Okavango Risk Partners';

/**
 * Signs in as one of the seeded demo personas by minting a Supabase Auth session server-side (via
 * the Auth admin/password API) and injecting it into the browser's localStorage before the SPA
 * boots — the fast, no-form path legitimate under Q-21 for the bulk of specs. Lands on the app root
 * and waits for the authenticated shell. Prefer this over a raw email so the persona set stays
 * centralised and typo-safe.
 */
export async function loginAsPersona(page: Page, persona: PersonaKey): Promise<void> {
  await loginAsPersonaSession(page, PERSONAS[persona]);
}
