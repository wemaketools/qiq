/**
 * API-credential request/response contracts (T-022, AC-040; spec §12.6).
 *
 * Ported field-for-field from the reference DTOs so the existing SPA keeps working unchanged
 * (`src/ui/src/features/settings/settingsApi.ts:276-298` already declares exactly these shapes):
 *   `ApiCredentialDto(Id, BrokerId, ClientId, Status, CreatedAt, LastRotatedAt, DisabledAt)`
 *                                                                   — ApiAccessDtos.cs:13-20
 *   `CredentialSecretDto(Credential, ClientId, Secret)`             — :39
 *   `ApiCredentialListDto(Credentials)`                             — :42
 *
 * `clientId` NOW MEANS `key_id`, AND THAT IS THE WHOLE Q-19 RESHAPE ON THE WIRE
 * ============================================================================
 * In the reference this field carried the Keycloak confidential client id (`qiq-t{tenantId}` /
 * `qiq-t{tenantId}-b{brokerId}`, ApiCredentialClientId.cs). Keycloak is gone (A-4), so the field
 * now carries the key's PUBLIC lookup handle — `api_credentials.key_id`, the `qiq_…` prefix of the
 * issued key. Same field name, same "safe to display" property, same role in the reveal-once
 * envelope, so the SPA renders it under the same `Client ID:` label with no change. The value is no
 * longer derivable from the tenant/broker ids, which is an improvement: it is random, so it does
 * not disclose the tenant id to whoever holds the key.
 *
 * THE LIST ENVELOPE IS NOT PAGED, AND THAT IS MEASURED
 * ===================================================
 * `ApiCredentialListDto` is a bare `{ credentials: [...] }` — no `items`/`totalCount`/`page`
 * (:42), and `listApiCredentials` reads `list.credentials` directly (settingsApi.ts:301-304).
 * There is at most one credential per scope, so there is nothing to page. The house `totalCount`
 * envelope is deliberately NOT applied here; adding it would break the Settings tab.
 *
 * THERE ARE NO REQUEST BODIES. Provision, regenerate and disable are all bodyless POSTs in the
 * reference (ApiAccessEndpoints.cs:35-41) — scope comes from the route, never from a payload, which
 * is the same P-06 unspoofability rule the intake endpoint relies on.
 */
import { z } from 'zod';

/**
 * `ListAsync`'s `brokerId` query binding (ApiAccessEndpoints.cs:44). Optional; when present it
 * narrows the list to that broker's credential. An UNPARSEABLE value is a 422 through the ordinary
 * validation path rather than ASP.NET's binder 400 — the same reported deviation as the sibling
 * broker/reference-data ports.
 */
export const listCredentialsQuerySchema = z.object({
  brokerId: z
    .string()
    .optional()
    .refine((value) => value === undefined || /^\d+$/.test(value), {
      message: "InclusiveBetweenValidator|'Broker Id' must be a whole number.",
    })
    .transform((value) => (value === undefined ? undefined : Number(value))),
});

export type ListCredentialsQuery = z.infer<typeof listCredentialsQuerySchema>;

/** Wire shape of `ApiCredentialDto`. Deliberately carries NO secret and no hash/salt. */
export interface ApiCredentialDto {
  readonly id: number;
  readonly brokerId: number | null;
  /** The public key id (`api_credentials.key_id`). See the header for why it is named `clientId`. */
  readonly clientId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastRotatedAt: string | null;
  readonly disabledAt: string | null;
}

/**
 * Wire shape of `CredentialSecretDto` — the reveal-once envelope, returned by provision and
 * regenerate and by NOTHING else. `secret` is the full presentable key (`{keyId}.{secret}`), which
 * is what an integrator pastes into their client configuration.
 */
export interface CredentialSecretDto {
  readonly credential: ApiCredentialDto;
  readonly clientId: string;
  readonly secret: string;
}

/** Wire shape of `ApiCredentialListDto`. */
export interface ApiCredentialListDto {
  readonly credentials: readonly ApiCredentialDto[];
}
