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

export const appEnvValues = ['local', 'preview', 'staging', 'production'] as const;
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

  DATABASE_URL: postgresUrl(),
  DIRECT_DATABASE_URL: postgresUrl(),

  SUPABASE_URL: httpUrl(),
  SUPABASE_ANON_KEY: secret(),
  SUPABASE_SERVICE_ROLE_KEY: secret(),

  CRON_SECRET: secret(),
  INTERNAL_JOB_SECRET: secret(),
  API_KEY_PEPPER: secret(MIN_PEPPER_LENGTH),

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
  'DATABASE_URL',
  'DIRECT_DATABASE_URL',
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
}

/** Maps the flat validated env record onto the nested `AppConfig` shape. */
export function toAppConfig(raw: RawConfig): AppConfig {
  return {
    nodeEnv: raw.NODE_ENV,
    appEnv: raw.APP_ENV,
    logLevel: raw.LOG_LEVEL,
    database: {
      url: raw.DATABASE_URL,
      directUrl: raw.DIRECT_DATABASE_URL,
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
  };
}
