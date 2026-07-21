/**
 * Tenant-scoped `api_credentials` persistence (T-022, AC-022, AC-040).
 *
 * Port of `src/api/QuoteIQ.Infrastructure/ApiAccess/ApiCredentialStore.cs`.
 *
 * EVERY ADMIN QUERY IS TENANT-PREDICATED, AND THERE IS NO DATABASE NET UNDERNEATH
 * ==============================================================================
 * Postgres RLS is NOT adopted (spec Q-10), so a forgotten predicate here is an unguarded
 * cross-tenant read with nothing beneath it. Every admin function therefore goes through
 * `forTenant(executor, tenantId)`, whose builders apply the table-qualified predicate themselves
 * and whose `insertInto` INJECTS `tenant_id` so a row cannot be written into another tenant.
 *
 * `findCredentialByKeyId` IS THE ONE DELIBERATE CROSS-PARTITION READ
 * =================================================================
 * It runs BEFORE any tenant context exists: intake resolves a presented key's `key_id` to its
 * credential row precisely in order to LEARN the tenant (P-06 — the tenant is never taken from the
 * caller). The reference marks the same function as its single `IgnoreQueryFilters` exception
 * (IApiCredentialStore.cs:23-29). Two properties keep it safe:
 *   1. `key_id` is generated with 128 bits of entropy, so it is globally unique by construction and
 *      the lookup returns at most one row. The enforced database constraint can only be
 *      `(tenant_id, key_id)` — a LIST-partitioned parent cannot carry a unique index omitting the
 *      partition key — so `ix_api_credentials_key_id` supports this lookup and the function still
 *      asserts singularity rather than assuming it.
 *   2. It returns the credential's OWN `tenant_id`. Nothing about the caller influences which row
 *      is found, so there is no cross-tenant read to authorize — the row IS the authorization.
 * It returns the hash and salt, which is the only place in this file that happens; nothing may
 * expose that shape beyond `service.verifyApiKey`.
 *
 * CREDENTIALS ARE NEVER DELETED (N-09, AC-075). There is no delete in this file: `disableCredential`
 * flips the status so leads already ingested through a retired credential stay attributable.
 */
import { forTenant, toTenantId, type DbExecutor, type TenantId } from '../../lib/db/index.js';
import type { ApiCredentialDto } from './schemas.js';

const CREDENTIAL_COLUMNS = [
  'id',
  'broker_id',
  'key_id',
  'status',
  'created_at',
  'last_rotated_at',
  'disabled_at',
] as const;

interface CredentialRow {
  readonly id: number;
  readonly broker_id: number | null;
  readonly key_id: string;
  readonly status: string;
  readonly created_at: Date | string;
  readonly last_rotated_at: Date | string | null;
  readonly disabled_at: Date | string | null;
}

/** `bigint` arrives as a string from node-postgres on some paths; identity ids are safe integers. */
function toNumber(value: number | string): number {
  return Number(value);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoStringOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIsoString(value);
}

/** `ApiCredentialDto.FromEntity` (ApiAccessDtos.cs:22-29). Carries no secret, hash or salt. */
function toDto(row: CredentialRow): ApiCredentialDto {
  return {
    id: toNumber(row.id),
    brokerId: row.broker_id === null ? null : toNumber(row.broker_id),
    clientId: row.key_id,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    lastRotatedAt: toIsoStringOrNull(row.last_rotated_at),
    disabledAt: toIsoStringOrNull(row.disabled_at),
  };
}

/** `ApiCredentialStore.ListAsync` (:29-42). Ordered by id, so the admin list is stable. */
export async function listCredentials(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number | undefined,
): Promise<ApiCredentialDto[]> {
  let query = forTenant(executor, tenantId)
    .selectFrom('api_credentials')
    .select(CREDENTIAL_COLUMNS);

  if (brokerId !== undefined) {
    query = query.where('broker_id', '=', brokerId);
  }

  const rows = await query.orderBy('id').execute();
  return rows.map(toDto);
}

