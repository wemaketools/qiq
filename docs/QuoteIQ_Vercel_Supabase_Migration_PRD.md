# QuoteIQ Platform Modernization PRD

**Product:** QuoteIQ - Insurance Leads and Quotation Intelligence Platform  
**Document type:** Product Requirements Document for platform modernization  
**Prepared:** July 18, 2026  
**Updated:** July 18, 2026  
**Primary objective:** Migrate the existing QuoteIQ application from a .NET backend with a Postgres database and Hangfire background jobs to a TypeScript backend deployable on Vercel, using Supabase as the database platform and Docker-based Supabase local development.

---

## 1. Executive Summary

QuoteIQ was previously specified as a multi-tenant insurance lead and quotation intelligence application with a .NET backend, Postgres database, and Hangfire for background jobs. This PRD defines the requirements to update that application so the backend can run on Vercel using TypeScript, while preserving the product capabilities already defined for leads, quotes, tenant management, user management, RBAC, dashboards, alerts, reporting, and tenant-specific configuration.

The modernization should not change the core business purpose of QuoteIQ. The application must still support:

- Multi-tenant lead and quote management.
- Tenant-specific brokers, relationship managers, leads, quotes, and configurable business lists.
- Clear distinction between Leads and Quotes.
- Dashboard and visualization requirements for executive, pipeline, RM, broker, loss, SLA, alerts, and reporting views.
- Permission-bound Tenant Manager and User Manager sections.
- Flexible role-based access control with roles, permissions, user groups, direct user assignments, and tenant switching.

The modernization changes the technical foundation:

- Replace the .NET backend with a TypeScript backend that can run as Vercel Functions or an equivalent Vercel-compatible TypeScript server layer.
- Replace direct application ownership of Postgres hosting with Supabase Postgres.
- Provide a complete local development setup using Supabase in Docker.
- Replace Hangfire with Vercel-compatible scheduled and asynchronous job patterns, primarily Vercel Cron Jobs and Vercel Queues or equivalent Vercel-native background processing options.
- Provide explicit local-development substitutes for Vercel Cron and Vercel Queues, because they cannot be fully emulated as managed Vercel services on a developer machine.
- Prepare the repository for eventual Vercel deployment by including Vercel configuration files, environment-variable placeholders, deployment documentation, and local/preview/staging/production setup guidance.

The expected result is a Vercel-deployable, TypeScript-based QuoteIQ application that remains functionally equivalent to the prior app while becoming easier to deploy, preview, and iterate in a serverless environment. Local development must be productive and deterministic, but it should be clear where local behavior is a simulation rather than a perfect reproduction of Vercel’s managed runtime.

---

## 2. Goals

### 2.1 Business Goals

- Preserve all previously approved QuoteIQ business functionality while changing the backend platform.
- Reduce infrastructure management burden by using Vercel for backend deployment and Supabase for managed Postgres services.
- Improve developer onboarding with a repeatable local development environment.
- Support fast preview deployments for product review, stakeholder demos, and QA.
- Keep background job capabilities required for reminders, alerts, scheduled reporting, lifecycle checks, and operational automation.
- Retain tenant isolation, RBAC, auditability, dashboard accuracy, and reporting reliability.

### 2.2 Product Goals

- Allow the application to operate with the same user-facing features after migration.
- Ensure tenant administrators, internal administrators, sales users, RMs, underwriters, executive viewers, and sales operations users experience no material loss of capability.
- Maintain consistent terminology across the product: Lead for the initial request/opportunity and Quote for the formal quotation/proposal associated to a Lead.
- Keep Tenant Manager and User Manager as permission-bound admin sections in the left navigation.
- Keep the dashboards and visualizations defined in the prior QuoteIQ PRD.

### 2.3 Technical Platform Goals

- Move backend application logic to TypeScript.
- Deploy backend endpoints on Vercel using a Vercel-supported TypeScript/Node runtime.
- Use Supabase Postgres as the operational database.
- Support Supabase local development through Docker and the Supabase CLI.
- Replace Hangfire with Vercel-native scheduled, queued, and asynchronous execution patterns.
- Define migration requirements for existing database schema, data, migrations, and job definitions.

---

## 3. Non-Goals

The modernization PRD does not require the following unless separately approved:

- Rewriting the frontend UI from scratch.
- Changing the approved QuoteIQ business model, dashboard definitions, or domain terminology.
- Replacing Supabase with another database platform.
- Using Supabase as the identity provider unless that is separately decided.
- Adding AI scoring, automated underwriting, or automated quote pricing.
- Adding email or WhatsApp integrations unless they already exist and must be preserved.
- Adding new insurance product capabilities unrelated to the platform migration.
- Building a generic queueing abstraction for every cloud provider; the target is Vercel-compatible execution.

---

## 4. Current State and Target State

### 4.1 Current State Assumptions

| Area | Current Assumption |
|---|---|
| Backend | .NET backend. |
| Database | Postgres database. |
| Data access | Existing .NET data access and migration approach, likely EF Core or equivalent. |
| Background jobs | Hangfire-based recurring and background processing. |
| Core product | Multi-tenant lead/quote management with dashboards, alerts, RBAC, Tenant Manager, and User Manager. |
| Deployment | Not optimized for Vercel-hosted TypeScript backend execution. |

### 4.2 Target State

| Area | Target Requirement |
|---|---|
| Backend language | TypeScript. |
| Backend hosting | Vercel-compatible serverless or Vercel function-based backend. |
| Database | Supabase Postgres. |
| Local database | Supabase local development stack running in Docker. |
| Database migrations | Repeatable SQL or TypeScript-compatible migration process usable locally, in CI, and against Supabase environments. |
| Background jobs | Vercel Cron Jobs, Vercel Queues, and/or Vercel-compatible durable async patterns replacing Hangfire. |
| Environments | Local, Preview, Staging, and Production environments with environment-specific Supabase projects or databases. |
| Product behavior | Functionally equivalent to the previously specified QuoteIQ application. |

---

## 5. Scope of Modernization

### 5.1 In Scope

- TypeScript backend implementation requirements.
- Vercel deployment requirements.
- Supabase database requirements.
- Supabase local development setup through Docker.
- Migration of existing Postgres schema and data to Supabase Postgres.
- Replacement of Hangfire jobs with Vercel-native background execution.
- Preservation of RBAC, tenant isolation, tenant switching, and admin management features.
- Preservation of dashboards, alerts, and reports.
- Testing, acceptance criteria, and rollout plan for the platform migration.

### 5.2 Out of Scope Unless Approved

- A full UX redesign.
- Replacing the frontend framework.
- Adopting Supabase Auth as the identity provider.
- Migrating file/document storage to Supabase Storage unless current document-upload features require it.
- Building broker-facing external access beyond what was already specified.
- Expanding the product beyond the approved QuoteIQ MVP requirements.

---

## 6. Platform Principles

### 6.1 Vercel-Compatible Backend Design

The TypeScript backend must be designed for Vercel execution patterns:

- Backend endpoints should be stateless.
- No endpoint should depend on long-lived in-memory state.
- No backend feature should require a permanently running web server process.
- Long-running work should be broken into smaller tasks or offloaded to queues/workflows.
- Scheduled work should be triggered through Vercel Cron Jobs or another approved Vercel-compatible scheduler.
- Asynchronous work should be triggered through Vercel Queues or another approved Vercel-compatible queueing mechanism.
- Database access must use serverless-safe connection behavior.
- Request handlers must be idempotent where retry or duplicate invocation is possible.

### 6.2 Supabase as the Database Platform

Supabase should be treated primarily as the Postgres platform for QuoteIQ unless a separate product decision is made to use additional Supabase services.

Required Supabase capabilities for the MVP migration:

- Postgres database.
- Local Supabase stack through Docker.
- Database migrations.
- Seed data for local development.
- Environment-specific database configuration.
- Secure connection strategy for Vercel backend functions.

