/**
 * Type-level adapter from the Supabase CLI's generated types to Kysely table interfaces
 * (T-008, M-12, AC-013).
 *
 * `supabase gen types typescript --local` emits, per table, a `{ Row, Insert, Update }` triple.
 * Kysely wants a single interface of `ColumnType<Select, Insert, Update>` columns. The two are the
 * same information in a different shape, so the whole bridge is types — there is no runtime code
 * in this file and nothing to keep in sync by hand.
 *
 * Three corrections are applied on the way through:
 *
 *  1. PARTITIONS ARE DROPPED. Every partitioned table in this schema carries a `<table>_default`
 *     partition, which the generator reports as an ordinary table. Rows must always be read and
 *     written through the partitioned parent so the tenant routing applies, so exposing the
 *     partitions in the Kysely schema would only offer a way to get that wrong.
 *
 *  2. `numeric` COLUMNS BECOME `string`. The generator maps them to `number`; node-postgres returns
 *     them as strings because `numeric` is arbitrary-precision. Trusting the generator here would
 *     mean every premium in the system is declared as a type it never actually has at runtime.
 *     The affected columns are themselves generated, from information_schema (column-overrides.ts).
 *
 *  3. OPTIONAL INSERT COLUMNS STAY OPTIONAL. The generator marks defaulted columns `?` in `Insert`
 *     and identity columns `?: never`; those flow through as `undefined` in the union, which is
 *     exactly how Kysely spells "optional on insert" / "not insertable".
 */
import type { ColumnType } from 'kysely';

import type { NumericColumns } from './generated/column-overrides.js';
import type { Database as SupabaseDatabase } from './generated/supabase-types.js';

type PublicTables = SupabaseDatabase['public']['Tables'];

/** Partition children (`leads_default`, ...) — reachable only through the parent. See note 1. */
export type PartitionTableName = Extract<keyof PublicTables, `${string}_default`>;

type BaseTables = Omit<PublicTables, PartitionTableName>;

/** Rewrites the declared type of a `numeric` column from `number` to `string`. See note 2. */
type ApplyNumericOverride<TTable, TColumn, TValue> = TTable extends keyof NumericColumns
  ? TColumn extends NumericColumns[TTable]
    ? Exclude<TValue, number> | string
    : TValue
  : TValue;

type SelectType<T extends keyof BaseTables, K extends keyof BaseTables[T]['Row']> =
  ApplyNumericOverride<T, K, BaseTables[T]['Row'][K]>;

type InsertType<T extends keyof BaseTables, K extends keyof BaseTables[T]['Row']> =
  K extends keyof BaseTables[T]['Insert']
    ? ApplyNumericOverride<T, K, BaseTables[T]['Insert'][K]>
    : never;

type UpdateType<T extends keyof BaseTables, K extends keyof BaseTables[T]['Row']> =
  K extends keyof BaseTables[T]['Update']
    ? ApplyNumericOverride<T, K, BaseTables[T]['Update'][K]>
    : never;

/** One generated table as a Kysely table interface. */
export type KyselifyTable<T extends keyof BaseTables> = {
  [K in keyof BaseTables[T]['Row']]: ColumnType<
    SelectType<T, K>,
    InsertType<T, K>,
    UpdateType<T, K>
  >;
};

/** The Kysely schema for the `public` schema, derived entirely from the generated types. */
export type KyselifyDatabase = {
  [T in keyof BaseTables]: KyselifyTable<T>;
};
