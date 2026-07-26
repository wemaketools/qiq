/**
 * The storage port and its configuration-driven binding (T-027; A-6, Q-6, AC-058, V-074).
 *
 * SERVER ONLY. `SupabaseStorageAdapter` is constructed from the service-role client; nothing here
 * may be imported from `src/ui`.
 *
 * THE BINDING IS SELECTED BY CONFIGURATION, WHICH IS THE WHOLE POINT OF THE PORT
 * =============================================================================
 * `STORAGE_ADAPTER` picks the implementation and `STORAGE_ATTACHMENTS_BUCKET` names the bucket, both
 * through the typed config module (the only reader of the environment, AC-010). Domain code calls
 * `createStorageAdapter(config)` — or, in tests, is handed an adapter directly — and never names a
 * vendor, so adding an S3/MinIO binding later is a new file plus one arm of the switch below, with
 * zero domain-code changes. That claim is tested rather than asserted: the same conformance suite
 * runs against both bindings, and the attachment integration suite runs the whole envelope flow
 * against each.
 *
 * THE FAKE CANNOT BE SELECTED IN A DEPLOYED ENVIRONMENT
 * ====================================================
 * Nothing about `STORAGE_ADAPTER=fake` is safe in dev/preview/staging/production: objects would live in
 * one warm instance's memory, vanish on recycle, and be visible to every request that instance
 * serves. A misconfigured deploy must fail loudly at composition rather than silently accept
 * uploads it will lose, so selecting it outside `local` throws.
 */
import { getAdminClient } from '../supabase/clients.js';
import type { AppConfig } from '../config/index.js';
import { FakeStorageAdapter } from './fake-adapter.js';
import { SupabaseStorageAdapter } from './supabase-adapter.js';
import type { StorageAdapter } from './types.js';

export { attachmentTenantPrefix, buildAttachmentKey, sanitizeAttachmentFileName } from './keys.js';
export { FakeStorageAdapter } from './fake-adapter.js';
export { SupabaseStorageAdapter, SUPABASE_UPLOAD_TOKEN_TTL_SECONDS } from './supabase-adapter.js';
export type {
  CreateSignedDownloadOptions,
  CreateSignedUploadOptions,
  SignedDownloadTarget,
  SignedUploadTarget,
  StorageAdapter,
  StorageObjectInfo,
} from './types.js';

/**
 * Builds the configured adapter.
 *
 * @throws when the deployment selects the in-memory fake outside a local environment.
 */
export function createStorageAdapter(config: AppConfig): StorageAdapter {
  if (config.storage.adapter === 'fake') {
    if (config.appEnv !== 'local' && config.nodeEnv !== 'test') {
      throw new Error(
        `STORAGE_ADAPTER=fake is not permitted in the '${config.appEnv}' environment: ` +
          'the in-memory adapter loses every uploaded object when the instance recycles.',
      );
    }
    return new FakeStorageAdapter();
  }

  return new SupabaseStorageAdapter({
    // The service-role client. Its privilege is why the domain layer authorizes BEFORE it ever
    // reaches this adapter: nothing below this line performs a tenant check.
    client: getAdminClient(config),
    bucket: config.storage.attachmentsBucket,
  });
}
