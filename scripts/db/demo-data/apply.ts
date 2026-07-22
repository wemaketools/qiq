/**
 * Applies the demo PLAN to a database (T-041, AC-085/AC-086).
 *
 * IDEMPOTENCY BY DELETE-THEN-REINSERT WITH EXPLICIT IDS
 * ====================================================
 * The whole demo layer keys on `DEMO_ID_BASE`: every demo global row has an id above it, and every
 * demo partitioned row lives in a demo tenant's partition. So a re-run first removes exactly the
 * demo layer (never touching organically-created rows) and then reinserts it with the SAME explicit
 * ids via `OVERRIDING SYSTEM VALUE`. The result is byte-identical between runs — the strongest form
 * of "re-running converges" (AC-085) and "identical logical state" (AC-086).
 *
 * The tenant ROWS themselves are UPSERTED rather than deleted, because dropping a tenant would mean
 * dropping and recreating its ~22 partitions; `create_tenant_partitions` is idempotent (CREATE ...
 * IF NOT EXISTS), so it is safe to call every run and the partitions simply persist.
 *
 * Everything runs in ONE transaction: a seed that fails halfway leaves the database exactly as it
 * found it.
 */
import type pg from 'pg';

import { DEMO_ID_BASE } from './catalog.js';
import { buildDemoPlan, type DemoPlan } from './plan.js';

const NOW_COLS = { created: 'created_at', updated: 'updated_at' } as const;

/** Chosen so a chunk stays well under node-postgres' 65535 bound parameters per statement. */
const MAX_PARAMS_PER_STATEMENT = 40_000;

async function loadPermissionCodes(client: pg.PoolClient | pg.Client): Promise<string[]> {
  const result = await client.query<{ code: string }>('select code from permissions order by code');
  return result.rows.map((r) => r.code);
}

interface ColumnSpec {
  readonly name: string;
  /** Extracts the value from a row; `now` supplied for audit-timestamp columns. */
  readonly value: (row: Record<string, unknown>, now: string) => unknown;
}

function col(name: string): ColumnSpec {
  return { name, value: (row) => row[name] ?? null };
}
function nowCol(name: string): ColumnSpec {
  return { name, value: (_row, now) => now };
}

async function bulkInsert(
  client: pg.PoolClient | pg.Client,
  table: string,
  columns: readonly ColumnSpec[],
  rows: readonly Record<string, unknown>[],
  now: string,
  onConflict?: string,
): Promise<void> {
  if (rows.length === 0) return;

  const columnNames = columns.map((c) => c.name).join(', ');
  const perRow = columns.length;
  const rowsPerChunk = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / perRow));

  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const row of chunk) {
      const placeholders: string[] = [];
      for (const column of columns) {
        params.push(column.value(row, now));
        placeholders.push(`$${String(params.length)}`);
      }
      tuples.push(`(${placeholders.join(', ')})`);
    }
    const conflict = onConflict === undefined ? '' : ` ${onConflict}`;
    await client.query(
      `insert into ${table} (${columnNames}) overriding system value values ${tuples.join(', ')}${conflict}`,
      params,
    );
  }
}

function asRows<T>(rows: readonly T[]): readonly Record<string, unknown>[] {
  return rows as readonly Record<string, unknown>[];
}

/**
 * Removes exactly the demo layer for the given tenants: every partitioned demo row (by tenant_id)
 * and every global demo row (id >= DEMO_ID_BASE), children before parents. It deliberately does NOT
 * drop the `tenants` rows (they are upserted, and dropping one would drop its partitions), so a
 * caller that wants a fully empty demo footprint (e.g. a test's afterAll) must delete the tenant
 * rows itself after calling this. Exported so the demo-seed integration test can leave zero residue.
 */
