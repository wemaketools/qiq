/**
 * T-003 / AC-006 — V-007 (second bullet).
 *
 * Every FK, unique and check constraint carried over from the Liquibase source gets a
 * negative-insert test: a deliberately violating statement must raise the expected SQLSTATE.
 * Asserting the constraint merely appears in pg_constraint proves nothing about enforcement —
 * a NOT VALID or mis-targeted constraint would still be listed.
 *
 * All work happens inside one transaction with a savepoint per case, so the suite leaves no
 * rows behind and the cases are order-independent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type DatabaseError } from 'pg';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('foundation schema constraints (T-003)', probe);

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

interface Fixtures {
  tenantId: string;
  authUserId: string;
  userId: string;
  roleId: string;
  groupId: string;
  permissionCode: string;
}

describeStack(title, () => {
  let client: Client;
  let f: Fixtures;

  beforeAll(async () => {
    if (!probe.available) return;
    client = new Client({ connectionString: probe.stack.dbUrl });
    await client.connect();
    await client.query('begin');

    const suffix = `t003c${process.pid}`;

    const tenant = await client.query<{ id: string }>(
      `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
      [`tenant-${suffix}`],
    );
    const auth = await client.query<{ id: string }>(
      'insert into auth.users (id) values (gen_random_uuid()) returning id',
    );
    const user = await client.query<{ id: string }>(
      `insert into users (auth_user_id, first_name, last_name, email, created_at, updated_at)
       values ($1, 'Con', 'Straint', $2, now(), now()) returning id`,
      [auth.rows[0]!.id, `${suffix}@example.test`],
    );
    const role = await client.query<{ id: string }>(
      `insert into roles (tenant_id, name, created_at, updated_at)
       values ($1, $2, now(), now()) returning id`,
      [tenant.rows[0]!.id, `role-${suffix}`],
    );
    const group = await client.query<{ id: string }>(
      `insert into user_groups (tenant_id, name, created_at, updated_at)
       values ($1, $2, now(), now()) returning id`,
      [tenant.rows[0]!.id, `group-${suffix}`],
    );
    const permission = await client.query<{ code: string }>(
      `insert into permissions (code, category, description)
       values ($1, 'test', 'constraint fixture') returning code`,
      [`t003.${suffix}`],
    );

    f = {
      tenantId: tenant.rows[0]!.id,
      authUserId: auth.rows[0]!.id,
      userId: user.rows[0]!.id,
      roleId: role.rows[0]!.id,
      groupId: group.rows[0]!.id,
      permissionCode: permission.rows[0]!.code,
    };

    // Seed one valid row per association table so the duplicate cases below have something
    // to collide with.
    await client.query('insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())', [
      f.tenantId,
      f.userId,
    ]);
    await client.query(
      'insert into role_permissions (role_id, permission_code, created_at) values ($1, $2, now())',
      [f.roleId, f.permissionCode],
    );
    await client.query(
      'insert into user_roles (user_id, role_id, tenant_id, created_at) values ($1, $2, $3, now())',
      [f.userId, f.roleId, f.tenantId],
    );
    await client.query(
      'insert into user_permissions (user_id, permission_code, tenant_id, created_at) values ($1, $2, $3, now())',
      [f.userId, f.permissionCode, f.tenantId],
    );
    await client.query('insert into group_members (group_id, user_id, created_at) values ($1, $2, now())', [
      f.groupId,
      f.userId,
    ]);
    await client.query('insert into group_roles (group_id, role_id, created_at) values ($1, $2, now())', [
      f.groupId,
      f.roleId,
    ]);
    await client.query(
      'insert into group_permissions (group_id, permission_code, created_at) values ($1, $2, now())',
      [f.groupId, f.permissionCode],
    );
    await client.query(
      `insert into reference_sequences (tenant_id, entity_type, year, next_value) values ($1, 'lead', 2026, 0)`,
      [f.tenantId],
    );
  });

  afterAll(async () => {
    if (client) {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
  });

  /** Runs a statement inside a savepoint and returns the SQLSTATE it raised, or null. */
  async function violationCode(sql: string, params: readonly unknown[]): Promise<string | null> {
    await client.query('savepoint negative_case');
    try {
      await client.query(sql, [...params]);
      await client.query('release savepoint negative_case');
      return null;
    } catch (error) {
      await client.query('rollback to savepoint negative_case');
      return (error as DatabaseError).code ?? 'unknown';
    }
  }

  interface Case {
    constraint: string;
    expected: string;
    sql: string;
    params: () => readonly unknown[];
  }

  const cases: Case[] = [
    {
      constraint: 'uq_users_auth_user_id',
      expected: UNIQUE_VIOLATION,
      sql: `insert into users (auth_user_id, first_name, last_name, email, created_at, updated_at)
            values ($1, 'Dup', 'Auth', $2, now(), now())`,
      params: () => [f.authUserId, `dup-auth-${process.pid}@example.test`],
    },
    {
      constraint: 'uq_users_email (case-insensitive)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into users (auth_user_id, first_name, last_name, email, created_at, updated_at)
            values (gen_random_uuid(), 'Dup', 'Email', $1, now(), now())`,
      params: () => [`T003C${process.pid}@EXAMPLE.TEST`.toUpperCase()],
    },
    {
      constraint: 'users.auth_user_id -> auth.users(id)',
      expected: FK_VIOLATION,
      sql: `insert into users (auth_user_id, first_name, last_name, email, created_at, updated_at)
            values ('00000000-0000-0000-0000-0000000000ff', 'No', 'Identity', $1, now(), now())`,
      params: () => [`no-identity-${process.pid}@example.test`],
    },
    {
      constraint: 'ck_tenants_status',
      expected: CHECK_VIOLATION,
      sql: `insert into tenants (name, status, created_at, updated_at) values ($1, 'archived', now(), now())`,
      params: () => [`bad-status-${process.pid}`],
    },
    {
      constraint: 'uq_tenants_active_name (case-insensitive, active only)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into tenants (name, created_at, updated_at) values ($1, now(), now())`,
      params: () => [`TENANT-T003C${process.pid}`.toUpperCase()],
    },
    {
      constraint: 'uq_user_tenants_user_tenant',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())',
      params: () => [f.tenantId, f.userId],
    },
    {
      constraint: 'user_tenants.user_id -> users(id)',
      expected: FK_VIOLATION,
      sql: 'insert into user_tenants (tenant_id, user_id, created_at) values ($1, 987654321, now())',
      params: () => [f.tenantId],
    },
    {
      constraint: 'uq_roles_tenant_name',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into roles (tenant_id, name, created_at, updated_at) values ($1, $2, now(), now())',
      params: () => [f.tenantId, `role-t003c${process.pid}`],
    },
    {
      constraint: 'uq_role_permissions_role_permission',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into role_permissions (role_id, permission_code, created_at) values ($1, $2, now())',
      params: () => [f.roleId, f.permissionCode],
    },
    {
      constraint: 'fk_role_permissions_role',
      expected: FK_VIOLATION,
      sql: 'insert into role_permissions (role_id, permission_code, created_at) values (987654321, $1, now())',
      params: () => [f.permissionCode],
    },
    {
      constraint: 'fk_role_permissions_permission',
      expected: FK_VIOLATION,
      sql: `insert into role_permissions (role_id, permission_code, created_at) values ($1, 'no.such.permission', now())`,
      params: () => [f.roleId],
    },
    {
      constraint: 'uq_user_roles_user_role_tenant',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into user_roles (user_id, role_id, tenant_id, created_at) values ($1, $2, $3, now())',
      params: () => [f.userId, f.roleId, f.tenantId],
    },
    {
      constraint: 'fk_user_roles_user',
      expected: FK_VIOLATION,
      sql: 'insert into user_roles (user_id, role_id, tenant_id, created_at) values (987654321, $1, $2, now())',
      params: () => [f.roleId, f.tenantId],
    },
    {
      constraint: 'fk_user_roles_role',
      expected: FK_VIOLATION,
      sql: 'insert into user_roles (user_id, role_id, tenant_id, created_at) values ($1, 987654321, $2, now())',
      params: () => [f.userId, f.tenantId],
    },
    {
      constraint: 'uq_user_permissions_user_permission_tenant',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into user_permissions (user_id, permission_code, tenant_id, created_at) values ($1, $2, $3, now())',
      params: () => [f.userId, f.permissionCode, f.tenantId],
    },
    {
      constraint: 'fk_user_permissions_user',
      expected: FK_VIOLATION,
      sql: 'insert into user_permissions (user_id, permission_code, tenant_id, created_at) values (987654321, $1, $2, now())',
      params: () => [f.permissionCode, f.tenantId],
    },
    {
      constraint: 'fk_user_permissions_permission',
      expected: FK_VIOLATION,
      sql: `insert into user_permissions (user_id, permission_code, tenant_id, created_at) values ($1, 'no.such.permission', $2, now())`,
      params: () => [f.userId, f.tenantId],
    },
    {
      constraint: 'uq_user_groups_tenant_name',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into user_groups (tenant_id, name, created_at, updated_at) values ($1, $2, now(), now())',
      params: () => [f.tenantId, `group-t003c${process.pid}`],
    },
    {
      constraint: 'uq_group_members_group_user',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into group_members (group_id, user_id, created_at) values ($1, $2, now())',
      params: () => [f.groupId, f.userId],
    },
    {
      constraint: 'fk_group_members_group',
      expected: FK_VIOLATION,
      sql: 'insert into group_members (group_id, user_id, created_at) values (987654321, $1, now())',
      params: () => [f.userId],
    },
    {
      constraint: 'fk_group_members_user',
      expected: FK_VIOLATION,
      sql: 'insert into group_members (group_id, user_id, created_at) values ($1, 987654321, now())',
      params: () => [f.groupId],
    },
    {
      constraint: 'uq_group_roles_group_role',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into group_roles (group_id, role_id, created_at) values ($1, $2, now())',
      params: () => [f.groupId, f.roleId],
    },
    {
      constraint: 'fk_group_roles_group',
      expected: FK_VIOLATION,
      sql: 'insert into group_roles (group_id, role_id, created_at) values (987654321, $1, now())',
      params: () => [f.roleId],
    },
    {
      constraint: 'fk_group_roles_role',
      expected: FK_VIOLATION,
      sql: 'insert into group_roles (group_id, role_id, created_at) values ($1, 987654321, now())',
      params: () => [f.groupId],
    },
    {
      constraint: 'uq_group_permissions_group_permission',
      expected: UNIQUE_VIOLATION,
      sql: 'insert into group_permissions (group_id, permission_code, created_at) values ($1, $2, now())',
      params: () => [f.groupId, f.permissionCode],
    },
    {
      constraint: 'fk_group_permissions_group',
      expected: FK_VIOLATION,
      sql: 'insert into group_permissions (group_id, permission_code, created_at) values (987654321, $1, now())',
      params: () => [f.permissionCode],
    },
    {
      constraint: 'fk_group_permissions_permission',
      expected: FK_VIOLATION,
      sql: `insert into group_permissions (group_id, permission_code, created_at) values ($1, 'no.such.permission', now())`,
      params: () => [f.groupId],
    },
    {
      constraint: 'uq_reference_sequences_tenant_entity_year',
      expected: UNIQUE_VIOLATION,
      sql: `insert into reference_sequences (tenant_id, entity_type, year, next_value) values ($1, 'lead', 2026, 0)`,
      params: () => [f.tenantId],
    },
  ];

  it.each(cases)('rejects a row violating $constraint', async ({ sql, params, expected }) => {
    expect(await violationCode(sql, params())).toBe(expected);
  });

  it('allows a removed tenant name to be reused (partial index does NOT over-reject)', async () => {
    await client.query('savepoint reuse_case');
    try {
      const name = `reuse-${process.pid}`;
      await client.query(
        `insert into tenants (name, status, removed_at, created_at, updated_at)
         values ($1, 'removed', now(), now(), now())`,
        [name],
      );
      await client.query(`insert into tenants (name, created_at, updated_at) values ($1, now(), now())`, [
        name,
      ]);
    } finally {
      await client.query('rollback to savepoint reuse_case');
    }
  });

  it('allows the same user/role pair in two different tenants (tenant context is part of the key)', async () => {
    await client.query('savepoint tenant_scope_case');
    try {
      const other = await client.query<{ id: string }>(
        `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
        [`other-${process.pid}`],
      );
      await client.query(
        'insert into user_roles (user_id, role_id, tenant_id, created_at) values ($1, $2, $3, now())',
        [f.userId, f.roleId, other.rows[0]!.id],
      );
    } finally {
      await client.query('rollback to savepoint tenant_scope_case');
    }
  });
});
