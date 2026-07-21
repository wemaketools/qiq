/**
 * Vercel function: GET /api/cron/alert-evaluation (T-031 scaffolding, M-14, Q-7).
 *
 * Job 3 — full per-tenant alert reconciliation sweep (spec §9.5).
 * Schedule (registered by T-034): pg_cron every 15 minutes -> pg_net -> this URL.
 *
 * Protected by CRON_SECRET. The handler itself is registered by T-034; until then this endpoint
 * authenticates, writes a failed job_run row and answers 501 — it never reports success for work
 * that does not exist yet.
 */
import { handleCronRequest } from '../../src/server/jobs/http.js';

export const config = {
  runtime: 'nodejs',
} as const;

export const jobName = 'alert-evaluation';

export default async function handler(request: Request): Promise<Response> {
  return await handleCronRequest(request, jobName);
}
