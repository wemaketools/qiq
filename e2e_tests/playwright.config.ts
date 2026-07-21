import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Playwright config for the migrated Vite/Hono/Supabase stack (T-043).
 *
 * The app runs as two local processes started together by `npm run dev` (docs/local-development.md):
 * the Hono API runner on :3001 and the Vite SPA dev server on :5173, with Vite proxying `/api/v1`
 * (and `/api/cron`) to the runner so the browser talks to a single origin. The suite therefore
 * targets the SPA origin and lets the `webServer` block start both processes, injecting the two
 * browser-safe VITE_ Supabase values the SPA needs.
 *
 * storageState note: unlike the retired in-memory OIDC layer, supabase-js persists the session in
 * localStorage (`persistSession`), so an admin-minted session injected before boot survives
 * navigation — that is exactly what `helpers/auth.ts loginAsPersonaSession` does, which is why no
 * per-project storageState file is needed.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal `.env.local` reader so the webServer can hand the SPA its VITE_ Supabase values. */
function envLocal(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(join(here, '..', '.env.local'), 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    /* fall back to process.env */
  }
  return out;
}

const env = envLocal();
const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';
const supabaseUrl =
  process.env['VITE_SUPABASE_URL'] ?? env['VITE_SUPABASE_URL'] ?? env['SUPABASE_URL'] ?? 'http://127.0.0.1:54321';
const supabaseAnonKey =
  process.env['VITE_SUPABASE_ANON_KEY'] ?? env['VITE_SUPABASE_ANON_KEY'] ?? env['SUPABASE_ANON_KEY'] ?? '';

// The CI smoke subset: the auth surface (unauth redirect, real-form sign-in both success/failure,
// sign-out). Fully green and self-contained — no demo-dataset reconciliation. See
// docs/local-development.md "End-to-end tests" for the CI decision.
const smokeSuites = /(smoke|login|logout)\.spec\.ts/;

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // The suite mutates a single shared demo database (create lead, assign, resolve alert, ...), and a
  // few specs drive server-side job hooks that touch tenant-wide state. Serialize for determinism —
  // the same rationale (plus GoTrue rate limits on the real-form login specs) the prior config had.
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
    testIdAttribute: 'data-testid',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // Invoked with `--project=smoke` for the CI gate (auth surface + shell).
      name: 'smoke',
      testMatch: smokeSuites,
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run dev',
    cwd: join(here, '..'),
    url: baseURL,
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      VITE_SUPABASE_URL: supabaseUrl,
      VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
      VITE_API_PROXY_TARGET: process.env['VITE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3001',
    },
  },
});
