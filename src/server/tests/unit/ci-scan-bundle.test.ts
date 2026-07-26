import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_SERVICE_ROLE_JWT } from '../fixtures/ci-scan-probe-secrets.js';
import { BUNDLE_RULES, scanBundleDir } from '../../../../scripts/ci/scan-bundle.js';

/**
 * Teeth proof for the built-bundle scanner (T-051, V-003) at the logic level. A synthetic dist
 * with a planted server secret / server-module fragment MUST be flagged; a clean dist must not be.
 * The end-to-end proof (real `npm run build:ui`, plant in SPA source, observe RED) is recorded in
 * the task report and exercised by the CLI, not here — this keeps the unit test fast and hermetic.
 */
describe('scan-bundle detects leaks in built assets (V-003)', () => {
  let dist: string;

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'quoteiq-scan-bundle-'));
    mkdirSync(join(dist, 'assets'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dist, { recursive: true, force: true });
  });

  function writeAsset(name: string, content: string): void {
    writeFileSync(join(dist, 'assets', name), content, 'utf8');
  }

  it('passes a clean bundle with no server secrets or modules', () => {
    writeAsset('index-abc.js', 'const a=1;console.log("hello world");export{a};');
    writeAsset('index-abc.css', '.btn{color:red}');
    expect(scanBundleDir(dist)).toEqual([]);
  });

  it('flags a server-only variable name inlined into an asset', () => {
    writeAsset('index-abc.js', 'const cfg={SUPABASE_SERVICE_ROLE_KEY:e.env.SUPABASE_SERVICE_ROLE_KEY};');
    const findings = scanBundleDir(dist);
    expect(findings.map((f) => f.rule)).toContain('server-var:SUPABASE_SERVICE_ROLE_KEY');
    expect(findings[0]?.file).toContain('index-abc.js');
  });

  it('flags SUPABASE_DATABASE_URL / CRON_SECRET / INTERNAL_JOB_SECRET names', () => {
    writeAsset('index-abc.js', 'x.SUPABASE_DATABASE_URL;y.CRON_SECRET;z.INTERNAL_JOB_SECRET;');
    const rules = scanBundleDir(dist).map((f) => f.rule);
    expect(rules).toContain('server-var:SUPABASE_DATABASE_URL');
    expect(rules).toContain('server-var:CRON_SECRET');
    expect(rules).toContain('server-var:INTERNAL_JOB_SECRET');
  });

  it('flags a src/server module path fragment (server code leaked)', () => {
    writeAsset('index-abc.js.map', '{"sources":["../../src/server/lib/config/schema.ts"]}');
    expect(scanBundleDir(dist).map((f) => f.rule)).toContain('server-module-path');
  });

  it('flags the literal "service_role"', () => {
    writeAsset('index-abc.js', 'const role="service_role";');
    expect(scanBundleDir(dist).map((f) => f.rule)).toContain('service-role-literal');
  });

  it('flags a concrete secret VALUE supplied from the environment', () => {
    writeAsset('index-abc.js', `const k="${FAKE_SERVICE_ROLE_JWT}";`);
    const findings = scanBundleDir(dist, [FAKE_SERVICE_ROLE_JWT]);
    expect(findings.map((f) => f.rule)).toContain('secret-value');
  });

  it('ignores placeholder-shaped extra values so an unset environment cannot false-positive', () => {
    writeAsset('index-abc.js', 'const k="<supabase-service-role-key>";');
    expect(scanBundleDir(dist, ['<supabase-service-role-key>'])).toEqual([]);
  });

  it('does not scan binary assets (guards against byte-noise false positives)', () => {
    writeAsset('logo.png', 'SUPABASE_DATABASE_URL-lookalike-bytes');
    expect(scanBundleDir(dist)).toEqual([]);
  });
});

describe('scan-bundle rule coverage (V-003)', () => {
  it('covers every server-only variable name from the env catalog', () => {
    const ruleNames = BUNDLE_RULES.map((r) => r.name);
    for (const varName of [
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_DATABASE_URL',
      'SUPABASE_DIRECT_DATABASE_URL',
      'CRON_SECRET',
      'INTERNAL_JOB_SECRET',
      'API_KEY_PEPPER',
    ]) {
      expect(ruleNames).toContain(`server-var:${varName}`);
    }
    expect(ruleNames).toContain('server-module-path');
  });
});
