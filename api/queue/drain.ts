/**
 * Vercel function: POST/GET /api/queue/drain (T-031, M-16, Q-7, spec §9.5).
 *
 * Invoked every minute by a `pg_cron` schedule that calls this URL through `pg_net` (M-22: the
 * schedule lives in a SQL migration — `vercel.json` never gains a `crons` key). Locally the same
 * drain runs through `npm run queue:worker`.
 *
 * Protected by INTERNAL_JOB_SECRET. All behaviour lives in src/server/jobs/http.ts so it can be
 * tested without a server.
 */
import { handleQueueDrainRequest } from '../../src/server/jobs/http.js';

export const config = {
  runtime: 'nodejs',
} as const;

// NAMED METHOD EXPORT, NOT `export default`. Vercel's Node runtime invokes a default export with
// the legacy `(req, res)` signature, so `request` arrived as an IncomingMessage and every drain
// died on `request.headers.get is not a function`. A named HTTP method export selects the Web
// `fetch` signature, which is what this handler and every test already assume.
//
// POST because the pg_cron drain schedule reaches this through `net.http_post` (invoke_queue_drain).
export async function POST(request: Request): Promise<Response> {
  return await handleQueueDrainRequest(request);
}
