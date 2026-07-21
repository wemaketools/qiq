/**
 * Server-to-server lead intake (T-030, AC-061; V-077, V-078; spec P-06, Q-19, §13 Intake).
 *
 * Port of `IntakeLeadCommandHandler.Handle` (:35-112). Three rules and one delegation:
 *
 *   1. the UNSPOOFABLE-BROKER rule (:39-58),
 *   2. the owner is OPTIONAL (schemas.ts),
 *   3. a duplicate NEVER blocks (:78, :93-102),
 *
 * and everything else — the validation catalog, ref generation, priority derivation, the status,
 * the audit row, the party-activity stamp — is `createLead`'s, unchanged. This module deliberately
 * re-implements NONE of it: a second creation path would be a second place for the tenant predicate
 * to be forgotten.
 *
 * TENANT AND BROKER COME FROM THE CREDENTIAL ROW AND FROM NOWHERE ELSE (P-06, AC-061)
 * ==================================================================================
 * `credential.tenantId` is what `LeadCreationActor.tenantId` is built from, so every downstream
 * read and write is predicated on the credential's tenant. There is no code path here that can read
 * a tenant from the body or a header — the intake schema has no such field, and unknown keys are
 * stripped by zod. A payload carrying `tenantId` is therefore inert rather than merely rejected,
 * which is the stronger property: a field that is never read cannot be read by mistake later.
 *
 * WHY A DUPLICATE DOES NOT CONFIRM-GATE AN UNATTENDED CALLER — MEASURED, NOT CHOSEN
 * ================================================================================
 * The browser path is confirm-gated: an open duplicate returns 409 with `lead: null` and the caller
 * re-submits with `createAnyway: true` (leads/service.ts:7-27). That gate is a HUMAN interaction —
 * it exists so a person can look at the matches and decide. A machine integration has nobody to
 * ask; a 409 it did not expect would either be retried forever or dropped on the floor, and either
 * way the lead is lost.
 *
 * So the question was NOT decided here. The reference answers it: `CreateAnyway: true` is forced
 * (:78) and the duplicates are attached to the successful 201 as a warning (:93-102). This port
 * does the same, and does it by ASKING `createLead` for the confirm envelope first and then
 * re-submitting with the confirmation — so the warning an integrator receives is computed by the
 * same duplicate logic the browser uses, rather than by a second copy of the window arithmetic that
 * could quietly disagree with it. The first call persists NOTHING when it gates (the reference
 * places that check before the transaction for exactly this reason), so the round trip is safe.
 *
 * IDEMPOTENCY AND RETRIES (CLAUDE.md, Vercel duplicate delivery)
 * =============================================================
 * This endpoint is NOT idempotent, and neither was the reference: a re-delivered POST creates a
 * SECOND lead carrying a `DUPLICATE_LEADS` warning naming the first. That is the deliberate
 * contract — a lead is a business event, and silently swallowing a resubmission would lose a
 * genuine second enquiry from the same client for the same product line, which is a normal
 * occurrence. The duplicate warning is how the ambiguity is surfaced to a human instead of guessed
 * at. `intake.test.ts` asserts this explicitly so nobody mistakes it for an oversight. A true
 * request-level idempotency key is NOT part of the reference contract and is FLAGGED in the task
 * file rather than invented here.
 */
import type { CredentialContext } from '../api-access/index.js';
import { DUPLICATE_LEAD_WARNING, type CreateLeadOutcomeDto } from '../leads/schemas.js';
import {
  createLead,
  type LeadCreationActor,
  type LeadsDeps,
} from '../leads/service.js';
import { AppError } from '../../lib/errors/index.js';
import type { TenantId } from '../../lib/db/index.js';
import {
  BROKER_NOT_ALLOWED_CODE,
  DUPLICATE_LEADS_CODE,
  type IntakeLeadInput,
  type IntakeOutcomeDto,
  type IntakeWarningDto,
} from './schemas.js';

export interface IntakeDeps {
  readonly leads: LeadsDeps;
}

/** `LeadSource.Api` (LeadConstants.cs:31) — what `leads.source` records for this path. */
const API_SOURCE = 'api' as const;

/**
 * The reference's `FieldForCode` (:114-125): which request field a service-layer failure belongs
 * to, so an unattended caller gets a machine-actionable `errors[]` entry rather than a bare code.
 *
 * `general` is the fallback for anything with no single owning field — the reference's `_ =>` arm.
 */
const FIELD_FOR_CODE: Readonly<Record<string, string>> = {
  LEAD_INVALID_BROKER: 'brokerId',
  LEAD_INVALID_REGION: 'regionId',
  LEAD_INVALID_PRODUCT_LINE: 'productLineId',
  LEAD_INVALID_COVER_TYPE: 'coverTypeId',
  LEAD_INVALID_REQUEST_CHANNEL: 'requestChannelId',
  LEAD_INVALID_PARTY: 'partyId',
  LEAD_INVALID_OWNER: 'ownerUserId',
  LEAD_EXTERNAL_REF_NOT_ENABLED: 'externalRef',
};

export const INTAKE_GENERAL_FIELD = 'general';

/**
 * `audit_log.actor_label` for an API-ingested change: `api_credential:{id}`.
 *
 * The DATABASE id, not the `key_id`. The key id is the public lookup handle a caller presents, and
 * an audit table is a widely-readable surface — recording it there would hand anyone with audit
 * access a list of live key ids to try. The row id is meaningless without the credential table.
 */
