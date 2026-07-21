/**
 * The Kysely schema for QuoteIQ (T-008, A-8, M-12).
 *
 * `Database` is derived from `npm run db:types` output — it is never hand-written, so it cannot
 * describe a schema the database does not have. CI runs `npm run db:types -- --check`, which fails
 * when the committed generated files no longer match the migrated schema (AC-013).
 *
 * Views, functions and non-`public` schemas are intentionally not part of this type yet: nothing
 * consumes them, and the adapter can be extended when something does.
 */
import type { Kysely, Transaction } from 'kysely';

import type { KyselifyDatabase } from './kyselify.js';

export type Database = KyselifyDatabase;

/** A full database client. */
export type DbClient = Kysely<Database>;

/** An open transaction. */
export type DbTransaction = Transaction<Database>;

/**
 * Anything a query can run on. Repositories should accept THIS, not `DbClient`, so that the same
 * function works standalone and inside a `withTransaction` block without an overload.
 */
export type DbExecutor = DbClient | DbTransaction;

/** Table names in the Kysely schema. */
export type TableName = keyof Database;
