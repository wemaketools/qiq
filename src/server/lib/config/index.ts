/**
 * Typed, validated, server-only configuration (spec §16, A-5 tier 1, AC-010).
 *
 * This is the ONLY module in the repository permitted to read the process environment; a lint
 * rule (`no-restricted-properties` in eslint.config.js) and a repository test
 * (src/server/tests/integration/config-env-access.test.ts) enforce that.
 *
 * Never import this from `src/ui` — it carries server-only secrets.
 */
import {
  configSchema,
  requiredEnvVars,
  toAppConfig,
  type AppConfig,
  type RawConfig,
} from './schema.js';

export type {
  AppConfig,
  AppEnv,
  LogLevel,
  NodeEnvName,
  RawConfig,
} from './schema.js';
export { appEnvValues, logLevelValues, optionalEnvVars, requiredEnvVars } from './schema.js';

/** Thrown when the environment cannot produce a complete, valid configuration. */
export class ConfigurationError extends Error {
  /** Names of the offending environment variables, for tests and operator tooling. */
  readonly variables: readonly string[];

  constructor(message: string, variables: readonly string[]) {
    super(message);
    this.name = 'ConfigurationError';
    this.variables = variables;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

/** Treats unset and blank values identically so a blank Vercel variable fails loudly. */
function normalize(env: EnvSource): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (value.trim() === '') continue;
    normalized[key] = value;
  }
  return normalized;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates an environment map and returns the typed configuration.
 * Throws `ConfigurationError` listing every problem — never returns a partial config.
 */
export function loadConfig(env: EnvSource): AppConfig {
  const normalized = normalize(env);
  const result = configSchema.safeParse(normalized);

  if (result.success) {
    return deepFreeze(toAppConfig(result.data as RawConfig));
  }

  const problems: string[] = [];
  const variables: string[] = [];

  for (const issue of result.error.issues) {
    const name = String(issue.path[0] ?? '(unknown variable)');
    if (variables.includes(name)) continue;
    variables.push(name);
    const missing = normalized[name] === undefined && requiredEnvVars.includes(name as never);
    problems.push(`  - ${name}: ${missing ? 'is required but was not set' : issue.message}`);
  }

  const message = [
    `Invalid server configuration (${problems.length} problem${problems.length === 1 ? '' : 's'}):`,
    ...problems,
    'Set these in .env.local for local development, or as Vercel Environment Variables for',
    'deployed environments. See .env.example for the full catalog.',
  ].join('\n');

  throw new ConfigurationError(message, variables);
}

let cached: AppConfig | null = null;

/**
 * Returns the process configuration, parsing the environment once per cold start.
 * A failed parse is not cached, so a corrected environment recovers without a restart.
 */
export function getConfig(): AppConfig {
  if (cached === null) {
    // The single sanctioned read of the process environment (AC-010); every other module
    // goes through getConfig(). eslint.config.js allow-lists this file for that reason.
    cached = loadConfig(process.env);
  }
  return cached;
}

/**
 * Non-throwing accessor for callers that must keep working with an invalid environment —
 * notably the logger, which has to be able to report the configuration failure itself.
 * Business code must use `getConfig()` so that misconfiguration fails fast.
 */
export function tryGetConfig(): AppConfig | null {
  try {
    return getConfig();
  } catch {
    return null;
  }
}

/** Test-only: clears the per-process cache. */
export function resetConfigCache(): void {
  cached = null;
}
