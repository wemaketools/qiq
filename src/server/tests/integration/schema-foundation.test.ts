/**
 * T-003 / AC-005 / AC-006 — V-006 + V-007 (first bullet).
 *
 * Asserts the foundation schema (identity, tenancy, RBAC, audit, reference sequences) exists
 * with the ported shape, and that the A-12 conventions hold: bigint identity PKs, LIST
 * partitioning on tenant_id with composite (tenant_id, id) PKs, timestamptz everywhere,
 * jsonb confined to audit payloads, and a partition-creation function that actually produces
 * usable partitions for a brand-new tenant id.
 *
 * These are catalog assertions plus one behavioural assertion (insert into each freshly
 * created partition). Catalog-only checks would pass against a table that exists but cannot
 * accept a row, which is precisely the failure mode partitioning bugs produce.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('foundation schema (T-003)', probe);

/** Every table T-003 owns. */
const FOUNDATION_TABLES = [
  'audit_log',
  'group_members',
  'group_permissions',
  'group_roles',
  'permissions',
  'reference_sequences',
  'role_permissions',
  'roles',
  'tenants',
  'user_groups',
  'user_permissions',
  'user_roles',
  'user_tenants',
  'users',
] as const;

/** Tables T-003 creates as LIST partitions of tenant_id. */
const PARTITIONED_TABLES = ['reference_sequences', 'user_tenants'] as const;

interface ColumnRow {
  column_name: string;
  data_type: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
}

