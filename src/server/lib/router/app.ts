/**
 * The /api/v1 Hono application (spec §9.2, A-19, M-04, T-009).
 *
 * One app, one function: `api/v1/[...segments].ts` is the only entrypoint, and every route is
 * composed in here via `app.route(...)`. There are no per-route Vercel functions.
 *
 * Middleware order (spec §9.2). The two slots are intentionally empty and are filled by later
 * tasks without reordering anything around them:
 *
 *   1. security headers        — outermost, so even 401/403/404/500 carry them (parity with the
 *                                .NET SecurityHeadersMiddleware, which ran first for that reason)
 *   2. request context         — correlation id resolved/generated, request logger attached
 *   3. request logging         — one JSON line per request on the way out (correlationId, route,
 *                                status, durationMs, plus userId/tenantId once the slots fill)
 *   4. error boundary          — turns anything thrown below it into problem+json; sits *inside*
 *                                logging so the log line records the mapped status, and *outside*
 *                                auth/tenant so their 401/403s are mapped too
 *   5. AUTH SLOT               — EMPTY (T-011): Supabase access-token verification -> c.set('userId')
 *   6. tenant context          — X-Tenant-Id verified server-side (T-013) -> c.set('tenantId')
 *   7. routes                  — health + domain routers
 *
 * `app.onError` remains registered as a last-resort net for anything thrown above the boundary.
 */
import { Hono } from 'hono';

import {
  authenticate,
  permissionResolution,
  type AuthenticateDeps,
  type PermissionResolutionDeps,
} from '../auth/index.js';
import type { AppConfig } from '../config/index.js';
import { problemResponse, PROBLEM_JSON_CONTENT_TYPE } from '../errors/problem.js';
import { NotFoundError } from '../errors/index.js';
import {
  CORRELATION_ID_HEADER,
  requestLogger,
  resolveCorrelationId,
  type LoggerOptions,
} from '../logging/index.js';
import { tenantContext, type TenantContextDeps } from '../tenancy/index.js';
import { healthRoutes } from '../../domains/health/routes.js';
import { meRoutes } from '../../domains/users/me.routes.js';
import type { MeDeps } from '../../domains/users/me.service.js';
import { userRoutes } from '../../domains/users/routes.js';
import type { UsersDeps } from '../../domains/users/service.js';
import { groupRoutes } from '../../domains/rbac/groups.routes.js';
import { permissionRoutes } from '../../domains/rbac/permissions.routes.js';
import { roleRoutes } from '../../domains/rbac/roles.routes.js';
import { apiAccessRoutes } from '../../domains/api-access/routes.js';
import type { ApiAccessDeps } from '../../domains/api-access/service.js';
import { intakeRoutes } from '../../domains/intake/routes.js';
import type { IntakeRouteDeps } from '../../domains/intake/routes.js';
import { alertRoutes } from '../../domains/alerts/routes.js';
import type { AlertsDeps } from '../../domains/alerts/service.js';
import { businessAssignmentRoutes } from '../../domains/assignments/routes.js';
import type { AssignmentsDeps } from '../../domains/assignments/service.js';
import { brokerRoutes } from '../../domains/brokers/routes.js';
import type { BrokersDeps } from '../../domains/brokers/service.js';
import { businessRulesRoutes } from '../../domains/business-rules/routes.js';
import type { BusinessRulesDeps } from '../../domains/business-rules/service.js';
import { dashboardRoutes } from '../../domains/dashboards/drill.routes.js';
import { brokerPerformanceRoutes } from '../../domains/dashboards/broker.routes.js';
import { rmPerformanceRoutes } from '../../domains/dashboards/rm.routes.js';
import { lossAnalysisRoutes } from '../../domains/dashboards/loss.routes.js';
import { executiveDashboardRoutes } from '../../domains/dashboards/executive.routes.js';
import { pipelineDashboardRoutes } from '../../domains/dashboards/pipeline.routes.js';
import type { DashboardsDeps } from '../../domains/dashboards/drill.service.js';
import { exportRoutes } from '../../domains/exports/routes.js';
import type { ExportsDeps } from '../../domains/exports/service.js';
import { reportRoutes } from '../../domains/reports/routes.js';
import type { ReportsDeps } from '../../domains/reports/service.js';
import { leadRoutes } from '../../domains/leads/routes.js';
import { leadTimelineRoutes } from '../../domains/leads/timeline.routes.js';
import { leadWorkflowRoutes } from '../../domains/leads/workflow/routes.js';
import type { LeadsDeps } from '../../domains/leads/service.js';
import { quoteRoutes } from '../../domains/quotes/routes.js';
import type { QuotesDeps } from '../../domains/quotes/service.js';
import { attachmentRoutes } from '../../domains/quotes/attachments.routes.js';
import type { AttachmentsDeps } from '../../domains/quotes/attachments.service.js';
import { partyRoutes } from '../../domains/parties/routes.js';
import type { PartiesDeps } from '../../domains/parties/service.js';
import { searchRoutes } from '../../domains/search/routes.js';
import type { SearchDeps } from '../../domains/search/service.js';
import { globalTemplateRoutes } from '../../domains/reference-data/global-template.routes.js';
import type { GlobalTemplateDeps } from '../../domains/reference-data/global-template.routes.js';
import { referenceDataRoutes } from '../../domains/reference-data/routes.js';
import type { ReferenceDataDeps } from '../../domains/reference-data/service.js';
import { tenantRoutes } from '../../domains/tenants/routes.js';
import type { TenantsDeps } from '../../domains/tenants/service.js';
import type { ApiEnv } from './env.js';

