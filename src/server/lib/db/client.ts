/**
 * Kysely client construction (T-008, A-8, M-09, N-03).
 *
 * Two entry points, and the difference between them is load-bearing:
 *
 *   getDb()          runtime request/job traffic, through SUPABASE_DATABASE_URL (Supavisor :6543,
 *                    transaction pooling). Cached per cold start so warm invocations reuse the
 *                    pool. Everything it does must be pooler-safe — see pool.ts.
 *
 *   createDirectDb() migrations, codegen and admin scripts, through SUPABASE_DIRECT_DATABASE_URL (:5432),
 *                    where a session exists. Never used by request handlers. Callers own the
 *                    returned handle and must `close()` it.
 *
 * Kysely's Postgres dialect issues `client.query(sql, params)` with no statement name, i.e. the
 * unnamed extended-query path, which is what makes it usable under transaction pooling at all.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { getConfig, type AppConfig } from '../config/index.js';
import { logger } from '../logging/index.js';
import { directPoolConfig, poolerPoolConfig } from './pool.js';
import type { Database, DbClient } from './types.js';

export interface DbHandle {
  readonly db: DbClient;
  /** Exposed for connection-safety assertions; business code should not touch it. */
  readonly pool: pg.Pool;
  /** The configured pool ceiling, so tests can assert the cap without reaching into pg. */
  readonly max: number;
  close(): Promise<void>;
}

function build(poolConfig: pg.PoolConfig): DbHandle {
  const pool = new pg.Pool(poolConfig);

  // An idle-client error (pooler restart, network blip) is emitted on the pool, and an unhandled
  // 'error' event would take the whole instance down. pg discards the broken client itself; the
  // only thing left to do is record it.
  pool.on('error', (error: Error) => {
    logger.error('Idle database client error', { error: error.message });
  });

  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

  return {
    db,
    pool,
    max: poolConfig.max ?? 0,
    // Destroying the Kysely instance ends the underlying pool; do not also call pool.end().
    close: () => db.destroy(),
  };
}

/**
 * Builds a client against an explicit connection string, using the pooler-safe settings.
 * Used by tests and by any caller that must not share the process-wide handle.
 */
export function createDb(options: { readonly connectionString: string }): DbHandle {
  return build(poolerPoolConfig(options.connectionString));
}

/**
 * Direct (non-pooled) connection for migrations, codegen and admin scripts (M-09).
 * The caller owns the handle and must close it; nothing caches this.
 */
export function createDirectDb(config: AppConfig = getConfig()): DbHandle {
  return build(directPoolConfig(config.database.directUrl));
}

let shared: DbHandle | null = null;

/**
 * The process-wide client for request and job handlers, over the transaction pooler.
 * Cached per cold start — it holds no request state, so sharing it is safe.
 */
export function getDb(config: AppConfig = getConfig()): DbClient {
  shared ??= createDb({ connectionString: config.database.url });
  return shared.db;
}

/** Closes the process-wide client. Test and script teardown only. */
export async function closeDb(): Promise<void> {
  const current = shared;
  shared = null;
  if (current !== null) await current.close();
}
