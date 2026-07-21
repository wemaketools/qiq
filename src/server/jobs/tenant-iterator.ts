/**
 * Explicit tenant iteration for sweeps (T-031, spec §9.5 "jobs run outside user tenant context").
 *
 * Jobs have no `X-Tenant-Id` and no user, so they cannot use the request-scoped tenant machinery.
 * They walk the active tenants explicitly instead, and this helper is the ONE place that walk is
 * written — so every sweep gets the same three properties:
 *
 * 1. ONE TENANT PER UNIT OF WORK. The callback receives a single tenant id. Nothing here hands a
 *    handler a set of tenants, because the moment a sweep holds two it can write one tenant's data
 *    into another's.
 *
 * 2. ONE TENANT'S FAILURE DOES NOT STOP THE SWEEP. Each callback is wrapped in try/catch, the
 *    error is recorded against that tenant and the loop continues (spec §9.5: "per-tenant try/catch
 *    continues remaining tenants"). Otherwise a single tenant with bad data would freeze quote
 *    expiry for every other tenant until someone noticed.
 *
 * 3. BOUNDED WORK. Tenants are read in keyset-paginated batches and the caller can stop early via
 *    the time budget, because the function runs inside a Vercel invocation with a hard maxDuration.
 *    A sweep that stops halfway is fine — the next tick resumes, since the sweeps are state-guarded.
 *
 * Only `status = 'active'` tenants are visited: a soft-removed tenant must not have alerts raised
 * or quotes expired on its behalf.
 */
import type { DbExecutor } from '../lib/db/index.js';

export interface ActiveTenant {
  readonly id: number;
  readonly name: string;
}

export interface TenantFailure {
  readonly tenantId: number;
  readonly error: unknown;
}

export interface ForEachTenantOptions {
  readonly batchSize?: number;
  /** Stops starting new tenants once this many ms have elapsed. */
  readonly timeBudgetMs?: number;
  readonly now?: () => number;
}

export interface ForEachTenantResult {
  readonly processed: number;
  readonly failures: readonly TenantFailure[];
  /** True when tenants remain unvisited because the time budget ran out. */
  readonly budgetExhausted: boolean;
}

export const DEFAULT_TENANT_BATCH_SIZE = 50;

/** Reads one keyset page of active tenants, ordered by id so paging is stable under concurrent inserts. */
export async function readActiveTenantPage(
  db: DbExecutor,
  afterId: number,
  limit: number,
): Promise<readonly ActiveTenant[]> {
  return await db
    .selectFrom('tenants')
    .select(['id', 'name'])
    .where('status', '=', 'active')
    .where('id', '>', afterId)
    .orderBy('id', 'asc')
    .limit(limit)
    .execute();
}

export async function forEachActiveTenant(
  db: DbExecutor,
  handle: (tenant: ActiveTenant) => Promise<void>,
  options: ForEachTenantOptions = {},
): Promise<ForEachTenantResult> {
  const batchSize = options.batchSize ?? DEFAULT_TENANT_BATCH_SIZE;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const budget = options.timeBudgetMs;

  const failures: TenantFailure[] = [];
  let processed = 0;
  let afterId = 0;
  let budgetExhausted = false;

  for (;;) {
    const page = await readActiveTenantPage(db, afterId, batchSize);
    if (page.length === 0) break;

    for (const tenant of page) {
      if (budget !== undefined && now() - startedAt >= budget) {
        budgetExhausted = true;
        break;
      }
      afterId = tenant.id;
      try {
        await handle(tenant);
        processed += 1;
      } catch (error) {
        failures.push({ tenantId: tenant.id, error });
      }
    }

    if (budgetExhausted || page.length < batchSize) break;
  }

  return { processed, failures, budgetExhausted };
}
