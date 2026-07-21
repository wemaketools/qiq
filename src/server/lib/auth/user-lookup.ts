/**
 * Resolves the application user behind a verified Supabase identity (T-011, spec §13).
 *
 * Port of the .NET `IUserResolver.ResolveAsync(keycloakSubjectId)` used by
 * `RequirePermissionFilter`: one lookup on the unique external-identity column, returning the
 * user's id and active flag. `users.auth_user_id` replaces `users.keycloak_id` one-for-one
 * (migration 20260718001100).
 *
 * The lookup is expressed as a narrow function type (`AppUserLookup`) and injected into the
 * middleware. That is a genuine seam, not speculative abstraction: the tests need to drive the
 * deactivated/unknown-user cases without touching production wiring.
 *
 * T-008 UPDATE: this module originally created its own small `pg.Pool` because the shared data
 * layer did not exist yet. It now goes through `src/server/lib/db`, so there is ONE place that
 * decides pool size, transaction-pooler safety and type parsing (see lib/db/pool.ts). The public
 * shape of this module is unchanged.
 */
import { createDb, type DbHandle } from '../db/index.js';

import type { AppConfig } from '../config/index.js';

export interface AppUserRecord {
  /** `users.id` (bigint) as a string. */
  readonly id: string;
  readonly authUserId: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly isActive: boolean;
}

/** Returns the application user for a verified `sub`, or null when no row exists. */
export type AppUserLookup = (authUserId: string) => Promise<AppUserRecord | null>;

export interface PgAppUserLookup {
  readonly lookup: AppUserLookup;
  close(): Promise<void>;
}

export function createPgAppUserLookup(config: AppConfig): PgAppUserLookup {
  const handle: DbHandle = createDb({ connectionString: config.database.url });

  return {
    lookup: async (authUserId) => {
      const row = await handle.db
        .selectFrom('users')
        .select(['id', 'auth_user_id', 'email', 'first_name', 'last_name', 'is_active'])
        .where('auth_user_id', '=', authUserId)
        .limit(1)
        .executeTakeFirst();

      if (row === undefined) return null;

      return {
        // `users.id` is bigint; the pool parses it to a number (lib/db/pool.ts). `AppUserRecord.id`
        // stays a string so ids are never accidentally used in arithmetic downstream.
        id: String(row.id),
        authUserId: row.auth_user_id,
        email: row.email,
        firstName: row.first_name,
        lastName: row.last_name,
        isActive: row.is_active,
      };
    },
    close: () => handle.close(),
  };
}

let sharedLookup: PgAppUserLookup | null = null;

/**
 * Process-wide lookup for the composition roots. Cached per cold start so warm invocations reuse
 * the pool; holds no request state.
 */
export function getAppUserLookup(config: AppConfig): AppUserLookup {
  sharedLookup ??= createPgAppUserLookup(config);
  return sharedLookup.lookup;
}

/** Test-only. */
export async function closeSharedAppUserLookup(): Promise<void> {
  const current = sharedLookup;
  sharedLookup = null;
  if (current !== null) await current.close();
}
