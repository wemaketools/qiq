/**
 * Demo seed: volumes, invariants, dashboard/alert coverage, idempotency, portability and auth
 * pairing (T-041; AC-079/AC-085/AC-086; V-100/V-109/V-110).
 *
 * The single most important property this suite pins is the one a shallow count check misses: the
 * seeded data must LIGHT UP every dashboard and fire every alert type. So it does not merely count
 * rows — it runs the real dashboard services and a real alert evaluation over the seed and asserts
 * non-degenerate output for BOTH tenants.
 *
 * ON THE RESET PATH: like baseline-seed.test.ts, this suite does NOT run `supabase db reset` — it is
 * destructive and the CI database is shared. It instead applies the demo layer (which touches only
 * the demo tenants, id >= DEMO_ID_BASE) on top of whatever baseline is present, which is exactly the
 * post-reset ordering, and asserts convergence by re-applying and diffing digests.
 *
 * RESIDUE: the demo entities are PERSISTENT demo data BY DESIGN when the seed is run for real, but a
 * TEST of the seed must not leave them in the shared CI database — that residue makes other suites
 * order-dependent (e.g. the demo job_run rows, ids >= DEMO_ID_BASE, outrank a manual cron row in
 * cron-scripts.test.ts's latest-by-id lookup). So `afterAll` deletes the ENTIRE demo footprint it
 * created — every partitioned row of the demo tenants, every global demo row (id >= DEMO_ID_BASE),
 * the demo tenant rows, and the provisioned Supabase Auth identities — targeting the seed's own
 * deterministic ids. Data deletion runs BEFORE the auth deprovision (auth identities are ON DELETE
 * RESTRICT from the app `users` rows, which the data purge removes first).
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyDemoSeed, purgeDemoLayer } from '../../../../scripts/db/demo-data/apply.js';
import { provisionDemoAuthUsers, deprovisionDemoAuthUsers } from '../../../../scripts/db/demo-data/auth-users.js';
import { verifyDemoSeed, DEMO_MINIMUMS } from '../../../../scripts/db/demo-data/verify.js';
import { LOCAL_DEMO_PASSWORD, PERSONAS, TENANTS } from '../../../../scripts/db/demo-data/catalog.js';
import { loadGrantGraph } from '../../domains/rbac/repository.js';
import { computeEffectivePermissions } from '../../domains/rbac/effective-permissions.js';
import { reconcileTenantAlerts } from '../../domains/alerts/evaluate.js';
import { ALERT_TYPES } from '../../domains/alerts/rules/types.js';
import { dashboardFilterSchema } from '../../domains/dashboards/index.js';
import { getExecutiveOverview } from '../../domains/dashboards/executive.service.js';
import { getPipelineDashboard } from '../../domains/dashboards/pipeline.service.js';
import { getBrokerPerformance } from '../../domains/dashboards/broker.service.js';
import { getRmPerformance } from '../../domains/dashboards/rm.service.js';
import { getLossAnalysis } from '../../domains/dashboards/loss.service.js';
import { poolerPoolConfig, toTenantId, type Database, type DbClient, type TenantId } from '../../lib/db/index.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('demo-seed', probe);

const DEMO_TENANT_NAMES = ['Kalahari Insurance (Pilot)', 'Okavango Risk Partners'];
/** Deterministic demo tenant ids from the catalog — used for cleanup even if the seed half-failed. */
const DEMO_TENANT_IDS: readonly number[] = TENANTS.map((t) => t.id);

let stack: LocalStack;
let pool: pg.Pool;
let db: DbClient;
let now: Date;
let tenantIds: number[] = [];

async function client(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: stack.dbUrl });
  await c.connect();
  return c;
}

