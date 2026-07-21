/**
 * Audit entry shape (T-013, AC-024, V-031; M-06, P-13, spec §11.4 / §15).
 *
 * Port of `src/api/QuoteIQ.Application/Abstractions/IAuditWriter.cs`
 * (`record AuditEntry(string EntityType, string EntityId, string Action, object? Details)`), with
 * the loose `object? Details` replaced by explicit `before`/`after` fields — see below.
 */

/** Any value that survives a round trip through `jsonb`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface AuditEntry {
  /** Domain entity name, e.g. `tenant`, `lead`, `role`. Matches the reference's EntityType. */
  readonly entityType: string;
  /** Entity primary key as text (the column is `text`, so bigints keep full precision). */
  readonly entityId: string;
  /** Dotted action name, e.g. `tenant.updated` — the reference's convention. */
  readonly action: string;
  /** Application `users.id`. Null for the background jobs, which set `actorLabel` instead. */
  readonly actorUserId: number | null;
  /** Human-readable actor for non-user actors, e.g. `system`. Null for ordinary callers. */
  readonly actorLabel?: string | null;
  /**
   * Tenant the audited change belongs to, or null for genuinely global actions (tenant lifecycle,
   * global template edits). `audit_log.tenant_id` is nullable precisely for these.
   */
  readonly tenantId: number | null;
  /** State before the change. `null` for creations. */
  readonly before?: JsonValue;
  /** State after the change. `null` for deletions. */
  readonly after?: JsonValue;
  /** Extra context merged into `details` alongside before/after (e.g. correlationId). */
  readonly context?: Readonly<Record<string, JsonValue>>;
}

/**
 * The `details` jsonb payload.
 *
 * CASING — A DELIBERATE, REPORTED DEVIATION FROM THE REFERENCE.
 * The .NET writer called `JsonSerializer.Serialize(entry.Details)` with no naming policy
 * (AuditWriter.cs:33), so handlers passing `new { Before = ..., After = ... }` produced PascalCase
 * keys — pinned by
 * `src/api/tests/QuoteIQ.Api.Tests/BusinessAssignments/BusinessAssignmentEndpointsTests.cs:135-136`
 * (`GetProperty("Before")`). This port uses lowercase `before`/`after` instead, because:
 *   1. T-003's migration comment (20260718001300_audit_log.sql:18-22) states the writer "writes
 *      {"before": ..., "after": ...} into details, and the shared audit assertion helper reads
 *      details->'before'/details->'after'" — that is the in-repo contract every later task builds on;
 *   2. `details` is not part of any preserved frontend API contract (there is no audit read endpoint
 *      in the §12 inventory), so nothing client-visible changes;
 *   3. the reference itself was inconsistent — its own writer unit test
 *      (AuditWriterTests.cs:29,41) used lowercase `before`/`after`.
 * The keys are ALWAYS both present (never omitted), so `details->'before'` is a total mapping
 * rather than a sometimes-null one.
 */
export interface AuditDetails {
  readonly before: JsonValue;
  readonly after: JsonValue;
  readonly [key: string]: JsonValue;
}
