import { DEMO_PASSWORD } from '../../../ui/src/auth/demoAccountList.js';

/**
 * The shared demo password for a LOCAL stack. Committed on purpose: it is documented in the README
 * and driven by the e2e suite, and a local Supabase stack grants nothing beyond the machine it runs
 * on. It must be at least `minimum_password_length` (6, supabase/config.toml) or the Auth Admin API
 * rejects the create, and well under GoTrue's 72-byte bcrypt cap.
 *
 * It is NOT a default for anywhere else. A hosted environment is reachable by anyone who learns its
 * URL, and this value is in the repository — see `resolveDemoPassword`.
 */
export const LOCAL_DEMO_PASSWORD = DEMO_PASSWORD;

export type DemoPasswordDecision =
  | { readonly ok: true; readonly password: string; readonly source: 'configured' | 'local-default' }
  | { readonly ok: false; readonly reason: string };

/**
 * Decides which password the demo personas get, and REFUSES rather than falling back to the
 * committed one outside local.
 *
 * The seed re-asserts every persona's password on each run (auth-users.ts), which is what makes a
 * rotated demo credential "heal" locally — and what silently re-published a known password on a
 * hosted environment every time anyone re-seeded it. Requiring DEMO_SEED_PASSWORD away from local
 * is what stops a re-seed from undoing a rotation.
 *
 * Pure, so the branch that matters can be tested exhaustively without a database or a stack.
 */
export function resolveDemoPassword(appEnv: string, configured: string | null): DemoPasswordDecision {
  const trimmed = configured?.trim() ?? '';
  if (trimmed !== '') return { ok: true, password: trimmed, source: 'configured' };

  if (appEnv === 'local') {
    return { ok: true, password: LOCAL_DEMO_PASSWORD, source: 'local-default' };
  }

  return {
    ok: false,
    reason:
      `Refusing to seed demo personas into "${appEnv}" with the committed local password.\n` +
      `That value (${LOCAL_DEMO_PASSWORD}) is in the repository, and this seed re-asserts it on ` +
      'every run — so a rotated password would be undone and re-published each time.\n\n' +
      'Set DEMO_SEED_PASSWORD for this environment and re-run.',
  };
}