export type { ApiEnv, RequestVariables } from './env.js';

export const API_BASE_PATH = '/api/v1';

/** Reported by GET /health. A build/commit stamp can be threaded in via `deps.version` later. */
export const API_VERSION = 'v1';

/**
 * Paths served without a bearer token. Health is the .NET `AllowAnonymous` health endpoint.
 * The Q-19 hashed-API-key intake route (T-030) does NOT belong here: it authenticates with its
 * own credential middleware rather than by being exempted from authentication.
 */
export const PUBLIC_PATHS: readonly string[] = [`${API_BASE_PATH}/health`];

const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

/** Static header set ported from src/api/QuoteIQ.Api/Security/SecurityHeadersMiddleware.cs. */
const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['X-Content-Type-Options', 'nosniff'],
  ['Referrer-Policy', 'no-referrer'],
  ['X-Frame-Options', 'DENY'],
  ['Content-Security-Policy', "frame-ancestors 'none'"],
];

export type ApiApp = Hono<ApiEnv>;

export interface AppDeps {
  readonly config: AppConfig;
  /** Injected by tests to capture log output; production uses the default stdout sink. */
  readonly loggerOptions?: LoggerOptions;
  /** Database handle, narrowed by T-008; carried here so handlers never reach for a module global. */
  readonly db?: unknown;
  readonly version?: string;
  /**
   * Authentication ports (T-011). Omitted only by test harnesses that deliberately exercise the
   * pipeline anonymously; production roots pass `defaultAuthDeps(config)`.
   */
  readonly auth?: AuthenticateDeps;
  /**
   * Effective-permission resolution port (T-012). Required by every route using
   * `requirePermission(...)`; when omitted, such a route fails CLOSED with a 500 rather than
   * allowing the request.
   */
  readonly rbac?: PermissionResolutionDeps;
  /**
   * Tenant-context ports (T-013). Required for any tenant-scoped route to be reachable: without
   * it the tenant slot is empty, no `tenantId` is ever set, and a tenant-scoped handler would run
   * with no verified tenant. Production roots always pass it.
   */
  readonly tenancy?: TenantContextDeps;
  /**
   * Session-surface ports (T-015). When omitted, `/me` and `/me/preferences` are simply not
   * registered and answer 404 — the SPA cannot bootstrap at all, which is a loud failure rather
   * than a silent one. Optional only so a test harness can build the pipeline without a database;
   * every production root must pass it (pinned by tests/integration/auth-wiring.test.ts).
   */
  readonly me?: MeDeps;
  /**
   * Tenant Manager ports (T-016). Omitted only by test harnesses; when absent the cross-tenant
   * `/tenants` surface is simply not registered and answers 404. Every route it registers carries
   * its own global `requirePermission(...)` guard, so mounting it grants nothing by itself.
   */
  readonly tenants?: TenantsDeps;
  /** Global default-template ports (T-016): `/global/default-reference-items`. */
  readonly globalTemplate?: GlobalTemplateDeps;
  /**
   * User Manager ports (T-017): `/users`, `/roles`, `/groups`, `/permissions`. ONE slot for all
   * four routers because they are one feature — a root wiring three of them would ship a User
   * Manager whose group tab 404s. Omitted only by test harnesses; when absent the whole surface is
   * unregistered and answers 404, which `tests/integration/auth-wiring.test.ts` pins against.
   */
  readonly userManager?: UsersDeps;
  /**
   * Tenant reference-data ports (T-019): `/settings/reference-data/*`. THE FIRST TENANT-SCOPED
   * SURFACE IN THIS APP — everything above it is on `GLOBAL_ROUTE_PREFIXES`. Omitted only by test
   * harnesses; when absent the whole Settings reference surface answers 404, taking the intake and
   * filter dropdowns of every screen with it, while every suite stays green (the suites compose
   * their own app and no test executes the Vercel root). Pinned by
   * `tests/integration/auth-wiring.test.ts`.
   */
  readonly referenceData?: ReferenceDataDeps;
  /**
   * Broker administration ports (T-021): `/brokers` and its `/contacts` subresource. Tenant-scoped
   * like `referenceData`, and omitted only by test harnesses; when absent the whole broker surface
   * answers 404, which takes the Settings brokers tab AND the broker picker in every leads filter
   * row, the intake form and every dashboard filter bar with it, while every suite stays green (the
   * suites compose their own app and no test executes the Vercel root). Pinned by
   * `tests/integration/auth-wiring.test.ts`.
   */
  readonly brokers?: BrokersDeps;
  /**
   * Parties ports (T-023): `/parties`, its `/{id}` detail and its `/{id}/leads` card. Tenant-scoped
   * like `referenceData` and `brokers`, and omitted only by test harnesses; when absent the whole
   * Parties surface answers 404, which takes the Parties screen AND the party picker that lead
   * intake depends on with it, while every suite stays green (the suites compose their own app and
   * no test executes the Vercel root). Pinned by `tests/integration/auth-wiring.test.ts`.
   */
  readonly parties?: PartiesDeps;
  /**
   * Leads ports (T-024): `/leads`, its `/{id}` detail/edit and `/leads/bulk-reassign`.
   * Tenant-scoped like `parties`, and omitted only by test harnesses; when absent the entire Leads
   * surface answers 404 — the Leads list, lead intake and Lead Detail all fail while every suite
   * stays green (the suites compose their own app and no test executes the Vercel root). Pinned by
   * `tests/integration/auth-wiring.test.ts`.
   *
   * ALSO serves T-025's twelve `POST /leads/{id}/operations/{op}` workflow routes, which need the
   * same `{ db }` and nothing more — see the mount below for why they do not get their own slot.
   *
   * ALSO serves T-029's `GET /leads/{id}/timeline`, for the same reason: it reads the same
   * tenant-scoped lead surface and needs the same `{ db }`.
   */
  readonly leads?: LeadsDeps;
  /**
   * Quote ports (T-026): `POST/GET /leads/{id}/quotes`, `GET/PUT /quotes/{id}`, the six
   * `POST /quotes/{id}/operations/{op}` routes and `POST /quotes/{id}/set-current`.
   *
   * A SEPARATE SLOT FROM `leads`, unlike the lead workflow routes which deliberately ride the leads
   * slot. The distinction is not stylistic: quotes are their own domain with their own permission
   * family (`quotes.*`), their own deps type (it carries the T-034 `onLeadChanged` alert seam that
   * `LeadsDeps` does not), and — critically — omitting them must not be able to silently disable
   * the LEAD surface or vice versa. Composing the leads slot without this one yields a working lead
   * detail whose Quotes card 404s, which is a visible failure; folding them together would make
   * "quotes are wired" untestable independently.
   */
  readonly quotes?: QuotesDeps;
  /**
   * Quote-attachment ports (T-027): `POST/GET /quotes/{id}/attachments`,
   * `POST /attachments/{id}/confirm`, `GET/DELETE /attachments/{id}`.
   *
   * A SEPARATE SLOT FROM `quotes`, and unlike the lead-workflow routes it does NOT ride its
   * domain's slot. The reason is its EXTRA dependency: this is the only surface in the app that
   * needs a `StorageAdapter` as well as a database (A-6). Folding it into `QuotesDeps` would force
   * every composition root that wants quotes to construct a storage adapter — including the test
   * harnesses that have no bucket — and would make "quotes are wired" and "storage is wired" one
   * untestable claim. Omitted only by test harnesses; when absent the whole attachment surface
   * answers 404, so a quote's documents silently cannot be added, listed or downloaded while every
   * suite stays green (the suites compose their own app and no test executes the Vercel root).
   * Pinned by `tests/integration/auth-wiring.test.ts`.
   */
  readonly attachments?: AttachmentsDeps;
  /**
   * Dashboard framework ports (T-035): `GET /dashboards/drill`, the shared drill-through endpoint
   * every dashboard chart's chevron calls.
   *
   * Tenant-scoped, and omitted only by test harnesses; when absent the drill answers 404, so every
   * dashboard still RENDERS — the charts and KPI cards are computed by their own endpoints — but
   * nothing in them can be clicked through to the underlying records. That is a quieter failure
   * than a blank screen and therefore a more dangerous one: the numbers look right and become
   * unverifiable, which is precisely the trust property drill-through exists to provide. Every
   * suite would stay green (the suites compose their own app and no test executes the Vercel
   * root). Pinned by `tests/integration/auth-wiring.test.ts`.
   *
   * The five dashboard endpoints themselves (T-036/T-037) mount on this same slot as they land.
   */
  readonly dashboards?: DashboardsDeps;
  /**
   * Export ports (T-039): `GET /exports/leads`, `/exports/parties` and `/exports/dashboard`.
   *
   * Tenant-scoped, and omitted only by test harnesses; when absent every Export/Download button in
   * the product 404s. That failure is loud for the user but silent for the suites, in the same way
   * its siblings are — the suites compose their own app and the Vercel root is executed by no test
   * (e2e drives serve-api.ts). Pinned by `tests/integration/auth-wiring.test.ts`.
   *
   * A SEPARATE SLOT FROM `leads`/`parties`/`dashboards`, even though it reads all three, because it
   * carries its own permission family (`*.export` plus the Internal-only
   * `global.cross_tenant_export` gate) and its own documented size limit. Folding it into any one of
   * them would make "the Leads list is wired" and "bulk extraction of the Leads list is wired" a
   * single untestable claim, and those are deliberately different privileges.
   */
  readonly exports?: ExportsDeps;
  /**
   * Report ports (T-040): `GET /reports`, `/reports/{key}` and `/reports/{key}/csv`.
   *
   * Tenant-scoped, and omitted only by test harnesses; when absent the entire Reports section 404s
   * — the catalog, every print-ready view and every report download. That failure is loud for the
   * user and silent for the suites, exactly like its siblings: the suites compose their own app and
   * the Vercel root is executed by no test (e2e drives serve-api.ts). Pinned by
   * `tests/integration/auth-wiring.test.ts`.
   *
   * A SEPARATE SLOT FROM `dashboards` and `exports`, even though it reads through both, because it
   * carries its own permission family (`reports.view` plus a PER-REPORT binding permission the
   * route guard cannot see) and its own catalog. Folding it into `dashboards` would make "the
   * dashboards are wired" and "the printable reports over them are wired" one untestable claim.
   */
  readonly reports?: ReportsDeps;
  /**
   * Global search ports (T-038): `GET /search`, the top-bar type-ahead across leads, quotes,
   * parties and brokers. Tenant-scoped, and omitted only by test harnesses; when absent the endpoint
   * answers 404 and the top-bar search silently returns nothing on every keystroke while every other
   * screen keeps working — the suites compose their own app and the Vercel root is executed by no
   * test (e2e drives serve-api.ts). Its own slot rather than riding `leads`, so this pin fails
   * independently: a root can wire the whole Leads surface and still ship a dead search box. Pinned
   * by `tests/integration/auth-wiring.test.ts`.
   */
  readonly search?: SearchDeps;
  /**
   * Tenant business-rules ports (T-020): `/settings/business-rules`. Tenant-scoped like
   * `referenceData`, and omitted only by test harnesses; when absent the Settings business-rules
   * tab answers 404 AND — because the GET is a membership-only read that the lead form, the aging
   * badges and the SLA columns all fetch — every screen silently falls back to hard-coded default
   * thresholds, which is the exact failure the reference recorded on 2026-07-13. Every suite would
   * stay green (the suites compose their own app and no test executes the Vercel root). Pinned by
   * `tests/integration/auth-wiring.test.ts`.
   */
  readonly businessRules?: BusinessRulesDeps;
  /**
   * Alerts Center ports (T-033): `/alerts`, `/alerts/summary`, `/alerts/badge` and the badge reset.
   *
   * Tenant-scoped, and omitted only by test harnesses; when absent the Alerts Center answers 404 AND
   * the sidebar badge poll fails silently, so users are shown NO outstanding alerts rather than an
   * error — the alerts stay open in the database, fully reconciled by the sweep, and simply never
   * surface. That is the failure mode this product can least afford to make quiet: the whole point
   * of the alert domain is that nothing at risk goes unnoticed. Every suite would stay green (the
   * suites compose their own app and no test executes the Vercel root). Pinned by
   * `tests/integration/auth-wiring.test.ts`.
   */
  readonly alerts?: AlertsDeps;
  /**
   * Business-assignment slot ports (T-020): `/settings/business-assignments`. Tenant-scoped, and
   * omitted only by test harnesses; when absent the Settings assignments tab answers 404 AND the
   * leads Assign dialog cannot resolve the accountable-owner assignment id at all, because that
   * read is membership-only for exactly that reason. Same silence as its siblings. Pinned by
   * `tests/integration/auth-wiring.test.ts`.
   */
  readonly assignments?: AssignmentsDeps;
  /**
   * API-credential administration ports (T-022): `/settings/api-credentials` and its broker-scoped
   * variant. Tenant-scoped, and omitted only by test harnesses; when absent the Settings API-access
   * tab and the broker API section both answer 404, so no tenant can issue, rotate or DISABLE an
   * intake credential — the last of which is the one that matters, because revoking a leaked key
   * becomes impossible through the product. Same silence as its siblings: the suites compose their
   * own app, and the Vercel root is executed by no test and driven by no e2e (e2e drives
   * serve-api.ts). Pinned by `tests/integration/auth-wiring.test.ts`.
   *
   * Unlike its siblings this slot carries a SECRET (the key pepper), which is why its factory takes
   * `config`: the typed config module is the only reader of the environment (AC-010).
   */
  readonly apiAccess?: ApiAccessDeps;
  /**
   * Intake ingress ports (T-030): `POST /intake/leads`, the server-to-server lead-intake endpoint.
   *
   * UNLIKE EVERY OTHER SLOT, this one is mounted OUTSIDE the session-auth group — see the mounting
   * block below for why, and for what breaks in each direction if that placement moves. Omitted
   * only by test harnesses; when absent the endpoint answers 404 and every partner integration
   * stops filing leads, silently as far as the suites are concerned (they compose their own app,
   * and the Vercel root is executed by no test). Pinned by `tests/integration/auth-wiring.test.ts`.
   *
   * Takes `config` like `apiAccess` does, because verifying a presented key needs the pepper.
   */
  readonly intake?: IntakeRouteDeps;
  /** Composition hook for domain routers (and for tests that need a route to exercise). */
  readonly registerRoutes?: (app: ApiApp) => void;
}