Optional Supabase capabilities:

- Supabase Auth.
- Supabase Storage for quote documents or attachments.
- Supabase Edge Functions.
- Supabase Realtime.
- Supabase Data API / PostgREST for selected read-heavy endpoints.

### 6.3 Preserve Product Behavior

The migration must be behavior-preserving unless a change is explicitly approved. Users should still be able to:

- Create, view, edit, and close Leads.
- Create, view, edit, revise, win, lose, expire, and withdraw Quotes.
- Manage tenants through Tenant Manager.
- Manage users, roles, permissions, groups, and group memberships through User Manager.
- Configure tenant-specific request channels, product lines, cover types, segments, industries, regions, and client types.
- View dashboards and drill into underlying records.
- Export reports.
- Receive or view alerts generated by background processing.

---

## 7. Backend Requirements

### 7.1 TypeScript Backend

| Requirement | Description |
|---|---|
| TypeScript first | All backend application logic must be implemented in TypeScript. |
| Vercel deployable | API endpoints must be deployable to Vercel without requiring a persistent process. |
| Modular domain structure | Lead, Quote, Tenant, User, RBAC, Broker, RM, Alert, Dashboard, Report, and Job domains should be organized clearly. |
| Shared validation | Request validation should be explicit and reusable across API handlers. |
| Stable API contracts | Existing frontend API contracts should be preserved where practical to reduce frontend migration effort. |
| API versioning | Breaking API changes should be versioned or isolated behind compatibility adapters. |
| Error standardization | API errors should use consistent shape, status code, message, and optional detail fields. |
| Audit support | Backend services must write audit events for privileged and business-critical operations. |
| Tenant context enforcement | Every tenant-scoped API operation must resolve and enforce tenant context. |
| Permission enforcement | Every protected operation must check effective permissions before execution. |

### 7.2 API Categories

The TypeScript backend must support API capabilities for the following product areas:

- Authentication/session integration.
- Tenant context and tenant switching.
- Tenant Manager.
- User Manager.
- Lead management.
- Quote management.
- Broker and broker contact management.
- Relationship Manager management or assignment.
- Tenant-configurable reference data.
- Follow-ups and notes.
- Alerts and escalations.
- Dashboards and metrics.
- Reports and exports.
- Background job control/status where needed.
- Audit history.

### 7.3 Tenant Context Requirements

Every backend request for tenant-scoped data must include or resolve an active tenant context.

| Requirement | Description |
|---|---|
| Tenant resolution | The backend must determine the active tenant from the authenticated session, request context, or explicit tenant selector. |
| Membership validation | The backend must verify that the user is assigned to the requested tenant unless the user has Internal/global access. |
| Internal override | Internal users may access any tenant only when their permissions allow it. |
| No mixed data | Tenant-scoped endpoints must not return data from multiple tenants unless the endpoint is explicitly marked as cross-tenant and restricted to Internal users. |
| Audit tenant context | Audit events for tenant-scoped operations should include tenant context. |

### 7.4 RBAC Enforcement Requirements

The backend must enforce the approved RBAC model:

- Permissions are granular capabilities.
- Roles are named collections of permissions.
- User Groups are named groups that contain users and can have roles and/or permissions assigned.
- Users can receive roles directly.
- Users can receive permissions directly.
- A user’s effective permissions are the combination of direct permissions, direct role permissions, group permissions, and group role permissions.
- Users must be assigned to at least one tenant unless they are Internal/global users.
- Tenant-scoped roles and permissions apply only to the relevant tenant.
- Internal/global permissions apply across tenants only where explicitly granted.

### 7.5 Backend Compatibility Requirements

Where practical, the TypeScript backend should preserve existing API behavior:

- Preserve endpoint semantics where the frontend already depends on them.
- Preserve DTO field names unless a rename is required for approved terminology such as Lead vs Quote.
- Preserve pagination, sorting, filtering, and export behavior.
- Preserve dashboard metric definitions.
- Preserve alert categories and trigger meanings.
- Preserve user-visible validation messages where appropriate.

Where compatibility cannot be preserved, the migration must identify the affected frontend changes and document the reason.

---

## 8. Supabase Database Requirements

### 8.1 Supabase Postgres as Primary Database

Supabase Postgres must become the operational database for the migrated application.

| Requirement | Description |
|---|---|
| Preserve relational model | Existing Lead, Quote, Tenant, RBAC, Broker, RM, Alert, Report, and Audit concepts must remain relationally queryable. |
| Preserve tenant isolation | Tenant-scoped records must continue to be segregated by tenant. |
| Support dashboards | Schema and indexes must support dashboard queries and drilldowns efficiently. |
| Support auditability | Audit tables or audit event structures must be retained or introduced. |
| Support soft delete | Tenant deletion and other business deletions that require historical preservation must be soft deletes. |
| Support reporting | Reporting queries must support selected filters and exports without excessive manual aggregation. |

### 8.2 Database Access Strategy

The TypeScript backend must use a Supabase-compatible database access approach that works reliably in Vercel serverless execution.

Requirements:

- Runtime database connections from Vercel must use a serverless-safe connection strategy.
- Direct database connections should be reserved for migrations, backups, restore operations, and controlled administrative use.
- Application traffic should use Supabase’s recommended serverless-friendly access method, such as a transaction pooler or Data API pattern.
- The data access layer must avoid unbounded client-side connection pools in Vercel functions.
- If a SQL driver or ORM is used, it must be configured to be compatible with transaction pooling where required.
- Database credentials must never be exposed to the browser.
- Service-role or privileged database credentials must be used only in server-side code and stored as environment secrets.

### 8.3 Migration Management

The project must provide a repeatable database migration process.

| Requirement | Description |
|---|---|
| Migration source of truth | Database schema changes must be represented in source-controlled migration files. |
| Local migrations | Developers must be able to apply migrations to the local Supabase database. |
| CI validation | Migrations should be validated in CI before deployment. |
| Environment promotion | Migrations should be applied consistently across Preview, Staging, and Production. |
| Rollback strategy | Risky migrations must include rollback or recovery guidance. |
| Seed data | Local development should include seed data for tenants, users, roles, permissions, leads, quotes, dashboards, alerts, and reports. |

### 8.4 Data Model Preservation

The migrated database must preserve the previously approved QuoteIQ data concepts:

- Tenant.
- User.
- User tenant membership.
- Permission.
- Role.
- Role permission assignment.
- User group.
- User group membership.
- User group role assignment.
- User direct role assignment.
- User direct permission assignment.
- Tenant-specific reference data.
- Broker and broker contact.
- Relationship Manager assignment.
- Client/prospect.
- Lead.
- Quote.
- Lead status history.
- Quote status history.
- Follow-up.
- Alert.
- Escalation.
- Report/export history where needed.
- Audit event.

### 8.5 Row-Level Security and Tenant Isolation

The implementation must define how tenant isolation is enforced. The preferred posture is defense in depth.

Requirements:

- Backend permission checks are required for every protected operation.
- Tenant-scoped queries must include tenant filtering.
- Supabase Row-Level Security should be evaluated and used where it materially improves tenant isolation and does not prevent required backend operations.
- Internal/global access must be explicitly handled and auditable.
- Automated tests must verify that users cannot access another tenant’s data through normal endpoints.
- Cross-tenant reporting must be disabled by default and restricted to Internal permissions.

### 8.6 Supabase Storage Requirements

If quote documents or attachments are included in the migrated scope:

- The product should evaluate Supabase Storage as the target storage option.
- Storage objects must be associated with a tenant, Lead, Quote, or audit record as appropriate.
- Access rules must enforce tenant membership and permissions.
- File metadata must remain queryable from the database.
- Historical documents must remain accessible after Lead/Quote closure subject to retention rules.

