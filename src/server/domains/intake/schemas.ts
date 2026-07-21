/**
 * The server-to-server lead-intake contract (T-030, AC-061; V-077; spec §13 Intake, P-06, Q-19).
 *
 * Port of `IntakeEndpoints.IntakeLeadRequest` (:114-131) and `IntakeOutcomeDto.cs`.
 *
 * THE BODY IS THE BROWSER BODY WITH THREE MEASURED DIFFERENCES, AND ONLY THREE
 * ===========================================================================
 * `IntakeLeadPayload` (IntakeLeadCommand.cs:29-49) is field-for-field `CreateLeadRequest` except:
 *
 *   1. `partyId` is REQUIRED and non-null (`long PartyId`, not `long?`). There is no inline-party
 *      creation on this path — the handler hard-codes `InlineParty: null` (:62). A payload that
 *      supplies `inlineParty` is therefore NOT honoured; zod strips the unknown key and the missing
 *      `partyId` is what fails, so an integrator cannot half-create a party.
 *   2. `ownerUserId` is OPTIONAL (`long? OwnerUserId`). CreateLeadValidator.cs:38-45 attaches the
 *      `NotNull` rule only `When(SourceOverride != Api)`. An ownerless submission creates an
 *      unassigned New lead.
 *   3. there is no `createAnyway`. The handler forces `CreateAnyway: true` (:78), so a duplicate
 *      can never confirm-gate an unattended caller — see service.ts for the full reasoning.
 *
 * Everything else — every code, every message, every boundary — is IMPORTED from
 * `leads/schemas.ts` rather than restated, so the two intake surfaces cannot drift apart.
 *
 * `brokerId` IS ACCEPTED HERE AND CONSTRAINED LATER, NOT DROPPED
 * =============================================================
 * A tenant-scoped credential legitimately names a broker in the payload (:57). A broker-SCOPED
 * credential may only name its own (:45-50). That is a rule about the CREDENTIAL, not about the
 * body's shape, so it lives in the service where the credential is in scope. Silently ignoring the
 * field instead would let a broker-scoped integrator believe they had filed against another broker.
 */
import { z } from 'zod';

import {
  LEAD_PRIORITIES,
  checkDateReceived,
  checkPolicyTerm,
  leadWriteShape,
  positiveId,
} from '../leads/schemas.js';

/** `IntakeLeadRequest` (:115-131). */
export const intakeLeadSchema = z
  .object({
    ...leadWriteShape,
    // `long PartyId` — required and non-null, unlike browser create's party/inline-party choice.
    partyId: positiveId('Party'),
    // `long? OwnerUserId` — optional on this path only.
    ownerUserId: positiveId('Owner').nullable().optional(),
    priority: z
      .enum(LEAD_PRIORITIES, { message: 'LEAD_PRIORITY_INVALID|Priority is not recognized.' })
      .nullable()
      .optional(),
    intakeNotes: z.string().trim().max(4000).nullable().optional(),
  })
  .superRefine(checkDateReceived)
  .superRefine(checkPolicyTerm);

export type IntakeLeadInput = z.infer<typeof intakeLeadSchema>;

/**
 * `IntakeOutcomeDto.Created` rendered by the endpoint (:106-108): the created lead's id and ref
 * plus any non-blocking warnings. NOT the full `LeadDto` — an unattended caller gets back only what
 * it needs to reference the lead later, which also keeps tenant data out of a machine integration's
 * logs.
 */
export interface IntakeOutcomeDto {
  readonly leadId: number;
  readonly leadRef: string;
  readonly warnings: readonly IntakeWarningDto[];
}

/** `IntakeWarningDto` (IntakeOutcomeDto.cs:7). */
export interface IntakeWarningDto {
  readonly code: string;
  readonly details: Record<string, unknown>;
}

/**
 * `IntakeOutcomeDto.BrokerNotAllowedCode` (:23) — the unspoofable-broker rejection.
 *
 * It is a 422 on `brokerId`, NOT a 401/403: the credential authenticated fine, the BODY asked for
 * something the credential may not do.
 */
export const BROKER_NOT_ALLOWED_CODE = 'BROKER_NOT_ALLOWED';

/**
 * `IntakeOutcomeDto.DuplicateLeadsCode` (:24) — **`DUPLICATE_LEADS`, PLURAL**.
 *
 * MEASURED, AND IT IS NOT A TYPO: the browser surface emits `DUPLICATE_LEAD` (singular,
 * CreateLeadOutcomeDto.cs:100) while the intake surface emits `DUPLICATE_LEADS`. The two codes are
 * read by two different consumers, so the difference is preserved rather than "corrected"; the
 * service maps one onto the other explicitly and the suite asserts the exact string.
 */
export const DUPLICATE_LEADS_CODE = 'DUPLICATE_LEADS';
