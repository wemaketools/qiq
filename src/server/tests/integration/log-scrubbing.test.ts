import { spawnSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  fixtureDatabaseUrl,
  fixtureSecretLiterals,
  fixtureSecrets,
} from '../fixtures/log-fixture-secrets.js';
import { describeSensitiveMatches, findSensitiveData } from '../helpers/sensitive-scan.js';
import { repoRoot } from './helpers/repo.js';

/**
 * AC-011 / V-013 / V-014.
 *
 * Runs the real logger in a real child process and scans its real stdout. Nothing is mocked:
 * if the redactor regresses, the secret reaches stdout and this test fails.
 */
let stdout = '';
let stderr = '';
let status: number | null = null;

beforeAll(() => {
  const run = spawnSync('npx --no-install tsx src/server/tests/fixtures/log-emitter.ts', {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    timeout: 120_000,
  });
  stdout = run.stdout ?? '';
  stderr = run.stderr ?? '';
  status = run.status;
});

function records(): Record<string, unknown>[] {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('captured stdout from a real logger process', () => {
  it('runs successfully and writes output', () => {
    expect(status, `stderr:\n${stderr}`).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  it('emits only single-line, parseable JSON objects', () => {
    const lines = stdout.split('\n').filter((line) => line.trim() !== '');

    expect(lines.length).toBe(6);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('stamps every record with level, message, timestamp and environment', () => {
    for (const record of records()) {
      expect(typeof record.level).toBe('string');
      expect(typeof record.message).toBe('string');
      expect(Number.isNaN(Date.parse(String(record.timestamp)))).toBe(false);
      expect(typeof record.env).toBe('string');
    }
  });

  it('carries a single correlation id across request and job records', () => {
    const ids = new Set(records().map((record) => record.correlationId));

    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('carries request fields on request records and job fields on job records', () => {
    const all = records();
    const request = all.find((record) => record.route !== undefined);
    const job = all.find((record) => record.jobName !== undefined);

    expect(request).toMatchObject({ userId: 'user-fixture', tenantId: 'tenant-fixture' });
    expect(job).toMatchObject({ jobName: 'alerts.sweep', counts: { 'tenant-fixture': 3 } });
  });

  it('contains zero sensitive data (V-014 pattern scan)', () => {
    const matches = findSensitiveData(stdout, [
      ...fixtureSecretLiterals,
      fixtureDatabaseUrl,
      fixtureSecrets.databasePassword,
    ]);

    expect(matches, describeSensitiveMatches(matches)).toEqual([]);
  });

  it.each(Object.entries(fixtureSecrets))('never emits the %s literal', (_name, secret) => {
    expect(stdout).not.toContain(secret);
  });

  it('still emits the surrounding diagnostic context (scrubbing is not silence)', () => {
    expect(stdout).toContain('sign-in attempt');
    expect(stdout).toContain('user@example.com');
    expect(stdout).toContain('[REDACTED]');
  });

  it('keeps stderr free of sensitive data too', () => {
    const matches = findSensitiveData(stderr, fixtureSecretLiterals);

    expect(matches, describeSensitiveMatches(matches)).toEqual([]);
  });
});
