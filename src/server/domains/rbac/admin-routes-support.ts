/**
 * Route-layer plumbing shared by the Users, Roles, Groups and Permissions routers (T-017).
 *
 * Three things every route in the User Manager needs, kept in one place so they cannot drift:
 *   - `adminActorFrom` builds the `AdminActor` from VERIFIED request context only;
 *   - `numericIdOf` reproduces ASP.NET's `{id:long}` route constraint;
 *   - `parseOr422` / `readJsonBody` map a bad payload onto each domain's own error code.
 */
import { NO_ACTIVE_USER_MESSAGE } from '../../lib/auth/middleware.js';
import { AppError, InternalError, NotFoundError, UnauthorizedError } from '../../lib/errors/index.js';
import type { FieldError } from '../../lib/errors/index.js';
import type { ApiEnv } from '../../lib/router/env.js';
import { toFieldErrors } from '../../lib/validation/index.js';
import type { AdminActor } from './admin-context.js';

import type { Context } from 'hono';
import type { ZodType } from 'zod';

/**
 * The acting user, ambient tenant and per-request permission resolver.
 *
 * Every field comes from middleware that already verified it: `auth` from the token the auth
 * middleware validated (T-011), `tenant` from the membership/cross-tenant check the tenant
 * middleware performed (T-013), `resolveAccess` from `permissionResolution()` (T-012). Nothing here
 * reads a header. A missing resolver is a composition bug and fails CLOSED with a 500 rather than
 * silently evaluating every escalation ceiling against an empty permission set — which would make
 * `callerHoldsInAllScopes` deny everything, but would make `isWriteAccessible` deny global writes
 * for the wrong reason and is not a state this code should ever run in.
 */
export function adminActorFrom(c: Context<ApiEnv>): AdminActor {
  const auth = c.get('auth');
  if (auth === undefined) throw new UnauthorizedError(NO_ACTIVE_USER_MESSAGE);

  const resolveAccess = c.get('resolveAccess');
  if (resolveAccess === undefined) {
    throw new InternalError(
      'permissionResolution() middleware is not mounted; cannot evaluate assignment ceilings.',
    );
  }

  const tenant = c.get('tenant');
  const correlationId = c.get('correlationId');

  return {
    userId: Number(auth.userId),
    tenantId: tenant === undefined ? null : Number(tenant.tenantId),
    isCrossTenant: tenant?.isCrossTenant ?? false,
    resolveAccess,
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

/**
 * ASP.NET's `{id:long}` constraint: a non-numeric segment does not MATCH the route, so the caller
 * gets a routing 404 rather than a validation error. Hono has no constraint syntax, so the check is
 * explicit and raises the same 404 the app's `notFound` handler would have produced.
 */
export function numericIdOf(c: Context<ApiEnv>, param: string): number {
  const raw = c.req.param(param) ?? '';
  if (!/^\d+$/.test(raw)) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new NotFoundError(`No route matches ${c.req.method} ${c.req.path}.`);
  }
  return id;
}

export type ValidationErrorFactory = (fieldErrors: readonly FieldError[]) => AppError;

export function parseOr422<S extends ZodType>(
  schema: S,
  value: unknown,
  toError: ValidationErrorFactory,
): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) throw toError(toFieldErrors(result.error));
  return result.data as ReturnType<S['parse']>;
}

/**
 * Reads a JSON body. `optional` covers the reference's nullable request records
 * (`DisableRoleRequest? request`, GroupEndpoints' bodiless action posts): an absent or unparseable
 * body becomes `{}` there rather than a 400, and the schema's defaults then apply.
 */
export async function readJsonBody(
  c: Context<ApiEnv>,
  options: { readonly optional?: boolean } = {},
): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    if (options.optional === true) return {};
    throw new AppError(400, 'The request body could not be read as JSON.');
  }
}
