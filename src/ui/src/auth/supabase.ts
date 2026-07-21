import { createClient } from '@supabase/supabase-js';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

/**
 * The SPA's single browser Supabase client — **authentication only** (spec §10 "Auth layer", A-4,
 * M-25). It replaces the retired `oidc-client-ts`/Keycloak layer.
 *
 * The client is built from `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`, the only two
 * browser-safe values in the environment catalog. The anon key is exposed to the browser *by
 * design*, and only because Supabase Auth (GoTrue) needs it; the application's data path stays
 * exclusively `/api/v1`, so this module never touches the Supabase Data API, Storage, or Realtime,
 * and the service-role key never comes anywhere near `src/ui` (AC-017, V-021).
 *
 * Session persistence and access-token refresh are delegated to supabase-js (`persistSession` +
 * `autoRefreshToken`, AC-033): a reload restores the session, and a rotated token is picked up by
 * the next `getAccessToken()` call because the API client reads the token *per request* rather
 * than caching one at module init.
 */

/** SPA route showing the email/password sign-in form. */
export const SIGN_IN_ROUTE = '/sign-in';
/** SPA route for requesting a reset email. */
export const FORGOT_PASSWORD_ROUTE = '/forgot-password';
/** SPA route GoTrue's recovery link returns to; also the `redirectTo` sent with the reset request. */
export const RESET_PASSWORD_ROUTE = '/reset-password';

/**
 * The single message rendered for *every* sign-in failure (spec §16, P-01, AC-032). Wrong password,
 * unknown account, unconfirmed email, and transport failure are indistinguishable to the caller, so
 * the form cannot be used to enumerate accounts.
 */
export const GENERIC_SIGN_IN_FAILURE = 'Sign-in failed. Check your details and try again.';

/** Shown after a reset request regardless of whether the address belongs to an account (AC-032). */
export const UNIFORM_RESET_CONFIRMATION =
  'If an account exists for that email address, a password reset link is on its way.';

/** Reset completion can only fail for reasons the user can act on; provider detail is not echoed. */
export const GENERIC_RESET_FAILURE = 'That reset link is no longer valid. Request a new one and try again.';

export type AuthOutcome = { ok: true } | { ok: false; message: string };

let client: SupabaseClient | null = null;

function requiredEnv(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string {
  const value = import.meta.env[name] as string | undefined;
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Copy .env.local.example to .env.local and fill it from \`npx supabase status\`.`,
    );
  }
  return value;
}

/**
 * The one Supabase client instance in the SPA, created lazily so importing this module (in tests,
 * or from a route that never authenticates) does not require the environment to be configured.
 */
export function getSupabaseClient(): SupabaseClient {
  if (client === null) {
    client = createClient(requiredEnv('VITE_SUPABASE_URL'), requiredEnv('VITE_SUPABASE_ANON_KEY'), {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // GoTrue returns the recovery/confirmation tokens in the URL fragment; the client must
        // consume them so /reset-password has a session to call `updateUser` with.
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
  }
  return client;
}

export async function getCurrentSession(): Promise<Session | null> {
  const { data } = await getSupabaseClient().auth.getSession();
  return data.session ?? null;
}

/**
 * The current access token, re-read on every call. `getSession()` transparently refreshes an
 * expired token, which is what keeps long-lived tabs working without a user-visible interruption.
 */
export async function getAccessToken(): Promise<string | null> {
  const session = await getCurrentSession();
  return session?.access_token ?? null;
}

export async function signInWithPassword(email: string, password: string): Promise<AuthOutcome> {
  try {
    const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
    // Deliberately ignores `error.message`: see GENERIC_SIGN_IN_FAILURE.
    return error === null ? { ok: true } : { ok: false, message: GENERIC_SIGN_IN_FAILURE };
  } catch {
    return { ok: false, message: GENERIC_SIGN_IN_FAILURE };
  }
}

/**
 * Requests a reset email. Resolves identically whether or not the address exists, and whether or
 * not GoTrue reported a problem — the caller has nothing to branch on, which is the point.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  try {
    await getSupabaseClient().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}${RESET_PASSWORD_ROUTE}`,
    });
  } catch {
    // Swallowed on purpose (AC-032).
  }
}

export async function completePasswordReset(newPassword: string): Promise<AuthOutcome> {
  try {
    const { error } = await getSupabaseClient().auth.updateUser({ password: newPassword });
    return error === null ? { ok: true } : { ok: false, message: GENERIC_RESET_FAILURE };
  } catch {
    return { ok: false, message: GENERIC_RESET_FAILURE };
  }
}

/**
 * Subscribes to Supabase auth-state transitions (sign-in, sign-out, token refresh) and returns the
 * unsubscribe function, so callers do not have to know supabase-js's nested subscription shape.
 */
export function onAuthStateChange(handler: (event: string, session: Session | null) => void): () => void {
  const { data } = getSupabaseClient().auth.onAuthStateChange((event, session) => {
    handler(event, session);
  });
  return () => data.subscription.unsubscribe();
}

/**
 * Guards against several concurrent API failures each starting their own navigation. Mirrors the
 * in-flight-promise idiom the retired OIDC layer used for the same reason.
 */
let reauthInFlight: Promise<void> | null = null;

/**
 * Ends the Supabase session and sends the browser to the sign-in page. Used both by the sign-out
 * menu action and by the API client's 401 handling (the token is missing, expired beyond refresh,
 * or the caller has no active application user behind it — either way, re-authenticate rather than
 * surfacing a confusing in-app error).
 */
export async function handleUnauthorized(): Promise<void> {
  reauthInFlight ??= (async () => {
    try {
      await getSupabaseClient().auth.signOut();
    } catch {
      // A failed sign-out must not prevent the redirect.
    }
    window.location.assign(SIGN_IN_ROUTE);
  })().finally(() => {
    reauthInFlight = null;
  });
  return reauthInFlight;
}

export async function signOut(): Promise<void> {
  return handleUnauthorized();
}
