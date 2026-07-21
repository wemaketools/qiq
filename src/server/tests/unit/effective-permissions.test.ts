/**
 * The pure effective-permission resolver (T-012, AC-018, V-022).
 *
 * These are the ported behavioural cases from
 * `src/api/tests/QuoteIQ.Infrastructure.Tests/Security/EffectivePermissionResolverTests.cs` — one
 * `it` per `[Fact]`, same names in spirit — plus the removal matrix V-022 asks for.
 *
 * POSITIVE CONTROLS: every exclusion case below also asserts that a control permission which SHOULD
 * survive is still present. Without that, an over-broad implementation that returns an empty set for
 * everything would pass every "ShouldExclude" test. (This exact failure mode was caught in T-004 and
 * T-006, so it is guarded explicitly rather than trusted.)
 */
import { describe, expect, it } from 'vitest';

import {
  computeEffectivePermissions,
  createEffectiveAccess,
} from '../../domains/rbac/effective-permissions.js';
import type {
  GrantGraph,
  GrantSource,
  PermissionGrant,
  TenantScopeValue,
} from '../../domains/rbac/types.js';
import { toTenantId, type TenantId } from '../../lib/db/index.js';

const TENANT_A: TenantId = toTenantId(101);
const TENANT_B: TenantId = toTenantId(202);

const P_DIRECT = 'leads.view';
const P_ROLE = 'leads.create';
const P_GROUP_ROLE = 'quotes.view';
const P_GROUP_DIRECT = 'quotes.create';
/** Never revoked by any case below; proves an exclusion is targeted, not a blanket denial. */
const P_CONTROL = 'alerts.view';

function grant(
  permissionCode: string,
  source: GrantSource,
  pathScopes: readonly TenantScopeValue[],
  pathActive = true,
): PermissionGrant {
  return { permissionCode, source, pathScopes, pathActive };
}

/** The AC-018 fixture: all four grant paths in tenant A, plus a global control grant. */
function fourPathGraph(overrides: readonly PermissionGrant[] = []): GrantGraph {
  return {
    userId: 1,
    grants: [
      grant(P_DIRECT, 'direct', [TENANT_A]),
      grant(P_ROLE, 'role', [TENANT_A, TENANT_A]),
      grant(P_GROUP_ROLE, 'group_role', [TENANT_A, TENANT_A]),
      grant(P_GROUP_DIRECT, 'group_direct', [TENANT_A]),
      grant(P_CONTROL, 'direct', [null]),
      ...overrides,
    ],
  };
}

function resolve(graph: GrantGraph, tenantId: TenantId | null): ReadonlySet<string> {
  return computeEffectivePermissions(graph, { tenantId });
}

describe('computeEffectivePermissions: union across grant paths', () => {
  it('returns exactly the union of the direct, role, group-role and group-direct grants in tenant A', () => {
    const effective = resolve(fourPathGraph(), TENANT_A);

    expect([...effective].sort()).toEqual(
      [P_DIRECT, P_ROLE, P_GROUP_ROLE, P_GROUP_DIRECT, P_CONTROL].sort(),
    );
  });

  it.each([
    ['direct', P_DIRECT],
    ['role', P_ROLE],
    ['group-role', P_GROUP_ROLE],
    ['group-direct', P_GROUP_DIRECT],
  ])('includes the permission granted only via the %s path', (_label, code) => {
    const only: GrantGraph = {
      userId: 1,
      grants: fourPathGraph().grants.filter((g) => g.permissionCode === code),
    };

    expect(resolve(only, TENANT_A).has(code)).toBe(true);
  });

  it.each([
    ['direct', P_DIRECT],
    ['role', P_ROLE],
    ['group-role', P_GROUP_ROLE],
    ['group-direct', P_GROUP_DIRECT],
  ])('removing the %s path removes exactly its contribution', (_label, removed) => {
    const graph: GrantGraph = {
      userId: 1,
      grants: fourPathGraph().grants.filter((g) => g.permissionCode !== removed),
    };

    const effective = resolve(graph, TENANT_A);

    expect(effective.has(removed)).toBe(false);
    // Positive control: the other three paths and the control grant are untouched.
    for (const survivor of [P_DIRECT, P_ROLE, P_GROUP_ROLE, P_GROUP_DIRECT, P_CONTROL]) {
      if (survivor === removed) continue;
      expect(effective.has(survivor)).toBe(true);
    }
  });

  it('de-duplicates a permission conferred by more than one path', () => {
    const graph: GrantGraph = {
      userId: 1,
      grants: [
        grant(P_DIRECT, 'direct', [TENANT_A]),
        grant(P_DIRECT, 'role', [TENANT_A, TENANT_A]),
        grant(P_DIRECT, 'group_direct', [TENANT_A]),
      ],
    };

    expect([...resolve(graph, TENANT_A)]).toEqual([P_DIRECT]);
  });

  it('resolves a user with no grants to the empty set', () => {
    expect(resolve({ userId: 1, grants: [] }, TENANT_A).size).toBe(0);
  });
});

