/**
 * The attachment routes (T-027; AC-056, AC-057, M-07).
 *
 * Port of `AttachmentEndpoints.Map` (:44-58), permission for permission:
 *
 *   POST   /api/v1/quotes/{id}/attachments           quotes.update   (:51)
 *   GET    /api/v1/quotes/{id}/attachments           quotes.view     ADDED — see below
 *   POST   /api/v1/attachments/{id}/confirm          quotes.update   ADDED — A-7 envelope
 *   GET    /api/v1/attachments/{id}                  quotes.view     (:57)
 *   DELETE /api/v1/attachments/{id}                  quotes.update   (:58)
 *
 * THE PERMISSIONS ARE THE REFERENCE'S, INCLUDING THE ABSENCE OF A DEDICATED ONE
 * ============================================================================
 * `AttachmentEndpoints`' own header records that `PermissionCatalog` has no attachments permission
 * and that `quotes.update`/`quotes.view` are reused deliberately, so no client mirror or drift guard
 * needs updating. That is preserved exactly: adding an `attachments.*` permission here would be a
 * catalog change no task owns, and it would silently deny every existing role.
 *
 * The two ADDED routes take the permission of the operation they belong to: confirm is the second
 * half of an upload (`quotes.update`), and the list is a read (`quotes.view`). Both are re-checked
 * against the quote's tenant inside the service; the route guard is the outer of two gates.
 *
 * TWO ROUTES HAVE NO REFERENCE COUNTERPART, FOR TWO DIFFERENT REASONS
 * ==================================================================
 * `POST /attachments/{id}/confirm` exists because A-7 splits the upload in two — it is part of the
 * one approved contract deviation (M-07), not an addition of scope.
 * `GET /quotes/{id}/attachments` is a genuine ADDITION beyond the reference: `AttachmentEndpoints`
 * has no list, and the SPA compensated with component-local state that lost every attachment on
 * reload. AC-057/V-073 require removed attachments to disappear from "the quote's list", which
 * cannot be verified without one. Recorded as a contradiction in the task file.
 *
 * MOUNTED UNDER THE TENANT-SCOPED GROUP LIKE EVERY OTHER QUOTE ROUTE
 * =================================================================
 * The reference used `TenantScopedGroup` for both `/quotes` and `/attachments` (:46, :55). Here that
 * is the app-level tenant middleware, which classifies anything not on the explicit global list as
 * tenant-scoped — so `/attachments/*` fails CLOSED without a verified tenant rather than needing to
 * opt in. `tenant-route-classification.test.ts` covers that classification.
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { attachmentValidationError } from './attachments.errors.js';
import { requestAttachmentUploadSchema } from './attachments.schemas.js';
import {
  confirmAttachmentUpload,
  getAttachmentDownload,
  listQuoteAttachments,
  removeAttachment,
  requestAttachmentUpload,
  type AttachmentsActor,
  type AttachmentsDeps,
} from './attachments.service.js';

import type { Context } from 'hono';

/** `{id:long}`: a non-numeric id does not MATCH the reference's route at all, so it is a 404. */
function idOf(c: Context<ApiEnv>): number {
  const raw = c.req.param('id') ?? '';
  const id = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

/** Reads the JSON body, treating an ABSENT body as `{}` so the schema reports the missing fields. */
async function readJsonBody(c: Context<ApiEnv>): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw attachmentValidationError([
      { field: 'body', code: 'ATTACHMENT_INVALID_BODY', message: 'The request body could not be read as JSON.' },
    ]);
  }
}

/**
 * Re-derives the actor from VERIFIED context only.
 *
 * The tenant comes from the T-013 middleware's `TenantContext`, never from the raw header. A missing
 * tenant or resolver is a composition fault that fails CLOSED with a 500 rather than proceeding
 * unscoped — which for this domain would mean signing a URL with no tenant confinement at all.
 */
async function actorFrom(c: Context<ApiEnv>): Promise<AttachmentsActor> {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const tenant = c.get('tenant');
  if (tenant === undefined) {
    throw new InternalError(
      'Attachment route reached with no verified tenant context; refusing to run an unscoped operation.',
    );
  }

  const resolveAccess = c.get('resolveAccess');
  if (resolveAccess === undefined) {
    throw new InternalError(
      'permissionResolution() middleware is not mounted; cannot evaluate attachment permissions.',
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

export function attachmentRoutes(deps: AttachmentsDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();

  // --- Quote-subordinate: the envelope request and the live list. ---

  routes.post('/quotes/:id/attachments', requirePermission('quotes.update'), async (c) => {
    const quoteId = idOf(c);
    const parsed = requestAttachmentUploadSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) throw attachmentValidationError(toFieldErrors(parsed.error));
    const actor = await actorFrom(c);

    const envelope = await requestAttachmentUpload(deps, quoteId, parsed.data, actor);
    // 202: the attachment is NOT yet created — the client must still transfer the bytes and confirm.
    // A 201 would claim a resource exists at a URL that would 404 until confirm succeeds.
    return c.json(envelope, 202);
  });

  routes.get('/quotes/:id/attachments', requirePermission('quotes.view'), async (c) => {
    const quoteId = idOf(c);
    const actor = await actorFrom(c);
    // A BARE ARRAY, mirroring `GET /leads/{id}/quotes` — measured, see the service.
    return c.json(await listQuoteAttachments(deps, quoteId, actor));
  });

  // --- Attachment-addressed: confirm, download envelope, soft remove. ---

  routes.post('/attachments/:id/confirm', requirePermission('quotes.update'), async (c) => {
    const attachmentId = idOf(c);
    const actor = await actorFrom(c);

    const attachment = await confirmAttachmentUpload(deps, attachmentId, actor);
    // 201 HERE, not at request time: this is the moment the attachment actually exists, and the
    // Location matches the reference's `Results.Created($"/api/v1/attachments/{id}")` (:71).
    return c.json(attachment, 201, {
      location: `/api/v1/attachments/${String(attachment.id)}`,
    });
  });

  routes.get('/attachments/:id', requirePermission('quotes.view'), async (c) => {
    const attachmentId = idOf(c);
    const actor = await actorFrom(c);
    return c.json(await getAttachmentDownload(deps, attachmentId, actor));
  });

  routes.delete('/attachments/:id', requirePermission('quotes.update'), async (c) => {
    const attachmentId = idOf(c);
    const actor = await actorFrom(c);

    await removeAttachment(deps, attachmentId, actor);
    // 204, as the reference (:85).
    return c.body(null, 204);
  });

  return routes;
}
