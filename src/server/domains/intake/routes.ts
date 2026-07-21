/**
 * The intake ingress: `POST /api/v1/intake/leads` (T-030, AC-061; V-077, V-078).
 *
 * Port of `IntakeEndpoints.Map` (:25-30) minus the rate-limiting policy, which is deferred (A-20 /
 * Q-17) and is FLAGGED in the task file rather than half-built here.
 *
 * THIS ROUTER IS MOUNTED OUTSIDE THE SESSION-AUTH GROUP, AND THAT PLACEMENT IS THE SECURITY BOUNDARY
 * ==================================================================================================
 * `app.ts` registers it BEFORE the authentication middleware, so a request here never reaches the
 * Supabase session check — exactly as the reference exempted this route from `TenantContextMiddleware`
 * and gave it its own scheme (:19-21). Two failure modes bracket that decision and both are pinned
 * by tests:
 *
 *   - mounted INSIDE the `/api/v1` session group, every integrator would get a 401 from the wrong
 *     middleware and no key would ever work;
 *   - mounted before the session group but WITHOUT `apiKeyAuth`, the route would be a completely
 *     unauthenticated public write endpoint into every tenant. That is the catastrophic direction,
 *     which is why the middleware is attached HERE — on the router itself, next to the handler it
 *     guards — rather than in `app.ts` where a reordering could separate them.
 *
 * Adding the path to `PUBLIC_PATHS` would have been the other way to bypass session auth, and is
 * deliberately NOT done: that list means "served with no credentials at all", which this route is
 * not. `auth-wiring.test.ts` already pins intake's absence from it.
 *
 * MEASURED RESPONSE SHAPES (IntakeEndpoints.cs:92-108)
 * ===================================================
 *   success -> 201 `{ leadId, leadRef, warnings }`
 *   failure -> 422 problem+json with `errors: [{ field, code, message }]`
 *   bad key -> 401 problem+json, ONE identical body for all five failure modes (auth.ts)
 *
 * There is no `Location` header: the reference emits none (:106-108), and the created lead is not
 * readable through this credential anyway — reading a lead needs a session and `leads.view`.
 */
import { Hono } from 'hono';

import type { ApiAccessDeps } from '../api-access/index.js';
import { InternalError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { leadValidationError, unreadableBodyError } from '../leads/errors.js';
import { apiKeyAuth } from './auth.js';
import { intakeLeadSchema } from './schemas.js';
import { intakeLead, type IntakeDeps } from './service.js';

import type { Context } from 'hono';

export interface IntakeRouteDeps extends IntakeDeps {
  /** The verification seam plus the pepper — `verifyApiKey`'s dependencies (T-022). */
  readonly apiAccess: ApiAccessDeps;
}

/**
 * Validation failures land in the intake `errors[]` contract, not the leads one.
 *
 * `AppError(422, ..., { fieldErrors })` renders as `errors: [{field, code, message}]` through the
 * app-wide problem mapper (problem.ts:12 names this very endpoint as the shape's origin), so the
 * reference's structured body is produced by the existing boundary rather than a bespoke response.
 */
function parseOr422(value: unknown) {
  const result = intakeLeadSchema.safeParse(value);
  if (!result.success) throw leadValidationError(toFieldErrors(result.error));
  return result.data;
}

async function readJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw unreadableBodyError();
  }
}

export function intakeRoutes(deps: IntakeRouteDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.post('/intake/leads', apiKeyAuth(deps.apiAccess), async (c) => {
    const input = parseOr422(await readJsonBody(c));

    // Set by `apiKeyAuth` and by nothing else. Its absence means the middleware was detached from
    // the handler, which must fail CLOSED with a 500 rather than run unauthenticated and unscoped.
    const credential = c.get('credential');
    if (credential === undefined) {
      throw new InternalError(
        'Intake route reached with no verified credential; refusing to ingest unauthenticated.',
      );
    }

    const correlationId = c.get('correlationId');
    const outcome = await intakeLead(
      deps,
      input,
      credential,
      correlationId,
    );

    return c.json(outcome, 201);
  });

  return routes;
}
