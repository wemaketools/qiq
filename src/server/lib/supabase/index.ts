/**
 * Server-only Supabase surface (T-011, AC-017).
 *
 * SERVER ONLY — never import from `src/ui`. The SPA builds its own client from
 * VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (T-018); the service-role key lives here and nowhere
 * else.
 */
export {
  getAdminClient,
  getVerificationClient,
  resetSupabaseClientCache,
} from './clients.js';
export {
  getJwksCache,
  JwksCache,
  JwksFetchError,
  resetJwksCaches,
  type JwksCacheOptions,
  type JwksDocument,
  type JwksKeySource,
} from './jwks.js';
