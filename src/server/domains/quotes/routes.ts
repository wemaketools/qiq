/**
 * The quote routes (T-026; AC-050, AC-052, AC-055, AC-096; V-064, V-067).
 *
 * Port of `QuoteEndpoints.Map` (:31-48), permission for permission:
 *
 *   POST /api/v1/leads/{id}/quotes                     quotes.create
 *   GET  /api/v1/leads/{id}/quotes                     quotes.view
 *   GET  /api/v1/quotes/{id}                           quotes.view
 *   PUT  /api/v1/quotes/{id}                           quotes.update
 *   POST /api/v1/quotes/{id}/operations/assign         quotes.assign
 *   POST /api/v1/quotes/{id}/operations/send           quotes.mark_sent
 *   POST /api/v1/quotes/{id}/operations/revise         quotes.revise
 *   POST /api/v1/quotes/{id}/operations/mark-won       quotes.close_won
 *   POST /api/v1/quotes/{id}/operations/mark-lost      quotes.close_lost
 *   POST /api/v1/quotes/{id}/operations/withdraw       quotes.withdraw
 *   POST /api/v1/quotes/{id}/set-current               quotes.set_current
 *
 * NOTE `set-current` IS NOT UNDER `/operations/` — MEASURED, AND DELIBERATELY PRESERVED
 * ====================================================================================
 * Every other operation is `POST /quotes/{id}/operations/{op}`; Set current has its own dedicated
 * route `POST /quotes/{id}/set-current` (`QuoteEndpoints.cs:47`, and spec.md §12.5 lists it
 * separately for the same reason). It is the odd one out because PRD 7.3 models it as a marker
 * action rather than a workflow transition — it never changes the quote's own status. It still
 * carries a wire code in the operation matrix so it can appear in a quote's `availableOperations`.
 * The task brief's operation list omits `set-current` entirely; the reference has it, it is the only
 * writer of `quotes.is_current` besides create, and this task owns that column's new invariant — so
 * it is implemented and the omission is recorded as a contradiction in the task file.
 *
 * THERE IS NO STANDALONE `POST /api/v1/quotes` CREATE ROUTE (AC-052, V-067)
 * ========================================================================
 * Creation exists only under a lead. That absence is asserted against the composed route table in
 * `quote-workflow.test.ts` rather than trusted from this comment.
 *
 * THERE IS ONE LITERAL ROUTE PER OPERATION AND NO `/operations/:op` CATCH-ALL
 * ==========================================================================
 * Same reasoning as the lead workflow routes: a parameterised route would have to look the
 * permission up from the path segment at request time, so a typo'd or unknown op would reach a
 * handler before any guard ran. Literal routes keep the permission map static and let an unknown op
 * fall through to the app's 404.
 *
 * EVERY HANDLER RE-DERIVES THE ACTOR FROM VERIFIED CONTEXT
 * =======================================================
 * The tenant comes from the T-013 middleware's verified `TenantContext`, never the raw header, and
 * a missing tenant or resolver is a composition fault that fails CLOSED with a 500 rather than
 * proceeding unscoped. `isSystemActor` is never set here — no HTTP caller can become the system
 * actor, which is what keeps the automatic expiry unreachable from the network.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { quoteValidationError, unreadableQuoteBodyError } from './errors.js';
import {
  createQuote,
  getQuoteById,
  listQuotesForLead,
  updateQuote,
  type QuotesActor,
  type QuotesDeps,
} from './service.js';
import {
  assignQuoteSchema,
  createQuoteSchema,
  markQuoteLostSchema,
  markQuoteWonSchema,
  reviseQuoteSchema,
  sendQuoteSchema,
  setCurrentQuoteSchema,
  updateQuoteSchema,
  withdrawQuoteSchema,
} from './schemas.js';
import {
  assignQuote,
  markQuoteLost,
  markQuoteWon,
  reviseQuote,
  sendQuote,
  setCurrentQuote,
  withdrawQuote,
  type QuoteWorkflowActor,
  type QuoteWorkflowDeps,
} from './workflow/operations.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

/** Validates with a quote schema, raising the quotes domain's 422 shape. */
function parseOr422<S extends ZodType>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw quoteValidationError(toFieldErrors(result.error));
  return result.data as ReturnType<S['parse']>;
}

/**
 * Reads the body, treating an ABSENT body as `{}`.
 *
 * Set current takes no body at all and the SPA POSTs it with none. The reference's model binder
 * produced a record with null members for that case; `c.req.json()` throws. An unparseable but
 * PRESENT body is still a 400 — only emptiness is forgiven.
 */
async function readOptionalJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw unreadableQuoteBodyError();
  }
}

