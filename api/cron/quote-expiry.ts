/**
 * Vercel function: GET /api/cron/quote-expiry (T-031 scaffolding, M-14, Q-7).
 *
 * Job 1 — expire Sent quotes past valid_until (spec §9.5).
 * Schedule (registered by T-032): pg_cron `0 * * * *` -> pg_net -> this URL.
 *
 * Protected by CRON_SECRET. The handler itself is registered by T-032; until then this endpoint
 * authenticates, writes a failed job_run row and answers 501 — it never reports success for work
 * that does not exist yet.
 */
import { handleCronRequest } from '../../src/server/jobs/http.js';

export const config = {
  runtime: 'nodejs',
} as const;

export const jobName = 'quote-expiry';

export default async function handler(request: Request): Promise<Response> {
  return await handleCronRequest(request, jobName);
}
