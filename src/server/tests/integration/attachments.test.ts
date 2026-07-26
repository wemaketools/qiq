/**
 * Quote attachments end to end over the A-7 signed-URL envelope, against REAL local Supabase
 * Storage (T-027; AC-021, AC-022, AC-024, AC-056, AC-057, AC-058; V-026, V-027, V-031, V-071..V-074).
 *
 * Same composed-system harness as `quote-workflow.test.ts`: real sessions, real tenants and
 * partitions, real grants, the real Hono pipeline via `app.request`, and — the part that matters
 * here — the real `SupabaseStorageAdapter` against the real Storage container. Nothing about the
 * bucket, the signatures or the expiry is stubbed, because every one of those is the thing under
 * test. The same suite additionally runs the shared `StorageAdapter` conformance contract, so the
 * fake used by unit tests and the adapter used in production are held to one standard (AC-058).
 *
 * BYTES MUST NEVER TRAVERSE THE API FUNCTION (V-071)
 * =================================================
 * Every transfer in this suite goes `fetch(signedUrl)` — straight to Storage, never through
 * `app.request`. The 10 MB case would be impossible otherwise, which is precisely the point: it is
 * the test that would fail if someone "simplified" the design back to streaming through the
 * function and under Vercel's ~4.5 MB body cap.
 *
 * EVERY REJECTION ASSERTS ITS CODE, NOT MERELY ITS STATUS
 * ======================================================
 * Five distinct failures on this surface answer 422 (disallowed type, extension mismatch, size cap,
 * signature mismatch, missing object) and two answer 403. Status alone cannot tell a renamed
 * executable from an oversize file, so every negative names the `code` it expects.
 *
 * REJECTIONS ARE ASSERTED AS ABSENCES TOO
 * =======================================
 * A 422 alone would also be returned by an implementation that signed a URL, wrote a row and then
 * failed. So the pre-signing negatives assert that NO row was created, and the confirm negatives
 * assert that the object is gone from the bucket AND the pending row is gone from the table.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGrantGraphLoader } from '../../domains/rbac/index.js';
import { ALLOWED_ATTACHMENT_CONTENT_TYPES } from '../../domains/quotes/attachment-content.js';
import { createAccessTokenVerifier, createPgAppUserLookup } from '../../lib/auth/index.js';
import type { PgAppUserLookup } from '../../lib/auth/user-lookup.js';
import { loadConfig, type AppConfig } from '../../lib/config/index.js';
import { poolerPoolConfig, type Database } from '../../lib/db/index.js';
import { buildApp, type ApiApp } from '../../lib/router/app.js';
import { createStorageAdapter, type StorageAdapter } from '../../lib/storage/index.js';
import { createTenantAccessValidator } from '../../lib/tenancy/index.js';
import { TestAuthFixtures, type TestUserSession } from '../helpers/auth.js';
import {
  itObeysTheStorageAdapterContract,
  type StorageContractContext,
} from '../helpers/storage-contract.js';
import { assertAudited, findAuditRows } from './helpers/audit-assert.js';
import { probeLocalStack, suiteTitle, type LocalStack } from './helpers/local-stack.js';
import { RbacFixtures } from './helpers/rbac-fixtures.js';

const probe = await probeLocalStack();
const describeStack = probe.available ? describe : describe.skip;
const title = suiteTitle('attachments', probe);

const LEADS = '/api/v1/leads';
const QUOTES = '/api/v1/quotes';
const ATTACHMENTS = '/api/v1/attachments';
const BUCKET = 'quote-attachments';

const PDF = 'application/pdf';

/** Leading bytes of a genuine file of each type; the rest of the body is irrelevant padding. */
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pdfBytes(totalLength = 32): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  bytes.set(PDF_MAGIC.slice(0, Math.min(PDF_MAGIC.length, totalLength)));
  return bytes;
}

function pngBytes(totalLength = 32): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  bytes.set(PNG_MAGIC.slice(0, Math.min(PNG_MAGIC.length, totalLength)));
  return bytes;
}

interface AttachmentDto {
  readonly id: number;
  readonly quoteId: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
  readonly uploadedBy: number | null;
}

interface UploadEnvelope {
  readonly attachmentId: number;
  readonly quoteId: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly uploadUrl: string;
  readonly uploadToken: string;
  readonly expiresInSeconds: number;
}

interface DownloadEnvelope {
  readonly attachmentId: number;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
  readonly expiresInSeconds: number;
}

interface ProblemBody {
  readonly status?: number;
  readonly detail?: string;
  readonly code?: string;
  readonly errors?: readonly { field: string; code: string; message: string }[];
}

