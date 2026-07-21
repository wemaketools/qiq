/**
 * Error-taxonomy -> RFC 7807 mapping (AC-014, AC-096, V-017, V-124).
 *
 * The expected `type` URIs and default titles below are NOT guesses: they were captured from a
 * live ASP.NET Core 10 `Results.Problem(...)` host reproducing the QuoteIQ call sites
 * (src/api/QuoteIQ.Api/Endpoints/BrokerEndpoints.cs `ProblemFromError`,
 * src/api/QuoteIQ.Api/Auth/RequirePermissionFilter.cs). Note 422 resolves to an RFC 4918 URI, not
 * the RFC 9110 pattern the other statuses use — the reason this table is measured, not assumed.
 */
import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  IllegalOperationError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../../lib/errors/index.js';
import {
  PROBLEM_JSON_CONTENT_TYPE,
  SANITIZED_INTERNAL_DETAIL,
  problemResponse,
  toProblem,
} from '../../lib/errors/problem.js';

const CORRELATION_ID = '11111111-2222-3333-4444-555555555555';

/** Captured from the live .NET reference host (see file header). */
const DOTNET_REFERENCE = [
  { status: 400, type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1', title: 'Bad Request' },
  { status: 401, type: 'https://tools.ietf.org/html/rfc9110#section-15.5.2', title: 'Unauthorized' },
  { status: 403, type: 'https://tools.ietf.org/html/rfc9110#section-15.5.4', title: 'Forbidden' },
  { status: 404, type: 'https://tools.ietf.org/html/rfc9110#section-15.5.5', title: 'Not Found' },
  { status: 409, type: 'https://tools.ietf.org/html/rfc9110#section-15.5.10', title: 'Conflict' },
  { status: 422, type: 'https://tools.ietf.org/html/rfc4918#section-11.2', title: 'Unprocessable Entity' },
  {
    status: 500,
    type: 'https://tools.ietf.org/html/rfc9110#section-15.6.1',
    title: 'An error occurred while processing your request.',
  },
] as const;

describe('problem+json type/title table matches the .NET reference', () => {
  it.each(DOTNET_REFERENCE)('status $status maps to the reference type and title', (reference) => {
    const problem = toProblem(new AppError(reference.status, 'reference probe'), CORRELATION_ID);

    expect(problem.status).toBe(reference.status);
    expect(problem.type).toBe(reference.type);
    expect(problem.title).toBe(reference.title);
  });

  it('serializes keys in the .NET order: type, title, status, detail, then extensions', () => {
    const problem = toProblem(
      new NotFoundError('Broker 7 was not found.', { code: 'BROKER_NOT_FOUND' }),
      CORRELATION_ID,
    );

    expect(Object.keys(problem)).toEqual(['type', 'title', 'status', 'detail', 'code', 'correlationId']);
  });
});

describe('error taxonomy -> status and shape', () => {
  it('ValidationError defaults to 422 and carries structured errors[]', () => {
    const error = new ValidationError([
      { field: 'name', code: 'NotEmptyValidator', message: "'Name' must not be empty." },
      { field: 'dateReceived', code: 'PredicateValidator', message: 'Date received cannot be in the future.' },
    ]);

    const problem = toProblem(error, CORRELATION_ID);

    expect(problem.status).toBe(422);
    expect(problem.title).toBe('Unprocessable Entity');
    expect(problem.errors).toEqual([
      { field: 'name', code: 'NotEmptyValidator', message: "'Name' must not be empty." },
      { field: 'dateReceived', code: 'PredicateValidator', message: 'Date received cannot be in the future.' },
    ]);
  });

  it('ValidationError joins field messages into detail so the existing SPA fallback still renders text', () => {
    // src/ui/src/api/client.ts `toNormalizedError` falls back to `body.detail`; the .NET handlers
    // joined FluentValidation messages with "; " behind the error code (CreateBrokerCommandHandler).
    const error = new ValidationError([
      { field: 'name', code: 'NotEmptyValidator', message: "'Name' must not be empty." },
      { field: 'email', code: 'EmailValidator', message: "'Email' is not a valid email address." },
    ]);

    expect(toProblem(error, CORRELATION_ID).detail).toBe(
      "VALIDATION_FAILED: 'Name' must not be empty.; 'Email' is not a valid email address.",
    );
  });

  it('ValidationError can be constructed as a 400 for malformed rather than invalid input', () => {
    const error = new ValidationError([], { status: 400, message: 'The request body is not valid JSON.' });

    expect(toProblem(error, CORRELATION_ID).status).toBe(400);
    expect(toProblem(error, CORRELATION_ID).title).toBe('Bad Request');
  });

  it('UnauthorizedError maps to 401 with no code extension (matches RequirePermissionFilter)', () => {
    const problem = toProblem(
      new UnauthorizedError('No active application user could be resolved for the authenticated principal.'),
      CORRELATION_ID,
    );

    expect(problem.status).toBe(401);
    expect(problem.detail).toBe(
      'No active application user could be resolved for the authenticated principal.',
    );
    expect(problem.code).toBeUndefined();
  });

  it('ForbiddenError maps to 403', () => {
    expect(toProblem(new ForbiddenError("Missing required permission 'broker.edit'."), CORRELATION_ID).status).toBe(403);
  });

  it('NotFoundError renders detail as "CODE: message" when a domain code is present', () => {
    const problem = toProblem(
      new NotFoundError('Broker 7 was not found.', { code: 'BROKER_NOT_FOUND' }),
      CORRELATION_ID,
    );

    expect(problem.status).toBe(404);
    expect(problem.detail).toBe('BROKER_NOT_FOUND: Broker 7 was not found.');
    expect(problem.code).toBe('BROKER_NOT_FOUND');
  });

  it('ConflictError maps to 409', () => {
    const problem = toProblem(
      new ConflictError('A broker named "Acme" already exists.', { code: 'BROKER_DUPLICATE_NAME' }),
      CORRELATION_ID,
    );

    expect(problem.status).toBe(409);
    expect(problem.code).toBe('BROKER_DUPLICATE_NAME');
  });

  it('IllegalOperationError is a 409 carrying the legal-operation hint', () => {
    const problem = toProblem(
      new IllegalOperationError('Quote QT-1 cannot be bound from status Lost.', {
        code: 'QUOTE_ILLEGAL_TRANSITION',
        availableOperations: ['reopen', 'correct'],
      }),
      CORRELATION_ID,
    );

    expect(problem.status).toBe(409);
    expect(problem.availableOperations).toEqual(['reopen', 'correct']);
  });

  it('every problem carries the correlation id', () => {
    for (const error of [
      new ValidationError([]),
      new UnauthorizedError('no'),
      new ForbiddenError('no'),
      new NotFoundError('no'),
      new ConflictError('no'),
      new InternalError('no'),
    ]) {
      expect(toProblem(error, CORRELATION_ID).correlationId).toBe(CORRELATION_ID);
    }
  });
});

describe('500 sanitization (AC-014, AC-096, V-124)', () => {
  const LEAK = 'password=hunter2 at Object.query (/var/task/src/server/lib/db/index.js:42:9)';

  it('an unexpected non-AppError becomes a sanitized 500 with the correlation id only', () => {
    const thrown = new Error(`connect ECONNREFUSED postgres://app:${LEAK}`);
    thrown.stack = `Error: boom\n    at ${LEAK}`;

    const problem = toProblem(thrown, CORRELATION_ID);
    const serialized = JSON.stringify(problem);

    expect(problem.status).toBe(500);
    expect(problem.detail).toBe(SANITIZED_INTERNAL_DETAIL);
    expect(problem.correlationId).toBe(CORRELATION_ID);
    expect(serialized).not.toContain(LEAK);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('postgres://');
    expect(serialized).not.toContain('/var/task/');
    expect(serialized).not.toContain('ECONNREFUSED');
  });

  it('does not leak a thrown string, object, or nested cause either', () => {
    for (const thrown of [
      LEAK,
      { message: LEAK },
      new Error('outer', { cause: new Error(LEAK) }),
    ]) {
      expect(JSON.stringify(toProblem(thrown, CORRELATION_ID))).not.toContain('hunter2');
    }
  });

  it('an explicitly constructed InternalError still never echoes its own message', () => {
    const problem = toProblem(new InternalError(`failed: ${LEAK}`), CORRELATION_ID);

    expect(problem.detail).toBe(SANITIZED_INTERNAL_DETAIL);
    expect(JSON.stringify(problem)).not.toContain('hunter2');
  });
});

describe('problemResponse', () => {
  it('uses the problem+json media type and the mapped status', async () => {
    const response = problemResponse(new NotFoundError('nope'), CORRELATION_ID);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe(PROBLEM_JSON_CONTENT_TYPE);
    expect(await response.json()).toMatchObject({ status: 404, correlationId: CORRELATION_ID });
  });
});
