/**
 * API-credential lifecycle and key verification (T-022, AC-022, AC-024, AC-040).
 *
 * Ports the five handlers under `src/api/QuoteIQ.Application/Features/ApiAccess/` onto the approved
 * Q-19 reshape: GetApiCredentials, ProvisionCredential, RegenerateSecret, DisableCredential, and
 * RevealSecret — the last of which has no successor and is answered by an explicit 410 in
 * routes.ts rather than reimplemented.
 *
 * WHAT REPLACED KEYCLOAK, AND WHAT DID NOT CHANGE
 * ==============================================
 * The reference called out to a Keycloak admin service to create a confidential client, rotate its
 * secret, and disable it, storing only a client-id reference. Keycloak is gone (A-4) and Supabase
 * Auth deliberately does not issue machine-to-machine credentials, so QuoteIQ issues its own keys
 * (Q-19). The BEHAVIOUR carried over intact — one credential per scope, reveal-once issuance,
 * regenerate, disable, audit, unspoofable broker — and the network call became a `randomBytes` plus
 * an HMAC. That is strictly stronger for the two properties that matter here: issuing a key is now
 * atomic with its database row (the reference could create a Keycloak client and then fail to
 * insert the row, orphaning it), and there is no third party holding a retrievable secret.
 *
 * EVERY MUTATION AND ITS AUDIT ROW SHARE ONE TRANSACTION (AC-024, V-031)
 * =====================================================================
 * The reference wrote its audit row through a separate `IAuditWriter` call AFTER the store call, so
 * a crash in between produced a credential change with no audit trail. Here each operation opens
 * one transaction covering the reads, the write and the audit row.
 *
 * THE PLAINTEXT KEY LIVES IN EXACTLY TWO PLACES AND NOWHERE ELSE
 * =============================================================
 * A local variable inside `provisionCredential`/`regenerateSecret`, and the response body those two
 * return. It is never persisted (only `key_id`, `key_hash`, `key_salt` are), never logged, never in
 * an audit payload (which carry `clientId` — the public key id — only), and never re-derivable. If
 * you are adding a code path that touches `generated.plaintext`, that is the property you are about
 * to break.
 */
import { createHmac } from 'node:crypto';

import { writeAudit } from '../audit/index.js';
import { withTransaction, type DbClient, type TenantId } from '../../lib/db/index.js';
import { err, ok, type Result } from '../../lib/result.js';
import {
  credentialAlreadyExistsError,
  credentialNotFoundError,
  invalidBrokerError,
} from './errors.js';
import { apiKeySecretMatches, generateApiKey, parseApiKey } from './keys.js';
import {
  disableCredential as disableCredentialRow,
  findCredential,
  findCredentialByKeyId,
  findCredentialForScope,
  insertCredential,
  isActiveBroker,
  listCredentials as listCredentialRows,
  rotateCredential,
  touchCredentialLastUsed,
} from './repository.js';
import type {
  ApiCredentialDto,
  ApiCredentialListDto,
  CredentialSecretDto,
  ListCredentialsQuery,
} from './schemas.js';

export interface ApiAccessDeps {
  readonly db: DbClient;
  /**
   * The application-wide API-key pepper, sourced by the composition root from the typed config
   * module (`config.secrets.apiKeyPepper`). Passed in rather than read here so that this module
   * never touches `process.env` (AC-010) and so the pepper's effect is testable.
   */
  readonly apiKeyPepper: string;
}

/** Who performed the action and in which verified tenant, for audit rows and `created_by`. */
export interface ApiAccessActor {
  readonly userId: number;
  readonly tenantId: TenantId;
  readonly correlationId?: string;
}

export const API_CREDENTIAL_PROVISIONED_ACTION = 'api_credential.provisioned';
export const API_CREDENTIAL_REGENERATED_ACTION = 'api_credential.regenerated';
export const API_CREDENTIAL_DISABLED_ACTION = 'api_credential.disabled';

function auditContext(actor: ApiAccessActor): { context?: { correlationId: string } } {
  return actor.correlationId === undefined
    ? {}
    : { context: { correlationId: actor.correlationId } };
}

/**
 * The audit payload for a credential. `clientId` is the PUBLIC key id and is safe to record; there
 * is deliberately no field here that could carry the secret, and none may be added.
 */
function credentialAuditPayload(
  credential: ApiCredentialDto,
): Record<string, string | number | null> {
  return {
    clientId: credential.clientId,
    brokerId: credential.brokerId,
    status: credential.status,
  };
}

/**
 * The `name` column is NOT NULL but has no field in the reference DTO and no control in the SPA, so
 * it is derived rather than collected. Recorded as a contract note in T-022's task file: the schema
 * added the column for a future admin label; until there is a UI for it, a deterministic derived
 * label is better than an empty string.
 */