/** Deliberately SHORT — a long shared token dominates trigram similarity on party names. */
const RUN = `t027-${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
let nameSequence = 0;
function uniqueName(prefix: string): string {
  nameSequence += 1;
  return `${prefix} ${RUN}-${String(nameSequence)}`;
}

function yesterday(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

describeStack(title, () => {
  let stack: LocalStack;
  let config: AppConfig;
  let auth: TestAuthFixtures;
  let fixtures: RbacFixtures;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let pgLookup: PgAppUserLookup;
  let storage: StorageAdapter;

  /** Holds every lead + quote grant in BOTH tenants, including `quotes.correct_closed`. */
  let admin: TestUserSession;
  /** Holds view/update in tenant A but NOT `quotes.correct_closed`. */
  let editor: TestUserSession;
  /** Holds `quotes.view` only — proves the update-gated routes 403 for a read-only caller. */
  let viewer: TestUserSession;

  let tenantA = 0;
  let tenantB = 0;

  const createdTenants: number[] = [];
  /** EVERY object this suite creates, so the shared bucket is left exactly as it was found. */
  const createdObjectKeys = new Set<string>();

  const OWNED_TABLES = [
    'quote_attachments',
    'quote_status_history',
    'quote_assignments',
    'quote_versions',
    'quotes',
    'lead_status_history',
    'lead_notes',
    'lead_assignments',
    'leads',
    'reference_sequences',
    'business_assignments',
    'parties',
    'reference_items',
    'tenant_settings',
    'audit_log',
    'user_tenants',
  ] as const;

  function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return auth.query<T>(sql, params);
  }

  async function deleteTenantData(tenantId: number): Promise<void> {
    for (const table of OWNED_TABLES) {
      await query(`delete from ${table} where tenant_id = $1`, [tenantId]).catch(() => undefined);
    }
    await query('delete from tenants where id = $1', [tenantId]).catch(() => undefined);
  }

  async function purgeStaleRunsOfThisSuite(): Promise<void> {
    const stale = await query<{ id: string }>(
      "select id::text as id from tenants where name like 't027-%'",
    ).catch(() => []);
    for (const row of stale) await deleteTenantData(Number(row.id));
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

  async function seedSettings(tenantId: number, maxAttachmentMb = 10): Promise<void> {
    await query(
      `insert into tenant_settings
         (tenant_id, currency_code, currency_symbol, max_attachment_mb, high_value_threshold,
          quote_expiry_alert_days, follow_up_overdue_grace_days, aging_amber_days, aging_red_days,
          unassigned_lead_hours, stalled_lead_days, stalled_quote_days, duplicate_check_days,
          lead_ref_format, quote_ref_format, lead_inactivity_expiry_days, pricing_approval_target_days,
          sla_assignment_days, sla_underwriting_days, sla_received_to_sent_days,
          require_pricing_approval_for_high_value, manual_external_ref_enabled,
          expire_lead_when_last_quote_expires, created_at, updated_at)
       values ($1, 'USD', '$', $2, 100000, 7, 2, 5, 10, 24, 7, 7, 30, 'L-{YYYY}-{SEQ:4}',
               'Q-{YYYY}-{SEQ:4}', 60, 3, 2, 3, 5, false, true, false, now(), now())`,
      [tenantId, maxAttachmentMb],
    );
  }

  async function setSizeCap(tenantId: number, maxAttachmentMb: number): Promise<void> {
    await query('update tenant_settings set max_attachment_mb = $2 where tenant_id = $1', [
      tenantId,
      maxAttachmentMb,
    ]);
  }

  async function addMembership(userId: number, tenantId: number): Promise<void> {
    await query('insert into user_tenants (tenant_id, user_id, created_at) values ($1, $2, now())', [
      tenantId,
      userId,
    ]);
  }

  async function seedRef(
    tenantId: number,
    listType: string,
    name: string,
    options: {
      reportingCategory?: string | null;
      canonicalKey?: string | null;
      productLineId?: number | null;
      isTerminal?: boolean;
    } = {},
  ): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into reference_items
         (tenant_id, list_type, name, display_order, is_active, reporting_category, canonical_key,
          product_line_id, is_terminal, created_at, updated_at)
       values ($1, $2, $3, 0, true, $4, $5, $6, $7, now(), now())
       returning id::text as id`,
      [
        tenantId,
        listType,
        name,
        options.reportingCategory ?? null,
        options.canonicalKey ?? null,
        options.productLineId ?? null,
        options.isTerminal ?? false,
      ],
    );
    return Number(rows[0]?.id);
  }

  /** Lead creation requires a configured `rm` business-assignment slot to resolve the owner. */
  async function seedRmSlot(tenantId: number, roleId: number): Promise<void> {
    await query(
      `insert into business_assignments (tenant_id, slot, role_id, created_at, updated_at)
       values ($1, 'rm', $2, now(), now())`,
      [tenantId, roleId],
    );
  }

  async function seedParty(tenantId: number, name: string, partyTypeId: number): Promise<number> {
    const rows = await query<{ id: string }>(
      `insert into parties (tenant_id, name, party_type_id, is_strategic, created_at, updated_at)
       values ($1, $2, $3, false, now(), now()) returning id::text as id`,
      [tenantId, name, partyTypeId],
    );
    return Number(rows[0]?.id);
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
      leads: { db },
      quotes: { db },
      attachments: { db, storage },
    });
  }

  async function call(
    method: string,
    path: string,
    options: { token?: string; tenantId?: number; body?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers();
    if (options.token !== undefined) headers.set('authorization', `Bearer ${options.token}`);
    if (options.tenantId !== undefined) headers.set('x-tenant-id', String(options.tenantId));
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return await harness().request(`http://localhost${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  // Reference fixtures.
  let partyTypeA = 0;
  let regionA = 0;
  let channelA = 0;
  let productLineA = 0;
  let coverTypeA = 0;
  let partyA = 0;
  let terminalQuoteStatusA = 0;

  let partyTypeB = 0;
  let regionB = 0;
  let channelB = 0;
  let productLineB = 0;
  let coverTypeB = 0;
  let partyB = 0;

  function leadBody(tenant: 'A' | 'B'): Record<string, unknown> {
    const a = tenant === 'A';
    return {
      partyId: a ? partyA : partyB,
      isExistingClient: true,
      dateReceived: yesterday(),
      requestChannelId: a ? channelA : channelB,
      brokerId: null,
      ownerUserId: appUserId(admin),
      regionId: a ? regionA : regionB,
      externalRef: null,
      productLineId: a ? productLineA : productLineB,
      coverTypeId: a ? coverTypeA : coverTypeB,
      sumInsured: null,
      estimatedPremium: null,
      policyTerm: 'm12',
      policyTermOther: null,
      priority: null,
      intakeNotes: null,
      createAnyway: true,
    };
  }

  async function createQuoteIn(tenant: 'A' | 'B'): Promise<number> {
    const tenantId = tenant === 'A' ? tenantA : tenantB;
    const leadResponse = await call('POST', LEADS, {
      token: admin.accessToken,
      tenantId,
      body: leadBody(tenant),
    });
    expect(
      leadResponse.status,
      `lead creation should have succeeded: ${await leadResponse.clone().text()}`,
    ).toBe(201);
    const leadId = ((await leadResponse.json()) as { lead: { id: number } | null }).lead?.id ?? 0;

    const quoteResponse = await call('POST', `${LEADS}/${leadId}/quotes`, {
      token: admin.accessToken,
      tenantId,
      body: { quotedPremium: 5000 },
    });
    expect(quoteResponse.status, 'quote creation should have succeeded').toBe(201);
    return ((await quoteResponse.json()) as { id: number }).id;
  }

  // -------------------------------------------------------------------------------------------
  // Envelope helpers. Note `transfer` NEVER touches `app.request` — that is the V-071 property.
  // -------------------------------------------------------------------------------------------

  async function requestUpload(
    quoteId: number,
    body: Record<string, unknown>,
    options: { session?: TestUserSession; tenantId?: number } = {},
  ): Promise<Response> {
    return await call('POST', `${QUOTES}/${quoteId}/attachments`, {
      token: (options.session ?? admin).accessToken,
      tenantId: options.tenantId ?? tenantA,
      body,
    });
  }

  async function requestUploadOk(
    quoteId: number,
    body: Record<string, unknown>,
  ): Promise<UploadEnvelope> {
    const response = await requestUpload(quoteId, body);
    expect(response.status, 'upload request should have been accepted').toBe(202);
    const envelope = (await response.json()) as UploadEnvelope;
    createdObjectKeys.add(await storageKeyOf(envelope.attachmentId));
    return envelope;
  }

  /** Transfers bytes DIRECTLY to Storage, exactly as a browser would. Never through the API. */
  async function transfer(
    envelope: UploadEnvelope,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<Response> {
    return await fetch(envelope.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: bytes,
    });
  }

  async function confirm(
    attachmentId: number,
    options: { session?: TestUserSession; tenantId?: number } = {},
  ): Promise<Response> {
    return await call('POST', `${ATTACHMENTS}/${attachmentId}/confirm`, {
      token: (options.session ?? admin).accessToken,
      tenantId: options.tenantId ?? tenantA,
    });
  }

  /** The whole happy path: request -> transfer -> confirm. */
  async function attachFile(
    quoteId: number,
    options: {
      fileName?: string;
      contentType?: string;
      bytes?: Uint8Array;
      declaredSizeBytes?: number;
    } = {},
  ): Promise<AttachmentDto> {
    const contentType = options.contentType ?? PDF;
    const bytes = options.bytes ?? pdfBytes();
    const envelope = await requestUploadOk(quoteId, {
      fileName: options.fileName ?? 'report.pdf',
      contentType,
      declaredSizeBytes: options.declaredSizeBytes ?? bytes.length,
    });

    const transferred = await transfer(envelope, bytes, contentType);
    expect(transferred.ok, 'direct transfer to the signed URL should have succeeded').toBe(true);

    const confirmed = await confirm(envelope.attachmentId);
    expect(confirmed.status, 'confirm should have succeeded').toBe(201);
    return (await confirmed.json()) as AttachmentDto;
  }

  async function storageKeyOf(attachmentId: number): Promise<string> {
    const rows = await query<{ storage_key: string }>(
      'select storage_key from quote_attachments where id = $1',
      [attachmentId],
    );
    return rows[0]?.storage_key ?? '';
  }

  async function readAttachmentRow(id: number): Promise<Record<string, unknown> | undefined> {
    const rows = await query<Record<string, unknown>>(
      `select id::text as id, quote_id::text as quote_id, tenant_id::text as tenant_id, file_name,
              content_type, size_bytes::text as size_bytes, storage_key,
              confirmed_at, removed_at, removed_by::text as removed_by
         from quote_attachments where id = $1`,
      [id],
    );
    return rows[0];
  }

  async function listAttachments(
    quoteId: number,
    options: { session?: TestUserSession; tenantId?: number } = {},
  ): Promise<Response> {
    return await call('GET', `${QUOTES}/${quoteId}/attachments`, {
      token: (options.session ?? admin).accessToken,
      tenantId: options.tenantId ?? tenantA,
    });
  }

  async function problemOf(response: Response): Promise<ProblemBody> {
    return (await response.json()) as ProblemBody;
  }

  /** Storage REST base, for the direct-bucket-access negatives. */
  function storageUrl(path: string): string {
    return `${stack.apiUrl.replace(/\/$/, '')}/storage/v1${path}`;
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

    // THE DEFAULT BINDING, selected by configuration exactly as production selects it — no test
    // override. `STORAGE_ADAPTER` is unset above, so this exercises the documented default (A-6).
    storage = createStorageAdapter(config);
    expect(storage.name, 'the default configured adapter must be Supabase Storage').toBe('supabase');

    auth = new TestAuthFixtures(stack);
    fixtures = new RbacFixtures((sql, params) => auth.query(sql, params ?? []));

    pool = new pg.Pool(poolerPoolConfig(stack.dbUrl));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    pgLookup = createPgAppUserLookup(config);

    await purgeStaleRunsOfThisSuite();

    tenantA = await createTenant('tenant-a');
    tenantB = await createTenant('tenant-b');
    await seedSettings(tenantA);
    await seedSettings(tenantB);

    admin = await auth.createTestUserWithSession({ label: 'a-admin' });
    editor = await auth.createTestUserWithSession({ label: 'a-editor' });
    viewer = await auth.createTestUserWithSession({ label: 'a-viewer' });

    for (const session of [admin, editor, viewer]) {
      await addMembership(appUserId(session), tenantA);
    }
    await addMembership(appUserId(admin), tenantB);

    const GRANTS = [
      'leads.view',
      'leads.view_all',
      'leads.create',
      'leads.update',
      'quotes.create',
      'quotes.view',
      'quotes.view_all',
      'quotes.update',
      'quotes.correct_closed',
    ] as const;

    for (const permission of GRANTS) {
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantA);
      await fixtures.grantDirectPermission(appUserId(admin), permission, tenantB);
    }

    // The editor holds everything EXCEPT `quotes.correct_closed` — the closed-quote discriminator.
    for (const permission of GRANTS.filter((p) => p !== 'quotes.correct_closed')) {
      await fixtures.grantDirectPermission(appUserId(editor), permission, tenantA);
    }

    // The viewer can read but not update — the discriminator for the update-gated routes.
    await fixtures.grantDirectPermission(appUserId(viewer), 'quotes.view', tenantA);
    await fixtures.grantDirectPermission(appUserId(viewer), 'leads.view', tenantA);

    const rmRoleA = await fixtures.createRole({ tenantId: tenantA });
    await fixtures.assignRole(appUserId(admin), rmRoleA, tenantA);
    await fixtures.assignRole(appUserId(editor), rmRoleA, tenantA);
    await seedRmSlot(tenantA, rmRoleA);

    const rmRoleB = await fixtures.createRole({ tenantId: tenantB });
    await fixtures.assignRole(appUserId(admin), rmRoleB, tenantB);
    await seedRmSlot(tenantB, rmRoleB);

    partyTypeA = await seedRef(tenantA, 'party_type', uniqueName('Corp A'));
    regionA = await seedRef(tenantA, 'region', uniqueName('North A'));
    channelA = await seedRef(tenantA, 'request_channel', uniqueName('Email A'));
    productLineA = await seedRef(tenantA, 'product_line', uniqueName('Motor A'));
    coverTypeA = await seedRef(tenantA, 'cover_type', uniqueName('Comp A'), {
      productLineId: productLineA,
    });

    for (const [key, category] of [
      ['new', 'open'],
      ['pricing', 'open'],
      ['quote_sent', 'quoted'],
    ] as const) {
      await seedRef(tenantA, 'lead_status', uniqueName(`${key} A`), {
        reportingCategory: category,
        canonicalKey: key,
      });
    }
    await seedRef(tenantA, 'quote_status', uniqueName('q-draft A'), {
      reportingCategory: 'open',
      canonicalKey: 'draft',
    });
    terminalQuoteStatusA = await seedRef(tenantA, 'quote_status', uniqueName('q-won A'), {
      reportingCategory: 'won',
      canonicalKey: 'won',
      isTerminal: true,
    });

    partyA = await seedParty(tenantA, `Acme ${RUN}`, partyTypeA);

    // Tenant B: the isolation fixture set.
    partyTypeB = await seedRef(tenantB, 'party_type', uniqueName('Corp B'));
    regionB = await seedRef(tenantB, 'region', uniqueName('North B'));
    channelB = await seedRef(tenantB, 'request_channel', uniqueName('Email B'));
    productLineB = await seedRef(tenantB, 'product_line', uniqueName('Motor B'));
    coverTypeB = await seedRef(tenantB, 'cover_type', uniqueName('Comp B'), {
      productLineId: productLineB,
    });
    for (const [key, category] of [
      ['new', 'open'],
      ['quote_sent', 'quoted'],
    ] as const) {
      await seedRef(tenantB, 'lead_status', uniqueName(`${key} B`), {
        reportingCategory: category,
        canonicalKey: key,
      });
    }
    await seedRef(tenantB, 'quote_status', uniqueName('q-draft B'), {
      reportingCategory: 'open',
      canonicalKey: 'draft',
    });
    partyB = await seedParty(tenantB, `Beta ${RUN}`, partyTypeB);
  }, 180_000);

  afterAll(async () => {
    if (!probe.available) return;

    // STORAGE RESIDUE FIRST, and through the adapter, so a failed assertion mid-suite cannot leave
    // objects in the shared bucket. Registered keys include ones whose upload never happened;
    // deleting an absent key is a documented no-op.
    for (const key of createdObjectKeys) {
      await storage?.delete(key).catch(() => undefined);
    }

    await fixtures?.cleanup();
    // Tenant deletion MUST precede `auth.cleanup()`: that call ends the pg pool these deletes run
    // on, and the deletes swallow errors — the reverse order is a SILENT no-op.
    for (const tenantId of createdTenants) await deleteTenantData(tenantId);

    await auth?.cleanup();
    await pgLookup?.close();
    await db?.destroy();
    await pool?.end().catch(() => undefined);
  }, 120_000);

  // -------------------------------------------------------------------------------------------
  // The port contract, against the REAL adapter (AC-058, V-074).
  // -------------------------------------------------------------------------------------------

  describe('SupabaseStorageAdapter obeys the shared StorageAdapter contract (AC-058, V-074)', () => {
    let sequence = 0;

    itObeysTheStorageAdapterContract(
      (): StorageContractContext => ({
        adapter: storage,
        putBytes: async (key, bytes, contentType) => {
          const target = await storage.createSignedUploadUrl(key, { contentType });
          const response = await fetch(target.url, {
            method: 'PUT',
            headers: { 'content-type': contentType },
            body: bytes,
          });
          if (!response.ok) throw new Error(`upload failed: ${String(response.status)}`);
        },
        track: (key) => createdObjectKeys.add(key),
        uniqueKey: (suffix) => {
          sequence += 1;
          return `t${String(tenantA)}/quotes/0/${String(sequence)}_${suffix}`;
        },
      }),
    );
  });

  // -------------------------------------------------------------------------------------------
  // The happy path (AC-056, AC-057, V-071, V-073).
  // -------------------------------------------------------------------------------------------

  describe('the signed-URL envelope, end to end (AC-056, V-071)', () => {
    it('requests, transfers directly to Storage, and confirms — recording server-observed metadata', async () => {
      const quoteId = await createQuoteIn('A');
      const bytes = pdfBytes(64);

      const envelope = await requestUploadOk(quoteId, {
        fileName: 'report.pdf',
        contentType: PDF,
        declaredSizeBytes: bytes.length,
      });

      expect(envelope.attachmentId).toBeGreaterThan(0);
      expect(envelope.quoteId).toBe(quoteId);
      expect(envelope.uploadUrl).toMatch(/^https?:\/\//);
      expect(envelope.uploadToken.length).toBeGreaterThan(16);
      expect(envelope.expiresInSeconds).toBeGreaterThan(0);

      const transferred = await transfer(envelope, bytes, PDF);
      expect(transferred.ok).toBe(true);

      const response = await confirm(envelope.attachmentId);
      expect(response.status).toBe(201);
      expect(response.headers.get('location')).toBe(
        `/api/v1/attachments/${String(envelope.attachmentId)}`,
      );

      const attachment = (await response.json()) as AttachmentDto;
      expect(attachment).toMatchObject({
        id: envelope.attachmentId,
        quoteId,
        fileName: 'report.pdf',
        contentType: PDF,
        sizeBytes: bytes.length,
        uploadedBy: appUserId(admin),
      });
    });

    it('issues a tenant-prefixed key built from server ids, and stores the row in that tenant', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);

      const row = await readAttachmentRow(attachment.id);
      expect(row?.tenant_id).toBe(String(tenantA));
      // The reference scheme, exactly: t{tenantId}/quotes/{quoteId}/{attachmentId}_{fileName}.
      expect(row?.storage_key).toBe(
        `t${String(tenantA)}/quotes/${String(quoteId)}/${String(attachment.id)}_report.pdf`,
      );
    });

    it('confines a path-traversal filename inside the tenant prefix', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId, { fileName: '../../../t9999/evil.pdf' });

      const key = String((await readAttachmentRow(attachment.id))?.storage_key);
      expect(key).toBe(
        `t${String(tenantA)}/quotes/${String(quoteId)}/${String(attachment.id)}_evil.pdf`,
      );
      expect(key.startsWith(`t${String(tenantA)}/`)).toBe(true);
      expect(key).not.toContain('..');
      expect(key).not.toContain('t9999');

      // The ORIGINAL name is preserved for display and download; only the KEY is sanitized.
      expect(attachment.fileName).toBe('../../../t9999/evil.pdf');
    });

    it('records the SERVER-observed size, not the client-declared one', async () => {
      const quoteId = await createQuoteIn('A');
      const bytes = pdfBytes(4096);

      // A client that lies small: declared 10 bytes, transferred 4096. Both are inside the cap, so
      // the request is legitimately accepted — but the persisted size must be the measured one.
      const attachment = await attachFile(quoteId, { bytes, declaredSizeBytes: 10 });

      expect(attachment.sizeBytes).toBe(4096);
      expect((await readAttachmentRow(attachment.id))?.size_bytes).toBe('4096');
    });

    it('uploads a full 10 MB file end to end, with no /api/v1 request carrying the body (Q-22)', async () => {
      const quoteId = await createQuoteIn('A');
      const TEN_MB = 10 * 1024 * 1024;
      const bytes = pdfBytes(TEN_MB);

      const envelope = await requestUploadOk(quoteId, {
        fileName: 'large.pdf',
        contentType: PDF,
        declaredSizeBytes: TEN_MB,
      });

      // The transfer goes straight to Storage. Were this routed through the function it would be
      // more than double Vercel's ~4.5 MB body cap — this is the case that forced A-7.
      const transferred = await transfer(envelope, bytes, PDF);
      expect(transferred.ok, '10 MB direct transfer should have succeeded').toBe(true);

      const response = await confirm(envelope.attachmentId);
      expect(response.status).toBe(201);
      expect(((await response.json()) as AttachmentDto).sizeBytes).toBe(TEN_MB);
    }, 120_000);

    it('returns a working, short-lived download URL with attachment disposition', async () => {
      const quoteId = await createQuoteIn('A');
      const bytes = pdfBytes(256);
      const attachment = await attachFile(quoteId, { bytes });

      const response = await call('GET', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(200);

      const envelope = (await response.json()) as DownloadEnvelope;
      expect(envelope.fileName).toBe('report.pdf');
      expect(envelope.sizeBytes).toBe(bytes.length);
      // SHORT-LIVED: an unbounded or day-long URL would fail this, and it is a bearer credential.
      expect(envelope.expiresInSeconds).toBeGreaterThan(0);
      expect(envelope.expiresInSeconds).toBeLessThanOrEqual(900);

      const fetched = await fetch(envelope.downloadUrl);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.get('content-disposition') ?? '').toMatch(/attachment/i);
      expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);
    });

    it('does not put the signed URL in the persisted row', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);

      // The row must name the object, never carry a credential for it.
      const row = await readAttachmentRow(attachment.id);
      expect(String(row?.storage_key)).not.toContain('token=');
      expect(String(row?.storage_key)).not.toMatch(/^https?:/);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Pre-signing validation: rejected BEFORE any URL exists (AC-056, V-071).
  // -------------------------------------------------------------------------------------------

  describe('validation happens before any URL is issued (AC-056, V-071)', () => {
    async function expectNoUrlIssued(response: Response, quoteId: number, code: string): Promise<void> {
      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe(code);
      // The response must not contain a URL, and no row may exist to hold a key.
      expect(JSON.stringify(problem)).not.toContain('token=');
      const rows = await query<{ count: string }>(
        'select count(*)::text as count from quote_attachments where quote_id = $1',
        [quoteId],
      );
      expect(rows[0]?.count, 'no attachment row may be created by a rejected request').toBe('0');
    }

    it('rejects a disallowed content type with ATTACHMENT_DISALLOWED_TYPE and issues no URL', async () => {
      const quoteId = await createQuoteIn('A');
      const response = await requestUpload(quoteId, {
        fileName: 'payload.exe',
        contentType: 'application/x-msdownload',
        declaredSizeBytes: 1024,
      });
      await expectNoUrlIssued(response, quoteId, 'ATTACHMENT_DISALLOWED_TYPE');
    });

    it('rejects an SVG — a disallowed type that renders script — with the same code', async () => {
      const quoteId = await createQuoteIn('A');
      const response = await requestUpload(quoteId, {
        fileName: 'logo.svg',
        contentType: 'image/svg+xml',
        declaredSizeBytes: 512,
      });
      await expectNoUrlIssued(response, quoteId, 'ATTACHMENT_DISALLOWED_TYPE');
    });

    it('rejects an allow-listed type whose EXTENSION disagrees (the renamed-executable case)', async () => {
      const quoteId = await createQuoteIn('A');
      const response = await requestUpload(quoteId, {
        fileName: 'invoice.pdf.exe',
        contentType: PDF,
        declaredSizeBytes: 1024,
      });
      await expectNoUrlIssued(response, quoteId, 'ATTACHMENT_EXTENSION_MISMATCH');
    });

    it('rejects a declared size above the per-tenant cap with ATTACHMENT_OVER_SIZE_CAP', async () => {
      const quoteId = await createQuoteIn('A');
      const response = await requestUpload(quoteId, {
        fileName: 'huge.pdf',
        contentType: PDF,
        declaredSizeBytes: 10 * 1024 * 1024 + 1,
      });
      await expectNoUrlIssued(response, quoteId, 'ATTACHMENT_OVER_SIZE_CAP');
    });

    it('honours a LOWERED per-tenant cap, proving the cap is read per tenant and not hard-coded', async () => {
      const quoteId = await createQuoteIn('A');
      await setSizeCap(tenantA, 1);
      try {
        const response = await requestUpload(quoteId, {
          fileName: 'twomb.pdf',
          contentType: PDF,
          declaredSizeBytes: 2 * 1024 * 1024,
        });
        await expectNoUrlIssued(response, quoteId, 'ATTACHMENT_OVER_SIZE_CAP');
        expect((await problemOf(await requestUpload(quoteId, {
          fileName: 'twomb.pdf',
          contentType: PDF,
          declaredSizeBytes: 2 * 1024 * 1024,
        }))).detail).toContain('1 MB');
      } finally {
        await setSizeCap(tenantA, 10);
      }
    });

    it('rejects an empty file with the reference validator message', async () => {
      const quoteId = await createQuoteIn('A');
      const response = await requestUpload(quoteId, {
        fileName: 'empty.pdf',
        contentType: PDF,
        declaredSizeBytes: 0,
      });
      expect(response.status).toBe(422);
      const problem = await problemOf(response);
      expect(problem.code).toBe('ATTACHMENT_VALIDATION_FAILED');
      expect(problem.errors?.some((e) => e.code === 'ATTACHMENT_EMPTY_FILE')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Confirm-time verification: the R-8 post-upload step (AC-057, V-073).
  // -------------------------------------------------------------------------------------------

  describe('confirm verifies the object that actually landed (AC-057, R-8, V-073)', () => {
    it('rejects content whose magic number contradicts the declared type, and deletes the object', async () => {
      const quoteId = await createQuoteIn('A');
      // Declared and named as a PDF; the bytes are a PNG. The pre-signing checks cannot see this,
      // because they never see bytes — this is exactly the gap the confirm step closes.
      const envelope = await requestUploadOk(quoteId, {
        fileName: 'disguised.pdf',
        contentType: PDF,
        declaredSizeBytes: 64,
      });
      const key = await storageKeyOf(envelope.attachmentId);
      expect((await transfer(envelope, pngBytes(64), PDF)).ok).toBe(true);
      expect(await storage.stat(key), 'the object should exist before confirm rejects it').not.toBeNull();

      const response = await confirm(envelope.attachmentId);

      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('ATTACHMENT_SIGNATURE_MISMATCH');
      // Both halves cleaned up: no orphaned object, no orphaned pending row.
      expect(await storage.stat(key), 'the rejected object must be deleted').toBeNull();
      expect(await readAttachmentRow(envelope.attachmentId)).toBeUndefined();
    });

    it('rejects an executable renamed to .pdf on its bytes alone', async () => {
      const quoteId = await createQuoteIn('A');
      const envelope = await requestUploadOk(quoteId, {
        fileName: 'report.pdf',
        contentType: PDF,
        declaredSizeBytes: 64,
      });
      const key = await storageKeyOf(envelope.attachmentId);
      // MZ — a Windows executable header.
      const mz = new Uint8Array(64);
      mz.set([0x4d, 0x5a, 0x90, 0x00]);
      expect((await transfer(envelope, mz, PDF)).ok).toBe(true);

      const response = await confirm(envelope.attachmentId);

      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('ATTACHMENT_SIGNATURE_MISMATCH');
      expect(await storage.stat(key)).toBeNull();
    });

    it('rejects an object that is oversize DESPITE an honest-looking declared size, and cleans up', async () => {
      const quoteId = await createQuoteIn('A');
      await setSizeCap(tenantA, 1);
      try {
        // Declares 1 KB (inside the 1 MB cap, so a URL is issued) then transfers 2 MB. Only the
        // server-observed size at confirm can catch this.
        const envelope = await requestUploadOk(quoteId, {
          fileName: 'sneaky.pdf',
          contentType: PDF,
          declaredSizeBytes: 1024,
        });
        const key = await storageKeyOf(envelope.attachmentId);
        expect((await transfer(envelope, pdfBytes(2 * 1024 * 1024), PDF)).ok).toBe(true);

        const response = await confirm(envelope.attachmentId);

        expect(response.status).toBe(422);
        expect((await problemOf(response)).code).toBe('ATTACHMENT_OVER_SIZE_CAP');
        expect(await storage.stat(key)).toBeNull();
        expect(await readAttachmentRow(envelope.attachmentId)).toBeUndefined();
      } finally {
        await setSizeCap(tenantA, 10);
      }
    });

    it('rejects confirming an attachment whose bytes were never transferred', async () => {
      const quoteId = await createQuoteIn('A');
      const envelope = await requestUploadOk(quoteId, {
        fileName: 'never.pdf',
        contentType: PDF,
        declaredSizeBytes: 32,
      });

      const response = await confirm(envelope.attachmentId);

      expect(response.status).toBe(422);
      expect((await problemOf(response)).code).toBe('ATTACHMENT_OBJECT_MISSING');
    });

    it('rejects a second confirm with 409 ATTACHMENT_ALREADY_CONFIRMED', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);

      const response = await confirm(attachment.id);

      expect(response.status).toBe(409);
      expect((await problemOf(response)).code).toBe('ATTACHMENT_ALREADY_CONFIRMED');
    });

    it('hides an unconfirmed attachment from the list and from download', async () => {
      const quoteId = await createQuoteIn('A');
      const envelope = await requestUploadOk(quoteId, {
        fileName: 'pending.pdf',
        contentType: PDF,
        declaredSizeBytes: 32,
      });

      const list = await listAttachments(quoteId);
      expect(list.status).toBe(200);
      expect((await list.json()) as AttachmentDto[]).toHaveLength(0);

      // A pending attachment must never yield a signed URL: there is no object behind it.
      const download = await call('GET', `${ATTACHMENTS}/${String(envelope.attachmentId)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(download.status).toBe(404);
      expect((await problemOf(download)).code).toBe('ATTACHMENT_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Tenant isolation (AC-021, AC-022, V-026, V-027, V-072).
  // -------------------------------------------------------------------------------------------

  describe('tenant isolation on every attachment operation (AC-021, AC-022, V-026, V-072)', () => {
    it('answers 404 for a tenant-B caller requesting an upload on a tenant-A quote, issuing no URL', async () => {
      const quoteA = await createQuoteIn('A');

      const response = await requestUpload(
        quoteA,
        { fileName: 'x.pdf', contentType: PDF, declaredSizeBytes: 32 },
        { tenantId: tenantB },
      );

      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe('ATTACHMENT_QUOTE_NOT_FOUND');
      const rows = await query<{ count: string }>(
        'select count(*)::text as count from quote_attachments where quote_id = $1',
        [quoteA],
      );
      expect(rows[0]?.count).toBe('0');
    });

    it('answers 404 — byte-identical to a nonexistent id — for a tenant-B caller on a tenant-A attachment', async () => {
      const quoteA = await createQuoteIn('A');
      const attachment = await attachFile(quoteA);

      const crossTenant = await call('GET', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantB,
      });
      const nonexistent = await call('GET', `${ATTACHMENTS}/2147483000`, {
        token: admin.accessToken,
        tenantId: tenantB,
      });

      expect(crossTenant.status).toBe(404);
      expect(nonexistent.status).toBe(404);

      // Deep-equal after removing the per-request correlation id and the id-bearing detail: the
      // SHAPE and the CODE must not distinguish "exists elsewhere" from "does not exist".
      // The correlation id is per-request by design and the detail names the id that was asked
      // for; everything else — status, title, type and CODE — must be identical.
      const strip = (body: ProblemBody): Record<string, unknown> => {
        const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
        delete rest.detail;
        delete rest.correlationId;
        return rest;
      };
      const crossBody = await problemOf(crossTenant);
      const missingBody = await problemOf(nonexistent);
      expect(strip(crossBody)).toEqual(strip(missingBody));
      expect(crossBody.code).toBe('ATTACHMENT_NOT_FOUND');
      expect(missingBody.code).toBe('ATTACHMENT_NOT_FOUND');
    });

    it('never mints a signed URL for a tenant-A key on behalf of a tenant-B caller', async () => {
      const quoteA = await createQuoteIn('A');
      const attachment = await attachFile(quoteA);

      const response = await call('GET', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantB,
      });

      expect(response.status).toBe(404);
      // The failure must occur BEFORE signing: nothing resembling a URL may appear in the body.
      const raw = await response.text();
      expect(raw).not.toContain('token=');
      expect(raw).not.toContain('/storage/v1');
    });

    it('refuses a cross-tenant confirm and leaves the pending row untouched', async () => {
      const quoteA = await createQuoteIn('A');
      const envelope = await requestUploadOk(quoteA, {
        fileName: 'x.pdf',
        contentType: PDF,
        declaredSizeBytes: 32,
      });
      await transfer(envelope, pdfBytes(32), PDF);

      const response = await confirm(envelope.attachmentId, { tenantId: tenantB });

      expect(response.status).toBe(404);
      expect((await problemOf(response)).code).toBe('ATTACHMENT_NOT_FOUND');
      // No side effect: still pending, so tenant A's own confirm still works afterwards.
      expect((await readAttachmentRow(envelope.attachmentId))?.confirmed_at).toBeNull();
      expect((await confirm(envelope.attachmentId)).status).toBe(201);
    });

    it('refuses a cross-tenant remove and leaves the row live', async () => {
      const quoteA = await createQuoteIn('A');
      const attachment = await attachFile(quoteA);

      const response = await call('DELETE', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantB,
      });

      expect(response.status).toBe(404);
      expect((await readAttachmentRow(attachment.id))?.removed_at).toBeNull();
    });

    it('lists only the addressed tenant\'s attachments', async () => {
      const quoteA = await createQuoteIn('A');
      const quoteB = await createQuoteIn('B');
      await attachFile(quoteA, { fileName: 'tenant-a.pdf' });

      const listA = await listAttachments(quoteA);
      expect(listA.status).toBe(200);
      const itemsA = (await listA.json()) as AttachmentDto[];
      expect(itemsA).toHaveLength(1);
      expect(itemsA[0]?.fileName).toBe('tenant-a.pdf');

      // The same quote id addressed as tenant B does not resolve at all.
      const crossList = await listAttachments(quoteA, { tenantId: tenantB });
      expect(crossList.status).toBe(404);

      const listB = await listAttachments(quoteB, { tenantId: tenantB });
      expect(listB.status).toBe(200);
      expect((await listB.json()) as AttachmentDto[]).toHaveLength(0);
    });

    it('keeps the two tenants in separate storage-key prefixes', async () => {
      const quoteA = await createQuoteIn('A');
      const quoteB = await createQuoteIn('B');
      const a = await attachFile(quoteA);

      const envelopeB = await call('POST', `${QUOTES}/${String(quoteB)}/attachments`, {
        token: admin.accessToken,
        tenantId: tenantB,
        body: { fileName: 'b.pdf', contentType: PDF, declaredSizeBytes: 32 },
      });
      expect(envelopeB.status).toBe(202);
      const bEnvelope = (await envelopeB.json()) as UploadEnvelope;
      createdObjectKeys.add(await storageKeyOf(bEnvelope.attachmentId));

      const keyA = String((await readAttachmentRow(a.id))?.storage_key);
      const keyB = String((await readAttachmentRow(bEnvelope.attachmentId))?.storage_key);

      expect(keyA.startsWith(`t${String(tenantA)}/`)).toBe(true);
      expect(keyB.startsWith(`t${String(tenantB)}/`)).toBe(true);
      expect(keyA.startsWith(`t${String(tenantB)}/`)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Authorization negatives (AC-056, V-072).
  // -------------------------------------------------------------------------------------------

  describe('authorization negatives (V-072)', () => {
    it('rejects an anonymous caller with 401 on every attachment route', async () => {
      const quoteId = await createQuoteIn('A');
      for (const [method, path] of [
        ['POST', `${QUOTES}/${String(quoteId)}/attachments`],
        ['GET', `${QUOTES}/${String(quoteId)}/attachments`],
        ['POST', `${ATTACHMENTS}/1/confirm`],
        ['GET', `${ATTACHMENTS}/1`],
        ['DELETE', `${ATTACHMENTS}/1`],
      ] as const) {
        const response = await call(method, path, { tenantId: tenantA });
        expect(response.status, `${method} ${path} should be 401 anonymously`).toBe(401);
      }
    });

    it('rejects a caller without quotes.update on the mutating routes with 403, issuing no URL', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);

      const requested = await requestUpload(
        quoteId,
        { fileName: 'x.pdf', contentType: PDF, declaredSizeBytes: 32 },
        { session: viewer },
      );
      expect(requested.status).toBe(403);
      expect(await requested.text()).not.toContain('token=');

      const removed = await call('DELETE', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(removed.status).toBe(403);
      expect((await readAttachmentRow(attachment.id))?.removed_at).toBeNull();
    });

    it('allows a quotes.view-only caller to read the list and the download envelope', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);

      const list = await listAttachments(quoteId, { session: viewer });
      expect(list.status).toBe(200);

      const download = await call('GET', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: viewer.accessToken,
        tenantId: tenantA,
      });
      expect(download.status).toBe(200);
    });

    it('requires quotes.correct_closed to attach to a CLOSED quote, and succeeds with it', async () => {
      const quoteId = await createQuoteIn('A');
      // Drive the quote to a terminal status directly: this suite owns the attachment gate, not the
      // workflow, and the gate reads the quote's status regardless of how it got there.
      await query('update quotes set status_id = $2 where id = $1', [quoteId, terminalQuoteStatusA]);

      const denied = await requestUpload(
        quoteId,
        { fileName: 'x.pdf', contentType: PDF, declaredSizeBytes: 32 },
        { session: editor },
      );
      expect(denied.status).toBe(403);
      expect((await problemOf(denied)).code).toBe(
        'ATTACHMENT_CLOSED_QUOTE_REQUIRES_CORRECTION_PERMISSION',
      );

      // The admin holds `quotes.correct_closed`, so the same request SUCCEEDS — the audited
      // corrections path, exactly as the reference's closed-record gate behaves.
      const allowed = await requestUpload(quoteId, {
        fileName: 'x.pdf',
        contentType: PDF,
        declaredSizeBytes: 32,
      });
      expect(allowed.status).toBe(202);
      createdObjectKeys.add(
        await storageKeyOf(((await allowed.json()) as UploadEnvelope).attachmentId),
      );
    });

    it('requires quotes.correct_closed to REMOVE from a closed quote', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);
      await query('update quotes set status_id = $2 where id = $1', [quoteId, terminalQuoteStatusA]);

      const response = await call('DELETE', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: editor.accessToken,
        tenantId: tenantA,
      });

      expect(response.status).toBe(403);
      expect((await problemOf(response)).code).toBe(
        'ATTACHMENT_CLOSED_QUOTE_REQUIRES_CORRECTION_PERMISSION',
      );
      expect((await readAttachmentRow(attachment.id))?.removed_at).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // The private bucket (AC-056, V-072).
  // -------------------------------------------------------------------------------------------

  describe('the bucket is private and unreachable without a signed URL (AC-056, V-072)', () => {
    it('is provisioned private, with the code allow-list mirrored as a storage-level backstop', async () => {
      const rows = await query<{
        public: boolean;
        file_size_limit: string | null;
        allowed_mime_types: string[] | null;
      }>(
        'select public, file_size_limit::text as file_size_limit, allowed_mime_types from storage.buckets where id = $1',
        [BUCKET],
      );

      expect(rows[0]?.public, 'the attachments bucket must not be public').toBe(false);
      // Drift guard: the migration's list and the code's allow-list must not diverge, or valid
      // uploads would be refused at the storage layer with an unhelpful error.
      expect([...(rows[0]?.allowed_mime_types ?? [])].sort()).toEqual(
        [...ALLOWED_ATTACHMENT_CONTENT_TYPES].sort(),
      );
      expect(Number(rows[0]?.file_size_limit)).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    });

    it('has no storage RLS policy, which is what denies anon and authenticated callers', async () => {
      const rows = await query<{ count: string }>(
        `select count(*)::text as count from pg_policies
          where schemaname = 'storage' and tablename = 'objects'`,
      );
      expect(rows[0]?.count, 'a permissive storage policy would expose every tenant').toBe('0');
    });

    it('refuses a direct object read with the anon key', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);
      const key = await storageKeyOf(attachment.id);

      const response = await fetch(storageUrl(`/object/${BUCKET}/${key}`), {
        headers: { apikey: stack.anonKey, Authorization: `Bearer ${stack.anonKey}` },
      });

      expect(response.ok, 'the anon key must not read the private bucket').toBe(false);
      expect([400, 401, 403, 404]).toContain(response.status);
    });

    it('refuses an unauthenticated object read', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);
      const key = await storageKeyOf(attachment.id);

      const response = await fetch(storageUrl(`/object/${BUCKET}/${key}`));

      expect(response.ok).toBe(false);
    });

    it('refuses an expired signed download URL', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);
      const key = await storageKeyOf(attachment.id);

      // MEASURED: Storage refuses `expiresIn < 1`, so an already-expired URL cannot be minted
      // directly. Mint the shortest legal one and let it lapse — this exercises real expiry
      // enforcement by the STORAGE SERVICE rather than any client-side check.
      //
      // There is deliberately NO "it works before expiring" pre-assertion here. It raced the
      // 1-second window under full-suite load and failed once, and it asserts nothing this suite
      // does not already prove twice over (the download test and the adapter contract both fetch a
      // live signed URL). Only the post-expiry assertion is kept, and it is one-directional: extra
      // delay can only make it MORE true, so it cannot flake in the other direction.
      const shortLived = await storage.createSignedDownloadUrl(key, { expiresInSeconds: 1 });
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const response = await fetch(shortLived.url);

      expect(response.ok, 'an expired signed URL must not serve the object').toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Soft remove and audit (AC-024, AC-057, V-031, V-073).
  // -------------------------------------------------------------------------------------------

  describe('soft remove and audit (AC-024, AC-057, V-031, V-073)', () => {
    it('writes exactly one quote_attachment.uploaded audit row on confirm, not on request', async () => {
      const quoteId = await createQuoteIn('A');
      const envelope = await requestUploadOk(quoteId, {
        fileName: 'audited.pdf',
        contentType: PDF,
        declaredSizeBytes: 32,
      });

      // Nothing is attached yet, so nothing may be audited yet.
      expect(
        await findAuditRows(query, {
          action: 'quote_attachment.uploaded',
          entityId: String(envelope.attachmentId),
        }),
      ).toHaveLength(0);

      await transfer(envelope, pdfBytes(32), PDF);
      expect((await confirm(envelope.attachmentId)).status).toBe(201);

      await assertAudited(query, {
        action: 'quote_attachment.uploaded',
        entityType: 'quote_attachment',
        entityId: String(envelope.attachmentId),
        actorUserId: appUserId(admin),
        tenantId: tenantA,
        before: null,
        after: { quoteId, fileName: 'audited.pdf', contentType: PDF, sizeBytes: 32 },
      });
    });

    it('soft removes: the row is retained and flagged, and a distinct audit row is written', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId, { fileName: 'removeme.pdf' });
      const key = await storageKeyOf(attachment.id);

      const response = await call('DELETE', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(response.status).toBe(204);

      // RETAINED (NFR-09), flagged, and attributable.
      const row = await readAttachmentRow(attachment.id);
      expect(row, 'a removed attachment row must be RETAINED, never hard-deleted').toBeDefined();
      expect(row?.removed_at).not.toBeNull();
      expect(row?.removed_by).toBe(String(appUserId(admin)));
      expect(row?.file_name).toBe('removeme.pdf');

      // The bytes DO go.
      expect(await storage.stat(key)).toBeNull();

      await assertAudited(query, {
        action: 'quote_attachment.removed',
        entityType: 'quote_attachment',
        entityId: String(attachment.id),
        actorUserId: appUserId(admin),
        tenantId: tenantA,
      });
    });

    it('hides a removed attachment from the list while its history remains queryable', async () => {
      const quoteId = await createQuoteIn('A');
      const kept = await attachFile(quoteId, { fileName: 'kept.pdf' });
      const removed = await attachFile(quoteId, { fileName: 'gone.pdf' });

      expect(((await listAttachments(quoteId)).status)).toBe(200);
      const before = (await (await listAttachments(quoteId)).json()) as AttachmentDto[];
      expect(before.map((a) => a.fileName).sort()).toEqual(['gone.pdf', 'kept.pdf']);

      expect(
        (await call('DELETE', `${ATTACHMENTS}/${String(removed.id)}`, {
          token: admin.accessToken,
          tenantId: tenantA,
        })).status,
      ).toBe(204);

      const after = (await (await listAttachments(quoteId)).json()) as AttachmentDto[];
      expect(after.map((a) => a.fileName)).toEqual(['kept.pdf']);
      expect(after.map((a) => a.id)).not.toContain(removed.id);

      // HISTORY REMAINS: the row and both audit rows survive the removal.
      expect(await readAttachmentRow(removed.id)).toBeDefined();
      expect(
        await findAuditRows(query, {
          action: 'quote_attachment.uploaded',
          entityId: String(removed.id),
        }),
      ).toHaveLength(1);
      expect(kept.id).not.toBe(removed.id);
    });

    it('answers 404 for a download or a second remove of a removed attachment', async () => {
      const quoteId = await createQuoteIn('A');
      const attachment = await attachFile(quoteId);
      await call('DELETE', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      const download = await call('GET', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      const second = await call('DELETE', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });

      expect(download.status).toBe(404);
      expect((await problemOf(download)).code).toBe('ATTACHMENT_NOT_FOUND');
      expect(second.status).toBe(404);
    });

    it('stamps lead activity on attach and on remove', async () => {
      const quoteId = await createQuoteIn('A');
      const leadRows = await query<{ lead_id: string }>(
        'select lead_id::text as lead_id from quotes where id = $1',
        [quoteId],
      );
      const leadId = Number(leadRows[0]?.lead_id);

      const readActivity = async (): Promise<string> => {
        const rows = await query<{ last_activity_at: string }>(
          'select last_activity_at::text as last_activity_at from leads where id = $1',
          [leadId],
        );
        return String(rows[0]?.last_activity_at);
      };

      const beforeAttach = await readActivity();
      const attachment = await attachFile(quoteId);
      const afterAttach = await readActivity();
      expect(afterAttach).not.toBe(beforeAttach);

      await call('DELETE', `${ATTACHMENTS}/${String(attachment.id)}`, {
        token: admin.accessToken,
        tenantId: tenantA,
      });
      expect(await readActivity()).not.toBe(afterAttach);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Residue: this suite shares one database and one bucket with siblings (V-027).
  // -------------------------------------------------------------------------------------------

  describe('leaves no residue', () => {
    it('creates every object under a prefix owned by one of this run\'s tenants', async () => {
      const rows = await query<{ storage_key: string }>(
        'select storage_key from quote_attachments where tenant_id = any($1::bigint[])',
        [createdTenants],
      );
      for (const row of rows) {
        expect(
          row.storage_key === '' ||
            createdTenants.some((id) => row.storage_key.startsWith(`t${String(id)}/`)),
          `key ${row.storage_key} must belong to a tenant this run created`,
        ).toBe(true);
      }
    });
  });
});
