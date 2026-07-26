import { getAccessToken, handleUnauthorized } from '../auth/supabase';
import { store } from '../app/store';

/**
 * Single API client module (spec §10.1): every backend call goes through `apiGet`/`apiPost`/
 * `apiPut` so bearer-token attachment, `X-Tenant-Id` header injection, and error normalization
 * live in exactly one place. `X-Tenant-Id` is omitted for `/tenants`, `/global`, and `/me` paths,
 * mirroring the API's `TenantContextMiddleware` exemptions (src/api/QuoteIQ.Api/Tenancy/TenantContextMiddleware.cs).
 */
export const API_BASE_URL = '/api/v1';

const TENANT_EXEMPT_PREFIXES = ['/tenants', '/global', '/me'];

export interface FieldError {
  field: string;
  message: string;
}

/** Normalized shape every caller of the API client works with, regardless of backend error format. */
export interface NormalizedError {
  status: number;
  title: string;
  fieldErrors: FieldError[];
}

/**
 * The API's problem+json wire shape (`src/server/lib/errors/problem.ts`, spec §14/AC-096).
 *
 * `errors` is an **array** of `{ field, code, message }` — not the ASP.NET-style
 * `Record<string, string[]>` dictionary this client used to assume. That mismatch (F-043-1) was
 * not a cosmetic one: `Object.entries(...).flatMap(([field, messages]) => messages.map(...))`
 * threw a `TypeError` on the real payload, and it threw *inside* `toNormalizedError` before
 * `detail` was ever read — so every call site's `catch (error: NormalizedError)` received a
 * `TypeError` instead, and the populated `detail` could not rescue it. It stayed latent only
 * because no validated backend endpoint had been exposed to the SPA until the dev proxy landed.
 */
interface ProblemDetailsBody {
  status?: number;
  title?: string;
  detail?: string;
  code?: string;
  errors?: unknown;
  correlationId?: string;
}

/** One structured validation failure as the API emits it (`FieldError` in src/server/lib/errors). */
interface ProblemFieldError {
  field?: unknown;
  code?: unknown;
  message?: unknown;
}

/**
 * Narrows the problem document's `errors` extension into the SPA's `FieldError[]`. Anything that
 * is not the documented array-of-objects shape yields an empty list rather than throwing: error
 * normalization is the last line of defence and must never itself fail.
 */
function toFieldErrors(errors: unknown): FieldError[] {
  if (!Array.isArray(errors)) {
    return [];
  }
  return errors.flatMap((entry: ProblemFieldError): FieldError[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const field = typeof entry.field === 'string' ? entry.field : '';
    const message = typeof entry.message === 'string' ? entry.message : '';
    return message === '' ? [] : [{ field, message }];
  });
}

