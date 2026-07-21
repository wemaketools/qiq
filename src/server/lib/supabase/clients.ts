/**
 * Server-only Supabase client factories (T-011, AC-017, spec §13/§16, A-4).
 *
 * SERVER ONLY. This module reads the service-role key out of the typed config and must never be
 * imported from `src/ui` — an import-boundary test
 * (src/server/tests/integration/supabase-server-only.test.ts) proves the SPA cannot reach it, and
 * the built-bundle scan (V-003) covers the emitted assets.
 *
 * Two clients, two jobs:
 *
 * - the *verification* client (anon key) is used exclusively for `auth.getClaims()`. It carries no
 *   privilege; the anon key is simply the credential GoTrue expects on the request. With the JWKS
 *   supplied by the caller (see ./jwks.ts) `getClaims()` performs pure local WebCrypto.
 * - the *admin* client (service-role key) reaches the Auth Admin API for user provisioning
 *   (T-017) and for the integration-test session helper (Q-21).
 *
 * Both are memoized per (url, key) for the lifetime of the process. That is a cold-start cache,
 * not business state: no request-derived value is ever stored on them, so a recycled Vercel
 * instance cannot leak one caller's context into another's. Memoization matters because
 * GoTrueClient keys its JWKS cache by storage key, so a fresh client per request would defeat it.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getConfig, type AppConfig } from '../config/index.js';

/**
 * Never persist or refresh a session on the server: these clients act on behalf of no one. A
 * server-side session store is also a cross-request leak in a warm serverless instance.
 */
const SERVER_CLIENT_OPTIONS = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
} as const;

const clientCache = new Map<string, SupabaseClient>();

function memoizedClient(url: string, key: string, cacheKey: string): SupabaseClient {
  const existing = clientCache.get(cacheKey);
  if (existing !== undefined) return existing;

  const created = createClient(url, key, SERVER_CLIENT_OPTIONS);
  clientCache.set(cacheKey, created);
  return created;
}

/**
 * Client used to verify inbound access tokens. Anon-key only — if this module ever needs the
 * service-role key to verify a token, something has gone badly wrong.
 */
export function getVerificationClient(config: AppConfig = getConfig()): SupabaseClient {
  return memoizedClient(
    config.supabase.url,
    config.supabase.anonKey,
    `verify:${config.supabase.url}`,
  );
}

/**
 * Supabase Auth Admin client (service-role). Every caller of this function must already have
 * performed its own authorization check: this client bypasses RLS and every Auth restriction.
 */
export function getAdminClient(config: AppConfig = getConfig()): SupabaseClient {
  return memoizedClient(
    config.supabase.url,
    config.supabase.serviceRoleKey,
    `admin:${config.supabase.url}`,
  );
}

/** Test-only: drops the memoized clients so a test can swap configuration. */
export function resetSupabaseClientCache(): void {
  clientCache.clear();
}
