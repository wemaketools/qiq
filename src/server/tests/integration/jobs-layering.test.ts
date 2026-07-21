/**
 * Layering guards for the job infrastructure (T-031).
 *
 * Two rules that are easy to state and easy to break silently months later:
 *
 * 1. THE IN-MEMORY QUEUE ADAPTER IS A TEST SEAM. If production code ever imports it, the drain
 *    endpoint stops using a durable queue and starts using a Map that dies with the function
 *    instance — messages would be "processed" and lost, with every test still green.
 *
 * 2. THE SPA MUST NOT CALL THE JOB ENDPOINTS (V-079). They are secret-protected server-to-server
 *    URLs; a reference in browser code would mean the secret is in the browser.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

function sourceFiles(directory: string, extensions = ['.ts', '.tsx']): string[] {
  const absolute = resolve(repoRoot, directory);
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (extensions.includes(extname(path))) found.push(path);
    }
  };

  walk(absolute);
  return found;
}

describe('in-memory queue adapter stays out of production code', () => {
  const productionFiles = [
    ...sourceFiles('src/server/jobs'),
    ...sourceFiles('api'),
    ...sourceFiles('scripts'),
  ].filter((path) => !path.includes('in-memory-adapter'));

  it('finds production files to check (guards against a vacuous scan)', () => {
    expect(productionFiles.length).toBeGreaterThan(10);
  });

  it.each(productionFiles.map((path) => [path.slice(repoRoot.length + 1), path]))(
    '%s does not import the in-memory adapter',
    (_label, path) => {
      expect(readFileSync(path, 'utf8')).not.toContain('in-memory-adapter');
    },
  );
});

describe('the SPA never references the job endpoints', () => {
  const uiFiles = sourceFiles('src/ui/src');

  it('finds SPA files to check (guards against a vacuous scan)', () => {
    expect(uiFiles.length).toBeGreaterThan(10);
  });

  it('contains no reference to /api/cron or /api/queue', () => {
    const offenders = uiFiles.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes('/api/cron') || source.includes('/api/queue');
    });
    expect(offenders.map((path) => path.slice(repoRoot.length + 1))).toEqual([]);
  });

  it('contains no reference to the job secrets', () => {
    const offenders = uiFiles.filter((path) => {
      const source = readFileSync(path, 'utf8');
      return source.includes('CRON_SECRET') || source.includes('INTERNAL_JOB_SECRET');
    });
    expect(offenders.map((path) => path.slice(repoRoot.length + 1))).toEqual([]);
  });
});
