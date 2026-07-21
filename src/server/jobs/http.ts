/**
 * HTTP shells for the job endpoints (T-031, M-14/M-16, AC-062/AC-063).
 *
 * `api/queue/drain.ts` and each `api/cron/*.ts` file are three-line Vercel entrypoints; everything
 * they do lives here, where it is directly testable without a running server. The order of
 * operations in both handlers is fixed and load-bearing:
 *
 *     authorize  ->  (only then)  touch the database
 *
 * Nothing before the secret check reads or writes anything: an unauthenticated caller must leave
 * NO trace — no job_run row, no queue read, no business mutation (V-079 asserts exactly that).
 * A read that happened "just to see what's there" before rejecting would be an unauthenticated
 * database query on a public URL.
 */
import { problemResponse } from '../lib/errors/problem.js';
import { logger, resolveCorrelationId } from '../lib/logging/index.js';
import { authorizeJobRequest } from './endpoint-auth.js';
import { createJobRuntime, type JobRuntime } from './runtime.js';
import type { DrainOptions } from './types.js';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export interface JobEndpointDeps {
  readonly runtime?: JobRuntime;
}

/** POST/GET /api/queue/drain — protected by INTERNAL_JOB_SECRET. */
export async function handleQueueDrainRequest(
  request: Request,
  deps: JobEndpointDeps = {},
  drainOptions: DrainOptions = {},
): Promise<Response> {
  let runtime: JobRuntime;
  try {
    runtime = deps.runtime ?? createJobRuntime();
  } catch (error) {
    const correlationId = resolveCorrelationId(request.headers);
    logger.error('queue drain could not build its runtime', { correlationId, err: error });
    return problemResponse(error, correlationId);
  }

  const denied = authorizeJobRequest(
    request,
    runtime.config.secrets.internalJobSecret,
    '/api/queue/drain',
  );
  if (denied !== null) return denied;

  const correlationId = resolveCorrelationId(request.headers);
  try {
    const summary = await runtime.consumer.drain(drainOptions);
    logger.info('queue drain completed', { correlationId, ...summary });
    return jsonResponse({ ok: true, correlationId, ...summary });
  } catch (error) {
    logger.error('queue drain failed', { correlationId, err: error });
    return problemResponse(error, correlationId);
  }
}

/** GET /api/cron/{job} — protected by CRON_SECRET. */
export async function handleCronRequest(
  request: Request,
  jobName: string,
  deps: JobEndpointDeps = {},
): Promise<Response> {
  let runtime: JobRuntime;
  try {
    runtime = deps.runtime ?? createJobRuntime();
  } catch (error) {
    const correlationId = resolveCorrelationId(request.headers);
    logger.error('cron endpoint could not build its runtime', { correlationId, jobName, err: error });
    return problemResponse(error, correlationId);
  }

  const denied = authorizeJobRequest(request, runtime.config.secrets.cronSecret, `/api/cron/${jobName}`);
  if (denied !== null) return denied;

  const correlationId = resolveCorrelationId(request.headers);
  const outcome = await runtime.runCron({ jobName, trigger: 'cron', correlationId });

  if (outcome.status === 'succeeded') {
    return jsonResponse({
      ok: true,
      jobName,
      jobRunId: outcome.jobRunId,
      correlationId,
      ...(outcome.counts === undefined ? {} : { counts: outcome.counts }),
    });
  }

  // 501 rather than 500 when nothing is registered yet: the scaffold must be distinguishable from
  // a real sweep failure, both to an operator and to the task that comes to implement it.
  const status = outcome.error instanceof Error && outcome.error.name === 'HandlerNotRegisteredError' ? 501 : 500;
  return jsonResponse({ ok: false, jobName, jobRunId: outcome.jobRunId, correlationId }, status);
}
