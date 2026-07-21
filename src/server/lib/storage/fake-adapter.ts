/**
 * `FakeStorageAdapter` — the in-memory `StorageAdapter` binding (T-027; A-6, AC-058, spec §17).
 *
 * The second real implementation of the port, and the reason CLAUDE.md's abstraction rule is
 * satisfied without building an S3 adapter nobody asked for. Spec §17 admits the fake at the unit
 * tier explicitly.
 *
 * IT SERVES REAL HTTP, ON PURPOSE
 * ===============================
 * A fake that returned an opaque `fake://` string would be untestable against the shared
 * conformance contract (which `fetch`es the URLs it is given), so the two bindings could only ever
 * have been compared on paper. This one binds an ephemeral loopback server and issues real URLs, so
 * the SAME assertions run against it and against Supabase.
 *
 * IT IS NOT MORE PERMISSIVE THAN PRODUCTION
 * =========================================
 * Upload tokens are single-use and checked; download URLs carry an expiry that is enforced; a
 * signature covers the key so a URL cannot be re-pointed at another object. Every one of those is a
 * property the real adapter has, and a fake that skipped them would let unit tests encode
 * authorization guarantees production does not provide — the classic way a mock lies.
 *
 * NOT FOR PRODUCTION. `createStorageAdapter` refuses to select it outside a local/test environment
 * (see index.ts); it holds every object in process memory and a warm serverless instance would both
 * lose them and leak them across requests.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import type {
  CreateSignedDownloadOptions,
  CreateSignedUploadOptions,
  SignedDownloadTarget,
  SignedUploadTarget,
  StorageAdapter,
  StorageObjectInfo,
} from './types.js';

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

interface UploadGrant {
  readonly key: string;
  readonly contentType: string;
}

interface DownloadGrant {
  readonly key: string;
  readonly expiresAtMs: number;
  readonly downloadFileName: string | undefined;
}

/** Matches Supabase Storage's fixed upload-token TTL so the two bindings report comparable values. */
const FAKE_UPLOAD_TTL_SECONDS = 7200;

/** The object key a request URL addresses, so a grant can be checked against it. */
function keyFromPath(pathname: string, prefix: string): string {
  return decodeURIComponent(pathname.slice(prefix.length));
}

export class FakeStorageAdapter implements StorageAdapter {
  readonly name = 'fake';

  private readonly objects = new Map<string, StoredObject>();
  private readonly uploadGrants = new Map<string, UploadGrant>();
  private readonly downloadGrants = new Map<string, DownloadGrant>();
  private server: Server | undefined;
  private origin = '';

  /** Binds the loopback server. Must be awaited before any signed URL is issued. */
  async listen(): Promise<void> {
    if (this.server !== undefined) return;

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const address = server.address() as AddressInfo;
    this.server = server;
    this.origin = `http://127.0.0.1:${String(address.port)}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Test affordance: every key currently held, for residue assertions. */
  keys(): string[] {
    return [...this.objects.keys()];
  }

  /** Test affordance: drops every object and grant. */
  reset(): void {
    this.objects.clear();
    this.uploadGrants.clear();
    this.downloadGrants.clear();
  }

  private requireOrigin(): string {
    if (this.origin === '') {
      throw new Error('FakeStorageAdapter.listen() must be awaited before issuing signed URLs.');
    }
    return this.origin;
  }

  createSignedUploadUrl(
    key: string,
    options: CreateSignedUploadOptions,
  ): Promise<SignedUploadTarget> {
    const origin = this.requireOrigin();
    const token = randomUUID().replace(/-/g, '');
    this.uploadGrants.set(token, { key, contentType: options.contentType });

    return Promise.resolve({
      url: `${origin}/upload/${encodeURIComponent(key)}?token=${token}`,
      token,
      expiresInSeconds: FAKE_UPLOAD_TTL_SECONDS,
    });
  }

  createSignedDownloadUrl(
    key: string,
    options: CreateSignedDownloadOptions,
  ): Promise<SignedDownloadTarget> {
    const origin = this.requireOrigin();
    const token = randomUUID().replace(/-/g, '');
    this.downloadGrants.set(token, {
      key,
      expiresAtMs: Date.now() + options.expiresInSeconds * 1000,
      downloadFileName: options.downloadFileName,
    });

    return Promise.resolve({
      url: `${origin}/object/${encodeURIComponent(key)}?token=${token}`,
      expiresInSeconds: options.expiresInSeconds,
    });
  }

  stat(key: string): Promise<StorageObjectInfo | null> {
    const stored = this.objects.get(key);
    return Promise.resolve(
      stored === undefined
        ? null
        : { sizeBytes: stored.bytes.length, contentType: stored.contentType },
    );
  }

  readHead(key: string, byteCount: number): Promise<Uint8Array> {
    const stored = this.objects.get(key);
    return Promise.resolve(
      stored === undefined ? new Uint8Array(0) : stored.bytes.slice(0, byteCount),
    );
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  /** Test affordance: places bytes without a signed URL, for seeding a foreign-tenant object. */
  put(key: string, bytes: Uint8Array, contentType: string): void {
    this.objects.set(key, { bytes, contentType });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);
    const token = url.searchParams.get('token') ?? '';

    if (request.method === 'PUT' && url.pathname.startsWith('/upload/')) {
      const grant = this.uploadGrants.get(token);
      // The grant covers a SPECIFIC key: re-pointing the path at another object must fail, exactly
      // as a Supabase signature covers its path. Without this the fake would accept a URL whose
      // path was swapped and quietly write to the original key.
      if (grant === undefined || grant.key !== keyFromPath(url.pathname, '/upload/')) {
        response.writeHead(401).end();
        return;
      }
      // Single-use, like a Supabase upload token: a replayed URL must not overwrite the object.
      this.uploadGrants.delete(token);

      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);

      this.objects.set(grant.key, {
        bytes: new Uint8Array(body),
        contentType: request.headers['content-type'] ?? grant.contentType,
      });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/object/')) {
      const grant = this.downloadGrants.get(token);
      if (
        grant === undefined ||
        grant.expiresAtMs <= Date.now() ||
        grant.key !== keyFromPath(url.pathname, '/object/')
      ) {
        response.writeHead(401).end();
        return;
      }

      const stored = this.objects.get(grant.key);
      if (stored === undefined) {
        response.writeHead(404).end();
        return;
      }

      const headers: Record<string, string> = { 'content-type': stored.contentType };
      if (grant.downloadFileName !== undefined) {
        headers['content-disposition'] = `attachment; filename="${grant.downloadFileName}"`;
      }
      response.writeHead(200, headers).end(Buffer.from(stored.bytes));
      return;
    }

    response.writeHead(404).end();
  }
}