If documents are not included in the migrated scope, this requirement can be deferred.

---

## 9. Local Development Requirements

### 9.1 Local Development Strategy

The repository must support local development without requiring a deployed Vercel project or a hosted Supabase project. Developers must be able to run the app, database, migrations, seed data, API tests, cron handlers, and queue-style job processing on a workstation.

Local development should approximate the production architecture but must not pretend to be a complete Vercel emulator.

| Area | Local Requirement | Limitation / Note |
|---|---|---|
| TypeScript app and API routes | Run locally through the framework development server and optionally `vercel dev`. | `vercel dev` is useful for approximating Vercel routing/functions, but framework-native dev mode may still be the normal daily workflow. |
| Supabase | Run the local Supabase stack through the Supabase CLI and Docker. | Local Supabase is the required database for normal developer workflows. |
| Vercel Cron | Simulate locally by manually invoking the same cron endpoints or shared cron handlers through scripts. | Vercel Cron itself does not run locally through `vercel dev` or `next dev`; production cron triggers must be validated after deployment. |
| Vercel Queues | Simulate locally through a local queue adapter backed by Supabase/Postgres, with optional integration testing against real Vercel Queues. | Vercel Queues are a managed service and should not be assumed to have a full local Docker emulator. |
| Environment variables | Use `.env.local` for local-only values and `.env.example` for documented placeholders. | Production, Preview, and Staging values must be configured in Vercel, not committed. |

### 9.2 Local Supabase Stack

The repository must include a complete local development setup for Supabase using Docker.

Required developer capabilities:

- Install project dependencies.
- Start the local Supabase stack.
- Stop the local Supabase stack.
- Reset the local database.
- Apply migrations locally.
- Seed local data.
- Run the TypeScript backend locally against local Supabase.
- Run the frontend locally against the local backend.
- Run tests against local Supabase or a dedicated test database.
- Generate TypeScript database types from the local Supabase schema where applicable.

### 9.3 Local Development Scripts

The project should provide scripts or documented commands for the following capabilities. Exact script names may vary, but the repository must provide an equivalent developer workflow.

| Script / Command | Purpose |
|---|---|
| `install` / package-manager install | Install Node/TypeScript project dependencies. |
| `supabase:start` | Start the local Supabase Docker stack. |
| `supabase:stop` | Stop local Supabase services. |
| `supabase:reset` | Reset local database and reapply migrations/seed data. |
| `db:migrate` | Apply migrations to the active local database where required. |
| `db:seed` | Seed local demo/test data where separate from reset. |
| `db:types` | Generate TypeScript types from the Supabase database schema if used. |
| `dev` | Run frontend and backend locally using the normal framework development server. |
| `dev:vercel` | Run `vercel dev` for Vercel-oriented local checks. |
| `typecheck` | Validate TypeScript types. |
| `lint` | Validate code quality rules. |
| `test` | Run unit tests. |
| `test:integration` | Run integration tests against local Supabase or an isolated test database. |
| `cron:list` | List registered local cron handlers. |
| `cron:run <job>` | Manually run a specific cron job locally. |
| `cron:run:all` | Run all locally registered cron handlers once. |
| `queue:worker` | Run a local queue worker against the local queue adapter. |
| `queue:enqueue:test` | Add a test message to the local queue adapter. |
| `jobs:status` | Show recent local job runs and failures. |

Recommended example script shape:

```json
{
  "scripts": {
    "dev": "next dev",
    "dev:vercel": "vercel dev",
    "supabase:start": "supabase start",
    "supabase:stop": "supabase stop",
    "supabase:reset": "supabase db reset",
    "db:types": "supabase gen types typescript --local > src/db/database.types.ts",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "cron:list": "tsx scripts/jobs/list-crons.ts",
    "cron:run": "tsx scripts/jobs/run-cron.ts",
    "cron:run:all": "tsx scripts/jobs/run-all-crons.ts",
    "queue:worker": "tsx scripts/jobs/local-queue-worker.ts",
    "queue:enqueue:test": "tsx scripts/jobs/enqueue-test-message.ts",
    "jobs:status": "tsx scripts/jobs/job-status.ts"
  }
}
```

### 9.4 Local Environment Configuration

The repository must include safe sample environment files and documentation.

Requirements:

- Provide `.env.example` with all required variables and placeholder values.
- Provide `.env.local.example` if local values differ meaningfully from deployed values.
- Provide local Supabase connection variables.
- Provide Vercel/Supabase environment variable documentation for Preview, Staging, and Production.
- Do not commit real secrets.
- Clearly separate anonymous/public Supabase keys from service-role or privileged credentials.
- Document which variables are safe for frontend exposure and which are server-only.
- Ensure `.env`, `.env.local`, `.env.*.local`, and `.vercel` are ignored by source control.

### 9.5 Local Seed Data

Local development must include seed data sufficient to demo and test the app:

- At least two tenants.
- Internal user.
- Tenant Admin user.
- Sales Head user.
- RM user.
- Underwriter user.
- Executive Viewer user.
- Example roles, permissions, and user groups.
- Tenant-specific request channels, product lines, cover types, segments, industries, regions, and client types.
- Brokers and broker contacts for each tenant.
- Example Leads and Quotes in different lifecycle stages.
- Example alerts and escalations.
- Dashboard-ready metrics data.
- Example local queued jobs and historical job-run records.

### 9.6 Local Cron Implementation Requirements

Vercel Cron must be implemented in a way that allows local testing even though the managed scheduler does not run locally.

Requirements:

- Every cron job must have a reusable TypeScript handler that can be called from both:
  - the production Vercel cron endpoint; and
  - a local CLI/script runner.
- Cron endpoint files must be thin wrappers around the shared handler.
- Local cron execution must call the same business logic used by the deployed cron endpoint.
- Local cron runners must support running one named job at a time.
- Local cron runners should support running all registered jobs once.
- Local cron execution must write to the same job-run/history tables as deployed cron execution.
- Local cron execution must use local Supabase by default.
- Cron handlers must be idempotent so manual re-runs do not create duplicate alerts, reminders, exports, notifications, or audit events.
- Cron handlers must log start time, end time, duration, success/failure, and correlation ID.
- Protected cron endpoints must require an internal secret or equivalent server-side authorization for direct HTTP invocation.

Recommended local pattern:

```txt
src/jobs/cron/
  registry.ts                  // named cron job registry
  generate-alerts.ts           // shared handler
  check-quote-expiry.ts        // shared handler
  check-sla-breaches.ts        // shared handler
  dispatch-scheduled-reports.ts// shared handler

src/app/api/cron/generate-alerts/route.ts
  -> validates cron secret / Vercel cron context
  -> calls generateAlertsCronHandler()

scripts/jobs/run-cron.ts
  -> loads local env
  -> resolves job name from CLI args
  -> calls same handler from src/jobs/cron/registry.ts
```

Example local invocation requirements:

```bash
npm run cron:run generate-alerts
npm run cron:run check-quote-expiry
npm run cron:run:all
```

Example HTTP invocation for local debugging:

```bash
curl -H "Authorization: Bearer local-cron-secret" \
  http://localhost:3000/api/cron/generate-alerts
```

### 9.7 Local Queue Implementation Requirements

The application must not bind core business logic directly to the Vercel Queues SDK. Queue publishing and consumption should be implemented through a small application-level abstraction so local development can use a local adapter.

Required queue interfaces:

| Interface | Purpose |
|---|---|
| QueuePublisher | Enqueue a durable work message. |
| QueueConsumer | Consume and acknowledge/fail messages. |
| JobHandler | Execute the business logic for a message type. |
| JobRunRepository | Record job status, attempts, failures, and completion. |

Required implementations:

| Implementation | Environment | Requirement |
|---|---|---|
| VercelQueuePublisher / VercelQueueConsumer | Preview, Staging, Production | Use Vercel Queues or the approved Vercel-compatible queue provider. |
| LocalPostgresQueuePublisher / LocalPostgresQueueConsumer | Local | Use local Supabase/Postgres tables to simulate durable queue behavior. |
| InMemoryQueuePublisher | Unit tests only | Allowed only for deterministic unit tests; not sufficient for local integration testing. |
| VercelQueuePollConsumer | Optional integration/local-to-cloud | Allows a local worker to poll a real Vercel Queue for integration testing where approved. |

The local queue adapter must support:

- Enqueue message.
- Reserve/dequeue message.
- Acknowledge success.
- Mark failure and increment attempt count.
- Retry eligible failed messages.
- Move permanently failed messages to a failed-job/dead-letter table or status.
- Record tenant context, message type, idempotency key, correlation ID, attempt count, status, timestamps, and error details.
- Run a local worker process that can process messages until stopped.

Recommended local queue tables:

| Table | Purpose |
|---|---|
| `job_queue` | Pending, processing, completed, failed, or dead-lettered work messages. |
| `job_run` | Each execution attempt or logical job run. |
| `job_error` | Error details for failed attempts where separate storage is useful. |
| `job_idempotency_key` | Optional table to prevent duplicate processing for critical message types. |

Recommended local pattern:

```txt
src/jobs/queue/
  publisher.ts                 // application interface
  consumer.ts                  // application interface
  handlers.ts                  // message type -> handler mapping
  adapters/
    vercel-queue-publisher.ts
    vercel-queue-consumer.ts
    local-postgres-queue.ts
    in-memory-queue.ts

scripts/jobs/local-queue-worker.ts
  -> loads local env
  -> uses LocalPostgresQueueConsumer
  -> dispatches to src/jobs/queue/handlers.ts
```

Example local invocation requirements:

```bash
npm run queue:enqueue:test -- --type refresh-dashboard-metrics --tenant demo-insurer
npm run queue:worker
npm run jobs:status
```

### 9.8 Local Queue vs Real Vercel Queue Testing

The product must distinguish local queue simulation from real queue integration testing.

| Test Type | Queue Target | Requirement |
|---|---|---|
| Unit tests | In-memory queue | Verify handler behavior without database or Vercel dependency. |
| Local integration tests | Local Supabase/Postgres queue adapter | Verify enqueue, process, retry, failure, idempotency, and job status behavior locally. |
| Preview/Staging integration tests | Real Vercel Queues | Verify SDK/configuration, queue credentials, deployment routing, retry behavior, and observability. |
| Optional local-to-cloud integration | Real Vercel Queue with poll mode | Allow a local worker to poll a real queue only when explicitly configured and safe. |

The default local workflow must never publish to real Vercel Queues unless an explicit environment flag is set.

### 9.9 Local Job Observability

Local cron and queue processing must be observable enough for development and debugging.

Requirements:

- Every local job run must write a job-run record.
- Every local job run must emit structured logs.
- Failed jobs must include error message, error class/name, stack trace where available, correlation ID, message type, tenant context where applicable, and attempt count.
- Developers must be able to inspect pending, processing, completed, failed, and dead-lettered local jobs.
- Developers must be able to safely reprocess failed idempotent jobs.

## 10. Deployment and Environment Requirements

### 10.1 Vercel Environments

The migrated app must support the following environment model:

| Environment | Purpose | Expected Platform |
|---|---|---|
| Local | Developer workstation with local Supabase Docker stack. | Local framework dev server, optional `vercel dev`, Supabase Docker. |
| Preview | Vercel preview deployments for branches/pull requests. | Vercel Preview plus non-production Supabase project/database. |
| Staging | Stable pre-production testing environment. | Vercel project/environment plus staging Supabase project/database. |
| Production | Live production environment. | Vercel Production plus production Supabase project/database. |

### 10.2 Supabase Environments

Each non-local environment should use an isolated Supabase project or database environment.

Requirements:

- Preview deployments must not write to Production data.
- Staging must not write to Production data.
- Production credentials must be available only to production deployment context.
- Environment variables must be configured separately per environment.
- Database migrations must be applied deliberately and consistently per environment.
- Seed data must not overwrite production data.
- Local development must use the local Supabase stack unless a developer explicitly opts into a remote development database.

### 10.3 Vercel Deployment Requirements

The Vercel deployment must support:

- TypeScript backend endpoints.
- Frontend deployment if the frontend is deployed in the same Vercel project.
- Environment-specific variables.
- Cron job registration through `vercel.json` or framework-supported Vercel configuration.
- Queue producer and consumer configuration where Vercel Queues are used.
- Build-time type checking.
- Automated tests before production promotion.
- Safe rollback strategy for app deployment.
- Explicit function runtime and region decisions where needed.
- No dependency on a persistent Node.js server process.

### 10.4 Repository Deployment Readiness Requirements

The repository must be structured so it can eventually be deployed to Vercel without redesigning the project layout.

Required repository deliverables:

| Deliverable | Requirement |
|---|---|
| `package.json` | Must include scripts for build, dev, typecheck, lint, test, Supabase local operations, local cron, local queue worker, and deployment validation. |
| `vercel.json` | Must define Vercel-specific configuration required by the app, including cron schedules where used. |
| `.env.example` | Must list every required variable with safe placeholder values. |
| `.env.local.example` | Recommended when local values differ from deployed values. |
| `.gitignore` | Must exclude local secrets, generated environment files, `.vercel`, logs, and transient local artifacts. |
| `supabase/config.toml` | Must exist for local Supabase development. |
| `supabase/migrations/` | Must contain source-controlled schema migrations. |
| `supabase/seed.sql` or seed script | Must provide repeatable local seed data. |
| `scripts/jobs/` | Must contain local cron and queue runner scripts. |
| `docs/deployment.md` | Must document Vercel setup, Supabase setup, environment variables, cron setup, queue setup, and production checklist. |
| `docs/local-development.md` | Must document how to start local Supabase, run the app, run jobs, reset the database, and troubleshoot common issues. |

Recommended repository shape:

```txt
/
  package.json
  vercel.json
  .env.example
  .env.local.example
  .gitignore
  README.md
  /src
    /app or /pages or /api
      /api
        /cron
          /generate-alerts
          /check-quote-expiry
          /check-sla-breaches
    /server
      /auth
      /db
      /tenancy
      /rbac
      /leads
      /quotes
      /reports
      /jobs
        /cron
        /queue
    /ui
  /scripts
    /jobs
      run-cron.ts
      run-all-crons.ts
      local-queue-worker.ts
      enqueue-test-message.ts
      job-status.ts
    /db
      seed.ts
      validate-migrations.ts
  /supabase
    config.toml
    seed.sql
    /migrations
  /docs
    local-development.md
    deployment.md
    background-jobs.md
    environment-variables.md
```

### 10.5 Vercel Configuration Requirements

The repository must include a Vercel configuration file or framework-native equivalent sufficient for deployment.

The Vercel configuration should include:

- Cron paths and schedules for production cron jobs.
- Function runtime configuration where needed.
- Region preferences where database latency requires it.
- Build command and output settings where not inferred by the framework.
- Redirects or rewrites only where required.

Example `vercel.json` shape for requirement clarity:

```json
{
  "crons": [
    {
      "path": "/api/cron/generate-alerts",
      "schedule": "*/15 * * * *"
    },
    {
      "path": "/api/cron/check-quote-expiry",
      "schedule": "0 * * * *"
    },
    {
      "path": "/api/cron/check-sla-breaches",
      "schedule": "*/30 * * * *"
    },
    {
      "path": "/api/cron/dispatch-scheduled-reports",
      "schedule": "0 5 * * *"
    }
  ]
}
```

