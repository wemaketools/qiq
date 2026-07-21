/**
 * Copies the global default template into a new tenant's `reference_items` (T-016, AC-026, V-034).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/Provisioning/TenantReferenceSeeder.cs`.
 *
 * THIS RUNS INSIDE THE TENANT-CREATION TRANSACTION AND MUST STAY THERE
 * ===================================================================
 * It takes a `DbExecutor` and the caller passes the open transaction. A tenant whose reference
 * lists were never copied is a broken tenant: it has no statuses to move a Lead through, no product
 * lines to quote against, and nothing for a dashboard filter to resolve — and nothing would report
 * the breakage until a user hit it. Throwing from here aborts the whole creation, which is the
 * intended outcome (TenantReferenceSeeder.cs:13-16).
 *
 * ORDERING IS LOAD-BEARING: product lines are inserted first so their new tenant-scoped ids exist
 * before cover types are inserted, since a cover type's `default_product_line_key` is a template
 * NAME that has to be resolved to a `reference_items.product_line_id` (:65-100). The reference
 * inserted product lines one row at a time to learn each id; this port does it in a single
 * `returning` statement — same ordering guarantee, one round trip instead of twelve.
 *
 * WHY THE RAW EXECUTOR AND NOT `forTenant(...)`
 * ============================================
 * `TenantScope.insertInto` takes ONE row, and this writes ~80 in two batches, so the rows carry an
 * explicit `tenant_id`. That id is `options.tenantId` — the branded `TenantId` the creation
 * transaction just generated, appearing once per statement and never derived from the template or
 * from any client input, so there is no value a hostile template could inject to move a row into
 * another tenant. The suite additionally asserts the seeded rows land in the tenant's OWN partition
 * rather than the DEFAULT one, which would fail if either the id or the partition step were wrong.
 */
import { writeAudit } from '../audit/index.js';
import type { DbExecutor, TenantId } from '../../lib/db/index.js';
import { REQUIRED_CANONICAL_STATUSES } from './canonical-statuses.js';
import {
  listDefaultReferenceItems,
  type DefaultReferenceItemRecord,
} from './template-repository.js';

export const REFERENCE_SEEDED_ACTION = 'tenant.reference_seeded';

const PRODUCT_LINE = 'product_line';
const COVER_TYPE = 'cover_type';

/**
 * Thrown when the live template cannot produce a usable tenant. It is an ordinary error (not an
 * `AppError`), so the router's boundary maps it to a sanitized 500: a template that has been
 * corrupted by an Internal user is a server-side condition, and its message names internal
 * invariants that have no business reaching a client.
 */
export class TemplateSeedingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateSeedingError';
  }
}

/**
 * TenantReferenceSeeder.EnsureCanonicalStatusesComplete (:143-163): every canonical lead/quote
 * status must still be present, ACTIVE, and carry its original reporting category and terminal
 * flag. Checked against the rows about to be copied, so an inactive canonical status fails here
 * exactly as a deleted one does.
 */
function ensureCanonicalStatusesComplete(templateItems: readonly DefaultReferenceItemRecord[]): void {
  for (const required of REQUIRED_CANONICAL_STATUSES) {
    const match = templateItems.find(
      (item) => item.listType === required.listType && item.canonicalKey === required.canonicalKey,
    );

    if (
      match === undefined ||
      match.reportingCategory !== required.reportingCategory ||
      match.isTerminal !== required.isTerminal
    ) {
      throw new TemplateSeedingError(
        `Global default template is missing or has misconfigured the required canonical ` +
          `${required.listType} status '${required.canonicalKey}' (expected reporting_category=` +
          `'${required.reportingCategory}', is_terminal=${String(required.isTerminal)}); tenant ` +
          `creation cannot seed an incomplete guarded-status taxonomy (spec FR-20).`,
      );
    }
  }
}

/** Template ordering: display_order, then id — the reference's `OrderBy(...).ThenBy(...)`. */
function byDisplayOrderThenId(
  left: DefaultReferenceItemRecord,
  right: DefaultReferenceItemRecord,
): number {
  return left.displayOrder - right.displayOrder || left.id - right.id;
}

