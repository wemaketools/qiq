/**
 * `SupabaseStorageAdapter` — the DEFAULT `StorageAdapter` binding (T-027; A-6, Q-6, spec §16).
 *
 * Replaces `src/api/QuoteIQ.Infrastructure/Storage/S3ObjectStorage.cs` (AWSSDK.S3 against MinIO).
 * The vendor changes; the contract does not.
 *
 * SERVICE-ROLE, SERVER-ONLY, AND THAT IS THE WHOLE SECURITY MODEL OF THE BUCKET
 * ============================================================================
 * The bucket is private and carries NO storage RLS policy, so `anon` and `authenticated` can reach
 * nothing in it at all (asserted in attachments.test.ts). Every byte of access therefore happens
 * either through this adapter's service-role client or through a signed URL this adapter minted
 * after the domain layer authorized the caller. That makes the signed URL the ONLY client-reachable
 * path, which is exactly what A-7 requires. This module must never be imported from `src/ui`.
 *
 * EXPIRY: DOWNLOAD IS CHOSEN, UPLOAD IS REPORTED — A MEASURED SUPABASE CONSTRAINT
 * ==============================================================================
 * `createSignedUrl(path, expiresIn, ...)` takes the download lifetime, so the domain layer picks a
 * short one and it is genuinely enforced. `createSignedUploadUrl(path, {upsert})` takes NO
 * `expiresIn` — measured against the installed @supabase/storage-js — so the upload token's TTL is
 * fixed server-side by Storage (two hours) and this adapter REPORTS it rather than pretending to
 * choose it. `expiresInSeconds` on the returned target is therefore honest about a value we do not
 * control. The mitigation for the long upload TTL is that the token authorizes writing ONE
 * server-chosen key that already has a metadata row bound to one tenant and one quote, and that an
 * unconfirmed object is never readable through the product.
 *
 * `upsert` IS LEFT FALSE DELIBERATELY
 * ==================================
 * A signed upload token is single-use against a non-existent key. With `upsert: true` a caller who
 * kept the URL could silently replace an already-confirmed, already-magic-number-checked object
 * with different bytes — a straight time-of-check/time-of-use hole in the R-8 verification.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  CreateSignedDownloadOptions,
  SignedDownloadTarget,
  SignedUploadTarget,
  StorageAdapter,
  StorageObjectInfo,
} from './types.js';

/**
 * Supabase Storage's server-side upload-token lifetime. NOT configurable through the client API;
 * see this file's header. Kept as a named constant so the value we report is traceable.
 */
export const SUPABASE_UPLOAD_TOKEN_TTL_SECONDS = 7200;

export interface SupabaseStorageAdapterOptions {
  readonly client: SupabaseClient;
  readonly bucket: string;
}

/** Shape of the `info()` payload we consume; declared locally to avoid an `any` at the seam. */
interface ObjectInfoPayload {
  readonly size?: number;
  readonly contentType?: string;
}

export class SupabaseStorageAdapter implements StorageAdapter {
  readonly name = 'supabase';

  private readonly client: SupabaseClient;
  private readonly bucket: string;

  constructor(options: SupabaseStorageAdapterOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
  }

  private files(): ReturnType<SupabaseClient['storage']['from']> {
    return this.client.storage.from(this.bucket);
  }

  // The `CreateSignedUploadOptions` argument is deliberately NOT destructured: Supabase binds no
  // content type into the upload token (see below), so this binding has nothing to do with it.
  async createSignedUploadUrl(key: string): Promise<SignedUploadTarget> {
    // The content type is NOT bound into the upload token — Storage records the type the client
    // sends. That is precisely why confirm re-observes it via `stat` and checks the magic number
    // rather than trusting anything the uploader declared.
    const { data, error } = await this.files().createSignedUploadUrl(key);
    if (error !== null || data === null) {
      throw new Error(`Could not create a signed upload URL: ${describe(error)}`);
    }

    return {
      url: data.signedUrl,
      token: data.token,
      expiresInSeconds: SUPABASE_UPLOAD_TOKEN_TTL_SECONDS,
    };
  }

  async createSignedDownloadUrl(
    key: string,
    options: CreateSignedDownloadOptions,
  ): Promise<SignedDownloadTarget> {
    const { data, error } = await this.files().createSignedUrl(key, options.expiresInSeconds, {
      // `download: <name>` makes Storage answer with `Content-Disposition: attachment; filename=...`
      // (spec §16). Passing the name rather than `true` also stops the browser from inferring one
      // from the opaque object key.
      ...(options.downloadFileName === undefined ? {} : { download: options.downloadFileName }),
    });
    if (error !== null || data === null) {
      throw new Error(`Could not create a signed download URL: ${describe(error)}`);
    }

    return { url: data.signedUrl, expiresInSeconds: options.expiresInSeconds };
  }

  async stat(key: string): Promise<StorageObjectInfo | null> {
    const { data, error } = await this.files().info(key);
    // Absence is a normal outcome (confirm runs against a key the client may never have written),
    // so it must be null rather than a throw — see the port's contract.
    if (error !== null || data === null) return null;

    const payload = data as ObjectInfoPayload;
    if (typeof payload.size !== 'number') return null;

    return {
      sizeBytes: payload.size,
      contentType: typeof payload.contentType === 'string' ? payload.contentType : null,
    };
  }

  async readHead(key: string, byteCount: number): Promise<Uint8Array> {
    if (byteCount <= 0) return new Uint8Array(0);

    // A RANGED read over a short-lived signed URL. `download()` would pull the whole object — up to
    // the 10 MB cap — through the function to inspect a handful of bytes, which is the exact cost
    // A-7 exists to avoid. Storage honours `Range`, so only the header crosses the wire.
    //
    // MEASURED: Storage refuses to SIGN a URL for an object that does not exist, so absence
    // surfaces here as a signing failure rather than as a 404 on the fetch below. The port requires
    // absence to be an empty array, not a throw, so the failure is re-checked against `stat` — and
    // rethrown when the object does exist, so a genuine outage is never silently read as "empty".
    let signed: SignedDownloadTarget;
    try {
      signed = await this.createSignedDownloadUrl(key, { expiresInSeconds: 60 });
    } catch (error) {
      if ((await this.stat(key)) === null) return new Uint8Array(0);
      throw error;
    }

    const response = await fetch(signed.url, {
      headers: { Range: `bytes=0-${String(byteCount - 1)}` },
    });

    // 404 (never written) and 416 (empty object) are both "no header to inspect", not failures.
    if (response.status === 404 || response.status === 416) return new Uint8Array(0);
    if (!response.ok && response.status !== 206) {
      throw new Error(`Could not read the object header: HTTP ${String(response.status)}`);
    }

    return new Uint8Array(await response.arrayBuffer()).slice(0, byteCount);
  }

  async delete(key: string): Promise<void> {
    // `remove` reports success for a key that was not there, which is the no-op the port requires.
    const { error } = await this.files().remove([key]);
    if (error !== null) {
      throw new Error(`Could not delete the object: ${describe(error)}`);
    }
  }
}

/**
 * Renders a storage error for a server-side message.
 *
 * Only the message is taken. A storage error can carry the request URL, and a signed URL must never
 * reach a log line (spec §14: never log tokens) — passing the whole object to a template would do
 * exactly that.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown storage error';
}
