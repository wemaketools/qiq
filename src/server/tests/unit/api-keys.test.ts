/**
 * The Q-19 first-party API-key primitive (T-022, AC-040; V-052; test_plan.unit).
 *
 * Pure crypto/format checks, no database. These are the properties the whole intake-auth story
 * rests on, and none of them are observable through the admin endpoints: an endpoint suite can see
 * that a key works, but only this file can see that the STORED form is one-way, per-row salted, and
 * pepper-bound.
 *
 * WHY THE PEPPER IS AN ARGUMENT AND NOT A MODULE READ
 * ==================================================
 * `keys.ts` never touches `process.env`. The pepper arrives as a parameter, sourced by the caller
 * from the typed config module (AC-010). That is what makes "a different pepper invalidates every
 * stored hash" testable at all — a module that read the environment itself could only be tested by
 * mutating global state.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  API_KEY_ID_PREFIX,
  apiKeySecretMatches,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
} from '../../domains/api-access/keys.js';

const PEPPER = 'unit-test-pepper-value-0123456789';
const OTHER_PEPPER = 'unit-test-pepper-value-9876543210';

/**
 * The shipped source of the key module, for the structural constant-time assertion below. A timing
 * measurement would be flaky in CI; reading the source is deterministic and fails loudly the day
 * someone "simplifies" the comparison to `===`.
 */
const keysModuleSource = readFileSync(
  new URL('../../domains/api-access/keys.ts', import.meta.url),
  'utf8',
);

describe('generateApiKey', () => {
  it('returns a plaintext key of the form {keyId}.{secret} with an identifiable prefix', () => {
    const generated = generateApiKey(PEPPER);

    expect(generated.keyId.startsWith(API_KEY_ID_PREFIX)).toBe(true);
    expect(generated.plaintext).toBe(`${generated.keyId}.${generated.secret}`);
    // The separator must appear exactly once, or `parseApiKey` cannot split unambiguously.
    expect(generated.plaintext.split('.')).toHaveLength(2);
  });

  it('carries at least 128 bits of entropy in the key id and 256 in the secret', () => {
    const generated = generateApiKey(PEPPER);

    // 16 random bytes rendered as hex.
    expect(generated.keyId.slice(API_KEY_ID_PREFIX.length)).toMatch(/^[0-9a-f]{32}$/);
    // 32 random bytes rendered base64url — 43 characters, no padding, no '.' to break parsing.
    expect(generated.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats a key id or a secret across generations', () => {
    const keyIds = new Set<string>();
    const secrets = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const generated = generateApiKey(PEPPER);
      keyIds.add(generated.keyId);
      secrets.add(generated.secret);
    }

    expect(keyIds.size).toBe(200);
    expect(secrets.size).toBe(200);
  });

  it('produces a stored form that contains neither the secret nor the plaintext key', () => {
    const generated = generateApiKey(PEPPER);

    // The three columns that actually land in `api_credentials` (20260718002400_api_credentials.sql).
    for (const stored of [generated.keyId, generated.salt, generated.hash]) {
      expect(stored).not.toContain(generated.secret);
      expect(stored).not.toContain(generated.plaintext);
    }
  });

  it('produces a hash that verifies against its own secret, salt and pepper', () => {
    const generated = generateApiKey(PEPPER);

    expect(apiKeySecretMatches(generated.hash, generated.secret, generated.salt, PEPPER)).toBe(true);
  });

  it('gives two credentials sharing one secret different hashes, because the salt is per row', () => {
    const a = generateApiKey(PEPPER);
    const b = generateApiKey(PEPPER);

    expect(a.salt).not.toBe(b.salt);
    expect(hashApiKeySecret('same-secret', a.salt, PEPPER)).not.toBe(
      hashApiKeySecret('same-secret', b.salt, PEPPER),
    );
  });
});

describe('hashApiKeySecret', () => {
  it('is deterministic for the same secret, salt and pepper', () => {
    const first = hashApiKeySecret('a-secret', 'a-salt', PEPPER);
    const second = hashApiKeySecret('a-secret', 'a-salt', PEPPER);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not confuse a salt/secret boundary shift (the delimiter is load-bearing)', () => {
    // Without a delimiter, ('ab','c') and ('a','bc') would hash identically and two distinct
    // credentials could authenticate each other's keys.
    expect(hashApiKeySecret('c', 'ab', PEPPER)).not.toBe(hashApiKeySecret('bc', 'a', PEPPER));
  });
});

