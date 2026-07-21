/**
 * Business-assignment slots: the `/settings/business-assignments` surface over the two fixed
 * `rm`/`underwriter` slots (T-020). Workflow consumers (T-024+) read the slot rows through
 * `listSlots` rather than re-projecting `business_assignments`.
 */
export {
  ASSIGNMENT_ROLE_IN_USE,
  BUSINESS_ASSIGNMENTS_NOT_FOUND,
  BUSINESS_ASSIGNMENTS_ROLE_INVALID,
  BUSINESS_ASSIGNMENTS_VALIDATION_FAILED,
} from './errors.js';
export {
  listUsersHoldingPermission,
  listUsersHoldingRole,
} from './eligible-repository.js';
export { hasLiveAssignments, listSlots, type AssignmentSlotRow } from './repository.js';
export { businessAssignmentRoutes } from './routes.js';
export {
  ASSIGNMENT_SLOTS,
  RM_SLOT,
  UNDERWRITER_SLOT,
  slotLabel,
  type AssignmentSlot,
  type BusinessAssignmentEntryDto,
  type BusinessAssignmentsDto,
  type EligibleAssigneeDto,
  type UpdateBusinessAssignmentsInput,
} from './schemas.js';
export {
  BUSINESS_ASSIGNMENTS_ENTITY_TYPE,
  BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
  PRICING_APPROVE_PERMISSION,
  getBusinessAssignments,
  getEligibleApprovers,
  getEligibleAssignees,
  updateBusinessAssignments,
  type AssignmentsActor,
  type AssignmentsDeps,
} from './service.js';

import { getDb } from '../../lib/db/index.js';
import type { AssignmentsDeps } from './service.js';

/**
 * Production wiring for the business-assignments endpoints. Mirrors `defaultReferenceDataDeps()`;
 * `getDb()` returns the process-wide pool and captures no request state.
 */
export function defaultAssignmentsDeps(): AssignmentsDeps {
  return { db: getDb() };
}
