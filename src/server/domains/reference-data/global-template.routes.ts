/**
 * The Internal-managed global default reference template (T-016, AC-024, AC-026; P-04, spec §11.2).
 *
 * Port of `src/api/QuoteIQ.Api/Endpoints/GlobalTemplateEndpoints.cs`:
 *
 *   GET /api/v1/global/default-reference-items   global.manage_templates  (:21)
 *   PUT /api/v1/global/default-reference-items   global.manage_templates  (:22)
 *
 * Global routes (`/api/v1/global` is on `GLOBAL_ROUTE_PREFIXES`): no `X-Tenant-Id`, and the guard
 * resolves in the global scope, so this is Internal-only in the way that matters.
 *
 * PUT REPLACES THE WHOLE TEMPLATE, TRANSACTIONALLY, AND TOUCHES NO EXISTING TENANT
 * ===============================================================================
 * `ReplaceAllAsync` deletes and re-inserts inside one transaction (the audit row rides along in the
 * same transaction, ReplaceDefaultReferenceItemsCommandHandler.cs:69-74). Tenants already created
 * keep their own copied `reference_items` rows — only FUTURE tenant creation reads this table
 * (ReplaceDefaultReferenceItemsCommand.cs:23-26). That is why a template edit is cheap and why a
 * BAD template edit is dangerous: it breaks the next tenant created, not the current ones. The
 * seeding guard in tenant-seeder.ts is what turns that into a loud failure.
 *
 * Measured status codes (GlobalTemplateEndpoints.cs:42-47), again with `detail: error.Message` and
 * NO `code` extension:
 *   REFERENCE_DATA_VALIDATION_FAILED       -> 422
 *   REFERENCE_DATA_PRODUCT_LINE_REQUIRED   -> 422
 *   success (PUT)                          -> 200 with an EMPTY body (`Results.Ok()`)
 */
import { Hono } from 'hono';

import { requirePermission } from '../../lib/auth/index.js';
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { withTransaction, type DbClient } from '../../lib/db/index.js';
import { AppError, UnauthorizedError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import { writeAudit } from '../audit/index.js';
import type { DefaultReferenceItemDto } from './global-template.schemas.js';
import { replaceTemplateSchema } from './global-template.schemas.js';
import {
  listDefaultReferenceItems,
  replaceDefaultReferenceItems,
  type DefaultReferenceItemInput,
} from './template-repository.js';

export const TEMPLATE_REPLACED_ACTION = 'default_reference_items.replaced';

export interface GlobalTemplateDeps {
  readonly db: DbClient;
}

/** ReferenceDataErrors.ProductLineRequired (ReferenceDataErrors.cs:15-16) -> 422, no code. */
const PRODUCT_LINE_REQUIRED_MESSAGE = 'Cover types require an active product line.';

export function globalTemplateRoutes(deps: GlobalTemplateDeps): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>();
  const basePath = '/global/default-reference-items';

  routes.get(basePath, requirePermission('global.manage_templates'), async (c) => {
    const items = await listDefaultReferenceItems(deps.db);
    const payload: DefaultReferenceItemDto[] = items.map((item) => ({
      listType: item.listType,
      name: item.name,
      displayOrder: item.displayOrder,
      isActive: item.isActive,
      isBrokerChannel: item.isBrokerChannel,
      defaultProductLineKey: item.defaultProductLineKey,
      reportingCategory: item.reportingCategory,
      canonicalKey: item.canonicalKey,
      isTerminal: item.isTerminal,
    }));
    return c.json(payload);
  });

  routes.put(basePath, requirePermission('global.manage_templates'), async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError(400, 'The request body could not be read as JSON.');
    }

    const parsed = replaceTemplateSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors = toFieldErrors(parsed.error);
      throw new AppError(422, fieldErrors.map((error) => error.message).join('; '), {
        fieldErrors,
      });
    }

    // Handler-level rule (ReplaceDefaultReferenceItemsCommandHandler.cs:39-54): a cover type must
    // point at an ACTIVE product line present in the SAME submitted set, not at whatever the
    // previous template happened to contain.
    const activeProductLineNames = new Set(
      parsed.data.items
        .filter((item) => item.listType === 'product_line' && item.isActive)
        .map((item) => item.name.trim().toLowerCase()),
    );

    for (const item of parsed.data.items) {
      if (item.listType !== 'cover_type') continue;
      const key = item.defaultProductLineKey;
      if (key == null) throw new AppError(422, PRODUCT_LINE_REQUIRED_MESSAGE);
      if (!activeProductLineNames.has(key.trim().toLowerCase())) {
        throw new AppError(
          422,
          `'${key}' is not an active product line in the submitted template.`,
        );
      }
    }

    const items: DefaultReferenceItemInput[] = parsed.data.items.map((item) => ({
      listType: item.listType,
      name: item.name,
      displayOrder: item.displayOrder,
      isActive: item.isActive,
      isBrokerChannel: item.isBrokerChannel ?? null,
      defaultProductLineKey: item.defaultProductLineKey ?? null,
      reportingCategory: item.reportingCategory ?? null,
      canonicalKey: item.canonicalKey ?? null,
      isTerminal: item.isTerminal,
    }));

    const auth = c.get('auth');
    if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);
    const correlationId = c.get('correlationId');

    await withTransaction(deps.db, async (trx) => {
      const before = await listDefaultReferenceItems(trx);
      await replaceDefaultReferenceItems(trx, items);

      await writeAudit(trx, {
        entityType: 'default_reference_items',
        entityId: 'template',
        action: TEMPLATE_REPLACED_ACTION,
        actorUserId: Number(auth.userId),
        // Global template: no tenant owns it (audit_log.tenant_id is nullable for this case).
        tenantId: null,
        // The reference audited only `new { Count }` (:72). The shared writer always emits both
        // halves, so the row records the size of the set before and after the replacement.
        before: { count: before.length },
        after: { count: items.length },
        ...(correlationId === undefined ? {} : { context: { correlationId } }),
      });
    });

    return c.body(null, 200);
  });

  return routes;
}