The actual schedules must be confirmed during background job inventory. Cron schedules must be documented as UTC-based platform triggers. Tenant-local business times must be calculated inside the job logic using tenant configuration rather than assuming the cron trigger timezone matches tenant timezone.

### 10.6 Environment Variable Placeholder Requirements

The repository must include placeholder documentation for all required deployment values. Names below are recommended placeholders; implementation may refine names, but every required value must be documented.

| Variable | Scope | Required For | Description |
|---|---|---|---|
| `APP_ENV` | Server | All environments | `local`, `preview`, `staging`, or `production`. |
| `APP_BASE_URL` | Server | All environments | Canonical server-side app URL for callbacks and absolute links. |
| `NEXT_PUBLIC_APP_BASE_URL` | Browser-safe | Frontend | Public base URL when needed by client code. |
| `NEXT_PUBLIC_SUPABASE_URL` | Browser-safe if using Supabase client in browser | Frontend/local | Supabase project URL or local Supabase API URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Browser-safe if RLS/auth posture allows it | Frontend/local | Supabase anonymous key. Must not grant privileged access. |
| `SUPABASE_URL` | Server | Backend | Supabase project URL for server-side code. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server secret | Backend/jobs | Privileged Supabase key for server-side operations only. Never expose to browser. |
| `SUPABASE_DATABASE_URL` | Server secret | Migrations/server data access | Pooled database connection string or approved serverless-safe connection string. |
| `SUPABASE_DIRECT_DATABASE_URL` | Server secret / CI only | Migrations/admin | Direct database connection for migrations or administrative scripts where needed. |
| `AUTH_ISSUER_URL` | Server | Auth | OIDC issuer or equivalent identity provider URL if existing auth remains. |
| `AUTH_CLIENT_ID` | Server | Auth | Auth client identifier. |
| `AUTH_CLIENT_SECRET` | Server secret | Auth | Auth client secret. |
| `AUTH_JWKS_URL` | Server | Auth | JWKS endpoint if token verification requires it. |
| `SESSION_SECRET` | Server secret | Auth/session | Secret used to sign/encrypt sessions where applicable. |
| `CRON_SECRET` | Server secret | Cron endpoints | Shared secret or internal token for protecting cron endpoints from direct unauthorized calls. |
| `INTERNAL_JOB_SECRET` | Server secret | Job endpoints | Secret for internal job dispatch endpoints if separate from cron secret. |
| `QUEUE_PROVIDER` | Server | Jobs | `local-postgres`, `vercel-queues`, or approved provider value. |
| `VERCEL_QUEUE_REGION` | Server | Vercel Queues | Queue region placeholder, if required by selected queue implementation. |
| `VERCEL_QUEUE_TOKEN` | Server secret | Vercel Queues | Queue API token/credential placeholder, if required by selected queue implementation. |
| `ALERTS_QUEUE_NAME` | Server | Jobs | Queue name for alert-generation work where separate queues are used. |
| `EXPORTS_QUEUE_NAME` | Server | Jobs | Queue name for export-generation work. |
| `NOTIFICATIONS_QUEUE_NAME` | Server | Jobs | Queue name for notification-delivery work. |
| `LOG_LEVEL` | Server | Observability | Runtime log verbosity. |
| `ERROR_TRACKING_DSN` | Server/browser as appropriate | Observability | Placeholder for approved error tracking provider. |
| `VERCEL_PROJECT_ID` | CI secret | Deployment automation | Vercel project identifier for CI deployments, if used. |
| `VERCEL_ORG_ID` | CI secret | Deployment automation | Vercel organization/team identifier for CI deployments, if used. |
| `VERCEL_TOKEN` | CI secret | Deployment automation | Vercel deployment token for CI, if used. |

### 10.7 `.env.example` Requirements

The `.env.example` file must contain placeholders only. It should look like this in principle:

```bash
APP_ENV=local
APP_BASE_URL=http://localhost:3000
NEXT_PUBLIC_APP_BASE_URL=http://localhost:3000

NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=replace-with-local-anon-key
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SERVICE_ROLE_KEY=replace-with-local-service-role-key
SUPABASE_DATABASE_URL=postgresql://postgres:<local-db-password>@127.0.0.1:54322/postgres
SUPABASE_DIRECT_DATABASE_URL=postgresql://postgres:<local-db-password>@127.0.0.1:54322/postgres

AUTH_ISSUER_URL=https://identity.example.com/realms/quoteiq
AUTH_CLIENT_ID=quoteiq-local
AUTH_CLIENT_SECRET=replace-with-local-client-secret
AUTH_JWKS_URL=https://identity.example.com/realms/quoteiq/protocol/openid-connect/certs
SESSION_SECRET=replace-with-local-session-secret

CRON_SECRET=replace-with-local-cron-secret
INTERNAL_JOB_SECRET=replace-with-local-job-secret
QUEUE_PROVIDER=local-postgres
VERCEL_QUEUE_REGION=iad1
VERCEL_QUEUE_TOKEN=replace-only-when-using-real-vercel-queue
ALERTS_QUEUE_NAME=quoteiq-alerts
EXPORTS_QUEUE_NAME=quoteiq-exports
NOTIFICATIONS_QUEUE_NAME=quoteiq-notifications

LOG_LEVEL=debug
ERROR_TRACKING_DSN=
```

The project must document how to replace these values for Vercel Preview, Staging, and Production.

### 10.8 Vercel Deployment Checklist Requirements

The repository must include a deployment checklist covering:

- Link local repository to the correct Vercel project.
- Configure project framework/build settings.
- Configure environment variables for Preview, Staging, and Production.
- Configure Supabase project/database for each deployed environment.
- Apply migrations to the target Supabase environment.
- Confirm `vercel.json` cron schedules are deployed.
- Confirm cron endpoint secrets are configured.
- Confirm queue credentials and queue names are configured.
- Confirm server-only secrets are not exposed to browser bundles.
- Confirm Preview/Staging do not point to Production Supabase.
- Run deployment smoke tests.
- Run tenant isolation and RBAC checks.
- Run background job smoke tests.
- Confirm logs and error monitoring are operational.

## 11. Hangfire Replacement Requirements

### 11.1 Background Job Inventory

Before implementation, all existing Hangfire jobs must be inventoried.

For each job, document:

- Job name.
- Business purpose.
- Trigger type: scheduled, recurring, delayed, event-driven, manually triggered.
- Current frequency.
- Expected duration.
- Inputs and outputs.
- Idempotency requirements.
- Retry behavior.
- Failure behavior.
- Whether users can observe job status.
- Whether job results affect dashboards, alerts, reports, or notifications.
- Required local-development behavior.
- Target Vercel execution pattern.

### 11.2 Job Classification

Each existing Hangfire job must be mapped to a Vercel-compatible execution pattern.

| Job Type | Target Pattern | Local Development Pattern |
|---|---|---|
| Fixed recurring schedule | Vercel Cron Job calling a TypeScript function. | CLI script invokes the same handler manually. |
| Periodic data sweep | Vercel Cron Job that scans due records and creates work items. | CLI script invokes sweep against local Supabase. |
| Event-triggered async work | Vercel Queue message produced from the API request or domain event. | Local Supabase/Postgres queue adapter. |
| Expensive work after user action | Vercel Queue consumer so the user request returns quickly. | Local queue worker process. |
| Delayed follow-up work | Queue with delayed delivery if supported, or persisted job table processed by cron. | Local job table with due-at timestamp processed by local cron runner. |
| User-configured recurring schedules | Scheduler table plus Vercel Cron dispatcher that finds due schedules. | Local cron runner calls dispatcher manually. |
| Multi-step durable process | Vercel Queues and job state tables, or Vercel Workflows if approved. | Local job state tables plus local worker. |
| Long-running processing | Break into chunks, process through queue messages, and persist progress. | Local queue worker processes chunks from local queue table. |

