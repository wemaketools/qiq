/**
 * Data API lockdown regression guard (T-014 / AC-023 / V-029 + V-030).
 *
 * Postgres RLS is NOT adopted (spec.md Q-10, human decision 2026-07-20). Tenant isolation is
 * enforced in the app layer (tenant-context middleware + repository tenant predicates, N-01).
 * That leaves exactly ONE database-level protection of tenant data: the PostgREST roles `anon`
 * and `authenticated` hold no DML privilege on anything in schema `public`, so the
 * browser-exposed anon key cannot read a single tenant row through the Data API.
 *
 * That property is currently true by default rather than by design — nothing in the migrations
 * asserts it, and a single stray `GRANT SELECT ... TO anon` in a future migration would remove
 * it silently, with no test failing anywhere else in the suite. Hence this file.
 *
 * Two deliberate design choices:
 *
 *   1. The table list is derived from the live catalog, never hardcoded, so a table added by a
 *      later migration is covered automatically instead of quietly escaping the check.
 *      Partitions are excluded (`relispartition`), matching `scripts/db/generate-types.ts`.
 *   2. The assertion is the ABSENCE of SELECT/INSERT/UPDATE/DELETE, not equality against the
 *      observed incidental privilege set (REFERENCES/TRIGGER/TRUNCATE, which Supabase grants by
 *      default and none of which can read or write a row). Pinning the exact set would turn a
 *      harmless Supabase default-privilege change into a false failure and train people to
 *      re-baseline the guard.
 *
 * `has_table_privilege` is checked alongside `information_schema.role_table_grants` on purpose:
 * the former resolves privileges reachable through role membership and PUBLIC grants, so a
 * privilege routed in some way other than a direct grant still fails the guard.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';

import { TestAuthFixtures } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;

/** The privileges that can read or modify a row. Nothing else is load-bearing here. */
const DML_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const;

/** The two roles PostgREST assumes for Data API requests: no key, and any end-user JWT. */
const DATA_API_ROLES = ['anon', 'authenticated'] as const;

/**
 * Every table in `public`, partitions excluded — rows are always reached through the
 * partitioned parent, and a partition inherits the parent's grants.
 */
const PUBLIC_TABLES_SQL = `
  select rel.relname as table_name
    from pg_class rel
    join pg_namespace ns on ns.oid = rel.relnamespace
   where ns.nspname = 'public'
     and rel.relkind in ('r', 'p')
     and rel.relispartition = false
   order by rel.relname
`;

const GRANTS_SQL = `
  select g.grantee, g.table_name, g.privilege_type
    from information_schema.role_table_grants g
    join pg_class rel on rel.relname = g.table_name
    join pg_namespace ns on ns.oid = rel.relnamespace and ns.nspname = g.table_schema
   where g.table_schema = 'public'
     and g.grantee = any($1::text[])
     and g.privilege_type = any($2::text[])
     and rel.relispartition = false
   order by g.grantee, g.table_name, g.privilege_type
`;

interface GrantRow {
  grantee: string;
  table_name: string;
  privilege_type: string;
}

interface PrivilegeProbeRow {
  role_name: string;
  table_name: string;
  privilege: string;
  has_privilege: boolean;
}

