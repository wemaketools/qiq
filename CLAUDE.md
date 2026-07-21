# Project Context

This is a Vercel-deployable TypeScript / React / Supabase PostgreSQL SaaS application.

The product is QuoteIQ: a multi-tenant insurance Leads and Quotation Intelligence Platform. The application manages insurance Leads from intake through Quote creation, follow-up, outcome tracking, alerts, reporting, tenant administration, and user/RBAC administration.

## Migration Context

This application is being converted from a previous .NET backend / PostgreSQL / Hangfire implementation to a TypeScript backend that can run on Vercel, using Supabase PostgreSQL as the database platform.

Do not preserve .NET-specific architecture by inertia. Preserve the business behavior, domain model, API contracts where practical, tenant isolation, RBAC behavior, dashboards, alerts, reports, and auditability.

## Architecture

- Backend: TypeScript running on Vercel-compatible serverless functions or a Vercel-supported TypeScript server layer.
- Frontend: React + TypeScript; Redux for state management unless an approved migration changes this.
- Database: Supabase PostgreSQL.
- Local database/dev platform: Supabase local development stack running through Docker and the Supabase CLI.
- Auth: Existing OIDC/Keycloak integration unless a separate decision approves Supabase Auth or another provider.
- Background jobs: Replace Hangfire with Vercel-compatible scheduled and asynchronous execution patterns, primarily Vercel Cron Jobs and Vercel Queues or an explicitly approved Vercel-compatible alternative.
- Logging: Structured server-side logging suitable for Vercel runtime logs; never log sensitive data.
- Runtime: Node.js runtime on Vercel unless a task explicitly requires and approves another Vercel runtime.

## Product Domain Expectations

Use the QuoteIQ terminology consistently:

- `Lead` means the initial quote request, intake record, or sales opportunity.
- `Quote` means the formal quotation/proposal provided to the requester.
- A Lead exists before a Quote exists.
- Every Quote must be associated with exactly one Lead.
- A Lead may have zero, one, or multiple Quotes if tenant policy allows revisions/options/re-quotes.
- Do not use `Quote Request` as the primary entity name. Use `Lead`.
- Dashboard labels must distinguish Leads, Quotes, Quoted Premium, Bound Premium, Lead-to-Quote Rate, and Quote-to-Win Rate.

Core tenant-scoped domains include:

- Leads.
- Quotes.
- Clients/prospects.
- Brokers and broker contacts.
- Relationship Managers.
- Sales teams and regions.
- Tenant-configurable reference data.
- Follow-ups and notes.
- Alerts and escalations.
- Reports and exports.
- Audit events.

Global/Internal domains include:

- Tenants.
- Global default templates.
- Internal/global permissions.
- Cross-tenant oversight where explicitly authorized.

## Multi-Tenancy Requirements

- The application is multi-tenant by design.
- Every tenant-scoped record must belong to exactly one tenant.
- Normal users must be assigned to at least one tenant.
- Users may be assigned to multiple tenants.
- Users with access to more than one tenant must be able to switch active tenant context.
- Internal users with the correct permissions can view any tenant.
- Tenant-scoped APIs must never return data from another tenant unless the endpoint is explicitly cross-tenant and permission-bound to Internal/global users.
- Tenant context must be enforced server-side on every tenant-scoped operation.
- Do not rely on the frontend tenant selector for authorization.
- Audit privileged actions and important tenant-scoped business changes.

## Admin Sections

The left navigation must include the main product areas plus permission-bound admin sections:

- Overview.
- Pipeline.
- Brokers.
- RM Performance.
- Loss Analysis.
- Alerts.
- Reports.
- Tenant Manager.
- User Manager.

### Tenant Manager

Tenant Manager is permission-bound and is used to add, view, edit, and remove tenants.

MVP tenant requirements:

- Tenant name is the only required tenant profile field for now.
- Tenant deletion must be soft deletion.
- Soft-deleted tenants must not appear as active tenant choices for normal workflows.
- Historical tenant data must remain available to authorized Internal users unless a separate data-retention requirement says otherwise.
- Tenant create, edit, soft delete, restore/reactivate, and view actions must be permission-bound and auditable.

### User Manager

User Manager is permission-bound and must support user, role, permission, and group administration.

User group requirements:

- Add, view, edit, and disable/delete user groups.
- User groups must have a name.
- User groups can have roles assigned.
- User groups can have permissions assigned directly.
- Users can be made members of user groups.
- Group membership and group permission changes must be auditable.

