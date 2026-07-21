/**
 * JWKS caching semantics (T-011, AC-016, V-020).
 *
 * The integration suite proves the real end-to-end fetch count against the live stack; this
 * suite pins the surrounding policy deterministically — TTL expiry, the unknown-kid refresh
 * cooldown, concurrent-refresh de-duplication, and the loud failure when a stack has no
 * asymmetric keys at all. Fetch and clock are injected, so no network and no timers are used.
 */
import { describe, expect, it } from 'vitest';

import { JwksCache, JwksFetchError } from '../../lib/supabase/jwks.js';

const SUPABASE_URL = 'http://127.0.0.1:54321';

function keySet(...kids: string[]): { keys: { kid: string; kty: string; key_ops: string[] }[] } {
  return { keys: kids.map((kid) => ({ kid, kty: 'EC', key_ops: ['verify'] })) };
}

interface Harness {
  readonly cache: JwksCache;
  readonly calls: string[];
  setKeys(kids: string[]): void;
  advance(ms: number): void;
}

function harness(options: { ttlMs?: number; minRefreshIntervalMs?: number } = {}): Harness {
  const calls: string[] = [];
  let now = 1_000_000;
  let current = keySet('kid-1');

  const cache = new JwksCache({
    supabaseUrl: SUPABASE_URL,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.minRefreshIntervalMs === undefined
      ? {}
      : { minRefreshIntervalMs: options.minRefreshIntervalMs }),
    clock: () => now,
    fetchImpl: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    cache,
    calls,
    setKeys: (kids) => {
      current = keySet(...kids);
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('JwksCache', () => {
  it('fetches once and serves every subsequent lookup from memory', async () => {
    const h = harness();

    for (let i = 0; i < 25; i += 1) {
      expect(await h.cache.findKey('kid-1')).not.toBeNull();
    }

    expect(h.cache.fetchCount).toBe(1);
    expect(h.calls).toEqual([`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`]);
  });

  it('de-duplicates concurrent cold-start refreshes into a single request', async () => {
    const h = harness();

    await Promise.all(Array.from({ length: 12 }, () => h.cache.findKey('kid-1')));

    expect(h.cache.fetchCount).toBe(1);
  });

  it('re-fetches after the TTL expires', async () => {
    const h = harness({ ttlMs: 60_000 });
    await h.cache.findKey('kid-1');

    h.advance(59_999);
    await h.cache.findKey('kid-1');
    expect(h.cache.fetchCount).toBe(1);

    h.advance(2);
    await h.cache.findKey('kid-1');
    expect(h.cache.fetchCount).toBe(2);
  });

  it('refreshes once for an unknown kid, then picks up a rotated key', async () => {
    const h = harness({ minRefreshIntervalMs: 30_000 });
    await h.cache.findKey('kid-1');
    expect(h.cache.fetchCount).toBe(1);

    h.setKeys(['kid-1', 'kid-2']);
    h.advance(30_001);

    expect(await h.cache.findKey('kid-2')).not.toBeNull();
    expect(h.cache.fetchCount).toBe(2);
  });

  it('does not turn a flood of unknown kids into a fetch amplifier', async () => {
    const h = harness({ minRefreshIntervalMs: 30_000 });
    await h.cache.findKey('kid-1');
    const before = h.cache.fetchCount;

    for (let i = 0; i < 50; i += 1) {
      expect(await h.cache.findKey(`bogus-${i}`)).toBeNull();
    }

    expect(h.cache.fetchCount - before).toBeLessThanOrEqual(1);
  });

  it('returns null (never a fallback) for a kid that is genuinely not ours', async () => {
    const h = harness();

    expect(await h.cache.findKey('somebody-elses-kid')).toBeNull();
  });

  it('fails loudly when the endpoint publishes no keys — the HS256-fallback trap', async () => {
    const cache = new JwksCache({
      supabaseUrl: SUPABASE_URL,
      fetchImpl: async () =>
        new Response(JSON.stringify({ keys: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    await expect(cache.getDocument()).rejects.toBeInstanceOf(JwksFetchError);
    await expect(cache.getDocument()).rejects.toThrow(/asymmetric signing keys/i);
  });

  it('surfaces a transport failure as JwksFetchError rather than a silent empty key set', async () => {
    const cache = new JwksCache({
      supabaseUrl: SUPABASE_URL,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    await expect(cache.findKey('kid-1')).rejects.toBeInstanceOf(JwksFetchError);
  });

  it('surfaces a non-200 response', async () => {
    const cache = new JwksCache({
      supabaseUrl: SUPABASE_URL,
      fetchImpl: async () => new Response('nope', { status: 503 }),
    });

    await expect(cache.findKey('kid-1')).rejects.toThrow(/HTTP 503/);
  });
});
