import { resetDatabase, seedDemo } from './helpers/seed';

/**
 * Playwright global setup (T-043). Two responsibilities, both guarded so an already-prepared
 * environment runs fast:
 *
 *   1. Seed the known demo dataset. By default the idempotent demo seed is (re)applied so the suite
 *      always runs against the T-041 demo data (personas, two tenants, leads/quotes/alert fixtures).
 *      Set `E2E_RESET=1` to also `supabase db reset` first (full migrations-from-empty + baseline),
 *      or `E2E_SKIP_SEED=1` to skip seeding entirely when you know the data is already in place.
 *   2. Fail fast if the local API is not reachable, so specs die with a clear message instead of
 *      confusing per-test timeouts. The Vite dev server proxies `/api/v1` to the local runner
 *      (src/ui/vite.config.ts); we probe the runner directly.
 */

const API_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3001';
const HEALTH_URL = `${API_TARGET}/api/v1/health`;

async function ensureSeed(): Promise<void> {
  if (process.env['E2E_SKIP_SEED'] === '1') {
    return;
  }
  if (process.env['E2E_RESET'] === '1') {
    await resetDatabase();
  }
  await seedDemo();
}

async function ensureApiReachable(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(HEALTH_URL);
  } catch (cause) {
    throw new Error(
      `Could not reach the API health endpoint at ${HEALTH_URL}. The SPA proxies '/api/v1/*' to ` +
        `this address, so it cannot talk to the backend until the API runner is up. Start the app ` +
        `with 'npm run dev' (API on :3001 + SPA on :5173), or set VITE_API_PROXY_TARGET.`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `The API health endpoint at ${HEALTH_URL} returned HTTP ${response.status} ${response.statusText}. ` +
        `The runner is up but unhealthy — check its startup logs (Supabase/DB wiring).`,
    );
  }
}

async function globalSetup(): Promise<void> {
  await ensureSeed();
  await ensureApiReachable();
}

export default globalSetup;
