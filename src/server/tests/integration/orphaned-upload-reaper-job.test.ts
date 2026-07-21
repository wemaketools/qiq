/**
 * Job 5 — the orphaned-upload reaper against a real database (T-049; AC-024; V-031).
 *
 * The reaper deletes `quote_attachments` rows that are still PENDING (`confirmed_at is null`, not
 * soft-removed) and whose signed upload URL expired, together with their storage objects. Nothing
 * that matters here is stubbed at the database seam: real tenants with real partitions, real
 * attachment rows, and the real sweep code. The storage seam IS the injectable `StorageAdapter`
 * port, exercised here through the `FakeStorageAdapter` — the intended test seam (AC-058) — so the
 * suite can assert exactly which OBJECTS survive without a Storage container.
 *
 * THE FIXTURE STRADDLES THE TTL BOUNDARY ON PURPOSE
 * =================================================
 * A fixture in which every pending row is long past the TTL could not tell a CORRECT threshold from
 * one that reaps everything. Every row below sits at a KNOWN offset from the injected `NOW`, and the
 * set deliberately contains rows either side of the cutoff (`NOW - 2h`):
 *
 *   uploaded_at = cutoff - 1min  ->  REAPED     (just outside the window)
 *   uploaded_at = cutoff         ->  KEPT       (`<`, not `<=`: an upload at the exact boundary may
 *                                                still be completing)
 *   uploaded_at = cutoff + 1min  ->  KEPT       (comfortably in flight)
 *
 * Flipping `<` to `<=` in `listOrphanedAttachmentCandidates` reaps `orphanAtBoundary` and fails the
 * boundary test; dropping the `uploaded_at` predicate reaps `orphanJustInside`; dropping the
 * `confirmed_at` / `removed_at` predicate reaps `confirmedOld` / `removedPendingOld`. That is what
 * makes these assertions load-bearing rather than decorative.
 *
 * WHY NOW IS A FIXED INSTANT IN THE PAST
 * ======================================
 * `NOW` is fixed so the boundary rows are deterministic, and it is in the PAST relative to the wall
 * clock so this suite's cutoff cannot reach any OTHER suite's recent pending rows: a row uploaded at
 * real-now is newer than this cutoff and is never a candidate here. Conversely the real-now reaper
 * that `cron:run:all` invokes cannot reach THESE rows either while they exist, because integration
 * suites run serially (`fileParallelism: false`) and this suite deletes its own data in `afterAll`.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORPHANED_UPLOAD_REAPER_JOB_NAME,
  createOrphanedUploadReaperHandler,
  runOrphanedUploadReaperSweep,
} from '../../jobs/cron/orphaned-upload-reaper.js';
import { runCronJob } from '../../jobs/cron/run-cron-job.js';
import { PgJobRunRepository } from '../../jobs/job-run-repository.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { jobLogger } from '../../lib/logging/index.js';
import { FakeStorageAdapter } from '../../lib/storage/index.js';
import { TestAuthFixtures } from '../helpers/auth.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('orphaned-upload reaper job', probe);

const RUN = `t049our-${process.pid}-${Date.now()}`;

/** The fixed instant every fixture offset is measured from, and the 2h TTL the sweep applies. */
const NOW = new Date('2026-06-15T12:00:00.000Z');
const TTL_SECONDS = 7200;
/** cutoff = NOW - 2h = 2026-06-15T10:00:00Z. */
const CUTOFF_MS = NOW.getTime() - TTL_SECONDS * 1000;