export function credentialActorLabel(credentialId: number): string {
  return `api_credential:${String(credentialId)}`;
}

/** A 422 carrying the reference's `errors[]` shape: one `{field, code, message}` per failure. */
export function intakeValidationError(field: string, code: string, message: string): AppError {
  return new AppError(422, message, { code, fieldErrors: [{ field, code, message }] });
}

/**
 * Re-shapes a leads-domain 422 into the intake `errors[]` contract (:105-108).
 *
 * ONLY 422s are re-shaped. A 404, a 403 or a 500 from below is rethrown untouched: turning an
 * unexpected failure into a tidy validation error would tell an integrator to fix its payload when
 * the real fault was ours, and would swallow the very signal the error boundary logs on.
 */
function asIntakeError(error: unknown): unknown {
  if (!(error instanceof AppError) || error.status !== 422) return error;

  // A shape-level failure already carries per-field errors from zod; leave them exactly as they are.
  if (error.fieldErrors !== undefined && error.fieldErrors.length > 0) return error;

  const code = error.code ?? 'INVALID';
  return intakeValidationError(FIELD_FOR_CODE[code] ?? INTAKE_GENERAL_FIELD, code, error.message);
}

/**
 * The unspoofable-broker rule (:39-58, AC-061, V-078).
 *
 * A broker-scoped credential FORCES its own broker and REJECTS a payload naming a different one —
 * rejects rather than silently overrides, because an integrator that believes it filed against
 * broker X must not discover months later that everything landed under broker Y. A payload that
 * names no broker, or names the credential's own, is accepted and the credential's broker is used.
 *
 * A tenant-scoped credential (`brokerId === null`) passes the payload's broker through to exactly
 * the checks browser intake applies — active, in THIS tenant, and consistent with the request
 * channel's broker requirement — all of which live in `createLead`.
 */
export function resolveBroker(
  credential: CredentialContext,
  payloadBrokerId: number | null | undefined,
): number | null {
  if (credential.brokerId === null) return payloadBrokerId ?? null;

  if (payloadBrokerId !== null && payloadBrokerId !== undefined && payloadBrokerId !== credential.brokerId) {
    throw intakeValidationError(
      'brokerId',
      BROKER_NOT_ALLOWED_CODE,
      'This credential is scoped to a specific broker; the payload names a different broker.',
    );
  }

  return credential.brokerId;
}

/** `IntakeWarningDto(DuplicateLeadsCode, new { duplicates })` (:101) — note the PLURAL code. */
function toIntakeWarnings(outcome: CreateLeadOutcomeDto): IntakeWarningDto[] {
  return outcome.warnings.map((warning) =>
    warning.code === DUPLICATE_LEAD_WARNING
      ? { code: DUPLICATE_LEADS_CODE, details: warning.details }
      : warning,
  );
}

export async function intakeLead(
  deps: IntakeDeps,
  input: IntakeLeadInput,
  credential: CredentialContext,
  correlationId?: string,
): Promise<IntakeOutcomeDto> {
  const brokerId = resolveBroker(credential, input.brokerId);

  // The credential IS the principal: no application user, no tenant header, and — deliberately —
  // no `access`, so the response surfaces no `availableOperations` (see `LeadCreationActor`).
  const actor: LeadCreationActor = {
    userId: null,
    tenantId: credential.tenantId satisfies TenantId,
    // A non-user actor MUST label itself, or its audit rows identify nobody — the same mechanism
    // the background jobs use for `"system"`. The credential's database id is safe to record; the
    // key and even its public `key_id` are not, and neither appears here.
    actorLabel: credentialActorLabel(credential.credentialId),
    ...(correlationId === undefined ? {} : { correlationId }),
  };

  const origin = { source: API_SOURCE, intakeCredentialId: credential.credentialId } as const;

  const create = async (createAnyway: boolean): Promise<CreateLeadOutcomeDto> => {
    try {
      return await createLead(
        deps.leads,
        {
          ...input,
          brokerId,
          inlineParty: null,
          ownerUserId: input.ownerUserId ?? null,
          createAnyway,
        },
        actor,
        origin,
      );
    } catch (error) {
      throw asIntakeError(error);
    }
  };

  const first = await create(false);

  // Not gated: nothing to reconcile, and `first` already holds the lead.
  if (!first.requiresConfirmation) {
    return outcomeOf(first, []);
  }

  // Gated: NOTHING was persisted, and `first.warnings` carries the duplicate matches. Re-submit
  // with the confirmation the reference hard-codes, and carry the matches onto the 201.
  const confirmed = await create(true);
  return outcomeOf(confirmed, toIntakeWarnings(first));
}

function outcomeOf(
  outcome: CreateLeadOutcomeDto,
  carried: readonly IntakeWarningDto[],
): IntakeOutcomeDto {
  const lead = outcome.lead;
  if (lead === null) {
    // Unreachable: `createLead` returns a null lead only on the confirm gate, which the caller has
    // already answered. Failing loudly beats emitting `leadId: null` against a non-null contract.
    throw new AppError(500, 'Lead creation returned no lead after the duplicate confirmation.');
  }

  return {
    leadId: lead.id,
    leadRef: lead.leadRef,
    warnings: [...carried, ...toIntakeWarnings(outcome)],
  };
}
