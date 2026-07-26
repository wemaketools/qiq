import { z } from 'zod';

/**
 * Static-tier configuration schema (spec A-5, tier 1: Vercel Sensitive Environment Variables).
 *
 * Deliberately absent:
 * - `SUPABASE_JWT_SECRET` — token verification uses asymmetric signing keys via
 *   `auth.getClaims()` (A-10), so the legacy shared secret has no consumer.
 * - `ERROR_TRACKING_DSN` — error tracking is disabled for MVP (Q-13).
 * - Any Supabase Vault (tier 2) surface — deferred with no MVP consumer (Q-23).
 */

// Ordered by deployment lifecycle, which is also the order they are listed back in a validation
// error. `dev` is the shared qiq-dev project the `dev` branch deploys to; `staging` is retained
// for a pre-production tier that does not exist yet. Nothing branches on any individual value —
// the only behavioural distinction drawn anywhere is `!== 'local'` (see lib/storage/index.ts and
// lib/router/app.ts) — so a new tier here is a LABEL, and its cost is the `job_run.environment`
// check constraint that has to list it (supabase/migrations/*_job_run_environment_dev.sql).
export const appEnvValues = ['local', 'dev', 'preview', 'staging', 'production'] as const;
export type AppEnv = (typeof appEnvValues)[number];

export const nodeEnvValues = ['development', 'test', 'production'] as const;
export type NodeEnvName = (typeof nodeEnvValues)[number];

export const logLevelValues = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof logLevelValues)[number];

/** Minimum length for the Q-19 API-key pepper; short peppers offer no meaningful protection. */
export const MIN_PEPPER_LENGTH = 16;

/** Selectable `StorageAdapter` bindings (A-6/Q-6). `fake` is local/test only. */
export const storageAdapterValues = ['supabase', 'fake'] as const;
export type StorageAdapterName = (typeof storageAdapterValues)[number];

/** The private attachments bucket, provisioned by supabase/migrations/*_storage_buckets.sql. */
export const DEFAULT_ATTACHMENTS_BUCKET = 'quote-attachments';

function hasProtocol(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * True when the value parses as a URL whose path is empty — i.e. an origin.
 *
 * Parsing is guarded because zod runs EVERY refinement, not just up to the first failure: an
 * unparseable value still reaches this check after the protocol check has already rejected it, and
 * an exception thrown here escapes validation entirely. The operator would then see a bare
 * "Invalid URL" instead of a message naming the variable — which is precisely the diagnosis this
 * config module exists to provide.
 */
function isOriginOnly(value: string): boolean {
  try {
    return new URL(value).pathname === '/';
  } catch {
    return false;
  }
}

function secret(minLength = 1, label = 'must be a non-empty value'): z.ZodType<string> {
  return z
    .string({ error: 'must be a string' })
    .transform((value) => value.trim())
    .refine((value) => value.length >= minLength, {
      error: minLength > 1 ? `must be at least ${minLength} characters long` : label,
    });
}

function postgresUrl(): z.ZodType<string> {
  return z
    .string({ error: 'must be a string' })
    .transform((value) => value.trim())
    .refine((value) => hasProtocol(value, ['postgres:', 'postgresql:']), {
      error: 'must be a postgres:// or postgresql:// connection string',
    });
}

function httpUrl(): z.ZodType<string> {
  return z
    .string({ error: 'must be a string' })
    .transform((value) => value.trim())
    .refine((value) => hasProtocol(value, ['http:', 'https:']), {
      error: 'must be an absolute http:// or https:// URL',
    });
}

/**
 * Makes an optional variable tolerate an EMPTY value as well as an absent one.
 *
 * `.optional()` alone only skips `undefined`. A secret store that holds the key with a blank value
 * — which is how "not applicable here" is usually expressed in a shared config, and how it reaches
 * Vercel — supplies `''`, which then runs the full validation and fails. For an OPTIONAL variable
 * that is a hard startup failure caused by a variable nobody needed: the config module validates
 * the whole catalog at once, so one blank entry takes down every function.
 *
 * Blank therefore means absent. It is only ever used for genuinely optional variables, so there is
 * no case where a blank should have been rejected instead.
 */
function blankAsAbsent<T extends z.ZodTypeAny>(schema: T): z.ZodType<z.output<T> | undefined> {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    schema.optional(),
  ) as z.ZodType<z.output<T> | undefined>;
}

function choice<const T extends readonly [string, ...string[]]>(
  values: T,
  fallback: T[number],
): z.ZodType<T[number]> {
  return z
    .enum(values, { error: `must be one of: ${values.join(', ')}` })
    .default(fallback) as unknown as z.ZodType<T[number]>;
}