describe('apiKeySecretMatches', () => {
  const generated = generateApiKey(PEPPER);

  it('rejects the wrong secret', () => {
    const other = generateApiKey(PEPPER);
    expect(apiKeySecretMatches(generated.hash, other.secret, generated.salt, PEPPER)).toBe(false);
  });

  it('rejects the right secret under the wrong salt', () => {
    expect(apiKeySecretMatches(generated.hash, generated.secret, 'not-the-salt', PEPPER)).toBe(
      false,
    );
  });

  it('rejects every stored hash once the pepper changes (AC-040 rotation semantics)', () => {
    // The pepper is not in the database on purpose: a full dump is not enough to verify a key.
    // Rotating it must invalidate everything, which is why this is asserted rather than assumed.
    expect(apiKeySecretMatches(generated.hash, generated.secret, generated.salt, OTHER_PEPPER)).toBe(
      false,
    );
  });

  it('rejects a stored hash of the wrong length without throwing', () => {
    // `crypto.timingSafeEqual` THROWS on a length mismatch. A truncated or corrupted `key_hash`
    // must be a plain authentication failure, not a 500 that tells the caller the row exists.
    expect(() =>
      apiKeySecretMatches('deadbeef', generated.secret, generated.salt, PEPPER),
    ).not.toThrow();
    expect(apiKeySecretMatches('deadbeef', generated.secret, generated.salt, PEPPER)).toBe(false);
  });

  it('rejects an empty stored hash', () => {
    expect(apiKeySecretMatches('', generated.secret, generated.salt, PEPPER)).toBe(false);
  });

  it('uses a constant-time comparison rather than string equality', () => {
    // Structural, not statistical: a timing assertion would be flaky in CI. The check is that the
    // module imports and calls node's `timingSafeEqual` — a `===` on the digests would leak the
    // number of matching leading bytes and let an attacker walk a forgery out byte by byte.
    expect(keysModuleSource).toContain('timingSafeEqual');
    expect(keysModuleSource).not.toMatch(/===\s*expectedHash|expectedHash\s*===/);
  });
});

describe('parseApiKey', () => {
  it('splits a generated key back into its id and secret', () => {
    const generated = generateApiKey(PEPPER);

    expect(parseApiKey(generated.plaintext)).toEqual({
      keyId: generated.keyId,
      secret: generated.secret,
    });
  });

  it('tolerates surrounding whitespace, which a copy/paste header commonly carries', () => {
    const generated = generateApiKey(PEPPER);

    expect(parseApiKey(`  ${generated.plaintext}\n`)).toEqual({
      keyId: generated.keyId,
      secret: generated.secret,
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['no separator', 'qiq_abc'],
    ['two separators', 'qiq_abc.def.ghi'],
    ['empty key id', '.secret'],
    ['empty secret', 'qiq_abc.'],
    ['wrong prefix', 'other_abc.secret'],
  ])('returns undefined for a %s key', (_label, presented) => {
    expect(parseApiKey(presented)).toBeUndefined();
  });
});

/**
 * The unknown-key timing equalization (T-022-F1).
 *
 * `verifyApiKey` performs a throwaway HMAC on the "no such credential" branch so that an unknown
 * key id costs roughly what a known one does. Deleting it leaves every behavioural test green — a
 * timing property is not deterministically observable in CI, and no statistical assertion belongs
 * in a test suite that has to pass on a noisy shared runner.
 *
 * So it is pinned STRUCTURALLY, the same way `apiKeySecretMatches`'s constant-time comparison is
 * above: the source must still contain the decoy and must still invoke it on the unknown-key path.
 * Without this, the one defence that makes the constant-time comparison meaningful could be removed
 * as dead code by anyone reading the function in isolation — the result is discarded, so it LOOKS
 * dead.
 */
const apiAccessServiceSource = readFileSync(
  new URL('../../domains/api-access/service.ts', import.meta.url),
  'utf8',
);

describe('verifyApiKey unknown-key timing equalization', () => {
  it('still computes a decoy hash on the unknown-key branch', () => {
    expect(apiAccessServiceSource).toContain('function equalizeUnknownKeyTiming');
    expect(apiAccessServiceSource).toMatch(/createHmac\(\s*'sha256'\s*,\s*pepper\s*\)/);
  });

  it('calls the equalizer where the credential lookup misses, before returning unknown_key', () => {
    // The ORDER matters, not merely the presence: an equalizer called after the early return, or
    // on a different branch, would restore the timing oracle while keeping the function in the file.
    const unknownKeyBranch =
      /if\s*\(row === undefined\)\s*\{[^}]*equalizeUnknownKeyTiming\([^)]*\);[^}]*return err\(verificationFailure\('unknown_key'\)\);/s;
    expect(apiAccessServiceSource).toMatch(unknownKeyBranch);
  });
});
