/**
 * Role and group domain failures (T-017, AC-030).
 *
 * Port of `RoleErrors.cs` / `GroupErrors.cs` together with the status mappings measured in
 * `src/api/QuoteIQ.Api/Endpoints/RoleEndpoints.cs:74-83` and `GroupEndpoints.cs:106-117`:
 *
 *   ROLE_NOT_FOUND                        -> 404  (RoleEndpoints.cs:76)
 *   ROLE_GLOBAL_FORBIDDEN                 -> 403  (:77)
 *   ROLE_PERMISSION_EXCEEDS_CALLER_GRANT  -> 403  (:77)
 *   ROLE_IN_USE                           -> 409  (:78)
 *   ROLE_SELF_LOCKOUT                     -> 409  (:78)
 *   ROLE_VALIDATION_FAILED                -> 422  (:80)
 *   ROLE_NAME_DUPLICATE                   -> 422  (:80)   NOT 409 — measured
 *   ROLE_PERMISSION_NOT_FOUND             -> 422  (:80)
 *   ROLE_TENANT_REQUIRED                  -> 422  (:80)
 *
 *   GROUP_NOT_FOUND / USER_NOT_FOUND / ROLE_NOT_FOUND   -> 404  (GroupEndpoints.cs:108)
 *   GROUP_GLOBAL_FORBIDDEN                              -> 403  (:110)
 *   GROUP_PERMISSION_EXCEEDS_CALLER_GRANT               -> 403  (:110)
 *   GROUP_SELF_LOCKOUT                                  -> 409  (:112)
 *   GROUP_VALIDATION_FAILED / NAME_DUPLICATE /
 *   USER_ALREADY_MEMBER / USER_NOT_MEMBER /
 *   ROLE_TENANT_MISMATCH / PERMISSION_NOT_FOUND /
 *   TENANT_REQUIRED                                     -> 422  (:114-116)
 *
 * A DUPLICATE NAME IS 422 IN BOTH MAPPERS, NOT 409 — the same measured-not-intuited quirk
 * `domains/tenants/errors.ts` records for tenants. `ALREADY_MEMBER` and `NOT_MEMBER` are 422 for the
 * same reason: they read like conflicts and the reference files them under Unprocessable Entity.
 *
 * UNLIKE the tenants mapper, these two DO attach a `code` extension and render
 * `detail: "CODE: message"` (RoleEndpoints.cs:76 `detail: $"{error.Code}: {error.Message}"` plus
 * `extensions: Extensions(error)`), so every error below is constructed WITH a code — which
 * lib/errors/problem.ts renders in exactly that shape.
 */
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';
import type { RoleUsage } from './admin-repository.js';

function unprocessable(code: string, message: string, fieldErrors?: readonly FieldError[]): AppError {
  return new AppError(422, message, {
    code,
    ...(fieldErrors === undefined ? {} : { fieldErrors }),
  });
}

/* ------------------------------------------ roles ------------------------------------------ */

export function roleValidationError(fieldErrors: readonly FieldError[]): AppError {
  return unprocessable(
    'ROLE_VALIDATION_FAILED',
    fieldErrors.map((error) => error.message).join('; '),
    fieldErrors,
  );
}

export function roleNotFoundError(roleId: number): NotFoundError {
  return new NotFoundError(`Role ${roleId} was not found.`, { code: 'ROLE_NOT_FOUND' });
}

export function roleDuplicateNameError(name: string): AppError {
  return unprocessable('ROLE_NAME_DUPLICATE', `A role named '${name}' already exists in this scope.`);
}

export function rolePermissionNotFoundError(code: string): AppError {
  return unprocessable('ROLE_PERMISSION_NOT_FOUND', `Permission '${code}' is not in the catalog.`);
}

export function roleTenantRequiredError(): AppError {
  return unprocessable(
    'ROLE_TENANT_REQUIRED',
    'A tenant context is required to create a tenant-scoped role.',
  );
}

export function roleGlobalForbiddenError(): ForbiddenError {
  return new ForbiddenError('Caller lacks permission to manage global (cross-tenant) roles.', {
    code: 'ROLE_GLOBAL_FORBIDDEN',
  });
}

