/**
 * The twelve lead workflow-operation routes (T-025; AC-047, AC-050, AC-096; V-061, V-064).
 *
 * Port of `LeadWorkflowEndpoints.Map` (:32-56), permission for permission:
 *
 *   POST /api/v1/leads/{id}/operations/assign                    leads.assign
 *   POST /api/v1/leads/{id}/operations/start-information-gathering  leads.update
 *   POST /api/v1/leads/{id}/operations/send-to-underwriting      leads.update
 *   POST /api/v1/leads/{id}/operations/start-pricing             leads.update
 *   POST /api/v1/leads/{id}/operations/request-pricing-approval  pricing.request
 *   POST /api/v1/leads/{id}/operations/approve-pricing           pricing.approve
 *   POST /api/v1/leads/{id}/operations/reject-pricing            pricing.reject
 *   POST /api/v1/leads/{id}/operations/log-follow-up             leads.update
 *   POST /api/v1/leads/{id}/operations/start-negotiation         leads.update
 *   POST /api/v1/leads/{id}/operations/mark-lost                 leads.close
 *   POST /api/v1/leads/{id}/operations/withdraw                  leads.close
 *   POST /api/v1/leads/{id}/operations/reopen                    leads.reopen
 *
 * THERE IS ONE LITERAL ROUTE PER OPERATION AND NO `/operations/:op` CATCH-ALL
 * ==========================================================================
 * A single parameterised route would have to look the permission up from the path segment at
 * request time, which means a typo'd or unknown op reaches a handler before any guard runs, and the
 * route table stops being a readable statement of what is gated by what. Twelve literal routes make
 * the permission map static and let an unknown op fall through to the app's 404, exactly as the
 * reference's twelve `MapPost` calls do.
 *
 * THERE IS DELIBERATELY NO STATUS-SET ENDPOINT (AC-047)
 * ====================================================
 * Status changes happen only through these named operations. Nothing here — and nothing in
 * `leads/routes.ts` — accepts a `statusId`; `updateLeadSchema` does not carry one. That absence is
 * the enforcement, and `lead-workflow.test.ts` asserts it against the composed route table rather
 * than trusting this comment.
 *
 * EVERY HANDLER RE-DERIVES THE ACTOR FROM VERIFIED CONTEXT
 * =======================================================
 * Same `actorFrom` discipline as `leads/routes.ts`: the tenant comes from the T-013 middleware's
 * verified `TenantContext`, never the raw header, and a missing tenant or resolver is a composition
 * fault that fails CLOSED with a 500 rather than proceeding unscoped. `isSystemActor` is never set
 * here — no HTTP caller can become the system actor.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../../lib/errors/index.js';
import type { TenantId } from '../../../lib/db/index.js';
import type { ApiEnv } from '../../../lib/router/env.js';
import { toFieldErrors } from '../../../lib/validation/index.js';
import { leadValidationError, unreadableBodyError } from '../errors.js';
import { getLeadById, type LeadsActor } from '../service.js';
import {
  approvePricing,
  assignLead,
  logFollowUp,
  markLeadLost,
  rejectPricing,
  reopenLead,
  requestPricingApproval,
  sendToUnderwriting,
  startInformationGathering,
  startNegotiation,
  startPricing,
  withdrawLead,
  type LeadWorkflowActor,
  type LeadWorkflowDeps,
} from './operations.js';
import {
  assignLeadSchema,
  logFollowUpSchema,
  markLeadLostSchema,
  optionalNoteSchema,
  rejectPricingSchema,
  reopenLeadSchema,
  requestPricingApprovalSchema,
  sendToUnderwritingSchema,
  withdrawLeadSchema,
} from './schemas.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

/**
 * Validates with a workflow schema, raising the leads domain's 422 shape.
 *
 * Deliberately the SAME `LEAD_VALIDATION_FAILED` envelope the rest of the leads surface uses: the
 * SPA has one error renderer for the domain, and a second code for structurally identical failures
 * would fragment it for no behavioural gain.
 */
function parseOr422<S extends ZodType>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw leadValidationError(toFieldErrors(result.error));
  return result.data as ReturnType<S['parse']>;
}

