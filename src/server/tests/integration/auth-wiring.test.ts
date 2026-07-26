/**
 * Every composition root wires authentication (T-011, AC-016).
 *
 * `buildApp({ auth })` is optional so test harnesses can exercise the pipeline anonymously. That
 * flexibility is exactly the kind of thing that ships an unauthenticated API by accident, so the
 * production roots are pinned here: a new entrypoint that forgets `auth:` fails this test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { API_BASE_PATH, PUBLIC_PATHS } from '../../lib/router/app.js';
import { repoRoot } from './helpers/repo.js';

/** Files that build the app for real traffic. Add new roots here deliberately. */
const COMPOSITION_ROOTS = ['api/v1/index.ts', 'scripts/dev/serve-api.ts'] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8');
}

describe('composition roots', () => {
  it.each(COMPOSITION_ROOTS)('%s passes auth deps to buildApp', (path) => {
    const contents = read(path);

    expect(contents).toContain('buildApp(');
    expect(contents).toContain('defaultAuthDeps(');
    // The call itself must carry the auth deps, not merely import the factory.
    expect(contents).toMatch(/buildApp\(\{[^}]*auth:\s*defaultAuthDeps\(config\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes tenancy deps to buildApp (T-013)', (path) => {
    // Same failure mode as the auth slot, one step further in: `buildApp({ tenancy })` is optional
    // so test harnesses can run without a database, and a root that omits it leaves the tenant slot
    // EMPTY. That is silent today — no tenant-scoped route is registered yet — and would become a
    // cross-tenant hole the moment one is, because a tenant-scoped handler would run with no
    // verified tenant. Pinned here so the first domain task cannot inherit an unwired boundary.
    const contents = read(path);

    expect(contents).toContain('defaultTenancyDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*tenancy:\s*defaultTenancyDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes session deps to buildApp (T-015)', (path) => {
    // `buildApp({ me })` is optional for the same test-harness reason as the slots above, and an
    // omitted slot is louder here — `/me` would 404 and the SPA could not bootstrap at all — but it
    // is pinned anyway so a new entrypoint cannot ship a shell that cannot log in.
    const contents = read(path);

    expect(contents).toContain('defaultMeDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*me:\s*defaultMeDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes rbac deps to buildApp (T-012/T-016)', (path) => {
    // The loudest omission of the four and, until finding F-016-1, the only unpinned one: without
    // `rbac`, `requirePermission` has no grant loader and fails CLOSED, so EVERY permission-guarded
    // route 500s in production while the whole test suite stays green (the tests compose their own
    // app). Removing this line from an entrypoint left 873/873 tests passing — which is exactly why
    // it is pinned here now.
    const contents = read(path);

    expect(contents).toContain('defaultRbacDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*rbac:\s*defaultRbacDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes tenants deps to buildApp (T-016)', (path) => {
    // Domain slots are registered conditionally (app.ts), so an omitted one does not fail closed
    // like `rbac` — it simply never registers the routes, and every /api/v1/tenants request 404s in
    // production. Removing this line left 876/876 tests, typecheck and lint all green (F-016-3):
    // the tests compose their own app, and the Vercel root is the one file NO test executes and no
    // e2e ever will, because e2e drives serve-api.ts. A source pin is its only possible guard.
    const contents = read(path);

    expect(contents).toContain('defaultTenantsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*tenants:\s*defaultTenantsDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes global-template deps to buildApp (T-016)', (path) => {
    // Same conditional-registration failure mode as the tenants slot, on the Internal-managed
    // global template routes.
    const contents = read(path);

    expect(contents).toContain('defaultGlobalTemplateDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*globalTemplate:\s*defaultGlobalTemplateDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes user-manager deps to buildApp (T-017)', (path) => {
    // The widest conditional slot yet: `userManager` registers /users, /roles, /groups AND
    // /permissions (app.ts), so a root that omits it 404s the ENTIRE User Manager in production —
    // user administration, role administration, group administration and the permission catalog —
    // while every suite stays green, because the suites compose their own app and the Vercel root
    // is executed by no test and driven by no e2e (e2e drives serve-api.ts). Verified by deleting
    // this line from each root in turn and watching this test, and only this test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultUserManagerDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*userManager:\s*defaultUserManagerDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes reference-data deps to buildApp (T-019)', (path) => {
    // The first TENANT-SCOPED slot, and the widest blast radius of the conditional ones: omitting
    // `referenceData` 404s /settings/reference-data for every list type, which is not just the
    // Settings screen but the dropdowns behind lead intake, party intake and every filter bar
    // (ReferenceDataEndpoints.cs:16-23 records the reference breaking exactly this way when the
    // route was over-permissioned). Same silence as its siblings: the suites compose their own app,
    // and the Vercel root is executed by no test and driven by no e2e (e2e drives serve-api.ts).
    // Verified by deleting this line from each root in turn and watching this test, and only this
    // test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultReferenceDataDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*referenceData:\s*defaultReferenceDataDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes brokers deps to buildApp (T-021)', (path) => {
    // Same conditional-registration failure mode as the reference-data slot, and nearly as wide:
    // omitting `brokers` 404s /brokers, which is the Settings brokers tab AND the broker picker
    // behind every leads filter row, the intake form and every dashboard filter bar
    // (BrokerEndpoints.cs:29-32 records the reference breaking exactly this way when the list route
    // was over-permissioned). Same silence as its siblings: the suites compose their own app, and
    // the Vercel root is executed by no test and driven by no e2e (e2e drives serve-api.ts).
    // Verified by deleting this line from each root in turn and watching this test, and only this
    // test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultBrokersDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*brokers:\s*defaultBrokersDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes parties deps to buildApp (T-023)', (path) => {
    // Same conditional-registration failure mode as the reference-data and brokers slots: omitting
    // `parties` 404s /parties, which is the whole Parties screen AND the party picker lead intake
    // depends on — a lead cannot be created without choosing a party, so this slot silently takes
    // the primary business workflow with it. Same silence as its siblings: the suites compose their
    // own app, and the Vercel root is executed by no test and driven by no e2e (e2e drives
    // serve-api.ts). Verified by deleting this line from each root in turn and watching this test,
    // and only this test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultPartiesDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*parties:\s*defaultPartiesDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes leads deps to buildApp (T-024)', (path) => {
    // The same conditional-registration silence as its siblings, and the widest blast radius of
    // any of them: omitting `leads` 404s `/leads`, taking the Leads list, lead intake, Lead Detail
    // and every drill-through into them at once — the product's primary workflow end to end. The
    // omission is invisible to the test suites (they compose their own app) and to e2e against
    // serve-api.ts if only the Vercel root is missed, which is exactly why BOTH roots are pinned.
    const contents = read(path);

    expect(contents).toContain('defaultLeadsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*leads:\s*defaultLeadsDeps\(onLeadChanged\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes quotes deps to buildApp (T-026)', (path) => {
    // Quotes get their OWN slot rather than riding the leads slot (unlike the lead workflow
    // routes), so omitting it is silent in a way the leads pin cannot catch: `/leads` and Lead
    // Detail keep working, and only the Quotes card, quote detail, the seven quote operations and
    // set-current 404 — i.e. the entire quote lifecycle, including the sole path to a Closed Won
    // lead (FR-39). The suites compose their own app and the Vercel root is executed by no test,
    // so without this pin the omission reaches production green.
    const contents = read(path);

    expect(contents).toContain('defaultQuotesDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*quotes:\s*defaultQuotesDeps\(onLeadChanged\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes attachment deps to buildApp (T-027)', (path) => {
    // Attachments get their own slot because they are the only surface needing a StorageAdapter as
    // well as a database (A-6), so omitting it is silent in a way the quotes pin cannot catch: the
    // whole quote lifecycle keeps working and only the documents on a quote — upload, list,
    // download, remove — 404. The suites compose their own app and the Vercel root is executed by
    // no test, so without this pin the omission reaches production green.
    //
    // The `config` argument is pinned too, not just the key: `defaultAttachmentsDeps()` with no
    // config would not compile, but a future edit passing a hand-rolled object could silently
    // bypass `createStorageAdapter`'s refusal to select the in-memory fake outside local.
    const contents = read(path);

    expect(contents).toContain('defaultAttachmentsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*attachments:\s*defaultAttachmentsDeps\(config\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes dashboard deps to buildApp (T-035)', (path) => {
    // Same conditional-registration silence as its siblings, with a failure mode that is quiet in
    // a specific and dangerous way: omitting `dashboards` 404s `GET /dashboards/drill`, so every
    // dashboard still renders — the KPI cards and charts come from their own endpoints — and only
    // the chevron that drills into a cell fails. The numbers stay on screen and become
    // unverifiable, which is the one property drill-through exists to give them. The suites
    // compose their own app and the Vercel root is executed by no test and driven by no e2e (e2e
    // drives serve-api.ts). Verified by deleting this line from each root in turn and watching
    // this test, and only this test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultDashboardsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*dashboards:\s*defaultDashboardsDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes export deps to buildApp (T-039)', (path) => {
    // Same conditional-registration silence as its siblings: omitting `exports` 404s
    // `/exports/leads`, `/exports/parties` and `/exports/dashboard`, so every Export button in the
    // product fails while every one of the 3400+ tests stays green — the suites compose their own
    // app and the Vercel root is executed by no test (e2e drives serve-api.ts).
    //
    // The ARGUMENT LIST is pinned as empty on purpose. `ExportsDeps.maxRows` is a test seam for the
    // documented synchronous size limit (Q-18), and a composition root that passed one would ship a
    // production cap nobody reviewed — silently rejecting exports that should succeed, or waving
    // through ones that blow the ~4.5 MB response cap. `defaultExportsDeps()` takes no arguments and
    // never sets it. Verified by deleting this line from each root in turn and watching this test,
    // and only this test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultExportsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*exports:\s*defaultExportsDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes report deps to buildApp (T-040)', (path) => {
    // Same conditional-registration silence as its siblings: omitting `reports` 404s the ENTIRE
    // Reports section — the catalog, all ten print-ready views and every report download — while
    // every suite stays green, because the suites compose their own app and the Vercel root is
    // executed by no test (e2e drives serve-api.ts).
    //
    // Its own slot rather than riding `dashboards` or `exports`, so this pin fails independently of
    // theirs: a root can have both of those wired and still ship a product whose Reports screen is
    // an error page. Verified by deleting this line from each root in turn and watching this test,
    // and only this test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultReportsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*reports:\s*defaultReportsDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes search deps to buildApp (T-038)', (path) => {
    // Same conditional-registration silence as its siblings: omitting `search` 404s `GET /search`,
    // so the top-bar type-ahead returns nothing on every keystroke (GlobalSearch.tsx swallows the
    // error into an empty dropdown) while every other screen keeps working — a dead search box no
    // suite notices, because the suites compose their own app and the Vercel root is executed by no
    // test (e2e drives serve-api.ts).
    //
    // Its own slot rather than riding `leads`, so this pin fails independently of the leads pin: a
    // root can wire the entire Leads surface and still ship a product whose search box is dead.
    // Verified by deleting this line from each root in turn and watching this test, and only this
    // test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultSearchDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*search:\s*defaultSearchDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes business-rules deps to buildApp (T-020)', (path) => {
    // Same conditional-registration silence as its siblings, with an unusually deceptive failure
    // mode: omitting `businessRules` 404s `/settings/business-rules`, and because that GET is a
    // MEMBERSHIP-ONLY read the SPA falls back to hard-coded default aging/SLA thresholds rather
    // than erroring — so every list, badge and SLA column keeps rendering, just with the wrong
    // tenant's numbers (BusinessRuleEndpoints.cs:13-22 records the reference breaking this way).
    // The suites compose their own app and the Vercel root is executed by no test and driven by no
    // e2e (e2e drives serve-api.ts). Verified by deleting this line from each root in turn and
    // watching this test, and only this test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultBusinessRulesDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*businessRules:\s*defaultBusinessRulesDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes alerts deps to buildApp (T-033)', (path) => {
    // Same conditional-registration silence as its siblings, and the quietest failure of the set:
    // omitting `alerts` 404s the whole Alerts Center AND the sidebar badge poll, which the SPA
    // treats as "no alerts" rather than as an error. The evaluation sweep keeps running and keeps
    // materializing rows nobody can see — a product whose entire purpose is that nothing at risk
    // goes unnoticed, silently noticing nothing. The suites compose their own app and the Vercel
    // root is executed by no test and driven by no e2e (e2e drives serve-api.ts). Verified by
    // deleting this line from each root in turn and watching this test, and only this test, go red.
    const contents = read(path);

    expect(contents).toContain('defaultAlertsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*alerts:\s*defaultAlertsDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes business-assignment deps to buildApp (T-020)', (path) => {
    // Omitting `assignments` 404s `/settings/business-assignments`, which is not only the Settings
    // tab: the leads Assign dialog reads it (membership-only, for exactly that reason) to resolve
    // the accountable-owner assignment id before it can look up eligible users, so lead assignment
    // stops working entirely. Same silence as above; verified the same way.
    const contents = read(path);

    expect(contents).toContain('defaultAssignmentsDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*assignments:\s*defaultAssignmentsDeps\(\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes api-access deps to buildApp (T-022)', (path) => {
    // Same conditional-registration silence as its siblings, with the sharpest consequence of the
    // set: omitting `apiAccess` 404s `/settings/api-credentials`, so a tenant can neither issue nor
    // — the part that matters — DISABLE an intake credential. Revoking a leaked API key becomes
    // impossible through the product, and every suite stays green, because the suites compose their
    // own app and the Vercel root is executed by no test and driven by no e2e (e2e drives
    // serve-api.ts). Verified by deleting this line from each root in turn and watching this test,
    // and only this test, go red.
    //
    // The `(config)` argument is pinned too, not just the slot: this factory alone needs the typed
    // config, because the API-key pepper is a static-tier secret (A-5) and `keys.ts`/`service.ts`
    // deliberately never read `process.env` themselves (AC-010).
    const contents = read(path);

    expect(contents).toContain('defaultApiAccessDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*apiAccess:\s*defaultApiAccessDeps\(config\)/s);
  });

  it.each(COMPOSITION_ROOTS)('%s passes intake deps to buildApp (T-030)', (path) => {
    // Omitting `intake` 404s `POST /intake/leads`, and the failure is INVISIBLE from inside the
    // product: no screen calls this endpoint, so every page keeps working while every partner
    // integration silently stops filing leads — the one surface whose users cannot tell anyone here
    // that it broke. Same conditional-registration silence as its siblings, and the same blind
    // spot: the suites compose their own app and the Vercel root is executed by no test.
    //
    // The `(config)` argument is pinned like `apiAccess`'s, and for the same reason: verifying a
    // presented key needs the pepper, which only the typed config module may read (AC-010).
    const contents = read(path);

    expect(contents).toContain('defaultIntakeDeps(');
    expect(contents).toMatch(/buildApp\(\{[^}]*intake:\s*defaultIntakeDeps\(config\)/s);
  });

  it.each(COMPOSITION_ROOTS)(
    '%s passes the alert re-evaluation seam to BOTH the leads and quotes slots (T-034)',
    (path) => {
      // The seam is what turns a completed workflow action into a queued `alert.reevaluate-lead`
      // message. It is OPTIONAL on both deps types (so test harnesses can compose an app without a
      // queue), which means a root that omits it produces an application that works perfectly and
      // simply never clears an alert within the minute — the 15-minute sweep hides it, and every
      // suite stays green because the suites compose their own app and no test executes these
      // roots.
      //
      // BOTH slots, because `app.ts` mounts `leadWorkflowRoutes(deps.leads)`: the twelve lead
      // operations read the seam from the leads slot while quote creation and the seven quote
      // operations read it from the quotes slot. Wiring one is a half-connected feature.
      const contents = read(path);

      expect(contents).toContain('defaultAlertReevaluationSeam(');
      expect(contents).toMatch(/leads:\s*defaultLeadsDeps\(onLeadChanged\)/s);
      expect(contents).toMatch(/quotes:\s*defaultQuotesDeps\(onLeadChanged\)/s);
    },
  );
});

describe('dashboard payload endpoints are mounted on the dashboards slot (T-037)', () => {
  /**
   * The composition-root pin above proves the `dashboards` DEPS are passed. It cannot see whether
   * the routers are actually MOUNTED, because that happens inside `buildApp`, and no other suite
   * can either: the dashboard suites register their router directly through `registerRoutes` so
   * they would stay green with these three lines deleted.
   *
   * That deletion is a silent failure of the worst shape available here — the shell renders, the
   * nav item is there, and only the three screens behind it answer 404 while every one of the 3000+
   * tests passes. Pinned on the source because the alternative (booting the app) needs a database
   * this assertion does not otherwise require.
   */
  const APP = 'src/server/lib/router/app.ts';

  it.each([
    ['broker-performance', 'brokerPerformanceRoutes'],
    ['rm-performance', 'rmPerformanceRoutes'],
    ['loss-analysis', 'lossAnalysisRoutes'],
  ])('mounts %s via %s', (_endpoint, routerName) => {
    const contents = read(APP);

    expect(contents).toContain(`import { ${routerName} }`);
    expect(contents).toContain(`api.route('/', ${routerName}(deps.dashboards));`);
  });
});

describe('public path policy', () => {
  it('exempts health and nothing else from authentication', () => {
    expect(PUBLIC_PATHS).toEqual([`${API_BASE_PATH}/health`]);
  });

  it('does not exempt the intake route, which authenticates with its own credentials (Q-19)', () => {
    expect(PUBLIC_PATHS.some((path) => path.includes('intake'))).toBe(false);
  });
});