function derivedCredentialName(brokerId: number | null): string {
  return brokerId === null ? 'Tenant API key' : `Broker ${String(brokerId)} API key`;
}

/** `GetApiCredentialsQueryHandler` (:16-20). */
export async function listCredentials(
  deps: ApiAccessDeps,
  query: ListCredentialsQuery,
  actor: ApiAccessActor,
): Promise<ApiCredentialListDto> {
  return {
    credentials: await listCredentialRows(deps.db, actor.tenantId, query.brokerId),
  };
}

/**
 * `ProvisionCredentialCommandHandler` (:42-96).
 *
 * Rule order is the reference's and is observable: for a broker-scoped request the broker-validity
 * check runs BEFORE the already-exists check (:47-56), so an invalid broker reports 422 rather than
 * 409 even when a credential for that broker id somehow exists.
 *
 * The whole thing runs in one transaction, so a duplicate concurrent provision cannot produce two
 * credentials for one scope: the second either sees the first's row or fails on the write.
 */
export async function provisionCredential(
  deps: ApiAccessDeps,
  brokerId: number | null,
  actor: ApiAccessActor,
): Promise<CredentialSecretDto> {
  return await withTransaction(deps.db, async (trx) => {
    if (brokerId !== null && !(await isActiveBroker(trx, actor.tenantId, brokerId))) {
      throw invalidBrokerError(brokerId);
    }

    if ((await findCredentialForScope(trx, actor.tenantId, brokerId)) !== undefined) {
      throw credentialAlreadyExistsError();
    }

    const generated = generateApiKey(deps.apiKeyPepper);

    const credential = await insertCredential(trx, actor.tenantId, {
      brokerId,
      keyId: generated.keyId,
      keyHash: generated.hash,
      keySalt: generated.salt,
      name: derivedCredentialName(brokerId),
      actorUserId: actor.userId,
    });

    await writeAudit(trx, {
      entityType: 'api_credential',
      entityId: String(credential.id),
      action: API_CREDENTIAL_PROVISIONED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: null,
      after: credentialAuditPayload(credential),
      ...auditContext(actor),
    });

    return { credential, clientId: credential.clientId, secret: generated.plaintext };
  });
}

/**
 * `RegenerateSecretCommandHandler` (:22-45).
 *
 * The key id rotates alongside the secret, which the reference could not do (its client id was the
 * Keycloak client's immutable name). Rotating it means the previous key is unresolvable rather than
 * merely non-verifying — a leaked old key cannot even be used to probe which credential it belonged
 * to. The admin UI re-reads `clientId` from this response, so the displayed value stays correct.
 *
 * A DISABLED CREDENTIAL CAN STILL BE REGENERATED, which is the reference's behaviour (:26-30 checks
 * only for existence). It does not resurrect it: `status` is untouched, so verification still fails.
 */
export async function regenerateSecret(
  deps: ApiAccessDeps,
  id: number,
  actor: ApiAccessActor,
): Promise<CredentialSecretDto> {
  return await withTransaction(deps.db, async (trx) => {
    const existing = await findCredential(trx, actor.tenantId, id);
    if (existing === undefined) throw credentialNotFoundError(id);

    const generated = generateApiKey(deps.apiKeyPepper);

    const credential = await rotateCredential(trx, actor.tenantId, id, {
      keyId: generated.keyId,
      keyHash: generated.hash,
      keySalt: generated.salt,
    });

    await writeAudit(trx, {
      entityType: 'api_credential',
      entityId: String(id),
      action: API_CREDENTIAL_REGENERATED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: credentialAuditPayload(existing),
      after: credentialAuditPayload(credential),
      ...auditContext(actor),
    });

    return { credential, clientId: credential.clientId, secret: generated.plaintext };
  });
}

/**
 * `DisableCredentialCommandHandler` (:21-49).
 *
 * IDEMPOTENT BY DESIGN: an already-disabled credential returns success WITHOUT a second audit row
 * (:29-47). A retried request therefore cannot inflate the audit trail — which matters under
 * Vercel, where duplicate delivery is normal.
 *
 * The row is never deleted and the hash is never cleared (N-09, AC-075): leads already ingested
 * through a retired credential stay attributable to it.
 */
export async function disableCredential(
  deps: ApiAccessDeps,
  id: number,
  actor: ApiAccessActor,
): Promise<ApiCredentialDto> {
  return await withTransaction(deps.db, async (trx) => {
    const existing = await findCredential(trx, actor.tenantId, id);
    if (existing === undefined) throw credentialNotFoundError(id);

    if (existing.status === 'disabled') return existing;

    const disabled = await disableCredentialRow(trx, actor.tenantId, id);

    await writeAudit(trx, {
      entityType: 'api_credential',
      entityId: String(id),
      action: API_CREDENTIAL_DISABLED_ACTION,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      before: credentialAuditPayload(existing),
      after: credentialAuditPayload(disabled),
      ...auditContext(actor),
    });

    return disabled;
  });
}

