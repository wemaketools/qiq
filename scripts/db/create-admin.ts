#!/usr/bin/env tsx
/**
 * Creates the FIRST sign-in account for an environment (the bootstrap admin).
 *
 * WHY THIS EXISTS: the baseline seed provisions the permission catalog and the global reference
 * template and deliberately no users, so a freshly migrated environment has nothing to sign in
 * with — and User Manager, which is how accounts are normally created, requires being signed in.
 * That circularity has to be broken once per environment, out of band, by an operator holding the
 * service-role key. This is that one break, and nothing else should use it.
 *
 * WHAT IT CREATES: an INTERNAL, zero-tenant user holding every permission in the catalog as
 * direct grants in the GLOBAL scope (`user_permissions.tenant_id IS NULL`). That shape is the
 * product's own (FR-16 / AC-030 permit a zero-tenant user precisely for Internal callers), and it
 * is what lets the account then create tenants and users through the UI rather than through more
 * scripts.
 *
 * Usage:
 *   npm run db:admin:create -- --email you@example.com
 *   npm run db:admin:create -- --email you@example.com --env=production
 *
 * The password is GENERATED and printed once unless --password is given. It is a bootstrap
 * credential: sign in, then change it (Supabase Auth, or the app's own reset flow). Re-running
 * re-asserts the password and the grants, so a forgotten one is recoverable.
 *
 * SAFETY: same gate as the seeds — a non-local target must be NAMED with --env, and the named
 * environment must match the loaded configuration. See scripts/db/seed-target.ts.
 */
import { randomBytes } from 'node:crypto';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';

import { getConfig, ConfigurationError, type AppConfig } from '../../src/server/lib/config/index.js';
import { decideSeedTarget } from './seed-target.js';

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): never {
  process.stderr.write(`\nADMIN CREATION FAILED\n${message}\n`);
  process.exit(1);
}

function flag(argv: readonly string[], name: string): string | null {
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? '';
}

/** URL-safe, no ambiguous characters to misread when it is copied out of a terminal once. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

interface AdminUser {
  readonly id: string;
  readonly email?: string;
}

/** Create-if-absent, then re-assert the password — so a re-run heals a forgotten credential. */
async function provisionAuthIdentity(
  admin: SupabaseClient,
  email: string,
  password: string,
): Promise<{ authUserId: string; created: boolean }> {
  const existing = new Map<string, string>();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error !== null) throw new Error(`listUsers failed: ${error.message}`);
    const users = data.users as AdminUser[];
    for (const user of users) {
      if (user.email !== undefined) existing.set(user.email.toLowerCase(), user.id);
    }
    if (users.length < 200) break;
  }

  const found = existing.get(email.toLowerCase());
  if (found !== undefined) {
    const { error } = await admin.auth.admin.updateUserById(found, {
      password,
      email_confirm: true,
      ban_duration: 'none',
    });
    if (error !== null) throw new Error(`updateUserById failed: ${error.message}`);
    return { authUserId: found, created: false };
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { bootstrap: true },
  });
  if (error !== null || data.user === null) {
    throw new Error(`createUser failed: ${error?.message ?? 'no user returned'}`);
  }
  return { authUserId: data.user.id, created: true };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const email = flag(argv, 'email');
  if (email === null || email.trim() === '') {
    fail('An --email is required.\nUsage: npm run db:admin:create -- --email you@example.com');
  }

  const firstName = flag(argv, 'first') ?? 'QuoteIQ';
  const lastName = flag(argv, 'last') ?? 'Admin';
  const password = flag(argv, 'password') ?? generatePassword();
  const generated = flag(argv, 'password') === null;

  let config: AppConfig;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof ConfigurationError) {
      fail(
        `${error.message}\n\nCreating an admin needs SUPABASE_DIRECT_DATABASE_URL, SUPABASE_URL ` +
          'and SUPABASE_SERVICE_ROLE_KEY.',
      );
    }
    throw error;
  }

  const decision = decideSeedTarget(config.appEnv, flag(argv, 'env'));
  if (!decision.allowed) {
    process.stderr.write(`\n${decision.reason}\n`);
    process.exit(1);
  }

  log('Bootstrap admin (Internal, zero-tenant, all permissions in the global scope)');
  log(`  target environment: ${decision.appEnv}`);
  log(`  email             : ${email}`);

  // 1. The Auth identity first: users.auth_user_id is NOT NULL and references auth.users.
  const admin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let authUserId: string;
  let created: boolean;
  try {
    ({ authUserId, created } = await provisionAuthIdentity(admin, email, password));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  log(`  auth identity     : ${created ? 'created' : 'reused (password re-asserted)'}`);

  // 2. The application row and its grants, in ONE transaction: a user that exists in auth but has
  //    no permissions can sign in and then see nothing, which is a worse state than not existing.
  const client = new pg.Client({ connectionString: config.database.directUrl });
  await client.connect();

  let userId: number;
  let permissionCount: number;
  try {
    await client.query('begin');

    const upserted = await client.query<{ id: string }>(
      `insert into public.users (auth_user_id, first_name, last_name, email, is_active,
                                 created_at, updated_at)
            values ($1, $2, $3, $4, true, now(), now())
       on conflict (auth_user_id) do update
               set first_name = excluded.first_name,
                   last_name  = excluded.last_name,
                   email      = excluded.email,
                   is_active  = true,
                   updated_at = now()
         returning id`,
      [authUserId, firstName, lastName, email],
    );

    const returnedId = upserted.rows[0]?.id;
    if (returnedId === undefined) throw new Error('the users row did not return an id');
    userId = Number(returnedId);

    // Every catalog permission, granted directly in the GLOBAL scope (tenant_id null). Read from
    // the `permissions` table rather than a list here, so this cannot drift from the catalog.
    //
    // REPLACE, not ON CONFLICT DO NOTHING. `uq_user_permissions_user_permission_tenant` is
    // UNIQUE (user_id, permission_code, tenant_id), and tenant_id is NULL for a global grant —
    // in a UNIQUE constraint NULL never equals NULL, so these rows do not conflict with each
    // other and the upsert silently duplicated every permission on each run (observed: 81 -> 162).
    // Clearing the user's global grants first is what actually converges, and it also drops a
    // permission that has since left the catalog.
    await client.query(
      'delete from public.user_permissions where user_id = $1 and tenant_id is null',
      [userId],
    );
    await client.query(
      `insert into public.user_permissions (user_id, permission_code, tenant_id, created_at)
            select $1, p.code, null, now() from public.permissions p`,
      [userId],
    );

    const total = await client.query<{ n: string }>(
      'select count(*)::text as n from public.user_permissions where user_id = $1 and tenant_id is null',
      [userId],
    );
    permissionCount = Number(total.rows[0]?.n ?? 0);

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    fail(`Writing the application user failed; the transaction was rolled back.\n${message}`);
  } finally {
    await client.end();
  }

  log(`  users.id          : ${String(userId)}`);
  log(`  permissions       : ${String(permissionCount)} (global scope)`);
  log('');
  log('OK: bootstrap admin ready. Sign in with:');
  log(`  email    : ${email}`);
  log(`  password : ${password}`);
  if (generated) {
    log('');
    log('This password was generated and is shown ONCE. Change it after signing in;');
    log('re-running this command re-asserts a new one if it is lost.');
  }
}

await main();
