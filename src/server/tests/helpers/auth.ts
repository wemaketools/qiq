/**
 * Real-session test fixtures (T-011, Q-21).
 *
 * EVERY authenticated integration test in this repository is expected to go through
 * `createTestUserWithSession()`. It mints a REAL session against the local Supabase Auth service
 * — admin-provision the identity, then sign in with the anon key — so the token under test is
 * byte-for-byte the token the SPA will send: ES256, real `kid`, real `iss`, real expiry. Nothing
 * about the auth path is mocked, which is the point: a hand-rolled token would prove nothing
 * about verification.
 *
 * Lifecycle contract:
 *   - one `TestAuthFixtures` per suite; `await fixtures.cleanup()` in `afterAll`.
 *   - cleanup deletes the app `users` row first, then the auth identity (users.auth_user_id is
 *     ON DELETE RESTRICT, so the reverse order fails).
 *   - construction sweeps identities left behind by a previously crashed run (same email prefix,
 *     older than STALE_AFTER_MS), so repeated runs cannot accumulate junk users.
 *   - every email is unique per (prefix, pid, timestamp, counter), so parallel vitest processes —
 *     T-005 runs concurrently — never collide.
 *
 * Tolerating `supabase db reset` underneath a run: fixtures are created per test/suite rather
 * than once globally, and `ensureAppUser` is an upsert, so a reset between tests costs a
 * re-create rather than a failure.
 */
import pg from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { LocalStack } from '../integration/helpers/local-stack.js';

export const TEST_EMAIL_PREFIX = 'quoteiq-test';
const STALE_AFTER_MS = 60 * 60 * 1000;
const SWEEP_PAGE_SIZE = 200;
const SWEEP_MAX_PAGES = 5;

let sequence = 0;

/**
 * GoTrue errors do not serialize through template interpolation (they render as `{}`), which cost
 * real debugging time when a concurrent `supabase db reset` restarted the stack mid-suite.
 */
function describeError(error: unknown): string {
  if (error === null || error === undefined) return 'unknown error';
  if (error instanceof Error) {
    const status: unknown = (error as { status?: unknown }).status;
    return status === undefined ? error.message : `${error.message} (status ${String(status)})`;
  }
  return JSON.stringify(error);
}

/**
 * T-005 runs `supabase db reset` concurrently with this suite. A single retry turns the resulting
 * transient Auth/DB unavailability into a slower pass instead of a spurious failure; a genuine
 * misconfiguration still fails on the second attempt.
 */
async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      }
    }
  }
  throw lastError;
}

function uniqueEmail(label: string): string {
  sequence += 1;
  return `${TEST_EMAIL_PREFIX}-${label}-${process.pid}-${Date.now()}-${sequence}@quoteiq.local`;
}

export interface TestUserSession {
  /** Supabase auth.users.id (uuid) — the `sub` claim. */
  readonly authUserId: string;
  /** Application users.id (bigint as string); null when the app row was deliberately skipped. */
  readonly appUserId: string | null;
  readonly email: string;
  readonly password: string;
  readonly accessToken: string;
  readonly refreshToken: string;
}

export interface CreateTestUserOptions {
  /** Distinguishes users within a suite; becomes part of the email. */
  readonly label?: string;
  /** users.is_active. Set false to exercise the deactivated-user rejection. */
  readonly isActive?: boolean;
  /** Skip the application `users` row entirely (auth identity with no app user). */
  readonly withAppUser?: boolean;
  readonly firstName?: string;
  readonly lastName?: string;
}

interface CreatedUser {
  readonly authUserId: string;
  readonly hasAppUser: boolean;
}

const UPSERT_APP_USER_SQL = `
  insert into users (auth_user_id, first_name, last_name, email, is_active,
                     created_at, updated_at)
  values ($1::uuid, $2, $3, $4, $5, now(), now())
  on conflict (auth_user_id) do update
     set first_name = excluded.first_name,
         last_name  = excluded.last_name,
         email      = excluded.email,
         is_active  = excluded.is_active,
         updated_at = now()
  returning id::text as id
`;

export class TestAuthFixtures {
  readonly #stack: LocalStack;
  readonly #admin: SupabaseClient;
  readonly #anon: SupabaseClient;
  readonly #pool: pg.Pool;
  readonly #created: CreatedUser[] = [];

  constructor(stack: LocalStack) {
    this.#stack = stack;
    this.#admin = createClient(stack.apiUrl, stack.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.#anon = createClient(stack.apiUrl, stack.anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    this.#pool = new pg.Pool({ connectionString: stack.dbUrl, max: 2 });
  }

