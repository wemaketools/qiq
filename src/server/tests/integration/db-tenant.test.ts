/**
 * Behavioural half of the tenant-scoping guarantee (T-008, AC-012, V-015).
 *
 * src/server/tests/unit/db-tenant.test.ts asserts the compiled SQL carries the predicate. This
 * suite asserts what actually matters: a scoped read of another tenant's data returns NOTHING, and
 * a scoped write cannot reach across the boundary.
 *
 * FIXTURES: every test creates its own tenants with a unique run marker and cleans up afterwards.
 * Nothing here depends on seeded data or on a stable row count, because T-006's seed and
 * `supabase db reset` may be running against the same database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from '../../lib/db/client.js';
import { forTenant, toTenantId, type TenantId } from '../../lib/db/tenant.js';
import { probeLocalStack, suiteTitle, type StackProbe } from './helpers/local-stack.js';

const probe: StackProbe = await probeLocalStack();

describe.skipIf(!probe.available)(suiteTitle('tenant-scoped query helpers', probe), () => {
  let handle: DbHandle;
  let tenantA: TenantId;
  let tenantB: TenantId;

  const marker = `t008-tenant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();

  async function createTenant(suffix: string): Promise<TenantId> {
    const row = await handle.db
      .insertInto('tenants')
      .values({ name: `${marker}-${suffix}`, created_at: now, updated_at: now })
      .returning('id')
      .executeTakeFirstOrThrow();
    return toTenantId(row.id);
  }

  beforeAll(async () => {
    if (!probe.available) return;
    handle = createDb({ connectionString: probe.stack.dbUrl });
    tenantA = await createTenant('a');
    tenantB = await createTenant('b');

    // One reference item per tenant, distinguishable by name.
    for (const [tenant, label] of [
      [tenantA, 'alpha'],
      [tenantB, 'beta'],
    ] as const) {
      await forTenant(handle.db, tenant)
        .insertInto('reference_items', {
          list_type: 'product_line',
          name: `${marker}-${label}`,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.deleteFrom('reference_items').where('name', 'like', `${marker}-%`).execute();
    await handle.db.deleteFrom('tenants').where('name', 'like', `${marker}-%`).execute();
    await handle.close();
  });

  it('reads only its own tenant rows', async () => {
    const rows = await forTenant(handle.db, tenantA)
      .selectFrom('reference_items')
      .select('name')
      .where('name', 'like', `${marker}-%`)
      .execute();

    expect(rows.map((row) => row.name)).toEqual([`${marker}-alpha`]);
  });

  it('returns NOTHING when one tenant asks for another tenant’s row by name', async () => {
    const rows = await forTenant(handle.db, tenantA)
      .selectFrom('reference_items')
      .select('name')
      .where('name', '=', `${marker}-beta`)
      .execute();

    expect(rows).toEqual([]);
  });

  it('returns NOTHING when one tenant asks for another tenant’s row by primary key', async () => {
    const beta = await forTenant(handle.db, tenantB)
      .selectFrom('reference_items')
      .select('id')
      .where('name', '=', `${marker}-beta`)
      .executeTakeFirstOrThrow();

    // The id is a real, existing row — only the tenant predicate keeps it out of reach.
    const rows = await forTenant(handle.db, tenantA)
      .selectFrom('reference_items')
      .selectAll()
      .where('id', '=', beta.id)
      .execute();

    expect(rows).toEqual([]);
  });

  it('an update scoped to one tenant does not touch another tenant’s row', async () => {
    const result = await forTenant(handle.db, tenantA)
      .updateTable('reference_items')
      .set({ is_active: false })
      .where('name', '=', `${marker}-beta`)
      .executeTakeFirst();

    expect(Number(result.numUpdatedRows)).toBe(0);

    const beta = await forTenant(handle.db, tenantB)
      .selectFrom('reference_items')
      .select('is_active')
      .where('name', '=', `${marker}-beta`)
      .executeTakeFirstOrThrow();

    expect(beta.is_active).toBe(true);
  });

  it('a delete scoped to one tenant does not remove another tenant’s row', async () => {
    const result = await forTenant(handle.db, tenantA)
      .deleteFrom('reference_items')
      .where('name', '=', `${marker}-beta`)
      .executeTakeFirst();

    expect(Number(result.numDeletedRows)).toBe(0);

    const surviving = await forTenant(handle.db, tenantB)
      .selectFrom('reference_items')
      .select('name')
      .where('name', '=', `${marker}-beta`)
      .execute();

    expect(surviving).toHaveLength(1);
  });

  it('writes the scope tenant id, so an inserted row is readable only by that tenant', async () => {
    await forTenant(handle.db, tenantA)
      .insertInto('reference_items', {
        list_type: 'region',
        name: `${marker}-scoped-insert`,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const fromA = await forTenant(handle.db, tenantA)
      .selectFrom('reference_items')
      .select('tenant_id')
      .where('name', '=', `${marker}-scoped-insert`)
      .execute();
    const fromB = await forTenant(handle.db, tenantB)
      .selectFrom('reference_items')
      .selectAll()
      .where('name', '=', `${marker}-scoped-insert`)
      .execute();

    expect(fromA).toHaveLength(1);
    expect(fromA[0]?.tenant_id).toBe(tenantA);
    expect(fromB).toEqual([]);
  });

  it('works inside a transaction, so tenant scoping and rollback compose', async () => {
    const scoped = forTenant(handle.db, tenantA);
    await expect(
      scoped.transaction(async (trx) => {
        await trx
          .insertInto('reference_items', {
            list_type: 'region',
            name: `${marker}-tx-rollback`,
            created_at: now,
            updated_at: now,
          })
          .execute();
        throw new Error('t008 rollback inside tenant scope');
      }),
    ).rejects.toThrow(/rollback inside tenant scope/);

    const rows = await forTenant(handle.db, tenantA)
      .selectFrom('reference_items')
      .selectAll()
      .where('name', '=', `${marker}-tx-rollback`)
      .execute();

    expect(rows).toEqual([]);
  });
});
