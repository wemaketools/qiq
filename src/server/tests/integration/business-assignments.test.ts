/**
 * The business-assignment slot surface, end to end (T-020; AC-022, AC-024, AC-038; V-027, V-031,
 * V-049).
 *
 * Port of the reference's `BusinessAssignmentEndpointsTests`, same shape as
 * `reference-data.test.ts` and `business-rules.test.ts`: real signed-in sessions, real tenants and
 * partitions, real grants, the real Hono pipeline via `app.request`. Nothing is stubbed — the
 * properties under test (tenant isolation, role confinement, the in-use guard) are properties of
 * the composed system.
 *
 * TWO FIXED SLOTS IS THE INVARIANT UNDER TEST (AC-038)
 * ====================================================
 * `rm` and `underwriter`, one role each. AC-038 asks that "adding a third slot" and "assigning
 * multiple roles to a slot" fail 422 — and the interesting thing about this design is that both are
 * mostly UNREPRESENTABLE rather than merely rejected: the write shape has exactly two nullable
 * fields, so a third slot can only be attempted as an unknown key, and a second role in one slot
 * cannot be spelled at all. Beneath that, `ck_business_assignments_slot` and
 * `uq_business_assignments_tenant_slot` enforce the same in the database. This suite pins the API
 * verdict AND (for the invariants the API cannot express) the database constraint directly, because
 * "unrepresentable" is a claim about the schema that deserves its own assertion.
 *
 * WHY THE ISOLATION TESTS HERE ARE LOAD-BEARING
 * ============================================
 * Postgres RLS is NOT adopted (spec Q-10, human decision 2026-07-20). Nothing beneath the tenant
 * predicates in repository.ts separates tenant A's slot configuration from tenant B's. The stakes
 * are higher than they look: these slots decide who may OWN a lead and who may underwrite a quote,
 * so a leaked or cross-written slot is an authorization change, not just a data leak. The
 * cross-tenant-role case is pinned both by its 422 and by the absence of any stored row.
 *
 * WHAT THIS SUITE DOES *NOT* COVER, AND WHY
 * =========================================
 * V-049 also asks that "the assign/reassign operation resolves eligible users from these slots".
 * That operation (`POST /leads/{id}/operations/assign`) and the `.../eligible-users` picker belong
 * to the leads/workflow tasks, which T-020 lists as `out_of_scope`; neither exists yet. The slot
 * CONSUMPTION half therefore lands with those tasks. Flagged in the task file rather than faked.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import {
  ASSIGNMENT_SLOTS,
  BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
  listSlots,
  type BusinessAssignmentsDto,
  type EligibleAssigneeDto,
} from '../../domains/assignments/index.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, toTenantId, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('business assignment slots', probe);

const PATH = '/api/v1/settings/business-assignments';

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

interface SlotRow extends Record<string, unknown> {
  readonly id: string;
  readonly slot: string;
  readonly role_id: string;
  readonly tenant_id: string;
}

const RUN = `t020ba-${process.pid}-${Date.now()}`;

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;

  /** Holds `business_assignments.manage` in BOTH tenants and is a member of both. */
  let admin: TestUserSession;
  /** Member of tenant A with no manage grant: the permission-matrix control. */
  let plainMember: TestUserSession;

  let tenantA: number;
  let tenantB: number;

  /**
   * Eligible-picker fixtures. Each user exercises exactly ONE grant path or exclusion rule, so a
   * failure names the path that broke rather than "the list was wrong".
   */
  let directHolder: TestUserSession;
  let groupHolder: TestUserSession;
  let nonHolder: TestUserSession;
  let inactiveHolder: TestUserSession;
  let outsideTenantHolder: TestUserSession;
  let approverDirect: TestUserSession;
  let approverViaRole: TestUserSession;
  let approverViaGroupRole: TestUserSession;
  let approverViaGroupDirect: TestUserSession;
  let nonApprover: TestUserSession;
  /** The `rm` slot row id in tenant A, kept configured for the whole eligible-picker block. */
  let rmAssignmentIdA = 0;

  /** Roles: two usable ones in A, one in B, one global, one inactive in A. */
  let roleA1 = 0;
  let roleA2 = 0;
  let roleA3 = 0;
  let roleB = 0;
  let globalRole = 0;
  let inactiveRoleA = 0;

  const createdTenants: number[] = [];

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  function appUserId(session: TestUserSession): number {
    if (session.appUserId === null) {
      throw new Error(`fixture user ${session.email} has no application users row`);
    }
    return Number(session.appUserId);
  }

  async function createTenant(label: string): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into tenants (name, status, created_at, updated_at)
       values ($1, 'active', now(), now()) returning id::text as id`,
      [`${RUN}-${label}`],
    );
    const id = Number(rows[0]?.id);
    createdTenants.push(id);
    await query('select create_tenant_partitions($1)', [id]);
    return id;
  }

  async function addMembership(userId: number, tenantId: number): Promise<void> {
    await query('insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())', [
      tenantId,
      userId,
    ]);
  }

  function harness(): ApiApp {
    return buildApp({
      config,
      loggerOptions: { sink: () => undefined },
      auth: {
        verifyAccessToken: createAccessTokenVerifier({ config }),
        lookupAppUser: (authUserId) => pgLookup.lookup(authUserId),
      },
      tenancy: {
        db,
        validateTenantAccess: createTenantAccessValidator({
          db,
          loadGrantGraph: createGrantGraphLoader(db),
        }),
      },
      rbac: { loadGrantGraph: createGrantGraphLoader(db) },
      assignments: { db },
    });
  }

  async function call(
    method: string,
    options: { token?: string; tenantId?: number; body?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    if (options.body !== undefined) headers.set('content-type', 'application/json');

    return await harness().request(`http://localhost${PATH}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function readSlots(tenantId: number): Promise<BusinessAssignmentsDto> {
    const response = await call('GET', { token: admin.accessToken, tenantId });
    expect(response.status).toBe(200);
    return (await response.json()) as BusinessAssignmentsDto;
  }

  async function writeSlots(
    tenantId: number,
    body: Record<string, unknown>,
  ): Promise<BusinessAssignmentsDto> {
    const response = await call('PUT', { token: admin.accessToken, tenantId, body });
    expect(response.status).toBe(200);
    return (await response.json()) as BusinessAssignmentsDto;
  }

  async function writeExpectingProblem(
    tenantId: number,
    body: Record<string, unknown>,
    expectedStatus: number,
  ): Promise<ProblemBody> {
    const response = await call('PUT', { token: admin.accessToken, tenantId, body });
    expect(response.status).toBe(expectedStatus);
    return (await response.json()) as ProblemBody;
  }

  /** Stored slot rows straight from the database — the side-effect check the API cannot fake. */
  async function storedSlots(tenantId: number): Promise<SlotRow[]> {
    return await query<SlotRow>(
      `select id::text as id, slot, role_id::text as role_id, tenant_id::text as tenant_id
         from business_assignments where tenant_id = $1 order by slot`,
      [tenantId],
    );
  }

  /** Resets both tenants to "no slots configured" between tests. */
  async function resetSlots(): Promise<void> {
    for (const tenantId of createdTenants) {
      await query('delete from lead_assignments where tenant_id = $1', [tenantId]);
      await query('delete from quote_assignments where tenant_id = $1', [tenantId]);
      await query('delete from business_assignments where tenant_id = $1', [tenantId]);
      await query('delete from audit_log where action = $1 and tenant_id = $2', [
        BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
        tenantId,
      ]);
    }
  }

  /**
   * A live lead assignee against a slot row.
   *
   * `lead_assignments` has NO foreign key to `leads` (20260718003200_leads.sql:132-146 declares only
   * the PK and the per-lead-per-slot unique constraint), so a synthetic `lead_id` is enough to
   * exercise the in-use guard without depending on T-024's lead creation. That keeps this suite
   * testing the guard rather than the leads domain.
   */
  async function seedLeadAssignment(
    tenantId: number,
    assignmentId: number,
    leadId: number,
  ): Promise<void> {
    await query(
      `insert into lead_assignments
         (tenant_id, lead_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [tenantId, leadId, assignmentId, appUserId(admin)],
    );
  }

  async function seedQuoteAssignment(
    tenantId: number,
    assignmentId: number,
    quoteId: number,
  ): Promise<void> {
    await query(
      `insert into quote_assignments
         (tenant_id, quote_id, business_assignment_id, user_id, created_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [tenantId, quoteId, assignmentId, appUserId(admin)],
    );
  }

  beforeAll(async () => {
    if (!probe.available) return;
    stack = probe.stack;

    config = loadConfig({
      APP_ENV: 'local',
      LOG_LEVEL: 'info',
      SUPABASE_DATABASE_URL: stack.dbUrl,
      SUPABASE_DIRECT_DATABASE_URL: stack.dbUrl,
      SUPABASE_URL: stack.apiUrl,
      SUPABASE_ANON_KEY: stack.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
      CRON_SECRET: 'local-cron-secret',
      INTERNAL_JOB_SECRET: 'local-internal-job-secret',
      API_KEY_PEPPER: 'local-api-key-pepper-value',
    });

    auth = new TestAuthFixtures(stack);
    fixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));

    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    pgLookup = createPgAppUserLookup(config);

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');

    admin = await auth.createTestUserWithSession({ label: 'slots-admin' });
    plainMember = await auth.createTestUserWithSession({ label: 'slots-member' });

    await addMembership(appUserId(admin), tenantA);
    await addMembership(appUserId(admin), tenantB);
    await addMembership(appUserId(plainMember), tenantA);

    await fixtures.grantDirectPermission(appUserId(admin), 'business_assignments.manage', tenantA);
    await fixtures.grantDirectPermission(appUserId(admin), 'business_assignments.manage', tenantB);
    // A DIFFERENT permission — and specifically the one the reference USED to gate the GET with, so
    // holding it must not confer the manage right.
    await fixtures.grantDirectPermission(appUserId(plainMember), 'business_assignments.view', tenantA);

    roleA1 = await fixtures.createRole({ tenantId: tenantA });
    roleA2 = await fixtures.createRole({ tenantId: tenantA });
    roleA3 = await fixtures.createRole({ tenantId: tenantA });
    roleB = await fixtures.createRole({ tenantId: tenantB });
    globalRole = await fixtures.createRole({ tenantId: null });
    inactiveRoleA = await fixtures.createRole({ tenantId: tenantA, isActive: false });

    // ---------------------------------------------------------------------------------------
    // Eligible-picker fixtures (one user per grant path / exclusion rule).
    // ---------------------------------------------------------------------------------------
    directHolder = await auth.createTestUserWithSession({
      label: 'slots-direct', firstName: 'Dinah', lastName: 'Direct',
    });
    groupHolder = await auth.createTestUserWithSession({
      label: 'slots-group', firstName: 'Gregor', lastName: 'Groupmember',
    });
    nonHolder = await auth.createTestUserWithSession({
      label: 'slots-nonholder', firstName: 'Nadia', lastName: 'Norole',
    });
    inactiveHolder = await auth.createTestUserWithSession({
      label: 'slots-inactive', firstName: 'Ivan', lastName: 'Inactive', isActive: false,
    });
    outsideTenantHolder = await auth.createTestUserWithSession({
      label: 'slots-outside', firstName: 'Otto', lastName: 'Outsider',
    });

    for (const session of [directHolder, groupHolder, nonHolder, inactiveHolder]) {
      await addMembership(appUserId(session), tenantA);
    }
    // outsideTenantHolder deliberately gets NO tenant-A membership: they hold the role but are not
    // a member, which is the isolation case the reader's user_tenants join exists to exclude.
    await addMembership(appUserId(outsideTenantHolder), tenantB);

    await fixtures.assignRole(appUserId(directHolder), roleA1, tenantA);
    await fixtures.assignRole(appUserId(inactiveHolder), roleA1, tenantA);
    await fixtures.assignRole(appUserId(outsideTenantHolder), roleA1, tenantA);

    const holderGroup = await fixtures.createGroup({ tenantId: tenantA });
    await fixtures.assignRoleToGroup(holderGroup, roleA1);
    await fixtures.addGroupMember(holderGroup, appUserId(groupHolder));

    // Approver fixtures: one per union branch of GetUsersHoldingPermissionAsync
    // (EligibleAssigneeReader.cs:46-79) — direct, via role, via group-role, via group-permission.
    approverDirect = await auth.createTestUserWithSession({
      label: 'appr-direct', firstName: 'Aabir', lastName: 'Approverdirect',
    });
    approverViaRole = await auth.createTestUserWithSession({
      label: 'appr-role', firstName: 'Aabira', lastName: 'Approverrole',
    });
    approverViaGroupRole = await auth.createTestUserWithSession({
      label: 'appr-grouprole', firstName: 'Aabiro', lastName: 'Approvergrouprole',
    });
    approverViaGroupDirect = await auth.createTestUserWithSession({
      label: 'appr-groupperm', firstName: 'Aabiru', lastName: 'Approvergroupperm',
    });
    nonApprover = await auth.createTestUserWithSession({
      label: 'appr-none', firstName: 'Nils', lastName: 'Nonapprover',
    });

    for (const session of [
      approverDirect, approverViaRole, approverViaGroupRole, approverViaGroupDirect, nonApprover,
    ]) {
      await addMembership(appUserId(session), tenantA);
    }

    await fixtures.grantDirectPermission(appUserId(approverDirect), 'pricing.approve', tenantA);
    // A DIFFERENT pricing permission: proves the reader matches the exact code, not the prefix.
    await fixtures.grantDirectPermission(appUserId(nonApprover), 'pricing.request', tenantA);

    const approverRole = await fixtures.createRole({
      tenantId: tenantA, permissions: ['pricing.approve'],
    });
    await fixtures.assignRole(appUserId(approverViaRole), approverRole, tenantA);

    const approverGroupWithRole = await fixtures.createGroup({ tenantId: tenantA });
    await fixtures.assignRoleToGroup(approverGroupWithRole, approverRole);
    await fixtures.addGroupMember(approverGroupWithRole, appUserId(approverViaGroupRole));

    const approverGroupWithPermission = await fixtures.createGroup({
      tenantId: tenantA, permissions: ['pricing.approve'],
    });
    await fixtures.addGroupMember(approverGroupWithPermission, appUserId(approverViaGroupDirect));
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    await resetSlots().catch(() => undefined);
    await fixtures?.cleanup();

    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on (tests/helpers/auth.ts), and every delete here swallows its error, so the reverse order
    // is a silent no-op that leaks this suite's tenants and audit rows into the next run.
    for (const tenantId of createdTenants) {
      await query('delete from audit_log where tenant_id = $1', [tenantId]).catch(() => undefined);
      await query('delete from user_tenants where tenant_id = $1', [tenantId]).catch(
        () => undefined,
      );
      await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
    }

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
  }, 180_000);

  // -------------------------------------------------------------------------------------------
  // Contract: exactly two slots
  // -------------------------------------------------------------------------------------------

  it('declares exactly the two slots rm and underwriter', () => {
    // The domain fact this whole task rests on. A third value would need a matching migration
    // change to `ck_business_assignments_slot`.
    expect(ASSIGNMENT_SLOTS).toEqual(['rm', 'underwriter']);
  });

  it('returns both slots as null for a tenant that has configured none', async () => {
    await resetSlots();
    const slots = await readSlots(tenantA);

    // Unconfigured is a normal state — it is what every tenant looks like right after creation,
    // since provisioning seeds settings and reference data but NOT assignment slots. It is null,
    // not a 404.
    expect(slots).toEqual({ rmRole: null, underwritingRole: null });
  });

  it('returns exactly the reference DTO field set', async () => {
    await resetSlots();
    const slots = await readSlots(tenantA);
    expect(Object.keys(slots).sort()).toEqual(['rmRole', 'underwritingRole']);
  });

  it('projects the assignmentId, roleId and roleName of a configured slot', async () => {
    await resetSlots();
    const written = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });

    expect(written.rmRole).toEqual({
      assignmentId: expect.any(Number) as number,
      roleId: roleA1,
      roleName: expect.any(String) as string,
    });
    expect(written.underwritingRole?.roleId).toBe(roleA2);
    // `roleName` is the joined `roles.name`, which is what the Settings screen renders.
    const roleNames = await query<{ name: string }>('select name from roles where id = $1', [roleA1]);
    expect(written.rmRole?.roleName).toBe(roleNames[0]?.name);
  });

  // -------------------------------------------------------------------------------------------
  // Round trip and slot mechanics
  // -------------------------------------------------------------------------------------------

  it('persists both slots and reads them back', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });

    const read = await readSlots(tenantA);
    expect(read.rmRole?.roleId).toBe(roleA1);
    expect(read.underwritingRole?.roleId).toBe(roleA2);

    const stored = await storedSlots(tenantA);
    expect(stored.map((row) => row.slot)).toEqual(['rm', 'underwriter']);
  });

  it('stores at most one row per slot, so a repeated write cannot accumulate rows', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });
    await writeSlots(tenantA, { rmRoleId: roleA3, underwritingRoleId: roleA2 });

    // "One role per slot" as an outcome, not merely as a constraint declaration.
    expect(await storedSlots(tenantA)).toHaveLength(2);
    expect((await readSlots(tenantA)).rmRole?.roleId).toBe(roleA3);
  });

  it('KEEPS the slot row id when a slot changes role, so live assignees stay attached', async () => {
    await resetSlots();
    const first = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });
    const assignmentId = first.rmRole?.assignmentId;
    expect(assignmentId).toBeDefined();

    const second = await writeSlots(tenantA, { rmRoleId: roleA3, underwritingRoleId: null });

    // This is the reason the store updates in place rather than delete-and-reinsert: every
    // `lead_assignments.business_assignment_id` points at this id. A new id would silently detach
    // every assignee in the tenant — a change of role would become a mass unassignment.
    expect(second.rmRole?.assignmentId).toBe(assignmentId);
    expect(second.rmRole?.roleId).toBe(roleA3);
  });

  it('clears a slot when its role id is null', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });
    const cleared = await writeSlots(tenantA, { rmRoleId: null, underwritingRoleId: roleA2 });

    expect(cleared.rmRole).toBeNull();
    expect(cleared.underwritingRole?.roleId).toBe(roleA2);
    expect(await storedSlots(tenantA)).toHaveLength(1);
  });

  it('treats an OMITTED slot as a clear, matching the full-replace contract', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });
    const replaced = await writeSlots(tenantA, { rmRoleId: roleA1 });

    // C# binds an absent `long?` to null, so the reference behaved identically: this endpoint is a
    // full replace, not a patch. The in-use guard is what stops that from orphaning live assignees.
    expect(replaced.underwritingRole).toBeNull();
  });

  it('accepts a GLOBAL role for a slot', async () => {
    await resetSlots();
    // TenantConfinement.IsAccessible treats a null tenant_id as visible to every tenant: an
    // Internal-managed default role is meant to be usable, which `forTenant` would have hidden.
    const written = await writeSlots(tenantA, { rmRoleId: globalRole, underwritingRoleId: null });
    expect(written.rmRole?.roleId).toBe(globalRole);
  });

  // -------------------------------------------------------------------------------------------
  // Validation — status AND code AND message
  // -------------------------------------------------------------------------------------------

  it('rejects the same role in both slots with 422 and the reference message', async () => {
    await resetSlots();
    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: roleA1, underwritingRoleId: roleA1 },
      422,
    );

    // One role holding both slots would make the two eligible-user pickers return identical sets,
    // so "reassign to underwriting" would be indistinguishable from a no-op.
    expect(problem.code).toBe('BUSINESS_ASSIGNMENTS_VALIDATION_FAILED');
    expect(problem.detail).toContain('The RM role and the Underwriting role must be different roles.');

    // T-046. The pinned code is PascalCase (`PredicateValidator|...`), which the explicit-code
    // parser used to miss — silently substituting the DERIVED code and leaving the literal prefix
    // in the message. `detail` alone cannot catch that: `toContain` passes just as happily on
    // "PredicateValidator|The RM role...". Assert the field-error code exactly, and assert the
    // prefix is absent from the text a user actually reads.
    expect(problem.errors).toEqual([
      {
        field: 'underwritingRoleId',
        code: 'PredicateValidator',
        message: 'The RM role and the Underwriting role must be different roles.',
      },
    ]);
    expect(problem.detail).not.toContain('PredicateValidator|');

    expect(await storedSlots(tenantA)).toHaveLength(0);
  });

  it('rejects a third slot, offered as an extra key (AC-038)', async () => {
    await resetSlots();
    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: roleA1, underwritingRoleId: roleA2, approverRoleId: roleA3 },
      422,
    );

    expect(problem.code).toBe('BUSINESS_ASSIGNMENTS_VALIDATION_FAILED');
    // The write must not half-apply: the two legal slots are NOT stored just because they were
    // valid on their own.
    expect(await storedSlots(tenantA)).toHaveLength(0);
  });

  it('refuses a third slot at the database level too, not only at the API', async () => {
    // The API cannot express a third slot, so the schema check constraint is what makes the claim
    // true against anything that writes around the API. Asserted directly rather than assumed.
    await expect(
      query(
        `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
         values ($1, $2, 'approver', now(), now())`,
        [tenantA, roleA1],
      ),
    ).rejects.toThrow(/ck_business_assignments_slot/);
  });

  it('refuses a second role in one slot at the database level (AC-038)', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });

    // `uq_business_assignments_tenant_slot` is what makes "one role each" a database guarantee
    // rather than an application convention.
    //
    // The violated index is reported under its PARTITION-LOCAL name (`..._p{tenantId}_tenant_id_slot_key`),
    // not the parent's, because the row lands in the tenant's own partition — which incidentally
    // confirms the partition exists and the row is NOT sitting in the DEFAULT safety net. Matched
    // loosely on `tenant_id_slot` so the assertion survives the partition naming without becoming
    // a match-anything regex.
    await expect(
      query(
        `insert into business_assignments (tenant_id, role_id, slot, created_at, updated_at)
         values ($1, $2, 'rm', now(), now())`,
        [tenantA, roleA3],
      ),
    ).rejects.toThrow(/duplicate key value violates unique constraint "business_assignments_[a-z0-9_]*tenant_id_slot_key"/);
  });

  it('rejects a non-positive role id as a payload failure, before any role lookup', async () => {
    await resetSlots();
    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: 0, underwritingRoleId: null },
      422,
    );

    // A malformed id is a bad REQUEST (VALIDATION_FAILED), distinct from a well-formed id that
    // names no usable role (ROLE_INVALID). Asserting the code, not just the 422, is what keeps the
    // two apart — they are the same status.
    expect(problem.code).toBe('BUSINESS_ASSIGNMENTS_VALIDATION_FAILED');
    expect(problem.detail).toContain('A role id must be greater than 0.');
  });

  it('rejects an INACTIVE role with the ROLE_INVALID code', async () => {
    await resetSlots();
    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: inactiveRoleA, underwritingRoleId: null },
      422,
    );

    expect(problem.code).toBe('BUSINESS_ASSIGNMENTS_ROLE_INVALID');
    expect(problem.detail).toContain(
      `Role ${String(inactiveRoleA)} is not an active role visible to this tenant.`,
    );
  });

  it('rejects a non-existent role with the same message as an inactive one', async () => {
    await resetSlots();
    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: 999_999_999, underwritingRoleId: null },
      422,
    );
    expect(problem.code).toBe('BUSINESS_ASSIGNMENTS_ROLE_INVALID');
    expect(problem.detail).toContain('is not an active role visible to this tenant.');
  });

  it('answers 400, not 422, for a body that is not JSON at all', async () => {
    const response = await harness().request(`http://localhost${PATH}`, {
      method: 'PUT',
      headers: new Headers({
        authorization: `Bearer ${admin.accessToken}`,
        'x-tenant-id': String(tenantA),
        'content-type': 'application/json',
      }),
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('writes no audit row when validation fails', async () => {
    await resetSlots();
    await writeExpectingProblem(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA1 }, 422);

    const rows = await findAuditRows(query, {
      action: BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
      tenantId: tenantA,
    });
    expect(rows).toHaveLength(0);
  });

  // -------------------------------------------------------------------------------------------
  // The in-use guard (409)
  // -------------------------------------------------------------------------------------------

  it('refuses to clear a slot that a live LEAD assignee still points at', async () => {
    await resetSlots();
    const configured = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });
    const rmAssignmentId = configured.rmRole?.assignmentId ?? 0;
    await seedLeadAssignment(tenantA, rmAssignmentId, 5001);

    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: null, underwritingRoleId: roleA2 },
      409,
    );

    expect(problem.code).toBe('ASSIGNMENT_ROLE_IN_USE');
    expect(problem.detail).toContain('The RM role');
    expect(problem.detail).toContain(
      'cannot be cleared because at least one lead or quote currently has an assignee holding it.',
    );
    // No side effect: the slot survives, so the assignee is not orphaned.
    expect(await storedSlots(tenantA)).toHaveLength(2);
  });

  it('refuses to clear a slot that a live QUOTE assignee still points at', async () => {
    await resetSlots();
    const configured = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });
    const underwriterAssignmentId = configured.underwritingRole?.assignmentId ?? 0;
    await seedQuoteAssignment(tenantA, underwriterAssignmentId, 6001);

    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: roleA1, underwritingRoleId: null },
      409,
    );

    // The label wording is slot-specific in the reference: "Underwriting", not "underwriter".
    expect(problem.code).toBe('ASSIGNMENT_ROLE_IN_USE');
    expect(problem.detail).toContain('The Underwriting role');
    expect(await storedSlots(tenantA)).toHaveLength(2);
  });

  it('ALLOWS changing the role of a slot that has live assignees', async () => {
    await resetSlots();
    const configured = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });
    await seedLeadAssignment(tenantA, configured.rmRole?.assignmentId ?? 0, 5002);

    // Only CLEARING is guarded: a role change keeps the row and therefore keeps the assignee
    // attached, so refusing it would lock a tenant out of ever reorganising its roles.
    const changed = await writeSlots(tenantA, { rmRoleId: roleA3, underwritingRoleId: null });
    expect(changed.rmRole?.roleId).toBe(roleA3);
    expect(changed.rmRole?.assignmentId).toBe(configured.rmRole?.assignmentId);
  });

  it('does not let another tenant\'s assignee block a slot clear', async () => {
    await resetSlots();
    const inA = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });
    // A tenant-B assignee row carrying the SAME assignment id value. `business_assignments.id` is
    // unique only WITHIN a tenant (the PK is `(tenant_id, id)`), so an unscoped in-use lookup would
    // read this row and wrongly block tenant A — the sort of cross-tenant coupling that has no
    // database net beneath it here.
    await seedQuoteAssignment(tenantB, inA.rmRole?.assignmentId ?? 0, 6002);

    const cleared = await writeSlots(tenantA, { rmRoleId: null, underwritingRoleId: null });
    expect(cleared.rmRole).toBeNull();
  });

  // -------------------------------------------------------------------------------------------
  // Permission matrix
  // -------------------------------------------------------------------------------------------

  it('lets a plain tenant member READ the slots with no manage grant', async () => {
    // The 2026-07-13 fix (BusinessAssignmentEndpoints.cs:14-25): every tenant member composing an
    // Assign dialog needs the slot configuration to resolve the accountable-owner assignment id, so
    // gating the GET 403'd the Owner filter and Assign dialog for every leads user.
    const response = await call('GET', { token: plainMember.accessToken, tenantId: tenantA });
    expect(response.status).toBe(200);
  });

  it('refuses a plain tenant member the WRITE, even holding business_assignments.view', async () => {
    const response = await call('PUT', {
      token: plainMember.accessToken,
      tenantId: tenantA,
      body: { rmRoleId: roleA1, underwritingRoleId: null },
    });
    expect(response.status).toBe(403);
  });

  it('stores nothing after a forbidden write', async () => {
    await resetSlots();
    await call('PUT', {
      token: plainMember.accessToken,
      tenantId: tenantA,
      body: { rmRoleId: roleA1, underwritingRoleId: roleA2 },
    });
    expect(await storedSlots(tenantA)).toHaveLength(0);
  });

  it('refuses an unauthenticated request', async () => {
    expect((await call('GET', { tenantId: tenantA })).status).toBe(401);
  });

  it('refuses a request with no tenant header on this tenant-scoped route', async () => {
    // 403 with the uniform denial message, not 400 — see business-rules.test.ts for why the
    // tenancy middleware makes every denial reason indistinguishable.
    const response = await call('GET', { token: admin.accessToken });
    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation (AC-022, V-027) — the load-bearing assertions
  // -------------------------------------------------------------------------------------------

  it("rejects another tenant's role with ROLE_INVALID and stores nothing", async () => {
    await resetSlots();
    const problem = await writeExpectingProblem(
      tenantA,
      { rmRoleId: roleB, underwritingRoleId: null },
      422,
    );

    expect(problem.code).toBe('BUSINESS_ASSIGNMENTS_ROLE_INVALID');
    // The message is IDENTICAL to the one a nonexistent id gets, so this endpoint cannot be used to
    // probe which role ids exist in another tenant (spec §14, N-01).
    expect(problem.detail).toContain('is not an active role visible to this tenant.');
    expect(await storedSlots(tenantA)).toHaveLength(0);
  });

  it('does not show tenant B the slots tenant A configured', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });

    expect(await readSlots(tenantB)).toEqual({ rmRole: null, underwritingRole: null });
    expect(await storedSlots(tenantB)).toHaveLength(0);
  });

  it('does not let a tenant-A write disturb tenant B\'s stored slots', async () => {
    await resetSlots();
    await writeSlots(tenantB, { rmRoleId: roleB, underwritingRoleId: null });
    const tenantBBefore = await storedSlots(tenantB);

    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });

    // Asserted against the stored rows, not the response: tenant A's answer would look perfectly
    // correct even if the write had cleared tenant B's slots as collateral.
    expect(await storedSlots(tenantB)).toEqual(tenantBBefore);
  });

  it('scopes the listSlots reader by tenant', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });
    await writeSlots(tenantB, { rmRoleId: roleB, underwritingRoleId: null });

    // The seam the workflow tasks will consume, checked directly rather than only through HTTP.
    const inA = await listSlots(db, toTenantId(tenantA));
    const inB = await listSlots(db, toTenantId(tenantB));

    expect(inA.map((row) => row.roleId)).toEqual([roleA1]);
    expect(inB.map((row) => row.roleId)).toEqual([roleB]);
  });

  it('refuses a caller who is not a member of the tenant they name', async () => {
    const response = await call('GET', { token: plainMember.accessToken, tenantId: tenantB });
    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------------------------
  // Audit (AC-024, V-031)
  // -------------------------------------------------------------------------------------------

  it('writes exactly one audit row per slot change, with the real before and after', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });

    await query('delete from audit_log where action = $1 and tenant_id = $2', [
      BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
      tenantA,
    ]);

    const before = await readSlots(tenantA);
    const after = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });

    await assertAudited(query, {
      action: BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
      entityType: 'business_assignments',
      entityId: String(tenantA),
      actorUserId: appUserId(admin),
      tenantId: tenantA,
      before: { rmRole: { ...before.rmRole }, underwritingRole: null },
      after: {
        rmRole: { ...after.rmRole },
        underwritingRole: { ...after.underwritingRole },
      },
    });
  });

  it('audits a slot CLEAR with the cleared slot as null in the after half', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: roleA2 });
    await query('delete from audit_log where action = $1 and tenant_id = $2', [
      BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
      tenantA,
    ]);

    await writeSlots(tenantA, { rmRoleId: null, underwritingRoleId: roleA2 });

    const rows = await findAuditRows(query, {
      action: BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
      tenantId: tenantA,
    });
    const details = rows[0]?.details as { before: BusinessAssignmentsDto; after: BusinessAssignmentsDto };

    // A clear is the one change that removes authority — who may own a lead — so the audit row must
    // show what was removed, not just that something changed.
    expect(details.before.rmRole?.roleId).toBe(roleA1);
    expect(details.after.rmRole).toBeNull();
  });

  it('audits the tenant the change was made in', async () => {
    await resetSlots();
    await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });

    const rowsInB = await findAuditRows(query, {
      action: BUSINESS_ASSIGNMENTS_UPDATED_ACTION,
      tenantId: tenantB,
    });
    expect(rowsInB).toHaveLength(0);
  });
  // -------------------------------------------------------------------------------------------
  // GET /eligible-users and /eligible-approvers (scope amended into T-020 by the orchestrator)
  //
  // MEASURED PERMISSION: BusinessAssignmentEndpoints.cs:36-37 maps BOTH routes with NO
  // `.RequirePermission(...)` — unlike the PUT at :35. The endpoint header (:14-25) states the
  // rationale: these are PICKERS, and gating them 403'd the Assign dialog for every leads user on
  // 2026-07-13. So the gate is tenant MEMBERSHIP, and "membership only" is pinned from both
  // directions below: a member with no assignment grant gets 200, a non-member gets 403, and an
  // anonymous caller gets 401.
  //
  // MEASURED SHAPE: `EligibleAssigneeDto(UserId, FirstName, LastName, Email)`
  // (EligibleAssigneeDto.cs:6) returned as a BARE JSON ARRAY via `Results.Ok(result.Value)`
  // (:71,80) — there is no pagination envelope on these routes at all, so no `total`/`totalCount`
  // question arises. The SPA agrees (settingsApi.ts:166-171).
  // -------------------------------------------------------------------------------------------

  describe('eligible-users', () => {
    async function callEligibleUsers(
      options: { token?: string; tenantId?: number; assignmentId?: number | string; search?: string },
    ): Promise<Response> {
      const params = new URLSearchParams();
      if (options.assignmentId !== undefined) params.set('assignmentId', String(options.assignmentId));
      if (options.search !== undefined) params.set('search', options.search);

      const headers = new Headers();
      if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
      if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));

      return await harness().request(
        `http://localhost${PATH}/eligible-users?${params.toString()}`,
        { method: 'GET', headers },
      );
    }

    async function eligibleUserIds(
      assignmentId: number, search?: string, token = admin.accessToken,
    ): Promise<number[]> {
      const response = await callEligibleUsers({
        token, tenantId: tenantA, assignmentId, ...(search === undefined ? {} : { search }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as EligibleAssigneeDto[]).map((dto) => dto.userId);
    }

    /** Configures the rm slot with roleA1 so the pickers have an assignment row to resolve. */
    async function configureRmSlot(): Promise<number> {
      const written = await writeSlots(tenantA, { rmRoleId: roleA1, underwritingRoleId: null });
      rmAssignmentIdA = written.rmRole?.assignmentId ?? 0;
      expect(rmAssignmentIdA).toBeGreaterThan(0);
      return rmAssignmentIdA;
    }

    it('returns exactly the reference EligibleAssigneeDto field set', async () => {
      const assignmentId = await configureRmSlot();
      const response = await callEligibleUsers({
        token: admin.accessToken, tenantId: tenantA, assignmentId,
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as EligibleAssigneeDto[];
      // A BARE ARRAY, not an envelope: `Results.Ok(IReadOnlyList<EligibleAssigneeDto>)` (:71).
      expect(Array.isArray(body)).toBe(true);
      const first = body.find((dto) => dto.userId === appUserId(directHolder));
      expect(first).toBeDefined();
      expect(Object.keys(first as object).sort()).toEqual(
        ['email', 'firstName', 'lastName', 'userId'].sort(),
      );
    });

    it('includes users holding the slot role DIRECTLY', async () => {
      const assignmentId = await configureRmSlot();
      expect(await eligibleUserIds(assignmentId)).toContain(appUserId(directHolder));
    });

    it('includes users holding the slot role VIA AN ACTIVE GROUP', async () => {
      // EligibleAssigneeReader.cs:33-38 — group_members -> user_groups -> group_roles.
      const assignmentId = await configureRmSlot();
      expect(await eligibleUserIds(assignmentId)).toContain(appUserId(groupHolder));
    });

    it('excludes a tenant member who does not hold the slot role', async () => {
      const assignmentId = await configureRmSlot();
      expect(await eligibleUserIds(assignmentId)).not.toContain(appUserId(nonHolder));
    });

    it('excludes a DEACTIVATED user who holds the role', async () => {
      // `u.IsActive` (:96). A deactivated user offered in an Assign dialog would let work be
      // routed to someone who can no longer sign in.
      const assignmentId = await configureRmSlot();
      expect(await eligibleUserIds(assignmentId)).not.toContain(appUserId(inactiveHolder));
    });

    it('excludes a role holder who is NOT a member of this tenant (isolation)', async () => {
      // The user_tenants join (:89-98) is the whole reason this is not just "who holds the role".
      // Without it, a role holder from another tenant would appear in this tenant's Assign dialog
      // and could be made the accountable owner of its leads — an authorization leak, not merely a
      // disclosure one. There is no RLS beneath this predicate (spec Q-10).
      const assignmentId = await configureRmSlot();
      expect(await eligibleUserIds(assignmentId)).not.toContain(appUserId(outsideTenantHolder));
    });

    it('filters by first name, last name or email, case-insensitively', async () => {
      // `EF.Functions.ILike` over the three columns (:104-107).
      const assignmentId = await configureRmSlot();

      expect(await eligibleUserIds(assignmentId, 'dinah')).toContain(appUserId(directHolder));
      expect(await eligibleUserIds(assignmentId, 'DIRECT')).toContain(appUserId(directHolder));
      expect(await eligibleUserIds(assignmentId, 'Groupmember')).toContain(appUserId(groupHolder));
      // A search matching one holder must exclude the other, or the filter is not filtering.
      expect(await eligibleUserIds(assignmentId, 'Dinah')).not.toContain(appUserId(groupHolder));
      expect(await eligibleUserIds(assignmentId, directHolder.email)).toContain(
        appUserId(directHolder),
      );
    });

    it('treats a blank search as no filter, matching IsNullOrWhiteSpace', async () => {
      // `if (!string.IsNullOrWhiteSpace(search))` (:101) — a whitespace-only search must not
      // become a `%   %` pattern that matches nothing and empties the dropdown.
      const assignmentId = await configureRmSlot();
      const unfiltered = await eligibleUserIds(assignmentId);
      expect(await eligibleUserIds(assignmentId, '   ')).toEqual(unfiltered);
      expect(await eligibleUserIds(assignmentId, '')).toEqual(unfiltered);
    });

    it('trims the search term before matching', async () => {
      // `search.Trim()` inside the pattern (:103).
      const assignmentId = await configureRmSlot();
      expect(await eligibleUserIds(assignmentId, '  Dinah  ')).toContain(appUserId(directHolder));
    });

    it('orders by first name then last name', async () => {
      const assignmentId = await configureRmSlot();
      const response = await callEligibleUsers({
        token: admin.accessToken, tenantId: tenantA, assignmentId,
      });
      const body = (await response.json()) as EligibleAssigneeDto[];
      const keys = body.map((dto) => `${dto.firstName} ${dto.lastName}`);
      expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right)));
    });

    it('returns each eligible user ONCE even when several grant paths apply', async () => {
      // The reference unions direct and via-group candidate ids and then `Distinct()`s (:40,:112).
      // A user holding the role both ways must not appear twice in a picker.
      const assignmentId = await configureRmSlot();
      const bothPathsGroup = await fixtures.createGroup({ tenantId: tenantA });
      await fixtures.assignRoleToGroup(bothPathsGroup, roleA1);
      await fixtures.addGroupMember(bothPathsGroup, appUserId(directHolder));

      const ids = await eligibleUserIds(assignmentId);
      expect(ids.filter((id) => id === appUserId(directHolder))).toHaveLength(1);
    });

    it('answers 404 BUSINESS_ASSIGNMENTS_NOT_FOUND for an unknown assignment id', async () => {
      // GetEligibleAssigneesQueryHandler.cs:28-32 — and this is the code the mapper's 404 branch
      // (:85) exists for. NOTE: T-020's first pass recorded this code as "dead in the reference"
      // on the strength of the config handlers alone; measuring THIS handler proved that wrong.
      await configureRmSlot();
      const response = await callEligibleUsers({
        token: admin.accessToken, tenantId: tenantA, assignmentId: 999_999_999,
      });

      expect(response.status).toBe(404);
      const problem = (await response.json()) as ProblemBody;
      expect(problem.code).toBe('BUSINESS_ASSIGNMENTS_NOT_FOUND');
      expect(problem.detail).toContain('Business assignment 999999999 was not found.');
    });

    it("answers 404 for ANOTHER TENANT's assignment id, not that tenant's users", async () => {
      // The handler resolves the assignment from `_store.ListAsync()`, which is tenant-scoped
      // (:26-27), so another tenant's slot id is indistinguishable from a nonexistent one. If this
      // regressed, tenant A could enumerate tenant B's members by guessing slot ids — the single
      // most damaging failure available on this endpoint.
      await configureRmSlot();
      const inB = await writeSlots(tenantB, { rmRoleId: roleB, underwritingRoleId: null });
      const tenantBAssignmentId = inB.rmRole?.assignmentId ?? 0;

      const response = await callEligibleUsers({
        token: admin.accessToken, tenantId: tenantA, assignmentId: tenantBAssignmentId,
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as ProblemBody).code).toBe('BUSINESS_ASSIGNMENTS_NOT_FOUND');
    });

    it('answers 400 when assignmentId is missing or not a number', async () => {
      // `long assignmentId` is a REQUIRED minimal-API query binding: a missing or unparseable
      // value fails model binding with a 400 before the handler runs.
      await configureRmSlot();
      expect(
        (await callEligibleUsers({ token: admin.accessToken, tenantId: tenantA })).status,
      ).toBe(400);
      expect(
        (await callEligibleUsers({
          token: admin.accessToken, tenantId: tenantA, assignmentId: 'abc',
        })).status,
      ).toBe(400);
    });

    it('is MEMBERSHIP-ONLY: a member with no business-assignments grant gets 200', async () => {
      // The allowed direction of the permission pin. `nonHolder` holds no grant at all in tenant A.
      const assignmentId = await configureRmSlot();
      const response = await callEligibleUsers({
        token: nonHolder.accessToken, tenantId: tenantA, assignmentId,
      });
      expect(response.status).toBe(200);
    });

    it('is MEMBERSHIP-ONLY: a NON-member is refused 403', async () => {
      // The refused direction. plainMember belongs to tenant A only, so naming tenant B must not
      // reach the handler — and must not reveal whether that tenant or slot exists.
      const inB = await writeSlots(tenantB, { rmRoleId: roleB, underwritingRoleId: null });
      const response = await callEligibleUsers({
        token: plainMember.accessToken,
        tenantId: tenantB,
        assignmentId: inB.rmRole?.assignmentId ?? 0,
      });
      expect(response.status).toBe(403);
    });

    it('refuses an unauthenticated caller', async () => {
      const assignmentId = await configureRmSlot();
      expect((await callEligibleUsers({ tenantId: tenantA, assignmentId })).status).toBe(401);
    });

    it('refuses a request with no tenant header', async () => {
      const assignmentId = await configureRmSlot();
      expect((await callEligibleUsers({ token: admin.accessToken, assignmentId })).status).toBe(403);
    });
  });

  describe('eligible-approvers', () => {
    async function callEligibleApprovers(
      options: { token?: string; tenantId?: number; search?: string },
    ): Promise<Response> {
      const params = new URLSearchParams();
      if (options.search !== undefined) params.set('search', options.search);

      const headers = new Headers();
      if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
      if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));

      const qs = params.toString();
      return await harness().request(
        `http://localhost${PATH}/eligible-approvers${qs ? `?${qs}` : ''}`,
        { method: 'GET', headers },
      );
    }

    async function approverIds(search?: string, tenantId = tenantA): Promise<number[]> {
      const response = await callEligibleApprovers({
        token: admin.accessToken, tenantId, ...(search === undefined ? {} : { search }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as EligibleAssigneeDto[]).map((dto) => dto.userId);
    }

    it('returns the same EligibleAssigneeDto shape as eligible-users', async () => {
      const response = await callEligibleApprovers({
        token: admin.accessToken, tenantId: tenantA,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as EligibleAssigneeDto[];
      const first = body.find((dto) => dto.userId === appUserId(approverDirect));
      expect(first).toBeDefined();
      expect(Object.keys(first as object).sort()).toEqual(
        ['email', 'firstName', 'lastName', 'userId'].sort(),
      );
    });

    it.each([
      ['a DIRECT user_permissions grant', () => appUserId(approverDirect)],
      ['a ROLE carrying the permission', () => appUserId(approverViaRole)],
      ['a GROUP whose ROLE carries the permission', () => appUserId(approverViaGroupRole)],
      ['a GROUP carrying the permission DIRECTLY', () => appUserId(approverViaGroupDirect)],
    ])('includes a user holding pricing.approve via %s', async (_label, userId) => {
      // All four union branches of GetUsersHoldingPermissionAsync (EligibleAssigneeReader.cs:46-79).
      // Each is asserted separately: a reader that dropped one branch would still look correct on
      // a fixture that happened to hold the permission two ways.
      expect(await approverIds()).toContain(userId());
    });

    it('excludes a user holding a DIFFERENT pricing permission', async () => {
      // `pricing.request` is not `pricing.approve` — the match is on the exact code, not a prefix.
      expect(await approverIds()).not.toContain(appUserId(nonApprover));
    });

    it('is picked by PERMISSION, not by a configured slot role', async () => {
      // GetEligibleApproversQuery.cs:9-11 is explicit: approvers are resolved by permission because
      // pricing approval is not itself an assignable slot role. So the approver list must NOT
      // depend on the slot configuration at all.
      await writeSlots(tenantA, { rmRoleId: null, underwritingRoleId: null });
      expect(await approverIds()).toContain(appUserId(approverDirect));
    });

    it('excludes a deactivated user and a non-member', async () => {
      const ids = await approverIds();
      expect(ids).not.toContain(appUserId(inactiveHolder));
      expect(ids).not.toContain(appUserId(outsideTenantHolder));
    });

    it('does not leak approvers across tenants', async () => {
      // Tenant B has no pricing.approve grants at all; the tenant-A approvers must not appear there.
      const idsInB = await approverIds(undefined, tenantB);
      expect(idsInB).not.toContain(appUserId(approverDirect));
      expect(idsInB).not.toContain(appUserId(approverViaGroupRole));
    });

    it('filters by search across name and email', async () => {
      expect(await approverIds('Approverdirect')).toContain(appUserId(approverDirect));
      expect(await approverIds('Approverdirect')).not.toContain(appUserId(approverViaRole));
    });

    it('returns each approver ONCE when several grant paths apply', async () => {
      // approverDirect gets a second, independent path to the same permission.
      const extraGroup = await fixtures.createGroup({
        tenantId: tenantA, permissions: ['pricing.approve'],
      });
      await fixtures.addGroupMember(extraGroup, appUserId(approverDirect));

      const ids = await approverIds();
      expect(ids.filter((id) => id === appUserId(approverDirect))).toHaveLength(1);
    });

    it('is MEMBERSHIP-ONLY: a member with no grant gets 200, a non-member is refused 403', async () => {
      // Both directions of the permission pin, per the measured absence of RequirePermission at :37.
      expect(
        (await callEligibleApprovers({ token: nonHolder.accessToken, tenantId: tenantA })).status,
      ).toBe(200);
      expect(
        (await callEligibleApprovers({ token: plainMember.accessToken, tenantId: tenantB })).status,
      ).toBe(403);
    });

    it('refuses an unauthenticated caller and a request with no tenant header', async () => {
      expect((await callEligibleApprovers({ tenantId: tenantA })).status).toBe(401);
      expect((await callEligibleApprovers({ token: admin.accessToken })).status).toBe(403);
    });
  });
});