### 11.3 Vercel Cron Requirements

Vercel Cron should be used for recurring scheduled work.

Requirements:

- Cron jobs must be registered in `vercel.json` or an approved framework/Vercel configuration mechanism.
- Cron endpoints must be server-side only and protected from unauthorized external invocation.
- Cron endpoints must use `CRON_SECRET`, platform-provided cron context, or an approved equivalent protection method.
- Cron jobs must be idempotent.
- Cron jobs must record job run status, start time, end time, duration, success/failure, and error details.
- Cron jobs must not rely on in-memory state.
- Cron jobs that process many records must operate in batches.
- Cron jobs should enqueue granular work items rather than doing large processing inline when volume is high.
- Cron schedules must be documented in the repository.
- Cron schedules should be treated as UTC platform triggers.
- Timezone-sensitive business schedules must be resolved explicitly from tenant settings and due-record tables.
- Preview deployments must not assume cron jobs will run automatically; preview validation should use manual endpoint invocation or job scripts.
- Cron failures must be visible in logs and job-run tables; application-level retry/compensation must be implemented where the platform does not retry automatically.

### 11.4 Local Cron Development Requirements

Local cron development must use manual or scripted invocation of the same cron handlers used in production.

Required design:

```txt
Vercel Cron in production
  -> HTTP GET/POST /api/cron/{job-name}
  -> validates cron authorization
  -> calls shared TypeScript job handler
  -> records job run

Local development
  -> npm run cron:run {job-name}
  -> calls shared TypeScript job handler directly
  -> records job run in local Supabase
```

Local cron acceptance criteria:

- A developer can run each cron job locally without Vercel.
- Local cron runs use local Supabase by default.
- Local cron runs produce the same business side effects as production, subject to local seed data.
- Local cron runs are visible in job history tables.
- Re-running a local cron job does not duplicate alerts/reminders/exports if the job is intended to be idempotent.
- The repository documents that Vercel Cron itself is not fully locally emulated.

### 11.5 Vercel Queue Requirements

Vercel Queues or equivalent Vercel-compatible queueing must be used for durable asynchronous work where immediate completion is not required.

Requirements:

- Queue messages must include a message type, tenant context where applicable, correlation ID, idempotency key, and minimal payload.
- Queue consumers must validate system authorization before executing work.
- Queue consumers must enforce tenant context for tenant-scoped work.
- Queue consumers must be idempotent to tolerate retries and duplicate delivery.
- Queue consumers must write job status and failure details to application tables where business visibility is required.
- Queue processing must support retries for transient failures.
- The app must provide an application-level dead-letter or failed-job table if the selected queue option does not provide sufficient dead-letter handling.
- Queue processing must not mix tenant data in a single job unless explicitly designed for Internal/global processing.
- Queue usage must be abstracted behind application interfaces so production and local implementations can differ without changing domain handlers.

### 11.6 Local Queue Development Requirements

Local queue development must use a local adapter by default. The preferred local adapter is a Supabase/Postgres-backed queue table because it gives deterministic local behavior and mirrors durable state transitions.

Required design:

```txt
Production / Preview / Staging
  API/domain event -> QueuePublisher -> Vercel Queue -> QueueConsumer -> JobHandler

Local development
  API/domain event -> QueuePublisher -> local Supabase job_queue table
  npm run queue:worker -> LocalPostgresQueueConsumer -> JobHandler
```

Local queue acceptance criteria:

- A developer can enqueue a job locally without Vercel.
- A developer can run a local worker that processes jobs from local Supabase.
- Local queue processing records attempts, status, errors, and completion.
- Failed local jobs can be inspected.
- Safe failed jobs can be reprocessed.
- Local queue processing supports idempotency keys.
- Local queue defaults must not send messages to real Vercel Queues.
- Real Vercel Queue testing must require explicit environment configuration.

### 11.7 Optional Local-to-Vercel Queue Poll Mode

The product may support an optional integration mode where a local worker polls a real Vercel Queue. This is not the default local workflow.

Requirements if enabled:

- Must require explicit `QUEUE_PROVIDER=vercel-queues` or equivalent.
- Must require non-production queue credentials.
- Must never point at production queues from a developer workstation unless explicitly authorized.
- Must clearly log that the worker is connected to a real Vercel Queue.
- Must be documented as integration testing, not normal local simulation.

### 11.8 Required Job Categories for QuoteIQ

The migrated system must support background processing for the following business categories where enabled:

| Category | Purpose | Target Pattern | Local Pattern |
|---|---|---|---|
| Alert generation | Identify unassigned leads, overdue follow-ups, stalled leads/quotes, expiring quotes, SLA breaches, and high-value at-risk opportunities. | Vercel Cron dispatcher plus batched processing. | `cron:run generate-alerts` against local Supabase. |
| Follow-up reminders | Detect due and overdue follow-ups. | Vercel Cron schedule plus alert/reminder job. | `cron:run follow-up-reminders`. |
| Quote expiry checks | Detect quotes expiring soon or expired. | Vercel Cron schedule. | `cron:run check-quote-expiry`. |
| SLA breach checks | Detect lead/quote/underwriting SLA breaches. | Vercel Cron schedule. | `cron:run check-sla-breaches`. |
| Scheduled reports | Generate or send reports if enabled. | Vercel Cron schedule plus queue for report generation. | Cron runner enqueues report jobs into local queue. |
| Export generation | Create large CSV/PDF exports without blocking user requests. | Vercel Queue. | Local queue adapter and local worker. |
| Dashboard aggregation | Refresh materialized or cached dashboard metrics if implemented. | Vercel Cron or Queue. | Cron runner or local queue worker. |
| Audit processing | Persist or enrich audit records if asynchronous. | Vercel Queue. | Local queue adapter and local worker. |
| Notification delivery | Send email or other notifications if enabled. | Vercel Queue with retry/failure tracking. | Local queue adapter; external delivery can be stubbed or sent to a local/sandbox provider. |

### 11.9 Job Status and Operations Visibility

The product should include operational visibility for background processing.

Requirements:

- Administrators should be able to see recent job runs where relevant.
- Failed jobs should be inspectable by authorized users.
- Jobs should include correlation IDs for debugging.
- Job failures that affect business users should produce visible admin alerts or operational logs.
- Reprocessing should be possible for safe, idempotent failed jobs.
- Local and deployed job runs should use the same status vocabulary.
- Job run records should identify environment: local, preview, staging, production.

### 11.10 Background Job Documentation Requirements

The repository must include `docs/background-jobs.md` or equivalent with:

- All cron job names.
- All cron endpoint paths.
- All cron schedules.
- Whether each cron is production-only, staging-enabled, or manually invoked.
- Queue names and message types.
- Local job commands.
- Job idempotency expectations.
- Failure/retry behavior.
- How to inspect local job state.
- How to manually run a cron job in Local, Preview, and Staging.
- How to verify a real Vercel Queue integration safely.

## 12. Data Migration Requirements

### 12.1 Migration Planning

The modernization must include a formal database migration plan from the existing Postgres database to Supabase Postgres.

Requirements:

- Inventory all existing tables, columns, indexes, constraints, views, functions, triggers, and migration files.
- Identify all .NET/EF-specific assumptions that must be converted to SQL or TypeScript-compatible migrations.
- Identify data cleanup required before migration.
- Identify records requiring tenant assignment or tenant normalization.
- Identify how soft-deleted tenants and records will be represented.
- Identify historical Hangfire state that must be retained, archived, or discarded.

### 12.2 Migration Execution

The migration must support:

- Dry-run migration into a non-production Supabase environment.
- Row count validation.
- Referential integrity validation.
- Tenant isolation validation.
- Dashboard metric comparison between old and new systems where old data is available.
- Audit history preservation where required.
- Rollback or restore plan.
- Production cutover checklist.

### 12.3 Data Compatibility