/**
 * Reads the body, treating an ABSENT body as `{}`.
 *
 * The note-only operations take no required field, and the SPA POSTs them with no body at all. The
 * reference's model binder produced a record with null members for that case; `c.req.json()` throws.
 * An unparseable but PRESENT body is still a 400 — only emptiness is forgiven.
 */
async function readOptionalJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw unreadableBodyError();
  }
}

/** `{id:long}`: a non-numeric id does not MATCH the reference's route at all, so it is a 404. */
function leadIdOf(c: Context<ApiEnv>): number {
  const raw = c.req.param('id') ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

async function actorFrom(c: Context<ApiEnv>): Promise<LeadsActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Lead workflow route reached with no verified tenant context; refusing to run an unscoped operation.',
    );
  }

  const resolveAccess = c.get('resolveAccess');
  if (resolveAccess === undefined) {
    throw new InternalError(
      'permissionResolution() middleware is not mounted; cannot evaluate operation permissions.',
    );
  }

  const correlationId = c.get('correlationId');
  return {
    userId: Number(auth.userId),
    tenantId: tenant.tenantId satisfies TenantId,
    access: await resolveAccess(tenant.tenantId),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

/** A `LeadsActor` is a workflow actor with a resolved access set and no system-actor claim. */
function workflowActor(actor: LeadsActor): LeadWorkflowActor {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    access: actor.access,
    ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
  };
}

export function leadWorkflowRoutes(deps: LeadWorkflowDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  /**
   * Every operation answers with the FRESHLY PROJECTED lead detail, exactly as the reference's
   * executor re-ran `GetLeadQuery` before returning. The re-read happens after commit, so the
   * `availableOperations` the SPA receives reflect the lead's NEW status — which is what lets the
   * action bar re-render correctly without a second round trip.
   */
  function register<S extends ZodType>(
    path: string,
    permission: Parameters<typeof requirePermission>[0],
    schema: S,
    run: (
      leadId: number,
      input: ReturnType<S['parse']>,
      actor: LeadWorkflowActor,
    ) => Promise<number>,
  ): void {
    routes.post(`/leads/:id/operations/${path}`, requirePermission(permission), async (c) => {
      const leadId = leadIdOf(c);
      const input = parseOr422(schema, await readOptionalJsonBody(c));
      const actor = await actorFrom(c);

      await run(leadId, input, workflowActor(actor));

      return c.json(await getLeadById({ db: deps.db }, leadId, actor));
    });
  }

  register('assign', 'leads.assign', assignLeadSchema, (id, input, actor) =>
    assignLead(deps, id, input, actor),
  );
  register(
    'start-information-gathering',
    'leads.update',
    optionalNoteSchema,
    (id, input, actor) => startInformationGathering(deps, id, input, actor),
  );
  register('send-to-underwriting', 'leads.update', sendToUnderwritingSchema, (id, input, actor) =>
    sendToUnderwriting(deps, id, input, actor),
  );
  register('start-pricing', 'leads.update', optionalNoteSchema, (id, input, actor) =>
    startPricing(deps, id, input, actor),
  );
  register(
    'request-pricing-approval',
    'pricing.request',
    requestPricingApprovalSchema,
    (id, input, actor) => requestPricingApproval(deps, id, input, actor),
  );
  register('approve-pricing', 'pricing.approve', optionalNoteSchema, (id, input, actor) =>
    approvePricing(deps, id, input, actor),
  );
  register('reject-pricing', 'pricing.reject', rejectPricingSchema, (id, input, actor) =>
    rejectPricing(deps, id, input, actor),
  );
  register('log-follow-up', 'leads.update', logFollowUpSchema, (id, input, actor) =>
    logFollowUp(deps, id, input, actor),
  );
  register('start-negotiation', 'leads.update', optionalNoteSchema, (id, input, actor) =>
    startNegotiation(deps, id, input, actor),
  );
  register('mark-lost', 'leads.close', markLeadLostSchema, (id, input, actor) =>
    markLeadLost(deps, id, input, actor),
  );
  register('withdraw', 'leads.close', withdrawLeadSchema, (id, input, actor) =>
    withdrawLead(deps, id, input, actor),
  );
  register('reopen', 'leads.reopen', reopenLeadSchema, (id, input, actor) =>
    reopenLead(deps, id, input, actor),
  );

  return routes;
}