function isTenantExempt(path: string): boolean {
  return TENANT_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function resolveTenantHeader(path: string): string | null {
  if (isTenantExempt(path)) {
    return null;
  }
  const activeTenantId = store.getState().session.activeTenantId;
  return activeTenantId != null ? String(activeTenantId) : null;
}

async function toNormalizedError(response: Response): Promise<NormalizedError> {
  let body: ProblemDetailsBody | undefined;
  try {
    body = (await response.json()) as ProblemDetailsBody;
  } catch {
    body = undefined;
  }

  return {
    // `||`, not `??`, on `statusText`: over HTTP/2 it is ALWAYS the empty string, and an empty
    // title is worse than a generic one — every call site does `setError(err.title ?? fallback)`,
    // which keeps `''` and then renders the `!error` branch. That is how a platform-level 404 on
    // every nested `/api/v1` route surfaced as "No dashboard data available." instead of an error.
    title: body?.detail ?? body?.title ?? (response.statusText || 'Request failed'),
    status: response.status,
    fieldErrors: toFieldErrors(body?.errors),
  };
}

async function request<T>(method: string, path: string, body?: unknown, extraOkStatuses?: readonly number[]): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const tenantHeader = resolveTenantHeader(path);
  if (tenantHeader) {
    headers['X-Tenant-Id'] = tenantHeader;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401) {
    const normalized = await toNormalizedError(response);
    // The bearer token is missing/expired/invalid — force re-authentication (FR-01/AC-001)
    // rather than surfacing a confusing in-app error.
    await handleUnauthorized();
    throw normalized;
  }

  const isExtraOkStatus = extraOkStatuses?.includes(response.status) ?? false;
  if (!response.ok && !isExtraOkStatus) {
    throw await toNormalizedError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

/**
 * `extraOkStatuses` lets a specific call site treat additional HTTP status codes as a successful
 * (non-`ProblemDetails`) JSON body rather than an error to normalize/throw — needed for
 * `POST /leads`, whose confirm-gated duplicate-lead response (spec FR-31) is a `CreateLeadOutcomeDto`
 * body on `409 Conflict`, not a `ProblemDetails` payload (`LeadEndpoints.CreateLeadAsync`,
 * `Results.Json(result.Value, statusCode: 409)`). Kept on the shared client (rather than a bespoke
 * fetch in `leadsApi.ts`) so bearer-token attachment, `X-Tenant-Id` injection, and 401 handling stay
 * in the one place this module's header comment already promises.
 */
export function apiPost<T>(path: string, body?: unknown, extraOkStatuses?: readonly number[]): Promise<T> {
  return request<T>('POST', path, body, extraOkStatuses);
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body);
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

/**
 * Transfers a file's bytes DIRECTLY to a signed storage URL (spec A-7/M-25, T-028's attachment
 * envelope): the bytes never pass through `/api/v1`, which lets a file above Vercel's ~4.5 MB
 * function-body cap upload successfully. Uses `XMLHttpRequest` rather than `fetch` because only XHR
 * exposes upload-progress events, and `onProgress` reports the fraction complete (0..1).
 *
 * Two deliberate omissions: the app bearer token is NEVER attached — the signed URL is the sole
 * credential and the app token must not reach the storage host — and `X-Tenant-Id` is not sent,
 * because the storage host is not the API. A non-2xx status (an expired signed URL answers 4xx) or a
 * transport error rejects with a `NormalizedError` so every call site's existing `catch` keeps
 * working unchanged.
 */
export function putFileToSignedUrl(
  url: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type !== '' ? file.type : 'application/octet-stream');
    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent): void => {
        if (event.lengthComputable && event.total > 0) {
          onProgress(event.loaded / event.total);
        }
      };
    }
    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(storageTransferError(xhr.status));
      }
    };
    xhr.onerror = (): void => reject(storageTransferError(0));
    xhr.onabort = (): void => reject(storageTransferError(0));
    xhr.send(file);
  });
}

/** The `NormalizedError` shape a failed direct-to-storage transfer surfaces to the UI (T-028). */
function storageTransferError(status: number): NormalizedError {
  return {
    status,
    title: 'The file could not be transferred to storage. Please try again.',
    fieldErrors: [],
  };
}

/**
 * Follows a short-lived signed download URL (spec A-7/M-25, T-028): the URL already carries
 * `Content-Disposition: attachment`, so navigating to it downloads rather than renders. A transient
 * anchor is used (rather than assigning `window.location`) so the current SPA view is not unloaded.
 * No app token is attached — the signed URL is self-authorizing.
 */
export function navigateToSignedUrl(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** One quote attachment download's bytes plus the filename the server suggested (spec FR-48, T-021's `GET /attachments/{id}` `Results.Stream(...)` response). */
export interface DownloadedFile {
  blob: Blob;
  fileName: string | null;
}

function fileNameFromContentDisposition(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(headerValue);
  return quotedMatch?.[1] ?? null;
}

/**
 * Downloads a binary response as a `Blob` (spec FR-48, T-021's attachment download endpoint) —
 * separate from `request<T>` because the response body is never JSON here. Same bearer-token/
 * `X-Tenant-Id`/401 handling as every other call.
 */
export async function apiGetBlob(path: string): Promise<DownloadedFile> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const tenantHeader = resolveTenantHeader(path);
  if (tenantHeader) {
    headers['X-Tenant-Id'] = tenantHeader;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, { method: 'GET', headers });

  if (response.status === 401) {
    const normalized = await toNormalizedError(response);
    await handleUnauthorized();
    throw normalized;
  }

  if (!response.ok) {
    throw await toNormalizedError(response);
  }

  const fileName = fileNameFromContentDisposition(response.headers.get('content-disposition'));
  const blob = await response.blob();
  return { blob, fileName };
}

/** Triggers the browser's native save-file flow for a downloaded blob (spec FR-48) via a transient anchor click. */
export function triggerBrowserDownload(file: DownloadedFile, fallbackFileName: string): void {
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.fileName ?? fallbackFileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
