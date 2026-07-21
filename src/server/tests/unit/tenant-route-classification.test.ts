/**
 * Route classification and the fail-closed default (T-013, AC-020).
 *
 * The property under test is not "the exempt list is correct" — it is "a route nobody classified
 * is tenant-scoped". Ported from `TenantContextMiddleware.RequiresTenantContext` /
 * `IsExempt` (src/api/QuoteIQ.Api/Tenancy/TenantContextMiddleware.cs:86-110).
 */
import { describe, expect, it } from 'vitest';

import {
  GLOBAL_ROUTE_PREFIXES,
  classifyRoute,
  notFoundMessage,
  requireFound,
  requiresTenantContext,
} from '../../lib/tenancy/context.js';
import { NotFoundError } from '../../lib/errors/index.js';

describe('route classification', () => {
  it('treats an unclassified /api/v1 route as tenant-scoped (fails closed)', () => {
    // The whole point: nobody has ever heard of this route, and it still demands a tenant.
    expect(classifyRoute('/api/v1/a-route-invented-after-T-013')).toBe('tenant-scoped');
    expect(classifyRoute('/api/v1/leads')).toBe('tenant-scoped');
    expect(classifyRoute('/api/v1/quotes/42/operations/bind')).toBe('tenant-scoped');
  });

  it('exempts exactly the reference global prefixes and their sub-paths', () => {
    // Positive control: these must genuinely be exempt, so the fail-closed assertions above are
    // not passing merely because the classifier says "tenant-scoped" to everything.
    expect(classifyRoute('/api/v1/tenants')).toBe('global');
    expect(classifyRoute('/api/v1/tenants/7')).toBe('global');
    expect(classifyRoute('/api/v1/global/default-reference-items')).toBe('global');
    expect(classifyRoute('/api/v1/me')).toBe('global');
    expect(classifyRoute('/api/v1/intake/leads')).toBe('global');
    expect(classifyRoute('/api/v1/health')).toBe('global');
  });

  it('does not exempt a sibling that merely shares a prefix', () => {
    // TenantContextMiddleware.IsExempt (:96-110) called this out by name. A bare startsWith would
    // hand `/api/v1/tenantsummary` the Tenant Manager's exemption and leave it unscoped.
    expect(classifyRoute('/api/v1/tenantsummary')).toBe('tenant-scoped');
    expect(classifyRoute('/api/v1/meetings')).toBe('tenant-scoped');
    expect(classifyRoute('/api/v1/globals')).toBe('tenant-scoped');
    expect(classifyRoute('/api/v1/intakes')).toBe('tenant-scoped');
  });

  it('leaves paths outside /api/v1 alone', () => {
    expect(classifyRoute('/health')).toBe('global');
    expect(classifyRoute('/')).toBe('global');
    expect(classifyRoute('/api/v2/leads')).toBe('global');
  });

  it('ignores case and trailing slashes', () => {
    expect(classifyRoute('/API/V1/TENANTS')).toBe('global');
    expect(classifyRoute('/api/v1/tenants/')).toBe('global');
    expect(classifyRoute('/api/v1/leads/')).toBe('tenant-scoped');
  });

  it('keeps requiresTenantContext as the exact inverse', () => {
    expect(requiresTenantContext('/api/v1/leads')).toBe(true);
    expect(requiresTenantContext('/api/v1/tenants')).toBe(false);
  });

  it('lists every global prefix under /api/v1', () => {
    // A prefix outside /api/v1 in this list would be dead config that silently exempts nothing.
    for (const prefix of GLOBAL_ROUTE_PREFIXES) {
      expect(prefix.startsWith('/api/v1/')).toBe(true);
      expect(classifyRoute(prefix)).toBe('global');
    }
  });
});

describe('requireFound (N-01)', () => {
  it('returns the value when present, including falsy ones', () => {
    expect(requireFound({ id: 1 }, 'Lead')).toEqual({ id: 1 });
    // Positive control against a naive `if (!value)` implementation, which would 404 on these.
    expect(requireFound(0, 'Count')).toBe(0);
    expect(requireFound('', 'Name')).toBe('');
    expect(requireFound(false, 'Flag')).toBe(false);
  });

  it('throws an identical 404 for null and for undefined', () => {
    // null = "the row was not there"; undefined = "the tenant-scoped query returned nothing".
    // A cross-tenant hit arrives as the latter, so the two must be indistinguishable.
    const fromNull = (): unknown => requireFound(null, 'Lead');
    const fromUndefined = (): unknown => requireFound(undefined, 'Lead');

    expect(fromNull).toThrow(NotFoundError);
    expect(fromUndefined).toThrow(NotFoundError);

    let nullMessage = '';
    let undefinedMessage = '';
    let nullStatus = 0;
    let undefinedStatus = 0;
    try {
      fromNull();
    } catch (error) {
      nullMessage = (error as NotFoundError).message;
      nullStatus = (error as NotFoundError).status;
    }
    try {
      fromUndefined();
    } catch (error) {
      undefinedMessage = (error as NotFoundError).message;
      undefinedStatus = (error as NotFoundError).status;
    }

    expect(nullMessage).toBe(undefinedMessage);
    expect(nullStatus).toBe(404);
    expect(undefinedStatus).toBe(404);
  });

  it('never mentions the id in the not-found message', () => {
    // The message must not become an echo channel confirming which ids were probed.
    const message = notFoundMessage('Lead');
    expect(message).toBe('Lead not found.');
    expect(message).not.toMatch(/\d/);
  });
});