The migrated data must preserve:

- Tenant records.
- Users and tenant memberships.
- Roles, permissions, user groups, and assignments.
- Tenant-specific configurable lists.
- Brokers and broker contacts.
- Relationship managers and assignments.
- Leads and lead lifecycle history.
- Quotes and quote lifecycle history.
- Follow-ups and notes.
- Alerts and escalations.
- Reports/export history if required.
- Audit events.

---

## 13. Tenant Manager Requirements After Migration

The Tenant Manager must remain permission-bound and available only to authorized Internal users or equivalent global administrators.

Requirements:

- Add tenant.
- View tenant list.
- View tenant details.
- Edit tenant.
- Soft-delete tenant.
- Reactivate or restore a soft-deleted tenant if approved.
- The only required tenant field for the MVP is tenant name.
- Soft-deleted tenants must not be available for normal tenant switching or new records.
- Historical data for soft-deleted tenants must remain preserved and auditable.
- Internal users with permission must be able to view soft-deleted tenants for administrative purposes.

---

## 14. User Manager Requirements After Migration

The User Manager must remain permission-bound and support tenant-scoped access management.

### 14.1 User Group Management

Authorized users must be able to:

- Add user groups.
- View user groups.
- Edit user groups.
- Remove or disable user groups where permitted.
- Give each group a name.
- Assign roles to a group.
- Assign permissions to a group if direct group permissions are supported.
- Add users as group members.
- Remove users from group membership.
- View effective access granted by group membership.

### 14.2 Role Management

Authorized users must be able to:

- Add roles.
- View roles.
- Edit roles.
- Remove or disable roles where permitted.
- Give each role a name.
- Assign permissions to a role.
- View which users and groups currently inherit a role.
- Prevent unsafe deletion of roles that are actively assigned unless explicitly confirmed or disabled instead.

### 14.3 User Management

Authorized users must be able to:

- Add users.
- View users.
- Edit users.
- Disable users.
- Capture first name.
- Capture last name.
- Capture email.
- Assign users to one or more tenants.
- Assign roles directly to users.
- Assign permissions directly to users.
- Add users to user groups.
- Remove users from user groups.
- View a user’s effective permissions.
- Preserve audit history when users are disabled or removed from a tenant.

---

## 15. Dashboard and Reporting Preservation Requirements

The TypeScript/Supabase migration must preserve the dashboard and reporting requirements from the existing QuoteIQ PRD.

Required dashboard areas:

- Overview.
- Pipeline.
- Brokers.
- RM Performance.
- Loss Analysis.
- Alerts.
- Reports.
- Tenant Manager.
- User Manager.

Required visualization categories:

- KPI cards.
- Horizontal bar charts.
- Funnel or tapered stage conversion charts.
- Donut charts.
- Stacked column charts.
- Line charts.
- Heatmap tables.
- Scatter plot quadrant chart for broker performance.
- Action panels.
- High-value opportunity tables.
- At-risk pipeline tables.
- Leadership insight panels.

Dashboard requirements after migration:

- Dashboard filters must continue to use tenant-specific reference data.
- Dashboard data must be scoped to the active tenant unless explicitly in Internal cross-tenant mode.
- Drill-through from chart to underlying Leads or Quotes must continue to work.
- Export behavior must continue to reflect active filters.
- Metrics must retain the same definitions unless changed through product approval.

---

## 16. Security and Access Requirements

### 16.1 Secret Management

- Supabase service-role keys must never be exposed to client-side code.
- Vercel environment variables must be scoped by environment.
- Local development must use local Supabase secrets only.
- Production secrets must not be committed to source control.
- Admin and job endpoints must be protected.

### 16.2 Authentication and Authorization

- The migration must preserve the approved authentication flow unless a separate decision changes it.
- The migration must preserve RBAC and tenant membership rules.
- Permission checks must be enforced on the server side.
- Internal/global permissions must be restricted and auditable.
- Tenant switching must not allow users to access unauthorized tenants.

### 16.3 Audit Requirements

Audit logs must capture:

- Tenant creation, update, soft delete, and reactivation.
- User creation, update, disablement, tenant assignment, and role/permission/group changes.
- Lead and Quote creation and lifecycle changes.
- High-value or closed-record changes.
- Report exports where required.
- Background job failures that affect business outcomes.
- Internal cross-tenant access where required.

---

## 17. Observability and Operational Requirements

The migrated platform must provide enough observability to support production operation.

Requirements:

- Structured backend logs.
- Correlation IDs for user requests and background jobs.
- Error tracking for API endpoints and jobs.
- Job run history and failure records.
- Database migration logs.
- Performance metrics for key endpoints and dashboard queries.
- Visibility into queue backlog, message age, and failures where queues are used.
- Alerts for recurring job failures or critical background processes not running.

---

## 18. Performance and Reliability Requirements

### 18.1 API Performance

- Common dashboard loads should return within an agreed target under expected pilot data volumes.
- Lead and Quote create/update operations should complete quickly and not wait for expensive derived processing.
- Expensive exports and report generation should use asynchronous processing where needed.
- Indexes must support common filters: tenant, date range, product line, cover type, broker, RM, region, status, aging bucket, SLA status, and lost reason.

### 18.2 Serverless Reliability

- Backend functions must tolerate cold starts.
- Long-running work must be chunked or queued.
- Background processing must be idempotent.
- Retries must not create duplicate alerts, exports, notifications, or audit events.
- Job progress must be persisted for any multi-step process.

### 18.3 Database Reliability

- Use connection patterns appropriate for Vercel and Supabase.
- Prevent connection exhaustion.
- Keep migrations reversible or recoverable where practical.
- Backups and restore procedures must be documented for production.
- Production cutover must include a rollback strategy.

---

## 19. Testing Requirements

### 19.1 Automated Tests

The migration must include automated tests for:

- API request validation.
- Tenant context enforcement.
- RBAC effective permission calculation.
- User Manager actions.
- Tenant Manager actions.
- Lead creation and lifecycle transitions.
- Quote creation and lifecycle transitions.
- Dashboard metrics.
- Alert generation.
- Background job idempotency.
- Data migration validation.
- Export generation.

### 19.2 Integration Tests

Integration tests should run against local Supabase or an isolated test Supabase environment.

Required integration test areas:

- Database migrations apply cleanly.
- Seed data loads successfully.
- API endpoints can read/write Supabase data.
- Tenant isolation is enforced.
- Jobs can generate alerts and update job status.
- Exports can be generated from realistic data.

### 19.3 Manual QA Requirements

Manual QA must verify:

- Existing user journeys still work.
- Tenant switching works for multi-tenant and Internal users.
- Tenant Manager works as specified.
- User Manager works as specified.
- Dashboards match expected sample data.
- Alerts are generated correctly.
- Background jobs run in local/staging/prod-like environments.
- No user can see another tenant’s data unless explicitly authorized.

---

## 20. Acceptance Criteria

### 20.1 Platform Migration Acceptance

- The backend is implemented in TypeScript.
- The backend can be deployed to Vercel.
- Supabase Postgres is used as the operational database.
- Local development can run Supabase in Docker.
- Developers can start the app locally from documented commands.
- Environment variables are documented and separated by environment.
- CI validates typecheck, tests, and migrations.

### 20.2 Product Behavior Acceptance

- Existing QuoteIQ core user journeys continue to work.
- Leads and Quotes remain separate entities.
- Tenant Manager is available only to authorized users.
- Tenant deletion is implemented as soft delete.
- User Manager supports users, groups, roles, permissions, role assignment, permission assignment, and group membership.
- Tenant-specific configurable lists continue to work.
- Brokers, RMs, Leads, and Quotes remain tenant-scoped.
- Dashboards and reports remain functional.
- Exports remain functional.

### 20.3 Background Job Acceptance