describeStack(title, () => {
  let client: Client;

  beforeAll(async () => {
    if (!probe.available) return;
    client = new Client({ connectionString: probe.stack.dbUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function columns(table: string): Promise<Map<string, ColumnRow>> {
    const { rows } = await client.query<ColumnRow>(
      `select column_name, data_type, udt_name, is_nullable
         from information_schema.columns
        where table_schema = 'public' and table_name = $1`,
      [table],
    );
    return new Map(rows.map((r) => [r.column_name, r]));
  }

  describe('table inventory (V-007)', () => {
    it('creates every foundation table in the public schema', async () => {
      const { rows } = await client.query<{ table_name: string }>(
        `select c.relname as table_name
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public'
            and c.relkind in ('r', 'p')
            and c.relname = any($1::text[])
          order by c.relname`,
        [[...FOUNDATION_TABLES]],
      );
      expect(rows.map((r) => r.table_name)).toEqual([...FOUNDATION_TABLES]);
    });
  });

  describe('users identity link (AC-006)', () => {
    it('links to Supabase auth via a non-null uuid auth_user_id and no keycloak_id remains', async () => {
      const cols = await columns('users');

      expect(cols.get('auth_user_id')).toMatchObject({ udt_name: 'uuid', is_nullable: 'NO' });
      expect(cols.has('keycloak_id')).toBe(false);
      expect(cols.get('email')).toMatchObject({ udt_name: 'citext', is_nullable: 'NO' });
      expect(cols.get('is_active')).toMatchObject({ udt_name: 'bool', is_nullable: 'NO' });
      expect(cols.get('last_tenant_id')).toMatchObject({ udt_name: 'int8', is_nullable: 'YES' });
      expect(cols.get('theme_preference')).toMatchObject({ udt_name: 'text', is_nullable: 'YES' });
    });

    it('enforces auth_user_id with a real foreign key onto auth.users', async () => {
      const { rows } = await client.query<{ conname: string; ref: string; confdeltype: string }>(
        `select conname, confrelid::regclass::text as ref, confdeltype
           from pg_constraint
          where conrelid = 'public.users'::regclass and contype = 'f'`,
      );
      const fk = rows.find((r) => r.ref === 'auth.users');
      expect(fk, 'users must carry an FK to auth.users').toBeDefined();
      // 'r' = ON DELETE RESTRICT: removing an auth identity must never cascade away an app
      // user row, because app users are deactivated and never deleted (AC-029).
      expect(fk?.confdeltype).toBe('r');
    });

    it('enforces auth_user_id uniqueness', async () => {
      const { rows } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'users' and indexname = 'uq_users_auth_user_id'`,
      );
      expect(rows[0]?.indexdef).toContain('UNIQUE');
    });
  });

  describe('tenants soft-remove (AC-006)', () => {
    it('constrains status to active/removed and keeps removal columns', async () => {
      const cols = await columns('tenants');
      expect(cols.get('status')).toMatchObject({ udt_name: 'text', is_nullable: 'NO' });
      expect(cols.has('removed_at')).toBe(true);
      expect(cols.has('removed_by')).toBe(true);

      const { rows } = await client.query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def
           from pg_constraint where conname = 'ck_tenants_status'`,
      );
      expect(rows[0]?.def).toContain("'active'");
      expect(rows[0]?.def).toContain("'removed'");
    });

    it('allows a removed tenant name to be reused via the partial active-name unique index', async () => {
      const { rows } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'uq_tenants_active_name'`,
      );
      expect(rows[0]?.indexdef).toMatch(/WHERE \(status = 'active'/);
      expect(rows[0]?.indexdef).toContain('lower(name)');
    });
  });

  describe('audit_log (AC-006)', () => {
    it('stores its payload as jsonb and indexes the documented access paths', async () => {
      const cols = await columns('audit_log');
      expect(cols.get('details')).toMatchObject({ udt_name: 'jsonb', is_nullable: 'YES' });
      expect(cols.get('tenant_id')).toMatchObject({ is_nullable: 'YES' });
      expect(cols.get('acted_at')).toMatchObject({ udt_name: 'timestamptz', is_nullable: 'NO' });
      expect(cols.has('actor_label')).toBe(true);

      const { rows } = await client.query<{ indexname: string }>(
        `select indexname from pg_indexes
          where schemaname = 'public' and tablename = 'audit_log' order by indexname`,
      );
      expect(rows.map((r) => r.indexname)).toEqual([
        'audit_log_pkey',
        'ix_audit_log_acted_at',
        'ix_audit_log_entity',
        'ix_audit_log_tenant_id',
      ]);
    });
  });

  describe('A-12 conventions (AC-005 / V-006)', () => {
    it('gives every foundation table with an id column a bigint identity primary key', async () => {
      const { rows } = await client.query<{ table_name: string; data_type: string; is_identity: string }>(
        `select table_name, data_type, is_identity
           from information_schema.columns
          where table_schema = 'public' and column_name = 'id' and table_name = any($1::text[])
          order by table_name`,
        [[...FOUNDATION_TABLES]],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(`${row.table_name}:${row.data_type}`).toBe(`${row.table_name}:bigint`);
        expect(`${row.table_name}:${row.is_identity}`).toBe(`${row.table_name}:YES`);
      }
    });

    it('uses no uuid column anywhere except the users.auth_user_id identity link', async () => {
      const { rows } = await client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public' and udt_name = 'uuid' and table_name = any($1::text[])
          order by table_name, column_name`,
        [[...FOUNDATION_TABLES]],
      );
      expect(rows).toEqual([{ table_name: 'users', column_name: 'auth_user_id' }]);
    });

    it('uses timestamptz for every timestamp column', async () => {
      const { rows } = await client.query<{ table_name: string; column_name: string; data_type: string }>(
        `select table_name, column_name, data_type
           from information_schema.columns
          where table_schema = 'public'
            and table_name = any($1::text[])
            and data_type like 'timestamp%'
            and data_type <> 'timestamp with time zone'`,
        [[...FOUNDATION_TABLES]],
      );
      expect(rows).toEqual([]);
    });

    it('confines jsonb to the audit payload column', async () => {
      const { rows } = await client.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name
           from information_schema.columns
          where table_schema = 'public' and udt_name = 'jsonb' and table_name = any($1::text[])`,
        [[...FOUNDATION_TABLES]],
      );
      expect(rows).toEqual([{ table_name: 'audit_log', column_name: 'details' }]);
    });

    it('LIST-partitions the tenant-scoped tables on tenant_id with composite (tenant_id, id) PKs', async () => {
      const { rows } = await client.query<{ table_name: string; strategy: string; key: string }>(
        `select c.relname as table_name,
                p.partstrat as strategy,
                pg_get_partkeydef(c.oid) as key
           from pg_partitioned_table p
           join pg_class c on c.oid = p.partrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1::text[])
          order by c.relname`,
        [[...PARTITIONED_TABLES]],
      );
      expect(rows.map((r) => r.table_name)).toEqual([...PARTITIONED_TABLES]);
      for (const row of rows) {
        expect(`${row.table_name}:${row.strategy}`).toBe(`${row.table_name}:l`);
        expect(`${row.table_name}:${row.key}`).toBe(`${row.table_name}:LIST (tenant_id)`);
      }

      const { rows: pks } = await client.query<{ table_name: string; def: string }>(
        `select c.relname as table_name, pg_get_constraintdef(con.oid) as def
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and con.contype = 'p' and c.relname = any($1::text[])
          order by c.relname`,
        [[...PARTITIONED_TABLES]],
      );
      for (const pk of pks) {
        expect(`${pk.table_name}:${pk.def}`).toBe(`${pk.table_name}:PRIMARY KEY (tenant_id, id)`);
      }
    });

    it('includes tenant_id in every unique constraint on a partitioned table', async () => {
      const { rows } = await client.query<{ table_name: string; conname: string; def: string }>(
        `select c.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as def
           from pg_constraint con
           join pg_class c on c.oid = con.conrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and con.contype = 'u' and c.relname = any($1::text[])`,
        [[...PARTITIONED_TABLES]],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(`${row.conname}:${row.def.includes('tenant_id')}`).toBe(`${row.conname}:true`);
      }
    });

    it('creates a DEFAULT partition safety net for every partitioned table', async () => {
      for (const table of PARTITIONED_TABLES) {
        const { rows } = await client.query<{ child: string; bound: string }>(
          `select child.relname as child, pg_get_expr(child.relpartbound, child.oid) as bound
             from pg_inherits i
             join pg_class parent on parent.oid = i.inhparent
             join pg_class child on child.oid = i.inhrelid
            where parent.relname = $1 and pg_get_expr(child.relpartbound, child.oid) = 'DEFAULT'`,
          [table],
        );
        expect(rows.map((r) => r.child), `${table} must have a DEFAULT partition`).toEqual([
          `${table}_default`,
        ]);
      }
    });
  });

  describe('create_tenant_partitions (AC-005 / V-006)', () => {
    it('creates and makes insertable a partition on every partitioned table for a brand-new tenant', async () => {
      await client.query('begin');
      try {
        const { rows: tenantRows } = await client.query<{ id: string }>(
          `insert into tenants (name, created_at, updated_at)
           values ($1, now(), now()) returning id`,
          [`t003-partition-probe-${process.pid}`],
        );
        const tenantId = tenantRows[0]!.id;

        await client.query('select create_tenant_partitions($1::bigint)', [tenantId]);

        // Discovered from the catalog rather than hard-coded, so this assertion covers
        // "all partitioned tables" as the schema grows (T-004/T-005) instead of a fixed list.
        const { rows: partitionedNow } = await client.query<{ table_name: string }>(
          `select c.relname as table_name
             from pg_partitioned_table p
             join pg_class c on c.oid = p.partrelid
             join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and pg_get_partkeydef(c.oid) = 'LIST (tenant_id)'
            order by c.relname`,
        );
        expect(partitionedNow.length).toBeGreaterThanOrEqual(PARTITIONED_TABLES.length);

        for (const { table_name: table } of partitionedNow) {
          const { rows } = await client.query<{ bound: string }>(
            `select pg_get_expr(child.relpartbound, child.oid) as bound
               from pg_inherits i
               join pg_class parent on parent.oid = i.inhparent
               join pg_class child on child.oid = i.inhrelid
              where parent.relname = $1 and child.relname = $2`,
            [table, `${table}_p${tenantId}`],
          );
          expect(rows[0]?.bound, `${table}_p${tenantId} must exist`).toBe(`FOR VALUES IN ('${tenantId}')`);
        }

        // Behavioural proof: rows actually land in the new per-tenant partitions.
        const authId = await client.query<{ id: string }>(
          'insert into auth.users (id) values (gen_random_uuid()) returning id',
        );
        const { rows: userRows } = await client.query<{ id: string }>(
          `insert into users (auth_user_id, first_name, last_name, email, created_at, updated_at)
           values ($1, 'Part', 'Probe', $2, now(), now()) returning id`,
          [authId.rows[0]!.id, `part.probe.${process.pid}@example.test`],
        );

        await client.query(
          'insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())',
          [tenantId, userRows[0]!.id],
        );
        await client.query(
          `insert into reference_sequences (tenant_id, entity_type, year, next_value)
           values ($1, 'lead', 2026, 0)`,
          [tenantId],
        );

        const landed = await client.query(`select 1 from user_tenants_p${tenantId}`);
        expect(landed.rowCount, 'user_tenants row must land in the tenant partition').toBe(1);
        const landedSeq = await client.query(`select 1 from reference_sequences_p${tenantId}`);
        expect(landedSeq.rowCount, 'reference_sequences row must land in the tenant partition').toBe(1);
      } finally {
        // Rolling back also drops the partitions created inside the transaction, which is the
        // property that lets tenant creation (T-016) be transactional in the first place.
        await client.query('rollback');
      }
    });

    it('is idempotent when called twice for the same tenant', async () => {
      await client.query('begin');
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into tenants (name, created_at, updated_at)
           values ($1, now(), now()) returning id`,
          [`t003-idempotency-probe-${process.pid}`],
        );
        const tenantId = rows[0]!.id;
        await client.query('select create_tenant_partitions($1::bigint)', [tenantId]);
        await expect(
          client.query('select create_tenant_partitions($1::bigint)', [tenantId]),
        ).resolves.toBeDefined();
      } finally {
        await client.query('rollback');
      }
    });
  });
});
