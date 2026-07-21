/**
 * Job 5 — the orphaned-upload reaper (T-049; AC-024; V-031).
 *
 * There is no .NET counterpart: the reference upload was ONE request (bytes streamed through the
 * API, validated, written to object storage and the metadata row inserted in a single transaction),
 * so a "half-uploaded" row could not exist and nothing needed reclaiming. The A-7 signed-URL
 * envelope split the transfer in two — the server inserts a PENDING row and issues a signed URL, the
 * client transfers the bytes directly, a second call confirms — which creates a state the reference
 * never had: a metadata row whose upload was requested and then abandoned, and whose object may or
 * may not have been written. Without this sweep every abandoned upload is permanent litter in a
 * private bucket nobody lists.
 *
 * ============================================================================================
 * JOB CONTRACT (spec §9.5's required documentation for every recurring job)
 * ============================================================================================
 *   NAME              orphaned-upload-reaper
 *   SCHEDULE          hourly at half past — pg_cron `30 * * * *` -> pg_net ->
 *                     GET /api/cron/orphaned-upload-reaper. Locally,
 *                     `npm run cron:run -- orphaned-upload-reaper` through the same object graph.
 *                     The half-hour offset simply keeps it off the same minute as the :00/:10 expiry
 *                     sweeps and the every-15-minute alert sweep; orphan reclamation is not
 *                     time-critical, since an unconfirmed row is already invisible to every read path.
 *   PURPOSE           Delete every `quote_attachments` row that is still PENDING (`confirmed_at is
 *                     null`, not soft-removed) and whose `uploaded_at` is older than the upload-URL
 *                     TTL, together with its storage object.
 *   IDEMPOTENCY KEY   NONE, and deliberately so. The sweep is STATE-GUARDED: its candidate query
 *                     selects only rows CURRENTLY pending and past the TTL, and reaping one deletes
 *                     it from that set. A second run therefore selects nothing and does nothing. The
 *                     storage delete is itself idempotent (a no-op on an absent object), so a run
 *                     that partially completed — object gone, row not yet deleted — is COMPLETABLE by
 *                     the next run rather than fatal. An idempotency key would add a way to fail
 *                     without removing a single duplicate, because the duplicate is already
 *                     impossible.
 *   RETRY BEHAVIOUR   Safe at any time, including concurrent and duplicate delivery. Two overlapping
 *                     runs cannot double-act: `deletePendingAttachment` is guarded on `confirmed_at
 *                     is null` and a row is either present-and-pending (deleted once) or already
 *                     gone (a no-op delete). A row that gets CONFIRMED between the candidate read and
 *                     the delete is protected by that same guard — the guarded delete affects zero
 *                     rows and the confirmed attachment survives.
 *   FAILURE HANDLING  PER-TENANT, and per-attachment within a tenant. One tenant's candidate query
 *                     throwing does not stop the sweep (the tenant iterator continues); one
 *                     attachment failing to delete does not abandon the rest of its tenant's
 *                     candidates — it is logged and skipped. The run reports FAILED with the failing
 *                     tenant ids and partial counts when any tenant threw.
 *   DATABASE STATE    Reads `quote_attachments`; deletes `quote_attachments` pending rows. No status
 *                     column, no history, no audit — a pending row is not a business record (NFR-09
 *                     preserves business records; this row never became one, exactly as
 *                     `discardPendingAttachment` argues on the confirm-rejection path).
 *   OBSERVABILITY     One structured log line per tenant (tenant id + counts, never a file name or a
 *                     storage key — §15), a warning per attachment that failed to reap, and aggregate
 *                     counts on the job_run row.
 *
 * THE OBJECT IS DELETED BEFORE THE ROW, ON PURPOSE
 * ================================================
 * Same ordering as `attachments.service.ts`'s `discardPendingAttachment`. If the storage delete
 * fails the row survives, and an orphaned ROW pointing at a real object is recoverable — the next
 * run finds it again and retries. The reverse failure — row gone, object retained — leaves bytes in
 * the bucket that nothing in the database describes, unrecoverable without a full bucket scan. So
 * the object goes first and the row second, and neither is inside the other's transaction.
 *
 * IT USES THE StorageAdapter PORT, NEVER A VENDOR SDK
 * ===================================================
 * The delete goes through the injected `StorageAdapter` (A-6). The sweep names no storage vendor, so
 * the fake adapter is the unit/integration test seam and switching bindings costs it nothing.
 */
import {
  deletePendingAttachment,
  listOrphanedAttachmentCandidates,
} from '../../domains/quotes/index.js';
import { toTenantId, withTransaction, type DbClient, type TenantId } from '../../lib/db/index.js';
import { SUPABASE_UPLOAD_TOKEN_TTL_SECONDS, type StorageAdapter } from '../../lib/storage/index.js';
import { forEachActiveTenant } from '../tenant-iterator.js';
import type { JobContext, JobHandler, JobResult } from '../types.js';
import { PartialSweepError } from './partial-sweep-error.js';

export const ORPHANED_UPLOAD_REAPER_JOB_NAME = 'orphaned-upload-reaper';

const MS_PER_SECOND = 1000;

/**
 * The reap cutoff: `now - ttlSeconds`, as an ISO instant. A pending row is a candidate only when its
 * `uploaded_at` is STRICTLY before this instant.
 *
 * Exported and pure so the unit suite can sweep it without a database, including the DST case no
 * integration fixture can reach (its rows are seeded in UTC). Arithmetic in milliseconds rather than
 * by mutating a Date's calendar component: the latter would silently shift the cutoff by an hour
 * across a DST boundary in any non-UTC process timezone, which is exactly the kind of one-hour error
 * that would reap an upload still in flight or spare one long abandoned.
 */