/** `ApiCredentialStore.FindAsync` (:44-48). Another tenant's id resolves to `undefined` -> 404. */
export async function findCredential(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<ApiCredentialDto | undefined> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('api_credentials')
    .select(CREDENTIAL_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();

  return row === undefined ? undefined : toDto(row);
}

/**
 * `FindTenantCredentialAsync` / `FindBrokerCredentialAsync` (:50-64), collapsed into one function
 * because they differ only in the predicate.
 *
 * NOTE THE ABSENT STATUS FILTER — it is the reference's, and it is what makes a disabled credential
 * still occupy its scope. See errors.ts for why that is preserved and flagged rather than fixed.
 */
export async function findCredentialForScope(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number | null,
): Promise<ApiCredentialDto | undefined> {
  const scoped = forTenant(executor, tenantId)
    .selectFrom('api_credentials')
    .select(CREDENTIAL_COLUMNS);

  const row = await (brokerId === null
    ? scoped.where('broker_id', 'is', null)
    : scoped.where('broker_id', '=', brokerId)
  ).executeTakeFirst();

  return row === undefined ? undefined : toDto(row);
}

/** The verification material for one credential. Never leaves `service.verifyApiKey`. */
export interface CredentialVerificationRow {
  readonly id: number;
  readonly tenantId: TenantId;
  readonly brokerId: number | null;
  readonly keyHash: string;
  readonly keySalt: string;
  readonly status: string;
}

/**
 * `FindByClientIdAsync` (:66-73) — the deliberate cross-partition read. See the header.
 *
 * Uses the raw executor rather than `forTenant` BY DESIGN, and is the only function in this file
 * that does: there is no tenant to scope to yet, because finding this row is how the tenant is
 * determined. It is not reachable from any admin route.
 */
export async function findCredentialByKeyId(
  executor: DbExecutor,
  keyId: string,
): Promise<CredentialVerificationRow | undefined> {
  const rows = await executor
    .selectFrom('api_credentials')
    .select(['id', 'tenant_id', 'broker_id', 'key_hash', 'key_salt', 'status'])
    .where('key_id', '=', keyId)
    .limit(2)
    .execute();

  // 128 bits of entropy makes a collision impossible in practice; two rows would mean key ids are
  // being generated non-randomly, and authenticating against an arbitrary one of them would be
  // worse than refusing.
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (row === undefined) return undefined;

  return {
    id: toNumber(row.id),
    tenantId: toTenantId(toNumber(row.tenant_id)),
    brokerId: row.broker_id === null ? null : toNumber(row.broker_id),
    keyHash: row.key_hash,
    keySalt: row.key_salt,
    status: row.status,
  };
}

export interface InsertCredentialInput {
  readonly brokerId: number | null;
  readonly keyId: string;
  readonly keyHash: string;
  readonly keySalt: string;
  readonly name: string;
  readonly actorUserId: number;
}

/** `ApiCredentialStore.AddAsync` (:75-80). `tenant_id` is injected by the scope, not by the caller. */
export async function insertCredential(
  executor: DbExecutor,
  tenantId: TenantId,
  input: InsertCredentialInput,
): Promise<ApiCredentialDto> {
  const row = await forTenant(executor, tenantId)
    .insertInto('api_credentials', {
      broker_id: input.brokerId,
      key_id: input.keyId,
      key_hash: input.keyHash,
      key_salt: input.keySalt,
      name: input.name,
      status: 'active',
      created_at: new Date().toISOString(),
      created_by: input.actorUserId,
    })
    .returning(CREDENTIAL_COLUMNS)
    .executeTakeFirstOrThrow();

  return toDto(row as unknown as CredentialRow);
}

export interface RotateCredentialInput {
  readonly keyId: string;
  readonly keyHash: string;
  readonly keySalt: string;
}

/**
 * Rotation, as ONE statement.
 *
 * `key_id`, `key_hash` and `key_salt` move together or not at all: a partial write would leave a
 * row whose stored hash cannot verify the key just handed to the caller, locking the integration
 * out with no way back. The single UPDATE (inside the service's transaction, alongside the audit
 * row) is what makes "atomically swaps hash and rotation metadata" true rather than aspirational.
 */
export async function rotateCredential(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
  input: RotateCredentialInput,
): Promise<ApiCredentialDto> {
  const row = await forTenant(executor, tenantId)
    .updateTable('api_credentials')
    .set({
      key_id: input.keyId,
      key_hash: input.keyHash,
      key_salt: input.keySalt,
      last_rotated_at: new Date().toISOString(),
    })
    .where('id', '=', id)
    .returning(CREDENTIAL_COLUMNS)
    .executeTakeFirstOrThrow();

  return toDto(row as unknown as CredentialRow);
}

/** Disable. The hash is deliberately left in place — status alone fails verification. */
export async function disableCredential(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<ApiCredentialDto> {
  const row = await forTenant(executor, tenantId)
    .updateTable('api_credentials')
    .set({ status: 'disabled', disabled_at: new Date().toISOString() })
    .where('id', '=', id)
    .returning(CREDENTIAL_COLUMNS)
    .executeTakeFirstOrThrow();

  return toDto(row as unknown as CredentialRow);
}

/**
 * Records a successful verification for the admin UI's "dormant credential" view.
 *
 * NEVER part of an authorization decision (20260718002400_api_credentials.sql, `last_used_at`), and
 * deliberately fire-and-forget at the call site: a failed usage stamp must not fail an otherwise
 * valid intake request. Scoped by the credential's OWN tenant id, which came from the row itself.
 */
export async function touchCredentialLastUsed(
  executor: DbExecutor,
  tenantId: TenantId,
  id: number,
): Promise<void> {
  await forTenant(executor, tenantId)
    .updateTable('api_credentials')
    .set({ last_used_at: new Date().toISOString() })
    .where('id', '=', id)
    .execute();
}

/**
 * Is this an ACTIVE broker in this tenant? (`IBrokerStore.FindAsync` + the
 * `is not { Status: BrokerStatus.Active }` guard, ProvisionCredentialCommandHandler.cs:47-50.)
 *
 * Lives here rather than reaching into the brokers domain's repository: this is a one-column
 * existence check, and a cross-domain repository import would be a far heavier coupling than the
 * predicate is worth.
 */
export async function isActiveBroker(
  executor: DbExecutor,
  tenantId: TenantId,
  brokerId: number,
): Promise<boolean> {
  const row = await forTenant(executor, tenantId)
    .selectFrom('brokers')
    .select('id')
    .where('id', '=', brokerId)
    .where('status', '=', 'active')
    .executeTakeFirst();

  return row !== undefined;
}