  get adminClient(): SupabaseClient {
    return this.#admin;
  }

  get anonClient(): SupabaseClient {
    return this.#anon;
  }

  get stack(): LocalStack {
    return this.#stack;
  }

  /** Mints a real, signed-in session. The returned access token is what the SPA would send. */
  async createTestUserWithSession(options: CreateTestUserOptions = {}): Promise<TestUserSession> {
    const {
      label = 'user',
      isActive = true,
      withAppUser = true,
      firstName = 'Test',
      lastName = 'User',
    } = options;

    const email = uniqueEmail(label);
    // Long enough to satisfy any GoTrue password policy; unique so it is never a shared secret.
    const password = `Test-${crypto.randomUUID()}!aA1`;

    const authUserId = await withRetry(async () => {
      const created = await this.#admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error !== null || created.data.user === null) {
        throw new Error(`admin.createUser failed for ${email}: ${describeError(created.error)}`);
      }
      return created.data.user.id;
    });
    this.#created.push({ authUserId, hasAppUser: withAppUser });

    const appUserId = withAppUser
      ? await withRetry(() =>
          this.ensureAppUser({ authUserId, email, firstName, lastName, isActive }),
        )
      : null;

    const session = await withRetry(() => this.signIn(email, password));

    return {
      authUserId,
      appUserId,
      email,
      password,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    };
  }

  /** Idempotent: safe to re-run after a `supabase db reset` wiped the row. */
  async ensureAppUser(user: {
    authUserId: string;
    email: string;
    firstName: string;
    lastName: string;
    isActive: boolean;
  }): Promise<string> {
    const result = await this.#pool.query<{ id: string }>(UPSERT_APP_USER_SQL, [
      user.authUserId,
      user.firstName,
      user.lastName,
      user.email,
      user.isActive,
    ]);
    const row = result.rows[0];
    if (row === undefined) throw new Error(`Could not upsert app user for ${user.email}`);
    return row.id;
  }

  async setAppUserActive(authUserId: string, isActive: boolean): Promise<void> {
    await this.#pool.query('update users set is_active = $2, updated_at = now() where auth_user_id = $1::uuid', [
      authUserId,
      isActive,
    ]);
  }

  /** Signs in through the anon key exactly as the SPA does, returning a freshly issued session. */
  async signIn(
    email: string,
    password: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const { data, error } = await this.#anon.auth.signInWithPassword({ email, password });
    if (error !== null || data.session === null) {
      throw new Error(`signInWithPassword failed for ${email}: ${describeError(error)}`);
    }
    return { accessToken: data.session.access_token, refreshToken: data.session.refresh_token };
  }

  async query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.#pool.query<T>(sql, params);
    return result.rows;
  }

  /** Deletes everything this fixture created and releases the pool. Safe to call twice. */
  async cleanup(): Promise<void> {
    const created = this.#created.splice(0, this.#created.length);
    for (const user of created) {
      try {
        if (user.hasAppUser) {
          await this.#pool.query('delete from users where auth_user_id = $1::uuid', [
            user.authUserId,
          ]);
        }
        await this.#admin.auth.admin.deleteUser(user.authUserId);
      } catch {
        // A concurrent `supabase db reset` may already have removed the rows; that is the
        // desired end state either way, so cleanup never fails a suite.
      }
    }
    await this.#pool.end();
  }

  /**
   * Best-effort removal of identities orphaned by a crashed run. Bounded by page count so a huge
   * local auth schema cannot stall a suite.
   */
  async sweepStaleTestUsers(now: number = Date.now()): Promise<number> {
    let removed = 0;

    for (let page = 1; page <= SWEEP_MAX_PAGES; page += 1) {
      const { data, error } = await this.#admin.auth.admin.listUsers({
        page,
        perPage: SWEEP_PAGE_SIZE,
      });
      if (error !== null || data.users.length === 0) break;

      for (const user of data.users) {
        const email = user.email ?? '';
        if (!email.startsWith(`${TEST_EMAIL_PREFIX}-`)) continue;
        if (now - new Date(user.created_at).getTime() < STALE_AFTER_MS) continue;

        try {
          await this.#pool.query('delete from users where auth_user_id = $1::uuid', [user.id]);
          await this.#admin.auth.admin.deleteUser(user.id);
          removed += 1;
        } catch {
          // Ignore: the sweep is opportunistic hygiene, never a gate.
        }
      }

      if (data.users.length < SWEEP_PAGE_SIZE) break;
    }

    return removed;
  }
}
