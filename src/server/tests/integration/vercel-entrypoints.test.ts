import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

/**
 * Every file under api/ must export Web `fetch`-style NAMED HTTP METHODS, never `export default`.
 *
 * WHY THIS EXISTS: the whole codebase is written against the Web platform — handlers take a
 * `Request` and return a `Response`, and the suites drive the Hono app that way directly. Vercel's
 * Node runtime, however, invokes a DEFAULT export with the legacy `(req, res)` signature and
 * discards its return value. Nothing in the repository exercised that boundary, so the mismatch
 * shipped and every deployed function failed in one of two silent ways:
 *
 *   - cron/queue: `TypeError: request.headers.get is not a function` — an IncomingMessage was
 *     passed where a Request was expected, so authorization threw before any job ran;
 *   - /api/v1/*: the handler built a correct Response, returned it, and the runtime ignored it,
 *     leaving the request to hang until the 30s timeout.
 *
 * Both were invisible to 3750 passing tests, because the suites never go through Vercel's
 * invocation contract. This test IS that contract, asserted statically so it costs nothing and
 * cannot be skipped by a missing stack.
 */

const API_ROOT = resolve(repoRoot, 'api');
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

function listEntrypoints(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listEntrypoints(path));
    else if (entry.name.endsWith('.ts')) found.push(path);
  }
  return found.sort();
}

const entrypoints = listEntrypoints(API_ROOT).map((path) => ({
  path,
  relative: relative(repoRoot, path),
  source: readFileSync(path, 'utf8'),
}));

/** Only real export statements — a `export default` inside a comment must not count either way. */
function exportedMethods(source: string): string[] {
  return HTTP_METHODS.filter((method) =>
    new RegExp(`^export\\s+(?:async\\s+function|const|function)\\s+${method}\\b`, 'm').test(source),
  );
}

function hasDefaultExport(source: string): boolean {
  return /^export\s+default\b/m.test(source);
}

describe('Vercel function entrypoints honour the platform invocation contract', () => {
  it('finds the entrypoints at all, so an empty glob cannot pass this suite vacuously', () => {
    expect(entrypoints.length).toBeGreaterThanOrEqual(6);
  });

  it.each(entrypoints.map((e) => e.relative))('%s does not use `export default`', (rel) => {
    const entry = entrypoints.find((e) => e.relative === rel);
    expect(
      hasDefaultExport(entry?.source ?? ''),
      'Vercel calls a default export as (req, res) and ignores its return value; export a named ' +
        'HTTP method instead',
    ).toBe(false);
  });

  it.each(entrypoints.map((e) => e.relative))('%s exports at least one HTTP method', (rel) => {
    const entry = entrypoints.find((e) => e.relative === rel);
    expect(exportedMethods(entry?.source ?? '')).not.toHaveLength(0);
  });

  it('serves the versioned API catch-all on every method the router can answer', () => {
    const catchAll = entrypoints.find((e) => e.relative === 'api/v1/index.ts');
    expect(catchAll, 'the /api/v1 catch-all entrypoint was not found').toBeDefined();

    // One function serves the whole surface, so an unlisted verb is a platform 405 that never
    // reaches Hono — the router would answer it, but the request never arrives.
    expect(exportedMethods(catchAll?.source ?? '')).toEqual([...HTTP_METHODS]);
  });

  it('reaches the cron endpoints by GET, which is what invoke_cron_endpoint sends', () => {
    const cron = entrypoints.filter((e) => e.relative.startsWith('api/cron/'));
    expect(cron.length).toBeGreaterThanOrEqual(4);
    for (const entry of cron) {
      expect(exportedMethods(entry.source), `${entry.relative} must export GET`).toContain('GET');
    }
  });

  it('reaches the queue drain by POST, which is what invoke_queue_drain sends', () => {
    const drain = entrypoints.find((e) => e.relative === 'api/queue/drain.ts');
    expect(drain, 'api/queue/drain.ts was not found').toBeDefined();
    expect(exportedMethods(drain?.source ?? '')).toContain('POST');
  });
});

/**
 * The SECOND way the deployed API died while every suite stayed green: reaching the function at all.
 *
 * Vercel's zero-config `api/` filesystem routing (this is a Vite SPA, not Next.js) has NO catch-all
 * filename syntax. `api/v1/[...segments].ts` — and `[[...segments]].ts` before it — both compile to
 * `"src": "^/api/v1/([^/]+)$"`, i.e. exactly ONE path segment. `/api/v1/leads` reached Hono while
 * `/api/v1/leads/1`, `/api/v1/dashboards/executive` and `/api/v1/me/preferences` got Vercel's own
 * NOT_FOUND page before the function was invoked. So the whole surface depends on the `rewrites`
 * entry below, not on the filename — and nothing but a real `vercel build` would otherwise notice
 * if it were dropped.
 */
describe('vercel.json routes the whole /api/v1 surface to the one function', () => {
  const vercelConfig = JSON.parse(readFileSync(resolve(repoRoot, 'vercel.json'), 'utf8')) as {
    rewrites?: { source: string; destination: string }[];
    functions?: Record<string, unknown>;
  };

  it('declares the entrypoint under its real, bracket-free filename', () => {
    expect(Object.keys(vercelConfig.functions ?? {})).toContain('api/v1/index.ts');
  });

  it('rewrites every nested /api/v1 path to the entrypoint, not just one segment', () => {
    const apiRewrite = vercelConfig.rewrites?.find((r) => r.destination === '/api/v1');
    expect(
      apiRewrite,
      'without this rewrite Vercel serves only /api/v1/{one-segment} and 404s everything deeper',
    ).toBeDefined();
    expect(apiRewrite?.source).toBe('/api/v1/:path*');
  });

  it('falls back to the SPA shell for client routes without swallowing /api', () => {
    const rewrites = vercelConfig.rewrites ?? [];
    const spaFallback = rewrites.find((r) => r.destination === '/index.html');
    expect(spaFallback, 'deep links and hard refreshes 404 without an SPA fallback').toBeDefined();
    // The lookahead is what keeps /api/* on the API; ordering alone would not survive a reshuffle.
    expect(spaFallback?.source).toBe('/((?!api/).*)');
    expect(rewrites.indexOf(spaFallback!)).toBeGreaterThan(
      rewrites.findIndex((r) => r.destination === '/api/v1'),
    );
  });
});
