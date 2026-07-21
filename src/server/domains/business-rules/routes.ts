/**
 * Tenant business-rules routes (T-020, AC-022, AC-024, AC-037; V-027, V-031, V-048; spec §12).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/BusinessRuleEndpoints.cs:26-32`, permission for permission:
 *
 *   GET /api/v1/settings/business-rules   (none — tenant membership only)  (:30)
 *   PUT /api/v1/settings/business-rules   business_rules.manage            (:31)
 *
 * THE READ IS DELIBERATELY UNGATED BEYOND MEMBERSHIP — AND THAT IS A BUG FIX, NOT A RELAXATION
 * ===========================================================================================
 * The endpoint's own doc comment (:13-22) records that the GET WAS gated by `business_rules.view`
 * and that the gate was removed on 2026-07-13: aging thresholds, SLA windows and expiry-alert days
 * drive list and detail rendering for EVERY tenant member, so the gate made non-admin roles fall
 * back to hard-coded default thresholds and 403'd the lead form's rules fetch. The SPA still
 * carries the scar tissue — `useTenantCurrency.ts:7` explains why the shell reads currency from the
 * membership payload instead of here, and `agingThresholds.ts:8` notes the read is now
 * membership-only. Re-adding the permission would re-break both, so the suite pins a plain tenant
 * member's 200 on GET alongside their 403 on PUT. `business_rules.view` remains the Settings-tab
 * UI gate and nothing more.
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * Both handlers read `c.get('tenant')`, the verified `TenantContext`, never the raw header. There
 * is no database-level net beneath the resulting predicates (Postgres RLS is not adopted, spec
 * Q-10), so `actorFrom` throwing rather than defaulting is load-bearing: a handler that ran with an
 * absent tenant would read or REWRITE settings with no tenant predicate at all.
 *
 * MEASURED RESPONSE SHAPES (BusinessRuleEndpoints.cs)
 * ==================================================
 *   get -> 200 BusinessRulesDto  (:38)
 *   put -> 200 BusinessRulesDto  (:66)   — the stored result, not an echo of the request
 *   missing settings row -> 404 BUSINESS_RULES_NOT_FOUND          (:74)
 *   validation failure   -> 422 BUSINESS_RULES_VALIDATION_FAILED  (:79)
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import type { TenantId } from '../../lib/db/index.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { businessRulesValidationError, unreadableBodyError } from './errors.js';
import { updateBusinessRulesSchema } from './schemas.js';
import {
  getBusinessRules,
  updateBusinessRules,
  type BusinessRulesActor,
  type BusinessRulesDeps,
} from './service.js';

import type { Context } from 'hono';

const PATH = '/settings/business-rules';

async function readJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw unreadableBodyError();
  }
}

/**
 * The VERIFIED tenant, plus the acting user.
 *
 * A missing tenant here is a composition fault (the route misclassified as global, or the tenancy
 * slot left unwired) and it fails CLOSED with a 500 rather than proceeding unscoped. There is no
 * fallback to the header, and there must never be one.
 */
function actorFrom(c: Context<ApiEnv>): BusinessRulesActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Business-rules route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function businessRulesRoutes(deps: BusinessRulesDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(PATH, async (c) => c.json(await getBusinessRules(deps, actorFrom(c))));

  routes.put(PATH, requirePermission('business_rules.manage'), async (c) => {
    // Deliberately NOT `lib/validation`'s `parseOrThrow`: that helper throws the generic
    // `VALIDATION_FAILED` code, while this endpoint's mapper emits
    // `BUSINESS_RULES_VALIDATION_FAILED` — which is what appears in `detail` and in the `code`
    // extension the SPA reads.
    const parsed = updateBusinessRulesSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) throw businessRulesValidationError(toFieldErrors(parsed.error));

    return c.json(await updateBusinessRules(deps, parsed.data, actorFrom(c)));
  });

  return routes;
}
