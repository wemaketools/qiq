/**
 * Tenant-scoping contract for the Kysely data layer (T-008, AC-012, V-015).
 *
 * These tests assert the SQL that the helpers COMPILE. They need no database: Kysely compiles
 * without connecting, and a wrong predicate is a wrong string long before it is a wrong row.
 * The behavioural half of the same guarantee — that a cross-tenant read actually returns nothing —
 * lives in src/server/tests/integration/db-tenant.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { createDb } from '../../lib/db/client.js';
import {
  TENANT_SCOPED_TABLES,
  forTenant,
  isTenantId,
  toTenantId,
  type TenantInsertable,
} from '../../lib/db/tenant.js';

// A syntactically valid URL is enough: pg.Pool does not connect until a query is issued.
const handle = createDb({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:6543/postgres' });
const db = handle.db;

const TENANT = toTenantId(42);

describe('toTenantId', () => {
  it('accepts a positive integer and returns it unchanged at runtime', () => {
    expect(toTenantId(7)).toBe(7);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects %p as a tenant id',
    (value) => {
      expect(() => toTenantId(value)).toThrowError(/tenant id/i);
    },
  );

  it('rejects values that are not numbers at all, so an untyped caller cannot smuggle one through', () => {
    const untyped = toTenantId as (value: unknown) => unknown;
    expect(() => untyped('42')).toThrowError(/tenant id/i);
    expect(() => untyped(null)).toThrowError(/tenant id/i);
    expect(() => untyped(undefined)).toThrowError(/tenant id/i);
  });

  it('isTenantId agrees with toTenantId', () => {
    expect(isTenantId(7)).toBe(true);
    expect(isTenantId(0)).toBe(false);
    expect(isTenantId('7')).toBe(false);
  });
});

describe('forTenant query helpers emit the tenant predicate', () => {
  it('selectFrom applies a parameterised, table-qualified tenant_id predicate', () => {
    const compiled = forTenant(db, TENANT).selectFrom('leads').selectAll().compile();

    expect(compiled.sql).toContain('"leads"."tenant_id" = $1');
    expect(compiled.parameters).toContain(42);
  });

  it('keeps the tenant predicate when the caller adds further conditions', () => {
    const compiled = forTenant(db, TENANT)
      .selectFrom('reference_items')
      .selectAll()
      .where('list_type', '=', 'product_line')
      .compile();

    expect(compiled.sql).toContain('"reference_items"."tenant_id" = $1');
    // The caller's own predicate must be ANDed on, not replace ours.
    expect(compiled.sql).toContain('and');
    expect(compiled.parameters).toEqual([42, 'product_line']);
  });

  it('updateTable applies the tenant predicate so an update cannot span tenants', () => {
    const compiled = forTenant(db, TENANT)
      .updateTable('reference_items')
      .set({ is_active: false })
      .compile();

    expect(compiled.sql).toContain('"reference_items"."tenant_id" = $');
    expect(compiled.parameters).toContain(42);
  });

  it('deleteFrom applies the tenant predicate so a delete cannot span tenants', () => {
    const compiled = forTenant(db, TENANT).deleteFrom('leads').compile();

    expect(compiled.sql).toContain('"leads"."tenant_id" = $1');
    expect(compiled.parameters).toContain(42);
  });

  it('insertInto injects tenant_id into the inserted row rather than trusting the caller', () => {
    const compiled = forTenant(db, TENANT)
      .insertInto('reference_items', {
        list_type: 'product_line',
        name: 'Motor',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .compile();

    expect(compiled.sql).toContain('"tenant_id"');
    expect(compiled.parameters).toContain(42);
  });

  it('insertInto ignores a caller-supplied tenant_id and uses the scope tenant', () => {
    // The type signature forbids tenant_id, but a boundary handler passing a parsed JSON body
    // through an `as` cast would defeat that. The runtime must not honour it.
    const values = {
      tenant_id: 999,
      list_type: 'product_line',
      name: 'Motor',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    } as unknown as TenantInsertable<'reference_items'>;

    const compiled = forTenant(db, TENANT).insertInto('reference_items', values).compile();

    expect(compiled.parameters).toContain(42);
    expect(compiled.parameters).not.toContain(999);
  });

  it('exposes the tenant id it is scoped to', () => {
    expect(forTenant(db, TENANT).tenantId).toBe(42);
  });

  it('refuses a tenant id that did not come through toTenantId', () => {
    const untyped = forTenant as (client: typeof db, tenantId: unknown) => unknown;
    expect(() => untyped(db, undefined)).toThrowError(/tenant id/i);
    expect(() => untyped(db, 0)).toThrowError(/tenant id/i);
  });
});

describe('TENANT_SCOPED_TABLES', () => {
  it('is derived from the generated schema and covers the core business tables', () => {
    expect(TENANT_SCOPED_TABLES).toEqual(expect.arrayContaining(['leads', 'quotes', 'alerts']));
  });

  it('excludes tables that have no tenant_id column', () => {
    expect(TENANT_SCOPED_TABLES).not.toContain('tenants');
    expect(TENANT_SCOPED_TABLES).not.toContain('permissions');
  });

  it('excludes partitions, which must always be reached through the partitioned parent', () => {
    expect(TENANT_SCOPED_TABLES.filter((table) => table.endsWith('_default'))).toEqual([]);
  });
});