function offsetFromCutoff(deltaMs: number): string {
  return new Date(CUTOFF_MS + deltaMs).toISOString();
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * The hand-computed truth table: fixture label -> whether the row (and its object) SURVIVES one
 * sweep. Derived from the candidate predicate, not from the implementation.
 */
interface FixtureSpec {
  /** uploaded_at, as a delta in ms from the cutoff instant. */
  readonly uploadedAtDelta: number;
  readonly confirmed: boolean;
  readonly removed: boolean;
  /** false seeds a row whose object was already deleted — the "tolerate object gone" case. */
  readonly withObject: boolean;
  readonly survives: boolean;
}

const FIXTURES: Readonly<Record<string, FixtureSpec>> = {
  /** pending, a full day past the cutoff: the plain positive case. */
  orphanFarPast: { uploadedAtDelta: -DAY, confirmed: false, removed: false, withObject: true, survives: false },
  /** pending, one minute past the cutoff: the boundary row that discriminates from `orphanAtBoundary`. */
  orphanJustOutside: { uploadedAtDelta: -MINUTE, confirmed: false, removed: false, withObject: true, survives: false },
  /** pending, an hour past the cutoff, object ALREADY gone: a partial previous run must still complete. */
  orphanMissingObject: { uploadedAtDelta: -HOUR, confirmed: false, removed: false, withObject: false, survives: false },
  /** pending, uploaded EXACTLY at the cutoff: `<` keeps it, `<=` would reap it. */
  orphanAtBoundary: { uploadedAtDelta: 0, confirmed: false, removed: false, withObject: true, survives: true },
  /** pending, one minute INSIDE the window: still possibly in flight, must be kept. */
  orphanJustInside: { uploadedAtDelta: MINUTE, confirmed: false, removed: false, withObject: true, survives: true },
  /** CONFIRMED and old: a live business record the sweep must never touch. */
  confirmedOld: { uploadedAtDelta: -DAY, confirmed: true, removed: false, withObject: true, survives: true },
  /** pending but SOFT-REMOVED and old: history NFR-09 preserves; excluded by the removed_at clause. */
  removedPendingOld: { uploadedAtDelta: -DAY, confirmed: false, removed: true, withObject: true, survives: true },
};

const SURVIVORS = Object.entries(FIXTURES)
  .filter(([, spec]) => spec.survives)
  .map(([label]) => label)
  .sort();
const REAPED = Object.entries(FIXTURES)
  .filter(([, spec]) => !spec.survives)
  .map(([label]) => label)
  .sort();

interface SeededAttachment {
  readonly id: number;
  readonly key: string;
}

interface TenantFixture {
  readonly tenantId: number;
  readonly attachments: Readonly<Record<string, SeededAttachment>>;
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let storage: FakeStorageAdapter;

  let tenantA: TenantFixture;
  let tenantB: TenantFixture;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  async function insertReturningId(sql: string, params: unknown[]): Promise<number> {
    const rows = await query<{ id: string }>(sql, params);
    return Number(rows[0]?.id);
  }

  async function createTenant(label: string): Promise<number> {
    const id = await insertReturningId(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-${label}`],
    );
    createdTenants.push(id);
    await query('select create_tenant_partitions($1)', [id]);
    return id;
  }

  /**
   * Seeds one attachment row directly and, unless `withObject` is false, places its object in the
   * fake adapter at the row's `storage_key`. The key is tenant-prefixed exactly as production keys
   * are, so a delete addresses the right namespace.
   */
  async function seedAttachment(
    tenantId: number,
    label: string,
    spec: FixtureSpec,
  ): Promise<SeededAttachment> {
    const uploadedAt = offsetFromCutoff(spec.uploadedAtDelta);
    const key = `t${String(tenantId)}/quotes/9001/${RUN}-${label}`;
    const id = await insertReturningId(
      `insert into quote_attachments
         (tenant_id, quote_id, file_name, content_type, size_bytes, storage_key, uploaded_at,
          uploaded_by, confirmed_at, removed_at, removed_by)
       values ($1, 9001, $2, 'application/pdf', 1024, $3, $4::timestamptz, null,
               $5::timestamptz, $6::timestamptz, null)
       returning id::text as id`,
      [
        tenantId,
        `${label}.pdf`,
        key,
        uploadedAt,
        spec.confirmed ? uploadedAt : null,
        spec.removed ? uploadedAt : null,
      ],
    );

    if (spec.withObject) {
      // A tiny PDF magic-number payload; content is irrelevant to the reaper, only its presence.
      storage.put(key, new Uint8Array([0x25, 0x50, 0x44, 0x46]), 'application/pdf');
    }
    return { id, key };
  }

  async function seedTenantFixtures(tenantId: number): Promise<TenantFixture> {
    const attachments: Record<string, SeededAttachment> = {};
    for (const [label, spec] of Object.entries(FIXTURES)) {
      attachments[label] = await seedAttachment(tenantId, label, spec);
    }
    return { tenantId, attachments };
  }

  /** The set of attachment ids still present for a tenant, keyed back to fixture labels. */
  async function survivingLabels(fixture: TenantFixture): Promise<string[]> {
    const rows = await query<{ id: string }>(
      'select id::text as id from quote_attachments where tenant_id = $1',
      [fixture.tenantId],
    );
    const presentIds = new Set(rows.map((row) => Number(row.id)));
    return Object.entries(fixture.attachments)
      .filter(([, seeded]) => presentIds.has(seeded.id))
      .map(([label]) => label)
      .sort();
  }

  /** Whether each fixture's object still exists in the fake bucket, keyed by label. */
  function objectPresenceByLabel(fixture: TenantFixture): Record<string, boolean> {
    const held = new Set(storage.keys());
    const result: Record<string, boolean> = {};
    for (const [label, seeded] of Object.entries(fixture.attachments)) {
      result[label] = held.has(seeded.key);
    }
    return result;
  }

  async function sweep(options: { batchSize?: number } = {}) {
    return await runOrphanedUploadReaperSweep(
      db,
      storage,
      { logger: jobLogger({ jobName: ORPHANED_UPLOAD_REAPER_JOB_NAME, correlationId: RUN, trigger: 'manual' }) },
      { now: NOW, ttlSeconds: TTL_SECONDS, ...options },
    );
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    config = loadConfig({
      APP_ENV: 'local',
      LOG_LEVEL: 'error',
      DATABASE_URL: stack.dbUrl,
      DIRECT_DATABASE_URL: stack.dbUrl,
      SUPABASE_URL: stack.apiUrl,
      SUPABASE_ANON_KEY: stack.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
      CRON_SECRET: 'local-cron-secret',
      INTERNAL_JOB_SECRET: 'local-internal-job-secret',
      API_KEY_PEPPER: 'local-api-key-pepper-value',
    });

    auth = new TestAuthFixtures(stack);
    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

    storage = new FakeStorageAdapter();
    await storage.listen();

    tenantA = await seedTenantFixtures(await createTenant('tenant-a'));
    tenantB = await seedTenantFixtures(await createTenant('tenant-b'));
  }, 300_000);

  afterAll(async () => {
    if (!probe.available) return;

    // Data deletion MUST precede `auth.cleanup()`: that call ends the pool these deletes run on and
    // each delete swallows its error, so the reverse order is a silent no-op.
    for (const tenantId of createdTenants) {
      await query('delete from quote_attachments where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }
    await query('delete from job_run where job_name = $1 and correlation_id like $2', [
      ORPHANED_UPLOAD_REAPER_JOB_NAME,
      `${RUN}%`,
    ]).catch(() => undefined);

    await storage?.close();
    await auth?.cleanup();
    await db?.destroy();
  }, 300_000);

  // -------------------------------------------------------------------------------------------
  // AC-024: only expired pending rows are reaped; everything else is left exactly as it was
  // -------------------------------------------------------------------------------------------

  it('reaps exactly the expired-pending set and leaves every other row present', async () => {
    await sweep();

    const survivors = await survivingLabels(tenantA);
    expect(survivors).toEqual(SURVIVORS);
    // The complementary half stated explicitly: none of the expired-pending rows survive.
    for (const label of REAPED) expect(survivors).not.toContain(label);
  });

  it('deletes the storage OBJECT together with the row, and only for reaped rows', async () => {
    await sweep();

    const present = objectPresenceByLabel(tenantA);
    // Reaped rows: their objects are gone (orphanMissingObject never had one — see next test).
    expect(present.orphanFarPast).toBe(false);
    expect(present.orphanJustOutside).toBe(false);
    // Survivors keep BOTH row and object.
    expect(present.orphanAtBoundary).toBe(true);
    expect(present.orphanJustInside).toBe(true);
    expect(present.confirmedOld).toBe(true);
    expect(present.removedPendingOld).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // The TTL boundary from BOTH sides — the single most load-bearing assertion in the suite
  // -------------------------------------------------------------------------------------------

  it('reaps a row just OUTSIDE the window and keeps ones just inside and exactly at the boundary', async () => {
    await sweep();

    const survivors = await survivingLabels(tenantA);
    // Just outside (cutoff - 1min): gone. Just inside (cutoff + 1min) and exactly at the cutoff:
    // kept. Stated individually so a bulk edit cannot silently lose the boundary — this is the pair
    // that distinguishes a correct threshold from one that reaps everything, and `orphanAtBoundary`
    // is what distinguishes `<` from `<=`.
    expect(survivors).not.toContain('orphanJustOutside');
    expect(survivors).toContain('orphanJustInside');
    expect(survivors).toContain('orphanAtBoundary');
  });

  // -------------------------------------------------------------------------------------------
  // Tolerate the object already being gone (a partial previous run must be completable)
  // -------------------------------------------------------------------------------------------

  it('completes when the object is already gone, deleting the row without a failure', async () => {
    const result = await sweep();

    // The row whose object was never placed is still reaped, and no attachment is counted as failed.
    expect(await survivingLabels(tenantA)).not.toContain('orphanMissingObject');
    expect(result.counts.attachmentsFailed).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // Confirmed and soft-removed rows are never touched
  // -------------------------------------------------------------------------------------------

  it('never reaps a confirmed or a soft-removed row, nor their objects', async () => {
    await sweep();

    const survivors = await survivingLabels(tenantA);
    expect(survivors).toContain('confirmedOld');
    expect(survivors).toContain('removedPendingOld');

    const present = objectPresenceByLabel(tenantA);
    expect(present.confirmedOld).toBe(true);
    expect(present.removedPendingOld).toBe(true);
  });

  // -------------------------------------------------------------------------------------------
  // AC-024 idempotency: a second run is a provable no-op
  // -------------------------------------------------------------------------------------------

  it('running the sweep twice reaps nothing the second time (rows and objects unchanged)', async () => {
    await sweep();

    const rowsAfterFirst = await survivingLabels(tenantA);
    const objectsAfterFirst = objectPresenceByLabel(tenantA);

    const second = await sweep();

    // Same surviving rows, same surviving objects — no double-act, no error.
    expect(await survivingLabels(tenantA)).toEqual(rowsAfterFirst);
    expect(objectPresenceByLabel(tenantA)).toEqual(objectsAfterFirst);
    // And the run itself reports it found nothing left to reap.
    expect(second.counts.attachmentsReaped).toBe(0);
    expect(second.counts.attachmentsFailed).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // AC-022 tenant isolation: an independent tenant with the same fixtures reaps identically
  // -------------------------------------------------------------------------------------------

  it('reaps each tenant independently and never crosses tenants', async () => {
    await sweep();

    // Same fixtures, independent tenants: the surviving set must match exactly in each.
    expect(await survivingLabels(tenantB)).toEqual(SURVIVORS);
    expect(await survivingLabels(tenantA)).toEqual(SURVIVORS);

    // Each tenant keeps exactly its four surviving objects under its OWN prefix — the sweep did not
    // reach across the prefix boundary and delete the other tenant's objects.
    const survivorsWithObject = SURVIVORS.filter((label) => FIXTURES[label]?.withObject).length;
    for (const tenantId of [tenantA.tenantId, tenantB.tenantId]) {
      const prefix = `t${String(tenantId)}/quotes/9001/${RUN}-`;
      const held = storage.keys().filter((key) => key.startsWith(prefix));
      expect(held).toHaveLength(survivorsWithObject);
    }
  });

  // -------------------------------------------------------------------------------------------
  // End-to-end dispatch: the registered handler runs through runCronJob and records a job_run row
  // -------------------------------------------------------------------------------------------

  it('dispatches through runCronJob, reaps a real seeded orphan, and records the run on job_run', async () => {
    // A fresh orphan seeded solely for this test, so the assertion holds regardless of which other
    // tests in this file already ran their sweeps.
    const fresh = await seedAttachment(tenantA.tenantId, 'e2e-dispatch', {
      uploadedAtDelta: -DAY,
      confirmed: false,
      removed: false,
      withObject: true,
      survives: false,
    });
    expect(storage.keys()).toContain(fresh.key);

    const jobRuns = new PgJobRunRepository(db, config.appEnv);
    const handler = createOrphanedUploadReaperHandler(db, storage, { now: NOW, ttlSeconds: TTL_SECONDS });

    const outcome = await runCronJob(
      { db, handlers: new Map([[handler.name, handler]]), jobRuns },
      { jobName: ORPHANED_UPLOAD_REAPER_JOB_NAME, trigger: 'manual', correlationId: `${RUN}-dispatch` },
    );

    expect(outcome.status).toBe('succeeded');

    // The row AND its object are gone end-to-end.
    const rows = await query<{ id: string }>(
      'select id::text as id from quote_attachments where tenant_id = $1 and id = $2',
      [tenantA.tenantId, fresh.id],
    );
    expect(rows).toHaveLength(0);
    expect(storage.keys()).not.toContain(fresh.key);

    // Durable evidence on job_run, with per-tenant counts.
    const jobRunRows = await query<{ status: string; counts: unknown; job_name: string }>(
      'select status, counts, job_name from job_run where correlation_id = $1',
      [`${RUN}-dispatch`],
    );
    expect(jobRunRows).toHaveLength(1);
    expect(jobRunRows[0]?.job_name).toBe(ORPHANED_UPLOAD_REAPER_JOB_NAME);
    expect(jobRunRows[0]?.status).toBe('succeeded');
    expect(JSON.stringify(jobRunRows[0]?.counts)).toContain('attachmentsReaped');
  });
});
