import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

/**
 * Auth helpers for the migrated Vite/Hono/Supabase stack (T-043). The old Keycloak
 * authorization-code page objects are gone; there are now two legitimate login surfaces (Q-21):
 *
 *   1. {@link loginAs} — a REAL sign-in through the SPA's `/sign-in` email/password form against
 *      local Supabase Auth (GoTrue). Used by the login/logout specs that must exercise the real
 *      login surface, and available to any spec that wants the genuine form round trip.
 *   2. {@link loginAsPersonaSession} — an ADMIN-MINTED session: the persona is signed in
 *      server-side via supabase-js, and the resulting session is injected into the browser's
 *      localStorage before the SPA boots (no per-test form typing). Faster, used for the bulk of
 *      specs via `helpers/personas.ts`.
 *
 * Both are valid per Q-21. The shared demo password is the LOCAL/E2E-only value the T-041 demo seed
 * sets on every persona (scripts/db/demo-data/catalog.ts `DEMO_PASSWORD`).
 */
export const E2E_PASSWORD = 'test1234';

// ---------------------------------------------------------------------------------------------
// Local Supabase config resolution (URL + anon key), shared by the session-minting path.
// ---------------------------------------------------------------------------------------------

interface SupabaseConfig {
  url: string;
  anonKey: string;
}

/** Minimal `.env.local` parser — used only when the value is not already on `process.env`. */
function readEnvLocal(): Record<string, string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const envPath = join(here, '..', '..', '.env.local');
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(envPath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch {
    // No .env.local — rely entirely on process.env below.
  }
  return out;
}

let cachedConfig: SupabaseConfig | null = null;

function supabaseConfig(): SupabaseConfig {
  if (cachedConfig) return cachedConfig;
  const env = readEnvLocal();
  const url =
    process.env['E2E_SUPABASE_URL'] ??
    process.env['VITE_SUPABASE_URL'] ??
    process.env['SUPABASE_URL'] ??
    env['VITE_SUPABASE_URL'] ??
    env['SUPABASE_URL'] ??
    'http://127.0.0.1:54321';
  const anonKey =
    process.env['E2E_SUPABASE_ANON_KEY'] ??
    process.env['VITE_SUPABASE_ANON_KEY'] ??
    process.env['SUPABASE_ANON_KEY'] ??
    env['VITE_SUPABASE_ANON_KEY'] ??
    env['SUPABASE_ANON_KEY'] ??
    '';
  if (anonKey === '') {
    throw new Error(
      'No Supabase anon key available for e2e login. Set VITE_SUPABASE_ANON_KEY (or SUPABASE_ANON_KEY) ' +
        'in .env.local from `npx supabase status`.',
    );
  }
  cachedConfig = { url, anonKey };
  return cachedConfig;
}