Role requirements:

- Add, view, edit, and disable/delete roles.
- Roles are named collections of permissions.
- Roles can be assigned to users directly.
- Roles can be assigned to user groups.
- Role permission changes must be auditable.

User requirements:

- Add, view, edit, activate, and deactivate users.
- User creation must collect first name, last name, and email.
- Users can be assigned to one or more tenants.
- Users can be assigned roles directly.
- Users can be assigned permissions directly.
- Users can be added to user groups.
- Users may have different roles, permissions, and group memberships per tenant.
- User activation/deactivation and access changes must be auditable.

## Tenant-Configurable Reference Data

The following lists must be configurable by tenant:

- Request Channels.
- Product Lines.
- Cover Types.
- Segments.
- Industries.
- Regions.
- Client Types.
- Lead Statuses, with guarded defaults.
- Quote Statuses, with guarded defaults.
- Lost Reasons.
- Broker Types / Tiers.
- SLA targets.
- High-value thresholds.
- Follow-up rules.

Rules:

- Use structured values for anything used in dashboards, filters, reporting, or business rules.
- Some lists should have sensible defaults for new tenants.
- Tenant-specific values must not leak across tenants.
- Disabled reference values must remain displayable for historical records.
- Do not use free text for core report dimensions unless explicitly approved.

## Backend Conventions

- Use TypeScript in strict mode.
- Avoid `any`; use explicit domain, request, response, and persistence types.
- Keep feature code close together: route handlers, schemas, services, repositories/data access, tests, and background job handlers.
- Prefer explicit, boring code over clever generic frameworks.
- Do not add abstractions unless there are at least two real implementations or a clear test seam.
- Validate inputs at system boundaries.
- Use a schema validation library already approved for the project. If none exists, propose one before adding it.
- Use consistent Result/Error or typed error patterns for expected business failures.
- Use async APIs all the way down.
- Do not use process-wide mutable state for business behavior.
- Do not rely on in-memory cache for correctness in Vercel/serverless execution.
- Do not assume function instances are long-lived.
- Handlers must be idempotent where retries or duplicate invocations are possible.
- Use structured logging; never log access tokens, refresh tokens, passwords, full authorization headers, personally sensitive data, or confidential insurance data.
- Use environment variables only through a typed/configured server-side configuration module.
- Keep server-only code out of client bundles.

## API Conventions

- API endpoints must be deployable on Vercel.
- Prefer Vercel-compatible route handlers/functions over long-running server processes.
- Preserve existing frontend API contracts where practical.
- Do not rename request/response fields unless required for approved terminology or compatibility cleanup.
- Use consistent API response and error shapes.
- Implement pagination, sorting, and filtering server-side for list endpoints.
- Enforce authorization in every protected endpoint.
- Enforce tenant context in every tenant-scoped endpoint.
- Cross-tenant endpoints must be explicit, Internal/global permission-bound, and auditable.
- Never trust tenant IDs, user IDs, role IDs, or permission claims supplied by the browser without server-side verification.

## Data Access and Supabase Conventions

- Supabase PostgreSQL is the system of record.
- Use SQL migrations compatible with Supabase local development and hosted Supabase environments.
- Do not use EF Core or EF Core migrations.
- Do not use Liquibase unless the migration plan explicitly retains it for Supabase-compatible SQL migrations.
- Prefer plain SQL migrations or an approved TypeScript migration tool.
- Schema changes must be repeatable locally and in CI.
- Local development must use Supabase CLI with Docker.
- Include seed data for local development where helpful, especially tenants, users, roles, permissions, reference data, sample leads, sample quotes, alerts, and dashboard data.
- Do not use JSONB for queryable core business fields unless approved.
- Use relational tables and constraints for core tenant, Lead, Quote, RBAC, broker, RM, reference data, follow-up, alert, and audit entities.
- Preserve referential integrity wherever practical.
- Use indexes for tenant-scoped access patterns, dashboard filters, status queries, date range filters, SLA/alert scans, and RBAC lookups.
- Treat Supabase Row Level Security as an optional additional guard unless a task explicitly adopts it. Server-side authorization checks are still required.
- Use service-role credentials only in server-side code and never expose them to the frontend.
- Browser/client code must use only safe public Supabase keys if direct Supabase client access is approved.
- Avoid N+1 query patterns in dashboards and reports.