describe('computeEffectivePermissions: tenant scoping', () => {
  it('confers none of the tenant-A grants when resolving tenant B', () => {
    const effective = resolve(fourPathGraph(), TENANT_B);

    for (const code of [P_DIRECT, P_ROLE, P_GROUP_ROLE, P_GROUP_DIRECT]) {
      expect(effective.has(code)).toBe(false);
    }
    // Positive control: the GLOBAL grant does cross, so tenant B is not simply empty.
    expect(effective.has(P_CONTROL)).toBe(true);
  });

  it('applies a global grant in any tenant and in the global scope', () => {
    const graph: GrantGraph = { userId: 1, grants: [grant(P_ROLE, 'role', [null, null])] };

    expect(resolve(graph, TENANT_A).has(P_ROLE)).toBe(true);
    expect(resolve(graph, TENANT_B).has(P_ROLE)).toBe(true);
    expect(resolve(graph, null).has(P_ROLE)).toBe(true);
  });

  it('resolves global grants for an Internal user with zero tenant memberships', () => {
    // Prior-build T-045 parity: the global scope is a real scope, not an empty placeholder.
    const graph: GrantGraph = {
      userId: 1,
      grants: [
        grant('global.view_any_tenant', 'role', [null, null]),
        grant(P_DIRECT, 'direct', [TENANT_A]),
      ],
    };

    const effective = resolve(graph, null);

    expect(effective.has('global.view_any_tenant')).toBe(true);
    // A tenant-scoped grant must NOT leak into the global scope.
    expect(effective.has(P_DIRECT)).toBe(false);
  });

  it('requires EVERY hop of a multi-hop path to be in scope', () => {
    // A group in tenant A carrying a role scoped to tenant B: the reference ANDs both predicates,
    // so this confers nothing in either tenant. Collapsing pathScopes to one value would grant it.
    const graph: GrantGraph = {
      userId: 1,
      grants: [grant(P_GROUP_ROLE, 'group_role', [TENANT_A, TENANT_B]), grant(P_CONTROL, 'direct', [null])],
    };

    expect(resolve(graph, TENANT_A).has(P_GROUP_ROLE)).toBe(false);
    expect(resolve(graph, TENANT_B).has(P_GROUP_ROLE)).toBe(false);
    expect(resolve(graph, TENANT_A).has(P_CONTROL)).toBe(true);
  });

  it('honours a global hop combined with a tenant-scoped hop', () => {
    // Global role assigned within tenant A: in scope for A, out of scope for B.
    const graph: GrantGraph = { userId: 1, grants: [grant(P_ROLE, 'role', [TENANT_A, null])] };

    expect(resolve(graph, TENANT_A).has(P_ROLE)).toBe(true);
    expect(resolve(graph, TENANT_B).has(P_ROLE)).toBe(false);
  });
});

describe('computeEffectivePermissions: disabled roles and groups', () => {
  it.each([
    ['role', grant(P_ROLE, 'role', [TENANT_A, TENANT_A], false)],
    ['group-role', grant(P_GROUP_ROLE, 'group_role', [TENANT_A, TENANT_A], false)],
    ['group-direct', grant(P_GROUP_DIRECT, 'group_direct', [TENANT_A], false)],
  ])('excludes a grant whose %s path is inactive', (_label, inactiveGrant) => {
    const graph: GrantGraph = {
      userId: 1,
      grants: [inactiveGrant, grant(P_CONTROL, 'direct', [TENANT_A])],
    };

    const effective = resolve(graph, TENANT_A);

    expect(effective.has(inactiveGrant.permissionCode)).toBe(false);
    expect(effective.has(P_CONTROL)).toBe(true);
  });
});

describe('createEffectiveAccess', () => {
  it('agrees with computeEffectivePermissions for the same graph and scope', () => {
    const graph = fourPathGraph();

    const access = createEffectiveAccess(graph, { tenantId: TENANT_A });

    expect([...access.permissions].sort()).toEqual([...resolve(graph, TENANT_A)].sort());
    expect(access.tenantId).toBe(TENANT_A);
  });

  it('answers has() for granted and ungranted codes', () => {
    const access = createEffectiveAccess(fourPathGraph(), { tenantId: TENANT_A });

    expect(access.has('leads.view')).toBe(true);
    expect(access.has('tenants.create')).toBe(false);
  });

  it('exposes visibility breadth as a queryable capability', () => {
    const graph: GrantGraph = {
      userId: 1,
      grants: [grant('leads.view_all', 'direct', [TENANT_A]), grant(P_CONTROL, 'direct', [TENANT_A])],
    };

    const access = createEffectiveAccess(graph, { tenantId: TENANT_A });

    expect(access.canViewAll('leads')).toBe(true);
    // Positive control: breadth is per-domain, not a single global flag.
    expect(access.canViewAll('quotes')).toBe(false);
  });

  it('does not report visibility breadth from a grant scoped to another tenant', () => {
    const graph: GrantGraph = { userId: 1, grants: [grant('leads.view_all', 'direct', [TENANT_A])] };

    expect(createEffectiveAccess(graph, { tenantId: TENANT_A }).canViewAll('leads')).toBe(true);
    expect(createEffectiveAccess(graph, { tenantId: TENANT_B }).canViewAll('leads')).toBe(false);
  });

  it('returns an immutable permission set', () => {
    const access = createEffectiveAccess(fourPathGraph(), { tenantId: TENANT_A });

    expect(() => (access.permissions as Set<string>).add('tenants.create')).toThrow();
    expect(access.has('tenants.create')).toBe(false);
  });
});