/** `{id:long}`: a non-numeric id does not MATCH the reference's route at all, so it is a 404. */
function idOf(c: Context<ApiEnv>): number {
  const raw = c.req.param('id') ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

async function actorFrom(c: Context<ApiEnv>): Promise<QuotesActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Quote route reached with no verified tenant context; refusing to run an unscoped operation.',
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

/** A `QuotesActor` is a workflow actor with a resolved access set and no system-actor claim. */
function workflowActor(actor: QuotesActor): QuoteWorkflowActor {
  return {
    userId: actor.userId,
    tenantId: actor.tenantId,
    access: actor.access,
    ...(actor.correlationId === undefined ? {} : { correlationId: actor.correlationId }),
  };
}

export function quoteRoutes(deps: QuotesDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  const workflowDeps: QuoteWorkflowDeps =
    deps.onLeadChanged === undefined
      ? { db: deps.db }
      : { db: deps.db, onLeadChanged: deps.onLeadChanged };

  // --- Lead-subordinate: creation and the Quotes card. ---

  routes.post('/leads/:id/quotes', requirePermission('quotes.create'), async (c) => {
    const leadId = idOf(c);
    const input = parseOr422(createQuoteSchema, await readOptionalJsonBody(c));
    const actor = await actorFrom(c);

    const quote = await createQuote(deps, leadId, input, actor);
    // 201 + Location, matching `Results.Created($"/api/v1/quotes/{id}", ...)`.
    return c.json(quote, 201, { location: `/api/v1/quotes/${String(quote.id)}` });
  });

  routes.get('/leads/:id/quotes', requirePermission('quotes.view'), async (c) => {
    const leadId = idOf(c);
    const actor = await actorFrom(c);
    // A BARE ARRAY, not a paged envelope — measured; see `QuoteListItemDto`.
    return c.json(await listQuotesForLead(deps, leadId, actor));
  });

  // --- Quote detail and the Draft edit / audited correction path. ---

  routes.get('/quotes/:id', requirePermission('quotes.view'), async (c) => {
    const quoteId = idOf(c);
    const actor = await actorFrom(c);
    return c.json(await getQuoteById(deps, quoteId, actor));
  });

  routes.put('/quotes/:id', requirePermission('quotes.update'), async (c) => {
    const quoteId = idOf(c);
    const input = parseOr422(updateQuoteSchema, await readOptionalJsonBody(c));
    const actor = await actorFrom(c);
    return c.json(await updateQuote(deps, quoteId, input, actor));
  });

  /**
   * Every operation answers with the FRESHLY PROJECTED quote detail, exactly as the reference's
   * executor re-ran `GetQuoteQuery` before returning. The re-read happens after commit, so the
   * `availableOperations` the SPA receives reflect the quote's NEW status — which is what lets the
   * action bar re-render correctly without a second round trip.
   */
  function register<S extends ZodType>(
    path: string,
    permission: Parameters<typeof requirePermission>[0],
    schema: S,
    run: (
      quoteId: number,
      input: ReturnType<S['parse']>,
      actor: QuoteWorkflowActor,
    ) => Promise<number>,
  ): void {
    routes.post(path, requirePermission(permission), async (c) => {
      const quoteId = idOf(c);
      const input = parseOr422(schema, await readOptionalJsonBody(c));
      const actor = await actorFrom(c);

      await run(quoteId, input, workflowActor(actor));

      return c.json(await getQuoteById(deps, quoteId, actor));
    });
  }

  register('/quotes/:id/operations/assign', 'quotes.assign', assignQuoteSchema, (id, input, actor) =>
    assignQuote(workflowDeps, id, input, actor),
  );
  register('/quotes/:id/operations/send', 'quotes.mark_sent', sendQuoteSchema, (id, input, actor) =>
    sendQuote(workflowDeps, id, input, actor),
  );
  register('/quotes/:id/operations/revise', 'quotes.revise', reviseQuoteSchema, (id, input, actor) =>
    reviseQuote(workflowDeps, id, input, actor),
  );
  register(
    '/quotes/:id/operations/mark-won',
    'quotes.close_won',
    markQuoteWonSchema,
    (id, input, actor) => markQuoteWon(workflowDeps, id, input, actor),
  );
  register(
    '/quotes/:id/operations/mark-lost',
    'quotes.close_lost',
    markQuoteLostSchema,
    (id, input, actor) => markQuoteLost(workflowDeps, id, input, actor),
  );
  register(
    '/quotes/:id/operations/withdraw',
    'quotes.withdraw',
    withdrawQuoteSchema,
    (id, input, actor) => withdrawQuote(workflowDeps, id, input, actor),
  );
  // The dedicated, non-`/operations/` route — see this file's header.
  register(
    '/quotes/:id/set-current',
    'quotes.set_current',
    setCurrentQuoteSchema,
    (id, input, actor) => setCurrentQuote(workflowDeps, id, input, actor),
  );

  return routes;
}