export async function purgeDemoLayer(client: pg.PoolClient | pg.Client, tenantIds: readonly number[]): Promise<void> {
  if (tenantIds.length === 0) return;

  const tenantList = tenantIds.join(', ');

  // Partitioned business + tenancy data (delete children before parents where FKs exist).
  const partitioned = [
    'alerts',
    'user_alert_views',
    'quote_status_history',
    'quote_assignments',
    'quote_versions',
    'quotes',
    'lead_status_history',
    'lead_notes',
    'follow_ups',
    'pricing_approvals',
    'lead_assignments',
    'leads',
    'broker_contacts',
    'brokers',
    'parties',
    'business_assignments',
    'reference_sequences',
    'reference_items',
    'tenant_settings',
    'user_tenants',
  ];
  for (const table of partitioned) {
    await client.query(`delete from ${table} where tenant_id in (${tenantList})`);
  }

  // Global demo rows, children first. Junction rows are matched by the DEMO ENTITIES they
  // reference, not only by their own id: rows written through the app at runtime (a user created
  // in the User Manager and handed a demo role, a demo user added to a group, …) carry ordinary
  // sequence ids below DEMO_ID_BASE, and matching on id alone leaves them behind to fail the
  // demo roles/groups/users deletes below with a foreign-key violation (observed 2026-07-22).
  const globalChildrenFirst: ReadonlyArray<readonly [table: string, predicate: string]> = [
    ['group_permissions', `id >= ${DEMO_ID_BASE} or group_id >= ${DEMO_ID_BASE}`],
    ['group_roles', `id >= ${DEMO_ID_BASE} or group_id >= ${DEMO_ID_BASE} or role_id >= ${DEMO_ID_BASE}`],
    ['group_members', `id >= ${DEMO_ID_BASE} or group_id >= ${DEMO_ID_BASE} or user_id >= ${DEMO_ID_BASE}`],
    ['user_permissions', `id >= ${DEMO_ID_BASE} or user_id >= ${DEMO_ID_BASE}`],
    ['user_roles', `id >= ${DEMO_ID_BASE} or role_id >= ${DEMO_ID_BASE} or user_id >= ${DEMO_ID_BASE}`],
    ['role_permissions', `id >= ${DEMO_ID_BASE} or role_id >= ${DEMO_ID_BASE}`],
    ['user_groups', `id >= ${DEMO_ID_BASE}`],
    ['roles', `id >= ${DEMO_ID_BASE}`],
    ['job_run', `id >= ${DEMO_ID_BASE}`],
    ['users', `id >= ${DEMO_ID_BASE}`],
  ];
  for (const [table, predicate] of globalChildrenFirst) {
    await client.query(`delete from ${table} where ${predicate}`);
  }
}

export interface ApplyResult {
  readonly plan: DemoPlan;
}

/**
 * Builds the plan and writes it. `authByPersona` maps a persona key to its provisioned
 * `auth.users.id` (uuid); it must contain every persona or the users insert fails loudly.
 */
