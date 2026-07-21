/**
 * The global `default_reference_items` template (T-016, AC-026; P-04, spec §11.2).
 *
 * Port of `src/api/QuoteIQ.Application/Abstractions/IDefaultReferenceItemStore.cs` and its EF
 * implementation. The table is GLOBAL and unpartitioned (20260718002100_default_reference_items.sql),
 * so the raw executor is correct here — there is no tenant to scope to.
 */
import { sql } from 'kysely';

import type { DbExecutor } from '../../lib/db/index.js';

export interface DefaultReferenceItemRecord {
  readonly id: number;
  readonly listType: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly isBrokerChannel: boolean | null;
  readonly defaultProductLineKey: string | null;
  readonly reportingCategory: string | null;
  readonly canonicalKey: string | null;
  readonly isTerminal: boolean;
}

const TEMPLATE_COLUMNS = [
  'id',
  'list_type',
  'name',
  'display_order',
  'is_active',
  'is_broker_channel',
  'default_product_line_key',
  'reporting_category',
  'canonical_key',
  'is_terminal',
] as const;

interface TemplateRow {
  readonly id: number;
  readonly list_type: string;
  readonly name: string;
  readonly display_order: number;
  readonly is_active: boolean;
  readonly is_broker_channel: boolean | null;
  readonly default_product_line_key: string | null;
  readonly reporting_category: string | null;
  readonly canonical_key: string | null;
  readonly is_terminal: boolean;
}

function toRecord(row: TemplateRow): DefaultReferenceItemRecord {
  return {
    id: Number(row.id),
    listType: row.list_type,
    name: row.name,
    displayOrder: row.display_order,
    isActive: row.is_active,
    isBrokerChannel: row.is_broker_channel,
    defaultProductLineKey: row.default_product_line_key,
    reportingCategory: row.reporting_category,
    canonicalKey: row.canonical_key,
    isTerminal: row.is_terminal,
  };
}

/** `IDefaultReferenceItemStore.ListAllAsync`. Ordered so the wire output is deterministic. */
export async function listDefaultReferenceItems(
  executor: DbExecutor,
): Promise<DefaultReferenceItemRecord[]> {
  const rows = await executor
    .selectFrom('default_reference_items')
    .select(TEMPLATE_COLUMNS)
    .orderBy('list_type')
    .orderBy('display_order')
    .orderBy('id')
    .execute();

  return rows.map(toRecord);
}

export interface DefaultReferenceItemInput {
  readonly listType: string;
  readonly name: string;
  readonly displayOrder: number;
  readonly isActive: boolean;
  readonly isBrokerChannel: boolean | null;
  readonly defaultProductLineKey: string | null;
  readonly reportingCategory: string | null;
  readonly canonicalKey: string | null;
  readonly isTerminal: boolean;
}

/**
 * `IDefaultReferenceItemStore.ReplaceAllAsync`: the whole template is replaced at once, inside one
 * transaction supplied by the caller. Existing tenants are untouched — only future tenant creation
 * reads this table (ReplaceDefaultReferenceItemsCommand.cs:23-26).
 */
export async function replaceDefaultReferenceItems(
  executor: DbExecutor,
  items: readonly DefaultReferenceItemInput[],
): Promise<void> {
  await sql`delete from default_reference_items`.execute(executor);

  if (items.length === 0) return;

  const now = new Date().toISOString();
  await executor
    .insertInto('default_reference_items')
    .values(
      items.map((item) => ({
        list_type: item.listType,
        name: item.name,
        display_order: item.displayOrder,
        is_active: item.isActive,
        is_broker_channel: item.isBrokerChannel,
        default_product_line_key: item.defaultProductLineKey,
        reporting_category: item.reportingCategory,
        canonical_key: item.canonicalKey,
        is_terminal: item.isTerminal,
        created_at: now,
        updated_at: now,
      })),
    )
    .execute();
}
