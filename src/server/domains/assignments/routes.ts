/**
 * Business-assignment slot routes (T-020, AC-022, AC-024, AC-038; V-027, V-031, V-049; spec §12).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/BusinessAssignmentEndpoints.cs:33-39`:
 *
 *   GET /api/v1/settings/business-assignments   (none — tenant membership only)  (:37)
 *   PUT /api/v1/settings/business-assignments   business_assignments.manage      (:38)
 *
 * THE READ IS UNGATED BEYOND MEMBERSHIP — A BUG FIX, NOT A RELAXATION
 * ==================================================================
 * The endpoint's own doc comment (:14-25) records that the GET WAS gated by
 * `business_assignments.view` and that the gate was removed on 2026-07-13 because it 403'd the
 * Owner filter and the Assign dialog for every leads user: every tenant member composing an Assign
 * dialog needs the slot configuration to resolve the accountable-owner assignment id BEFORE it can
 * look up eligible assignees. The SPA still records this (`leadsApi.ts:189-190`). Re-adding the
 * permission would re-break the leads screens, so the suite pins a plain tenant member's 200 on GET
 * alongside their 403 on PUT. `business_assignments.view` remains the Settings-tab UI gate.
 *
 * THE TWO PICKER ROUTES ARE MEMBERSHIP-ONLY, MEASURED FROM THE ROUTE TABLE
 * =======================================================================
 *   GET /api/v1/settings/business-assignments/eligible-users       (none — membership only)  (:36)
 *   GET /api/v1/settings/business-assignments/eligible-approvers   (none — membership only)  (:37)
 *
 * Neither carries `.RequirePermission(...)`, unlike the PUT at :35 — this is the route table's
 * plain text, not an inference from the route names. The endpoint header (:14-25) gives the
 * rationale: these are PICKERS. Every tenant member composing an Assign dialog needs them, and
 * gating them behind `business_assignments.view` (a Settings-admin permission) 403'd the Owner
 * filter and the Assign dialog for every leads user until the gate was removed on 2026-07-13.
 * The suite pins BOTH directions — a member holding no assignment grant gets 200, a non-member
 * gets 403 — so neither re-adding the gate nor dropping the membership requirement can pass.
 *
 * These two were added to T-020 by the orchestrator after the first pass flagged them as unowned
 * (no other task file mentioned them, while the SPA calls both).
 *
 * TENANT SCOPE COMES FROM THE MIDDLEWARE, NEVER FROM THE ROUTE
 * ===========================================================
 * Both handlers read `c.get('tenant')`, the verified `TenantContext`. There is no database-level net
 * beneath the resulting predicates (Postgres RLS is not adopted, spec Q-10), so `actorFrom` throwing
 * rather than defaulting is load-bearing. `isCrossTenant` is carried through because the role
 * visibility rule needs it (service.ts) — and it comes from the middleware's verification, not from
 * anything the caller sent.
 *
 * MEASURED RESPONSE SHAPES (BusinessAssignmentEndpoints.cs)
 * ========================================================
 *   get -> 200 BusinessAssignmentsDto  (:47)
 *   put -> 200 BusinessAssignmentsDto  (:59)  — the stored result, not an echo
 *   invalid role      -> 422 BUSINESS_ASSIGNMENTS_ROLE_INVALID       (:95)
 *   same role twice   -> 422 BUSINESS_ASSIGNMENTS_VALIDATION_FAILED  (:95)
 *   clearing in use   -> 409 ASSIGNMENT_ROLE_IN_USE                  (:90)
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, UnauthorizedError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import type { TenantId } from '../../lib/db/index.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import {
  assignmentsValidationError,
  invalidQueryParameterError,
  unreadableBodyError,
} from './errors.js';
import {
  eligibleApproversQuerySchema,
  eligibleUsersQuerySchema,
  updateBusinessAssignmentsSchema,
} from './schemas.js';
import {
  getBusinessAssignments,
  getEligibleApprovers,
  getEligibleAssignees,
  updateBusinessAssignments,
  type AssignmentsActor,
  type AssignmentsDeps,
} from './service.js';

import type { Context } from 'hono';

const PATH = '/settings/business-assignments';

async function readJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw unreadableBodyError();
  }
}

/** The VERIFIED tenant and cross-tenant flag, plus the acting user. Fails CLOSED, never defaults. */
function actorFrom(c: Context<ApiEnv>): AssignmentsActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Business-assignments route reached with no verified tenant context; refusing to run an unscoped query.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    isCrossTenant: tenant.isCrossTenant,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

export function businessAssignmentRoutes(deps: AssignmentsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  routes.get(PATH, async (c) => c.json(await getBusinessAssignments(deps, actorFrom(c))));

  routes.put(PATH, requirePermission('business_assignments.manage'), async (c) => {
    // Deliberately NOT `lib/validation`'s `parseOrThrow`: that helper throws the generic
    // `VALIDATION_FAILED` code, while this endpoint's mapper emits
    // `BUSINESS_ASSIGNMENTS_VALIDATION_FAILED` — the code the SPA reads.
    const parsed = updateBusinessAssignmentsSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) throw assignmentsValidationError(toFieldErrors(parsed.error));

    return c.json(await updateBusinessAssignments(deps, parsed.data, actorFrom(c)));
  });

  // The two picker routes. Registered with NO `requirePermission(...)` — see the header; that
  // absence is the measured contract, and the suite pins it from both directions.
  //
  // Both are mounted BEFORE nothing and AFTER nothing in particular: Hono matches these literal
  // sub-paths independently of the bare `PATH` above, so ordering carries no meaning here.

  routes.get(`${PATH}/eligible-users`, async (c) => {
    // A REQUIRED `long` query binding in the reference, so a missing or unparseable value is a
    // model-binding 400 rather than a 422 — deliberately not routed through the domain's
    // `*_VALIDATION_FAILED` mapper, which would report the wrong class of failure.
    const parsed = eligibleUsersQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw invalidQueryParameterError(
        parsed.error.issues.map((issue) => issue.message.split('|').at(-1)).join('; '),
      );
    }

    const { assignmentId, search } = parsed.data;
    return c.json(await getEligibleAssignees(deps, assignmentId, search ?? null, actorFrom(c)));
  });

  routes.get(`${PATH}/eligible-approvers`, async (c) => {
    const parsed = eligibleApproversQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw invalidQueryParameterError(
        parsed.error.issues.map((issue) => issue.message.split('|').at(-1)).join('; '),
      );
    }

    return c.json(await getEligibleApprovers(deps, parsed.data.search ?? null, actorFrom(c)));
  });

  return routes;
}
