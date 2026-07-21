// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with `npm run db:types` (scripts/db/generate-types.ts).
// CI runs `npm run db:types -- --check`, which fails if this file is stale (AC-013).

/**
 * Every `public` table with a `tenant_id` column, from information_schema.
 *
 * src/server/lib/db/tenant.ts type-checks this list against the generated Kysely schema, so
 * the two generated artifacts cannot drift apart without failing the build.
 */
export const TENANT_SCOPED_TABLE_NAMES = [
  'alerts',
  'api_credentials',
  'audit_log',
  'broker_contacts',
  'brokers',
  'business_assignments',
  'follow_ups',
  'job_idempotency_key',
  'lead_assignments',
  'lead_notes',
  'lead_status_history',
  'leads',
  'parties',
  'pricing_approvals',
  'quote_assignments',
  'quote_attachments',
  'quote_status_history',
  'quote_versions',
  'quotes',
  'reference_items',
  'reference_sequences',
  'roles',
  'tenant_settings',
  'user_alert_views',
  'user_groups',
  'user_permissions',
  'user_roles',
  'user_tenants',
] as const;