/** Content digest over the stable (non-timestamp) columns of the demo tenants' core tables. */
async function digest(c: pg.Client): Promise<Record<string, string>> {
  const demo = `tenant_id in (select id from tenants where name = any($1))`;
  const rows: Record<string, string> = {};
  const one = async (label: string, sql: string): Promise<void> => {
    const r = await c.query<{ d: string | null }>(sql, [DEMO_TENANT_NAMES]);
    rows[label] = r.rows[0]?.d ?? '<empty>';
  };
  await one(
    'leads',
    `select md5(string_agg(concat_ws('|', id, lead_ref, party_id, status_id, estimated_premium, sum_insured, date_received), E'\n' order by id)) as d from leads where ${demo}`,
  );
  await one(
    'quotes',
    `select md5(string_agg(concat_ws('|', id, lead_id, status_id, is_current, coalesce(valid_until::text, '~'), coalesce(sent_date::text, '~'), coalesce(bound_premium::text, '~')), E'\n' order by id)) as d from quotes where ${demo}`,
  );
  await one(
    'quote_versions',
    `select md5(string_agg(concat_ws('|', id, quote_id, version_no, quoted_premium, is_current), E'\n' order by id)) as d from quote_versions where ${demo}`,
  );
  await one(
    'parties',
    `select md5(string_agg(concat_ws('|', id, name, party_type_id, is_strategic), E'\n' order by id)) as d from parties where ${demo}`,
  );
  return rows;
}

async function seedOnce(): Promise<void> {
  const auth = await provisionDemoAuthUsers({
    supabaseUrl: stack.apiUrl,
    serviceRoleKey: stack.serviceRoleKey,
      password: LOCAL_DEMO_PASSWORD,
  });
  const c = await client();
  try {
    const { plan } = await applyDemoSeed(c, auth.byPersona, now, LOCAL_DEMO_PASSWORD);
    tenantIds = plan.tenants.map((t) => t.id);
  } finally {
    await c.end();
  }
  for (const tenantId of tenantIds) {
    await reconcileTenantAlerts(db, toTenantId(tenantId), { now });
  }
}

async function demoUserFor(c: pg.Client, tenantId: number): Promise<number> {
  const r = await c.query<{ user_id: string }>(
    'select user_id from user_tenants where tenant_id = $1 order by id limit 1',
    [tenantId],
  );
  return Number(r.rows[0]?.user_id ?? 0);
}

beforeAll(async () => {
  if (!probe.available) return;
  stack = probe.stack;
  pool = new pg.Pool({ connectionString: stack.dbUrl, max: 2 });
  db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  now = new Date();
  await seedOnce();
}, 300_000);

afterAll(async () => {
  if (!probe.available) return;

  // Leave ZERO residue. Data deletion FIRST (it runs on its own pg.Client and removes the app
  // `users` rows that the auth identities are ON DELETE RESTRICT from), THEN deprovision auth,
  // THEN destroy the Kysely pool. Targets the seed's own deterministic ids via the catalog.
  const c = await client();
  try {
    await purgeDemoLayer(c, DEMO_TENANT_IDS);
    for (const tenantId of DEMO_TENANT_IDS) {
      // Defensive: the seed does not write audit_log, but alert reconciliation over the demo
      // tenants could, and a partitioned residue row would still be demo residue.
      await c.query('delete from audit_log where tenant_id = $1', [tenantId]).catch(() => undefined);
    }
    await c.query(`delete from tenants where id = any($1::bigint[])`, [DEMO_TENANT_IDS]);
  } finally {
    await c.end();
  }

  await deprovisionDemoAuthUsers({
    supabaseUrl: stack.apiUrl,
    serviceRoleKey: stack.serviceRoleKey,
  }).catch(() => undefined);

  // Kysely's PostgresDialect owns and ends `pool` on destroy; a second pool.end() throws.
  await db?.destroy();
}, 300_000);

