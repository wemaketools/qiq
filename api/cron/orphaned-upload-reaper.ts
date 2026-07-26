/**
 * Vercel function: GET /api/cron/orphaned-upload-reaper (T-049, M-14, Q-7).
 *
 * Job 5 — delete pending attachment rows + objects whose signed upload URL expired unconfirmed
 * (spec §9.5). Schedule (registered by T-049's migration): pg_cron `30 * * * *` -> pg_net -> this
 * URL.
 *
 * Protected by CRON_SECRET. All behaviour lives in `handleCronRequest`; this file is the three-line
 * entrypoint, matching the other `api/cron/*` endpoints.
 */
import { handleCronRequest } from '../../src/server/jobs/http.js';

export const config = {
  runtime: 'nodejs',
} as const;

export const jobName = 'orphaned-upload-reaper';

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