export function orphanUploadCutoff(now: Date, ttlSeconds: number): string {
  return new Date(now.getTime() - ttlSeconds * MS_PER_SECOND).toISOString();
}

export interface OrphanedUploadReaperOptions {
  /** Injected so tests are deterministic; production passes nothing and uses the wall clock. */
  readonly now?: Date | undefined;
  /**
   * The upload-URL lifetime a row must exceed to be reaped. Defaults to the Supabase upload-token
   * TTL (fixed at 2h server-side; `createSignedUploadUrl` accepts no `expiresIn`). Injectable only
   * so tests can compress the window; production never sets it.
   */
  readonly ttlSeconds?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly timeBudgetMs?: number | undefined;
}

export interface OrphanedUploadReaperSweepResult {
  readonly counts: Record<string, number>;
  readonly failedTenantIds: number[];
}

/**
 * Reaps one tenant's expired pending uploads. Returns the counts so the caller can aggregate them.
 */
async function reapForTenant(
  db: DbClient,
  storage: StorageAdapter,
  tenantId: TenantId,
  cutoff: string,
  context: Pick<JobContext, 'logger'>,
): Promise<{ attachmentsReaped: number; attachmentsFailed: number }> {
  const candidates = await listOrphanedAttachmentCandidates(db, tenantId, cutoff);
  if (candidates.length === 0) {
    return { attachmentsReaped: 0, attachmentsFailed: 0 };
  }

  let attachmentsReaped = 0;
  let attachmentsFailed = 0;

  for (const candidate of candidates) {
    try {
      // Object FIRST, then the row (see the header). `delete` is a no-op on an absent key, so a
      // partial previous run whose object is already gone still completes here.
      if (candidate.storageKey.length > 0) {
        await storage.delete(candidate.storageKey);
      }
      // Guarded on `confirmed_at is null` inside the statement: a row confirmed since the candidate
      // read is protected and this affects zero rows.
      await withTransaction(db, (trx) => deletePendingAttachment(trx, tenantId, candidate.id));
      attachmentsReaped += 1;
    } catch (error) {
      // One bad attachment must not abandon the rest of the tenant's candidates.
      attachmentsFailed += 1;
      context.logger.warn('orphaned-upload-reaper could not reap attachment', {
        tenantId: Number(tenantId),
        attachmentId: candidate.id,
        err: error,
      });
    }
  }

  return { attachmentsReaped, attachmentsFailed };
}

/**
 * Runs the sweep across every active tenant. Exported separately from the handler so tests can drive
 * it with a real client + a fake storage adapter and assert per-tenant behaviour without the
 * job_run plumbing.
 */
export async function runOrphanedUploadReaperSweep(
  db: DbClient,
  storage: StorageAdapter,
  context: Pick<JobContext, 'logger'>,
  options: OrphanedUploadReaperOptions = {},
): Promise<OrphanedUploadReaperSweepResult> {
  const now = options.now ?? new Date();
  const ttlSeconds = options.ttlSeconds ?? SUPABASE_UPLOAD_TOKEN_TTL_SECONDS;
  const cutoff = orphanUploadCutoff(now, ttlSeconds);

  let attachmentsReaped = 0;
  let attachmentsFailed = 0;
  const failedTenantIds: number[] = [];

  const outcome = await forEachActiveTenant(
    db,
    async (tenant) => {
      const result = await reapForTenant(db, storage, toTenantId(tenant.id), cutoff, context);

      attachmentsReaped += result.attachmentsReaped;
      attachmentsFailed += result.attachmentsFailed;

      // Ids and counts only — never a file name or a storage key (§15).
      context.logger.info('orphaned-upload-reaper swept tenant', {
        tenantId: tenant.id,
        attachmentsReaped: result.attachmentsReaped,
        attachmentsFailed: result.attachmentsFailed,
      });
    },
    {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.timeBudgetMs === undefined ? {} : { timeBudgetMs: options.timeBudgetMs }),
    },
  );

  for (const failure of outcome.failures) {
    failedTenantIds.push(failure.tenantId);
    context.logger.error('orphaned-upload-reaper failed for tenant', {
      tenantId: failure.tenantId,
      err: failure.error,
    });
  }

  return {
    counts: {
      tenantsProcessed: outcome.processed,
      tenantsFailed: outcome.failures.length,
      attachmentsReaped,
      attachmentsFailed,
      budgetExhausted: outcome.budgetExhausted ? 1 : 0,
    },
    failedTenantIds,
  };
}

/**
 * The registrable handler.
 *
 * A FACTORY over an explicit client and storage adapter rather than reading them off `context`: the
 * sweep opens its own per-attachment transactions and needs the configured `StorageAdapter`, which
 * `JobContext` does not carry. Production passes the same process-wide client and the composition
 * root's adapter, so there is no second connection and no second binding.
 */
export function createOrphanedUploadReaperHandler(
  db: DbClient,
  storage: StorageAdapter,
  options: OrphanedUploadReaperOptions = {},
): JobHandler {
  return {
    name: ORPHANED_UPLOAD_REAPER_JOB_NAME,

    async handle(_payload: unknown, context: JobContext): Promise<JobResult> {
      const { counts, failedTenantIds } = await runOrphanedUploadReaperSweep(
        db,
        storage,
        context,
        options,
      );

      if (failedTenantIds.length > 0) {
        throw new PartialSweepError(ORPHANED_UPLOAD_REAPER_JOB_NAME, failedTenantIds, counts);
      }

      return { counts };
    },
  };
}