- All Hangfire jobs have been inventoried and mapped to Vercel-compatible patterns.
- Scheduled jobs run through Vercel Cron or approved equivalent.
- Async jobs run through Vercel Queues or approved equivalent.
- Job failures are recorded.
- Jobs are idempotent.
- Alert generation works without Hangfire.
- Scheduled reporting/export jobs work without Hangfire where enabled.
- No runtime dependency on Hangfire remains.

### 20.4 Data Migration Acceptance

- Existing schema concepts are represented in Supabase.
- Required historical data migrates successfully.
- Data validation passes after migration.
- Tenant isolation is validated after migration.
- Dashboard totals reconcile against migrated data within agreed tolerance.
- Rollback or restore path is documented.

---

## 21. Rollout Plan

### Phase 1 - Discovery and Inventory

- Inventory current .NET backend endpoints.
- Inventory current database schema and migrations.
- Inventory Hangfire jobs.
- Identify frontend API dependencies.
- Confirm current authentication and authorization implementation.
- Confirm Supabase services to be used beyond Postgres, if any.

### Phase 2 - Foundation

- Set up TypeScript backend structure.
- Set up local Supabase Docker workflow.
- Define environment variables.
- Define database migration workflow.
- Establish connection strategy for Vercel and Supabase.
- Implement authentication/session integration.
- Implement tenant context and RBAC foundations.

### Phase 3 - Core Domain Migration

- Migrate Tenant Manager.
- Migrate User Manager.
- Migrate tenant reference data.
- Migrate Leads.
- Migrate Quotes.
- Migrate brokers and RMs.
- Migrate follow-ups, alerts, reports, and audit history.

### Phase 4 - Dashboard and Reporting Migration

- Recreate dashboard queries on Supabase.
- Validate KPI definitions.
- Validate filters.
- Validate drilldowns.
- Validate exports.
- Compare output to prior implementation or approved sample data.

### Phase 5 - Background Job Migration

- Replace Hangfire recurring jobs with Vercel Cron patterns.
- Replace background processing with Vercel Queues or approved equivalent.
- Add job run history and failure tables.
- Add local job simulation.
- Test idempotency and retry behavior.

### Phase 6 - Data Migration and Cutover

- Dry-run migration.
- Validate data and metrics.
- Run staging cutover rehearsal.
- Resolve data quality issues.
- Finalize production cutover checklist.
- Execute production cutover.
- Monitor API, database, and job behavior.

---

## 22. Open Questions

### 22.1 Platform Questions

- Will the frontend remain in the same framework and repository?
- Will the TypeScript backend use framework-native route handlers, plain Vercel Functions, or another Vercel-compatible API layer?
- Which TypeScript database access library will be used?
- Will Supabase Auth be used, or will the existing identity provider remain?
- Will Supabase Storage be used for quote documents and attachments?
- Will Vercel Queues be used directly, or will Vercel Workflows be considered for multi-step processes?

### 22.2 Database Questions

- How much existing production data must be migrated?
- Are there existing EF migrations that need to be converted, or should the target schema be recreated from the approved domain model?
- Are there database views/functions/triggers that must be preserved?
- Should Supabase Row-Level Security be mandatory for tenant isolation or used selectively?
- What is the expected production data volume during the first 12 months?

### 22.3 Background Job Questions

- Which Hangfire jobs exist today?
- Which jobs are business-critical?
- Which jobs need near-real-time execution versus scheduled batch execution?
- Which jobs are safe to retry?
- Which jobs require user-visible status?
- What job history must be retained after the migration?

### 22.4 Deployment Questions

- How many Supabase projects will be used: one per environment or shared projects with schemas/branches?
- What deployment approval process is required for Production?
- What backup and restore expectations exist for Production?
- What observability tooling should be used for runtime errors and job failures?

---

## 23. Appendix A - Required Background Job Mapping Template

| Existing Hangfire Job | Business Purpose | Current Trigger | Target Pattern | Frequency | Idempotency Key | Failure Handling | User Visibility |
|---|---|---|---|---|---|---|---|
| TBD | TBD | Recurring / delayed / manual / event | Vercel Cron / Queue / Workflow / Manual function | TBD | TBD | Retry / failed-job table / alert | Admin / hidden / user-facing |

---

## 24. Appendix B - Minimum Local Development Deliverables

The repository must include or document:

- Node/TypeScript version requirements.
- Package manager requirement.
- Supabase CLI setup.
- Docker requirement.
- Local Supabase start/stop/reset commands.
- Local migration commands.
- Local seed command.
- Local backend start command.
- Local frontend start command.
- Local test command.
- Local job trigger commands.
- Local cron runner scripts.
- Local queue worker scripts.
- Environment variable documentation.
- Vercel deployment placeholder documentation.
- `vercel.json` with cron schedule placeholders.
- Troubleshooting guide for local database and job execution.

---

## 25. Appendix C - Vercel Deployment Placeholder Checklist

The repository must include placeholders and documentation for eventual Vercel deployment even if actual production values are not available during development.

### C.1 Required Placeholder Files

| File | Required Content |
|---|---|
| `.env.example` | Placeholder values for local, preview, staging, and production variables. |
| `.env.local.example` | Local Supabase and local job values. |
| `vercel.json` | Cron path/schedule placeholders and Vercel configuration. |
| `docs/environment-variables.md` | Full environment variable catalog, scope, sensitivity, and where configured. |
| `docs/deployment.md` | Vercel project setup, Supabase setup, migration flow, job setup, and smoke tests. |
| `docs/background-jobs.md` | Cron and queue implementation details, including local simulation. |
| `docs/local-development.md` | Step-by-step local setup with Supabase Docker, app start, cron runs, and queue worker runs. |

### C.2 Deployment Values That Must Be Supplied Later

The implementation must not hard-code these values. They must remain configurable placeholders until the deployment environment is created.

| Category | Placeholder Values Needed |
|---|---|
| Vercel project | Project name, team/org, project ID, build settings, production domain, preview domain behavior. |
| Supabase | Project URL, anon key, service role key, database connection string, direct database URL, pooler configuration. |
| Auth | Issuer URL, client ID, client secret, callback URLs, logout URLs, JWKS URL, allowed audience/claims. |
| Jobs | Cron secret, internal job secret, queue provider, queue region, queue credentials, queue names. |
| Observability | Log level, error tracking DSN, alert routing, operational contact or channel. |
| Email/notifications | Provider credentials and sandbox routing if notification delivery is enabled. |
| App URLs | Local, Preview, Staging, and Production base URLs. |

### C.3 Deployment Readiness Acceptance Criteria

- A new developer can copy `.env.local.example` to `.env.local`, start Supabase locally, run migrations/seeds, and run the app.
- A deployment engineer can configure Vercel environment variables using `docs/environment-variables.md` without reading source code.
- The Vercel project can build without missing undocumented environment variables.
- Preview/Staging/Production environment variables are separated.
- Production secrets are not present in the repository.
- `vercel.json` includes the intended cron endpoints, even if schedules are initially conservative placeholders.
- Cron endpoints are protected and can be manually smoke-tested after deployment.
- Queue configuration can be disabled, local, or Vercel-backed by environment setting.
- Local queue testing does not require a Vercel account.
- Real Vercel Queue testing requires explicit non-local configuration.

## 26. Appendix D - Migration Definition of Done

The migration is complete when:

- No .NET backend runtime is required for normal application operation.
- No Hangfire runtime is required for normal background processing.
- The TypeScript backend is deployed and operational on Vercel.
- Supabase Postgres is the source of truth for operational data.
- Local development works using Supabase in Docker.
- All approved QuoteIQ product capabilities still work.
- All required background jobs have Vercel-compatible replacements.
- Tenant isolation and RBAC are validated.
- Data migration is validated.
- Documentation is sufficient for a new developer to run the app locally.