## Local Development Requirements

Local development must be reproducible from a clean checkout without requiring a managed cloud database.

Required local development capabilities:

- Supabase stack runs locally through Docker and the Supabase CLI.
- Local database migrations can be applied from the repository.
- Local seed data can be loaded from the repository.
- Frontend and backend can run against the local Supabase stack.
- Environment variables are documented with a safe example file.
- Secrets are never committed.
- Local-only secrets must be clearly marked as local development values.
- Local setup instructions must include all required commands.

Expected local artifacts may include:

- `supabase/config.toml`.
- `supabase/migrations/`.
- `supabase/seed.sql` or equivalent seed scripts.
- `.env.example`.
- package scripts for starting local development, applying migrations, resetting local data, running tests, and typechecking.

## Background Jobs and Hangfire Replacement

Hangfire must not be used in the TypeScript/Vercel target architecture.

Replace Hangfire jobs with Vercel-compatible patterns:

- Use Vercel Cron Jobs for scheduled triggers.
- Use Vercel Queues or an explicitly approved Vercel-compatible queue for asynchronous work that should not block user requests.
- Use cron-triggered queue polling where appropriate.
- Break long-running work into small idempotent units.
- Use durable database state for job progress, locks, deduplication, retry tracking, and auditability where needed.
- Do not rely on a permanently running worker process.
- Do not rely on in-memory schedules.
- Do not assume a job runs exactly once.
- Every job handler must tolerate retries and duplicate delivery.
- Every recurring job must define its schedule, purpose, idempotency key strategy, failure behavior, and observability expectations.

Typical QuoteIQ background jobs include:

- Generate overdue follow-up alerts.
- Generate stalled Lead alerts.
- Generate stalled Quote alerts.
- Generate expiring Quote alerts.
- Generate SLA breach alerts.
- Recompute or refresh dashboard aggregates if the implementation uses aggregate tables.
- Send or prepare scheduled reports if scheduled reporting is approved.
- Process exports if exports are asynchronous.
- Clean up expired transient data.

For every Hangfire job migrated, document:

- Existing job name and purpose.
- New Vercel Cron schedule or queue trigger.
- Input payload shape, if queued.
- Idempotency key.
- Retry behavior.
- Failure handling.
- Required database state.
- Observability/logging expectations.

## Frontend Conventions

- Use functional React components.
- Use TypeScript strict typing.
- Avoid `any`; use explicit domain and API types.
- API calls should go through the existing API client layer or an approved replacement.
- Do not call privileged Supabase operations directly from the browser.
- Treat the UI as hostile; do not rely on client-side checks for authorization.
- Do not duplicate backend validation rules unless needed for UX.
- Tenant context must be visible to users who can access multiple tenants.
- Tenant switching must clear or refresh tenant-scoped data to prevent cross-tenant confusion.
- Permission-bound navigation items must be hidden or disabled based on effective permissions, but backend authorization must still be enforced.

## Dashboard and Reporting Expectations

Preserve the approved dashboard areas:

- Executive Overview.
- Pipeline and Conversion.
- Broker Performance.
- RM Performance.
- Loss Analysis.
- SLA and Turnaround.
- Alerts Center.
- Reports.

Visualizations must support tenant-scoped filters and drill-through:

- Date range.
- Product line.
- Cover type.
- Broker.
- RM/team.
- Broker type.
- Region.
- Client type.
- Segment.
- Industry.
- Lead status.
- Quote status.
- Aging bucket.
- SLA status.
- Lost reason.

Dashboard and report queries must be tenant-safe, performant, and clear about whether they count Leads, Quotes, or Premium.

## Testing

Before claiming a task is complete:

- Run backend tests.
- Run frontend typecheck if frontend changed.
- Run backend typecheck if backend changed.
- Run linting if configured.
- Run migration validation if schema changed.
- Run relevant integration tests against local Supabase when database behavior changed.
- Add or update tests for bug fixes and business logic changes.
- If tests cannot be run, state exactly why.

Testing expectations:

- Follow the testing pyramid: unit → integration → E2E.
- Use deterministic, isolated, order-independent, CI-safe tests.
- Every requirement must have at least one test with clear pass/fail criteria.
- Use the project-approved TypeScript test framework. Do not introduce an alternative without approval.
- Test names should clearly describe behavior, condition, and expected outcome.
- Use AAA pattern where it improves readability.
- Integration tests must verify tenant isolation and permission enforcement for sensitive flows.
- Migration tests must verify schema can be applied from a clean local Supabase database.
- Background job tests must verify idempotency and retry-safe behavior.

