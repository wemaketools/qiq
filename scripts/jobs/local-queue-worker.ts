#!/usr/bin/env tsx
/**
 * `npm run queue:worker` — the documented LOCAL consumer path (T-031, M-16, AC-065, spec §9.5).
 *
 * Deployed, pgmq is drained by a pg_cron schedule calling /api/queue/drain through pg_net. Locally
 * that callback cannot work: pg_net runs inside the Supabase Docker container and the dev server
 * runs on the host, so the container would have to reach back out to the host on a port nobody has
 * agreed on. Q-7 therefore makes this script the deterministic local path — and it drains through
 * `createJobRuntime()`, the same object graph the endpoint uses, so "the same handler code" is a
 * property of the import graph rather than a claim in a comment.
 *
 * Usage:
 *   npm run queue:worker                 poll until idle, then keep polling (Ctrl-C to stop)
 *   npm run queue:worker -- --once       one drain pass, then exit
 *   npm run queue:worker -- --idle-exit  exit as soon as a pass finds nothing (used by tests)
 *   npm run queue:worker -- --max-messages 5 --poll-ms 500 --visibility 30
 */
import { closeDb } from '../../src/server/lib/db/index.js';
import { createJobRuntime } from '../../src/server/jobs/runtime.js';
import type { DrainSummary } from '../../src/server/jobs/types.js';

interface Args {
  readonly once: boolean;
  readonly idleExit: boolean;
  readonly pollMs: number;
  readonly maxMessages: number;
  readonly visibilityTimeoutSeconds: number;
}

function numberFlag(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag);
  if (index === -1) return fallback;
  const parsed = Number(argv[index + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function parseArgs(argv: readonly string[]): Args {
  return {
    once: argv.includes('--once'),
    idleExit: argv.includes('--idle-exit'),
    pollMs: numberFlag(argv, '--poll-ms', 1000),
    maxMessages: numberFlag(argv, '--max-messages', 50),
    visibilityTimeoutSeconds: numberFlag(argv, '--visibility', 60),
  };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function describe(summary: DrainSummary): string {
  return (
    `drained ${summary.read} message(s) from ${summary.queueName}: ` +
    `${summary.succeeded} succeeded, ${summary.duplicates} duplicate, ${summary.failed} failed, ` +
    `${summary.deadLettered} dead-lettered, ${summary.invalid} invalid (${summary.elapsedMs}ms` +
    `${summary.budgetExhausted ? ', time budget reached' : ''})`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = createJobRuntime();

  out(`queue:worker started against "${runtime.transport.queueName}" (env=${runtime.config.appEnv})`);

  let stopping = false;
  const stop = (): void => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    const summary = await runtime.consumer.drain({
      maxMessages: args.maxMessages,
      visibilityTimeoutSeconds: args.visibilityTimeoutSeconds,
    });

    if (summary.read > 0) out(describe(summary));
    if (args.once) break;
    if (args.idleExit && summary.read === 0) {
      out('queue is empty; exiting (--idle-exit)');
      break;
    }
    if (summary.read === 0) await new Promise((resolve) => setTimeout(resolve, args.pollMs));
  }

  const metrics = await runtime.transport.metrics();
  out(`queue backlog: ${metrics.queueLength}, archived (dead-letter): ${metrics.archivedCount}`);
  await closeDb();
}

await main();
