/**
 * Per-request context shared by every middleware and route handler.
 *
 * Kept in its own module so domain route files can type their `Hono<ApiEnv>` without importing the
 * app factory (which would be a cycle: app.ts composes the domain routers).
 */
import type { CredentialContext } from '../../domains/api-access/service.js';
import type { AuthContext } from '../auth/context.js';
import type { EffectiveAccessResolver } from '../auth/require-permission.js';
import type { Logger } from '../logging/index.js';
import type { TenantContext } from '../tenancy/context.js';

export interface RequestVariables {
  /** Inbound `x-correlation-id` when safe, otherwise a fresh UUID. Always present. */
  correlationId: string;
  /** Request-scoped logger already carrying the correlation id. Always present. */
  logger: Logger;
  /** Set by the authentication middleware (T-011). */
  userId?: string;
  /** Full authenticated principal, set alongside `userId` by the auth middleware (T-011). */
  auth?: AuthContext;
  /**
   * Verified tenant id as a string, set by the tenant-context middleware (T-013). Present only on
   * tenant-scoped routes, and only after server-side verification — never the raw header value.
   */
  tenantId?: string;
  /** Full verified tenant context, set alongside `tenantId` by the tenant middleware (T-013). */
  tenant?: TenantContext;
  /**
   * Per-request effective-permission resolver, installed by `permissionResolution()` (T-012).
   * Memoized for THIS request only — see require-permission.ts for why it can never be shared.
   */
  resolveAccess?: EffectiveAccessResolver;
  /**
   * The credential a first-party API key resolved to, set by `apiKeyAuth()` on the intake ingress
   * ONLY (T-030). It is the sole principal on that route: its `tenantId` and `brokerId` come from
   * the `api_credentials` row, never from a header or a body field, which is what makes intake
   * scoping unspoofable (P-06). No other middleware in this app ever sets it, so a handler reading
   * it necessarily ran behind API-key authentication.
   */
  credential?: CredentialContext;
}

export interface ApiEnv {
  Variables: RequestVariables;
}
