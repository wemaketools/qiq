import { describe, expect, it } from 'vitest';
import { API_BASE_URL } from './client';

/**
 * Regression guard for the local dev wiring (T-018): the SPA calls the API on a relative path, so
 * `npm run dev` only works if the Vite dev server proxies that exact prefix to the local function
 * runner (scripts/dev/serve-api.ts, fixed port 3001).
 *
 * This asserts the configuration, not the running server — the live end-to-end check (`npm run dev`
 * then `GET http://localhost:5173/api/v1/health` returning the API's JSON rather than Vite's
 * index.html fallback) is recorded in the task file as a manual verification step, and is what
 * V-043's e2e run exercises for real.
 */
const VITE_CONFIG = import.meta.glob<string>('../../vite.config.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const source = VITE_CONFIG['../../vite.config.ts'] ?? '';

describe('vite dev server API proxy', () => {
  it('loads the vite config source', () => {
    expect(source).not.toBe('');
  });

  it('proxies the exact API base path the client calls', () => {
    // If API_BASE_URL ever changes, this fails rather than silently leaving dev broken.
    expect(API_BASE_URL).toBe('/api/v1');
    expect(source).toMatch(/'\/api\/v1':\s*\{\s*target:/);
  });

  it('also proxies the cron endpoints for manual local testing', () => {
    expect(source).toMatch(/'\/api\/cron':\s*\{\s*target:/);
  });

  it('defaults the proxy target to the local function runner port', () => {
    expect(source).toContain("'http://127.0.0.1:3001'");
  });

  it('does not proxy the whole /api prefix indiscriminately', () => {
    expect(source).not.toMatch(/'\/api':\s*\{/);
  });
});
