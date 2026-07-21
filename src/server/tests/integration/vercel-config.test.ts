import { describe, expect, it } from 'vitest';

import { readJsonFile } from './helpers/repo.js';

interface VercelConfig {
  readonly crons?: unknown;
  readonly framework?: string;
  readonly functions?: Record<string, { readonly runtime?: string; readonly maxDuration?: number }>;
}

const vercelConfig = readJsonFile<VercelConfig>('vercel.json');

describe('vercel.json skeleton', () => {
  it('never registers Vercel crons (schedules are pg_cron entries in supabase/migrations, M-22)', () => {
    expect(Object.prototype.hasOwnProperty.call(vercelConfig, 'crons')).toBe(false);
  });

  it('keeps the Vite framework preset for the SPA build', () => {
    expect(vercelConfig.framework).toBe('vite');
  });

  it('declares function runtime and maxDuration configuration', () => {
    const functions = vercelConfig.functions ?? {};
    const entries = Object.values(functions);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.maxDuration).toBeTypeOf('number');
    }
  });
});
