/**
 * Vercel function entrypoint for the versioned API surface (spec §8, A-19/Q-3b).
 *
 * The catch-all is the ONLY function serving /api/v1: routing happens inside the Hono app
 * (src/server/lib/router/app.ts), never through per-route function files.
 *
 * The app is built lazily and cached per cold start so that a configuration failure produces a
 * sanitized 500 (with a correlation id, and the real cause in the server log) rather than a raw
 * module-load crash.
 *
 * PLAIN FILENAME + AN EXPLICIT REWRITE, NOT A BRACKET CATCH-ALL. Vercel's zero-config `api/`
 * filesystem routing (this is a Vite SPA, not Next.js) has NO catch-all syntax: a `[...segments].ts`
 * filename is treated exactly like a single dynamic `[segments].ts`. `vercel build` emits
 * `"src": "^/api/v1/([^/]+)$"` for it — ONE path segment. So `/api/v1/leads` reached the router
 * while `/api/v1/leads/1`, `/api/v1/dashboards/executive`, `/api/v1/me/preferences` and every other
 * nested route answered Vercel's own `NOT_FOUND` page before the function was ever invoked.
 * Renaming `[[...segments]]` → `[...segments]` changed nothing, because both forms collapse to the
 * same one-segment regex.
 *
 * The whole `/api/v1` surface therefore reaches this function through the `rewrites` entry in
 * vercel.json (`/api/v1/:path*` → `/api/v1`). A Vercel rewrite only selects WHICH function serves
 * the request — the function still receives the ORIGINAL request URL — so Hono keeps matching real
 * paths like `/api/v1/leads/1` and needs no path rewriting of its own.
 *
 * Nothing local caught the original break: the dev server (scripts/dev/serve-api.ts) and every test
 * drive the Hono app directly, so Vercel's routing layer is exercised only by `vercel build`/deploy.
 */
import { handle } from 'hono/vercel';

import { defaultApiAccessDeps } from '../../src/server/domains/api-access/index.js';
import { defaultIntakeDeps } from '../../src/server/domains/intake/index.js';
import { defaultAlertsDeps } from '../../src/server/domains/alerts/index.js';
import { defaultAssignmentsDeps } from '../../src/server/domains/assignments/index.js';
import { defaultBrokersDeps } from '../../src/server/domains/brokers/index.js';
import { defaultBusinessRulesDeps } from '../../src/server/domains/business-rules/index.js';
import { defaultDashboardsDeps } from '../../src/server/domains/dashboards/index.js';
import { defaultExportsDeps } from '../../src/server/domains/exports/index.js';
import { defaultReportsDeps } from '../../src/server/domains/reports/index.js';
import { defaultSearchDeps } from '../../src/server/domains/search/index.js';
import { defaultLeadsDeps } from '../../src/server/domains/leads/index.js';
import {
  defaultAttachmentsDeps,
  defaultQuotesDeps,
} from '../../src/server/domains/quotes/index.js';
import { defaultPartiesDeps } from '../../src/server/domains/parties/index.js';
import {
  defaultGlobalTemplateDeps,
  defaultReferenceDataDeps,
} from '../../src/server/domains/reference-data/index.js';
import { defaultTenantsDeps } from '../../src/server/domains/tenants/index.js';
import { defaultMeDeps, defaultUserManagerDeps } from '../../src/server/domains/users/index.js';
import { defaultRbacDeps } from '../../src/server/domains/rbac/index.js';
import { defaultAuthDeps } from '../../src/server/lib/auth/index.js';
import { getConfig } from '../../src/server/lib/config/index.js';
import { problemResponse } from '../../src/server/lib/errors/problem.js';
import { logger, resolveCorrelationId } from '../../src/server/lib/logging/index.js';
import { defaultAlertReevaluationSeam } from '../../src/server/jobs/runtime.js';
import { buildApp } from '../../src/server/lib/router/app.js';
import { defaultTenancyDeps } from '../../src/server/lib/tenancy/index.js';

export const config = {
  runtime: 'nodejs',
} as const;

let cachedHandler: ((request: Request) => Response | Promise<Response>) | null = null;

function getHandler(): (request: Request) => Response | Promise<Response> {
  const config = getConfig();
  // The T-034 alert re-evaluation seam. It is supplied to BOTH the leads slot and the quotes slot:
  // `app.ts` mounts `leadWorkflowRoutes(deps.leads)`, so the twelve lead operations take theirs
  // from the leads slot while quote creation and the seven quote operations take theirs from the
  // quotes slot. Wiring only one of them would leave half the workflow surface converging on the
  // 15-minute sweep instead of within the minute, with every suite still green.
  const onLeadChanged = defaultAlertReevaluationSeam(config);
  cachedHandler ??= handle(
    buildApp({
      config,
      auth: defaultAuthDeps(config),
      tenancy: defaultTenancyDeps(),
      rbac: defaultRbacDeps(),
      me: defaultMeDeps(),
      tenants: defaultTenantsDeps(),
      globalTemplate: defaultGlobalTemplateDeps(),
      userManager: defaultUserManagerDeps(),
      referenceData: defaultReferenceDataDeps(),
      brokers: defaultBrokersDeps(),
      parties: defaultPartiesDeps(),
      leads: defaultLeadsDeps(onLeadChanged),
      quotes: defaultQuotesDeps(onLeadChanged),
      attachments: defaultAttachmentsDeps(config),
      dashboards: defaultDashboardsDeps(),
      exports: defaultExportsDeps(),
      reports: defaultReportsDeps(),
      search: defaultSearchDeps(),
      businessRules: defaultBusinessRulesDeps(),
      alerts: defaultAlertsDeps(),
      assignments: defaultAssignmentsDeps(),
      apiAccess: defaultApiAccessDeps(config),
      intake: defaultIntakeDeps(config),
    }),
  );
  return cachedHandler;
}

async function serve(request: Request): Promise<Response> {
  try {
    return await getHandler()(request);
  } catch (error) {
    // Reached only when the app itself cannot be constructed (invalid environment): the in-app
    // error boundary handles everything after that point.
    const correlationId = resolveCorrelationId(request.headers);
    logger.error('failed to serve request: the API application could not be built', {
      correlationId,
      err: error,
    });
    return problemResponse(error, correlationId);
  }
}

// NAMED METHOD EXPORTS, NOT `export default`. Vercel's Node runtime invokes a default export with
// the legacy `(req, res)` signature and IGNORES anything it returns — so this function built a
// correct Response, handed it back, and then sat until the 30s wall clock killed it. Every request
// to /api/v1 timed out that way, while the suite stayed green because it drives the Hono app
// directly with Web Request objects and never goes through Vercel's invocation contract.
//
// One catch-all serves the whole versioned surface (routing happens inside Hono, per the note at
// the top of this file), so every method the API answers has to be listed here — an unlisted verb
// is a 405 from the platform that never reaches the router.
export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const HEAD = serve;
export const OPTIONS = serve;
