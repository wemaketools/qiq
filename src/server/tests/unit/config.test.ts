import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigurationError,
  getConfig,
  loadConfig,
  requiredEnvVars,
  resetConfigCache,
  tryGetConfig,
} from '../../lib/config/index.js';

/** A complete, valid environment. Every value is obviously synthetic. */
function validEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    APP_ENV: 'preview',
    LOG_LEVEL: 'debug',
    DATABASE_URL: 'postgresql://postgres:pooler-pass@db.example.supabase.co:6543/postgres',
    DIRECT_DATABASE_URL: 'postgresql://postgres:direct-pass@db.example.supabase.co:5432/postgres',
    SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key-value-for-tests',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-value-for-tests',
    CRON_SECRET: 'cron-secret-value-for-tests',
    INTERNAL_JOB_SECRET: 'internal-job-secret-value-for-tests',
    API_KEY_PEPPER: 'pepper-value-with-enough-entropy-for-tests',
  };
}

function envWithout(key: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = validEnv();
  delete env[key];
  return env;
}

function expectConfigError(env: Record<string, string | undefined>): ConfigurationError {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as ConfigurationError;
  }
  throw new Error('expected loadConfig to throw ConfigurationError, but it returned a value');
}

describe('loadConfig — happy path', () => {
  it('parses a complete environment into a typed config object', () => {
    const config = loadConfig(validEnv());

    expect(config.nodeEnv).toBe('test');
    expect(config.appEnv).toBe('preview');
    expect(config.logLevel).toBe('debug');
    expect(config.database.url).toBe(
      'postgresql://postgres:pooler-pass@db.example.supabase.co:6543/postgres',
    );
    expect(config.database.directUrl).toBe(
      'postgresql://postgres:direct-pass@db.example.supabase.co:5432/postgres',
    );
    expect(config.supabase.url).toBe('https://abcdefghijklmnop.supabase.co');
    expect(config.supabase.anonKey).toBe('anon-key-value-for-tests');
    expect(config.supabase.serviceRoleKey).toBe('service-role-key-value-for-tests');
    expect(config.secrets.cronSecret).toBe('cron-secret-value-for-tests');
    expect(config.secrets.internalJobSecret).toBe('internal-job-secret-value-for-tests');
    expect(config.secrets.apiKeyPepper).toBe('pepper-value-with-enough-entropy-for-tests');
  });

  it('applies documented defaults when optional variables are absent', () => {
    const env = validEnv();
    delete (env as Record<string, string | undefined>).APP_ENV;
    delete (env as Record<string, string | undefined>).NODE_ENV;
    delete (env as Record<string, string | undefined>).LOG_LEVEL;

    const config = loadConfig(env);

    expect(config.appEnv).toBe('local');
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
  });

  it('trims surrounding whitespace from secret values', () => {
    const env = validEnv();
    env.CRON_SECRET = '  cron-secret-value-for-tests  ';

    expect(loadConfig(env).secrets.cronSecret).toBe('cron-secret-value-for-tests');
  });

  it('ignores unrelated environment variables instead of failing on them', () => {
    const env: Record<string, string> = { ...validEnv(), SOME_UNRELATED_VAR: 'whatever' };

    expect(() => loadConfig(env)).not.toThrow();
  });

  it('returns a deeply frozen config so callers cannot mutate shared state', () => {
    const config = loadConfig(validEnv());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.supabase)).toBe(true);
    expect(Object.isFrozen(config.secrets)).toBe(true);
  });

  it('does not expose SUPABASE_JWT_SECRET (A-10) or ERROR_TRACKING_DSN (Q-13)', () => {
    const serialized = JSON.stringify(loadConfig(validEnv()));

    expect(serialized).not.toMatch(/jwtSecret/i);
    expect(serialized).not.toMatch(/errorTracking/i);
    expect(requiredEnvVars).not.toContain('SUPABASE_JWT_SECRET');
    expect(requiredEnvVars).not.toContain('ERROR_TRACKING_DSN');
  });
});

