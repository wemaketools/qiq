import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../lib/config/index.js';

/**
 * An OPTIONAL variable set to an empty value must be treated as absent, not as an invalid value.
 *
 * WHY: `.optional()` only skips `undefined`. A secret store holding the key with a blank value —
 * which is how "not applicable in this environment" is normally expressed in a shared config, and
 * exactly how it reaches Vercel — supplies `''`. That would then run the full validation, fail, and
 * because the config module validates the WHOLE catalog at once, take down every function in the
 * environment. A variable nobody needed would be a total outage.
 *
 * This came from a real near-miss: DEMO_SEED_PASSWORD was deliberately left blank in the production
 * config (the demo seed must never run there), which would have broken production on the next
 * deploy.
 */

const BASE = {
  SUPABASE_DATABASE_URL: 'postgresql://127.0.0.1:5432/postgres',
  SUPABASE_DIRECT_DATABASE_URL: 'postgresql://127.0.0.1:5432/postgres',
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  CRON_SECRET: 'cron',
  INTERNAL_JOB_SECRET: 'internal',
  API_KEY_PEPPER: '0123456789abcdef',
} as const;

const BLANKS = ['', ' ', '   ', '\t'] as const;

describe('optional configuration variables treat blank as absent', () => {
  it.each(BLANKS)('DEMO_SEED_PASSWORD=%j parses as absent rather than failing validation', (blank) => {
    const config = loadConfig({ ...BASE, DEMO_SEED_PASSWORD: blank });

    expect(config.seed.demoPassword).toBeNull();
  });

  it.each(BLANKS)('JOB_CRON_BASE_URL=%j parses as absent rather than failing validation', (blank) => {
    const config = loadConfig({ ...BASE, JOB_CRON_BASE_URL: blank });

    expect(config.jobs.cronBaseUrl).toBeNull();
  });

  it('is indistinguishable from omitting them entirely', () => {
    const blank = loadConfig({ ...BASE, DEMO_SEED_PASSWORD: '', JOB_CRON_BASE_URL: '' });
    const absent = loadConfig({ ...BASE });

    expect(blank.seed.demoPassword).toBe(absent.seed.demoPassword);
    expect(blank.jobs.cronBaseUrl).toBe(absent.jobs.cronBaseUrl);
  });

  it('still carries a value that IS set', () => {
    const config = loadConfig({
      ...BASE,
      DEMO_SEED_PASSWORD: 'a-real-demo-password',
      JOB_CRON_BASE_URL: 'https://qiq.example.com',
    });

    expect(config.seed.demoPassword).toBe('a-real-demo-password');
    expect(config.jobs.cronBaseUrl).toBe('https://qiq.example.com');
  });

  // Blank is forgiven; WRONG is not. Treating "absent" leniently must not weaken the checks that
  // catch a misconfigured value, which is the failure this leniency could otherwise mask.
  it('still rejects a password below the Supabase minimum length', () => {
    expect(() => loadConfig({ ...BASE, DEMO_SEED_PASSWORD: 'short' })).toThrow(/DEMO_SEED_PASSWORD/);
  });

  it('still rejects a base URL that is not an absolute origin', () => {
    expect(() => loadConfig({ ...BASE, JOB_CRON_BASE_URL: 'not-a-url' })).toThrow(
      /JOB_CRON_BASE_URL/,
    );
  });

  it('still rejects a base URL carrying a path or a trailing slash', () => {
    expect(() => loadConfig({ ...BASE, JOB_CRON_BASE_URL: 'https://qiq.example.com/' })).toThrow(
      /JOB_CRON_BASE_URL/,
    );
    expect(() => loadConfig({ ...BASE, JOB_CRON_BASE_URL: 'https://qiq.example.com/api' })).toThrow(
      /JOB_CRON_BASE_URL/,
    );
  });

  it('does not extend the leniency to REQUIRED variables', () => {
    // A blank required variable is a genuine misconfiguration and must still fail loudly.
    expect(() => loadConfig({ ...BASE, API_KEY_PEPPER: '' })).toThrow(/API_KEY_PEPPER/);
    expect(() => loadConfig({ ...BASE, SUPABASE_URL: '' })).toThrow(/SUPABASE_URL/);
  });
});
