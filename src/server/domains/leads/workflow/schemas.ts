/**
 * Per-operation request schemas (T-025; AC-051, AC-096).
 *
 * Ports the FluentValidation validators under `Features/Leads/Workflow/*` plus the request records
 * declared inline at `LeadWorkflowEndpoints.cs:182-200`.
 *
 * THE SHAPE/RULE SPLIT IS THE REFERENCE'S, AND IT IS DELIBERATE
 * ============================================================
 * Each reference validator carries a header saying so explicitly ("Shape-level validation only;
 * role-eligibility/accountable-owner checks need database lookups and live in the handler"). The
 * split survives here for a reason that outlives the port: a schema is a pure function of the body,
 * so anything requiring the lead's CURRENT status, the tenant's reference data or the caller's
 * grants cannot live in one without smuggling I/O into validation. Concretely:
 *
 *   here (422 `LEAD_WORKFLOW_VALIDATION_FAILED` with `errors[]`)   in operations.ts (422, own code)
 *   ------------------------------------------------------------  -----------------------------
 *   assignments non-empty, no duplicate slot                       slot belongs to tenant, assignee eligible
 *   lostReasonId > 0                                               reason is ACTIVE, 'other' needs a comment
 *   rejectionReason non-empty                                      a pending request actually exists
 *   outcomeNote non-empty                                          next follow-up required+future past Quote Sent
 *   approverUserId > 0                                             approver holds pricing.approve
 *
 * THE ERROR CODE PREFIX IS `LEAD_` TO MATCH `toFieldErrors`' EXISTING CONVENTION
 * =============================================================================
 * `message: 'CODE|text'` is how this codebase attaches a per-field code to a zod issue
 * (`lib/validation`'s `EXPLICIT_CODE`). Reusing `positiveId` from the leads schemas keeps the id
 * rules — and their codes — identical across intake and workflow rather than drifting apart.
 */
import { z } from 'zod';

import { positiveId } from '../schemas.js';

