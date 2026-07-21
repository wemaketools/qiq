/**
 * RBAC grant fixtures for the T-012 integration suites.
 *
 * Ported from the arrange blocks of
 * `src/api/tests/QuoteIQ.Infrastructure.Tests/Security/EffectivePermissionResolverTests.cs`, which
 * built each grant path row by row against a real database. Same approach here: real rows, real
 * joins, no in-memory stand-in for the schema.
 *
 * Tenant ids are synthetic and random, exactly as in the reference tests (`RandomId()`): none of the
 * grant tables has a foreign key to `tenants` (see 20260718001200_rbac.sql), and randomising them
 * keeps concurrently-running suites from colliding on a shared tenant.
 *
 * Permission CODES are taken from the real seeded catalog rather than invented, because
 * `role_permissions.permission_code` etc. are foreign keys to `permissions` — a made-up code would
 * fail to insert. Every fixture object created is tracked and removed by `cleanup()` in
 * reverse-dependency order.
 */
import type { PermissionCode } from '../../../domains/rbac/permission-catalog.js';

/** Runs a parameterised statement and returns rows. Satisfied by `TestAuthFixtures.query`. */
export type QueryFn = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

/** A tenant id for fixture rows. Random and high, so it cannot collide with seeded tenants. */
export function randomTenantId(): number {
  return 2_000_000_000 + Math.floor(Math.random() * 100_000_000);
}

interface CreatedRow {
  readonly table: string;
  readonly id: number;
}

export class RbacFixtures {
  readonly #query: QueryFn;
  /** Reverse-order teardown: junction rows are deleted before the roles/groups they reference. */
  readonly #created: CreatedRow[] = [];

  constructor(query: QueryFn) {
    this.#query = query;
  }

  async #insert(table: string, sql: string, params: unknown[]): Promise<number> {
    const rows = await this.#query<{ id: string | number }>(sql, params);
    const row = rows[0];
    if (row === undefined) throw new Error(`Insert into ${table} returned no id`);
    const id = typeof row.id === 'string' ? Number(row.id) : row.id;
    this.#created.push({ table, id });
    return id;
  }

  /** A role, tenant-scoped or (with `tenantId: null`) global. */
  async createRole(options: {
    tenantId: number | null;
    isActive?: boolean;
    permissions?: readonly PermissionCode[];
  }): Promise<number> {
    const roleId = await this.#insert(
      'roles',
      `insert into roles (tenant_id, name, is_active, created_at, updated_at)
       values ($1, $2, $3, now(), now()) returning id`,
      [options.tenantId, `t012-role-${crypto.randomUUID()}`, options.isActive ?? true],
    );

    for (const permission of options.permissions ?? []) {
      await this.#insert(
        'role_permissions',
        `insert into role_permissions (role_id, permission_code, created_at)
         values ($1, $2, now()) returning id`,
        [roleId, permission],
      );
    }

    return roleId;
  }

  /** A user group, with optional directly-attached permissions. */
  async createGroup(options: {
    tenantId: number | null;
    isActive?: boolean;
    permissions?: readonly PermissionCode[];
  }): Promise<number> {
    const groupId = await this.#insert(
      'user_groups',
      `insert into user_groups (tenant_id, name, is_active, created_at, updated_at)
       values ($1, $2, $3, now(), now()) returning id`,
      [options.tenantId, `t012-group-${crypto.randomUUID()}`, options.isActive ?? true],
    );

    for (const permission of options.permissions ?? []) {
      await this.#insert(
        'group_permissions',
        `insert into group_permissions (group_id, permission_code, created_at)
         values ($1, $2, now()) returning id`,
        [groupId, permission],
      );
    }

    return groupId;
  }

  /** Grant path (a): a permission granted straight to the user. */
  async grantDirectPermission(
    userId: number,
    permission: PermissionCode,
    tenantId: number | null,
  ): Promise<void> {
    await this.#insert(
      'user_permissions',
      `insert into user_permissions (user_id, permission_code, tenant_id, created_at)
       values ($1, $2, $3, now()) returning id`,
      [userId, permission, tenantId],
    );
  }

  /** Grant path (b): a role assigned directly to the user, within a tenant scope. */
  async assignRole(userId: number, roleId: number, tenantId: number | null): Promise<void> {
    await this.#insert(
      'user_roles',
      `insert into user_roles (user_id, role_id, tenant_id, created_at)
       values ($1, $2, $3, now()) returning id`,
      [userId, roleId, tenantId],
    );
  }

  /** Grant path (c), first half: a role attached to a group. */
  async assignRoleToGroup(groupId: number, roleId: number): Promise<void> {
    await this.#insert(
      'group_roles',
      `insert into group_roles (group_id, role_id, created_at) values ($1, $2, now()) returning id`,
      [groupId, roleId],
    );
  }

  /** Grant paths (c) and (d): group membership. */
  async addGroupMember(groupId: number, userId: number): Promise<void> {
    await this.#insert(
      'group_members',
      `insert into group_members (group_id, user_id, created_at) values ($1, $2, now()) returning id`,
      [groupId, userId],
    );
  }

  async cleanup(): Promise<void> {
    for (const row of [...this.#created].reverse()) {
      try {
        await this.#query(`delete from ${row.table} where id = $1`, [row.id]);
      } catch {
        // A concurrent `supabase db reset` may already have removed it; that is the desired end
        // state either way, so teardown never fails a suite.
      }
    }
    this.#created.length = 0;
  }
}
