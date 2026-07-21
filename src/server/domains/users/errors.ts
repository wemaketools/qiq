/**
 * User Manager domain failures (T-017, AC-029, AC-030, AC-031).
 *
 * Port of `src/api/QuoteIQ.Application/Features/Users/UserErrors.cs` with the status mapping
 * measured in `src/api/QuoteIQ.Api/Endpoints/UserEndpoints.cs:104-117`:
 *
 *   USER_NOT_FOUND / USER_TENANT_NOT_FOUND /
 *   USER_ROLE_NOT_FOUND / USER_GROUP_NOT_FOUND              -> 404  (:106-107)
 *
 *   USER_TENANT_NOT_ALLOWED / USER_REQUIRES_ASSIGN_TENANT /
 *   USER_REQUIRES_ASSIGN_ROLE / USER_REQUIRES_ASSIGN_GROUP /
 *   USER_REQUIRES_GRANT_DIRECT_PERMISSION /
 *   USER_PERMISSION_EXCEEDS_CALLER_GRANT                    -> 403  (:108-110)
 *
 *   USER_ALREADY_INACTIVE / USER_CANNOT_DEACTIVATE_SELF /
 *   USER_CANNOT_CHANGE_OWN_ACCESS                           -> 409  (:111-112)
 *
 *   USER_VALIDATION_FAILED / USER_REQUIRES_TENANT /
 *   USER_EMAIL_DUPLICATE / USER_ROLE_TENANT_MISMATCH /
 *   USER_GROUP_TENANT_MISMATCH / USER_PERMISSION_NOT_FOUND  -> 422  (:113-115)
 *
 * A DUPLICATE EMAIL IS 422, NOT 409 — measured at :113, not intuited. So is a
 * role/group tenant mismatch. `USER_ALREADY_INACTIVE` IS 409 even though its siblings are 422.
 *
 * All of these carry a `code` extension and render `detail: "CODE: message"` (:107
 * `detail: $"{error.Code}: {error.Message}"` + `extensions: Extensions(error)`), unlike the tenants
 * mapper — see domains/tenants/errors.ts for why that difference is preserved rather than unified.
 *
 * `USER_AUTH_PROVISIONING_FAILED` has no reference code: the reference's Keycloak call threw and
 * became a 500. AC-031 requires provisioning failure to "surface as a typed error", so it is 502
 * (a dependency the API called failed) with a message that never echoes the auth-side detail.
 */
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';

function unprocessable(code: string, message: string, fieldErrors?: readonly FieldError[]): AppError {
  return new AppError(422, message, {
    code,
    ...(fieldErrors === undefined ? {} : { fieldErrors }),
  });
}

export function userValidationError(fieldErrors: readonly FieldError[]): AppError {
  return unprocessable(
    'USER_VALIDATION_FAILED',
    fieldErrors.map((error) => error.message).join('; '),
    fieldErrors,
  );
}

export function userNotFoundError(userId: number): NotFoundError {
  return new NotFoundError(`User ${userId} was not found.`, { code: 'USER_NOT_FOUND' });
}

export function userTenantNotFoundError(tenantId: number): NotFoundError {
  return new NotFoundError(`Tenant ${tenantId} was not found.`, {
    code: 'USER_TENANT_NOT_FOUND',
  });
}

export function userRoleNotFoundError(roleId: number): NotFoundError {
  return new NotFoundError(`Role ${roleId} was not found.`, { code: 'USER_ROLE_NOT_FOUND' });
}

export function userGroupNotFoundError(groupId: number): NotFoundError {
  return new NotFoundError(`Group ${groupId} was not found.`, { code: 'USER_GROUP_NOT_FOUND' });
}

/** FR-16 / P-03: a non-Internal user must belong to at least one tenant. */
export function userRequiresTenantError(): AppError {
  return unprocessable(
    'USER_REQUIRES_TENANT',
    'A non-Internal user must be assigned to at least one tenant.',
  );
}

export function userDuplicateEmailError(email: string): AppError {
  return unprocessable('USER_EMAIL_DUPLICATE', `A user with email '${email}' already exists.`);
}

