/**
 * Connection-safety contract for the pg pool behind Kysely (T-008, AC-012, V-015, N-03, R-3).
 *
 * Supavisor transaction pooling multiplexes many clients over few server backends, so a serverless
 * instance must hold a TINY pool and must not depend on anything that lives in a session. These
 * assertions pin the configuration; src/server/tests/integration/db-pool.test.ts proves the
 * behaviour against a real database.
 */
import { describe, expect, it } from 'vitest';

import {
  MAX_POOLED_CONNECTIONS,
  directPoolConfig,
  parseInt8,
  poolerPoolConfig,
} from '../../lib/db/pool.js';

const POOLED_URL = 'postgresql://postgres:postgres@db.example.supabase.co:6543/postgres';
const DIRECT_URL = 'postgresql://postgres:postgres@db.example.supabase.co:5432/postgres';

describe('poolerPoolConfig', () => {
  const config = poolerPoolConfig(POOLED_URL);

  it('caps the per-instance pool at 2 connections (V-015)', () => {
    expect(MAX_POOLED_CONNECTIONS).toBeLessThanOrEqual(2);
    expect(config.max).toBe(MAX_POOLED_CONNECTIONS);
    expect(config.max).toBeLessThanOrEqual(2);
  });

  it('uses the connection string it was given', () => {
    expect(config.connectionString).toBe(POOLED_URL);
  });

  it('releases idle connections rather than pinning a Supavisor slot for a dead instance', () => {
    expect(config.idleTimeoutMillis).toBeGreaterThan(0);
    expect(config.idleTimeoutMillis).toBeLessThanOrEqual(30_000);
    expect(config.allowExitOnIdle).toBe(true);
  });

  it('bounds connection acquisition so a saturated pooler surfaces as an error, not a hang', () => {
    expect(config.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(config.connectionTimeoutMillis).toBeLessThanOrEqual(30_000);
  });

  it('does not set any startup `options` parameter, which transaction pooling may reject', () => {
    expect(config.options).toBeUndefined();
  });

  it('installs an int8 parser so bigint columns match the generated `number` declaration', () => {
    expect(config.types?.getTypeParser).toBeTypeOf('function');
  });
});

describe('directPoolConfig', () => {
  it('is for scripts and admin work, so it is single-connection and session-capable', () => {
    const config = directPoolConfig(DIRECT_URL);
    expect(config.connectionString).toBe(DIRECT_URL);
    expect(config.max).toBe(1);
  });
});

describe('parseInt8', () => {
  it('returns a JS number for ordinary ids', () => {
    expect(parseInt8('1')).toBe(1);
    expect(parseInt8('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('handles negative values', () => {
    expect(parseInt8('-42')).toBe(-42);
  });

  it('throws rather than silently losing precision beyond 2^53', () => {
    // 9007199254740993 is not representable as a double; Number() rounds it to ...992.
    expect(() => parseInt8('9007199254740993')).toThrowError(/precision|safe integer/i);
  });

  it('throws on values that are not integers at all', () => {
    expect(() => parseInt8('not-a-number')).toThrowError();
  });
});
