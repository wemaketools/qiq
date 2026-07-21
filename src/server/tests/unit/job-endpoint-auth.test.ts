/**
 * Job endpoint secret validation (T-031, AC-062, V-079).
 *
 * `/api/cron/*` and `/api/queue/drain` are reachable from the public internet and mutate tenant
 * data. The rule they are guarded by is a pure function, tested here directly; the HTTP behaviour
 * (401 body, absence of side effects) is proven in ../integration/job-endpoints.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  authorizeJobRequest,
  checkJobSecret,
  extractPresentedSecret,
  secretsMatch,
} from '../../jobs/endpoint-auth.js';

const SECRET = 'correct-horse-battery-staple-0123456789';

describe('secretsMatch', () => {
  it('accepts an exact match', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
  });

  it.each([
    ['a different secret of the same length', `${SECRET.slice(0, -1)}X`],
    ['a prefix of the secret', SECRET.slice(0, 10)],
    ['the secret plus a suffix', `${SECRET}X`],
    ['an empty string', ''],
    ['a differently-cased secret', SECRET.toUpperCase()],
  ])('rejects %s', (_label, candidate) => {
    expect(secretsMatch(candidate, SECRET)).toBe(false);
  });

  it('does not throw on length mismatch (timingSafeEqual requires equal lengths)', () => {
    expect(() => secretsMatch('x', SECRET)).not.toThrow();
    expect(() => secretsMatch(`${SECRET}${SECRET}`, SECRET)).not.toThrow();
  });
});

describe('extractPresentedSecret', () => {
  it.each([
    ['Bearer form', `Bearer ${SECRET}`, SECRET],
    ['lowercase scheme', `bearer ${SECRET}`, SECRET],
    ['bare secret', SECRET, SECRET],
    ['padded value', `  Bearer   ${SECRET}  `, SECRET],
  ])('reads the credential from the %s', (_label, header, expected) => {
    expect(extractPresentedSecret(header)).toBe(expected);
  });

  it.each([
    ['a missing header', null],
    ['an undefined header', undefined],
    ['an empty header', ''],
    ['whitespace only', '   '],
    ['a scheme with no credential', 'Bearer '],
  ])('returns null for %s', (_label, header) => {
    expect(extractPresentedSecret(header)).toBeNull();
  });
});

describe('checkJobSecret', () => {
  it('authorizes the correct secret (positive control)', () => {
    expect(checkJobSecret(`Bearer ${SECRET}`, SECRET)).toEqual({ authorized: true });
    expect(checkJobSecret(SECRET, SECRET)).toEqual({ authorized: true });
  });

  it('reports a missing credential distinctly from a wrong one, for logs only', () => {
    expect(checkJobSecret(null, SECRET)).toEqual({ authorized: false, reason: 'missing' });
    expect(checkJobSecret('Bearer nope', SECRET)).toEqual({ authorized: false, reason: 'mismatch' });
  });

  it('does not accept another endpoint\'s secret', () => {
    expect(checkJobSecret(`Bearer ${SECRET}`, 'a-different-secret')).toEqual({
      authorized: false,
      reason: 'mismatch',
    });
  });
});

describe('authorizeJobRequest', () => {
  function request(authorization?: string): Request {
    return new Request('https://example.test/api/queue/drain', {
      headers: authorization === undefined ? {} : { authorization },
    });
  }

  it('returns null (proceed) for the correct secret', () => {
    expect(authorizeJobRequest(request(`Bearer ${SECRET}`), SECRET, '/api/queue/drain')).toBeNull();
  });

  it('returns an identical 401 problem document for missing and wrong secrets', async () => {
    const missing = authorizeJobRequest(request(), SECRET, '/api/queue/drain');
    const wrong = authorizeJobRequest(request('Bearer wrong'), SECRET, '/api/queue/drain');

    expect(missing?.status).toBe(401);
    expect(wrong?.status).toBe(401);
    expect(missing?.headers.get('content-type')).toBe('application/problem+json');

    const missingBody = (await missing?.json()) as Record<string, unknown>;
    const wrongBody = (await wrong?.json()) as Record<string, unknown>;

    // Probing must not reveal WHY the call was rejected; only the correlation id may differ.
    delete missingBody.correlationId;
    delete wrongBody.correlationId;
    expect(missingBody).toEqual(wrongBody);
  });

  it('never echoes the presented or expected secret in the response body', async () => {
    const response = authorizeJobRequest(request('Bearer guessed-secret-value'), SECRET, '/api/cron/x');
    const body = await response?.text();
    expect(body).not.toContain('guessed-secret-value');
    expect(body).not.toContain(SECRET);
  });
});
