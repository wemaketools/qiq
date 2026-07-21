/**
 * Pure bearer-token parsing and JWT-header policy (T-011, AC-016, V-019).
 *
 * These are the checks that run BEFORE any cryptography, so they are the ones that decide
 * whether a hostile token ever reaches the verifier at all. The algorithm allow-list in
 * particular is load-bearing: `auth.getClaims()` silently falls back to a network `getUser()`
 * call for `HS*`/`none`/kid-less tokens (see GoTrueClient.getClaims), which would turn an
 * offline verification path into a server round-trip driven by attacker-controlled input.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_JWT_ALGORITHMS,
  decodeJwtHeader,
  expectedIssuer,
  extractBearerToken,
  isAllowedAlgorithm,
  issuerMatches,
} from '../../lib/auth/token.js';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function tokenWithHeader(header: unknown): string {
  return `${encodeSegment(header)}.${encodeSegment({ sub: 'x' })}.signature`;
}

describe('extractBearerToken', () => {
  it('returns the credential from a well-formed Bearer header', () => {
    const result = extractBearerToken('Bearer abc.def.ghi');

    expect(result).toEqual({ ok: true, value: 'abc.def.ghi' });
  });

  it('accepts the scheme case-insensitively, as RFC 7235 requires', () => {
    for (const scheme of ['bearer', 'BEARER', 'BeArEr']) {
      expect(extractBearerToken(`${scheme} abc.def.ghi`)).toEqual({ ok: true, value: 'abc.def.ghi' });
    }
  });

  it('tolerates extra whitespace between the scheme and the credential', () => {
    expect(extractBearerToken('Bearer    abc.def.ghi')).toEqual({ ok: true, value: 'abc.def.ghi' });
  });

  it('reports a missing header distinctly from a malformed one', () => {
    expect(extractBearerToken(null)).toEqual({ ok: false, error: 'missing_authorization_header' });
    expect(extractBearerToken(undefined)).toEqual({ ok: false, error: 'missing_authorization_header' });
    expect(extractBearerToken('')).toEqual({ ok: false, error: 'missing_authorization_header' });
    expect(extractBearerToken('   ')).toEqual({ ok: false, error: 'missing_authorization_header' });
  });

  it('rejects every non-Bearer scheme and malformed credential shape', () => {
    const malformed = [
      'Basic dXNlcjpwYXNz',
      'Token abc.def.ghi',
      'Bearer',
      'Bearer ',
      'abc.def.ghi',
      'Bearer abc def',
      'BearerAbc.def.ghi',
    ];

    for (const header of malformed) {
      expect(extractBearerToken(header), header).toEqual({
        ok: false,
        error: 'malformed_authorization_header',
      });
    }
  });
});

describe('decodeJwtHeader', () => {
  it('decodes the alg and kid of a three-segment token', () => {
    const result = decodeJwtHeader(tokenWithHeader({ alg: 'ES256', kid: 'key-1', typ: 'JWT' }));

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toMatchObject({ alg: 'ES256', kid: 'key-1' });
  });

  it('rejects anything that is not a base64url-encoded three-segment JWT', () => {
    const malformed = [
      'not-a-jwt',
      'only.two',
      'a.b.c.d',
      '.b.c',
      `${Buffer.from('not json', 'utf8').toString('base64url')}.b.c`,
      `${encodeSegment(['array'])}.b.c`,
      `${encodeSegment('string')}.b.c`,
      `${encodeSegment(null)}.b.c`,
      tokenWithHeader({ kid: 'no-alg' }),
      tokenWithHeader({ alg: 42 }),
    ];

    for (const token of malformed) {
      expect(decodeJwtHeader(token), token).toEqual({ ok: false, error: 'malformed_token' });
    }
  });
});

describe('isAllowedAlgorithm', () => {
  it('accepts only asymmetric algorithms', () => {
    for (const alg of ALLOWED_JWT_ALGORITHMS) {
      expect(isAllowedAlgorithm(alg), alg).toBe(true);
    }
    expect(ALLOWED_JWT_ALGORITHMS).toContain('ES256');
  });

  it('rejects "none" and every symmetric HMAC algorithm (alg-confusion downgrade)', () => {
    for (const alg of ['none', 'None', 'NONE', 'HS256', 'HS384', 'HS512', '', 'ES256 ']) {
      expect(isAllowedAlgorithm(alg), alg).toBe(false);
    }
  });
});

describe('issuer checks', () => {
  it('derives the GoTrue issuer from the Supabase URL, ignoring a trailing slash', () => {
    expect(expectedIssuer('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321/auth/v1');
    expect(expectedIssuer('http://127.0.0.1:54321/')).toBe('http://127.0.0.1:54321/auth/v1');
  });

  it('matches only the exact expected issuer', () => {
    const url = 'http://127.0.0.1:54321';

    expect(issuerMatches('http://127.0.0.1:54321/auth/v1', url)).toBe(true);
    expect(issuerMatches('http://127.0.0.1:54321/auth/v1/', url)).toBe(true);
    expect(issuerMatches('https://evil.example.com/auth/v1', url)).toBe(false);
    expect(issuerMatches('http://127.0.0.1:54321/auth/v2', url)).toBe(false);
    expect(issuerMatches(undefined, url)).toBe(false);
    expect(issuerMatches(42, url)).toBe(false);
  });
});
