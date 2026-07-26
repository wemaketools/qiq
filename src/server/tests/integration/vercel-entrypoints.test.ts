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
    const catchAll = entrypoints.find((e) => e.relative.includes('segments'));
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