describeStack(suiteTitle('Data API lockdown: grant inventory (T-014, V-029)', probe), () => {
  let client: Client;
  let publicTables: string[];

  beforeAll(async () => {
    if (!probe.available) return;
    client = new Client({ connectionString: probe.stack.dbUrl });
    await client.connect();
    const { rows } = await client.query<{ table_name: string }>(PUBLIC_TABLES_SQL);
    publicTables = rows.map((row) => row.table_name);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('discovers the public tables from the live catalog rather than a hardcoded list', () => {
    // A catalog query that silently returns nothing would make every assertion below vacuous.
    expect(publicTables.length).toBeGreaterThan(0);
    expect(publicTables).toContain('leads');
    expect(publicTables).toContain('quotes');
    expect(publicTables).toContain('tenants');
  });

  it('grants anon and authenticated no SELECT, INSERT, UPDATE or DELETE on any public table', async () => {
    const { rows } = await client.query<GrantRow>(GRANTS_SQL, [
      [...DATA_API_ROLES],
      [...DML_PRIVILEGES],
    ]);

    // Rendered as strings so a failure names the offending role, privilege and table directly in
    // the diff instead of burying them in an object dump.
    const violations = rows.map(
      (row) => `${row.grantee} has ${row.privilege_type} on public.${row.table_name}`,
    );
    expect(violations).toEqual([]);
  });

  it('reports no effective DML privilege for anon or authenticated, including via role membership', async () => {
    const { rows } = await client.query<PrivilegeProbeRow>(
      `select r.role_name,
              t.table_name,
              p.privilege,
              has_table_privilege(r.role_name, format('public.%I', t.table_name), p.privilege) as has_privilege
         from unnest($1::text[]) as r(role_name)
        cross join unnest($2::text[]) as t(table_name)
        cross join unnest($3::text[]) as p(privilege)
        order by r.role_name, t.table_name, p.privilege`,
      [[...DATA_API_ROLES], publicTables, [...DML_PRIVILEGES]],
    );

    // Guards against the probe itself degenerating: rows must cover every role x table x privilege.
    expect(rows.length).toBe(DATA_API_ROLES.length * publicTables.length * DML_PRIVILEGES.length);

    const violations = rows
      .filter((row) => row.has_privilege)
      .map((row) => `${row.role_name} has ${row.privilege} on public.${row.table_name}`);
    expect(violations).toEqual([]);
  });
});

/**
 * V-030: the same property proven through the surface that actually matters — a real HTTP request
 * to the local PostgREST endpoint with the browser-exposed anon key, and with a real end-user
 * access token, against tables that demonstrably contain rows.
 *
 * Rows are seeded by this suite rather than assumed from `supabase/seed.sql`, so the proof holds
 * on a freshly reset database and the suite cannot pass merely because the table was empty.
 */
describeStack(suiteTitle('Data API lockdown: PostgREST denial (T-014, V-030)', probe), () => {
  let stack: LocalStack;
  let client: Client;
  let fixtures: TestAuthFixtures;
  let userAccessToken: string;
  let seededTenantId: number;

  /** Tables probed over HTTP: two seeded by this suite, three core tenant tables besides. */
  const SEEDED_TABLES = ['tenants', 'roles'] as const;
  const PROBED_TABLES = [...SEEDED_TABLES, 'leads', 'quotes', 'users'] as const;

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;
    client = new Client({ connectionString: stack.dbUrl });
    await client.connect();

    const tenant = await client.query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`t014-lockdown-${process.pid}-${Date.now()}`],
    );
    seededTenantId = Number(tenant.rows[0]?.id);

    await client.query(
      `insert into roles (tenant_id, name, is_active, created_at, updated_at)
       values ($1, $2, true, now(), now())`,
      [seededTenantId, `t014-lockdown-role-${crypto.randomUUID()}`],
    );

    fixtures = new TestAuthFixtures(stack);
    const session = await fixtures.createTestUserWithSession({ label: 't014' });
    userAccessToken = session.accessToken;
  });

  afterAll(async () => {
    if (client !== undefined && seededTenantId !== undefined) {
      await client.query('delete from roles where tenant_id = $1', [seededTenantId]);
      await client.query('delete from tenants where id = $1', [seededTenantId]);
    }
    await fixtures?.cleanup();
    await client?.end();
  });

  async function get(table: string, token: string): Promise<{ status: number; body: string }> {
    const response = await fetch(`${stack.apiUrl}/rest/v1/${table}?select=*&limit=5`, {
      headers: { apikey: stack.anonKey, Authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.text() };
  }

  it('has rows present in the seeded tenant tables (otherwise the denial below proves nothing)', async () => {
    for (const table of SEEDED_TABLES) {
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from ${table} where ${table === 'tenants' ? 'id' : 'tenant_id'} = $1`,
        [seededTenantId],
      );
      expect(rows[0]?.n).toBeGreaterThan(0);
    }
  });

  it.each(PROBED_TABLES)(
    'denies the browser-exposed anon key at the privilege level on public.%s',
    async (table) => {
      const { status, body } = await get(table, stack.anonKey);

      expect(status).toBe(401);
      const parsed = JSON.parse(body) as { code?: string; message?: string };
      expect(parsed.code).toBe('42501');
      expect(parsed.message).toContain(`permission denied for table ${table}`);
      // No row payload of any kind came back.
      expect(Array.isArray(parsed)).toBe(false);
    },
  );

  it.each(PROBED_TABLES)(
    'denies a real end-user access token at the privilege level on public.%s',
    async (table) => {
      const { status, body } = await get(table, userAccessToken);

      // 403 rather than the anon path's 401: the request IS authenticated, it is the `authenticated`
      // role's privileges that are missing. Both are the same 42501 grant-level denial underneath.
      expect(status).toBe(403);
      const parsed = JSON.parse(body) as { code?: string; message?: string };
      expect(parsed.code).toBe('42501');
      expect(parsed.message).toContain(`permission denied for table ${table}`);
      expect(Array.isArray(parsed)).toBe(false);
    },
  );
});