export function rolePermissionExceedsCallerGrantError(code: string): ForbiddenError {
  return new ForbiddenError(
    `Caller cannot add permission '${code}' to this role because they do not hold it themselves in this scope.`,
    { code: 'ROLE_PERMISSION_EXCEEDS_CALLER_GRANT' },
  );
}

export function roleSelfLockoutRemovalError(code: string): ConflictError {
  return new ConflictError(
    `Removing '${code}' from a role you hold would lock you out of access administration. Another administrator must do this.`,
    { code: 'ROLE_SELF_LOCKOUT' },
  );
}

export function roleSelfLockoutDisableError(): ConflictError {
  return new ConflictError(
    'Disabling a role you hold that carries user/role/group administration permissions would lock you out. Another administrator must do this.',
    { code: 'ROLE_SELF_LOCKOUT' },
  );
}

/** RoleErrors.InUse — the message enumerates the blast radius, verbatim from the reference. */
export function roleInUseError(usage: RoleUsage): ConflictError {
  const users = usage.users.map((user) => user.email).join(', ');
  const groups = usage.groups.map((group) => group.name).join(', ');
  return new ConflictError(
    `Role is in use by ${usage.users.length} user(s) [${users}] and ${usage.groups.length} group(s) [${groups}]. ` +
      'Remove these assignments first, or pass force=true.',
    { code: 'ROLE_IN_USE' },
  );
}

/* ----------------------------------------- groups ------------------------------------------ */

export function groupValidationError(fieldErrors: readonly FieldError[]): AppError {
  return unprocessable(
    'GROUP_VALIDATION_FAILED',
    fieldErrors.map((error) => error.message).join('; '),
    fieldErrors,
  );
}

export function groupNotFoundError(groupId: number): NotFoundError {
  return new NotFoundError(`Group ${groupId} was not found.`, { code: 'GROUP_NOT_FOUND' });
}

export function groupUserNotFoundError(userId: number): NotFoundError {
  return new NotFoundError(`User ${userId} was not found.`, { code: 'GROUP_USER_NOT_FOUND' });
}

export function groupRoleNotFoundError(roleId: number): NotFoundError {
  return new NotFoundError(`Role ${roleId} was not found.`, { code: 'GROUP_ROLE_NOT_FOUND' });
}

export function groupDuplicateNameError(name: string): AppError {
  return unprocessable(
    'GROUP_NAME_DUPLICATE',
    `A group named '${name}' already exists in this scope.`,
  );
}

export function groupAlreadyMemberError(userId: number): AppError {
  return unprocessable(
    'GROUP_USER_ALREADY_MEMBER',
    `User ${userId} is already a member of this group.`,
  );
}

export function groupNotMemberError(userId: number): AppError {
  return unprocessable('GROUP_USER_NOT_MEMBER', `User ${userId} is not a member of this group.`);
}

export function groupRoleTenantMismatchError(roleId: number): AppError {
  return unprocessable(
    'GROUP_ROLE_TENANT_MISMATCH',
    `Role ${roleId} does not belong to this group's tenant scope.`,
  );
}

export function groupPermissionNotFoundError(code: string): AppError {
  return unprocessable('GROUP_PERMISSION_NOT_FOUND', `Permission '${code}' is not in the catalog.`);
}

export function groupTenantRequiredError(): AppError {
  return unprocessable(
    'GROUP_TENANT_REQUIRED',
    'A tenant context is required to create a tenant-scoped group.',
  );
}

export function groupGlobalForbiddenError(): ForbiddenError {
  return new ForbiddenError('Caller lacks permission to manage global (cross-tenant) groups.', {
    code: 'GROUP_GLOBAL_FORBIDDEN',
  });
}

export function groupPermissionExceedsCallerGrantError(code: string): ForbiddenError {
  return new ForbiddenError(
    `Caller cannot grant permission '${code}' to this group because they do not hold it themselves in this scope.`,
    { code: 'GROUP_PERMISSION_EXCEEDS_CALLER_GRANT' },
  );
}

export function groupSelfLockoutLeaveError(): ConflictError {
  return new ConflictError(
    'You cannot remove yourself from a group that grants you user/role/group administration permissions. Another administrator must do this.',
    { code: 'GROUP_SELF_LOCKOUT' },
  );
}
