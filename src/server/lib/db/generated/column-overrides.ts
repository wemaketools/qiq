// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with `npm run db:types` (scripts/db/generate-types.ts).
// CI runs `npm run db:types -- --check`, which fails if this file is stale (AC-013).

/**
 * Columns whose runtime JavaScript type differs from the Supabase CLI declaration.
 *
 * Every column listed here is Postgres `numeric`. node-postgres returns `numeric` as a STRING
 * because it is arbitrary-precision — parsing premiums into IEEE-754 doubles would silently
 * corrupt money. The CLI declares them `number`, so kyselify.ts rewrites them to `string`.
 *
 * Generated from information_schema, so a numeric column added by a later migration is picked
 * up automatically by `npm run db:types`.
 */
export interface NumericColumns {
  readonly alerts: 'premium_at_risk';
  readonly leads: 'competitor_premium' | 'estimated_premium' | 'sum_insured';
  readonly pricing_approvals: 'proposed_premium';
  readonly quote_versions: 'quoted_premium';
  readonly quotes: 'bound_premium' | 'competitor_premium';
  readonly tenant_settings: 'high_value_threshold';
}
