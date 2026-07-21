/**
 * The `StorageAdapter` PORT (T-027; A-6, Q-6, AC-058, spec §16).
 *
 * Successor to `src/api/QuoteIQ.Application/Abstractions/IObjectStorage.cs`. The reference port was
 * `PutAsync` / `OpenReadAsync` / `DeleteAsync` — three STREAMING operations — because bytes flowed
 * through the .NET API process. Under Q-22/A-7 bytes must NOT flow through a Vercel function (the
 * ~4.5 MB body limit sits below the 10 MB attachment cap), so the port's shape changes with the
 * transfer pattern: the app hands out short-lived signed URLs and the client transfers directly.
 * Preserving `OpenReadAsync` would have preserved an operation the product must never perform.
 *
 * WHAT SURVIVES FROM THE REFERENCE PORT IS ITS PURPOSE
 * ===================================================
 * Domain code never names a storage vendor. `SupabaseStorageAdapter` is the default binding (Q-6);
 * an S3/MinIO-compatible adapter — the reference's actual backend — remains substitutable via
 * configuration because every method here is expressible against S3 (`createPresignedPost`/
 * `getSignedUrl`, `HeadObject`, ranged `GetObject`, `DeleteObject`). No alternative adapter is
 * BUILT: CLAUDE.md forbids speculative abstraction, and the port is justified by two real
 * implementations already — the Supabase default and the fake test seam.
 *
 * THE OPERATION SET IS THE MINIMUM THE FLOW NEEDS, AND EACH ONE EARNS ITS PLACE
 * ============================================================================
 *   createSignedUploadUrl   — the request-upload envelope's product.
 *   createSignedDownloadUrl — the download envelope's product; expiry and attachment disposition
 *                             are caller-chosen because both are security-relevant.
 *   stat                    — confirm's server-side size/type observation. The migration is explicit
 *                             that `size_bytes`/`content_type` are recorded "as the SERVER observed
 *                             them, not as the client claimed"; without `stat` that is impossible
 *                             and the columns would hold hostile input.
 *   readHead                — confirm's magic-number check (R-8). A RANGED read, not a download:
 *                             pulling 10 MB through the function to inspect 4 bytes would reintroduce
 *                             the very body-size problem A-7 exists to avoid.
 *   delete                  — cleanup on failed confirm, and the reference's remove-path delete.
 *
 * There is deliberately NO `exists`: `stat(key) !== null` answers it, and a second way to ask the
 * same question is a second way for two adapters to disagree.
 *
 * ADAPTERS MUST NOT THROW FOR "ABSENT"
 * ====================================
 * `stat` returns null, `readHead` returns an empty array, and `delete` is a no-op on a missing key
 * (the reference's `DeleteAsync` documented the same). Confirm and remove both run against keys
 * that may legitimately not exist, and an adapter that threw would turn an ordinary rejection into
 * a 500. The conformance suite pins all three.
 */

/** A short-lived, single-key target the client uploads to directly. */
export interface SignedUploadTarget {
  /** Absolute URL. NEVER log this: possession of it is the authorization to write the object. */
  readonly url: string;
  /** Adapter-specific upload credential; supabase-js's `uploadToSignedUrl` takes it separately. */
  readonly token: string;
  /**
   * The target's lifetime. REPORTED, NOT CHOSEN, for the Supabase binding: Supabase Storage fixes
   * the upload token's TTL server-side and `createSignedUploadUrl` accepts no `expiresIn`. Adapters
   * that can choose one should honour a shorter lifetime; none may report a TTL longer than the
   * one it actually issued.
   */
  readonly expiresInSeconds: number;
}

/** A short-lived, single-key target the client downloads from directly. */
export interface SignedDownloadTarget {
  /** Absolute URL. NEVER log this: possession of it is the authorization to read the object. */
  readonly url: string;
  readonly expiresInSeconds: number;
}

/** Server-observed object metadata, as opposed to anything the uploading client claimed. */
export interface StorageObjectInfo {
  readonly sizeBytes: number;
  /** Null when the backend records no content type for the object. */
  readonly contentType: string | null;
}

export interface CreateSignedUploadOptions {
  /** The content type the object is expected to carry. */
  readonly contentType: string;
}

export interface CreateSignedDownloadOptions {
  readonly expiresInSeconds: number;
  /**
   * When set, the target responds with `Content-Disposition: attachment; filename=...` (spec §16:
   * "attachment disposition on download"). This is a real defence, not cosmetics: an inline-rendered
   * HTML or SVG attachment would execute in the storage origin.
   */
  readonly downloadFileName?: string;
}

export interface StorageAdapter {
  /** Stable identifier for logs and for the config-selection test. Never a credential. */
  readonly name: string;

  createSignedUploadUrl(
    key: string,
    options: CreateSignedUploadOptions,
  ): Promise<SignedUploadTarget>;

  createSignedDownloadUrl(
    key: string,
    options: CreateSignedDownloadOptions,
  ): Promise<SignedDownloadTarget>;

  /** Server-observed metadata, or null when the object does not exist. Never throws for absence. */
  stat(key: string): Promise<StorageObjectInfo | null>;

  /**
   * The first `byteCount` bytes of the object, or an empty array when it does not exist. May return
   * FEWER bytes than requested when the object is shorter; callers must not assume a full buffer.
   */
  readHead(key: string, byteCount: number): Promise<Uint8Array>;

  /** Removes the object. A no-op, not an error, when the key does not exist. */
  delete(key: string): Promise<void>;
}