Critical tests for this migration:

- Tenant Manager create/edit/soft-delete behavior.
- User Manager user/group/role/permission assignment behavior.
- Effective permission calculation.
- Tenant switching and tenant isolation.
- Lead creation and Quote association.
- Lead-to-Quote and Quote-to-Win metrics.
- Dashboard filter correctness.
- Alert job idempotency.
- Cron/queue handler retry behavior.
- Supabase migration and seed reset.

## Project Structure

Prefer a structure that supports a Vercel-deployable TypeScript backend, React frontend, Supabase local development, and existing feature documentation.

```
/src/
  api/
    routes-or-functions/
    domains/
      tenants/
      users/
      rbac/
      leads/
      quotes/
      brokers/
      reference-data/
      dashboards/
      alerts/
      reports/
      audit/
    jobs/
    lib/
      config/
      db/
      auth/
      validation/
      errors/
      logging/
    tests/
  ui/
/supabase/
  config.toml
  migrations/
  seed.sql
/e2e_tests/
/docs/
  /features/
    {feature_slug}/
      changes/
        {change_slug}/
          prompt.md
          tasks/
            qa/
              step {number} - {short_name}.md
            developer/
              step {number} - {short_name}.md
      bugs/
        {yyyymmdd_hhmm}/
          prompt.md
          tasks/
            qa/
              step {number} - {short_name}.md
            developer/
              step {number} - {short_name}.md
      prompt.md
      requirements.md
      specs.md
      tasks/
        qa/
          step {number} - {short_name}.md
        developer/
          step {number} - {short_name}.md
      reviews/
        architect.json
        security.json
        qa.json
  refactor/
    {refactor_slug}/
      prompt.md
      tasks/
        qa/
          step {number} - {short_name}.md
        developer/
          step {number} - {short_name}.md
```

If the repository already uses a different Vercel-compatible structure, preserve it unless there is a clear reason to change it.

## Security

- Zero trust at all boundaries.
- Validate all external input.
- Do not implement custom crypto.
- Secrets must be stored in Vercel/Supabase environment configuration or local-only `.env` files that are not committed.
- Never commit secrets, tokens, service-role keys, database passwords, or production URLs containing credentials.
- Treat the React/Redux UI as a hostile environment.
- Guard all sensitive operations with server-side authorization checks.
- Enforce tenant isolation server-side.
- Use least privilege for Supabase keys and database access.
- Service-role credentials are server-only.
- Admin operations such as tenant management, user management, role/permission updates, direct permission grants, exports, and cross-tenant access must be auditable.
- Do not log sensitive data.
- Protect scheduled and queued job endpoints from public misuse.

## Git Behavior

- Never run ANY git operations. The human will handle git.

## Migration Behavior

When converting .NET code to TypeScript:

- Preserve business behavior over implementation shape.
- Do not recreate .NET layers mechanically if a simpler TypeScript/Vercel structure is clearer.
- Translate domain rules, validation rules, permissions, tests, and API contracts deliberately.
- Identify and document any behavior that cannot be confidently mapped.
- Prefer incremental migration steps with verifiable tests.
- Keep frontend changes minimal unless API contract changes require them.
- Remove obsolete .NET/Hangfire assumptions from new TypeScript code paths.
- Do not keep dead .NET compatibility code unless a staged migration requires it and the reason is documented.

## What Not to Do

- Do not introduce new paid/proprietary cloud-native services beyond the approved Vercel and Supabase platform choices without explicit approval.
- Do not use Hangfire in the target TypeScript/Vercel architecture.
- Do not use EF Core or EF Core migrations.
- Do not introduce non-permissive licenses.
- Do not add new frameworks, ORMs, migration tools, auth providers, or queue providers without approval.
- Do not silently fill gaps in ambiguous specifications; flag them explicitly.
- Do not add premature abstractions, unnecessary comments, speculative features, or generic multi-cloud layers.
- Do not bypass tenant isolation or RBAC checks for convenience.
- Do not expose Supabase service-role credentials to the frontend.
- Do not assume Vercel functions can run indefinitely.
- Do not assume background jobs are exactly-once.
