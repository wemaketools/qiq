import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

const requiredDirectories = [
  'api/v1',
  'api/cron',
  'api/queue',
  'src/server/lib/config',
  'src/server/lib/db',
  'src/server/lib/auth',
  'src/server/lib/tenancy',
  'src/server/lib/validation',
  'src/server/lib/errors',
  'src/server/lib/logging',
  'src/server/lib/storage',
  'src/server/lib/supabase',
  'src/server/lib/router',
  'src/server/domains',
  'src/server/jobs/cron',
  'src/server/jobs/queue',
  'src/server/tests',
  'scripts/jobs',
  'scripts/db',
  'supabase',
  'e2e_tests',
];

const requiredDomainDirectories = [
  'tenants',
  'users',
  'rbac',
  'leads',
  'quotes',
  'parties',
  'brokers',
  'reference-data',
  'business-rules',
  'assignments',
  'dashboards',
  'alerts',
  'reports',
  'exports',
  'search',
  'intake',
  'api-access',
  'audit',
].map((domain) => `src/server/domains/${domain}`);

const requiredFiles = [
  'docs/local-development.md',
  'docs/deployment.md',
  'docs/background-jobs.md',
  'docs/environment-variables.md',
  'vercel.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'vitest.config.ts',
  '.env.example',
  '.env.local.example',
  'api/v1/[[...segments]].ts',
];

// Cutover (T-044) removed the legacy .NET stack and its docker-compose infrastructure. These
// paths were guarded as "must still be present" during the migration; the guard is now inverted so
// a re-introduction of the retired stack fails the layout check.
const removedLegacyPaths = ['src/api', 'docker-compose.yml', 'infra'];

describe('spec section 8 repository layout', () => {
  it.each(requiredDirectories)('has directory %s', (relative) => {
    const absolute = resolve(repoRoot, relative);
    expect(existsSync(absolute), `${relative} is missing`).toBe(true);
    expect(statSync(absolute).isDirectory(), `${relative} is not a directory`).toBe(true);
  });

  it.each(requiredDomainDirectories)('has domain directory %s', (relative) => {
    const absolute = resolve(repoRoot, relative);
    expect(existsSync(absolute), `${relative} is missing`).toBe(true);
    expect(statSync(absolute).isDirectory(), `${relative} is not a directory`).toBe(true);
  });

  it.each(requiredFiles)('has file %s', (relative) => {
    const absolute = resolve(repoRoot, relative);
    expect(existsSync(absolute), `${relative} is missing`).toBe(true);
    expect(statSync(absolute).isFile(), `${relative} is not a file`).toBe(true);
  });

  it.each(removedLegacyPaths)('has removed the legacy .NET/infra path %s at cutover (T-044)', (relative) => {
    expect(existsSync(resolve(repoRoot, relative)), `${relative} must be removed at cutover`).toBe(false);
  });
});
