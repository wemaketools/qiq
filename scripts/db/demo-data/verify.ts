/**
 * Post-seed verification (T-041, AC-086 "the script itself asserts counts AND key invariants").
 *
 * This is part of the DELIVERABLE, not just a test: the seed refuses to report success unless the
 * documented volumes are met AND the structural invariants hold — every quote has a lead, exactly
 * one current version per quote, status/category consistency, and (after an evaluation run) every
 * alert type is represented. A seed that inserted the right COUNT of broken rows would still fail
 * here.
 */
import type pg from 'pg';

import { ALERT_TYPES } from '../../../src/server/domains/alerts/rules/types.js';

export interface DemoVolumes {
  readonly tenants: number;
  readonly users: number;
  readonly brokers: number;
  readonly parties: number;
  readonly leads: number;
  readonly quotes: number;
  readonly followUps: number;
  readonly pricingApprovals: number;
}

export const DEMO_MINIMUMS: DemoVolumes = {
  tenants: 2,
  users: 15,
  brokers: 18,
  parties: 200,
  leads: 300,
  quotes: 500,
  followUps: 400,
  pricingApprovals: 40,
};

export interface VerificationReport {
  readonly volumes: DemoVolumes;
  readonly alertTypesPresent: readonly string[];
  readonly ok: boolean;
  readonly failures: readonly string[];
}

async function scalar(client: pg.PoolClient | pg.Client, sql: string): Promise<number> {
  const result = await client.query<{ n: string }>(sql);
  return Number(result.rows[0]?.n ?? 0);
}

/** Reads the demo volumes (scoped to the demo tenants by name so it never counts test residue). */
async function readVolumes(client: pg.PoolClient | pg.Client): Promise<DemoVolumes> {
  const demoTenantFilter =
    "tenant_id in (select id from tenants where name in ('Kalahari Insurance (Pilot)', 'Okavango Risk Partners'))";
  return {
    tenants: await scalar(
      client,
      "select count(*) as n from tenants where name in ('Kalahari Insurance (Pilot)', 'Okavango Risk Partners')",
    ),
    users: await scalar(client, "select count(*) as n from users where email like '%@quoteiq.local'"),
    brokers: await scalar(client, `select count(*) as n from brokers where ${demoTenantFilter}`),
    parties: await scalar(client, `select count(*) as n from parties where ${demoTenantFilter}`),
    leads: await scalar(client, `select count(*) as n from leads where ${demoTenantFilter}`),
    quotes: await scalar(client, `select count(*) as n from quotes where ${demoTenantFilter}`),
    followUps: await scalar(client, `select count(*) as n from follow_ups where ${demoTenantFilter}`),
    pricingApprovals: await scalar(client, `select count(*) as n from pricing_approvals where ${demoTenantFilter}`),
  };
}

export async function verifyDemoSeed(client: pg.PoolClient | pg.Client): Promise<VerificationReport> {
  const failures: string[] = [];
  const volumes = await readVolumes(client);

  const check = (label: string, actual: number, minimum: number): void => {
    if (actual < minimum) failures.push(`${label}: expected >= ${String(minimum)}, got ${String(actual)}`);
  };
  check('tenants', volumes.tenants, DEMO_MINIMUMS.tenants);
  check('users', volumes.users, DEMO_MINIMUMS.users);
  check('brokers', volumes.brokers, DEMO_MINIMUMS.brokers);
  check('parties', volumes.parties, DEMO_MINIMUMS.parties);
  check('leads', volumes.leads, DEMO_MINIMUMS.leads);
  check('quotes', volumes.quotes, DEMO_MINIMUMS.quotes);
  check('followUps', volumes.followUps, DEMO_MINIMUMS.followUps);
  check('pricingApprovals', volumes.pricingApprovals, DEMO_MINIMUMS.pricingApprovals);

  const demoTenants =
    "q.tenant_id in (select id from tenants where name in ('Kalahari Insurance (Pilot)', 'Okavango Risk Partners'))";

  // INVARIANT: every quote has a lead in the same tenant.
  const orphanQuotes = await scalar(
    client,
    `select count(*) as n from quotes q where ${demoTenants} and not exists (
       select 1 from leads l where l.tenant_id = q.tenant_id and l.id = q.lead_id)`,
  );
  if (orphanQuotes > 0) failures.push(`orphan quotes (no lead): ${String(orphanQuotes)}`);

  // INVARIANT: exactly one current version per quote.
  const badCurrentVersion = await scalar(
    client,
    `select count(*) as n from quotes q where ${demoTenants} and (
       select count(*) from quote_versions v
        where v.tenant_id = q.tenant_id and v.quote_id = q.id and v.is_current) <> 1`,
  );
  if (badCurrentVersion > 0) failures.push(`quotes without exactly one current version: ${String(badCurrentVersion)}`);

  // INVARIANT: lead status resolves to a lead_status reference item in the same tenant.
  const badLeadStatus = await scalar(
    client,
    `select count(*) as n from leads l where l.tenant_id in (select id from tenants where name in
       ('Kalahari Insurance (Pilot)', 'Okavango Risk Partners')) and not exists (
       select 1 from reference_items r where r.tenant_id = l.tenant_id and r.id = l.status_id
         and r.list_type = 'lead_status')`,
  );
  if (badLeadStatus > 0) failures.push(`leads with an invalid status reference: ${String(badLeadStatus)}`);

  // INVARIANT: quote status resolves to a quote_status reference item in the same tenant.
  const badQuoteStatus = await scalar(
    client,
    `select count(*) as n from quotes q where ${demoTenants} and not exists (
       select 1 from reference_items r where r.tenant_id = q.tenant_id and r.id = q.status_id
         and r.list_type = 'quote_status')`,
  );
  if (badQuoteStatus > 0) failures.push(`quotes with an invalid status reference: ${String(badQuoteStatus)}`);

  // INVARIANT: won/lost leads carry a decision date (status/category consistency).
  const decidedWithoutDate = await scalar(
    client,
    `select count(*) as n from leads l
       join reference_items r on r.tenant_id = l.tenant_id and r.id = l.status_id
      where l.tenant_id in (select id from tenants where name in
            ('Kalahari Insurance (Pilot)', 'Okavango Risk Partners'))
        and r.reporting_category in ('won', 'lost') and l.decision_date is null`,
  );
  if (decidedWithoutDate > 0) failures.push(`won/lost leads with no decision_date: ${String(decidedWithoutDate)}`);

  // Alert coverage (only meaningful after an evaluation run; the seed runs one before verifying).
  const alertRows = await client.query<{ type: string }>(
    `select distinct a.type from alerts a
      where a.resolved_at is null and a.tenant_id in (select id from tenants where name in
            ('Kalahari Insurance (Pilot)', 'Okavango Risk Partners'))`,
  );
  const alertTypesPresent = alertRows.rows.map((r) => r.type).sort();
  const missing = ALERT_TYPES.filter((t) => !alertTypesPresent.includes(t));
  if (missing.length > 0) failures.push(`alert types not firing on the seed: ${missing.join(', ')}`);

  return { volumes, alertTypesPresent, ok: failures.length === 0, failures };
}
