/**
 * Job composition root (T-031).
 *
 * The single place the real dependencies are wired together, so `/api/queue/drain`,
 * `/api/cron/{job}`, `npm run queue:worker` and the local cron scripts all execute the SAME object
 * graph. Spec §9.5's "local substitute runs the same handler code" is enforced here rather than
 * asserted in prose: there is no second wiring for any of them to drift into.
 */
import type { LeadChangedListener } from '../domains/leads/index.js';
import { getConfig, type AppConfig } from '../lib/config/index.js';
import { getDb, type DbClient } from '../lib/db/index.js';
import { createStorageAdapter } from '../lib/storage/index.js';
import { createAlertEvaluationHandler } from './cron/alert-evaluation.js';
import { createLeadInactivityExpiryHandler } from './cron/lead-inactivity-expiry.js';
import { createOrphanedUploadReaperHandler } from './cron/orphaned-upload-reaper.js';
import { createQuoteExpiryHandler } from './cron/quote-expiry.js';
import { cronHandlers, registerCronHandler } from './cron/registry.js';
import { runCronJob, type CronRunOutcome, type RunCronJobOptions } from './cron/run-cron-job.js';
import { PgJobRunRepository, type JobRunRepository } from './job-run-repository.js';
import {
  alertReevaluateLeadHandler,
  createAlertReevaluationSeam,
} from './queue/alert-reevaluate-lead.js';
import { createQueueConsumer } from './queue/drain.js';
import { ALERT_REEVALUATION_QUEUE, PgmqTransport } from './queue/pgmq-adapter.js';
import { queueHandlers, registerQueueHandler } from './queue/registry.js';
import type { QueueConsumer, QueuePublisher, QueueTransport } from './types.js';
import { pgJobTransactionRunner } from './unit-of-work.js';

export interface JobRuntime {
  readonly config: AppConfig;
  readonly db: DbClient;
  readonly jobRuns: JobRunRepository;
  readonly transport: QueueTransport;
  readonly publisher: QueuePublisher;
  readonly consumer: QueueConsumer;
  /** The post-commit callback the lead/quote workflow deps take as `onLeadChanged` (T-034). */
  readonly onLeadChanged: LeadChangedListener;
  runCron(options: RunCronJobOptions): Promise<CronRunOutcome>;
}

export interface JobRuntimeOverrides {
  readonly config?: AppConfig;
  readonly db?: DbClient;
  readonly queueName?: string;
}

export function createJobRuntime(overrides: JobRuntimeOverrides = {}): JobRuntime {
  const config = overrides.config ?? getConfig();
  const db = overrides.db ?? getDb(config);
  const jobRuns = new PgJobRunRepository(db, config.appEnv);
  const transport = new PgmqTransport(db, overrides.queueName ?? ALERT_REEVALUATION_QUEUE);

  // All three sweeps are registered HERE rather than at their modules' top level, because each
  // handler is a factory over an explicit `DbClient` — they need the client this composition root
  // resolves. Registration is idempotent (the registry is a Map keyed by job name), so building a
  // second runtime in a test re-registers against that runtime's client rather than accumulating
  // handlers.
  //
  // The seam is built BEFORE the sweeps so the two expiry sweeps can be given it. In .NET the
  // expiry jobs got this behaviour for free by resolving the executors from the DI scope; here it
  // has to be passed explicitly, and a `{ db }` that forgot it would look identical in every test.
  const onLeadChanged = createAlertReevaluationSeam({ publisher: transport });

  registerCronHandler(createQuoteExpiryHandler(db, { onLeadChanged }));
  registerCronHandler(createLeadInactivityExpiryHandler(db, { onLeadChanged }));
  registerCronHandler(createAlertEvaluationHandler(db));

  // The reaper needs the configured StorageAdapter to delete abandoned objects (T-049). Built from
  // the same typed config as every other binding; `createStorageAdapter` refuses the in-memory fake
  // outside a local environment, so a misconfigured deploy fails loudly here rather than silently
  // deleting rows whose objects it cannot reach.
  registerCronHandler(createOrphanedUploadReaperHandler(db, createStorageAdapter(config)));

  // The queue consumer. Registered here rather than at the registry's module level so that the
  // cron and queue registration stories are the same one, and so `cron:list`-style tooling that
  // builds a runtime observes the real, complete dispatch table.
  registerQueueHandler(alertReevaluateLeadHandler);

  const consumer = createQueueConsumer({
    transport,
    handlers: queueHandlers,
    jobRuns,
    runInTransaction: pgJobTransactionRunner(db),
  });

  return {
    config,
    db,
    jobRuns,
    transport,
    publisher: transport,
    consumer,
    onLeadChanged,
    runCron: (options) => runCronJob({ db, handlers: cronHandlers, jobRuns }, options),
  };
}

/**
 * The `onLeadChanged` seam for the REQUEST path (T-034).
 *
 * The API function needs the publisher but none of the consumer machinery, so this returns just the
 * callback rather than making every request-serving cold start construct a drain loop. It goes
 * through `createJobRuntime` regardless, so the request path and the job path publish to THE SAME
 * queue name via THE SAME adapter — a second, hand-rolled transport here is exactly how a producer
 * ends up writing to a queue no consumer reads.
 */
export function defaultAlertReevaluationSeam(config?: AppConfig): LeadChangedListener {
  return createJobRuntime(config === undefined ? {} : { config }).onLeadChanged;
}
