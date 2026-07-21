/**
 * AC-003 / V-004: the local Supabase stack must expose a healthy Storage service alongside
 * database and auth.
 *
 * This closes finding F-002-1. `supabase status` exits 0 while listing stopped services, so
 * without an explicit probe the whole suite stayed green when Storage was disabled in
 * config.toml or its container died — the same false-green class as a suite that never runs.
 * Storage is load-bearing from T-027 onward (StorageAdapter, signed-URL attachment uploads).
 */
import { describe, expect, it } from 'vitest';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('local Supabase storage service', probe);

describeStack(title, () => {
  const stack = probe.available ? probe.stack : ({} as LocalStack);
  const storageUrl = (path: string): string => `${stack.apiUrl.replace(/\/$/, '')}/storage/v1${path}`;

  // A stopped container leaves the connection hanging until the OS timeout (~54s observed),
  // which would stall CI on the very failure this suite exists to catch. Fail fast instead.
  const PROBE_TIMEOUT_MS = 10_000;
  const probeFetch = (path: string, init?: RequestInit): Promise<Response> =>
    fetch(storageUrl(path), { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });

  it('serves a healthy storage service reporting its version', async () => {
    const response = await probeFetch('/version');

    expect(response.status).toBe(200);
    // A disabled or crashed storage container answers 404/502 through the gateway rather than
    // a version string, so assert on real content and not just reachability.
    expect((await response.text()).trim()).not.toHaveLength(0);
  });

  it('exposes the authenticated bucket API to the service role', async () => {
    const response = await probeFetch('/bucket', {
      headers: {
        apikey: stack.serviceRoleKey,
        Authorization: `Bearer ${stack.serviceRoleKey}`,
      },
    });

    expect(response.status).toBe(200);
    // T-027 provisions buckets; here we only require that the API answers with a JSON list,
    // so this stays true both before and after buckets exist.
    expect(Array.isArray(await response.json())).toBe(true);
  });
});
