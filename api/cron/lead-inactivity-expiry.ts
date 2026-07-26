/**
 * Vercel function: GET /api/cron/lead-inactivity-expiry (T-031 scaffolding, M-14, Q-7).
 *
 * Job 2 — expire open leads inactive beyond the tenant threshold (spec §9.5).
 * Schedule (registered by T-032): pg_cron `10 * * * *` -> pg_net -> this URL.
 *
 * Protected by CRON_SECRET. The handler itself is registered by T-032; until then this endpoint
 * authenticates, writes a failed job_run row and answers 501 — it never reports success for work
 * that does not exist yet.
 */
import { handleCronRequest } from '../../src/server/jobs/http.js';

export const config = {
  runtime: 'nodejs',
} as const;

export const jobName = 'lead-inactivity-expiry';

// NAMED METHOD EXPORT, NOT `export default`. Vercel's Node runtime invokes a default export with
// the legacy `(req, res)` signature, so `request` arrived as an IncomingMessage and every call
// died on `request.headers.get is not a function` before the job could run — see the T-031 note in
// src/server/jobs/http.ts. A named HTTP method export selects the Web `fetch` signature instead,
// which is what this handler, the job layer and every test already assume.
//
// GET because the pg_cron schedules reach this through `net.http_get` (invoke_cron_endpoint).
export async function GET(request: Request): Promise<Response> {
  return await handleCronRequest(request, jobName);
}
