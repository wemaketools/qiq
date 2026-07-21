/**
 * API error taxonomy (spec §14, AC-096).
 *
 * Each class pins the HTTP status the .NET reference returned for that class of failure; the
 * mapping to the wire shape lives in ./problem.ts. Errors thrown here are caught by the router's
 * error boundary — domain code should still prefer `Result` (lib/result.ts) for expected business
 * failures and throw only at boundaries where a Result cannot flow.
 */

/** One structured validation failure, matching the .NET `IntakeErrorDto(field, code, message)`. */
export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface AppErrorOptions {
  /** Domain error code echoed as the problem+json `code` extension (BrokerEndpoints convention). */
  readonly code?: string;
  readonly fieldErrors?: readonly FieldError[];
  /** 409 legal-operation hint: what the caller *may* do from the current state. */
  readonly availableOperations?: readonly string[];
  readonly cause?: unknown;
}

/**
 * Base class for every failure that has a deliberate HTTP representation. Anything else reaching
 * the error boundary is treated as unexpected and sanitized into a 500.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly fieldErrors: readonly FieldError[] | undefined;
  readonly availableOperations: readonly string[] | undefined;

  constructor(status: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = status;
    this.code = options.code;
    this.fieldErrors = options.fieldErrors;
    this.availableOperations = options.availableOperations;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Default code used when a boundary validation failure has no ported domain code. */
export const VALIDATION_FAILED_CODE = 'VALIDATION_FAILED';

export interface ValidationErrorOptions extends AppErrorOptions {
  /** 422 for a well-formed but invalid payload; 400 for one that could not even be read. */
  readonly status?: 400 | 422;
  readonly message?: string;
}

/**
 * 422 by default (well-formed payload that fails the ported FluentValidation rules); 400 when the
 * request could not be parsed at all.
 */
export class ValidationError extends AppError {
  constructor(fieldErrors: readonly FieldError[], options: ValidationErrorOptions = {}) {
    const message = options.message ?? fieldErrors.map((error) => error.message).join('; ');
    super(options.status ?? 422, message, {
      ...options,
      code: options.code ?? VALIDATION_FAILED_CODE,
      fieldErrors,
    });
  }
}

/** 401 — no authenticated principal, or no active application user behind it. */
export class UnauthorizedError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(401, message, options);
  }
}

/**
 * 403 — authenticated but not permitted, including tenant-context violations. Messages must never
 * disclose whether the target resource exists.
 */
export class ForbiddenError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(403, message, options);
  }
}

/** 404 — nonexistent id, and the deliberate answer for a cross-tenant id. */
export class NotFoundError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(404, message, options);
  }
}

/** 409 — the request conflicts with current state (duplicate name, concurrent edit). */
export class ConflictError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(409, message, options);
  }
}

export interface IllegalOperationOptions extends AppErrorOptions {
  /** Required here: an illegal transition must tell the caller what *is* legal. */
  readonly availableOperations: readonly string[];
}

/** 409 for an illegal workflow transition, carrying the legal-operation hint (AC-096). */
export class IllegalOperationError extends ConflictError {
  constructor(message: string, options: IllegalOperationOptions) {
    super(message, options);
  }
}

/**
 * 500 — an unexpected condition. The message is for the server log only; it is never rendered to
 * the client (see problem.ts).
 */
export class InternalError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(500, message, options);
  }
}
