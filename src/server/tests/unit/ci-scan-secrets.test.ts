import { describe, expect, it } from 'vitest';

import {
  FAKE_POSTGRES_URL,
  FAKE_SB_SECRET_KEY,
  FAKE_SECRET_ASSIGNMENT,
  FAKE_SERVICE_ROLE_JWT,
} from '../fixtures/ci-scan-probe-secrets.js';
import {
  ALLOWLIST,
  isAllowlisted,
  scanContent,
  scanRepo,
  SECRET_RULES,
} from '../../../../scripts/ci/scan-secrets.js';

/**
 * Teeth proof for the repo-wide secret scanner (T-051, V-114). Each planted secret in a
 * non-allowlisted path MUST be flagged; the same secret in an allowlisted path must not be; and
 * the actual repository must scan CLEAN (a real match here is a genuine finding, not something to
 * allowlist away).
 */
const NON_ALLOWLISTED = 'src/server/domains/leads/repository.ts';

describe('scan-secrets rule set has teeth (V-114)', () => {
  it('flags a three-segment JWT in a non-allowlisted file', () => {
    const findings = scanContent(NON_ALLOWLISTED, `const token = '${FAKE_SERVICE_ROLE_JWT}';`);
    expect(findings.map((f) => f.rule)).toContain('jwt');
    expect(findings[0]?.file).toBe(NON_ALLOWLISTED);
  });

  it('flags a Supabase secret key', () => {
    const findings = scanContent(NON_ALLOWLISTED, `key=${FAKE_SB_SECRET_KEY}`);
    expect(findings.map((f) => f.rule)).toContain('supabase-secret-key');
  });

  it('flags a postgres URL with an inline password', () => {
    const findings = scanContent(NON_ALLOWLISTED, FAKE_POSTGRES_URL);
    expect(findings.map((f) => f.rule)).toContain('postgres-inline-credential');
  });

  it('flags a high-entropy value assigned to a secret-named variable', () => {
    const findings = scanContent(NON_ALLOWLISTED, FAKE_SECRET_ASSIGNMENT);
    expect(findings.map((f) => f.rule)).toContain('high-entropy-secret-assignment');
  });

  it('flags a PEM private-key block', () => {
    const findings = scanContent(NON_ALLOWLISTED, '-----BEGIN RSA PRIVATE KEY-----');
    expect(findings.map((f) => f.rule)).toContain('private-key-block');
  });

  it('never echoes the full candidate secret into the finding excerpt', () => {
    const findings = scanContent(NON_ALLOWLISTED, `const token = '${FAKE_SERVICE_ROLE_JWT}';`);
    expect(findings[0]?.excerpt).not.toContain(FAKE_SERVICE_ROLE_JWT);
  });
});

describe('scan-secrets allowlist is specific, not a hole (V-114)', () => {
  it('does not flag the same JWT when it lives in an allowlisted placeholder/fixture path', () => {
    for (const allowed of ['.env.local.example', 'src/server/tests/fixtures/log-fixture-secrets.ts']) {
      expect(scanContent(allowed, `x = '${FAKE_SERVICE_ROLE_JWT}'`)).toEqual([]);
    }
  });

  it('STILL flags a secret in a file the allowlist does not cover (proves it is not a broad glob)', () => {
    // A sibling of an allowlisted fixture that is NOT itself listed must not inherit the exemption.
    const sibling = 'src/server/tests/fixtures/not-allowlisted.ts';
    expect(isAllowlisted(sibling)).toBe(false);
    expect(scanContent(sibling, `x = '${FAKE_SERVICE_ROLE_JWT}'`).length).toBeGreaterThan(0);
  });

  it('allowlists only exact paths and contains no wildcard entry', () => {
    expect(ALLOWLIST).toContain('.env.example');
    expect(ALLOWLIST).toContain('.env.local.example');
    expect(ALLOWLIST.every((entry) => !entry.includes('*'))).toBe(true);
  });

  it('does not treat placeholder connection strings or var names as secrets', () => {
    expect(scanContent(NON_ALLOWLISTED, 'DATABASE_URL=<direct-postgres-connection-string>')).toEqual([]);
    expect(scanContent(NON_ALLOWLISTED, 'SUPABASE_SERVICE_ROLE_KEY=<supabase-service-role-key>')).toEqual([]);
    expect(scanContent(NON_ALLOWLISTED, 'const name = "SUPABASE_SERVICE_ROLE_KEY";')).toEqual([]);
  });
});

describe('scan-secrets over the real repository (V-114)', () => {
  it('scans a non-trivial number of tracked files and finds zero committed secrets', () => {
    const { findings, scanned } = scanRepo();
    // Guard against a vacuous scan that matched nothing because it scanned nothing.
    expect(scanned).toBeGreaterThan(100);
    // A failure here is a REAL finding — a committed secret — not something to allowlist away.
    expect(findings).toEqual([]);
  });
});

describe('scan-secrets configuration integrity', () => {
  it('defines the documented credential-shape rules', () => {
    const names = SECRET_RULES.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'jwt',
        'supabase-secret-key',
        'private-key-block',
        'postgres-inline-credential',
        'high-entropy-secret-assignment',
      ]),
    );
  });
});