describe('loadConfig — fail fast on missing variables', () => {
  it.each(requiredEnvVars)('throws naming %s when it is absent', (name) => {
    const error = expectConfigError(envWithout(name));

    expect(error.message).toContain(name);
    expect(error.message).toMatch(/is required but was not set/);
    expect(error.variables).toContain(name);
  });

  it.each(['', '   '])('treats the empty-ish value %j as missing', (value) => {
    const env = validEnv();
    env.CRON_SECRET = value;

    const error = expectConfigError(env);

    expect(error.message).toContain('CRON_SECRET');
    expect(error.message).toMatch(/is required but was not set/);
  });

  it('reports every problem at once rather than only the first', () => {
    const env: Record<string, string | undefined> = validEnv();
    delete env.DATABASE_URL;
    delete env.CRON_SECRET;
    delete env.SUPABASE_URL;

    const error = expectConfigError(env);

    expect(error.variables).toEqual(
      expect.arrayContaining(['DATABASE_URL', 'CRON_SECRET', 'SUPABASE_URL']),
    );
    expect(error.message).toContain('3 problem');
  });

  it('produces an actionable message pointing at the env files', () => {
    const error = expectConfigError(envWithout('DATABASE_URL'));

    expect(error.message).toContain('.env.local');
    expect(error.message).toContain('.env.example');
    expect(error.name).toBe('ConfigurationError');
  });

  it('never leaks a secret value into the error message', () => {
    const env = validEnv();
    env.APP_ENV = 'prod';

    const error = expectConfigError(env);

    expect(error.message).not.toContain('service-role-key-value-for-tests');
    expect(error.message).not.toContain('cron-secret-value-for-tests');
    expect(error.message).not.toContain('pooler-pass');
  });
});

describe('loadConfig — fail fast on malformed variables', () => {
  it.each([
    ['DATABASE_URL', 'not-a-connection-string'],
    ['DATABASE_URL', 'https://db.example.com/postgres'],
    ['DIRECT_DATABASE_URL', 'mysql://user:pass@host:3306/db'],
  ])('rejects %s when it is not a postgres connection string (%s)', (name, value) => {
    const env = validEnv();
    env[name] = value;

    const error = expectConfigError(env);

    expect(error.variables).toContain(name);
    expect(error.message).toMatch(/postgres/i);
  });

  it.each(['not-a-url', 'ftp://example.com', 'supabase.co'])(
    'rejects SUPABASE_URL value %j',
    (value) => {
      const env = validEnv();
      env.SUPABASE_URL = value;

      const error = expectConfigError(env);

      expect(error.variables).toContain('SUPABASE_URL');
      expect(error.message).toMatch(/http/i);
    },
  );

  it('rejects an unknown APP_ENV and lists the allowed values', () => {
    const env = validEnv();
    env.APP_ENV = 'prod';

    const error = expectConfigError(env);

    expect(error.variables).toContain('APP_ENV');
    expect(error.message).toContain('local');
    expect(error.message).toContain('preview');
    expect(error.message).toContain('staging');
    expect(error.message).toContain('production');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    const env = validEnv();
    env.LOG_LEVEL = 'verbose';

    expect(expectConfigError(env).variables).toContain('LOG_LEVEL');
  });

  it('rejects an API_KEY_PEPPER that is too short to be a credible secret', () => {
    const env = validEnv();
    env.API_KEY_PEPPER = 'short';

    const error = expectConfigError(env);

    expect(error.variables).toContain('API_KEY_PEPPER');
    expect(error.message).toMatch(/16/);
  });

  it('accepts a postgres:// scheme as well as postgresql://', () => {
    const env = validEnv();
    env.DATABASE_URL = 'postgres://postgres:pw@127.0.0.1:54322/postgres';

    expect(loadConfig(env).database.url).toBe('postgres://postgres:pw@127.0.0.1:54322/postgres');
  });
});

describe('getConfig — process-level accessor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigCache();
  });

  function stubValidEnv(): void {
    for (const [key, value] of Object.entries(validEnv())) {
      vi.stubEnv(key, value);
    }
  }

  it('reads process.env and caches the parsed result per cold start', () => {
    stubValidEnv();
    resetConfigCache();

    const first = getConfig();
    const second = getConfig();

    expect(first.appEnv).toBe('preview');
    expect(second).toBe(first);
  });

  it('re-reads the environment after resetConfigCache', () => {
    stubValidEnv();
    resetConfigCache();
    const first = getConfig();

    vi.stubEnv('APP_ENV', 'staging');
    resetConfigCache();
    const second = getConfig();

    expect(second).not.toBe(first);
    expect(second.appEnv).toBe('staging');
  });

  it('throws instead of returning a partially populated config', () => {
    stubValidEnv();
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    resetConfigCache();

    expect(() => getConfig()).toThrow(ConfigurationError);
    expect(() => getConfig()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('does not cache a failed parse', () => {
    stubValidEnv();
    vi.stubEnv('CRON_SECRET', '');
    resetConfigCache();

    expect(() => getConfig()).toThrow(ConfigurationError);

    vi.stubEnv('CRON_SECRET', 'cron-secret-value-for-tests');
    expect(() => getConfig()).not.toThrow();
  });

  it('tryGetConfig returns null on an invalid environment instead of throwing', () => {
    stubValidEnv();
    vi.stubEnv('DATABASE_URL', '');
    resetConfigCache();

    expect(tryGetConfig()).toBeNull();
  });

  it('tryGetConfig returns the config on a valid environment', () => {
    stubValidEnv();
    resetConfigCache();

    expect(tryGetConfig()?.appEnv).toBe('preview');
  });
});
