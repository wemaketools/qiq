/**
 * API-access credential administration: the Q-19 first-party hashed API keys behind
 * `/settings/api-credentials`, plus the verification seam intake authenticates with (T-022).
 */
export {
  API_CREDENTIAL_DISABLED_ACTION,
  API_CREDENTIAL_PROVISIONED_ACTION,
  API_CREDENTIAL_REGENERATED_ACTION,
  disableCredential,
  listCredentials,
  provisionCredential,
  recordApiKeyUse,
  regenerateSecret,
  verifyApiKey,
  type ApiAccessActor,
  type ApiAccessDeps,
  type ApiKeyVerificationFailure,
  type ApiKeyVerificationReason,
  type CredentialContext,
} from './service.js';
export { apiAccessRoutes } from './routes.js';
export type {
  ApiCredentialDto,
  ApiCredentialListDto,
  CredentialSecretDto,
} from './schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { AppConfig } from '../../lib/config/index.js';
import type { ApiAccessDeps } from './service.js';

/**
 * Production wiring for the API-credential endpoints.
 *
 * Takes `config` — unlike its sibling factories — because the key pepper is a static-tier secret
 * (A-5) and the typed config module is the only thing allowed to read the environment (AC-010).
 * Threading it through here is what keeps `keys.ts` and `service.ts` free of `process.env`.
 *
 * `getDb()` returns the process-wide pool and captures no request state; the tenant is supplied per
 * request by the route handlers from the verified `TenantContext`, never from here.
 */
export function defaultApiAccessDeps(config: AppConfig): ApiAccessDeps {
  return { db: getDb(), apiKeyPepper: config.secrets.apiKeyPepper };
}