export function userRoleTenantMismatchError(roleId: number): AppError {
  return unprocessable(
    'USER_ROLE_TENANT_MISMATCH',
    `Role ${roleId} does not belong to any of the assigned tenants.`,
  );
}

export function userGroupTenantMismatchError(groupId: number): AppError {
  return unprocessable(
    'USER_GROUP_TENANT_MISMATCH',
    `Group ${groupId} does not belong to any of the assigned tenants.`,
  );
}

export function userPermissionNotFoundError(code: string): AppError {
  return unprocessable('USER_PERMISSION_NOT_FOUND', `Permission '${code}' is not in the catalog.`);
}

export function userTenantNotAllowedError(tenantId: number): ForbiddenError {
  return new ForbiddenError(
    `Caller is not permitted to assign tenant ${tenantId} without cross-tenant access.`,
    { code: 'USER_TENANT_NOT_ALLOWED' },
  );
}

export function userRequiresAssignTenantError(): ForbiddenError {
  return new ForbiddenError(
    'Caller lacks users.assign_tenant and cannot assign tenant memberships.',
    { code: 'USER_REQUIRES_ASSIGN_TENANT' },
  );
}

export function userRequiresAssignRoleError(): ForbiddenError {
  return new ForbiddenError('Caller lacks users.assign_role and cannot assign direct roles.', {
    code: 'USER_REQUIRES_ASSIGN_ROLE',
  });
}

export function userRequiresAssignGroupError(): ForbiddenError {
  return new ForbiddenError(
    'Caller lacks users.assign_group and cannot assign group memberships.',
    { code: 'USER_REQUIRES_ASSIGN_GROUP' },
  );
}

export function userRequiresGrantDirectPermissionError(): ForbiddenError {
  return new ForbiddenError(
    'Caller lacks users.grant_direct_permission and cannot grant direct permissions.',
    { code: 'USER_REQUIRES_GRANT_DIRECT_PERMISSION' },
  );
}

export function userPermissionExceedsCallerGrantError(code: string): ForbiddenError {
  return new ForbiddenError(
    `Caller cannot grant permission '${code}' because they do not hold it themselves in the target tenant(s).`,
    { code: 'USER_PERMISSION_EXCEEDS_CALLER_GRANT' },
  );
}

export function userAlreadyInactiveError(userId: number): ConflictError {
  return new ConflictError(`User ${userId} is already deactivated.`, {
    code: 'USER_ALREADY_INACTIVE',
  });
}

/** Reactivation counterpart. No reference code exists — the reference had no activate route. */
export function userAlreadyActiveError(userId: number): ConflictError {
  return new ConflictError(`User ${userId} is already active.`, { code: 'USER_ALREADY_ACTIVE' });
}

export function userCannotDeactivateSelfError(): ConflictError {
  return new ConflictError(
    'You cannot deactivate your own account. Another administrator must do this.',
    { code: 'USER_CANNOT_DEACTIVATE_SELF' },
  );
}

export function userCannotChangeOwnAccessError(): ConflictError {
  return new ConflictError(
    'You cannot change your own tenant, role, permission, or group assignments. Another administrator must do this.',
    { code: 'USER_CANNOT_CHANGE_OWN_ACCESS' },
  );
}

/**
 * The Supabase Auth Admin API refused to provision the identity.
 *
 * 422 AND NOT 5xx, DELIBERATELY. A gateway-style status would read better semantically, but
 * `lib/errors/problem.ts` SANITIZES every status >= 500 — detail is replaced with the generic
 * text and the `code` extension is dropped — so a 502 here would be indistinguishable from an
 * unhandled crash. AC-031 requires the failure to "surface as a typed error", which on this
 * codebase's wire contract means a 4xx carrying a code. 422 also matches the most common real
 * cause: an address Auth already knows, which is the same class of failure as
 * `USER_EMAIL_DUPLICATE`.
 *
 * The message is generic on purpose: the auth-side detail can echo an address or an internal
 * identifier. The real cause is logged server-side by the error boundary and never rendered.
 */
export function userAuthProvisioningFailedError(): AppError {
  return unprocessable(
    'USER_AUTH_PROVISIONING_FAILED',
    'The identity provider could not provision this user. No user was created.',
  );
}