/** supabase-js's default localStorage key: `sb-<first-hostname-label>-auth-token`. */
function storageKeyFor(url: string): string {
  return `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
}

// ---------------------------------------------------------------------------------------------
// Real SPA form login.
// ---------------------------------------------------------------------------------------------

/**
 * Signs in through the real SPA `/sign-in` form against local Supabase Auth and waits for the
 * authenticated shell. This is the genuine login surface (P-01): the same form a user sees.
 */
export async function loginAs(page: Page, email: string, password: string = E2E_PASSWORD): Promise<void> {
  await page.goto('/sign-in');
  await page.getByTestId('sign-in-page').waitFor({ state: 'visible' });
  await page.locator('#sign-in-email').fill(email);
  await page.locator('#sign-in-password').fill(password);
  await page.getByTestId('sign-in-submit').click();
  // On success the SPA leaves /sign-in for the resolved landing page and renders the shell.
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20000 });
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20000 });
}

// ---------------------------------------------------------------------------------------------
// Admin-minted session injection.
// ---------------------------------------------------------------------------------------------

/** Per-worker cache of the serialized supabase-js session JSON, keyed by email. */
const sessionCache = new Map<string, string>();

/**
 * Mints a Supabase Auth session for a persona server-side and returns the exact `(storageKey,
 * value)` pair the SPA's supabase-js client persists — so injecting `value` at `storageKey` in
 * localStorage yields a fully authenticated browser without a form round trip. The value is
 * `JSON.stringify(session)`, which is precisely what auth-js writes and reads back.
 */
async function mintSession(email: string): Promise<{ key: string; value: string }> {
  const { url, anonKey } = supabaseConfig();
  const key = storageKeyFor(url);
  const cached = sessionCache.get(email);
  if (cached) return { key, value: cached };

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: E2E_PASSWORD });
  if (error || !data.session) {
    throw new Error(`Failed to mint a session for ${email}: ${error?.message ?? 'no session returned'}`);
  }
  const value = JSON.stringify(data.session);
  sessionCache.set(email, value);
  return { key, value };
}

/**
 * Injects an admin-minted session for `email` into the browser context and lands on the
 * authenticated shell. `addInitScript` seeds localStorage before every navigation in the context,
 * so subsequent `page.goto(...)` calls in the same test stay authenticated.
 */
export async function loginAsPersonaSession(page: Page, email: string): Promise<void> {
  const { key, value } = await mintSession(email);
  await page.context().addInitScript(
    ([k, v]) => {
      window.localStorage.setItem(k, v);
    },
    [key, value] as const,
  );
  await page.goto('/');
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 20000 });
}

// ---------------------------------------------------------------------------------------------
// Admin password set (service-role) — the migrated replacement for the retired Keycloak admin
// reset. Used by user-manager.spec.ts to give a UI-created user a known password so the
// "deactivated user cannot sign in" leg can attempt a real login as that exact user.
// ---------------------------------------------------------------------------------------------

/** Resolves the local service-role key (server-only; local .env.local value, never a production secret). */
function serviceRoleKey(): string {
  const env = readEnvLocal();
  const key =
    process.env['E2E_SUPABASE_SERVICE_ROLE_KEY'] ??
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
    env['SUPABASE_SERVICE_ROLE_KEY'] ??
    '';
  if (key === '') {
    throw new Error(
      'No Supabase service-role key available for the e2e admin password set. Set ' +
        'SUPABASE_SERVICE_ROLE_KEY in .env.local from `npx supabase status`.',
    );
  }
  return key;
}

/**
 * Sets a known password on the Supabase Auth identity for `email` via the Admin API. The identity is
 * provisioned by the User Manager create-user flow (`auth.admin.createUser`, src/server/domains/
 * users/auth-admin.ts) with a random password; this resets it so a subsequent real sign-in can be
 * attempted as that user.
 */
export async function setUserPasswordByEmail(email: string, password: string): Promise<void> {
  const { url } = supabaseConfig();
  const admin = createClient(url, serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const target = email.toLowerCase();
  let userId: string | undefined;
  for (let pageNo = 1; pageNo <= 25 && userId === undefined; pageNo++) {
    const { data, error } = await admin.auth.admin.listUsers({ page: pageNo, perPage: 200 });
    if (error) {
      throw new Error(`Admin listUsers failed while locating ${email}: ${error.message}`);
    }
    userId = data.users.find((u) => u.email?.toLowerCase() === target)?.id;
    if (data.users.length < 200) break;
  }
  if (userId === undefined) {
    throw new Error(`No Supabase Auth identity found for ${email}`);
  }
  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) {
    throw new Error(`Admin updateUserById(password) failed for ${email}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Forbidden-deep-link assertion.
// ---------------------------------------------------------------------------------------------

/**
 * Navigates to a deep link the caller is expected to be forbidden from and asserts the
 * `forbidden-page` renders. Under the migrated stack the session lives in localStorage
 * (supabase-js `persistSession`), so a full reload restores it in-process — there is no OIDC
 * callback round trip to wait out. A small bounded retry covers ordinary transient slowness.
 */
export async function gotoAndExpectForbidden(page: Page, path: string, timeout = 15000): Promise<void> {
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await page.goto(path);
    try {
      await expect(page.getByTestId('forbidden-page')).toBeVisible({ timeout });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