function isDeployedEnvironment(config: AppConfig): boolean {
  return config.appEnv !== 'local';
}

export function buildApp(deps: AppDeps): ApiApp {
  const app = new Hono<ApiEnv>();
  const emitHsts = isDeployedEnvironment(deps.config);

  // 1. Security headers — applied on the way out so they survive a replaced response.
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of SECURITY_HEADERS) {
      c.header(name, value);
    }
    if (emitHsts) {
      c.header('Strict-Transport-Security', HSTS_VALUE);
    }
  });

  // 2. Request context: correlation id + request-scoped logger.
  app.use('*', async (c, next) => {
    const correlationId = resolveCorrelationId(c.req.raw.headers);
    c.set('correlationId', correlationId);
    c.set(
      'logger',
      requestLogger({ correlationId }, deps.loggerOptions ?? {}),
    );

    await next();

    c.header(CORRELATION_ID_HEADER, correlationId);
  });

  // 3. Request logging (AC-011, V-013). userId/tenantId are read *after* next() so the values the
  //    auth and tenant slots set are picked up once those slots are filled.
  app.use('*', async (c, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      const routePath = c.req.routePath;
      const route = routePath.includes('*') ? c.req.path : routePath;
      c.get('logger').info('request completed', {
        method: c.req.method,
        route: `${c.req.method} ${route}`,
        status: c.res.status,
        durationMs: Date.now() - startedAt,
        userId: c.get('userId'),
        tenantId: c.get('tenantId'),
      });
    }
  });

  // 4. Error boundary: every failure below becomes problem+json, and the real error is logged
  //    server-side through the redacting logger — never sent to the client.
  app.use('*', async (c, next) => {
    try {
      await next();
    } catch (error) {
      const correlationId = c.get('correlationId');
      c.get('logger').error('request failed', { err: error });
      c.res = problemResponse(error, correlationId);
    }
  });

  // 4b. INTAKE INGRESS — MOUNTED HERE ON PURPOSE, BETWEEN THE ERROR BOUNDARY AND THE AUTH SLOT.
  //
  //     `POST /intake/leads` authenticates with a first-party API key (Q-19), not a Supabase
  //     session, so it must not pass through the auth/tenant/permission slots below: there is no
  //     bearer token to verify and no `X-Tenant-Id` to resolve — the tenant comes from the
  //     credential row (spec §9.2, IntakeEndpoints.cs:19-21). Registering the router BEFORE those
  //     middlewares is what achieves that: Hono runs matching handlers in registration order, and
  //     this one answers without ever calling into them.
  //
  //     It IS still inside 1-4, which is deliberate and load-bearing in the other direction: the
  //     ingress gets security headers, a correlation id, the request log line and — most
  //     importantly — the error boundary, so a throw inside intake becomes problem+json rather than
  //     an unmapped 500 leaking internals to an external caller.
  //
  //     THE ROUTE IS NOT UNAUTHENTICATED. `intakeRoutes` attaches `apiKeyAuth()` to the handler
  //     itself, so the credential check cannot be separated from the route by an edit to this file.
  //     Moving this block BELOW the auth slot would 401 every integrator; deleting `apiKeyAuth`
  //     would make it a public write endpoint into every tenant. `intake.test.ts` pins both ends.
  if (deps.intake) {
    app.route(API_BASE_PATH, intakeRoutes(deps.intake));
  }

  // 5. AUTH SLOT — Supabase access-token verification (T-011).
  //    Scoped to /api/v1/* and skipping the public paths below; the middleware additionally lets
  //    unmatched paths fall through so an unknown route still answers 404, not 401 (V-017).
  //    `deps.auth` is optional so a test harness can exercise the pipeline anonymously; every
  //    production composition root must supply it, which
  //    src/server/tests/integration/auth-wiring.test.ts asserts.
  if (deps.auth) {
    app.use(`${API_BASE_PATH}/*`, authenticate({ publicPaths: PUBLIC_PATHS, ...deps.auth }));
  }

  // 6. TENANT SLOT — X-Tenant-Id resolution and membership verification (T-013).
  //    Mounted AFTER auth (it needs the principal) and BEFORE permission resolution (whose
  //    effective set is scoped to the tenant verified here). `deps.tenancy` is optional only so a
  //    test harness can exercise the pipeline without a database; every production composition root
  //    must supply it. Routes classified `global` (Tenant Manager, /global, /me, /intake, /health)
  //    pass through — see lib/tenancy/context.ts, where anything NOT on that explicit list is
  //    tenant-scoped and therefore fails closed.
  if (deps.tenancy) {
    app.use(`${API_BASE_PATH}/*`, tenantContext(deps.tenancy));
  }

  // 6b. Effective-permission resolution (T-012). Mounted AFTER auth (it needs the principal) and
  //     after the tenant slot (the resolved set is tenant-scoped), and BEFORE the routes whose
  //     `requirePermission(...)` guards read it. It only installs a per-request resolver — it
  //     never authorizes anything by itself, so mounting it on a route does not grant access.
  if (deps.rbac) {
    app.use(`${API_BASE_PATH}/*`, permissionResolution(deps.rbac));
  }

  // 7. Routes.
  const api = new Hono<ApiEnv>();
  api.route('/', healthRoutes(deps.version ?? API_VERSION));
  if (deps.me) {
    api.route('/', meRoutes(deps.me));
  }
  if (deps.tenants) {
    api.route('/', tenantRoutes(deps.tenants));
  }
  if (deps.globalTemplate) {
    api.route('/', globalTemplateRoutes(deps.globalTemplate));
  }
  if (deps.userManager) {
    const { db } = deps.userManager;
    api.route('/', userRoutes(deps.userManager));
    api.route('/', roleRoutes({ db }));
    api.route('/', groupRoutes({ db }));
    api.route('/', permissionRoutes({ db }));
  }
  if (deps.referenceData) {
    api.route('/', referenceDataRoutes(deps.referenceData));
  }
  if (deps.brokers) {
    api.route('/', brokerRoutes(deps.brokers));
  }
  if (deps.parties) {
    api.route('/', partyRoutes(deps.parties));
  }
  if (deps.leads) {
    api.route('/', leadRoutes(deps.leads));
    // T-025's twelve `POST /leads/{id}/operations/{op}` routes ride the SAME slot deliberately:
    // they need nothing `leadRoutes` does not already have (`{ db }`), so giving them their own
    // deps entry would create a composition root that can wire the leads surface while silently
    // omitting its workflow — a 404 on every action button with the list and detail still working.
    api.route('/', leadWorkflowRoutes(deps.leads));
    // T-029's `GET /leads/{id}/timeline`, same slot for the same reason.
    api.route('/', leadTimelineRoutes(deps.leads));
  }
  if (deps.quotes) {
    // T-026. Mounted after the leads slot because two of its routes are lead-subordinate
    // (`/leads/{id}/quotes`); Hono matches on the full path so the order is not load-bearing, but
    // keeping them adjacent makes the lead/quote surface readable as one block.
    api.route('/', quoteRoutes(deps.quotes));
  }
  if (deps.attachments) {
    // T-027. Registers BOTH the quote-subordinate attachment routes and the `/attachments/{id}`
    // family, mirroring the reference's two endpoint groups (`AttachmentEndpoints.cs:46,55`).
    // `/attachments/*` is not on GLOBAL_ROUTE_PREFIXES, so the tenant middleware classifies it as
    // tenant-scoped and it fails CLOSED without a verified tenant.
    api.route('/', attachmentRoutes(deps.attachments));
  }
  if (deps.dashboards) {
    // T-035. `/dashboards/*` is not on GLOBAL_ROUTE_PREFIXES, so the tenant middleware classifies
    // it as tenant-scoped and it fails CLOSED without a verified tenant — which for an aggregate
    // matters more than for a list, since an unscoped sum looks like a perfectly ordinary number.
    api.route('/', dashboardRoutes(deps.dashboards));
    // T-037's three payload endpoints ride the SAME slot, as the slot's own doc anticipated. They
    // need nothing `dashboardRoutes` does not already have (`{ db }`), and each carries its own
    // `dashboards.view_*` guard, so mounting them grants nothing by itself. Giving them separate
    // slots would create a composition root that can wire the drill while silently omitting the
    // dashboards it drills FROM — every chart 404ing with the chevron still working.
    api.route('/', brokerPerformanceRoutes(deps.dashboards));
    api.route('/', rmPerformanceRoutes(deps.dashboards));
    api.route('/', lossAnalysisRoutes(deps.dashboards));
    // T-036's two payload endpoints, on the same slot and for the same reasons. All five dashboards
    // mount together so a composition root cannot wire three of them and leave two 404ing.
    api.route('/', executiveDashboardRoutes(deps.dashboards));
    api.route('/', pipelineDashboardRoutes(deps.dashboards));
  }
  if (deps.exports) {
    // T-039. `/exports/*` is not on GLOBAL_ROUTE_PREFIXES, so the tenant middleware classifies it
    // as tenant-scoped and it fails CLOSED without a verified tenant — which matters most here, as
    // an unscoped BULK read hands over a whole table in one file rather than one page.
    api.route('/', exportRoutes(deps.exports));
  }
  if (deps.reports) {
    // T-040. `/reports/*` is not on GLOBAL_ROUTE_PREFIXES, so the tenant middleware classifies it
    // as tenant-scoped and it fails CLOSED without a verified tenant. A report is a bulk read whose
    // unscoped failure would not surface as one obvious foreign row but as a whole printable
    // document of another tenant's book.
    api.route('/', reportRoutes(deps.reports));
  }
  if (deps.search) {
    // T-038. `/search` is not on GLOBAL_ROUTE_PREFIXES, so the tenant middleware classifies it as
    // tenant-scoped and it fails CLOSED without a verified tenant — which matters for a search that
    // fans across four tables, since an unscoped hit is another tenant's lead/quote/party/broker.
    api.route('/', searchRoutes(deps.search));
  }
  if (deps.businessRules) {
    api.route('/', businessRulesRoutes(deps.businessRules));
  }
  if (deps.alerts) {
    // T-033. `/alerts/*` is not on GLOBAL_ROUTE_PREFIXES, so the tenant middleware classifies it as
    // tenant-scoped and it fails CLOSED without a verified tenant.
    api.route('/', alertRoutes(deps.alerts));
  }
  if (deps.assignments) {
    api.route('/', businessAssignmentRoutes(deps.assignments));
  }
  if (deps.apiAccess) {
    api.route('/', apiAccessRoutes(deps.apiAccess));
  }
  deps.registerRoutes?.(api);
  app.route(API_BASE_PATH, api);

  app.notFound((c) =>
    problemResponse(
      new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`),
      c.get('correlationId') ?? resolveCorrelationId(c.req.raw.headers),
    ),
  );

  app.onError((error, c) => {
    const correlationId = c.get('correlationId') ?? resolveCorrelationId(c.req.raw.headers);
    c.get('logger')?.error('unhandled error above the error boundary', { err: error });
    return problemResponse(error, correlationId);
  });

  return app;
}

export { PROBLEM_JSON_CONTENT_TYPE };
