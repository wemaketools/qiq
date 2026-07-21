/**
 * Request validation at the API boundary (spec §14, M-04, AC-014).
 *
 * zod is the porting target for the FluentValidation catalog; this module's only job is to turn a
 * `ZodError` into the preserved wire shape:
 *
 *   errors: [{ field, code, message }]
 *
 * which mirrors the .NET intake contract
 * (`new IntakeErrorDto(ToCamelCase(e.PropertyName), e.ErrorCode ?? "INVALID", e.ErrorMessage)` in
 * IntakeLeadCommandHandler.cs) — camelCase field path, FluentValidation `ErrorCode`, validator
 * message, with `"INVALID"` as the reference's own fallback.
 *
 * The zod-issue -> FluentValidation-code table below covers the shape-level rules. Where a ported
 * validator's exact `ErrorCode` matters, pin it at the schema by writing the message as
 * `"CODE|human message"`; `toFieldErrors` splits it back apart. That keeps the per-rule codes with
 * the per-rule schema (T-025/T-026 port them verbatim) instead of in a growing central map.
 */
import type { ZodError, ZodType, ZodIssue } from 'zod';

import { ValidationError, type FieldError } from '../errors/index.js';

/**
 * Matches a message that pins an explicit error code, e.g. `LEAD_DATE_RECEIVED_FUTURE|...` or
 * `PredicateValidator|...`.
 *
 * Both casings are legitimate and neither is a house-style preference (T-046):
 *   - PascalCase (`NotNullValidator`) is FluentValidation's *default* `ErrorCode` — the validator
 *     type name. The .NET reference never calls `WithErrorCode`, so these are literally the codes
 *     the old API put on the wire, and `codeForIssue` below derives the very same spellings.
 *   - SCREAMING_SNAKE (`LEAD_*`) is used where a ported rule had a custom code.
 *
 * The grammar therefore admits `[A-Z][A-Za-z0-9_]*`, which covers both. An earlier
 * `[A-Z][A-Z0-9_]*` excluded the PascalCase form, and because the parser had no failure mode the
 * result was silent degradation: the pinned code was replaced by the derived one *and* the literal
 * `NotNullValidator|` prefix leaked into the user-visible message, with no signal either way.
 */
const EXPLICIT_CODE = /^([A-Z][A-Za-z0-9_]*)\|([\s\S]*)$/;

/**
 * A prefix-shaped candidate: everything before the first `|`, when it contains no whitespace.
 * Prose legitimately contains spaced pipes (`'Allowed: New | Assigned'`), and every such message
 * in the tree has whitespace around the bar, so requiring an unbroken token keeps prose out.
 */
const PREFIX_SHAPED = /^([^\s|]+)\|/;

/**
 * Rejects a prefix that was clearly *meant* as a rule code but does not conform. Silence is the
 * defect this guards: without it a malformed prefix yields a plausible-looking derived code and a
 * leaked message, which is indistinguishable from correct behaviour at a 422. Failing here turns
 * that into an immediate, attributable developer error.
 */
function assertNoMalformedPrefix(message: string): void {
  const shaped = PREFIX_SHAPED.exec(message);
  if (shaped !== null && !EXPLICIT_CODE.test(message)) {
    throw new Error(
      `Validation message carries a non-conforming rule-code prefix ${JSON.stringify(shaped[1])}; ` +
        'an explicit code must match [A-Z][A-Za-z0-9_]* (e.g. "NotNullValidator|..." or ' +
        `"LEAD_REQUIRED|..."). Offending message: ${JSON.stringify(message)}`,
    );
  }
}

/** The reference's fallback when FluentValidation supplied no ErrorCode. */
export const FALLBACK_ERROR_CODE = 'INVALID';

/** `contacts[0].name` — FluentValidation's property-path rendering. */
export function formatFieldPath(path: readonly PropertyKey[]): string {
  let rendered = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${segment}]`;
      continue;
    }
    rendered += rendered === '' ? String(segment) : `.${String(segment)}`;
  }
  return rendered;
}

function codeForIssue(issue: ZodIssue): string {
  switch (issue.code) {
    // A missing, null, or wrong-typed property never reaches a FluentValidation rule in the
    // reference — the closest equivalent verdict is NotNull.
    case 'invalid_type':
      return 'NotNullValidator';
    case 'too_small':
      if (issue.origin === 'string' || issue.origin === 'array' || issue.origin === 'set') {
        return issue.minimum === 1 ? 'NotEmptyValidator' : 'MinimumLengthValidator';
      }
      return issue.inclusive === true ? 'GreaterThanOrEqualValidator' : 'GreaterThanValidator';
    case 'too_big':
      if (issue.origin === 'string' || issue.origin === 'array' || issue.origin === 'set') {
        return 'MaximumLengthValidator';
      }
      return issue.inclusive === true ? 'LessThanOrEqualValidator' : 'LessThanValidator';
    case 'invalid_format':
      return issue.format === 'email' ? 'EmailValidator' : 'RegularExpressionValidator';
    case 'invalid_value':
      return 'EnumValidator';
    default:
      return FALLBACK_ERROR_CODE;
  }
}

export function toFieldErrors(error: ZodError): FieldError[] {
  return error.issues.map((issue) => {
    const explicit = EXPLICIT_CODE.exec(issue.message);
    if (explicit !== null) {
      return {
        field: formatFieldPath(issue.path),
        code: explicit[1]!,
        message: explicit[2]!,
      };
    }

    assertNoMalformedPrefix(issue.message);

    return {
      field: formatFieldPath(issue.path),
      code: codeForIssue(issue),
      message: issue.message,
    };
  });
}

/** Parses with a schema, throwing a 422 `ValidationError` carrying the structured errors[]. */
export function parseOrThrow<S extends ZodType>(schema: S, value: unknown): ReturnType<S['parse']> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(toFieldErrors(result.error));
  }
  return result.data as ReturnType<S['parse']>;
}

/**
 * The slice of a Hono `Context` these helpers need. Structural on purpose: lib/validation stays
 * independent of the router's generics.
 */
export interface ValidationContext {
  readonly req: {
    json(): Promise<unknown>;
    query(): Record<string, string | undefined>;
    param(): Record<string, string | undefined>;
  };
}

/**
 * Validates the JSON request body. An unparseable body is a 400 (the request could not be read);
 * a well-formed body that breaks the rules is a 422 — the same split the reference had between
 * model-binding failures and validator failures.
 */
export async function validateBody<S extends ZodType>(
  c: ValidationContext,
  schema: S,
): Promise<ReturnType<S['parse']>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ValidationError([], {
      status: 400,
      message: 'The request body could not be read as JSON.',
    });
  }
  return parseOrThrow(schema, body);
}

export function validateQuery<S extends ZodType>(
  c: ValidationContext,
  schema: S,
): ReturnType<S['parse']> {
  return parseOrThrow(schema, c.req.query());
}

export function validateParams<S extends ZodType>(
  c: ValidationContext,
  schema: S,
): ReturnType<S['parse']> {
  return parseOrThrow(schema, c.req.param());
}