export async function applyDemoSeed(
  client: pg.PoolClient | pg.Client,
  authByPersona: ReadonlyMap<string, string>,
  now: Date,
): Promise<ApplyResult> {
  const nowIso = now.toISOString();
  const codes = await loadPermissionCodes(client);
  const plan = buildDemoPlan({ now, allPermissionCodes: codes });
  const tenantIds = plan.tenants.map((t) => t.id);

  await client.query('begin');
  try {
    // 1. Tenants (upsert) + partitions.
    await bulkInsert(
      client,
      'tenants',
      [col('id'), col('name'), { name: 'status', value: () => 'active' }, nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.tenants),
      nowIso,
      'on conflict (id) do update set name = excluded.name, status = excluded.status, updated_at = excluded.updated_at',
    );
    for (const tenant of plan.tenants) {
      await client.query('select create_tenant_partitions($1)', [tenant.id]);
    }

    // 2. Remove the previous demo layer (now that partitions are guaranteed to exist).
    await purgeDemoLayer(client, tenantIds);

    // 3. Roles + permissions.
    await bulkInsert(
      client,
      'roles',
      [col('id'), col('tenant_id'), col('name'), { name: 'is_active', value: () => true }, nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.roles),
      nowIso,
    );
    await bulkInsert(
      client,
      'role_permissions',
      [col('id'), col('role_id'), col('permission_code'), nowCol(NOW_COLS.created)],
      asRows(plan.rolePermissions),
      nowIso,
    );

    // 4. Groups.
    await bulkInsert(
      client,
      'user_groups',
      [col('id'), col('tenant_id'), col('name'), { name: 'is_active', value: () => true }, nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.groups),
      nowIso,
    );
    await bulkInsert(
      client,
      'group_roles',
      [col('id'), col('group_id'), col('role_id'), nowCol(NOW_COLS.created)],
      asRows(plan.groupRoles),
      nowIso,
    );
    await bulkInsert(
      client,
      'group_permissions',
      [col('id'), col('group_id'), col('permission_code'), nowCol(NOW_COLS.created)],
      asRows(plan.groupPermissions),
      nowIso,
    );

    // 5. Users (with the provisioned auth identity).
    const userRows = plan.users.map((user) => {
      const authUserId = authByPersona.get(user.personaKey);
      if (authUserId === undefined) {
        throw new Error(`No auth identity provisioned for persona "${user.personaKey}"`);
      }
      return {
        id: user.id,
        auth_user_id: authUserId,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        is_active: user.is_active,
        last_tenant_id: user.last_tenant_id,
        theme_preference: 'system',
      };
    });
    await bulkInsert(
      client,
      'users',
      [
        col('id'),
        col('auth_user_id'),
        col('first_name'),
        col('last_name'),
        col('email'),
        col('is_active'),
        col('last_tenant_id'),
        col('theme_preference'),
        nowCol(NOW_COLS.created),
        nowCol(NOW_COLS.updated),
      ],
      asRows(userRows),
      nowIso,
    );

    // 6. Memberships / grant paths.
    await bulkInsert(
      client,
      'user_tenants',
      [col('id'), col('tenant_id'), col('user_id'), nowCol(NOW_COLS.created)],
      asRows(plan.userTenants),
      nowIso,
    );
    await bulkInsert(
      client,
      'user_roles',
      [col('id'), col('user_id'), col('role_id'), col('tenant_id'), nowCol(NOW_COLS.created)],
      asRows(plan.userRoles),
      nowIso,
    );
    await bulkInsert(
      client,
      'user_permissions',
      [col('id'), col('user_id'), col('permission_code'), col('tenant_id'), nowCol(NOW_COLS.created)],
      asRows(plan.userPermissions),
      nowIso,
    );
    await bulkInsert(
      client,
      'group_members',
      [col('id'), col('group_id'), col('user_id'), nowCol(NOW_COLS.created)],
      asRows(plan.groupMembers),
      nowIso,
    );

    // 7. Tenant settings (upsert on the one-row-per-tenant constraint).
    await bulkInsert(
      client,
      'tenant_settings',
      [
        col('id'),
        col('tenant_id'),
        col('currency_code'),
        col('currency_symbol'),
        col('high_value_threshold'),
        nowCol(NOW_COLS.created),
        nowCol(NOW_COLS.updated),
      ],
      asRows(plan.tenantSettings),
      nowIso,
      'on conflict (tenant_id) do update set currency_code = excluded.currency_code, ' +
        'currency_symbol = excluded.currency_symbol, high_value_threshold = excluded.high_value_threshold, ' +
        'updated_at = excluded.updated_at',
    );

    // 8. Reference items.
    await bulkInsert(
      client,
      'reference_items',
      [
        col('id'),
        col('tenant_id'),
        col('list_type'),
        col('name'),
        col('display_order'),
        { name: 'is_active', value: () => true },
        col('is_broker_channel'),
        col('product_line_id'),
        col('reporting_category'),
        col('canonical_key'),
        col('is_terminal'),
        nowCol(NOW_COLS.created),
        nowCol(NOW_COLS.updated),
      ],
      asRows(plan.referenceItems),
      nowIso,
    );

    // 9. Business assignment slots.
    await bulkInsert(
      client,
      'business_assignments',
      [col('id'), col('tenant_id'), col('role_id'), col('slot'), nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.businessAssignments),
      nowIso,
    );

    // 10. Reference sequences.
    await bulkInsert(
      client,
      'reference_sequences',
      [col('id'), col('tenant_id'), col('entity_type'), col('year'), col('next_value')],
      asRows(plan.referenceSequences),
      nowIso,
    );

    // 11. Parties, brokers, contacts.
    await bulkInsert(
      client,
      'parties',
      [
        col('id'),
        col('tenant_id'),
        col('name'),
        col('party_type_id'),
        col('segment_id'),
        col('industry_id'),
        col('region_id'),
        col('is_strategic'),
        col('contact_name'),
        col('contact_email'),
        col('contact_phone'),
        col('last_activity_at'),
        nowCol(NOW_COLS.created),
        nowCol(NOW_COLS.updated),
      ],
      asRows(plan.parties),
      nowIso,
    );
    await bulkInsert(
      client,
      'brokers',
      [col('id'), col('tenant_id'), col('name'), col('broker_type_id'), col('branch'), col('status'), nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.brokers),
      nowIso,
    );
    await bulkInsert(
      client,
      'broker_contacts',
      [col('id'), col('tenant_id'), col('broker_id'), col('name'), col('email'), col('phone'), col('is_primary'), nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.brokerContacts),
      nowIso,
    );

    // 12. Leads and their satellites.
    await bulkInsert(
      client,
      'leads',
      [
        col('id'),
        col('tenant_id'),
        col('party_id'),
        col('lead_ref'),
        col('external_ref'),
        col('date_received'),
        col('request_channel_id'),
        col('broker_id'),
        col('region_id'),
        col('product_line_id'),
        col('cover_type_id'),
        col('sum_insured'),
        col('estimated_premium'),
        col('policy_term'),
        col('priority'),
        col('is_existing_client'),
        col('status_id'),
        col('pricing_approval_state'),
        col('date_assigned'),
        col('decision_date'),
        col('lost_reason_id'),
        col('loss_comments'),
        col('last_activity_at'),
        col('next_follow_up_date'),
        col('follow_up_count'),
        col('source'),
        col('created_at'),
        nowCol(NOW_COLS.updated),
      ],
      asRows(plan.leads),
      nowIso,
    );
    await bulkInsert(
      client,
      'lead_assignments',
      [col('id'), col('tenant_id'), col('lead_id'), col('business_assignment_id'), col('user_id'), nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.leadAssignments),
      nowIso,
    );
    await bulkInsert(
      client,
      'lead_notes',
      [col('id'), col('tenant_id'), col('lead_id'), col('body'), col('created_at'), col('created_by')],
      asRows(plan.leadNotes),
      nowIso,
    );
    await bulkInsert(
      client,
      'lead_status_history',
      [col('id'), col('tenant_id'), col('lead_id'), col('operation'), col('previous_status_id'), col('new_status_id'), col('acted_by'), col('acted_at')],
      asRows(plan.leadHistory),
      nowIso,
    );
    await bulkInsert(
      client,
      'follow_ups',
      [col('id'), col('tenant_id'), col('lead_id'), col('follow_up_date'), col('outcome_note'), col('next_follow_up_date'), col('logged_by'), col('logged_at')],
      asRows(plan.followUps),
      nowIso,
    );
    await bulkInsert(
      client,
      'pricing_approvals',
      [
        col('id'),
        col('tenant_id'),
        col('lead_id'),
        col('requested_by'),
        col('requested_at'),
        col('approver_id'),
        col('proposed_premium'),
        col('state'),
        col('decided_by'),
        col('decided_at'),
      ],
      asRows(plan.pricingApprovals),
      nowIso,
    );

    // 13. Quotes and their satellites.
    await bulkInsert(
      client,
      'quotes',
      [
        col('id'),
        col('tenant_id'),
        col('lead_id'),
        col('quote_ref'),
        col('status_id'),
        col('is_current'),
        col('product_line_id'),
        col('cover_type_id'),
        col('prepared_date'),
        col('sent_date'),
        col('valid_until'),
        col('decision_date'),
        col('bound_premium'),
        col('created_at'),
        nowCol(NOW_COLS.updated),
      ],
      asRows(plan.quotes),
      nowIso,
    );
    await bulkInsert(
      client,
      'quote_versions',
      [col('id'), col('tenant_id'), col('quote_id'), col('version_no'), col('quoted_premium'), col('is_current'), col('created_at')],
      asRows(plan.quoteVersions),
      nowIso,
    );
    await bulkInsert(
      client,
      'quote_assignments',
      [col('id'), col('tenant_id'), col('quote_id'), col('business_assignment_id'), col('user_id'), nowCol(NOW_COLS.created), nowCol(NOW_COLS.updated)],
      asRows(plan.quoteAssignments),
      nowIso,
    );
    await bulkInsert(
      client,
      'quote_status_history',
      [col('id'), col('tenant_id'), col('quote_id'), col('operation'), col('previous_status_id'), col('new_status_id'), col('acted_by'), col('acted_at')],
      asRows(plan.quoteHistory),
      nowIso,
    );

    // 14. Sample job runs.
    await bulkInsert(
      client,
      'job_run',
      [
        col('id'),
        col('job_name'),
        col('trigger'),
        col('environment'),
        col('correlation_id'),
        col('status'),
        col('started_at'),
        col('finished_at'),
        col('duration_ms'),
        { name: 'counts', value: (row) => row['counts'] },
      ],
      asRows(plan.jobRuns),
      nowIso,
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }

  return { plan };
}
