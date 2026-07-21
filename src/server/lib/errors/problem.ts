/**
 * RFC 7807 problem+json mapping, preserved 1:1 from the .NET reference (A-3, AC-095, AC-096).
 *
 * The `type` URIs and default titles below were captured empirically from a live ASP.NET Core 10
 * host reproducing QuoteIQ's `Results.Problem(...)` call sites — not inferred. 422 in particular
 * resolves to an RFC 4918 URI while its neighbours use RFC 9110, which is exactly the kind of
 * detail a guess gets wrong.
 *
 * Reference call sites:
 *   src/api/QuoteIQ.Api/Endpoints/BrokerEndpoints.cs  (ProblemFromError: status/title/detail/code)
 *   src/api/QuoteIQ.Api/Auth/RequirePermissionFilter.cs (401/403, no code extension)
 *   src/api/QuoteIQ.Api/Endpoints/IntakeEndpoints.cs   (422 with errors:[{field,code,message}])
 *
 * Additions over the reference: `correlationId` on every problem (spec §14/§15) and `errors[]` on
 * SPA-facing validation failures (spec §14, AC-096) — both additive; `detail` is still populated so
 * the SPA's existing `detail ?? title` fallback keeps rendering a message.
 */
import type { FieldError } from './index.js';
import { isAppError } from './index.js';

export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';

/**
 * Detail returned for every unexpected failure. Deliberately constant: no exception message, SQL,
 * connection string, or stack ever reaches the client (AC-014). The correlation id is the only
 * handle the caller gets, and it joins the response to the full server-side log record.
 */
export const SANITIZED_INTERNAL_DETAIL =
  'An unexpected error occurred. Quote the correlation id when contacting support.';

/** Empirically captured from ASP.NET Core 10 `Results.Problem(statusCode: n)`. */
const PROBLEM_TYPES: Readonly<Record<number, string>> = {
  400: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
  401: 'https://tools.ietf.org/html/rfc9110#section-15.5.2',
  403: 'https://tools.ietf.org/html/rfc9110#section-15.5.4',
  404: 'https://tools.ietf.org/html/rfc9110#section-15.5.5',
  409: 'https://tools.ietf.org/html/rfc9110#section-15.5.10',
  422: 'https://tools.ietf.org/html/rfc4918#section-11.2',
  500: 'https://tools.ietf.org/html/rfc9110#section-15.6.1',
};

const PROBLEM_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'An error occurred while processing your request.',
};

/**
 * Statuses outside the taxonomy fall back to `about:blank` rather than a guessed URI: a later task
 * adding (say) 429 must probe the reference and extend the table above, not invent a value.
 */
export function problemTypeFor(status: number): string {
  return PROBLEM_TYPES[status] ?? 'about:blank';
}

export function problemTitleFor(status: number): string {
  return PROBLEM_TITLES[status] ?? PROBLEM_TITLES[500]!;
}

/** Key order mirrors ASP.NET's serialization: type, title, status, detail, then extensions. */
export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly FieldError[];
  readonly availableOperations?: readonly string[];
  readonly correlationId: string;
}

/** `"CODE: message"`, the detail convention used across the .NET endpoint mappers. */
function renderDetail(code: string | undefined, message: string): string {
  return code === undefined ? message : `${code}: ${message}`;
}

export function toProblem(error: unknown, correlationId: string): ProblemDocument {
  const status = isAppError(error) ? error.status : 500;

  // Every 5xx is sanitized regardless of how it was constructed, so a domain author cannot leak
  // internals by putting them in an InternalError message.
  if (status >= 500) {
    return {
      type: problemTypeFor(status),
      title: problemTitleFor(status),
      status,
      detail: SANITIZED_INTERNAL_DETAIL,
      correlationId,
    };
  }

  const appError = isAppError(error) ? error : undefined;
  const detail = appError === undefined ? undefined : renderDetail(appError.code, appError.message);

  return {
    type: problemTypeFor(status),
    title: problemTitleFor(status),
    status,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    ...(appError?.code === undefined ? {} : { code: appError.code }),
    ...(appError?.fieldErrors === undefined || appError.fieldErrors.length === 0
      ? {}
      : { errors: appError.fieldErrors }),
    ...(appError?.availableOperations === undefined
      ? {}
      : { availableOperations: appError.availableOperations }),
    correlationId,
  };
}

export function problemResponse(error: unknown, correlationId: string): Response {
  const problem = toProblem(error, correlationId);
  return new Response(JSON.stringify(problem), {
    status: problem.status,
    headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE },
  });
}
