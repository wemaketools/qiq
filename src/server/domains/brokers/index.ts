/**
 * Brokers and broker contacts: tenant-scoped CRUD, disable, and the exactly-one-primary-contact
 * discipline over `brokers`/`broker_contacts` (T-021).
 */
export {
  BROKER_CONTACT_ADDED_ACTION,
  BROKER_CONTACT_REMOVED_ACTION,
  BROKER_CONTACT_SET_PRIMARY_ACTION,
  BROKER_CONTACT_UPDATED_ACTION,
  BROKER_CREATED_ACTION,
  BROKER_DISABLED_ACTION,
  BROKER_UPDATED_ACTION,
  type BrokersActor,
  type BrokersDeps,
} from './service.js';
export { brokerRoutes } from './routes.js';
export type {
  BrokerContactDto,
  BrokerDetailDto,
  BrokerListDto,
  BrokerSummaryDto,
} from './schemas.js';

import { getDb } from '../../lib/db/index.js';
import type { BrokersDeps } from './service.js';

/**
 * Production wiring for the broker endpoints.
 *
 * Mirrors `defaultReferenceDataDeps()`. `getDb()` returns the process-wide pool and captures no
 * request state; the tenant is supplied per request by the route handlers from the verified
 * `TenantContext`, never from here.
 */
export function defaultBrokersDeps(): BrokersDeps {
  return { db: getDb() };
}
