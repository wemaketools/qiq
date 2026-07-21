/**
 * zod -> preserved 422 `errors:[{field,code,message}]` shape (AC-014, AC-096, V-017).
 *
 * The target shape is the .NET intake contract
 * (src/api/QuoteIQ.Application/Features/ApiAccess/Intake/IntakeOutcomeDto.cs `IntakeErrorDto`,
 * emitted by IntakeLeadCommandHandler as
 * `new IntakeErrorDto(ToCamelCase(e.PropertyName), e.ErrorCode ?? "INVALID", e.ErrorMessage)`):
 * camelCase field path, FluentValidation `ErrorCode`, and the validator message, with `"INVALID"`
 * as the reference's own fallback code.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from '../../lib/errors/index.js';
import { formatFieldPath, parseOrThrow, toFieldErrors } from '../../lib/validation/index.js';

describe('formatFieldPath', () => {
  it('renders nested object paths dot-separated', () => {
    expect(formatFieldPath(['broker', 'primaryContact', 'email'])).toBe('broker.primaryContact.email');
  });

  it('renders array indices in bracket notation, as FluentValidation does', () => {
    expect(formatFieldPath(['contacts', 0, 'name'])).toBe('contacts[0].name');
  });

  it('renders the empty (whole-object) path as an empty field', () => {
    expect(formatFieldPath([])).toBe('');
  });
});

describe('toFieldErrors maps zod issues to FluentValidation-style codes', () => {
  it('reports a missing required property as NotNullValidator', () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({});

    expect(result.success).toBe(false);
    const errors = toFieldErrors(result.error!);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.field).toBe('name');
    expect(errors[0]!.code).toBe('NotNullValidator');
    expect(errors[0]!.message).toBeTypeOf('string');
    expect(errors[0]!.message.length).toBeGreaterThan(0);
  });

  it('reports an empty required string as NotEmptyValidator', () => {
    const schema = z.object({ name: z.string().min(1) });
    const errors = toFieldErrors(schema.safeParse({ name: '' }).error!);

    expect(errors[0]).toMatchObject({ field: 'name', code: 'NotEmptyValidator' });
  });

  it('reports an over-long string as MaximumLengthValidator', () => {
    const schema = z.object({ name: z.string().max(3) });
    const errors = toFieldErrors(schema.safeParse({ name: 'abcd' }).error!);

    expect(errors[0]).toMatchObject({ field: 'name', code: 'MaximumLengthValidator' });
  });

  it('reports a below-minimum number as GreaterThanValidator when the bound is exclusive', () => {
    const schema = z.object({ premium: z.number().gt(0) });
    const errors = toFieldErrors(schema.safeParse({ premium: 0 }).error!);

    expect(errors[0]).toMatchObject({ field: 'premium', code: 'GreaterThanValidator' });
  });

  it('reports a below-minimum number as GreaterThanOrEqualValidator when the bound is inclusive', () => {
    const schema = z.object({ premium: z.number().min(1) });
    const errors = toFieldErrors(schema.safeParse({ premium: 0 }).error!);

    expect(errors[0]).toMatchObject({ field: 'premium', code: 'GreaterThanOrEqualValidator' });
  });

  it('reports an invalid email as EmailValidator', () => {
    const schema = z.object({ email: z.email() });
    const errors = toFieldErrors(schema.safeParse({ email: 'not-an-email' }).error!);

    expect(errors[0]).toMatchObject({ field: 'email', code: 'EmailValidator' });
  });

  it('reports a value outside an enum as EnumValidator', () => {
    const schema = z.object({ priority: z.enum(['low', 'high']) });
    const errors = toFieldErrors(schema.safeParse({ priority: 'urgent' }).error!);

    expect(errors[0]).toMatchObject({ field: 'priority', code: 'EnumValidator' });
  });

  it('falls back to the reference fallback code INVALID for unmapped issues', () => {
    const schema = z.object({ token: z.string().refine(() => false, 'nope') });
    const errors = toFieldErrors(schema.safeParse({ token: 'x' }).error!);

    expect(errors[0]).toMatchObject({ field: 'token', code: 'INVALID', message: 'nope' });
  });

  it('preserves a per-schema explicit code so ported FluentValidation codes can be pinned verbatim', () => {
    const schema = z.object({
      dateReceived: z.string().refine(() => false, { error: 'LEAD_DATE_RECEIVED_FUTURE|Date received cannot be in the future.' }),
    });
    const errors = toFieldErrors(schema.safeParse({ dateReceived: '2999-01-01' }).error!);

    expect(errors[0]).toEqual({
      field: 'dateReceived',
      code: 'LEAD_DATE_RECEIVED_FUTURE',
      message: 'Date received cannot be in the future.',
    });
  });

  /**
   * T-046. The explicit-code parser originally matched only `/^([A-Z][A-Z0-9_]*)\|/`, so the
   * PascalCase FluentValidation codes used across assignments/brokers/api-access/business-rules
   * did NOT match. That single cause produced two symptoms with no signal at all: the pinned code
   * was silently replaced by the DERIVED code, and the literal `PredicateValidator|` prefix leaked
   * into the human-readable message. Asserting the message (not just the code) is what makes the
   * leak visible — a status-only or code-only test cannot distinguish these.
   */
  it('preserves a PascalCase FluentValidation explicit code and strips the prefix from the message', () => {
    const schema = z.object({
      rmRoleId: z
        .number()
        .refine(() => false, {
          error: 'PredicateValidator|The RM role and the Underwriting role must be different roles.',
        }),
    });
    const errors = toFieldErrors(schema.safeParse({ rmRoleId: 1 }).error!);

    expect(errors[0]).toEqual({
      field: 'rmRoleId',
      code: 'PredicateValidator',
      message: 'The RM role and the Underwriting role must be different roles.',
    });
  });

  it('never leaks an explicit-code prefix into the message even when the derived code coincides', () => {
    // `.number()` on a string yields invalid_type -> derived code `NotNullValidator`, which is
    // ALSO the pinned code. The code assertion therefore passes either way; only the message
    // proves the prefix was actually parsed rather than passed through verbatim.
    const schema = z.object({
      roleId: z.number({ message: 'NotNullValidator|A role id must be a number or null.' }),
    });
    const errors = toFieldErrors(schema.safeParse({ roleId: 'x' }).error!);

    expect(errors[0]!.code).toBe('NotNullValidator');
    expect(errors[0]!.message).toBe('A role id must be a number or null.');
    expect(errors[0]!.message).not.toContain('|');
  });

  it('throws loudly on a prefix-shaped but non-conforming code rather than silently deriving one', () => {
    // The real defect was the absence of any failure mode: a malformed prefix produced a
    // plausible-looking wrong code AND a leaked message with no signal. A non-conforming prefix
    // must now be a hard developer error, never a silent fallback to the derived code.
    const schema = z.object({
      token: z.string().refine(() => false, { error: 'notNullValidator|lower-cased by mistake.' }),
    });

    expect(() => toFieldErrors(schema.safeParse({ token: 'x' }).error!)).toThrowError(
      /non-conforming rule-code prefix/i,
    );
  });

  it('leaves prose containing a spaced pipe alone instead of treating it as a code prefix', () => {
    const schema = z.object({
      status: z.string().refine(() => false, { error: 'Allowed: New | Assigned | Closed' }),
    });
    const errors = toFieldErrors(schema.safeParse({ status: 'x' }).error!);

    expect(errors[0]).toEqual({
      field: 'status',
      code: 'INVALID',
      message: 'Allowed: New | Assigned | Closed',
    });
  });

  it('reports every failing field, not just the first', () => {
    const schema = z.object({ name: z.string().min(1), email: z.email() });
    const errors = toFieldErrors(schema.safeParse({ name: '', email: 'x' }).error!);

    expect(errors.map((e) => e.field).sort()).toEqual(['email', 'name']);
  });
});

describe('parseOrThrow', () => {
  it('returns the parsed value on success', () => {
    expect(parseOrThrow(z.object({ n: z.coerce.number() }), { n: '4' })).toEqual({ n: 4 });
  });

  it('throws a ValidationError carrying the mapped errors[] on failure', () => {
    expect.assertions(3);
    try {
      parseOrThrow(z.object({ name: z.string().min(1) }), { name: '' });
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).status).toBe(422);
      expect((error as ValidationError).fieldErrors).toEqual([
        expect.objectContaining({ field: 'name', code: 'NotEmptyValidator' }),
      ]);
    }
  });
});
