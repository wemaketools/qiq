/**
 * `FakeStorageAdapter` against the shared `StorageAdapter` conformance contract (T-027; AC-058,
 * V-074).
 *
 * The fake is the CLAUDE.md-justified second implementation of the port: it is the test seam that
 * lets unit-level code exercise the attachment flow with no Docker, and — together with the real
 * adapter running the same contract in `attachments.test.ts` — it is what makes "swapping adapters
 * needs zero domain-code changes" a tested claim rather than a design intention.
 *
 * The fake serves its signed URLs from an in-process HTTP server, because the contract insists on
 * `fetch`ing them. A fake that returned an opaque non-fetchable string would have made the contract
 * untestable against it, and the two adapters would only have appeared to agree.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeStorageAdapter } from '../../lib/storage/index.js';
import {
  itObeysTheStorageAdapterContract,
  type StorageContractContext,
} from '../helpers/storage-contract.js';

describe('FakeStorageAdapter', () => {
  let adapter: FakeStorageAdapter;
  let sequence = 0;

  beforeAll(async () => {
    adapter = new FakeStorageAdapter();
    await adapter.listen();
  });

  afterAll(async () => {
    await adapter?.close();
  });

  itObeysTheStorageAdapterContract(
    (): StorageContractContext => ({
      adapter,
      putBytes: async (key, bytes, contentType) => {
        // Through the real signed-upload path, exactly as the Supabase binding does.
        const target = await adapter.createSignedUploadUrl(key, { contentType });
        const response = await fetch(target.url, {
          method: 'PUT',
          headers: { 'content-type': contentType },
          body: bytes,
        });
        if (!response.ok) throw new Error(`fake upload failed: ${String(response.status)}`);
      },
      track: () => undefined,
      uniqueKey: (suffix) => {
        sequence += 1;
        return `t1/quotes/1/${String(sequence)}_${suffix}`;
      },
    }),
  );

  it('rejects an upload presented with a token it did not issue', async () => {
    // The fake must not be more permissive than the real thing, or unit tests written against it
    // would encode an authorization property production does not have.
    const key = 't1/quotes/1/900_forged.pdf';
    const target = await adapter.createSignedUploadUrl(key, { contentType: 'application/pdf' });
    const forged = target.url.replace(/token=[^&]+/, 'token=forged-token');

    const response = await fetch(forged, { method: 'PUT', body: Uint8Array.from([0x25]) });

    expect(response.ok).toBe(false);
    expect(await adapter.stat(key)).toBeNull();
  });

  it('refuses to serve a download URL whose expiry has passed', async () => {
    const key = 't1/quotes/1/901_expired.pdf';
    const target = await adapter.createSignedUploadUrl(key, { contentType: 'application/pdf' });
    await fetch(target.url, { method: 'PUT', body: Uint8Array.from([0x25, 0x50, 0x44, 0x46]) });

    const signed = await adapter.createSignedDownloadUrl(key, { expiresInSeconds: -1 });
    const response = await fetch(signed.url);

    expect(response.status).toBe(401);
  });

  it('exposes the objects it holds so a test can assert residue', async () => {
    const before = adapter.keys().length;
    const key = 't1/quotes/1/902_residue.pdf';
    const target = await adapter.createSignedUploadUrl(key, { contentType: 'application/pdf' });
    await fetch(target.url, { method: 'PUT', body: Uint8Array.from([0x25, 0x50, 0x44, 0x46]) });

    expect(adapter.keys()).toContain(key);
    expect(adapter.keys()).toHaveLength(before + 1);

    await adapter.delete(key);
    expect(adapter.keys()).not.toContain(key);
  });
});