export interface SeedTenantReferenceDataOptions {
  readonly tenantId: TenantId;
  readonly actorUserId: number;
  readonly correlationId?: string;
}

/** Number of rows copied, per list type — the payload the reference audited (:110). */
export type SeedCounts = Record<string, number>;

export async function seedTenantReferenceData(
  executor: DbExecutor,
  options: SeedTenantReferenceDataOptions,
): Promise<SeedCounts> {
  const templateItems = (await listDefaultReferenceItems(executor)).filter((item) => item.isActive);

  ensureCanonicalStatusesComplete(templateItems);

  const now = new Date().toISOString();
  const counts: SeedCounts = {};

  const common = {
    is_active: true,
    created_at: now,
    created_by: options.actorUserId,
    updated_at: now,
    updated_by: options.actorUserId,
  } as const;

  // --- product lines first: cover types below resolve their parent id from these rows.
  const productLines = templateItems
    .filter((item) => item.listType === PRODUCT_LINE)
    .sort(byDisplayOrderThenId);

  const productLineIdsByName = new Map<string, number>();

  if (productLines.length > 0) {
    const inserted = await executor
      .insertInto('reference_items')
      .values(
        productLines.map((template) => ({
          tenant_id: options.tenantId,
          list_type: template.listType,
          name: template.name,
          display_order: template.displayOrder,
          is_broker_channel: template.isBrokerChannel,
          product_line_id: null,
          reporting_category: template.reportingCategory,
          canonical_key: template.canonicalKey,
          is_terminal: template.isTerminal,
          ...common,
        })),
      )
      .returning(['id', 'name'])
      .execute();

    for (const row of inserted) {
      productLineIdsByName.set(row.name, Number(row.id));
    }
    counts[PRODUCT_LINE] = inserted.length;
  }

  // --- everything else, with cover types resolved against the ids just created.
  const remaining = templateItems
    .filter((item) => item.listType !== PRODUCT_LINE)
    .sort(
      (left, right) =>
        left.listType.localeCompare(right.listType) || byDisplayOrderThenId(left, right),
    );

  const rows = remaining.map((template) => {
    let productLineId: number | null = null;

    if (template.listType === COVER_TYPE) {
      const resolved =
        template.defaultProductLineKey === null
          ? undefined
          : productLineIdsByName.get(template.defaultProductLineKey);

      if (resolved === undefined) {
        // TenantReferenceSeeder.cs:93-96, verbatim reasoning: a cover type with no product line to
        // link to would be unusable, so the whole creation is aborted rather than seeded broken.
        throw new TemplateSeedingError(
          `Global default template cover type '${template.name}' references product line ` +
            `'${String(template.defaultProductLineKey)}', which is missing or inactive in the ` +
            `current template; tenant creation cannot seed a cover type with no product line to ` +
            `link to.`,
        );
      }

      productLineId = resolved;
    }

    counts[template.listType] = (counts[template.listType] ?? 0) + 1;

    return {
      tenant_id: options.tenantId,
      list_type: template.listType,
      name: template.name,
      display_order: template.displayOrder,
      is_broker_channel: template.isBrokerChannel,
      product_line_id: productLineId,
      reporting_category: template.reportingCategory,
      canonical_key: template.canonicalKey,
      is_terminal: template.isTerminal,
      ...common,
    };
  });

  if (rows.length > 0) {
    await executor.insertInto('reference_items').values(rows).execute();
  }

  await writeAudit(executor, {
    entityType: 'tenant',
    entityId: String(options.tenantId),
    action: REFERENCE_SEEDED_ACTION,
    actorUserId: options.actorUserId,
    // Tenant-scoped: the reference wrote this row with the ambient tenant flipped to the new tenant
    // (TenantReferenceSeeder.cs:63 before :109), unlike the global `tenant.created` row.
    tenantId: options.tenantId,
    before: null,
    after: { countsByListType: counts },
    ...(options.correlationId === undefined ? {} : { context: { correlationId: options.correlationId } }),
  });

  return counts;
}