// -------------------------------------------------------------------------------------------------
// Verification — the seam T-030 (intake auth) consumes
// -------------------------------------------------------------------------------------------------

/** The scope a verified key establishes. Every field comes from the credential ROW. */
export interface CredentialContext {
  readonly credentialId: number;
  /**
   * The credential's own tenant. UNSPOOFABLE (P-06): it is read from the row the key id resolved
   * to, never from a header, a body field or a query parameter. Callers must use THIS tenant, not
   * anything the request supplied.
   */
  readonly tenantId: TenantId;
  /** Set for a broker-scoped credential; a payload naming a different broker must be rejected. */
  readonly brokerId: number | null;
}

/**
 * Why a key did not verify. For SERVER-SIDE LOGGING ONLY.
 *
 * Callers must map every reason to one identical 401 with one identical body. Distinguishing
 * "unknown key" from "wrong secret" at the boundary would let an attacker enumerate valid key ids,
 * and distinguishing "disabled" would confirm that a tenant exists and once had API access. The
 * `message` is the same opaque sentence for every reason precisely so that a caller which forwards
 * it cannot leak the distinction by accident.
 */
export type ApiKeyVerificationReason =
  | 'malformed_key'
  | 'unknown_key'
  | 'credential_disabled'
  | 'secret_mismatch';

export interface ApiKeyVerificationFailure {
  readonly reason: ApiKeyVerificationReason;
  readonly message: string;
}

const OPAQUE_FAILURE_MESSAGE = 'The presented API key is not valid.';

function verificationFailure(reason: ApiKeyVerificationReason): ApiKeyVerificationFailure {
  return { reason, message: OPAQUE_FAILURE_MESSAGE };
}

/**
 * A hash computation performed on the "no such credential" path so that an unknown key id costs
 * roughly what a known one does. Without it, the response time alone distinguishes a valid key id
 * from an invalid one, and the constant-time comparison inside `apiKeySecretMatches` protects
 * nothing. The result is discarded on purpose.
 */
function equalizeUnknownKeyTiming(secret: string, pepper: string): void {
  void createHmac('sha256', pepper).update(`decoy:${secret}`).digest('hex');
}

/**
 * Verifies a presented API key and resolves the scope it authorizes (AC-040, Q-19, P-06).
 *
 * Exported for T-030's intake middleware; this is the ONLY supported way to authenticate an intake
 * caller. The order of checks is deliberate:
 *
 *   1. PARSE FIRST, so a malformed key never becomes a database round trip — otherwise an
 *      unauthenticated caller has a free way to make the server do work.
 *   2. Look the key id up ACROSS partitions, because the credential is what determines the tenant.
 *   3. Reject a disabled credential BEFORE comparing the secret. A disabled credential must fail
 *      even when the presented key is otherwise perfectly correct
 *      (20260718002400_api_credentials.sql, "DISABLING IS THE ONLY REMOVAL PATH").
 *   4. Compare in constant time.
 *
 * `last_used_at` is NOT written here. It is a separate, deliberately non-authorizing write
 * (`touchCredentialLastUsed`) so that verification stays a pure read and a failed usage stamp can
 * never fail a valid request.
 */
export async function verifyApiKey(
  deps: ApiAccessDeps,
  presentedKey: string,
): Promise<Result<CredentialContext, ApiKeyVerificationFailure>> {
  const parsed = parseApiKey(presentedKey);
  if (parsed === undefined) return err(verificationFailure('malformed_key'));

  const row = await findCredentialByKeyId(deps.db, parsed.keyId);
  if (row === undefined) {
    equalizeUnknownKeyTiming(parsed.secret, deps.apiKeyPepper);
    return err(verificationFailure('unknown_key'));
  }

  if (row.status !== 'active') return err(verificationFailure('credential_disabled'));

  if (!apiKeySecretMatches(row.keyHash, parsed.secret, row.keySalt, deps.apiKeyPepper)) {
    return err(verificationFailure('secret_mismatch'));
  }

  return ok({ credentialId: row.id, tenantId: row.tenantId, brokerId: row.brokerId });
}

/**
 * Stamps `last_used_at` after a successful verification, for the admin UI's dormant-credential
 * view. Never an authorization input; call it fire-and-forget.
 */
export async function recordApiKeyUse(
  deps: ApiAccessDeps,
  context: CredentialContext,
): Promise<void> {
  await touchCredentialLastUsed(deps.db, context.tenantId, context.credentialId);
}
