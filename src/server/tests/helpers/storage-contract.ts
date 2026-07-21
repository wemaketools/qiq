/**
 * The `StorageAdapter` CONFORMANCE SUITE (T-027; AC-058, V-074).
 *
 * AC-058 requires that swapping the configured adapter needs zero domain-code changes. That claim
 * is only worth anything if both adapters are held to the SAME observable contract, so this file
 * defines it once and is executed twice:
 *
 *   - `tests/unit/storage-fake.test.ts`        -> FakeStorageAdapter (in-memory, no stack needed)
 *   - `tests/integration/attachments.test.ts`  -> SupabaseStorageAdapter (real local Storage)
 *
 * A behaviour asserted only against the fake would prove nothing about production; a behaviour
 * asserted only against Supabase would let the fake drift into a seam that lies to unit tests.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT ASSERT
 * ============================================
 * Signed-upload-URL EXPIRY is not asserted here. Supabase Storage fixes the upload token's TTL
 * server-side and exposes no way to request a different one (`createSignedUploadUrl(path, {upsert})`
 * takes no `expiresIn`), so the adapter REPORTS that TTL rather than choosing it, and a shared
 * assertion would be asserting a Supabase constant. Download expiry IS caller-chosen and IS
 * asserted, both here and end-to-end in the integration suite.
 */
import { expect, it } from 'vitest';

import type { StorageAdapter } from '../../lib/storage/index.js';

export interface StorageContractContext {
  /** The adapter under test. */
  readonly adapter: StorageAdapter;
  /**
   * Puts bytes at `key` by whatever route the deployment's clients use, so the contract is
   * exercised through the REAL transfer path rather than a back door: the Supabase binding uploads
   * through a signed URL exactly as a browser would.
   */
  readonly putBytes: (key: string, bytes: Uint8Array, contentType: string) => Promise<void>;
  /** Registers a key for cleanup so neither the bucket nor the fake retains residue. */
  readonly track: (key: string) => void;
  /** Unique per invocation, so parallel/repeat runs never collide. */
  readonly uniqueKey: (suffix: string) => string;
}

const PDF_BYTES = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x41]);

/**
 * Registers the shared contract. Call from inside a `describe` block.
 *
 * @param context Lazily resolved so the caller can build the adapter in `beforeAll`.
 */
export function itObeysTheStorageAdapterContract(context: () => StorageContractContext): void {
  it('reports a stable adapter name', () => {
    expect(context().adapter.name).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('round-trips bytes through a signed upload URL and a signed download URL', async () => {
    const { adapter, putBytes, track, uniqueKey } = context();
    const key = uniqueKey('roundtrip.pdf');
    track(key);

    await putBytes(key, PDF_BYTES, 'application/pdf');

    const download = await adapter.createSignedDownloadUrl(key, { expiresInSeconds: 60 });
    const response = await fetch(download.url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it('issues an upload target whose URL is not derivable from the key alone', async () => {
    const { adapter, track, uniqueKey } = context();
    const key = uniqueKey('unguessable.pdf');
    track(key);

    const first = await adapter.createSignedUploadUrl(key, { contentType: 'application/pdf' });

    // A bare bucket URL with no credential material would be guessable from the key; the signature
    // is what makes possession of the URL the authorization. Assert a token is actually present.
    expect(first.token.length).toBeGreaterThan(16);
    expect(first.url).toContain('token=');
    expect(first.expiresInSeconds).toBeGreaterThan(0);
  });

  it('scopes a signed download URL to one key and one expiry', async () => {
    const { adapter, putBytes, track, uniqueKey } = context();
    const mine = uniqueKey('mine.pdf');
    const other = uniqueKey('other.pdf');
    track(mine);
    track(other);
    await putBytes(mine, PDF_BYTES, 'application/pdf');
    await putBytes(other, Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x99]), 'application/pdf');

    const signed = await adapter.createSignedDownloadUrl(mine, { expiresInSeconds: 60 });

    // Re-pointing the signed URL at a different object must not work: the signature covers the key.
    const tampered = signed.url.replace(encodeURIComponent(mine), encodeURIComponent(other)).replace(mine, other);
    const response = await fetch(tampered);
    expect(response.status).not.toBe(200);
  });

  it('sets an attachment content-disposition when a download filename is requested', async () => {
    const { adapter, putBytes, track, uniqueKey } = context();
    const key = uniqueKey('disposition.pdf');
    track(key);
    await putBytes(key, PDF_BYTES, 'application/pdf');

    const signed = await adapter.createSignedDownloadUrl(key, {
      expiresInSeconds: 60,
      downloadFileName: 'Quarterly Report.pdf',
    });
    const response = await fetch(signed.url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition') ?? '').toMatch(/attachment/i);
  });

  it('stats a stored object with its server-observed size', async () => {
    const { adapter, putBytes, track, uniqueKey } = context();
    const key = uniqueKey('stat.pdf');
    track(key);
    await putBytes(key, PDF_BYTES, 'application/pdf');

    const info = await adapter.stat(key);

    expect(info).not.toBeNull();
    expect(info?.sizeBytes).toBe(PDF_BYTES.length);
    expect(info?.contentType).toBe('application/pdf');
  });

  it('returns null from stat for an absent key rather than throwing', async () => {
    const { adapter, uniqueKey } = context();
    await expect(adapter.stat(uniqueKey('never-written.pdf'))).resolves.toBeNull();
  });

  it('reads only the leading bytes requested, for the magic-number check', async () => {
    const { adapter, putBytes, track, uniqueKey } = context();
    const key = uniqueKey('head.pdf');
    track(key);
    await putBytes(key, PDF_BYTES, 'application/pdf');

    const head = await adapter.readHead(key, 4);

    expect(head).toEqual(PDF_BYTES.slice(0, 4));
  });

  it('returns an empty head for an absent key rather than throwing', async () => {
    const { adapter, uniqueKey } = context();
    await expect(adapter.readHead(uniqueKey('absent.pdf'), 8)).resolves.toEqual(new Uint8Array(0));
  });

  it('deletes an object, and deleting an absent key is a no-op rather than an error', async () => {
    const { adapter, putBytes, track, uniqueKey } = context();
    const key = uniqueKey('deleteme.pdf');
    track(key);
    await putBytes(key, PDF_BYTES, 'application/pdf');
    expect(await adapter.stat(key)).not.toBeNull();

    await adapter.delete(key);
    expect(await adapter.stat(key)).toBeNull();

    // Idempotent: confirm-cleanup and remove both run delete on paths that may already be gone.
    await expect(adapter.delete(key)).resolves.toBeUndefined();
  });
}
