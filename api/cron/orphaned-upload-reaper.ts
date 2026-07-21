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

export default async function handler(request: Request): Promise<Response> {
  return await handleCronRequest(request, jobName);
}
