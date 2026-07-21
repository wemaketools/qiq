/**
 * T-004 / AC-007 — V-005, V-008.
 *
 * Negative-insert coverage for every constraint T-004's migrations carry, plus the structural
 * guarantees that make api_credentials safe to store (Q-19) and the partitioning that makes the
 * tenant-scoped tables usable.
 *
 * Every constraint case asserts the actual SQLSTATE raised by a deliberately violating statement.
 * Asserting a constraint is merely LISTED in pg_constraint proves nothing about enforcement: a
 * NOT VALID, mis-targeted, or partition-local constraint would still show up in the catalog while
 * happily accepting the row it is supposed to reject.
 *
 * All work happens inside one transaction with a savepoint per case, so the suite leaves no rows
 * behind and the cases are order-independent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, type DatabaseError } from 'pg';
import { probeLocalStack, suiteTitle } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('reference/settings/credentials schema constraints (T-004)', probe);

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

/** Tables T-004 creates as LIST partitions of tenant_id. */
const PARTITIONED_TABLES = [
  'api_credentials',
  'business_assignments',
  'reference_items',
  'tenant_settings',
] as const;

interface Fixtures {
  tenantId: string;
  roleId: string;
  otherRoleId: string;
}

describeStack(title, () => {
  let client: Client;
  let f: Fixtures;

  beforeAll(async () => {
    if (!probe.available) return;
    client = new Client({ connectionString: probe.stack.dbUrl });
    await client.connect();
    await client.query('begin');

    const suffix = `t004c${process.pid}`;

    const tenant = await client.query<{ id: string }>(
      `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
      [`tenant-${suffix}`],
    );
    const tenantId = tenant.rows[0]!.id;

    const role = await client.query<{ id: string }>(
      `insert into roles (tenant_id, name, created_at, updated_at)
       values ($1, $2, now(), now()) returning id`,
      [tenantId, `role-${suffix}`],
    );
    const otherRole = await client.query<{ id: string }>(
      `insert into roles (tenant_id, name, created_at, updated_at)
       values ($1, $2, now(), now()) returning id`,
      [tenantId, `role-other-${suffix}`],
    );

    f = { tenantId, roleId: role.rows[0]!.id, otherRoleId: otherRole.rows[0]!.id };

    // Seed one valid row per table so the duplicate cases below have something to collide with.
    await client.query(
      `insert into reference_items
         (tenant_id, list_type, name, canonical_key, reporting_category, is_terminal, created_at, updated_at)
       values ($1, 'quote_status', 'Won', 'won', 'won', true, now(), now())`,
      [f.tenantId],
    );
    await client.query(
      `insert into default_reference_items (list_type, name, created_at, updated_at)
       values ($1, 'Template Motor', now(), now())`,
      ['product_line'],
    );
    await client.query(
      `insert into tenant_settings (tenant_id, created_at, updated_at) values ($1, now(), now())`,
      [f.tenantId],
    );
    await client.query(
      `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
       values ($1, $2, 'rm', now(), now())`,
      [f.tenantId, f.roleId],
    );
    await client.query(
      `insert into api_credentials
         (tenant_id, key_id, key_hash, key_salt, name, created_at)
       values ($1, $2, 'hash-value', 'salt-value', 'Seed credential', now())`,
      [f.tenantId, `key-${suffix}`],
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
    // ---- reference_items -------------------------------------------------------------------
    {
      constraint: 'ck_reference_items_reporting_category (invalid category)',
      expected: CHECK_VIOLATION,
      sql: `insert into reference_items (tenant_id, list_type, name, reporting_category, created_at, updated_at)
            values ($1, 'quote_status', 'Bogus Category', 'in_progress', now(), now())`,
      params: () => [f.tenantId],
    },
    {
      constraint: 'ck_reference_items_list_type (invalid list type)',
      expected: CHECK_VIOLATION,
      sql: `insert into reference_items (tenant_id, list_type, name, created_at, updated_at)
            values ($1, 'not_a_list_type', 'Bogus List', now(), now())`,
      params: () => [f.tenantId],
    },
    {
      constraint: 'uq_reference_items_tenant_list_name',
      expected: UNIQUE_VIOLATION,
      sql: `insert into reference_items (tenant_id, list_type, name, created_at, updated_at)
            values ($1, 'quote_status', 'Won', now(), now())`,
      params: () => [f.tenantId],
    },
    {
      // The strengthening deviation documented in the migration header: a second row carrying the
      // same canonical_key inside one tenant's quote_status list would make "the won status"
      // ambiguous for every metric that resolves by key.
      constraint: 'uq_reference_items_tenant_list_canonical_key (duplicate canonical key)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into reference_items (tenant_id, list_type, name, canonical_key, created_at, updated_at)
            values ($1, 'quote_status', 'Won (renamed)', 'won', now(), now())`,
      params: () => [f.tenantId],
    },

    // ---- default_reference_items -----------------------------------------------------------
    {
      constraint: 'ck_default_reference_items_reporting_category',
      expected: CHECK_VIOLATION,
      sql: `insert into default_reference_items (list_type, name, reporting_category, created_at, updated_at)
            values ('lead_status', $1, 'in_progress', now(), now())`,
      params: () => [`bad-category-${process.pid}`],
    },
    {
      constraint: 'ck_default_reference_items_list_type',
      expected: CHECK_VIOLATION,
      sql: `insert into default_reference_items (list_type, name, created_at, updated_at)
            values ('not_a_list_type', $1, now(), now())`,
      params: () => [`bad-list-${process.pid}`],
    },
    {
      constraint: 'uq_default_reference_items_list_name',
      expected: UNIQUE_VIOLATION,
      sql: `insert into default_reference_items (list_type, name, created_at, updated_at)
            values ('product_line', 'Template Motor', now(), now())`,
      params: () => [],
    },

    // ---- tenant_settings -------------------------------------------------------------------
    {
      constraint: 'uq_tenant_settings_tenant_id (exactly one settings row per tenant)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into tenant_settings (tenant_id, created_at, updated_at) values ($1, now(), now())`,
      params: () => [f.tenantId],
    },

    // ---- business_assignments --------------------------------------------------------------
    {
      // "One role per slot per tenant": a DIFFERENT role competing for the SAME occupied slot is
      // the case that matters, and it must be rejected.
      constraint: 'uq_business_assignments_tenant_slot (second role in an occupied slot)',
      expected: UNIQUE_VIOLATION,
      sql: `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
            values ($1, $2, 'rm', now(), now())`,
      params: () => [f.tenantId, f.otherRoleId],
    },
    {
      constraint: 'ck_business_assignments_slot (invented third slot)',
      expected: CHECK_VIOLATION,
      sql: `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
            values ($1, $2, 'approver', now(), now())`,
      params: () => [f.tenantId, f.otherRoleId],
    },

    // ---- api_credentials -------------------------------------------------------------------
    {
      constraint: 'ck_api_credentials_status',
      expected: CHECK_VIOLATION,
      sql: `insert into api_credentials (tenant_id, key_id, key_hash, key_salt, name, status, created_at)
            values ($1, $2, 'h', 's', 'Bad status', 'revoked', now())`,
      params: () => [f.tenantId, `bad-status-${process.pid}`],
    },
    {
      constraint: 'uq_api_credentials_key_id',
      expected: UNIQUE_VIOLATION,
      sql: `insert into api_credentials (tenant_id, key_id, key_hash, key_salt, name, created_at)
            values ($1, $2, 'h', 's', 'Duplicate key id', now())`,
      params: () => [f.tenantId, `key-t004c${process.pid}`],
    },
    {
      constraint: 'api_credentials.key_hash NOT NULL',
      expected: NOT_NULL_VIOLATION,
      sql: `insert into api_credentials (tenant_id, key_id, key_hash, key_salt, name, created_at)
            values ($1, $2, null, 's', 'No hash', now())`,
      params: () => [f.tenantId, `no-hash-${process.pid}`],
    },
    {
      constraint: 'api_credentials.key_salt NOT NULL',
      expected: NOT_NULL_VIOLATION,
      sql: `insert into api_credentials (tenant_id, key_id, key_hash, key_salt, name, created_at)
            values ($1, $2, 'h', null, 'No salt', now())`,
      params: () => [f.tenantId, `no-salt-${process.pid}`],
    },
  ];

  it.each(cases)('rejects a row violating $constraint', async ({ sql, params, expected }) => {
    expect(await violationCode(sql, params())).toBe(expected);
  });

  // ---- Positive cases: the constraints must not OVER-reject -------------------------------
  // A unique constraint that rejects everything would pass every negative case above. These pin
  // the boundary of each rule so an over-broad constraint fails loudly.

  it('allows the same canonical_key in a different list_type and in a different tenant', async () => {
    await client.query('savepoint canonical_scope');
    try {
      // Same key, different list: lead_status 'won' must not collide with quote_status 'won'.
      await client.query(
        `insert into reference_items (tenant_id, list_type, name, canonical_key, created_at, updated_at)
         values ($1, 'lead_status', 'Won', 'won', now(), now())`,
        [f.tenantId],
      );
      // Same key and list, different tenant: tenants are configured independently.
      const other = await client.query<{ id: string }>(
        `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
        [`t004-other-${process.pid}`],
      );
      await client.query(
        `insert into reference_items (tenant_id, list_type, name, canonical_key, created_at, updated_at)
         values ($1, 'quote_status', 'Won', 'won', now(), now())`,
        [other.rows[0]!.id],
      );
    } finally {
      await client.query('rollback to savepoint canonical_scope');
    }
  });

  it('allows many rows with a NULL canonical_key in one list (NULLs are distinct)', async () => {
    await client.query('savepoint null_canonical');
    try {
      for (const name of ['Motor', 'Marine', 'Property']) {
        await client.query(
          `insert into reference_items (tenant_id, list_type, name, created_at, updated_at)
           values ($1, 'product_line', $2, now(), now())`,
          [f.tenantId, name],
        );
      }
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from reference_items
          where tenant_id = $1 and list_type = 'product_line' and canonical_key is null`,
        [f.tenantId],
      );
      expect(rows[0]!.count, 'all three NULL-key product lines must coexist').toBe('3');
    } finally {
      await client.query('rollback to savepoint null_canonical');
    }
  });

  it('allows both slots to be filled for one tenant, and the same slot in another tenant', async () => {
    await client.query('savepoint slot_scope');
    try {
      await client.query(
        `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
         values ($1, $2, 'underwriter', now(), now())`,
        [f.tenantId, f.otherRoleId],
      );
      const other = await client.query<{ id: string }>(
        `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
        [`t004-slot-${process.pid}`],
      );
      await client.query(
        `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
         values ($1, $2, 'rm', now(), now())`,
        [other.rows[0]!.id, f.roleId],
      );
    } finally {
      await client.query('rollback to savepoint slot_scope');
    }
  });

  // ---- api_credentials structural guarantees (Q-19) ---------------------------------------

  it('has NO column capable of holding a plaintext or retrievable key', async () => {
    const { rows } = await client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'api_credentials'`,
    );
    const columns = rows.map((r) => r.column_name);

    // Names that would indicate a retrievable secret rather than a verify-only hash.
    const forbidden = [
      'key',
      'api_key',
      'secret',
      'client_secret',
      'plaintext_key',
      'key_plaintext',
      'key_value',
      'password',
      'token',
      // Q-19 explicitly retires the Keycloak client binding.
      'keycloak_client_id',
    ];
    expect(columns.filter((c) => forbidden.includes(c))).toEqual([]);

    // And the hash columns that replace them must actually be present.
    expect(columns).toEqual(expect.arrayContaining(['key_id', 'key_hash', 'key_salt']));
  });

  it('requires both hash columns to be NOT NULL so an unverifiable credential cannot exist', async () => {
    const { rows } = await client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'api_credentials'
          and column_name in ('key_id', 'key_hash', 'key_salt')
        order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'key_hash', is_nullable: 'NO' },
      { column_name: 'key_id', is_nullable: 'NO' },
      { column_name: 'key_salt', is_nullable: 'NO' },
    ]);
  });

  it('creates no Supabase Vault objects (Q-23: none in this migration)', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name in ('vault_secrets', 'secrets', 'tenant_secrets')`,
    );
    expect(rows).toEqual([]);
  });

  // ---- Partitioning (spec §11 / AC-005) ---------------------------------------------------

  it('LIST-partitions the tenant-scoped T-004 tables on tenant_id, leaving the global template alone', async () => {
    const { rows } = await client.query<{ relname: string; partstrat: string | null; partcol: string | null }>(
      `select c.relname, p.partstrat::text as partstrat,
              (select a.attname from pg_attribute a
                where a.attrelid = c.oid and a.attnum = p.partattrs[0]) as partcol
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_partitioned_table p on p.partrelid = c.oid
        where n.nspname = 'public'
          and c.relname = any($1::text[])
        order by c.relname`,
      [[...PARTITIONED_TABLES, 'default_reference_items']],
    );

    for (const table of PARTITIONED_TABLES) {
      const row = rows.find((r) => r.relname === table);
      expect(row, `${table} must exist`).toBeDefined();
      expect(row!.partstrat, `${table} must be LIST-partitioned`).toBe('l');
      expect(row!.partcol, `${table} must be partitioned on tenant_id`).toBe('tenant_id');
    }

    // The global template is deliberately NOT partitioned: it has no tenant_id at all.
    const template = rows.find((r) => r.relname === 'default_reference_items');
    expect(template?.partstrat, 'default_reference_items must NOT be partitioned').toBeNull();
  });

  it('creates a DEFAULT partition safety net for every T-004 partitioned table', async () => {
    const { rows } = await client.query<{ parent: string }>(
      `select parent.relname as parent
         from pg_inherits i
         join pg_class parent on parent.oid = i.inhparent
         join pg_class child on child.oid = i.inhrelid
        where parent.relname = any($1::text[])
          and pg_get_expr(child.relpartbound, child.oid) = 'DEFAULT'`,
      [[...PARTITIONED_TABLES]],
    );
    expect(rows.map((r) => r.parent).sort()).toEqual([...PARTITIONED_TABLES]);
  });

  it('is picked up by the catalog-driven create_tenant_partitions, and rows land in the new partitions', async () => {
    await client.query('savepoint partition_probe');
    try {
      const tenant = await client.query<{ id: string }>(
        `insert into tenants (name, created_at, updated_at) values ($1, now(), now()) returning id`,
        [`t004-partition-probe-${process.pid}`],
      );
      const tenantId = tenant.rows[0]!.id;

      // T-003's function discovers partitioned tables from the catalog, so T-004's tables must be
      // covered without anyone editing a registry. Verify the partitions actually appear.
      await client.query('select create_tenant_partitions($1::bigint)', [tenantId]);

      for (const table of PARTITIONED_TABLES) {
        const { rows } = await client.query<{ child: string }>(
          `select child.relname as child
             from pg_inherits i
             join pg_class parent on parent.oid = i.inhparent
             join pg_class child on child.oid = i.inhrelid
            where parent.relname = $1 and child.relname = $2`,
          [table, `${table}_p${tenantId}`],
        );
        expect(rows.length, `${table} must have a partition for tenant ${tenantId}`).toBe(1);
      }

      // Behavioural proof: a row must actually LAND in the dedicated partition, not the DEFAULT
      // one. A partition that exists but does not route writes is the failure mode catalog-only
      // checks miss entirely.
      await client.query(
        `insert into tenant_settings (tenant_id, created_at, updated_at) values ($1, now(), now())`,
        [tenantId],
      );
      await client.query(
        `insert into reference_items (tenant_id, list_type, name, created_at, updated_at)
         values ($1, 'region', 'Gaborone', now(), now())`,
        [tenantId],
      );
      await client.query(
        `insert into api_credentials (tenant_id, key_id, key_hash, key_salt, name, created_at)
         values ($1, $2, 'h', 's', 'Partition probe', now())`,
        [tenantId, `probe-${process.pid}`],
      );

      const settings = await client.query(
        `select 1 from tenant_settings_p${tenantId} where tenant_id = $1`,
        [tenantId],
      );
      expect(settings.rowCount, 'tenant_settings row must land in the tenant partition').toBe(1);
      const items = await client.query(
        `select 1 from reference_items_p${tenantId} where tenant_id = $1`,
        [tenantId],
      );
      expect(items.rowCount, 'reference_items row must land in the tenant partition').toBe(1);
      const creds = await client.query(
        `select 1 from api_credentials_p${tenantId} where tenant_id = $1`,
        [tenantId],
      );
      expect(creds.rowCount, 'api_credentials row must land in the tenant partition').toBe(1);
    } finally {
      await client.query('rollback to savepoint partition_probe');
    }
  });

  // ---- tenant_settings defaults (FR-11 compatibility contract) -----------------------------

  it('applies the FR-11 column defaults so a bare INSERT matches application-created settings', async () => {
    const { rows } = await client.query<Record<string, unknown>>(
      `select currency_code, currency_symbol, max_attachment_mb, high_value_threshold,
              quote_expiry_alert_days, follow_up_overdue_grace_days, aging_amber_days, aging_red_days,
              unassigned_lead_hours, stalled_lead_days, stalled_quote_days, duplicate_check_days,
              lead_ref_format, quote_ref_format, lead_inactivity_expiry_days,
              pricing_approval_target_days, sla_assignment_days, sla_underwriting_days,
              sla_received_to_sent_days, require_pricing_approval_for_high_value,
              manual_external_ref_enabled, expire_lead_when_last_quote_expires
         from tenant_settings where tenant_id = $1`,
      [f.tenantId],
    );
    expect(rows[0]).toEqual({
      currency_code: 'BWP',
      currency_symbol: 'BWP',
      max_attachment_mb: 10,
      high_value_threshold: null,
      quote_expiry_alert_days: 7,
      follow_up_overdue_grace_days: 0,
      aging_amber_days: 8,
      aging_red_days: 15,
      unassigned_lead_hours: 24,
      stalled_lead_days: 7,
      stalled_quote_days: 7,
      duplicate_check_days: 30,
      lead_ref_format: 'L-{YYYY}-{SEQ:4}',
      quote_ref_format: 'Q-{YYYY}-{SEQ:4}',
      lead_inactivity_expiry_days: 60,
      pricing_approval_target_days: 3,
      sla_assignment_days: 1,
      sla_underwriting_days: 3,
      sla_received_to_sent_days: 5,
      require_pricing_approval_for_high_value: false,
      manual_external_ref_enabled: false,
      expire_lead_when_last_quote_expires: false,
    });
  });
});
