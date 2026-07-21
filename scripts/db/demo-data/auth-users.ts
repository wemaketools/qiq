/**
 * Demo Auth identity provisioning (T-041, Q-21a, AC-085).
 *
 * The e2e suite (T-043) signs in as these personas with a KNOWN password, so this is load-bearing:
 * every persona must have a local Supabase Auth identity, and `users.auth_user_id` must link to it.
 * Provisioning goes through the Auth Admin API with the service-role key (server-only, A-4) and is
 * CREATE-IF-ABSENT so re-running converges — a second run reuses the existing identity rather than
 * failing on a duplicate email, and re-asserts the known password so a rotated demo password heals.
 *
 * The one deactivated persona is BANNED via the Admin API so its sign-in fails, mirroring the
 * deactivate-not-delete contract (AC-029) the demo is meant to showcase.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { DEMO_PASSWORD, PERSONAS } from './catalog.js';

export interface AuthProvisionResult {
  /** persona key -> auth.users.id (uuid). */
  readonly byPersona: Map<string, string>;
  readonly created: number;
  readonly reused: number;
}

interface AdminUser {
  readonly id: string;
  readonly email?: string;
}

async function listAllUsers(admin: SupabaseClient): Promise<Map<string, string>> {
  const byEmail = new Map<string, string>();
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error !== null) throw new Error(`listUsers failed: ${error.message}`);
    const users = data.users as AdminUser[];
    for (const user of users) {
      if (user.email !== undefined) byEmail.set(user.email.toLowerCase(), user.id);
    }
    if (users.length < 200) break;
  }
  return byEmail;
}

export async function provisionDemoAuthUsers(config: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
}): Promise<AuthProvisionResult> {
  const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existing = await listAllUsers(admin);
  const byPersona = new Map<string, string>();
  let created = 0;
  let reused = 0;

  for (const persona of PERSONAS) {
    const email = persona.email.toLowerCase();
    const isActive = persona.isActive ?? true;
    let userId = existing.get(email);

    if (userId === undefined) {
      const { data, error } = await admin.auth.admin.createUser({
        email: persona.email,
        password: DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { firstName: persona.firstName, lastName: persona.lastName, demo: true },
      });
      if (error !== null || data.user === null) {
        throw new Error(`createUser failed for ${persona.email}: ${error?.message ?? 'no user returned'}`);
      }
      userId = data.user.id;
      created += 1;
    } else {
      // Re-assert the known password and confirmation so the persona can always sign in.
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password: DEMO_PASSWORD,
        email_confirm: true,
      });
      if (error !== null) {
        throw new Error(`updateUserById failed for ${persona.email}: ${error.message}`);
      }
      reused += 1;
    }

    // Deactivated persona: ban so sign-in is refused; active personas are explicitly un-banned in
    // case a previous run banned this email.
    const { error: banError } = await admin.auth.admin.updateUserById(userId, {
      ban_duration: isActive ? 'none' : '876000h',
    });
    if (banError !== null) {
      throw new Error(`ban toggle failed for ${persona.email}: ${banError.message}`);
    }

    byPersona.set(persona.key, userId);
  }

  return { byPersona, created, reused };
}

/**
 * Inverse of `provisionDemoAuthUsers`: deletes the demo persona auth identities. Used by the
 * demo-seed integration test so its run leaves zero residue (the seed's data rows are removed
 * separately; this removes the Supabase Auth identities they were linked to). Best-effort and
 * idempotent — an already-absent identity is fine. Callers MUST delete the app `users` rows that
 * reference these identities (users.auth_user_id is ON DELETE RESTRICT) BEFORE calling this.
 */
export async function deprovisionDemoAuthUsers(config: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
}): Promise<number> {
  const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const existing = await listAllUsers(admin);
  let removed = 0;
  for (const persona of PERSONAS) {
    const userId = existing.get(persona.email.toLowerCase());
    if (userId === undefined) continue;
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error === null) removed += 1;
  }
  return removed;
}
