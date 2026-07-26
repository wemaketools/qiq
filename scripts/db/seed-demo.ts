#!/usr/bin/env tsx
/**
 * Demo seed runner (T-041, M-11 layer 2, Q-8, Q-21a, A-1; AC-079/AC-085/AC-086).
 *
 * Layers the full demo dataset ON TOP of a baseline-seeded database: two tenants, personas with real
 * local Supabase Auth identities (known password, for e2e), brokers, parties, leads, quotes,
 * follow-ups, pricing approvals, alert-triggering fixtures, plausible history and sample job runs.
 * It then RUNS an alert evaluation over the seed (so the Alerts Center is populated immediately) and
 * VERIFIES counts and invariants before reporting success.
 *
 * Usage:
 *   npm run db:seed:demo                    seed the configured (local) database
 *   npm run db:seed:demo -- --env=dev       required to seed anything that is not local
 *
 * SAFETY (A-1, M-11: "never run automatically in production"). Identical gate to the baseline seed:
 * the target comes from the loaded configuration, and a non-local target additionally requires the
 * operator to NAME it with `--env=`. See scripts/db/seed-target.ts.
 *
 * CONNECTION: SUPABASE_DIRECT_DATABASE_URL, never the pooler (A-8). Auth provisioning uses the service-role
 * key via the server config module (A-4), never a browser-exposed key.
 */
import pg from 'pg';

import { getConfig, ConfigurationError, type AppConfig } from '../../src/server/lib/config/index.js';
import { createDirectDb } from '../../src/server/lib/db/client.js';
import { toTenantId } from '../../src/server/lib/db/tenant.js';
import { reconcileTenantAlerts } from '../../src/server/domains/alerts/evaluate.js';
import { applyDemoSeed } from './demo-data/apply.js';
import { provisionDemoAuthUsers } from './demo-data/auth-users.js';
import { verifyDemoSeed } from './demo-data/verify.js';
import { decideSeedTarget } from './seed-target.js';

/**
 * `--env=staging` -> "staging"; `--env staging` -> "staging"; absent -> null. Copied from seed.ts
 * rather than imported, because seed.ts runs its baseline `main()` at module load and importing it
 * would seed the database as a side effect of parsing a flag.
 */
function parseEnvFlag(argv: readonly string[]): string | null {
  const inline = argv.find((arg) => arg.startsWith('--env='));
  if (inline !== undefined) return inline.slice('--env='.length);
  const index = argv.indexOf('--env');
  if (index === -1) return null;
  return argv[index + 1] ?? '';
}

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}
function fail(message: string): never {
  process.stderr.write(`\nDEMO SEED FAILED\n${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown = argv.filter(
    (arg, index) =>
      arg !== '--demo' &&
      !arg.startsWith('--env=') &&
      arg !== '--env' &&
      argv[index - 1] !== '--env',
  );
  if (unknown.length > 0) {
    fail(`Unknown argument(s): ${unknown.join(', ')}\nUsage: npm run db:seed:demo -- [--env=<environment>]`);
  }

  let config: AppConfig;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      fail(`${error.message}\n\nThe demo seed needs SUPABASE_DIRECT_DATABASE_URL, SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`);
    }
    throw error;
  }

  const decision = decideSeedTarget(config.appEnv, parseEnvFlag(argv));
  if (!decision.allowed) {
    process.stderr.write(`\n${decision.reason}\n`);
    process.exit(1);
  }

  const now = new Date();
  log('Demo seed (M-11 layer 2): full demo dataset + auth personas + alert fixtures');
  log(`  target environment: ${decision.appEnv}`);
  log('  connection: SUPABASE_DIRECT_DATABASE_URL (direct, not the pooler)');

  // 1. Auth identities first — users.auth_user_id is NOT NULL and references auth.users.
  log('  provisioning Supabase Auth identities (Admin API, create-if-absent)...');
  const auth = await provisionDemoAuthUsers({
    supabaseUrl: config.supabase.url,
    serviceRoleKey: config.supabase.serviceRoleKey,
  });
  log(`  auth identities: ${String(auth.created)} created, ${String(auth.reused)} reused`);

  // 2. Apply the plan in one transaction.
  const client = new pg.Client({ connectionString: config.database.directUrl });
  await client.connect();
  let tenantIds: number[] = [];
  try {
    const { plan } = await applyDemoSeed(client, auth.byPersona, now);
    tenantIds = plan.tenants.map((t) => t.id);
    log(
      `  inserted: ${String(plan.tenants.length)} tenants, ${String(plan.users.length)} users, ` +
        `${String(plan.brokers.length)} brokers, ${String(plan.parties.length)} parties, ` +
        `${String(plan.leads.length)} leads, ${String(plan.quotes.length)} quotes, ` +
        `${String(plan.followUps.length)} follow-ups, ${String(plan.pricingApprovals.length)} pricing approvals`,
    );
  } finally {
    await client.end();
  }

  // 3. Run an alert evaluation so the demo lights up the Alerts Center immediately.
  const handle = createDirectDb(config);
  try {
    for (const tenantId of tenantIds) {
      const result = await reconcileTenantAlerts(handle.db, toTenantId(tenantId), { now });
      log(`  alerts (tenant ${String(tenantId)}): created ${String(result.created)}, matched ${String(result.matched)}`);
    }
  } finally {
    await handle.close();
  }

  // 4. Verify counts + invariants — the seed refuses to claim success otherwise.
  const verifyClient = new pg.Client({ connectionString: config.database.directUrl });
  await verifyClient.connect();
  try {
    const report = await verifyDemoSeed(verifyClient);
    log(
      `  volumes: ${report.volumes.tenants} tenants, ${report.volumes.users} users, ` +
        `${report.volumes.brokers} brokers, ${report.volumes.parties} parties, ${report.volumes.leads} leads, ` +
        `${report.volumes.quotes} quotes, ${report.volumes.followUps} follow-ups, ` +
        `${report.volumes.pricingApprovals} pricing approvals`,
    );
    log(`  alert types firing: ${report.alertTypesPresent.length}/11 (${report.alertTypesPresent.join(', ')})`);
    if (!report.ok) {
      fail(`Post-seed verification failed:\n  - ${report.failures.join('\n  - ')}`);
    }
  } finally {
    await verifyClient.end();
  }

  log('OK: demo seed applied and verified (re-runnable; re-running converges).');
}

await main();
