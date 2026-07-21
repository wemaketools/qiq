/**
 * Where the seed is allowed to run (T-006, M-11: the seed is "never run automatically in
 * production", and per Q-8 the same script must still be usable AS a deliberate deploy step).
 *
 * Those two requirements are reconciled by a confirmation flag rather than a hard block: a local
 * target runs unattended, anything else runs only when the operator names the exact environment
 * they are pointing at. Naming it is the point — `--env=production` cannot be typed by accident,
 * and it cannot be satisfied by a stale flag left in shell history when the credentials underneath
 * have changed, because the flag must MATCH the environment the loaded configuration resolves to.
 *
 * Kept separate from seed.ts, and free of any database or environment access, so the dangerous
 * branch is exhaustively unit-testable without a database.
 */
import { appEnvValues, type AppEnv } from '../../src/server/lib/config/index.js';

export type SeedTargetDecision =
  | { readonly allowed: true; readonly appEnv: AppEnv }
  | { readonly allowed: false; readonly reason: string };

/** The operator-facing instruction for confirming a non-local target. */
export function nonLocalRefusalHint(appEnv: string): string {
  return (
    `Refusing to seed: the loaded configuration targets APP_ENV="${appEnv}", which is not a local ` +
    'database. Seeding a deployed environment must be deliberate, so re-run it naming that ' +
    `environment explicitly:\n  npm run db:seed -- --env=${appEnv}`
  );
}

function isAppEnv(value: string): value is AppEnv {
  return (appEnvValues as readonly string[]).includes(value);
}

/**
 * @param appEnv        the environment the loaded configuration resolves to (config.appEnv)
 * @param confirmedEnv  the value of `--env=...`, or null when the flag was not supplied
 */
export function decideSeedTarget(appEnv: AppEnv, confirmedEnv: string | null): SeedTargetDecision {
  if (confirmedEnv !== null && confirmedEnv !== appEnv) {
    const named = isAppEnv(confirmedEnv) ? `"${confirmedEnv}"` : `"${confirmedEnv}" (not a known environment)`;
    return {
      allowed: false,
      reason:
        `Refusing to seed: --env=${confirmedEnv} names ${named}, but the loaded configuration ` +
        `targets APP_ENV="${appEnv}". Point the configuration at the environment you meant, or ` +
        'correct the flag — the two must agree.',
    };
  }

  if (appEnv !== 'local' && confirmedEnv === null) {
    return { allowed: false, reason: nonLocalRefusalHint(appEnv) };
  }

  return { allowed: true, appEnv };
}