export const configSchema = z.object({
  NODE_ENV: choice(nodeEnvValues, 'development'),
  APP_ENV: choice(appEnvValues, 'local'),
  LOG_LEVEL: choice(logLevelValues, 'info'),

  SUPABASE_DATABASE_URL: postgresUrl(),
  SUPABASE_DIRECT_DATABASE_URL: postgresUrl(),

  SUPABASE_URL: httpUrl(),
  SUPABASE_ANON_KEY: secret(),
  SUPABASE_SERVICE_ROLE_KEY: secret(),

  CRON_SECRET: secret(),
  INTERNAL_JOB_SECRET: secret(),
  API_KEY_PEPPER: secret(MIN_PEPPER_LENGTH),

  // Origin the pg_cron -> pg_net schedules call back on, consumed ONLY by
  // `npm run db:cron:configure` when it writes public.job_cron_config. Optional because it has no
  // sensible default and local development has no deployed origin to call: the schedules are
  // documented no-ops there (Q-7). The configure script fails loudly if it is missing.
  //
  // Must be an ORIGIN, not a URL with a path, and must not end in a slash — invoke_cron_endpoint()
  // concatenates `base_url || '/api/cron/' || job_name`, so a trailing slash yields a double slash
  // and a path segment yields a 404 that only shows up at 03:00 in the Postgres log.
  JOB_CRON_BASE_URL: blankAsAbsent(
    z
      .string({ error: 'must be a string' })
    .transform((value) => value.trim())
    .refine((value) => hasProtocol(value, ['http:', 'https:']), {
      error: 'must be an absolute http:// or https:// URL',
    })
    .refine((value) => !value.endsWith('/'), { error: 'must not end with a trailing slash' })
      .refine(isOriginOnly, {
        error: 'must be an origin only, with no path',
      }),
  ),

  // Password the demo seed gives its personas. Read ONLY by `npm run db:seed:demo`, never by the
  // application. Optional because a local stack falls back to the committed default; away from
  // local the seed refuses without it, rather than re-publishing a password that lives in this
  // repository — see resolveDemoPassword() in scripts/db/demo-data/catalog.ts.
  //
  // Minimum 6 to match `minimum_password_length` in supabase/config.toml; the Auth Admin API
  // rejects anything shorter and the seed would fail halfway through provisioning identities.
  DEMO_SEED_PASSWORD: blankAsAbsent(
    secret(6, 'must be at least 6 characters (Supabase minimum_password_length)'),
  ),

  // Storage port binding (T-027, A-6/Q-6). Defaulted, so no deployment must set them to get the
  // approved default behaviour; `fake` is refused outside local by createStorageAdapter().
  STORAGE_ADAPTER: choice(storageAdapterValues, 'supabase'),
  STORAGE_ATTACHMENTS_BUCKET: z
    .string({ error: 'must be a string' })
    .transform((value) => value.trim())
    .refine((value) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(value), {
      error: 'must be a lower-case bucket name (letters, digits and dashes)',
    })
    .default(DEFAULT_ATTACHMENTS_BUCKET),
});

export type RawConfig = z.infer<typeof configSchema>;

/**
 * Variables with no default. Absence of any of these is a hard startup failure.
 * Used by tests and by docs generation; keep in sync with `configSchema`.
 */
export const requiredEnvVars = [
  'SUPABASE_DATABASE_URL',
  'SUPABASE_DIRECT_DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CRON_SECRET',
  'INTERNAL_JOB_SECRET',
  'API_KEY_PEPPER',
] as const;

export const optionalEnvVars = [
  'NODE_ENV',
  'APP_ENV',
  'LOG_LEVEL',
  'JOB_CRON_BASE_URL',
  'DEMO_SEED_PASSWORD',
  'STORAGE_ADAPTER',
  'STORAGE_ATTACHMENTS_BUCKET',
] as const;

/** The typed configuration consumed by server code. */
export interface AppConfig {
  readonly nodeEnv: NodeEnvName;
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  readonly database: {
    /** Pooled connection (Supavisor transaction mode) used by serverless request handlers. */
    readonly url: string;
    /** Direct connection used for migrations and admin tooling. */
    readonly directUrl: string;
  };
  readonly supabase: {
    readonly url: string;
    readonly anonKey: string;
    readonly serviceRoleKey: string;
  };
  readonly secrets: {
    readonly cronSecret: string;
    readonly internalJobSecret: string;
    readonly apiKeyPepper: string;
  };
  /** Storage port binding (A-6). Carries no credential: the adapter reads the service-role key. */
  readonly storage: {
    readonly adapter: StorageAdapterName;
    readonly attachmentsBucket: string;
  };
  readonly seed: {
    /** Demo persona password. `null` locally, where the committed default applies. */
    readonly demoPassword: string | null;
  };
  readonly jobs: {
    /**
     * Origin the pg_cron schedules call back on. `null` when unset, which is the normal state
     * locally; only `db:cron:configure` reads it, and it refuses rather than inventing one.
     */
    readonly cronBaseUrl: string | null;
  };
}

/** Maps the flat validated env record onto the nested `AppConfig` shape. */
export function toAppConfig(raw: RawConfig): AppConfig {
  return {
    nodeEnv: raw.NODE_ENV,
    appEnv: raw.APP_ENV,
    logLevel: raw.LOG_LEVEL,
    database: {
      url: raw.SUPABASE_DATABASE_URL,
      directUrl: raw.SUPABASE_DIRECT_DATABASE_URL,
    },
    supabase: {
      url: raw.SUPABASE_URL,
      anonKey: raw.SUPABASE_ANON_KEY,
      serviceRoleKey: raw.SUPABASE_SERVICE_ROLE_KEY,
    },
    secrets: {
      cronSecret: raw.CRON_SECRET,
      internalJobSecret: raw.INTERNAL_JOB_SECRET,
      apiKeyPepper: raw.API_KEY_PEPPER,
    },
    storage: {
      adapter: raw.STORAGE_ADAPTER,
      attachmentsBucket: raw.STORAGE_ATTACHMENTS_BUCKET,
    },
    seed: {
      demoPassword: raw.DEMO_SEED_PASSWORD ?? null,
    },
    jobs: {
      cronBaseUrl: raw.JOB_CRON_BASE_URL ?? null,
    },
  };
}
