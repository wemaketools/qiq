/**
 * Server-to-server lead intake: `POST /intake/leads` (T-030; spec P-06, Q-19, §13 Intake).
 *
 * The ONLY externally-reachable write ingress in this application that does not run behind a
 * Supabase session, and the only consumer of `verifyApiKey`.
 */
export { API_KEY_HEADER, INTAKE_UNAUTHORIZED_CODE, INTAKE_UNAUTHORIZED_MESSAGE } from './auth.js';
export { intakeRoutes, type IntakeRouteDeps } from './routes.js';
export {
  BROKER_NOT_ALLOWED_CODE,
  DUPLICATE_LEADS_CODE,
  type IntakeOutcomeDto,
  type IntakeWarningDto,
} from './schemas.js';

import { defaultApiAccessDeps } from '../api-access/index.js';
import { defaultLeadsDeps } from '../leads/index.js';
import type { AppConfig } from '../../lib/config/index.js';
import type { IntakeRouteDeps } from './routes.js';

/**
 * Production wiring for the intake ingress.
 *
 * Takes `config` for the same reason `defaultApiAccessDeps` does — the key pepper is a static-tier
 * secret (A-5) and the typed config module is the only permitted reader of the environment
 * (AC-010). Composed FROM the two sibling factories rather than rebuilding their deps, so intake
 * can never end up verifying against a different pepper than the one credentials were issued under.
 */
export function defaultIntakeDeps(config: AppConfig): IntakeRouteDeps {
  return { apiAccess: defaultApiAccessDeps(config), leads: defaultLeadsDeps() };
}
