/**
 * pg connection-pool configuration for the Kysely data layer (T-008, A-8, M-09, N-03, R-3).
 *
 * CONNECTION SAFETY — WHY THIS FILE LOOKS THE WAY IT DOES
 * =======================================================
 * Runtime traffic goes through Supabase's Supavisor pooler in TRANSACTION mode (`SUPABASE_DATABASE_URL`,
 * port 6543). Transaction pooling assigns a server backend for the duration of a TRANSACTION, not
 * a connection, and hands it to someone else afterwards. Three consequences drive everything here:
 *
 *   1. THE CLIENT-SIDE POOL MUST BE TINY. Vercel runs many short-lived instances concurrently;
 *      each one holding a "modest" pool of 10 is how a pooler's client-connection limit gets
 *      exhausted by traffic a single database could otherwise serve. Supavisor does the real
 *      pooling, so `max` here only needs to cover the concurrency of ONE invocation: 2.
 *
 *   2. NO NAMED PREPARED STATEMENTS. A named statement is prepared on one backend; the next
 *      statement may run on a different one, producing `prepared statement "xyz" does not exist`.
 *      Kysely's PostgresDialect calls `client.query(sql, params)` with no `name`, so node-postgres
 *      uses the UNNAMED extended-query path — safe. Nothing in this codebase may pass a `name`, and
 *      src/server/tests/integration/db-pool.test.ts asserts `pg_prepared_statements` stays empty so
 *      that a future change to that behaviour fails loudly instead of in production.
 *
 *   3. NO SESSION STATE. No LISTEN/NOTIFY, no session-level advisory locks (`pg_advisory_lock`),
 *      no bare `SET` expected to persist, no temp tables spanning statements. The transaction-
 *      scoped equivalents are fine and are what this codebase uses: `SET LOCAL` (the seam T-014
 *      wires RLS context through), `pg_advisory_xact_lock()`, and `SELECT ... FOR UPDATE` inside
 *      one transaction (the reference-sequence pattern, R-3). This is enforced by a source scan in
 *      src/server/tests/integration/db-session-safety.test.ts.
 *
 * ALSO DELIBERATE:
 *   - No `options` startup parameter. Supavisor may reject or ignore per-connection startup
 *     options, and anything set that way is session state by definition (see 3).
 *   - Query cancellation via AbortSignal is NOT used. Kysely implements it as
 *     `pg_cancel_backend(pid)` issued over a second connection; under transaction pooling that pid
 *     may by then belong to another client's transaction, so cancelling is actively unsafe.
 *
 * Migrations and admin scripts use `directPoolConfig` against `SUPABASE_DIRECT_DATABASE_URL` (port 5432),
 * where a real session exists and none of the above applies.
 */
import pg from 'pg';

/** Per-instance client-side pool ceiling. Supavisor does the real pooling (V-015 asserts <= 2). */
export const MAX_POOLED_CONNECTIONS = 2;

/** A pooled connection is worthless to a frozen serverless instance; give the slot back quickly. */
const IDLE_TIMEOUT_MS = 10_000;

/** A saturated pooler must surface as an error inside the function's lifetime, not as a hang. */
const CONNECTION_TIMEOUT_MS = 10_000;

/** Postgres OID for `int8` / `bigint`. */
const INT8_OID = 20;

/**
 * Parses `bigint` into a JS number, throwing rather than losing precision.
 *
 * node-postgres returns int8 as a STRING by default because int8 exceeds the range of an IEEE-754
 * double. The Supabase type generator, however, declares every bigint column as `number`. Rather
 * than let the declared type lie about the runtime value, the pool installs this parser so the two
 * agree — and refuses the one case where they could not: a value above 2^53, where `Number()`
 * would silently return a DIFFERENT id. Every bigint in this schema is an identity sequence, so
 * that ceiling is unreachable in practice; if it is ever reached, an exception is the only honest
 * outcome.
 */
export function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`Cannot parse bigint value ${JSON.stringify(value)} as an integer.`);
  }
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(
      `bigint value ${value} exceeds Number.MAX_SAFE_INTEGER; converting it would lose precision. ` +
        'Widen the column mapping to string before storing values this large.',
    );
  }
  return parsed;
}

/**
 * `numeric` is deliberately NOT overridden here: node-postgres returns it as a string, which is
 * what money requires. `npm run db:types` records those columns in generated/column-overrides.ts
 * so the TypeScript declaration says `string` too.
 */
const customTypes: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: string) => {
    if (oid === INT8_OID && format !== 'binary') return parseInt8;
    return pg.types.getTypeParser(oid, format as never);
  }) as pg.CustomTypesConfig['getTypeParser'],
};

/** Pool configuration for runtime traffic through the Supavisor transaction pooler. */
export function poolerPoolConfig(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    max: MAX_POOLED_CONNECTIONS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    // Let the Node process exit when the pool goes idle instead of holding a Supavisor slot open.
    allowExitOnIdle: true,
    types: customTypes,
  };
}

/**
 * Pool configuration for migrations, codegen and admin scripts on the DIRECT connection.
 * Single-connection: these are sequential tools, and a direct connection is the scarce resource.
 */
export function directPoolConfig(connectionString: string): pg.PoolConfig {
  return {
    connectionString,
    max: 1,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    allowExitOnIdle: true,
    types: customTypes,
  };
}