describeStack(title, () => {
  it('reaches at least the documented AC-085 volumes and passes post-seed verification', async () => {
    const c = await client();
    try {
      const report = await verifyDemoSeed(c);
      expect(report.failures, report.failures.join('; ')).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.volumes.tenants).toBeGreaterThanOrEqual(DEMO_MINIMUMS.tenants);
      expect(report.volumes.users).toBeGreaterThanOrEqual(DEMO_MINIMUMS.users);
      expect(report.volumes.brokers).toBeGreaterThanOrEqual(DEMO_MINIMUMS.brokers);
      expect(report.volumes.parties).toBeGreaterThanOrEqual(DEMO_MINIMUMS.parties);
      expect(report.volumes.leads).toBeGreaterThanOrEqual(DEMO_MINIMUMS.leads);
      expect(report.volumes.quotes).toBeGreaterThanOrEqual(DEMO_MINIMUMS.quotes);
      expect(report.volumes.followUps).toBeGreaterThanOrEqual(DEMO_MINIMUMS.followUps);
      expect(report.volumes.pricingApprovals).toBeGreaterThanOrEqual(DEMO_MINIMUMS.pricingApprovals);
    } finally {
      await c.end();
    }
  });

  it('fires every one of the eleven alert types on the seed', async () => {
    const c = await client();
    try {
      const r = await c.query<{ type: string }>(
        `select distinct a.type from alerts a where a.resolved_at is null and a.tenant_id in
           (select id from tenants where name = any($1))`,
        [DEMO_TENANT_NAMES],
      );
      const present = new Set(r.rows.map((row) => row.type));
      const missing = ALERT_TYPES.filter((t) => !present.has(t));
      expect(missing, `alert types not firing: ${missing.join(', ')}`).toEqual([]);
    } finally {
      await c.end();
    }
  });

  it('renders non-degenerate data on every dashboard for BOTH tenants', async () => {
    const c = await client();
    try {
      const wide = dashboardFilterSchema.parse({
        from: new Date(now.getTime() - 200 * 86_400_000).toISOString().slice(0, 10),
        to: now.toISOString().slice(0, 10),
      });
      const tenants = await c.query<{ id: string }>(
        'select id from tenants where name = any($1) order by id',
        [DEMO_TENANT_NAMES],
      );
      expect(tenants.rows.length).toBe(2);

      for (const { id } of tenants.rows) {
        const tenantId = toTenantId(Number(id)) as TenantId;
        const userId = await demoUserFor(c, Number(id));
        const actor = { userId, tenantId, canViewAllLeads: true };

        const exec = await getExecutiveOverview({ db }, actor, wide, now);
        const openPipeline = exec.kpis.find((k) => k.key === 'open_pipeline_premium')?.value ?? 0;
        expect(Number(openPipeline)).toBeGreaterThan(0);
        expect(exec.pipelineByStage.length).toBeGreaterThan(0);
        expect(exec.requiresAttention.reduce((s, r) => s + r.count, 0)).toBeGreaterThan(0);
        // High-value panel is populated (threshold configured), which many seeds forget.
        expect(exec.highValueOpportunities.length).toBeGreaterThan(0);

        const pipeline = await getPipelineDashboard({ db }, actor, wide, now);
        expect(pipeline.stageConversionFunnel.length).toBeGreaterThan(0);
        expect(pipeline.atRiskPipeline.length).toBeGreaterThan(0);

        const broker = await getBrokerPerformance({ db }, actor, wide, now);
        expect(broker.table.length).toBeGreaterThan(0);

        const rm = await getRmPerformance({ db }, actor, wide, now);
        expect(rm.topRms.length).toBeGreaterThan(0);

        const loss = await getLossAnalysis({ db }, actor, wide, now);
        expect(loss.kpis.length).toBeGreaterThan(0);
      }
    } finally {
      await c.end();
    }
  });

  it('converges on re-run: a second seed leaves core-table content digests identical (AC-086)', async () => {
    const before = await (async () => {
      const c = await client();
      try {
        return await digest(c);
      } finally {
        await c.end();
      }
    })();

    await seedOnce();

    const after = await (async () => {
      const c = await client();
      try {
        return await digest(c);
      } finally {
        await c.end();
      }
    })();

    expect(after).toEqual(before);
    // The digests must actually be digesting something (guard against an all-empty false pass).
    expect(before.leads).not.toBe('<empty>');
    expect(before.quotes).not.toBe('<empty>');
  }, 300_000);

  it('grants the tenant admin a tenant-scoped ceiling that EXCLUDES Internal/global codes, while the Internal admin keeps them', async () => {
    // The AC-083 boundary (F-041-4): the Tenant Manager nav gates on `tenants.view` and its endpoint
    // resolves that permission GLOBALLY, so a tenant admin must not hold `tenants.*`/`global.*` in
    // any scope. Proven against the real grant graph + effective-permission resolver, not the plan.
    const userIdByEmail = async (c: pg.Client, email: string): Promise<number> => {
      const r = await c.query<{ id: string }>('select id from users where email = $1', [email]);
      const id = r.rows[0]?.id;
      if (id === undefined) throw new Error(`demo user not found: ${email}`);
      return Number(id);
    };

    const c = await client();
    let pilotAdminId: number;
    let internalAdminId: number;
    try {
      pilotAdminId = await userIdByEmail(c, 'pilot.admin@quoteiq.local');
      internalAdminId = await userIdByEmail(c, 'internal.admin@quoteiq.local');
    } finally {
      await c.end();
    }

    const tenant1 = toTenantId(TENANTS[0]!.id);
    const INTERNAL_CODES = ['tenants.view', 'tenants.create', 'global.view_any_tenant', 'global.manage_global_defaults'];

    // Resolve grants through a pool with the app's int8->number parser so scope equality
    // (computeEffectivePermissions compares tenant_id === scope) matches production, not the raw
    // string a default pg pool returns for bigint.
    const permPool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    const permDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: permPool }) });
    try {
      const pilotGraph = await loadGrantGraph(permDb, pilotAdminId);
      const pilotTenant = computeEffectivePermissions(pilotGraph, { tenantId: tenant1 });
      const pilotGlobal = computeEffectivePermissions(pilotGraph, { tenantId: null });
      // Tenant admin holds a real tenant capability (proves the grant path resolves at all)...
      expect(pilotTenant.has('users.view')).toBe(true);
      expect(pilotTenant.has('reference_data.manage')).toBe(true);
      // ...but NONE of the Internal/global codes, in either scope. An over-granted persona (the bug)
      // WOULD hold these, so this assertion discriminates the fix from the defect.
      for (const code of INTERNAL_CODES) {
        expect(pilotTenant.has(code), `pilot.admin must not hold ${code} (tenant scope)`).toBe(false);
        expect(pilotGlobal.has(code), `pilot.admin must not hold ${code} (global scope)`).toBe(false);
      }

      // The Internal admin DOES hold the Internal/global codes globally (via the global INTERNAL role).
      const internalGraph = await loadGrantGraph(permDb, internalAdminId);
      const internalGlobal = computeEffectivePermissions(internalGraph, { tenantId: null });
      for (const code of INTERNAL_CODES) {
        expect(internalGlobal.has(code), `internal.admin must hold ${code} (global scope)`).toBe(true);
      }
    } finally {
      await permDb.destroy();
    }
  });

  it('provisions demo personas that can authenticate against local Supabase Auth (Q-21a)', async () => {
    const anon = createClient(stack.apiUrl, stack.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const active = PERSONAS.find((p) => (p.isActive ?? true) && p.key === 'internal_admin');
    if (active === undefined) throw new Error('expected an active persona');

    const ok = await anon.auth.signInWithPassword({ email: active.email, password: LOCAL_DEMO_PASSWORD });
    expect(ok.error, ok.error?.message).toBeNull();
    expect(ok.data.session?.access_token).toBeTruthy();

    // The deactivated persona is banned and must NOT be able to sign in (deactivate-not-delete).
    const disabled = PERSONAS.find((p) => (p.isActive ?? true) === false);
    if (disabled !== undefined) {
      const denied = await anon.auth.signInWithPassword({ email: disabled.email, password: LOCAL_DEMO_PASSWORD });
      expect(denied.data.session).toBeNull();
      expect(denied.error).not.toBeNull();
    }
  });
});