/** `yyyy-MM-dd`, matching the reference's `DateOnly` binding. */
const dateOnly = (field: string): z.ZodType<string> =>
  z
    .string({ message: `LEAD_REQUIRED|${field} is required.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, {
      message: `LEAD_INVALID_DATE|${field} must be a yyyy-MM-dd date.`,
    });

/** A required free-text field: `NotEmpty()` means non-blank, not merely present. */
const requiredText = (message: string): z.ZodType<string> =>
  z
    .string({ message: `LEAD_REQUIRED|${message}` })
    .trim()
    .min(1, { message: `LEAD_REQUIRED|${message}` });

/** An optional note. Absent, null and blank are all "no note". */
const optionalNote = z.string().trim().nullable().optional();

/** `GreaterThan(0).When(x => x is not null)` for a money amount. */
const optionalPositiveAmount = (field: string): z.ZodType<number | null | undefined> =>
  z
    .number({ message: `LEAD_REQUIRED|${field} must be a number.` })
    .positive({ message: `LEAD_MUST_BE_GREATER_THAN_ZERO|${field} must be greater than 0.` })
    .nullable()
    .optional();

/**
 * The body every note-only operation takes (`OptionalNoteRequest`, :186): start-information-gathering,
 * start-pricing, approve-pricing, start-negotiation.
 *
 * `.optional()` on the whole object is what lets the SPA POST with no body at all for these — the
 * reference's model binder treats a missing body as a record with null members.
 */
export const optionalNoteSchema = z.object({ note: optionalNote }).partial();

export type OptionalNoteInput = z.infer<typeof optionalNoteSchema>;

/**
 * `AssignLeadRequest` (:182-184) with `AssignLeadValidator`'s rules.
 *
 * `userId` is NULLABLE and that is the clear-the-slot signal, not an omission — the single
 * Assign/Reassign dialog contract sends every slot it wants to change, with null meaning "unassign".
 * Which is why the "accountable owner cannot be left unassigned" rule cannot live here: it depends
 * on the lead's OTHER existing assignments, not on this body.
 */
export const assignLeadSchema = z.object({
  assignments: z
    .array(
      z.object({
        businessAssignmentId: positiveId('businessAssignmentId'),
        userId: positiveId('userId').nullable(),
      }),
    )
    .min(1, { message: 'LEAD_REQUIRED|At least one role assignment is required.' })
    .refine(
      (assignments) =>
        new Set(assignments.map((a) => a.businessAssignmentId)).size === assignments.length,
      { message: 'LEAD_DUPLICATE_ASSIGNMENT|Each assignable role may only appear once per request.' },
    ),
  comment: optionalNote,
});

export type AssignLeadInput = z.infer<typeof assignLeadSchema>;

/**
 * `SendToUnderwritingRequest` (:188).
 *
 * The reference checks `UnderwritingOwnerUserId <= 0` in the HANDLER rather than a validator
 * (SendToUnderwritingCommandHandler.cs:52-55), returning its generic workflow-validation code. The
 * rule is expressed here instead — same rejection, same status, one layer earlier — because a
 * non-positive id is purely a property of the body. The resulting `code` therefore differs from the
 * reference on this one field (`LEAD_MUST_BE_POSITIVE` in `errors[]` rather than a bare
 * `LEAD_WORKFLOW_VALIDATION_FAILED`), which is strictly more information for the same outcome.
 */
export const sendToUnderwritingSchema = z.object({
  underwritingOwnerUserId: positiveId('underwritingOwnerUserId'),
  note: optionalNote,
});

export type SendToUnderwritingInput = z.infer<typeof sendToUnderwritingSchema>;

/** `RequestPricingApprovalRequest` (:190) with `RequestPricingApprovalValidator`'s rules. */
export const requestPricingApprovalSchema = z.object({
  approverUserId: positiveId('approverUserId'),
  proposedPremium: optionalPositiveAmount('proposedPremium'),
  note: optionalNote,
});

export type RequestPricingApprovalInput = z.infer<typeof requestPricingApprovalSchema>;

/** `RejectPricingRequest` (:192) — `RejectPricingValidator` makes the reason mandatory. */
export const rejectPricingSchema = z.object({
  rejectionReason: requiredText('A rejection reason is required.'),
});

export type RejectPricingInput = z.infer<typeof rejectPricingSchema>;

/**
 * `LogFollowUpRequest` (:194) with `LogFollowUpValidator`'s rules.
 *
 * `followUpDate` is optional and defaults to today in the handler (`command.FollowUpDate ?? today`);
 * `nextFollowUpDate` is optional HERE because whether it is required depends on the lead's reporting
 * category, which this schema cannot see.
 */
export const logFollowUpSchema = z.object({
  followUpDate: dateOnly('followUpDate').nullable().optional(),
  outcomeNote: requiredText('An outcome note is required.'),
  nextFollowUpDate: dateOnly('nextFollowUpDate').nullable().optional(),
});

export type LogFollowUpInput = z.infer<typeof logFollowUpSchema>;

/** `MarkLeadLostRequest` (:196) with `MarkLeadLostValidator`'s rules. */
export const markLeadLostSchema = z.object({
  lostReasonId: positiveId('lostReasonId'),
  competitor: z.string().trim().nullable().optional(),
  competitorPremium: optionalPositiveAmount('competitorPremium'),
  lossComments: z.string().trim().nullable().optional(),
});

export type MarkLeadLostInput = z.infer<typeof markLeadLostSchema>;

/** `WithdrawLeadRequest` (:198) — `WithdrawLeadValidator` makes the note mandatory. */
export const withdrawLeadSchema = z.object({
  withdrawalNote: requiredText('A withdrawal note is required.'),
});

export type WithdrawLeadInput = z.infer<typeof withdrawLeadSchema>;

/** `ReopenLeadRequest` (:200) — `ReopenLeadValidator` makes the reason mandatory. */
export const reopenLeadSchema = z.object({
  reopenReason: requiredText('A reopen reason is required.'),
});

export type ReopenLeadInput = z.infer<typeof reopenLeadSchema>;
