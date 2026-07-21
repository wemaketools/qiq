/**
 * Supabase Auth Admin provisioning (T-017, AC-017, AC-031; V-021, V-041; A-4, spec §13).
 *
 * SERVER ONLY. This module is the ONLY place in the User Manager that touches the service-role
 * client (`lib/supabase/clients.ts:getAdminClient`), which bypasses RLS and every Auth restriction.
 * The key is read exclusively through the typed config module, is never logged, and never appears in
 * an error surfaced to a client — the import-boundary suite proves `src/ui` cannot reach any of it.
 *
 * WHAT REPLACED KEYCLOAK, AND WHAT THAT CHANGED
 * =============================================
 * The reference used `IKeycloakAdminService` with three operations, all reproduced here:
 *
 *   CreateUserAsync(email, first, last)     -> `auth.admin.createUser`
 *   SendResetPasswordEmailAsync(id)         -> `auth.admin.generateLink({ type: 'recovery' })`
 *   SetUserEnabledAsync(id, enabled)        -> `auth.admin.updateUserById({ ban_duration })`
 *
 * GoTrue has no `enabled` flag; BANNING is its disable primitive, and a banned identity is refused
 * at sign-in (which is what AC-029 asks for). `'none'` lifts it, which is the reactivation path.
 *
 * THE INITIAL PASSWORD IS RANDOM AND IS NEVER RETURNED
 * ===================================================
 * `createUser` requires a password (or an invite flow). A cryptographically random one is generated
 * server-side, used once, and discarded: it is not returned to the caller, not logged, and not
 * stored. The user reaches their account through the recovery link, exactly as the Keycloak flow's
 * reset-password email worked. Returning a temporary password in the create response would put a
 * live credential in a browser, a proxy log, and the SPA's Redux devtools.
 *
 * `sendRecoveryEmail` is BEST EFFORT, mirroring CreateUserCommandHandler.cs:240-252: a mail-delivery
 * failure (no SMTP configured on a local stack, for instance) must not roll back an otherwise
 * successful account creation. The outcome is reported as `emailSent` on the response — the SPA
 * already renders that field — rather than swallowed silently.
 */
import { getAdminClient } from '../../lib/supabase/index.js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Long enough to satisfy any GoTrue policy, random so it is never a shared or guessable secret, and
 * deliberately SHORT ENOUGH: GoTrue hashes with bcrypt, which silently caps at 72 BYTES and rejects
 * anything longer, so two concatenated uuids (76 chars) fails every create with an opaque error.
 * One uuid plus the character-class prefix is 40 chars and ~122 bits of entropy.
 */
function generateInitialPassword(): string {
  return `Aa1!${crypto.randomUUID()}`;
}

/** GoTrue's "banned indefinitely"; `'none'` is the documented value that lifts a ban. */
const INDEFINITE_BAN = '876000h';
const NO_BAN = 'none';

export interface ProvisionAuthUserInput {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
}

/**
 * The Auth Admin operations the User Manager needs. An interface rather than a direct client call
 * so the failure paths AC-031/V-041 require (provisioning failure must leave no half-created app
 * user) can be forced deterministically in the integration suite without breaking the local stack
 * for every other test — the real implementation below is what production and the happy-path tests
 * both run.
 */
export interface AuthAdminPort {
  /** Creates the identity and returns its `auth.users.id` uuid. Throws on failure. */
  createUser(input: ProvisionAuthUserInput): Promise<string>;
  /** Compensating delete, used when the app-side transaction fails after provisioning. */
  deleteUser(authUserId: string): Promise<void>;
  /** Bans (disables) or unbans the identity. A banned identity cannot sign in. */
  setDisabled(authUserId: string, disabled: boolean): Promise<void>;
  /** Best-effort initial-credential email. Returns false instead of throwing. */
  sendRecoveryEmail(email: string): Promise<boolean>;
}

/**
 * Errors from GoTrue are re-thrown with their message only. The message describes the auth-side
 * failure (e.g. a duplicate email) and never carries the service-role key; the caller maps it onto
 * a typed domain error, and the error boundary sanitizes anything unexpected into a 500.
 */
function describeAuthError(error: { message?: string } | null): string {
  return error?.message ?? 'unknown Supabase Auth Admin failure';
}

export function createSupabaseAuthAdmin(client: SupabaseClient = getAdminClient()): AuthAdminPort {
  return {
    async createUser(input) {
      const { data, error } = await client.auth.admin.createUser({
        email: input.email,
        password: generateInitialPassword(),
        // The administrator vouched for the address by entering it; requiring the invitee to
        // confirm before they can even use the recovery link would strand every created account.
        email_confirm: true,
        user_metadata: { first_name: input.firstName, last_name: input.lastName },
      });

      if (error !== null || data.user === null) {
        throw new Error(`Supabase Auth Admin createUser failed: ${describeAuthError(error)}`);
      }
      return data.user.id;
    },

    async deleteUser(authUserId) {
      const { error } = await client.auth.admin.deleteUser(authUserId);
      if (error !== null) {
        throw new Error(`Supabase Auth Admin deleteUser failed: ${describeAuthError(error)}`);
      }
    },

    async setDisabled(authUserId, disabled) {
      const { error } = await client.auth.admin.updateUserById(authUserId, {
        ban_duration: disabled ? INDEFINITE_BAN : NO_BAN,
      });
      if (error !== null) {
        throw new Error(`Supabase Auth Admin updateUserById failed: ${describeAuthError(error)}`);
      }
    },

    async sendRecoveryEmail(email) {
      try {
        const { error } = await client.auth.admin.generateLink({ type: 'recovery', email });
        return error === null;
      } catch {
        return false;
      }
    },
  };
}
