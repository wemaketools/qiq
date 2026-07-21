# QuoteIQ Product Requirements Document

**Product:** QuoteIQ - Insurance Leads and Quotation Intelligence Platform  
**Client / context:** The Brittany insurance lead and quotation management POC/MVP  
**Document type:** Business-focused PRD  
**Prepared:** June 20, 2026  
**Updated:** July 11, 2026  
**Primary market context:** Botswana, with potential reuse across SADC insurance and B2B financial services markets  
**Companion document:** `QuoteIQ_UI_Standards.md` - shared visual style, control, validation, and messaging standards referenced throughout this PRD. Field-level specifications in this document state *what* is captured and *which control* is used; the companion document states *how* controls, errors, colors, and formats behave everywhere.

---

## 1. Executive Summary

QuoteIQ is a multi-tenant business application for managing insurance leads from initial intake through quotation, follow-up, and final outcome. The product is intended to move insurers from basic quote tracking to active sales and quotation intelligence: understanding what leads were received, what was quoted, what is still open, what converted, what was lost, why it was lost, and where sales leadership should intervene.

The terminology must be precise:

- A **Party** is a person interested in insurance or who has purchased insurance with the tenant; so can be a prospect or customer, a person or legal entity
- A **Lead** is the initial insurance quote request or sales opportunity captured through the intake form or another intake channel and is always associated to a **Party**
- A **Quote** is the formal quotation or proposal provided to the requester after enough information has been collected and pricing/underwriting work has been completed.
- A **Quote** is always associated to a **Lead**.
- A **Lead** may have no Quote yet, one Quote, or multiple associated Quotes where the business supports revisions, options, or re-quotes.
- Dashboards may show both lead metrics and quote metrics, but labels must make clear which entity is being counted.

The MVP should focus on five practical outcomes:

1. Capture every lead in a consistent way.
2. Track each lead through a clear business lifecycle with ownership, dates, reminders, and outcomes.
3. Track quotes as distinct records associated with leads once formal quotations are issued.
4. Provide dashboards that expose pipeline value, conversion, aging, follow-up discipline, broker performance, RM performance, turnaround, SLA breaches, and loss reasons.
5. Support multiple tenants with tenant-specific data, tenant-configurable business lists, role-based access control, and tenant switching for users who can access more than one tenant.

The product should be positioned as a **Sales Quote Control Tower**, not a passive quote register. Its value is commercial: premium visibility, sales discipline, lead-to-quote conversion, quote-to-win conversion, broker performance management, loss intelligence, and management intervention before opportunities are lost.

---

## 2. Product Goals

### 2.1 Business Goals

- Improve visibility of the live insurance lead and quotation pipeline.
- Reduce premium leakage from stalled, poorly followed-up, or unmanaged leads and quotes.
- Help Sales, Relationship Managers, Underwriting, and Management understand where intervention is needed.
- Improve follow-up discipline through reminders, overdue alerts, and escalation queues.
- Identify which brokers, RMs, product lines, cover types, regions, industries, segments, and party types are driving lead volume, quoted premium, won premium, and conversion.
- Capture structured loss reasons so management can understand whether business is being lost due to pricing, product fit, service, broker behavior, incumbent relationships, tender activity, or other reasons.
- Support multiple insurers or business units as separate tenants, while enabling The Brittany/internal platform users to manage global configuration and view tenant data where authorized.
- Create a repeatable product pattern for insurance and adjacent B2B financial services sales environments.

### 2.2 MVP Goals

- Deliver a polished working MVP for one or more pilot tenants, with each tenant operating as an isolated business environment.
- Prove that structured lead capture plus quote lifecycle tracking can generate useful management intelligence.
- Provide dashboards that are useful in weekly sales management and executive review meetings.
- Keep the workflow simple enough for RMs, Underwriters, and Sales Operations to adopt quickly.
- Provide tenant-specific configuration for core business lists without requiring custom builds for each tenant.
- Provide role-based access control flexible enough for business roles, user groups, and direct user exceptions.

### 2.3 Non-Goals for MVP

The MVP should not attempt to solve every insurance operations problem. The following should be deferred unless required for pilot success:

- Full core insurance system integration.
- Full email inbox integration.
- WhatsApp integration.
- Automated quote pricing or rating engine.
- AI win-probability prediction.
- Complex document management (simple quote file attachments are in scope - see 12.7).
- Multi-insurer marketplace workflows where one lead is shopped across multiple insurer tenants.
- Advanced commission or broker remuneration calculations.

---

## 3. Product Principles

### 3.1 Multi-Tenant by Design

QuoteIQ must be designed as a multi-tenant product from the first version. Each tenant represents an insurer, business unit, or client organization using QuoteIQ. Tenant boundaries are business boundaries.

Each tenant must have its own:

- Leads.
- Quotes.
- Brokers and broker contacts.
- Users (RBAC system allows for creating any relevant type of user, such as Relationship Manager, Underwriting Owner, Sales Manager, etc.).
- Party records.
- Tenant-specific reference lists.
- Tenant-specific dashboards, reports, alerts, and business rules.

### 3.2 Clear Lead and Quote Separation

The product must avoid using “lead”, “quote request”, and “quote” interchangeably.

- The **Lead** begins when a quote request is submitted or captured.
- The **Quote** begins when a formal quotation/proposal exists or is sent.
- Pipeline views may include pre-quote lead stages and post-quote proposal stages, but the underlying distinction must remain clear.
- Metrics must distinguish lead volume from quote volume where the distinction affects business interpretation.

### 3.3 Configurable Without Over-Customization

Tenants should be able to configure key business lists and rules while retaining sensible defaults. The MVP should support enough configuration to make each tenant operationally credible without turning every tenant into a separate product.

### 3.4 Action-Oriented Dashboards

Dashboards should not only report what happened. They should show what needs action now: stalled leads, delayed quotes, overdue follow-ups, high-value opportunities, SLA breaches, expiring quotes, underperforming brokers, and loss patterns.

---

## 4. Target Users and Personas

| Persona | Scope | Primary Need | Key Product Expectations |
|---|---:|---|---|
| Internal Platform Administrator | Global | Manage tenants, global defaults, internal users, and cross-tenant oversight. | Internal role, global tenant management, all-tenant access where permitted, audit visibility. |
| Tenant Administrator | Tenant | Manage tenant users, tenant reference lists, roles, groups, business rules, and data quality. | Tenant administration, user/group management, configurable dropdowns, tenant-level reports. |
| Head of Sales / Business Development | Tenant | Understand pipeline, conversion, premium at risk, RM activity, broker performance, and where to intervene. | Executive dashboard, pipeline view, alerts, conversion reporting, exportable weekly reports. |
| Relationship Manager (RM) | Tenant | Manage assigned leads and quotes, follow up with brokers/clients, and keep pipeline current. | Simple lead entry, assigned lead list, follow-up reminders, status updates, notes, next action tracking. |
| Underwriter | Tenant | See assigned underwriting work, manage quote preparation status, and expose turnaround delays. | Assigned underwriting queue, SLA visibility, underwriting status, reasons for delay. |
| Sales Operations / Admin | Tenant | Maintain data quality, support lead and quote capture, help with reporting, and manage reference data if permitted. | Lead/quote maintenance, user support, dropdown lists, reporting support, data correction. |
| Executive Viewer / ExCo | Tenant | Review high-level performance without operational detail overload. | Read-only executive overview, trend charts, won/lost premium, quotes at risk, broker/RM insights. |
| Broker / Partner Contact - future or optional | Tenant-scoped external | Submit or follow quote requests. | External intake form, lead acknowledgement, limited status visibility if approved by the business. |

---

## 5. Multi-Tenant Business Requirements

### 5.1 Tenant Model

| Requirement | Description |
|---|---|
| Tenant creation | Internal users with the required Tenant Manager permission must be able to add new tenants. |
| Tenant viewing | Authorized users must be able to view the list of tenants and open a tenant detail page. |
| Tenant editing | Authorized users must be able to edit a tenant's name, contact name, contact email, and contact phone (consistent with 5.5). |
| Tenant removal | Authorized users must be able to remove a tenant from active use. Tenant removal must be implemented as a soft delete so historical data, audit history, and reporting integrity are preserved. |
| Tenant profile | For the MVP, the only required tenant profile fields are **tenant name**, **contact name**, **contact email**, and **contact phone**. Additional tenant profile fields such as country, timezone, primary contact, billing data, or branding are out of scope unless required during discovery. Each tenant additionally carries a configurable **display currency** (code and symbol, default BWP) that controls the currency symbol/formatting used across all of that tenant's screens, inputs, dashboards, and exports; it is presentation-only, applies to all of the tenant's data, and individual leads/quotes do not store a per-record currency. |
| Tenant status | Tenants have exactly two states: Active and Removed. Removal is a soft delete that hides the tenant from normal use without hard deletion; suspension and removal are deliberately the same state for the MVP, and a removed tenant can be restored (5.5). |
| Tenant isolation | Tenant data must be segregated so users only access data for tenants they are assigned to, unless they have Internal access. |
| Tenant defaults | Creating a new tenant must automatically populate every tenant-configurable reference list (Section 6) with a sane starting data set, so a new tenant is immediately usable without manual setup. These seeded values are a starting point only: each tenant can edit, add, disable, or reorder them, and the seeded defaults are sourced from an easily updateable definition (Section 6.4) rather than hard-coded. |
| Tenant-specific rules | Each tenant should be able to define practical business rules such as high-value thresholds, SLA targets, quote expiry alert windows, follow-up thresholds, list aging warning thresholds (12.4), unassigned-lead and stalled-item thresholds (18.1), the duplicate-lead check window (9.3), lead/quote reference formats (9.2, 12.7), the lead inactivity expiry period (10.4), and pricing-approval targets (10.4, 18.1). |

### 5.2 Tenant-Scoped Data

The following data must be tenant-scoped:

- Leads.
- Quotes.
- Parties.
- Users, user groups, and roles.
- Brokers.
- Underwriters.
- Follow-ups.
- Alerts and escalations.
- Attachments and quote documents.
- Dashboards and reports.
- Tenant-specific reference data.

### 5.3 Tenant Context Switching

Users who can view more than one tenant must have a clear mechanism to switch tenant context.

| Requirement | Description |
|---|---|
| Tenant selector | A user with multiple tenant memberships should see a tenant switcher in the application shell. |
| Current tenant visibility | The current active tenant should always be visible to avoid accidental cross-tenant work. |
| Tenant-specific filters | Dashboards, leads, quotes, brokers, RMs, and reports should load within the active tenant context. |
| Internal all-tenant access | Internal users should be able to view any tenant, either by selecting a tenant or using an authorized cross-tenant view where appropriate. |
| No accidental mixing | Tenant-scoped lists should not combine data across tenants unless the user is in an explicitly cross-tenant internal reporting mode. |
| Remembered preference | The product should remember the last selected tenant for a user, but users must be able to change it at any time. |

### 5.4 Cross-Tenant Views

Cross-tenant views are not required for normal tenant users. They may be useful for Internal users. For MVP, the only cross tenant view needed is the Tenant Manager, which allows for adding, editing, and removing tenants.


### 5.5 Tenant Manager Requirements

The left navigation must include a **Tenant Manager** section. This section must be permission-bound and should only appear to users with tenant-management permissions, normally Internal users or other explicitly authorized platform administrators.

Tenant Manager is the business administration area for adding, viewing, editing, and removing tenants.

| Capability | Requirement |
|---|---|
| View tenants | Authorized users can view a list of tenants, including active and soft-deleted/removed tenants where permission allows. |
| Add tenant | Authorized users can create a new tenant by entering the tenant name, contact name, contact email, and contact phone. |
| View tenant | Authorized users can open a tenant record and view its current name, contact name, contact email, contact phone, and status. |
| Edit tenant | Authorized users can update the tenant name, contact name, contact email, and contact phone. |
| Remove tenant | Authorized users can remove a tenant from active use. Removal must be a soft delete, not permanent deletion. |
| Restore tenant | Recommended: authorized users can restore a soft-deleted tenant if removal was accidental or the tenant is reactivated. |
| Tenant audit | Creation, edits, soft deletion, and restoration should be auditable. |

For the MVP, Tenant Manager should not require capture of tenant country, currency, timezone, address, billing information, branding, or commercial terms. Those fields can be considered later if the product requires stronger tenant administration.

---

## 6. Tenant-Configurable Reference Data

### 6.1 Configurable Lists

The following lists should be configurable by tenant:

| Reference Data | Tenant Configurable | Sensible Defaults Recommended | Business Use |
|---|---:|---:|---|
| Request Channels | Yes | Yes | Lead source and intake reporting. |
| Product Lines | Yes | Yes | Product-level pipeline and conversion analysis. |
| Cover Types | Yes | Yes | More granular insurance cover classification. |
| Party Segments | Yes | Yes | Segment performance reporting. |
| Industries / Sectors | Yes | Yes | Market and sector analysis. |
| Regions | Yes | Yes | Regional performance and ownership. |
| Party Types | Yes | Yes | Party classification. |
| Lead Statuses | Yes, with guarded defaults | Yes | Pipeline workflow and dashboard stages. |
| Quote Statuses | Yes, with guarded defaults | Yes | Quote/proposal lifecycle tracking. |
| Lost Reasons | Yes | Yes | Loss intelligence and management reporting. |
| Broker Types / Tiers | Yes | Yes | Broker segmentation and performance reporting. |
| SLA Targets | Yes | No universal default | Turnaround and breach reporting. |
| High-Value Thresholds | Yes | No universal default | Escalation and management focus. |
| Follow-Up Rules | Yes | Yes | Follow-up compliance and overdue alerts. |

### 6.2 Reference Data Requirements

- Tenant administrators and internal users should be able to add, edit, disable, and reorder tenant-specific values where permitted. Reference data is managed in the Settings section (12.10).
- Request channels carry a tenant-configurable **broker channel** flag; this drives the conditional broker requirement at intake (9.3).
- Cover types are maintained **per product line**, so intake and quoting can restrict cover types to the selected product line (9.3, 12.7).
- Defaults should be provided for common insurance categories, but tenants must be able to tailor them.
- Disabling a reference value should not break historical reporting; historical leads and quotes should still display the value used at the time.
- Reference values used in reporting should prefer structured selections over free text.
- Some workflow statuses may be configurable in name/order, but core business meanings must remain mappable to standard reporting categories such as Open, Quoted, Won, Lost, Expired, and Withdrawn.
- Tenant-specific reference values should not be visible to other tenants.
- Internal users should be able to manage global default templates used when new tenants are created.

### 6.3 Suggested Default Values

#### Request Channels

- Broker email.
- Direct client.
- RM referral.
- Phone.
- Portal.
- WhatsApp.
- Renewal review.
- Walk-in / branch.
- Other.

#### Product Lines

- Motor.
- Property.
- Liability.
- Engineering.
- Marine.
- Group Life.
- Health.
- Funeral.
- Agriculture.
- Commercial Combined.
- Specialty Risks.
- Other.

#### Party Types

- Individual.
- SME.
- Corporate.
- Group.
- Government.
- Parastatal.
- Non-profit.
- Other.

#### Industries / Sectors

- Agriculture.
- Mining.
- Logistics / Transport.
- Hospitality.
- Retail.
- Construction.
- Manufacturing.
- Financial Services.
- Public Sector.
- Professional Services.
- Other.

#### Party Segments

- Retail.
- SME.
- Corporate.
- Strategic Account.
- Specialty Risks.
- Agriculture.
- Public Sector.
- Other.

#### Regions

- Botswana - National.
- Gaborone.
- Francistown.
- Maun.
- Kasane.
- Lobatse.
- Palapye.
- Selebi-Phikwe.
- Other.

Tenants outside Botswana should be able to replace these with their own regional lists.

#### Lead Statuses (guarded defaults)

Lead statuses are workflow states, not free-form data. They are set exclusively by the workflow operations defined in Section 10.4 - never by a manually edited dropdown or text field on a lead form. Tenants may rename statuses, reorder them, or add intermediate open statuses, but every status must map to one of the standard reporting categories, and the terminal statuses (Won, Lost, Expired, Withdrawn) cannot be disabled.

| Order | Default Lead Status | Reporting Category | Meaning |
|---:|---|---|---|
| 1 | New | Open | Lead captured; not yet assigned to an owner. |
| 2 | Assigned | Open | An accountable owner (RM) has been assigned. |
| 3 | Information Gathering | Open | Additional client, broker, or risk information is being collected. |
| 4 | Underwriting | Open | Underwriting review or risk assessment is in progress. |
| 5 | Pricing | Open | Pricing / quote preparation is in progress. |
| 6 | Quote Sent | Quoted | At least one formal quote has been sent to the requester. |
| 7 | Negotiation | Quoted | Terms, coverage, or premium are being negotiated. |
| 8 | Closed Won | Won | An associated quote was won; lead converted. |
| 9 | Closed Lost | Lost | Opportunity lost (before or after quote; reporting distinguishes the two). |
| 10 | Expired | Expired | Quote validity lapsed or lead went inactive past tenant threshold. |
| 11 | Withdrawn | Withdrawn | Request withdrawn or no longer valid. |

The prototype screenshots use the labels New Quote, Under Review / Information Gathering, Pending Underwriting, Pending Pricing, Proposal Sent, Negotiation, Won, and Lost. These map onto the canonical list above (Under Review → Underwriting, Pending Pricing → Pricing, Proposal Sent → Quote Sent). The product should use one canonical vocabulary per tenant.

#### Quote Statuses (guarded defaults)

Quote statuses are likewise set only by quote workflow operations (Section 10.4).

- Draft.
- Sent.
- Revised.
- Won.
- Lost.
- Expired.
- Withdrawn.

#### Broker Types / Tiers

- Tier 1 - strategic partner.
- Tier 2 - core partner.
- Tier 3 - occasional partner.
- Direct / non-intermediated.

### 6.4 Reference Data Seeding on Tenant Creation

When a new tenant is created, the product must auto-populate that tenant's configurable reference data (Section 6.1) with a sane default data set so the tenant is operationally credible from the moment it exists. No administrator should have to hand-build the core lists before the first lead can be captured.

| Requirement | Description |
|---|---|
| Automatic on creation | Creating a tenant copies the current default reference data set into the new tenant as tenant-owned values. This happens as part of tenant creation, not as a later manual step. |
| Sane starting point | The seeded values are the suggested defaults in Section 6.3 (request channels, product lines, cover types, party segments, industries, regions, party types, lead statuses, quote statuses, lost reasons, broker types) — enough to run the standard workflow and dashboards immediately. |
| Starting point, not a lock-in | Seeded values are owned by the tenant and fully editable afterwards: each tenant can rename, add, disable, or reorder them, subject to the guarded-status rules in Section 6.2 (terminal statuses cannot be disabled; every status must map to a standard reporting category). |
| Easily updateable definition | The default data set must live in an easily maintainable, single source of definition (for example a versioned seed definition maintained by Internal users, per Section 6.2's global default templates) rather than being hard-coded across the application. Updating the defaults must not require code changes to individual features. |
| Applies to future defaults changes only | Editing the global default template changes what future tenants are seeded with. It does not retroactively overwrite the reference data of tenants that already exist, so no tenant's local customization is lost. |
| Tenant isolation preserved | Seeded values become tenant-scoped data (Section 5.2); one tenant's edits to its seeded lists never affect another tenant. |

---

## 7. Lead and Quote Domain Requirements

### 7.1 Lead Definition

A Lead is the original request or opportunity. It captures who requested insurance coverage, what kind of coverage is needed, where it came from, who owns it, and where it sits in the sales workflow.

A Lead should exist before a Quote exists.

### 7.2 Quote Definition

A Quote is the formal commercial proposal or pricing output associated to a Lead. A Quote should capture the premium, quote date, valid-until date, quote reference number, quote version, and outcome-related information.

A Lead may have multiple Quotes when business reality requires it, for example:

- revised premium after negotiation;
- alternative cover options;
- corrected quote;
- renewal re-quote;
- multi-product quote options.

### 7.3 Lead-to-Quote Relationship Rules

| Rule | Requirement |
|---|---|
| Party association | Every Lead is associated with exactly one Party; a Party may have many Leads over time (12.9). |
| Lead first | Intake creates a Lead, not a Quote. |
| Quote creation | A Quote is created when formal quotation terms or a proposal are prepared or sent. |
| Association | Every Quote must be associated with exactly one Lead. |
| Multiple quotes | The product should allow multiple Quotes per Lead. |
| Primary quote | Where multiple Quotes for the same product exist, one Quote may be marked as current or primary for dashboard rollups. |
| Conversion | A Lead may be considered converted when one associated Quote is marked Won. |
| Loss | A Lead may be marked Lost when the opportunity is lost, even if a Quote was never issued, but reporting must distinguish “lost before quote” from “lost after quote.” |
| Expiry | Quote expiry applies to Quotes. Lead staleness applies to Leads. |
| Auditability | Lead status changes and Quote status changes must both be traceable using an append-only log. |

### 7.4 Terminology in UI and Reports

The product should use these labels consistently:

| Term | Use |
|---|---|
| Party | The person or legal entity behind a lead (prospect or customer). Dashboard tables inherited from the prototype may label this column "Client"; "Client" always refers to the Party. |
| Lead | Initial quote request/opportunity. |
| Lead Intake | The form or channel used to capture a new Lead. |
| Request Channel | How the Lead entered the business. |
| Quote | Formal quotation/proposal issued or prepared for a Lead. |
| Quote Sent | The stage where a Quote has been sent to broker/client/requester. |
| Quoted Premium | Premium value on a Quote. |
| Bound Premium | Premium value won when a Quote converts. |
| Lead-to-Quote Rate | Leads that received at least one Quote divided by eligible Leads. |
| Quote-to-Win Rate | Quotes won divided by Quotes sent. |

Avoid using “quote request” as the entity name in the product. Use **Lead**.

---

## 8. Scope Overview

| Capability | Requirement |
|---|---|
| Multi-tenant foundation | Support multiple tenants, tenant-specific data, tenant-specific configuration, and tenant switching for multi-tenant users. |
| Tenant Manager | Provide a permission-bound left-menu section for adding, viewing, editing, and soft-removing tenants. |
| User Manager | Provide a permission-bound left-menu section for managing users, roles, user groups, role assignments, group memberships, and direct permissions. |
| User login and tenant assignment | The entire application is gated behind login; the only anonymous flow is password reset, and there is no self-service sign-up (12.11). Users log in with their email as username. Users must be assigned to at least one tenant unless they are Internal global users. Users may be assigned to multiple tenants. |
| Role-based access control | Support roles, permissions, user groups, group role assignment, direct user role assignment, and direct user permission assignment. |
| Internal role | Provide an Internal role for global administration and management of global data such as tenants and default templates. |
| Lead intake | Provide a structured form for capturing leads and the minimum information needed for pipeline reporting, both within the web app and via REST API. |
| Quote management | Create and manage quotes as distinct entities associated with leads once formal quotations are prepared or sent. Multiple quotes can be created per lead. |
| Lead lifecycle | Track lead status from intake through assigned, information gathering, underwriting/pricing, quote sent, follow-up, and final outcome. |
| Quote lifecycle | Track quote-specific status such as drafted, sent, revised, won, lost, expired, or withdrawn. |
| Business Assignments | Define, per tenant, which roles leads and quotes can be assigned to ("assignable roles"); for example, if a tenant's RBAC system defines Relationship Manager, Underwriter, and Account Executive roles, the tenant could configure Relationship Manager and Underwriter as assignable roles for quotes, allowing an RM and an Underwriter to be assigned to each quote. A lead or quote can therefore carry multiple simultaneous assignments - one user per configured assignable role - and the single Assign / Reassign workflow operation (10.4, 12.8) manages all of them. Assigned roles drive dashboards and reports. |
| Tenant reference data | Allow tenant configuration of request channels, product lines, cover types, segments, industries, regions, and party types. |
| Tenant core data | Brokers, users, parties, leads, and quotes are segregated by tenant. |
| Party management | Provide a Parties section with list, view, add, and edit screens; a party can have many leads, and a party's leads are visible and workable from its detail page (12.9). |
| Settings | Provide a permission-bound Settings section, grouped with the administrative navigation entries, for tenant-scoped administration: brokers, reference data, business rules, business assignments, and API access (12.10). |
| Follow-up management | Capture last follow-up, next follow-up, follow-up count, and notes. Generate overdue reminders. |
| Lost reason capture | Require a structured lost reason when a lead or quote is marked Lost. Support optional free-text comments. |
| Pipeline view | Show open leads and quotes with filters by RM, broker, product, status, aging, and premium value. |
| Dashboards | Provide executive, pipeline, RM, broker, product, loss reason, turnaround, and alert views. |
| Alerts | Surface overdue follow-ups, stalled leads, quote expiry risk, high-value opportunities, SLA breaches, and executive escalations. |
| Exports | Allow business users to export dashboard/table data for weekly sales meetings and ExCo reporting. |
| Audit trail | Maintain a business-readable history of important changes, including status changes, ownership changes, dates, and outcome updates. |

---

## 9. Lead Intake Requirements

### 9.1 Intake Channels

The product should support manual lead capture in the MVP and should be structured so future intake channels can be added.

| Intake Channel | Description |
|---|---|
| Browser | Intake form shown in product with fields to be completed on screen to submit a lead. |
| REST API Intake | REST API endpoint through which tenants and authorized brokers can submit leads using OAuth client credentials (API id and secret) provisioned in Settings (12.10). |

Request channels must be configurable per tenant, with sensible defaults available.

### 9.2 Intake Form Principle: Capture Facts, Not Lifecycle

The New Lead form captures only the facts a person actually knows at intake: who is asking for cover, what cover they need, where the request came from, and who will own it. Everything about lifecycle, process tracking, and outcome is system-managed and must **not** appear on the form. Lead and quote lifecycle is driven by the workflow operations in Section 10.4, never by a manually edited status dropdown.

Fields that must **not** appear on the New Lead form:

| Excluded Field | Why Excluded | Where It Is Managed |
|---|---|---|
| Lead ID / reference | System-generated on save using a tenant-configurable format (e.g., `L-2026-0421`). Shown on Lead Detail after creation. | System. Tenants that need to record an external/manual reference may enable the optional **External reference** field (9.3). |
| Lead status | Always `New` on creation. Changes only through workflow operations. | Workflow operations (10.4). |
| Quote fields (reference, version, premium, prepared/sent/valid-until dates, quote status) | Quotes are separate records subordinate to the lead, created later from Lead Detail. | Quote screens (12.7) and quote workflow operations (10.4). |
| Date assigned, SLA status, turnaround days | Derived from workflow events and tenant SLA rules. | System-calculated. |
| Underwriting owner | Set by the **Send to underwriting** workflow action or by Assign / Reassign, like any other assignable role (Section 8). | Workflow operations (10.4). |
| Follow-up fields (last/next follow-up date, count, notes) | Follow-ups are activities logged against an existing lead. | **Log follow-up** action on Lead Detail (12.5). |
| Outcome fields (outcome status, decision date, bound premium, lost reason, competitor, loss comments) | Captured by the **Mark won** / **Mark lost** / **Withdraw** workflow dialogs, with their own validation. | Workflow dialogs (12.8). |
| Active tenant | Implicit from the current tenant context, which is always visible in the application shell. All dropdowns load the active tenant's reference values only. | Tenant switcher (5.3). |

### 9.3 New Lead Form - Field Specification

The form is a single page opened from the global **+ New Lead** button or from the Leads list (see Section 12.6 for screen behavior and layout, and `QuoteIQ_UI_Standards.md` for control, validation, and error-display standards). Fields are grouped into three sections rendered in order, each a two-column grid.

#### Section 1 - Party

| Field | Control | Required | Validation / Behavior |
|---|---|---|---|
| Party | Searchable dropdown (type-ahead over tenant parties) with inline **+ New party** option | Required | Selecting an existing party shows a read-only summary (type, segment, industry, region) and collapses the fields below. Choosing **+ New party** expands them. |
| Party name | Text, max 200 chars | Required for new party | Trimmed; duplicate-name warning (non-blocking) against existing tenant parties. |
| Party type | Dropdown (tenant list) | Required for new party | - |
| Existing vs new client | Radio pair: `Existing client` / `New business` | Required | Separates renewal/expansion from new business in reporting. |
| Industry / sector | Dropdown (tenant list) | Optional, recommended | - |
| Party segment | Dropdown (tenant list) | Optional, recommended | - |
| Strategic account | Toggle | Optional, default off | Flags accounts requiring management visibility. |
| Contact name / email / phone | Text / email / phone inputs | Optional | Email and phone format-validated. *Addition beyond the original brief - confirm in discovery.* |

#### Section 2 - Request Details

| Field | Control | Required | Validation / Behavior |
|---|---|---|---|
| Date received | Date picker, defaults to today | Required | Cannot be in the future. Editable to support back-capture of requests received earlier. |
| Request channel | Dropdown (tenant list) | Required | - |
| Broker | Searchable dropdown of tenant brokers | Required when the selected request channel is a broker channel; otherwise optional | Tenant configuration marks which channels are broker channels. |
| Owner | Searchable dropdown of tenant users eligible as lead owners (per Business Assignments, Section 8) | Required | Defaults to the current user when they are eligible. Captures the accountable owner role only; the lead's other assignable roles (Section 8) are set later via Assign / Reassign (10.4). |
| Region | Dropdown (tenant list) | Required | Single region per lead. Defaults from the selected party's region; editable. For a party created inline via **+ New party**, the new party's region is initialized from this field. |
| External reference | Text, max 50 chars | Optional; visible only when the tenant enables manual lead references | Uniqueness warning within tenant (non-blocking). |

#### Section 3 - Coverage Need

| Field | Control | Required | Validation / Behavior |
|---|---|---|---|
| Product line | Dropdown (tenant list) | Required | Changing it resets Cover type. |
| Cover type | Dropdown, dependent on Product line | Required | Disabled until Product line is selected; shows only cover types for that product line. |
| Sum insured / exposure value | Currency input (tenant display-currency prefix, e.g. `BWP`; thousands separators) | Optional, recommended | Must be > 0 when provided. |
| Estimated annual premium | Currency input | Optional, recommended | Must be > 0 when provided. Drives pipeline value before a formal quote exists. |
| Policy term | Dropdown: 6, 12 (default), 24, 36 months, Other | Optional | - |
| Priority | Dropdown: `Normal` / `High`; defaults to derived value | Optional | Derived as `High` when estimated premium exceeds the tenant high-value threshold; user may override. |
| Intake notes | Multiline textarea | Optional | Free-text context for the owner; stored as the first activity entry. |

#### Form Actions and Validation Behavior

- Primary button **Create lead** (bottom right), secondary **Cancel**. Per UI standards: inline field errors on blur and on submit, form-level error summary when three or more fields fail, server-side revalidation of everything.
- On success: navigate to the new Lead Detail screen and show a success toast, e.g. `Lead L-2026-0421 created`.
- Duplicate lead check on save: if an open lead exists for the same party and product line within the tenant-configured window, show a non-blocking warning dialog listing the potential duplicates with links, and offer **Create anyway** / **Review existing**.
- **Edit Lead** reuses this specification: same fields, same validation. Lifecycle, follow-up, and outcome data remain non-editable there (see 12.6).

### 9.4 REST API Intake

- The API accepts the same business fields with the same required/optional rules as the form, with one exception: **Owner is optional via API** - API-submitted leads may arrive unassigned. Lead status is always created as `New`.
- Two credential types exist, both provisioned from Settings (12.10): **broker-scoped** credentials, issued per broker from the broker view page, and **tenant-scoped** credentials, issued to the tenant itself. With broker-scoped credentials the `broker` field is set automatically from the credential and cannot be spoofed; with tenant-scoped credentials the payload may supply the broker, subject to the same channel rules as the form.
- Validation failures return a structured error list (field, code, message) suitable for machine handling; the duplicate check returns a warning payload rather than blocking.
- API-created leads appear in the Leads list and alerts exactly like browser-created leads (e.g., they trigger the unassigned-lead alert until assigned).

---

## 10. Lead and Quote Lifecycle Requirements

### 10.1 Standard Lead Lifecycle

The MVP should support a clear lead lifecycle that reflects the real insurance sales journey while staying simple enough for adoption.

The recommended MVP lead lifecycle is the default Lead Status list defined in Section 6.3:

1. **New** - lead has been captured.
2. **Assigned** - lead has an accountable RM owner.
3. **Information Gathering** - additional client, broker, or risk information is required.
4. **Underwriting** - underwriting review or risk assessment is in progress.
5. **Pricing** - pricing input or quote preparation is in progress.
6. **Quote Sent** - a formal quote has been sent to broker/client; the lead is awaiting decision and under active follow-up.
7. **Negotiation** - terms, coverage, or premium are being discussed.
8. **Closed Won** - lead converted into bound business through an associated quote.
9. **Closed Lost** - lead was declined or awarded elsewhere.
10. **Expired** - quote validity period passed without conversion, or the lead was no longer active.
11. **Withdrawn** - request is no longer valid.

Leads do not need to pass through every open status; workflow operations (10.4) define which jumps are legal (for example, a simple motor lead can go straight from Assigned to Pricing).

### 10.2 Standard Quote Lifecycle

Recommended MVP quote lifecycle:

1. **Draft / Prepared** - quote exists but has not yet been sent.
2. **Sent** - quote has been provided to the requester.
3. **Revised** - quote was changed after initial preparation or negotiation.
4. **Won** - quote converted to bound premium.
5. **Lost** - quote was rejected or business was placed elsewhere.
6. **Expired** - quote valid-until date passed without conversion.
7. **Withdrawn** - quote was withdrawn or no longer applicable.

### 10.3 Lifecycle Business Rules

| Rule | Requirement |
|---|---|
| Tenant context | Every lead and quote must belong to one tenant. |
| Workflow-only transitions | Lead and quote statuses change only through the named workflow operations in 10.4. No screen may offer status as an editable dropdown or text field. |
| Status history | Every lead and quote status change should be captured with date/time, user, previous status, and new status. |
| Required dates | Key lifecycle dates must be captured as the lead and quote progress: received, assigned, prepared, sent, decision. |
| Lost reason | A lead or quote cannot be marked Lost without a structured lost reason. |
| Won premium | A quote cannot be marked Won without a bound premium. |
| Follow-up requirement | Open leads past the Quote Sent stage should have a next follow-up date. |
| Quote expiry | Quotes with a valid-until date should generate expiring quote alerts before expiry. |
| SLA breach | Leads or quotes exceeding agreed tenant-specific turnaround thresholds should be flagged. |
| High-value escalation | Leads or quotes above a tenant-configured premium threshold should be eligible for escalation when stalled, overdue, or near expiry. |
| Ownership | Each open lead must have an accountable owner. |
| Closed quote protection | Closed leads and quotes should be editable only by authorized roles or through a correction process. |

### 10.4 Workflow Operations

Lifecycle is guided by explicit, named workflow operations. Each operation is a button or menu item on Lead Detail (or on a quote row within it), opens a small dialog collecting only the inputs that operation needs, validates them, applies the transition, and writes an audit/timeline entry. Dialog layout and validation display follow Section 12.8 and `QuoteIQ_UI_Standards.md`.

**Assignment model.** Leads and quotes are not assigned to a single generic owner. Each tenant configures which roles are assignable to leads and which to quotes (Business Assignments, Section 8), and an item holds up to one assignee per configured assignable role - for example, a lead may simultaneously carry an RM and an Underwriter. One of the lead's assignable roles is designated the **accountable owner** role (typically RM); rules elsewhere that require "an accountable owner" (10.3) refer to that role. There is a single Assign / Reassign operation per item, and its dialog manages all of the item's role assignments - any configured role can be set, changed, or cleared through it, not just the accountable owner.

#### Lead Workflow Operations

| Operation | Available When (lead status) | Required Inputs | Result |
|---|---|---|---|
| Assign / Reassign | New, or any open status (reassign) | One searchable user dropdown per assignable role configured for leads (Section 8), pre-filled with current assignees; accountable owner required, other roles optional; optional comment | Any subset of role assignments can be changed in one operation. New → Assigned once the accountable owner is set; reassignment keeps the current status. Records date assigned and, per changed role, previous and new assignee. |
| Start information gathering | Assigned, Underwriting, Pricing | Optional note | Status → Information Gathering. |
| Send to underwriting | Assigned, Information Gathering | Underwriting owner (searchable user dropdown); optional note | Status → Underwriting. Sets the lead's underwriting assignable role (Section 8) - a status-changing shortcut for that assignment. Starts underwriting SLA clock. |
| Start pricing | Assigned, Information Gathering, Underwriting | Optional note | Status → Pricing. |
| Request pricing approval | Pricing | Approver (searchable dropdown of users with the pricing-approval permission); proposed premium (currency, optional); note (optional) | Pricing approval state → Pending; starts the pricing-approval clock (18.1). Lead status unchanged. |
| Approve pricing | Pricing, approval Pending; permission-bound | Optional note | Approval state → Approved; timeline entry recorded. Lead status unchanged; quoting proceeds. |
| Reject pricing | Pricing, approval Pending; permission-bound | Rejection reason (required) | Approval state → Rejected; lead remains in Pricing for rework; a new request can be submitted. |
| Create quote | Any open status (typically Pricing) | Opens the New Quote form (12.7) | Creates a Draft quote under the lead. If the lead is before Pricing, it moves to Pricing. |
| Log follow-up | Quote Sent, Negotiation (any open status permitted) | Follow-up date (default today); outcome note; next follow-up date (required while lead is open past Quote Sent) | Increments follow-up count, updates last/next follow-up dates, adds timeline entry. No status change. |
| Start negotiation | Quote Sent | Optional note | Status → Negotiation. |
| Mark lost | Any open status | Lost reason (dropdown, tenant list, required); competitor won (dropdown/text, optional); competitor premium (currency, optional); loss comments (textarea, optional) | Status → Closed Lost with decision date; any open quotes on the lead → Lost. Reporting records whether loss was before or after quote. |
| Withdraw | Any open status | Withdrawal note (required) | Status → Withdrawn; any open quotes → Withdrawn. |
| Reopen | Closed Lost, Expired, Withdrawn; permission-bound | Reopen reason (required) | Returns lead to its last open status; fully audited. |
| Expire (automatic) | Any open status | None - system job | Lead → Expired when it has had no activity for longer than the tenant-configured lead inactivity expiry period. Any activity on the lead's quotes counts as lead activity, so quote inactivity cascades into lead inactivity. Expiry alerts raised (Section 18). |

A lead is marked **Closed Won** only through the quote-level *Mark won* operation - there is no direct lead-level "won" action, because winning always happens on a specific quote.

Pricing approval is a tracked sub-state of the Pricing stage (Pending / Approved / Rejected), not a lead status; it does not change the canonical status lists in 6.3. A tenant business rule may optionally require an approved pricing approval before **Send quote** when the quoted premium exceeds the tenant's high-value threshold.

#### Quote Workflow Operations

| Operation | Available When (quote status) | Required Inputs | Result |
|---|---|---|---|
| Create quote | Lead is open | Quoted premium (currency, required); cover details defaulted from lead (editable); valid-until date (optional at draft); notes | Quote created as Draft, version 1, reference auto-generated per tenant format. Quote role assignments (Section 8) default from the lead's matching roles where configured. |
| Assign / Reassign | Draft, Sent, Revised | One searchable user dropdown per assignable role configured for quotes (Section 8), pre-filled with current assignees; optional comment | Updates the quote's role assignments; any subset of configured roles can be changed in one operation. Quote status unchanged. Audited per changed role. |
| Send quote | Draft, Revised | Sent date (default today); valid-until date (required); next follow-up date for the lead (required) | Quote → Sent. Lead → Quote Sent when this is the first sent quote. |
| Revise quote | Sent | New quoted premium and/or terms (required); revision note | Creates a new version marked current; quote → Revised. Prior versions remain visible in history. |
| Mark won | Sent, Revised | Bound premium (currency, required; defaults to quoted premium); decision date (default today) | Quote → Won; lead → Closed Won. Other open quotes on the lead → Withdrawn (confirmed in the dialog). |
| Mark lost | Sent, Revised | Lost reason (required); competitor won (optional); competitor premium (optional); loss comments (optional) | Quote → Lost. If no other open quote exists, the dialog offers to close the lead as Lost (default on). |
| Withdraw quote | Draft, Sent, Revised | Withdrawal note | Quote → Withdrawn. Lead status unchanged. |
| Expire (automatic) | Sent, Revised past valid-until date | None - system job | Quote → Expired; expiring/expired alerts raised (Section 18). Tenant rule may also expire the lead when no other open quote exists. |

#### Automatic Behavior

- With two exceptions - the automatic quote expiry job and the automatic lead inactivity expiry job (both marked "Expire (automatic)" above) - SLA breaches, stalled flags, and aging never change status by themselves; they raise alerts and flags (Section 18) so a person acts through a workflow operation.
- Every operation records date/time, acting user, previous status, new status, and captured inputs in the append-only history required by 7.3.

---

## 11. Pipeline Management Requirements

### 11.1 Pipeline View

Business users should be able to see and manage the live lead and quote pipeline within the active tenant. The pipeline view should answer:

- What leads are currently open?
- Which leads have not yet received quotes?
- Which quotes have been sent and are awaiting decision?
- Who owns each lead?
- How old is each lead or quote?
- What premium value is at risk?
- What stage is each lead in?
- What is the next action?
- Which leads or quotes are overdue, stalled, expiring, or escalated?

### 11.2 Pipeline Filters

All dashboard and pipeline views should support practical sales-management filters. Filters should use tenant-specific reference data.

| Filter | Purpose |
|---|---|
| Tenant | Available to multi-tenant and Internal users. Determines the active tenant context. |
| Date range | View lead or quote activity for current month, quarter, YTD, or custom periods. |
| Product line | Analyze performance by product or line of business. |
| Cover type | Analyze performance at more granular cover classification. |
| Broker | Compare broker volume, conversion, turnaround, and loss patterns. |
| RM | Track ownership, activity, conversion, and follow-up compliance. |
| Broker type | Distinguish broker categories or partner segments. |
| Region | Support regional performance views. |
| Party Type | Analyze performance by party category. |
| Segment | Analyze performance by tenant-defined commercial segment. |
| Industry | Analyze sector-level lead quality and conversion. |
| Lead status / quote status | Focus on open, stalled, sent, negotiation, won, lost, etc. |
| Aging bucket | Identify stale leads and quotes. |
| Premium range / high-value | Focus management attention on material opportunities. |
| SLA status | View compliant vs breached items. |
| Lost reason | Analyze loss patterns. |

The screenshots indicate common global filters at the top of dashboard pages: date range, product line, broker, RM or RM/team, broker type, and region. The product should retain this cross-dashboard filtering pattern and add tenant context where relevant.

---

## 12. Screens, Navigation, and Common UI Behavior

This section is the authoritative catalog of application screens and their expected interactions. Dashboards (Sections 13-18) and Reports (Section 19) define their own content; everything shares the shell, navigation, and behavior defined here. Visual standards - colors, typography, control behavior, validation and error display, message styles, and data formats - are defined once in `QuoteIQ_UI_Standards.md` and are not repeated per screen.

### 12.1 Left Navigation

The product provides a left navigation matching the prototype screenshots, extended with the operational Leads and Parties workspaces and the permission-bound administration sections. Standard sections appear first; administrative sections are grouped at the **bottom of the sidebar, below a visual separator**, because they are administration rather than daily work.

Standard sections:

- Overview (Section 13).
- Leads - the operational workspace: list, detail, intake, and workflow (12.4-12.8). *Not present in the prototype screenshots, which are dashboard-only; required for the product.*
- Parties - party records and their leads (12.9). *Not present in the prototype screenshots; required for the product.*
- Pipeline (Section 14).
- Brokers (Section 15.1).
- RM Performance (Section 15.2).
- Loss Analysis (Section 16).
- Alerts (Section 18) - shows a new-alert count badge (18.2).
- Reports (Section 19).

Administrative sections (bottom of the sidebar, below the separator):

- Settings, visible to users with permission to at least one of its subsections (12.10). *Not present in the prototype screenshots; required for the product.*
- User Manager, visible only to users with user/access-management permissions (Section 20.1.1). *Not present in the prototype screenshots; required for the product.*
- Tenant Manager, visible only to users with tenant-management permissions (Section 5.5). *Not present in the prototype screenshots; required for the product.*

There is deliberately **no top-level Quotes entry**: quotes are subordinate to leads and are always reached through their lead (12.5, 12.7). Dashboard drill-throughs that land on a quote open it in the context of its lead.

Administrative entries must not appear for users who lack the relevant permissions. Internal users may see all three when granted the appropriate global permissions; tenant administrators typically see Settings and User Manager for their tenant.

### 12.2 Application Shell

As shown in the screenshots:

| Element | Requirement |
|---|---|
| Sidebar | Fixed left sidebar on a deep teal-navy surface: tenant brand ("The Brittany"), product wordmark ("QuoteIQ / Quotation Intelligence"), nav items with icons, active item highlighted with an accent pill, count badge on Alerts. |
| User card | Bottom of sidebar: avatar initials, user name, role (e.g., "Michael Ndlovu / Head of Sales"), chevron menu with profile, theme, and sign-out. |
| Tenant switcher | For multi-tenant and Internal users, a tenant selector in the shell with the active tenant always visible (Section 5.3). *Addition - the prototype is single-tenant.* |
| Top bar | Page title on the left. Right side: global search (`Search leads, quotes, clients, brokers…`), notification bell showing the same new-alert count as the Alerts nav badge (18.2), help, **Export** button, and the primary **+ New Lead** button. *The prototype header shows "+ New Quote"; the product is lead-first (Section 7), so the global action creates a Lead. Quotes are created from within a lead.* |
| Global search | Type-ahead across tenant leads, quotes, parties, and brokers; results grouped by entity type; selecting a quote opens its lead; selecting a party opens its Party detail page (12.9). |
| Filter bar | On dashboards, below the header: Date Range (calendar range picker, e.g., "May 1 - May 31, 2025"), Product Line, Broker, RM, Region dropdowns (default `All`), and **Clear filters**. RM Performance replaces RM with RM / Team and replaces Broker with Broker Type, per the prototype filter row. |
| Footer | Copyright line, centered "All amounts in {tenant display currency}" (e.g., "All amounts in BWP"), right-aligned data currency ("Data as of May 31, 2025 08:30 SAST") with a refresh control. |

### 12.3 Common Dashboard Behavior

| Requirement | Description |
|---|---|
| Tenant context | Dashboards load in the active tenant context, unless the user is in an authorized Internal cross-tenant view. |
| Global filters | Per the filter bar in 12.2; filters use tenant-specific reference data and persist while navigating between dashboards. |
| KPI card anatomy | Tinted circular icon, small label, large value, and a delta versus the prior comparable period (e.g., "↑ 14% vs Apr 1-30"). Delta color is direction-aware: green when the movement is good, amber/red when bad (a *drop* in turnaround is green). |
| Period comparisons | KPI cards show trend versus prior period where meaningful. |
| Lead vs quote clarity | Cards and charts must clearly state whether they count Leads, Quotes, or Premium. The prototype counts everything as "quotes"; the product must label lead metrics and quote metrics distinctly (Section 7.4). |
| Drill-through | Every KPI, chart segment, alert, and table row opens the underlying leads or quotes. Each card carries a contextual link ("View full pipeline →", "View aging report →") and a `⋮` menu (export, view details). |
| Stage chips | Statuses render as colored chips using one shared palette across all screens (see `QuoteIQ_UI_Standards.md`). |
| Export | Dashboards and tables are exportable for management reporting (Section 19.2). |
| Last refreshed timestamp | Dashboards show data currency in the footer. |
| Consistent currency | Premium values in the tenant's configured display currency (default BWP; BWP for Botswana pilots). Large values may use compact notation on cards and axes (`BWP 128.6M`); tables show full amounts (`8,750,000`). |
| Action orientation | Dashboards identify next actions, overdue items, and escalation points - not just history. |

### 12.4 Leads List Screen

The default landing screen of the Leads section: the working queue for RMs, Sales Ops, and Sales Heads.

| Aspect | Requirement |
|---|---|
| Layout | Full-width table card beneath a filter row. **+ New Lead** button at top right. |
| Columns | Lead ID (monospace link) · Party · Broker · Product line / Cover type · Premium (estimated until quoted; then current quoted premium, right-aligned) · Status (chip) · Age (days; amber ≥ 8, red ≥ 15, thresholds tenant-configurable) · Owner · Next follow-up (red when overdue) · Flags (chips: Escalated, SLA, Expiring, High value). |
| Sorting | Default: newest date received first. All columns sortable. |
| Filters | Status (multi-select), Owner, Broker, Product line, Region, Request channel, Date received range, and a **My leads** toggle (default on for RMs). |
| Search | Filter-as-you-type within the list on lead ID, party, and broker. |
| Row interaction | Click anywhere on a row opens Lead Detail. No inline editing in the list. |
| Pagination | 25 rows per page with count summary ("1-25 of 312"). |
| Bulk actions | Permission-bound bulk **Reassign** of selected leads. Bulk reassignment changes the accountable owner only; other role assignments (Section 8) are managed per lead via Assign / Reassign. No other bulk operations in MVP. |
| Empty state | Icon plus "No leads match the current filters", with **Clear filters** and **+ New Lead** actions. |
| Export | Current filtered list to CSV/Excel. |

### 12.5 Lead Detail Screen

One page per lead; the single place where a lead is viewed, worked, and closed. Quotes live inside this screen.

| Area | Requirement |
|---|---|
| Header | Lead ID + party name as title; status chip; priority/strategic flags; assignees with avatars (accountable owner first, then the lead's other assigned roles per Section 8); age. Right side: the contextual **primary workflow action** for the current status (e.g., `Assign` when New, `Send quote` when a draft quote exists, `Log follow-up` when Quote Sent) plus a **More actions** menu with the other legal operations from 10.4, and **Edit lead**. Illegal operations are hidden, not disabled. |
| Summary panel | Read-only facts in labeled groups: Request (channel, broker, date received, region, external reference), Coverage (product line, cover type, sum insured, estimated premium, policy term), Party card (name, type, segment, industry, strategic flag; links to the Party detail page, 12.9). |
| Quotes section | A card titled **Quotes** listing the lead's quotes - the only place quotes are created. Columns: Quote ref (monospace) · Version · Status (chip) · Quoted premium · Prepared / Sent dates · Valid-until (amber when within the tenant expiry-alert window, red when past) · Current marker (one current/primary quote per lead, per 7.3) · Row actions (legal quote operations from 10.4). **+ New Quote** button on the card header (hidden when the lead is closed). Clicking a row expands the quote detail panel (12.7). Empty state: "No quotes yet - create one when formal terms are ready." |
| Follow-ups & activity | Chronological timeline combining status changes (from the append-only history), follow-ups, notes, and quote events; newest first. **Log follow-up** button. Next follow-up date shown prominently above the timeline, red with an "Overdue" chip when past. |
| Outcome panel | Appears only once the lead is closed: outcome status, decision date, bound premium (Won) or lost reason / competitor / comments (Lost), who closed it. |
| Editing | **Edit lead** (permission-bound) opens the intake fields from 9.3 for correction. Status, lifecycle dates, follow-up history, and outcome are never editable here. Closed leads are read-only except through the authorized correction process (10.3), and corrections are audited. |

### 12.6 New Lead and Edit Lead Screens

Field-level specification is Section 9.3. Screen behavior:

- Opens as a full page (not a modal) from **+ New Lead** or the Leads list; Edit opens pre-populated from Lead Detail.
- Three titled sections (Party, Request Details, Coverage Need) laid out on a two-column grid; textareas span both columns. Sticky footer bar with **Cancel** and **Create lead** / **Save changes**.
- Validation and error presentation per `QuoteIQ_UI_Standards.md`: errors inline under the field, red border and message; summary banner when multiple errors; unsaved-changes prompt on navigation away.

### 12.7 Quote Panel - Create, View, Edit

Quotes have no standalone top-level screen; they are created and worked inside Lead Detail.

**New Quote form** (modal from the Quotes card; also reachable via the *Create quote* workflow action):

| Field | Control | Required | Notes |
|---|---|---|---|
| Quote reference | Read-only, auto-generated per tenant format (e.g., `Q-2026-1503`) | - | Displayed, not editable. |
| Version | Read-only, starts at 1 | - | Incremented by *Revise quote*. |
| Product line / Cover type | Dropdowns, defaulted from the lead | Required | Editable for multi-option quoting. |
| Quoted premium | Currency input | Required | Must be > 0. |
| Prepared date | Date picker, default today | Required | Cannot precede lead date received. |
| Valid-until date | Date picker | Optional at Draft; required at Send | Must be after sent date. |
| Notes | Textarea | Optional | - |

Primary action **Save as draft**; success toast and the new Draft row appears in the Quotes card.

**Quote detail panel** (expanded row): all fields above, status history, attachments (below), and the legal workflow buttons for its status (Send quote, Revise, Mark won, Mark lost, Withdraw - per 10.4).

**Attachments:** a quote supports multiple file attachments (e.g., the issued quote document and supporting files). Allowed types for the MVP: images (PNG/JPG), PDF, and Word (`.doc`/`.docx`). Uploads are validated for type and a sensible maximum file size; attachment add/remove is audited and follows the closed-quote editing rules above.

**Editing rules:** Draft quotes are directly editable. Sent quotes change only through *Revise quote* (new version). Closed quotes (Won/Lost/Expired/Withdrawn) are read-only except through the authorized correction process.

### 12.8 Workflow Action Dialogs

All workflow operations in 10.4 - lead-level and quote-level alike - share one dialog pattern:

- Modal titled with the action and target (e.g., "Mark lost - L-2026-0421 · Botswana Mining Co." for a lead; "Mark won - Q-2026-1503 · L-2026-0421" for a quote), a one-line description of the consequence, the action's required inputs, and footer buttons **Cancel** plus a primary button naming the verb (`Mark lost`). Destructive/irreversible actions (Mark lost, Withdraw, Reopen) use the danger button style and restate the consequence.
- Inline validation per UI standards; e.g., submitting Mark lost without a reason shows "Select a lost reason" beneath the dropdown and blocks submission.
- On success: toast confirmation, status chip updates in place, and a timeline entry is added - no full-page reload.

Lead dialogs open from the Lead Detail header actions (12.5); quote dialogs open from a quote row or the quote detail panel (12.7). Where a lead-level and a quote-level operation share a name (Assign / Reassign, Mark lost, Withdraw), they are distinct dialogs with their own inputs and consequences, listed separately below.

#### Lead Workflow Dialogs

| Dialog | Inputs (from 10.4) | Notes |
|---|---|---|
| Assign / Reassign | One searchable user dropdown per assignable role configured for leads (Section 8), pre-filled with current assignees; comment | A single dialog manages all of the lead's role assignments: the accountable owner is required; each other configured role (e.g., Underwriter, Account Executive) can be set, changed, or cleared in the same dialog. Shows current assignees when reassigning. |
| Send to underwriting | Underwriting owner, note | Shortcut that sets the underwriting assignable role and moves the lead to Underwriting. |
| Request pricing approval | Approver, proposed premium (optional), note | Approver list limited to users with the pricing-approval permission. |
| Approve / Reject pricing | Approve: optional note. Reject: rejection reason (required) | Permission-bound; the dialog restates the request being decided (requester, proposed premium, note). |
| Log follow-up | Follow-up date (default today), outcome note, next follow-up date | Next follow-up required while the lead is open past Quote Sent; date must be in the future. |
| Mark lost (lead) | Lost reason (dropdown, required), competitor won, competitor premium, loss comments | Closes the lead as Lost; warns that any open quotes on the lead will also be marked Lost. |
| Withdraw (lead) | Withdrawal note | Confirmation emphasized; any open quotes on the lead → Withdrawn. |
| Reopen | Reopen reason | Permission-bound; states the status the lead will return to. |

#### Quote Workflow Dialogs

| Dialog | Inputs (from 10.4) | Notes |
|---|---|---|
| Assign / Reassign (quote) | One searchable user dropdown per assignable role configured for quotes (Section 8), pre-filled with current assignees; comment | Same multi-role pattern as the lead dialog, over the quote's own assignable roles; quote status unchanged. |
| Send quote | Sent date (default today), valid-until date, next follow-up date | Shows quoted premium read-only for confirmation. Lead → Quote Sent when this is the first sent quote. |
| Revise quote | New quoted premium and/or terms, revision note | Creates a new version marked current; prior versions remain visible in history. |
| Mark won | Bound premium (defaults to quoted premium), decision date | Warns that other open quotes on the lead will be withdrawn; lead → Closed Won. |
| Mark lost (quote) | Lost reason (dropdown, required), competitor won, competitor premium, loss comments | When no other open quote exists, includes "Also close the lead as Lost" checkbox, default checked. |
| Withdraw quote | Withdrawal note | Confirmation emphasized; lead status unchanged. |

### 12.9 Party Screens

Parties are standalone records: a party can have many leads over time (7.3), so parties are managed in their own **Parties** section rather than only inline at intake. Intake keeps its inline **+ New party** option (9.3); parties created there appear in this section like any other.

**Parties list**

| Aspect | Requirement |
|---|---|
| Layout | Full-width table card beneath a filter row. **+ New Party** button at top right. |
| Columns | Party name (link) · Party type · Segment · Industry · Region · Strategic (flag) · Open leads (count) · Total leads (count) · Last activity date. |
| Filters | Party type, segment, industry, region, strategic flag; filter-as-you-type search on party name. |
| Sorting / pagination | All columns sortable; default alphabetical by party name; 25 rows per page with count summary. |
| Row interaction | Click anywhere on a row opens Party detail. No inline editing. |
| Export | Current filtered list to CSV/Excel. |
| Empty state | Per UI standards, with **+ New Party** action. |

**Party detail (view)**

| Area | Requirement |
|---|---|
| Header | Party name as title; party type; strategic flag; **Edit party** button (permission-bound). |
| Summary panel | Read-only facts: party type, segment, industry, region, contact name/email/phone, strategic flag. |
| Leads card | All leads associated with the party, using the Leads list columns (12.4) minus the Party column; row click opens Lead Detail. **+ New Lead** button opens the New Lead form (9.3) with the Party section pre-filled and locked to this party. |
| Deletion | Parties cannot be deleted in the MVP; corrections are made through Edit party. |

**New Party / Edit Party**

- Full-page form using the party fields from 9.3 Section 1 - party name, party type, industry/sector, party segment, strategic account, and contact name/email/phone - plus **Region** (optional; a party's region is never required, whether created here or inline at intake).
- Same validation behavior as all forms (`QuoteIQ_UI_Standards.md`), including the non-blocking duplicate-name warning against existing tenant parties.
- On success: navigate to Party detail and show a success toast.

### 12.10 Settings Section

**Settings** is the tenant-scoped administration area for tenant-specific data and rules. It appears in the administrative group at the bottom of the left navigation (12.1) for any user with permission to at least one of its subsections; only the subsections the user is permitted to access are shown. All content operates within the active tenant context.

Settings uses an internal **vertical tab navigation**, one tab per subsection:

| Subsection | Content |
|---|---|
| Brokers | Broker administration: list, add, edit, and disable brokers. Fields: broker name (required), broker type/tier (tenant list), branch, status (active/disabled), and broker contacts (name, email, phone; one marked primary). The broker view page also manages that broker's API access (see API access below). |
| Reference data | Manage the tenant-configurable lists in Section 6.1 - request channels (with the broker-channel flag), product lines, cover types per product line, party segments, industries, regions, party types, lead statuses, quote statuses, lost reasons, and broker types - with add, edit, disable, and reorder behavior per 6.2. |
| Business rules | Manage the tenant rule values from 5.1: high-value thresholds, SLA targets, quote expiry alert windows, follow-up thresholds, aging warning thresholds, unassigned-lead and stalled-item thresholds, the duplicate-lead check window, lead/quote reference formats, the lead inactivity expiry period, and pricing-approval targets. |
| Business assignments | Configure which roles are assignable to leads and to quotes, and which lead role is the accountable owner role (Section 8, 10.4). |
| API access | Tenant-level API intake credentials (9.4): enable or disable API access for the tenant. Enabling provisions the necessary Keycloak client and displays the API id, with the secret revealable/copyable and regenerable. Broker-level API credentials are provisioned the same way from the broker view page in the Brokers subsection. All provisioning, regeneration, and disabling actions are permission-bound and audited. |

Each subsection is individually permission-bound (Section 20.6), and all changes are audited.

### 12.11 Login and Authentication

**Access gating.** The entire application is gated behind authentication. Unauthenticated users can reach only the login page and the password reset flow; every other screen and API redirects to login. There is **no self-service sign-up**: user accounts are created and managed internally through User Manager (20.1.1) or backend administration. There is no anonymous functionality beyond password reset.

**Login page.**

| Element | Requirement |
|---|---|
| Branding | QuoteIQ logo above the form. A placeholder logo/wordmark ("QuoteIQ / Quotation Intelligence", matching the sidebar branding in 12.2) is used until a brand asset is provided. |
| Username | Text field labeled **Email** - the user's email address is the username (20.1.1). |
| Password | Password field with show/hide toggle. |
| Login button | Primary button **Log in**, with a busy state while authenticating and protection against double submission. |
| Forgot password | "Forgot password?" link opening the password reset flow below. |
| Errors | A failed login shows one generic message (e.g., "Incorrect email or password") that does not reveal which value was wrong or whether the account exists. Deactivated users cannot log in and receive the same generic message. |
| Post-login | Successful login lands the user in their last active tenant (5.3) on their default screen. |

**Password reset - the only anonymous flow.**

- "Forgot password?" asks for the account email and always shows the same confirmation ("If an account exists for this email, a reset link has been sent"), regardless of whether the account exists, to prevent account enumeration.
- The reset email contains a time-limited, single-use link to a page where the user sets a new password.
- Password resets are audited; the reset flow reveals no account details beyond the reset form itself.

**Identity provider note.** Authentication is delivered through the platform identity provider (Keycloak via OIDC, consistent with API access in 12.10). The login and reset pages may be served by the identity provider, themed to this specification so the experience is QuoteIQ-branded.

---

## 13. Executive Overview Dashboard

The Executive Overview provides a concise view of business health and immediate concerns for the active tenant. Layout per the Overview screenshot: a KPI row, a three-across chart row (Pipeline by Stage, Open Aging donut, Won vs Lost Trend), then a two-across bottom row (High-Value Opportunities table, Requires Attention panel).

### 13.1 KPI Cards

The prototype shows six cards; the product adds lead-clarity cards so lead and quote counts are never conflated (Section 7.4).

| KPI | Business Meaning | In Prototype Screenshot |
|---|---|---:|
| Total Quotes | Total formal quotes issued in selected period. | Yes (e.g., 1,248 ↑14%) |
| Open Pipeline Premium | Quoted or estimated premium still open. | Yes (BWP 128.6M) |
| Won Premium MTD/YTD | Premium converted into won business. | Yes (BWP 42.3M) |
| Conversion Rate | Share of decided opportunities that convert to won business. | Yes (33.9% ↑3.6pp) |
| Average Turnaround | Average time from lead received to quote sent; delta colored green when falling. | Yes (2.6 days ↓0.6) |
| Quotes at Risk | Open quotes that are stale, overdue, high-value, expiring, or SLA-breached; amber styling. | Yes (87 ↑15) |
| Total Leads | Total leads received in selected period. | Product addition |
| Lead-to-Quote Rate | Share of eligible leads that received at least one quote. | Product addition |
| Leads at Risk | Open leads that are stale, not assigned, delayed, or missing required next action. | Product addition |

### 13.2 Required Visualizations

| Visualization | Presentation (per screenshot) | Business Question Answered |
|---|---|---|
| Pipeline by Stage | Horizontal bar chart, one accent-colored bar per open stage, each labeled with count and share (e.g., "Information Gathering 842 · 67%"). Link "View full pipeline →". **Prototype deviation:** the screenshot's bars are cumulative reached-stage counts that include Won (New 1,248 · 100% down to Won 98 · 8%); that cumulative view is the Pipeline dashboard's conversion funnel (14.2). Here the product counts **current open items per stage**, with each bar's share taken over the open total. | How many open items are at each stage of the pipeline? |
| Open Quotes / Leads Aging | Donut with center total (e.g., "512 Open Quotes") and legend showing count and percentage per bucket: 0-3, 4-7, 8-14, 15+ days. Link "View aging report →". | How old is the open inventory? |
| Won vs Lost Trend | Line chart with a Weekly/Monthly selector (a dropdown in the prototype); Won Premium as a solid accent line, Lost Premium as a dashed purple line; compact currency y-axis. Link "View trend analysis →". | Are won and lost premiums trending favorably over time? |
| High-Value Opportunities | Table (13.3). Link "View all opportunities →". | Which material opportunities require attention? |
| Requires Attention | Alert panel (13.3). Links "View all alerts →" and "Go to alerts center →". | Which categories need action now? |

### 13.3 Executive Overview Table and Panel Requirements

The High-Value Opportunities table, per the screenshot plus product additions:

| Column | Notes |
|---|---|
| Client | With party-type icon. |
| Broker | - |
| Product | Product line / cover type. |
| Premium (BWP) | Right-aligned, full amount. |
| Stage | Status chip (shared chip palette). |
| Next Action | Action text with due date beneath (e.g., "Provide revised terms · Jun 2, 2025"). |
| Owner | Product addition. |
| Risk indicator | Product addition - flag chip where at risk. |

Rows drill through to Lead Detail.

The Requires Attention panel lists categories as rows with icon, title, one-line definition, count (color-coded by severity), and a chevron drilling into the Alerts center. Per the screenshot: Stalled Quotes ("Quotes with no activity in 7+ days"), Overdue Follow-ups ("Follow-ups past next action date"), Expiring Quotes ("Quotes expiring in 7 days or less"). The product should also surface, at minimum: SLA breaches, executive escalations, leads awaiting assignment, and leads awaiting underwriting or pricing approval.

---

## 14. Pipeline and Conversion Dashboard

The Pipeline and Conversion dashboard should give Sales and Sales Operations a more detailed operational view of lead flow, quote flow, conversion, and aging. Layout per the Pipeline screenshot: KPI row; chart row (Pipeline Stage Conversion funnel, Pipeline by Product Line stacked columns, Quote Volume by Source donut); bottom row (Aging by Stage heatmap, At-Risk Pipeline table, Immediate Actions panel).

### 14.1 KPI Cards

| KPI | Business Meaning | In Prototype Screenshot |
|---|---|---:|
| New Leads This Month | Count of new leads received in the selected period. | Yes (labeled "New Quotes This Month") |
| Open Pipeline Value | Total premium value still open. | Yes (BWP 128.6M) |
| Quote-to-Proposal Rate | Share of eligible leads/quotes that progressed to quote sent. | Yes (34.7% ↑3.6pp) |
| Proposal-to-Win Rate | Share of sent quotes that converted to won business. | Yes (28.9% ↑2.4pp) |
| Average Quote Age | Average age of open quote records after quote issue. | Yes (6.1 days ↓0.8) |
| SLA Breaches | Number of leads or quotes breaching agreed turnaround or follow-up rules; amber styling. | Yes (37 ↑12) |
| Quotes Issued This Month | Count of quotes sent or issued in the selected period. | Product addition |
| Lead-to-Quote Rate | Share of leads that progressed to formal quote. | Product addition |
| Average Lead Age | Average age of open lead records. | Product addition |

### 14.2 Required Visualizations

| Visualization | Presentation (per screenshot) | Business Question Answered |
|---|---|---|
| Pipeline Stage Conversion | Tapered funnel in an accent gradient; each stage labeled with count and conversion-from-top percentage (New 1,248 · 100% → Won 132 · 11%, Lost shown last in red). Link "View full conversion report →". | Where do leads and quotes drop off in the pipeline? |
| Pipeline by Product Line | Stacked vertical columns by month (open pipeline value), one color per product line with legend (e.g., Motor navy, Property teal, Engineering green, Marine purple, Group Life orange); monthly totals labeled above columns. Link "View product line breakdown →". | Which product lines make up open pipeline value over time? |
| Quote Volume by Source | Donut with center total and legend showing each broker/source with count and share (e.g., "TradeSure Brokers 412 · 33%"). Link "View source performance →". | Which brokers or sources are generating quote volume? |
| Lead Volume by Channel | Donut or bar chart of leads by request channel. | Which request channels generate lead volume? *Product addition - not in prototype.* |
| Aging by Stage | Heatmap matrix: one row per **open** stage, columns 0-3, 4-7, 8-14, 15-30, 31-60, 60+ days plus Total; counts are of open items; cell backgrounds graded green → amber → red by concentration. Link "View aging analysis →". **Prototype deviation:** the screenshot (titled "Number of Quotes") includes Won and Lost rows; the product omits closed stages - aging is meaningful only for open inventory. | Which stages have aging or backlog problems? |
| At-Risk Pipeline | Action table (14.3). Link "View full at-risk pipeline →". | Which specific leads or quotes need intervention? |
| Immediate Actions | Action panel (14.4). Link "Go to alerts center →". | What categories require action today? |

### 14.3 At-Risk Pipeline Table Requirements

Columns per the screenshot, plus product additions:

| Column | Notes |
|---|---|
| Client | - |
| Broker | - |
| Premium (BWP) | Right-aligned. |
| Stage | Status chip. |
| Age | Days, colored amber/red by threshold. |
| Owner | - |
| Risk Reason | Short text (see list below). |
| Lead ID / Quote reference | Product addition - link to Lead Detail. |
| Tenant | Product addition - only in Internal cross-tenant mode. |
| Suggested or required action | Product addition. |

Risk reasons should include examples such as:

- Lead not assigned.
- Pricing approval delayed.
- Client feedback pending.
- Terms under review.
- Additional information requested.
- Awaiting underwriting.
- Quote near expiry.
- No activity within defined threshold.
- Follow-up overdue.
- High-value lead stalled.

### 14.4 Immediate Action Categories

The Immediate Actions panel lists categories as rows with icon, title, one-line definition, and color-coded count. Per the screenshot: Overdue Quotes ("Quotes past initial SLA"), Pending Pricing Approvals, Exec Escalations ("Requires executive attention"), SLA Breaches. The product should additionally support:

- Unassigned leads.
- Overdue follow-ups.
- Expiring quotes.
- Follow-ups due today.

Each row drills into the Alerts center pre-filtered to that category.

---

## 15. Broker and RM Performance Dashboards

Two related dashboards, matching the two navigation entries and screenshots, help management understand who is driving value and where coaching or broker engagement is needed.

### 15.1 Broker Performance Dashboard (nav: Brokers)

Per the Brokers screenshot: KPI row, then Top Brokers ranking beside the Broker Performance Matrix, then a full-width broker ranking table.

**KPI cards:**

| KPI | Business Meaning |
|---|---|
| Active Brokers | Number of tenant-scoped brokers/partners contributing lead or quote activity in the period. |
| Broker Quotes | Quote volume originated via brokers in the period. |
| Broker Conversion | Conversion rate across broker-originated business. |
| Won via Brokers | Premium won through broker channels (BWP). |
| Avg Turnaround | Average turnaround for broker-originated items; falling delta shown green. |
| Overdue Follow-ups | Broker-related follow-ups past their next action date. |

**Visualizations:**

| Visualization | Presentation (per screenshot) | Business Question Answered |
|---|---|---|
| Top Brokers / Partners | Horizontal bar ranking by quote volume, with quote count and conversion % columns beside each bar. | Which brokers generate the most quote activity and conversion? |
| Broker Performance Matrix | Scatter plot: x = quote volume, y = conversion rate, bubble size = won premium; points colored by quadrant (15.3 legend). | Which brokers are high-value partners, volume sources, or underperformers? |
| Broker Performance table | All partners ranked by volume. Columns: Broker (name + primary contact) · Tier (chip) · Branch · Quotes · Conversion (%; green when strong, red when weak) · Won Premium · Avg TAT · Overdue (count) · Top Loss Reason. | How does every broker compare, and where are the loss patterns? |

### 15.2 RM Performance Dashboard (nav: RM Performance)

Per the RM & Broker Performance screenshot. The filter bar uses **RM / Team** instead of RM and **Broker Type** instead of Broker.

**KPI cards:**

| KPI | Business Meaning |
|---|---|
| Active RMs | Number of tenant-scoped RMs handling leads or quotes in selected period. |
| Active Brokers | Number of tenant-scoped brokers/partners contributing activity. |
| Won Premium YTD | Premium won during year-to-date or selected period. |
| RM Conversion Rate | Conversion performance for relationship managers. |
| Broker Conversion Rate | Conversion performance across brokers. |
| Follow-up Compliance | Percentage of required follow-ups completed on time. |

**Visualizations:**

| Visualization | Presentation (per screenshot) | Business Question Answered |
|---|---|---|
| Top Relationship Managers | Horizontal bar ranking by won premium with a conversion % column. Link "View all RMs →". | Which RMs are producing the highest won premium and conversion? |
| Top Brokers / Partners | Horizontal bar ranking by quote volume with conversion % column. Link "View all brokers →". | Which brokers generate the most quote activity and conversion? |
| Broker Performance Matrix | Quadrant scatter (as 15.1), with four-color quadrant legend. | Which brokers deserve which management response? |
| Turnaround (SLA) by RM / Team | Horizontal bars per team with a dashed SLA target marker (e.g., "SLA Target: 3 Days"); bars beyond target flagged. Metric dropdown (e.g., Avg Turnaround (Days)). | Which teams or segments are slower than target? |
| Performance Watchlist | Table: RM / Broker · Quotes · Won Premium · Conversion · Avg Turnaround · Overdue Follow-ups · Suggested Action (color-coded chip, 15.4). Link "View full watchlist →". | Who requires retention, coaching, engagement, more leads, or escalation? |
| Leadership Insights | Insight panel: icon + headline + one-line narrative per insight (top performing broker, underperforming RM, turnaround at risk, follow-up compliance, largest premium opportunity). Link "View all insights →". | What should leadership notice without interpreting every chart? |

### 15.3 Broker Performance Matrix Quadrants

The scatter plot should classify brokers into business-action categories:

| Quadrant | Meaning | Suggested Management Response |
|---|---|---|
| High Volume / High Conversion | Strategic growth partner. | Maintain momentum, deepen relationship, allocate support. |
| High Volume / Low Conversion | Busy but inefficient or price-shopping source. | Investigate loss reasons, coach broker, review pricing/product fit. |
| Low Volume / High Conversion | Potential growth opportunity. | Provide more leads, improve engagement, identify expansion potential. |
| Low Volume / Low Conversion | Low priority or problem channel. | Review relationship value, reduce effort, or intervene selectively. |

The two prototype screens color the quadrants differently (e.g., low-volume/high-conversion is blue on Brokers and purple on RM Performance). The product uses one consistent quadrant palette on both dashboards, defined in `QuoteIQ_UI_Standards.md`.

### 15.4 Performance Watchlist Suggested Actions

The product should support management labels such as:

- Maintain momentum.
- Recognize and retain.
- Deepen engagement.
- Provide more leads.
- Coach and support.
- Escalate and intervene.
- Review relationship.

---

## 16. Loss Analysis Dashboard

The Loss Analysis dashboard should help management understand why business is being lost and whether action is needed on pricing, product, service, broker engagement, or underwriting speed. Layout per the Loss Analysis screenshot: KPI row; chart row (Lost Premium by Reason, Lost Premium Trend); second row (Lost Premium by Product Line, Competitor Analysis); full-width Loss Commentary feed.

### 16.0 KPI Cards

| KPI | Business Meaning |
|---|---|
| Lost Premium | Total premium lost in period (BWP); a falling delta is good and shown green. |
| Quotes Lost | Count of quotes lost in period. |
| Top Loss Reason | Most frequent structured loss reason (e.g., "Pricing"). |
| Avg Price Gap | Average % difference between our quoted premium and the winning/competitor price, where known. |
| Top Competitor | Competitor winning the most lost business. |

The prototype's **Win-back Potential** card is deliberately excluded from the product.

### 16.1 Required Loss Reasons

The MVP should include a structured lost reason list that is configurable by tenant. Recommended initial values:

- Pricing too high.
- Competitor won.
- Incumbent retained.
- Tender exercise only.
- Coverage gap.
- Terms not accepted.
- Service concern.
- Brand / trust concern.
- Underwriting declined.
- No response.
- Decision postponed.
- Quote expired.
- Lost before quote issued.
- Other (requires a loss comment when selected).

This list is identical to the taxonomy in Appendix C, which describes when each reason applies.

### 16.2 Required Visualizations

On the dashboard, per the screenshot:

| Visualization | Presentation | Business Question Answered |
|---|---|---|
| Lost Premium by Reason | Horizontal bar chart in the danger/red hue, one bar per reason, labeled with amount (e.g., "Pricing · BWP 6.7M"). | Which reasons account for the most lost premium? |
| Lost Premium Trend | Line chart with soft area fill, last 6 months. | Is lost premium rising or falling? |
| Lost Premium by Product Line | Horizontal bar chart (amber/orange hue), one bar per product line with amount. | Which products are losing the most premium? |
| Competitor Analysis | Table "Where business is going": Competitor · Deals Lost · Premium Lost · Avg Price Gap (%). | Which competitors are most frequently winning, and at what price distance? |
| Loss Commentary | Feed of recent lost-business notes: client + product line, one-line comment, loss-reason chip, premium amount. | What is the qualitative story behind recent losses? |

Available as drill-downs or report views (not required on the dashboard face):

| View | Business Question Answered |
|---|---|
| Lost lead / lost quote count by reason | Which reasons occur most often, and do pre-quote losses differ from post-quote losses? |
| Loss trend by reason over time | Are specific loss reasons increasing or decreasing? |
| Loss by cover type | Which cover types are losing and why? |
| Loss by broker | Which brokers have recurring loss patterns? |
| Loss by RM | Which RMs may need coaching or support? |
| Price difference analysis | Where known, how far away was pricing from competitor/client expectation? |

### 16.3 Loss Drilldown Fields

Loss analysis drilldowns should include:

- Client.
- Broker.
- RM.
- Product line.
- Cover type.
- Quoted premium.
- Lost premium.
- Lost reason.
- Whether the opportunity was lost before quote or after quote.
- Competitor won, where known.
- Competitor premium, where known.
- Decision date.
- Loss comments.
- Whether management intervention occurred.

---

## 17. SLA and Turnaround Visibility

SLA and turnaround visibility should expose delays that affect quote conversion and broker/client experience. There is **no dedicated SLA navigation entry** in the prototype; the product delivers these metrics where the screenshots place them: the SLA Breaches KPI and Aging by Stage heatmap on the Pipeline dashboard (14), Turnaround (SLA) by RM / Team on RM Performance (15.2), Avg Turnaround on Brokers (15.1), the SLA tab of the Alerts center (18), and the SLA / Turnaround report (19). A standalone dashboard may be added later if pilot usage demands it.

### 17.1 Required Metrics

| Metric | Business Meaning |
|---|---|
| Lead Received-to-Assignment Time | How quickly leads are acknowledged and owned. |
| Lead Received-to-Quote Prepared Time | How quickly the organization can prepare a quote after lead receipt. |
| Quote Prepared-to-Sent Time | Whether prepared quotes are being sent promptly. |
| Quote Sent-to-Decision Time | How long brokers/clients take to respond. |
| Underwriting Time | How long underwriting inputs take. |
| Average Turnaround by Product | Which products take longer to quote. |
| Average Turnaround by Cover Type | Which cover types take longer to quote. |
| Average Turnaround by RM/Team | Which teams are meeting expectations. |
| SLA Breaches | Count and value of leads or quotes exceeding tenant-specific targets. |

### 17.2 Required Visualizations and Where They Live

| Visualization | Chart Type | Location | Business Question Answered |
|---|---|---|---|
| Turnaround by Product / Team | Horizontal bar chart with dashed SLA target marker | RM Performance dashboard (15.2) | Which areas are slower than target? |
| SLA Breach Count | KPI card with trend delta | Pipeline dashboard (14.1) | Are SLA breaches increasing? |
| SLA Breaches by Stage | Bar chart | SLA / Turnaround report (19) | Where are delays occurring? |
| Aging by Stage | Heatmap table | Pipeline dashboard (14.2) | Which status stages have stale lead or quote inventory? |
| Underwriting Delay Queue | Table | Alerts center SLA tab (18) and SLA / Turnaround report | Which leads are awaiting underwriting beyond SLA? |

---

## 18. Alerts and Escalation Requirements

Alerts should convert dashboards into action. The product should surface items that need immediate attention.

### 18.1 Alert Types

| Alert | Trigger |
|---|---|
| Unassigned lead | Lead has been received but not assigned within tenant-configured threshold. |
| Overdue follow-up | Next follow-up date is in the past and lead/quote is still open. |
| Stalled lead | No activity for a configured number of days before a quote is issued. |
| Stalled quote | No activity for a configured number of days after a quote is issued. |
| Quote expiring soon | Quote valid-until date is within configured threshold. |
| Expired quote | Quote valid-until date has passed and quote is not closed. |
| SLA breach | Lead, quote, or underwriting turnaround exceeds target. |
| High-value stalled opportunity | Premium exceeds tenant-specific threshold and opportunity is stale, overdue, or blocked. |
| Pending pricing approval | A pricing approval request (10.4) has been pending beyond the tenant-configured target. |
| Awaiting underwriting | Lead is assigned to underwriting beyond target. |
| Executive escalation | Item requires leadership attention due to value, age, strategic client, or repeated delay. |

### 18.2 Alerts Center Screen

Per the Alerts & Escalation screenshot ("Where to intervene"):

| Area | Requirement |
|---|---|
| Category summary cards | A row of cards, one per alert category, each with icon, category name, one-line definition, and count: Escalated ("High-value & stalled"), Stalled ("No activity 7+ days"), Overdue ("Follow-up overdue"), Expiring ("Within 7 days / expired"), SLA Breaches ("UW beyond SLA"). Clicking a card activates the matching queue tab. |
| Escalation Queue header | Title plus a rollup: "Premium at risk: BWP 6.3M · 12 quotes". Tab filters with counts: All · Escalated · Overdue · Expiring · SLA. |
| Queue table columns | Quote / Lead ref (monospace) · Client (with product line beneath) · Broker (or "Direct") · Premium at Risk (right-aligned) · Stage (chip) · Age (amber/red past thresholds) · Owner · Flags (chips such as `Escalated`, `Follow-Up Due`) · Action. |
| Action column | A contextual link per row that opens the appropriate workflow dialog (12.8): **Assign & acknowledge** for unassigned/new items, **Follow up** for overdue follow-ups, **Executive review** for escalated items. Completing the action clears or downgrades the alert. |
| Filters | Standard filter bar, plus filtering by owner, product, cover type, region, priority, and (where permitted) tenant. |
| Drill-through | Row click opens Lead Detail with the alerting quote highlighted. |
| New-alert badge | The Alerts nav item and the header notification bell show the count of alerts created since the current user last opened the Alerts center. Opening the Alerts center resets the count to zero for that user. The count is per-user; it is a "new since last visit" indicator, not the number of open alerts. |

---

## 19. Reports and Export Requirements

The product should support weekly sales and management reporting without requiring manual spreadsheet reconstruction.

### 19.0 Reports Screen

Per the Reports & Exports screenshot ("Weekly cadence"):

- Intro line explaining that CSV exports and print-ready PDF views are produced from live data.
- A grid of report cards, each with an icon, report name, one-line description, and two buttons: primary **Open report** (opens the print-ready view) and secondary **CSV**. Cards shown in the prototype: Executive Weekly Report, Pipeline & Conversion, Broker Performance, RM Performance, Loss Analysis, SLA / Turnaround - mapping to the standard reports in 19.1.
- Scheduled report distribution is **out of scope for the MVP**: reports are generated on demand. The prototype's "Scheduled & recent" panel and cadence label are not built (A.7).

### 19.1 Standard Reports

| Report | Audience | Purpose |
|---|---|---|
| Executive Overview Report | MD, Head of Sales, ExCo | Summarize lead activity, quote activity, won/lost premium, conversion, risk, and intervention items. |
| Pipeline Aging Report | Sales Head, RMs, Sales Ops | Show open leads/quotes by age, stage, owner, and premium. |
| Broker Performance Report | Sales Head, Broker Management | Compare broker volume, conversion, won premium, turnaround, and loss reasons. |
| RM Performance Report | Sales Head | Compare RM activity, conversion, follow-up compliance, and overdue items. |
| Loss Analysis Report | Sales, Product, Underwriting, Management | Identify why business is being lost. |
| SLA / Turnaround Report | Sales and Underwriting | Track lead speed, quote speed, underwriting turnaround, and breach patterns. |
| Escalation Queue Report | Management | Focus on high-value stalled, overdue, or expiring opportunities. |
| Tenant Configuration Report | Tenant Admin, Internal | Review tenant reference lists and configured business rules. User and role information should be managed through User Manager. |
| Internal Tenant Overview Report | Internal users | View tenant status, active users, lead/quote volumes, and adoption health. |

### 19.2 Export Requirements

- Export dashboard data to Excel or CSV.
- Export dashboard snapshots or reports to PDF.
- Preserve active filters in exported reports.
- Include tenant name, report date, data period, currency, and last refreshed timestamp.
- Allow users to export detailed lead and quote lists behind dashboard summaries.
- Cross-tenant exports should be restricted to Internal users with explicit permission.

---

## 20. Role-Based Access Control Requirements

Access should be role-based from the first version. The model must support tenant-level roles and global/Internal permissions.

### 20.1 RBAC Model

QuoteIQ must support:

- **Permissions**: granular capabilities such as create lead, update lead, view dashboard, manage tenant users, manage global tenants, export reports, manage reference data, etc.
- **Roles**: named collections of permissions.
- **User Groups**: named groups that can contain users and have roles assigned.
- **Users**: individual accounts that can belong to one or more tenants.
- **Direct User Role Assignments**: roles assigned directly to users.
- **Direct User Permission Assignments**: exceptional permissions assigned directly to users without creating a role.
- **Group Role Assignments**: roles assigned to groups, inherited by users in those groups.
- **Group Memberships**: users assigned to groups within a tenant or globally where appropriate.

### 20.1.1 User Manager Section Requirements

The left navigation must include a **User Manager** section. This section must be permission-bound and should only appear to users with user/access-management permissions. User Manager is the administration area for managing users, roles, user groups, and permission assignments.

#### User Groups

User Manager must allow authorized administrators to add, view, edit, and remove or disable user groups.

| Field / Capability | Requirement |
|---|---|
| Group name | Required. Each user group must have a clear name. |
| Assigned roles | Administrators can assign one or more roles to a user group. |
| Assigned permissions | Administrators can assign one or more direct permissions to a user group where the business wants group-level permission exceptions. |
| Group members | Administrators can add users to the group and remove users from the group. |
| Scope | Groups should operate within the active tenant context unless they are explicitly global/Internal groups. |
| Auditability | Group creation, edits, role/permission changes, and membership changes should be auditable. |

#### Roles

User Manager must allow authorized administrators to add, view, edit, and remove or disable roles.

| Field / Capability | Requirement |
|---|---|
| Role name | Required. Each role must have a clear business name. |
| Permissions | A role is a named group of permissions. Administrators can assign one or more permissions to a role. |
| Role usage visibility | Administrators should be able to see which users or groups currently use a role before disabling or removing it. |
| Scope | Roles should operate within the active tenant context unless they are explicitly global/Internal roles. |
| Auditability | Role creation, edits, permission changes, and removal/disablement should be auditable. |

#### Users

User Manager must allow authorized administrators to add, view, edit, deactivate, and manage users.

| Field / Capability | Requirement |
|---|---|
| First name | Required when adding a user. |
| Last name | Required when adding a user. |
| Email | Required when adding a user. Email is the primary user contact and login identifier. |
| Tenant assignment | A normal user must be assigned to at least one tenant. A user may be assigned to multiple tenants. |
| Assigned roles | Administrators can assign one or more roles directly to the user. |
| Assigned permissions | Administrators can assign one or more direct permissions to the user for exceptions that are not covered by roles or groups. |
| User group membership | Administrators can add the user to one or more user groups. |
| Tenant-specific access | Users may have different roles, permissions, and group memberships in different tenants. |
| Internal access | Users with the Internal role or equivalent global permissions can view any tenant and use the tenant switcher according to their permissions. |
| Deactivation | Users should be deactivated rather than hard-deleted so audit history remains intact. |
| Auditability | User creation, edits, deactivation, tenant assignment changes, role changes, permission changes, and group membership changes should be auditable. |

User Manager should make effective access understandable to administrators by showing, at minimum, a user's direct roles, direct permissions, group memberships, and tenant assignments.

### 20.2 Tenant Membership

| Requirement | Description |
|---|---|
| Minimum tenant assignment | Every normal user must be assigned to at least one tenant. |
| Multiple tenant assignment | A user may be assigned to multiple tenants. |
| Tenant-scoped permissions | Permissions should generally apply within a tenant context unless explicitly global/Internal. |
| Tenant switching | Users with multiple tenants must be able to switch active tenant context. |
| Tenant-specific roles | A user may have different roles in different tenants. |
| Tenant-specific groups | A user may belong to different groups in different tenants. |
| Deactivation | Removing a user from a tenant should remove their access to that tenant’s data without deleting historical audit records. |

### 20.3 Internal Role

The product must include an **Internal** role for global platform users.

| Internal Role Capability | Requirement |
|---|---|
| Manage tenants | Create, edit, activate, deactivate, and view tenants. |
| Manage global defaults | Manage global default templates for reference data and initial tenant setup. |
| View any tenant | Internal users can view any tenant, subject to Internal permissions. |
| Tenant switching | Internal users can switch into any tenant context. |
| Cross-tenant oversight | Internal users can access cross-tenant operational or adoption dashboards where permitted. |
| Global user support | Internal users can support tenant administration where permitted. |
| Audit access | Internal users can review audit information across tenants where permitted. |

Internal access should be powerful and therefore clearly permissioned, auditable, and limited to users explicitly assigned the Internal role or equivalent global permissions.

### 20.4 Recommended Business Roles

| Role | Scope | Business Access |
|---|---|---|
| Internal | Global | Manage tenants, global defaults, and view any tenant where permitted. |
| Tenant Admin | Tenant | Manage tenant users, tenant roles/groups, tenant reference lists, business rules, and all tenant records. |
| Sales Head | Tenant | View all dashboards, manage escalations, review all tenant leads/quotes, assign/reassign ownership, export reports. |
| Relationship Manager | Tenant | Create and update assigned leads/quotes, manage follow-ups, update status, add notes, close won/lost where permitted. |
| Underwriter | Tenant | View assigned underwriting items, update underwriting status, add delay reasons, mark quote prepared where permitted. |
| Sales Operations/Admin | Tenant | Create and maintain lead/quote records, support data quality, run reports, assist with updates. |
| Executive Viewer | Tenant | Read-only access to executive dashboards, trends, alerts, and reports. |
| Broker / Partner - future | Tenant-scoped external | Submit or view limited lead/quote status only if external access is approved. |

### 20.5 Access Principles

- Executive viewers should be read-only.
- RMs should be able to manage their own assigned leads and quotes and see relevant team-level reporting depending on tenant policy.
- Sales leadership should see all commercial performance data within their tenant.
- Underwriters should see data required to support quote preparation and SLA management.
- Tenant Admins and Sales Operations should be able to correct data quality issues within their tenant.
- Internal users can view any tenant and manage global platform data.
- Closed lead and quote changes should be limited or logged clearly.
- Cross-tenant access must be restricted to Internal users or explicitly authorized multi-tenant users.
- Effective permissions should be understandable to administrators, including permissions inherited from groups and roles.

### 20.6 Example Permission Categories

| Category | Example Permissions |
|---|---|
| Tenant management | View tenant, create tenant, edit tenant, deactivate tenant, manage tenant settings. |
| User and access management | Invite user, assign tenant, assign role, assign group, manage roles, manage groups, grant direct permission. |
| Lead management | Create lead, view lead, update lead, assign lead, request pricing approval, approve/reject pricing, close lead, delete/void lead, export leads. |
| Party management | Create party, view party, update party, export parties. |
| Quote management | Create quote, view quote, update quote, revise quote, mark quote sent, close quote won/lost, export quotes. |
| Broker management | Create broker, update broker, disable broker, manage broker contacts, manage broker API access, view broker performance. |
| API access | Enable/disable tenant API access, view API credentials, regenerate secrets. |
| RM management | Manage RM assignments, view RM performance, reassign leads. |
| Reference data | Manage request channels, product lines, cover types, segments, industries, regions, party types, lost reasons. |
| Dashboards and reports | View executive dashboard, view pipeline dashboard, view loss dashboard, export reports. |
| Alerts and escalation | View alerts, assign alert owner, escalate item, clear/resolve alert. |
| Internal/global | Manage global defaults, view all tenants, cross-tenant reporting, global audit access. |

---

## 21. Business Data Quality Requirements

The value of the dashboards depends on consistent data capture. The product should enforce simple business rules.

### 21.1 Mandatory Structured Fields

The MVP should avoid excessive free text for fields used in reporting. The following should be structured wherever possible and configurable by tenant where noted:

- Request channel.
- Product line.
- Cover type.
- Broker.
- RM.
- Region.
- Party type.
- Existing/new client.
- Segment.
- Industry / sector.
- Lead status.
- Quote status.
- Lost reason.
- SLA status.
- Alert reason.

### 21.2 Validation Requirements

- A user must operate within a valid tenant context before creating or viewing tenant-scoped records.
- Mandatory fields must be completed before a lead can be submitted or moved to relevant stages.
- A formal quote cannot exist without an associated lead.
- Lost leads or quotes must have a lost reason. When the lost reason is Other, a loss comment is required (Appendix C).
- Won quotes must have bound premium and decision date.
- Open leads past the Quote Sent stage should have a next follow-up date.
- Quote expiry date should be required once a quote is sent, unless business rules allow exceptions.
- Premium values should be numeric and displayed in the tenant's configured display currency (a presentation-only tenant setting, default BWP). Individual leads and quotes do not store a per-record currency.
- Date fields should be logically consistent: sent date cannot precede received date, decision date cannot precede sent date unless exception is recorded.
- Duplicate lead warnings should be shown when the same client, broker, product, and date range appear similar within the same tenant.
- Tenant-scoped reference data must come from the active tenant’s configuration.
- Internal users should not accidentally create tenant-scoped records without selecting or confirming the tenant context.

---

## 22. Business Metrics Definitions

Final metric formulas should be confirmed with the client during discovery. The MVP should make definitions visible to avoid reporting disputes.

| Metric | Proposed Definition |
|---|---|
| Total Leads | Count of leads created or received during selected period. |
| New Leads This Month | Count of leads received in the current month. |
| Total Quotes | Count of formal quotes created or sent during selected period. |
| Leads Without Quote | Count of open leads that have no associated quote yet. |
| Open Pipeline Premium | Sum of quoted premium for open quotes plus estimated premium for open leads without quotes, depending on selected view. |
| Quoted Premium | Sum of premium on formal quotes issued in the selected period. |
| Won Premium | Sum of bound premium for quotes marked Won in the selected period. |
| Lost Premium | Sum of quoted premium for quotes marked Lost in the selected period. |
| Lead-to-Quote Rate | Leads with at least one formal quote divided by eligible leads. |
| Conversion Rate / Hit Ratio | Won quotes divided by decided quotes, or won premium divided by quoted premium, depending on agreed business definition. |
| Quote-to-Proposal Rate | Quotes that reach Proposal Sent divided by total eligible leads or quotes, depending on agreed business definition. |
| Proposal-to-Win Rate | Won quotes divided by quotes that reached Proposal Sent. |
| Average Lead Age | Average days since date received for open leads. |
| Average Quote Age | Average days since quote sent for open quotes. |
| Average Turnaround | Average days from lead received to quote sent, unless filtered to a different turnaround dimension. |
| Follow-up Compliance | Percentage of required follow-ups completed by or before next follow-up date. |
| SLA Breaches | Count of leads or quotes exceeding configured turnaround or follow-up targets. |
| Leads at Risk | Count of open leads that meet at least one risk rule: stale, unassigned, no activity, high-value, or SLA breached. |
| Quotes at Risk | Count of open quotes that meet at least one risk rule: stale, overdue, expiring, high-value stalled, or SLA breached. |

---

## 23. POC Demo Journey

The POC should be visually convincing and operationally believable. It should demonstrate the real business workflow, not only static dashboard screens.

| Step | Demo Moment | Business Outcome Shown |
|---|---|---|
| 1. Tenant setup | Create or select a tenant and configure core lists. | The product can support different insurers/business units with tenant-specific configuration. |
| 2. Lead intake | Capture a lead through the intake form. | The organization can consistently capture client, broker, RM, product, premium estimate, date received, and channel. |
| 3. Quote creation | Create a quote associated with the lead. | The product distinguishes the original lead from the formal quote issued to the requester. |
| 4. Workflow movement | Move the lead and quote through the lifecycle. | The opportunity can be assigned, prepared, sent, followed up, and closed won/lost with required business data. |
| 5. Control tower | Show the dashboards. | Management can see pipeline value, stalled leads, quote performance, RM performance, broker conversion, turnaround, and loss reasons. |
| 6. Access control | Show different user roles or tenant switching. | The product supports controlled tenant-specific access and Internal oversight. |

### 23.1 Seed and Demonstration Data

To make the POC believable and to exercise every capability without an operator first entering data by hand, the application must ship with a seed data set that can be loaded into a fresh environment.

The numbers below are **minimums**, not caps or exact targets — the goal is enough realistic volume and spread that dashboards, filters, aging buckets, alerts, and performance views are meaningful rather than empty. The specific names, values, and exact per-record details are an implementation detail to be produced during the build; the seed generator may reasonably exceed these minimums.

#### Entities and Minimum Volumes

All records below belong to the single seeded tenant (for example, the pilot tenant "The Brittany"), which is created with its tenant profile and its auto-populated reference data (Section 6.4).

| Entity | Minimum count | Distribution / notes |
|---|---:|---|
| Tenant | 1 | The pilot tenant, with contact profile and full auto-seeded reference data (Section 6.4). |
| Users | 15 | Spread across the recommended business roles (Section 20.4): at least 1 Internal, 1 Tenant Admin, 1 Sales Head, 6 Relationship Managers, 3 Underwriters, 1 Sales Operations, and 2 Executive Viewers. Six-plus RMs are required so RM Performance comparisons are meaningful. |
| Brokers | 18 | Spread across all broker tiers (Tier 1/2/3 and Direct, Section 6.3) with contacts, so the broker performance matrix and quadrants populate. Include a few high-volume and a few underperforming brokers. |
| Parties | 200 | Mix of party types, segments, industries, and regions; a mix of existing clients and new business; a handful flagged strategic. |
| Leads | 300 | Distributed across the lifecycle and reference data as detailed below. |
| Quotes | 500 | Roughly 1.5–2 quotes per quoted lead: most quoted leads have one quote, some have 2–3 (revisions, alternative options, re-quotes) so version history and "current quote" behavior are demonstrable. Not every lead has a quote (leads lost/withdrawn before quote must exist). |
| Follow-ups | 400 | Logged against leads past Quote Sent and elsewhere, including several overdue, so follow-up compliance and overdue alerts populate. |
| Pricing approval requests | 40 | Pricing approval is the only approval workflow in the MVP (10.4); seed it across all three states: ~20 Approved (on leads that progressed to quotes, including some now Won, so approvals appear in closed-lead history), ~10 Rejected (at least a few followed by a re-request that was later approved, to demonstrate the rework loop), and ~10 Pending on leads currently in Pricing - of which at least 5 are pending beyond the tenant pricing-approval target so the pending-pricing-approval alert (18.1) and the Immediate Actions panel (14.4) populate. |
| Status history entries | — | Every seeded lead and quote must carry a plausible append-only status history (Section 7.3) reflecting how it reached its current state, so timelines and turnaround/aging metrics are real rather than blank. |

#### Lead Lifecycle Distribution (of the 300 leads)

Seeded leads must be spread across the lifecycle (Section 10) so every dashboard, conversion metric, and loss view has data:

- **~135 open** across the open stages (New, Assigned, Information Gathering, Underwriting, Pricing, Quote Sent, Negotiation), weighted toward the middle of the pipeline; include at least 5 unassigned (New) leads to populate the awaiting-assignment alert.
- **~45 Closed Won**, each with an associated Won quote and a bound premium.
- **~75 Closed Lost**, each with a structured lost reason spread across the full lost-reason taxonomy (Appendix C / Section 16.1); include both "lost before quote" and "lost after quote" cases, and some with competitor and competitor-premium captured.
- **~30 Expired** and **~15 Withdrawn** to exercise those reporting categories.
- Additionally, at least **15 of the leads above** (spanning open and closed) should be high-value - above a plausible tenant high-value threshold - some of them stalled, to populate high-value-opportunity views and escalations. High value is a flag, not a lifecycle state, so these overlap with the lifecycle counts above (which sum to ~300).

#### Quote Lifecycle Distribution (of the 500 quotes)

Spread quotes across quote statuses (Section 10.2): Draft, Sent, Revised, Won, Lost, Expired, and Withdrawn. At least ~40 quotes should be **Sent and currently open**, with a subset carrying a valid-until date inside the expiry-alert window (and a few already past it) so expiring/expired-quote alerts populate.

#### Cross-Cutting Requirements

| Requirement | Description |
|---|---|
| At-risk and alert conditions | At least ~20 records should deliberately meet each of the main risk/alert rules (stalled, overdue follow-up, expiring quote, SLA breach, high value, unassigned), plus at least 5 each for the remaining alert types in 18.1 (pending pricing approval, awaiting underwriting, executive escalation), so the alerts center and "requires attention" panels are populated in every category. |
| Spread across reference data | Leads and quotes must be spread across product lines, cover types, brokers, RMs, regions, request channels, segments, and industries so filtering and breakdown visualizations are demonstrable. |
| Realistic dates and premiums | Dates should span roughly the last 6–12 months and premiums should use plausible BWP values, so trend charts, aging, turnaround, and premium KPIs render sensibly. |
| Repeatable and idempotent | The seed process must be runnable against a fresh environment to reach a known demonstrable state, and must be easily updateable as the product evolves. |

### POC Success Standard

After a 10-minute demonstration, the MD and Head of Sales should be able to understand:

- Where the lead and quote pipeline stands.
- How much premium is open, won, lost, or at risk.
- Which brokers and RMs are performing well or poorly.
- Which leads or quotes need intervention.
- Where premium is leaking.
- Who needs to act next.
- How the same product can support multiple tenants without mixing data.

---

## 24. Adoption and Change Management Requirements

The main adoption risk is that RMs may see the product as a policing tool. The business positioning should be that QuoteIQ helps win more business, protect pipeline value, and get management support for important opportunities.

| Risk | Mitigation |
|---|---|
| RM resistance | Position as sales support and revenue protection, not surveillance. Keep capture easy. |
| Poor data quality | Use tenant-specific dropdowns, mandatory fields, validation, and clear definitions. |
| Workflow complexity | Start with the minimum viable workflow and refine after pilot usage. |
| Leadership loses interest | Provide a sharp weekly dashboard tied to actual management decisions. |
| Integration delays | Start standalone unless integration is a pilot condition. |
| Misaligned ownership | Agree who owns lead and quote updates at each stage: RM, Sales Admin, or Underwriting. |
| Dashboard mistrust | Publish metric definitions and ensure users understand what each KPI means. |
| Tenant misconfiguration | Seed sensible defaults and limit configuration to users with clear administrative responsibility. |
| Access control confusion | Provide clear role templates and show effective permissions to administrators. |

---

## 25. MVP Acceptance Criteria

The MVP should be considered successful when the following conditions are met.

### 25.1 Multi-Tenancy

- Internal users can create and manage tenants.
- Tenant Manager is visible only to users with tenant-management permissions.
- Authorized users can add a tenant using tenant name.
- Authorized users can view and edit tenant name.
- Authorized users can remove a tenant, and removal is a soft delete rather than a hard delete.
- Tenant-scoped records are isolated by tenant.
- Normal users can only access tenants to which they are assigned.
- Users may be assigned to one or more tenants.
- Users with multiple tenant assignments can switch active tenant context.
- Internal users can view any tenant.
- Tenant context is visible in the application when relevant.

### 25.2 Tenant Configuration

- Tenant administrators can configure request channels, product lines, cover types, segments, industries, regions, and party types.
- Creating a tenant automatically populates its configurable reference lists with the default data set (Section 6.4), and the seeded values can be edited or disabled.
- Permitted users can manage brokers, reference data, business rules, business assignments, and API access in the Settings section (12.10); users see only the subsections they are permitted to access.
- Tenant-specific reference values appear in lead/quote forms and dashboard filters.
- Disabled reference values remain available for historical reporting.

### 25.3 Lead Capture

- Users can create leads using a structured intake form.
- Required fields are enforced.
- Leads and quotes can hold one assignee per tenant-configured assignable role (Section 8), e.g., an RM and an underwriting owner simultaneously.
- The single Assign / Reassign operation can set, change, or clear any of the configured role assignments, not just the accountable owner.
- Product, broker, client, region, premium estimate, and date information can be captured consistently.
- Parties can be created, viewed, and edited in the Parties section, and a party's leads are visible from its detail page (12.9).
- A new lead can be created from a party's detail page with the party pre-selected, and the intake form supports choosing an existing party or creating one inline (9.3).
- Brokers, RMs, clients, and leads are segregated by tenant.

### 25.4 Quote Management

- Users can create quotes as distinct records associated with leads.
- A quote cannot exist without a lead.
- Quotes can capture quoted premium, quote reference, quote status, prepared/sent dates, and valid-until date.
- A lead can support multiple quotes where permitted.
- A quote supports multiple file attachments (images, PDF, Word) per 12.7.
- Won/lost outcomes can be captured at quote level and reflected in lead status.

### 25.5 Workflow

- Leads can move through the agreed lifecycle stages.
- Quotes can move through the agreed quote lifecycle stages.
- Status changes happen only through named workflow operations (Section 10.4); no screen exposes lead or quote status as an editable field.
- Status changes are visible in history.
- Open leads and quotes can carry next follow-up dates and notes.
- Leads/quotes can be closed as Won or Lost.
- Lost leads/quotes require structured lost reasons.
- Pricing approval can be requested, approved, and rejected through workflow operations, and requests pending beyond target raise alerts (10.4, 18.1).
- Open leads with no activity (including quote activity) beyond the tenant-configured inactivity period are automatically expired (10.4).

### 25.6 Role-Based Access Control

- The application is inaccessible without authentication; the only anonymous functionality is password reset (12.11).
- There is no self-service sign-up; users are created through User Manager or backend administration.
- Users log in with their email address as username, and failed logins do not reveal whether an account exists.
- User Manager is visible only to users with user/access-management permissions.
- Roles can be created with a name and assigned permissions.
- User groups can be created with a name.
- User groups can have users assigned as members.
- User groups can have roles assigned.
- User groups can have direct permissions assigned where permitted.
- Users can be added with first name, last name, and email.
- Users can be assigned to one or more tenants.
- Users can be assigned roles directly.
- Users can be assigned permissions directly.
- Users can be added to user groups.
- Users can have different roles, permissions, and group memberships in different tenants.
- An Internal role exists for global tenant and platform management.
- Internal permissions are auditable and restricted to authorized users.

### 25.7 Dashboards

- Executive users can view total leads, total quotes, open premium, won premium, conversion rate, average turnaround, and items at risk.
- Sales users can view pipeline by stage, open lead/quote aging, and at-risk opportunities.
- Management can compare RM and broker performance.
- Users can view loss reasons and lost premium analysis.
- Users can view SLA/turnaround performance and breaches.
- Dashboard filters work consistently across key views and use tenant-specific values.

### 25.8 Alerts

- The system identifies unassigned leads.
- The system identifies overdue follow-ups.
- The system identifies stalled leads and stalled quotes.
- The system identifies expiring quotes.
- The system identifies SLA breaches.
- High-value at-risk opportunities are visible to management.

### 25.9 Reporting

- Users can export lead lists, quote lists, and dashboard data for management meetings.
- Reports reflect selected filters and include tenant name, reporting period, currency, and last refreshed timestamp.
- Cross-tenant reports are restricted to Internal users with appropriate permissions.

### 25.10 Pilot Readiness

- Pilot users can be trained on the core workflow in a short session.
- Sales leadership can use the dashboard in a weekly pipeline meeting.
- Data definitions are documented clearly enough to prevent major reporting ambiguity.
- Tenant configuration and access control are simple enough for tenant administrators to understand.

---

## 26. Suggested 90-Day MVP Path

| Period | Focus | Business Outputs |
|---|---|---|
| Weeks 1-2 | Discovery and workflow mapping | Confirm personas, tenants, tenant roles, lead/quote terminology, fields, statuses, dashboards, SLA rules, ownership, pilot scope, and data governance. |
| Weeks 3-4 | Prototype and approval | Clickable prototype, tenant setup flow, sample lead/quote dashboard, client walkthrough, and agreed MVP backlog. |
| Weeks 5-8 | Core build | Tenant management, RBAC, lead capture, quote management, pipeline workflow, reminders, exports, and dashboard views. |
| Weeks 9-10 | Pilot data and testing | Configure pilot tenant, import sample/live lead and quote data, test workflows, refine validations, and prepare training. |
| Weeks 11-12 | Pilot launch | Go live with selected users, monitor adoption, fix priority issues, and publish first management report. |

---

## 27. Open Questions for Client Discovery

### 27.1 Tenant and Deployment Questions

- What is the first tenant for the pilot?
- Will the pilot include only one insurer/business unit, or should it demonstrate multiple tenants?
- What tenant-specific branding or naming is required, if any?
- Who will act as Tenant Administrator?
- For the MVP, are tenant name plus contact name, contact email, and contact phone (Section 5.1) sufficient tenant profile fields, or are any additional fields absolutely required for pilot operations?
- What global/Internal users from The Brittany should have access to tenant data?

### 27.2 Business Workflow Questions

- Which products or lines of business should the pilot cover first?
- Who currently owns each stage of the lead and quote lifecycle?
- At what exact business point does a lead become ready for a formal quote?
- Should a lead support multiple quotes, quote revisions, or quote options in the MVP?
- What turnaround SLAs are expected by product, cover type, channel, or broker type?
- What premium threshold should trigger escalation?
- How are quotes currently prepared, stored, and referenced?

### 27.3 Reference Data Questions

- What request channels should be available for the pilot tenant?
- What product lines and cover types should be available for the pilot tenant?
- What party types, segments, industries, and regions should be available?
- Which lists should use default values and which must be tenant-specific from day one?
- Who should be allowed to manage these lists?

### 27.4 Reporting and Management Questions

- What reports does the Head of Sales currently prepare manually?
- Which broker, partner, branch, and contact information is already available?
- Which fields are mandatory today, and which are often missing?
- How should conversion rate be defined: by lead count, quote count, premium value, or more than one metric?
- Should the MVP include broker-facing intake, or should intake be internal only?
- What are the current loss reason categories used by Sales or Underwriting?
- What level of executive detail is useful without overwhelming ExCo users?
- Who will own data quality during the pilot?
- What is the preferred cadence for weekly sales reporting?

### 27.5 Access Control Questions

- Which roles are required for the pilot tenant?
- Should RMs see only their own leads or all team leads?
- Should Underwriters see all underwriting work or only assigned work?
- Who can close a lead or quote as Won/Lost?
- Who can change closed lead or quote records?
- Who can export reports?
- Who can manage tenant users and roles?
- Which users should have Internal access?

---

## 28. Appendix A - Screenshot-Derived Visualization Catalog

The prototype screenshots in `docs/prototype/screenshots/` cover seven screens: Overview, Pipeline, Brokers, RM Performance, Loss Analysis, Alerts, and Reports. Two prototype generations appear: an earlier generation (Overview, Pipeline, RM Performance) on a deep teal-navy sidebar with no global search or header create button, and a later generation labeled "Prototype v0.4.2" (Brokers, Loss Analysis, Alerts, Reports) that keeps a dark sidebar and adds a global search box, a header "+ New Quote" button, and a filter toggle. The product follows the later generation's header (global search plus global action), with the global action renamed **+ New Lead** (Section 12.2), and uses one consistent sidebar treatment per `QuoteIQ_UI_Standards.md`.

**Terminology caveat:** the prototype counts every record as a "quote", including pre-quote pipeline stages. In the product, pre-quote stages count Leads and post-quote metrics count Quotes; labels must follow Section 7.4.

### A.1 Executive Overview Screenshot

| Area | Visualization / Component | Requirement |
|---|---|---|
| Header filters | Date range, product line, broker, RM, region, clear filters | Narrow executive metrics by commercial dimension. Add tenant context for multi-tenant users. |
| KPI row | Total quotes, open pipeline premium, won premium MTD, conversion rate, avg turnaround, quotes at risk - each with icon and vs-prior-period delta | Show high-level commercial health with period-over-period comparison. |
| Pipeline by Stage | Horizontal bar chart with count and % per stage | Show pipeline distribution by stage. Screenshot counts are cumulative and include Won; the product shows open items per stage (13.2). |
| Open Quotes Aging | Donut with center total; buckets 0-3 / 4-7 / 8-14 / 15+ days with counts and % | Show aging distribution of open inventory. |
| Won vs Lost Trend | Line chart, weekly toggle; won solid, lost dashed | Compare won and lost premium over time. |
| High-Value Opportunities | Table: client, broker, product, premium, stage chip, next action + date | Highlight material open opportunities. |
| Requires Attention | Alert panel: stalled quotes, overdue follow-ups, expiring quotes with counts | Summarize what needs action, linking to the alerts center. |

### A.2 Pipeline and Conversion Screenshot

| Area | Visualization / Component | Requirement |
|---|---|---|
| KPI row | New quotes this month, open pipeline value, quote-to-proposal rate, proposal-to-win rate, avg quote age, SLA breaches | Track flow and conversion efficiency. |
| Pipeline Stage Conversion | Tapered funnel with count and conversion % per stage | Show stage-by-stage progression and drop-off. |
| Pipeline by Product Line | Stacked monthly columns with product-line legend and monthly totals | Show open pipeline value by product line over time. |
| Quote Volume by Source | Donut with center total; legend with counts and shares | Show quote volume by broker or source. |
| Aging by Stage | Heatmap: stages × age buckets (0-3 → 60+ days) with green→red grading and totals | Show aging distribution by pipeline stage. Screenshot includes Won/Lost rows; the product includes open stages only (14.2). |
| At-Risk Pipeline | Action table: client, broker, premium, stage chip, age, owner, risk reason | Identify specific items needing intervention. |
| Immediate Actions | Action panel: overdue quotes, pending pricing approvals, exec escalations, SLA breaches | Summarize today's operational actions. |

### A.3 Brokers Screenshot (Broker & Partner Performance)

| Area | Visualization / Component | Requirement |
|---|---|---|
| KPI row | Active brokers, broker quotes, broker conversion, won via brokers, avg turnaround, overdue follow-ups | Summarize broker channel health. |
| Top Brokers / Partners | Horizontal bar ranking by quote volume with conversion % | Rank broker activity and efficiency. |
| Broker Performance Matrix | Scatter: volume vs conversion, bubble = won premium, quadrant colors | Classify brokers for management response. |
| Broker Performance table | Broker + contact, tier chip, branch, quotes, conversion (color-coded), won premium, avg TAT, overdue, top loss reason | Full ranked broker comparison with loss patterns. |

### A.4 RM and Broker Performance Screenshot

| Area | Visualization / Component | Requirement |
|---|---|---|
| Header filters | Replaces RM with RM/Team and Broker with Broker Type in the standard filters | Analyze by team and partner category. |
| KPI row | Active RMs, active brokers, won premium YTD, RM conversion rate, broker conversion rate, follow-up compliance | Summarize sales network health within the tenant. |
| Top Relationship Managers | Horizontal bar ranking by won premium with conversion % | Rank tenant RMs. |
| Top Brokers / Partners | Horizontal bar ranking by quote volume with conversion % | Rank tenant brokers. |
| Broker Performance Matrix | Scatter plot quadrant chart | Compare brokers by volume and conversion. |
| Turnaround (SLA) by RM / Team | Horizontal bars with dashed SLA target marker and metric dropdown | Show teams exceeding turnaround targets. |
| Performance Watchlist | Table: RM/broker, quotes, won premium, conversion, avg turnaround, overdue follow-ups, suggested-action chip | Direct management attention. |
| Leadership Insights | Insight panel: top broker, underperforming RM, turnaround risk, follow-up compliance, largest opportunity | Narrative summary for leadership. |

### A.5 Loss Analysis Screenshot

| Area | Visualization / Component | Requirement |
|---|---|---|
| KPI row | Lost premium, quotes lost, top loss reason, avg price gap, top competitor, win-back potential | Summarize loss position at a glance. Win-back Potential is prototype-only and is not built (16.0). |
| Lost Premium by Reason | Horizontal bars (red hue) with amounts | Rank loss drivers by premium. |
| Lost Premium Trend | Line chart with area fill, last 6 months | Show loss trajectory. |
| Lost Premium by Product Line | Horizontal bars (amber hue) | Show which products are losing premium. |
| Competitor Analysis | Table: competitor, deals lost, premium lost, avg price gap | Show where business is going. |
| Loss Commentary | Feed: client + product, note, loss-reason chip, premium | Qualitative loss intelligence. |

### A.6 Alerts Screenshot (Alerts & Escalation)

| Area | Visualization / Component | Requirement |
|---|---|---|
| Category cards | Escalated, stalled, overdue, expiring, SLA breaches - each with definition and count | Categorize intervention needs. |
| Escalation Queue | Premium-at-risk rollup; tabs All/Escalated/Overdue/Expiring/SLA; table with ref, client + product, broker, premium at risk, stage chip, age, owner, flag chips | Work the intervention queue. |
| Action column | Contextual actions: assign & acknowledge, follow up, executive review | Convert alerts into workflow operations. |

### A.7 Reports Screenshot (Reports & Exports)

| Area | Visualization / Component | Requirement |
|---|---|---|
| Report cards | Six cards (executive weekly, pipeline & conversion, broker performance, RM performance, loss analysis, SLA/turnaround) each with Open report + CSV | One-click weekly reporting pack. |
| Scheduled & recent | Distribution list with last-sent/scheduled info and status chips | Prototype only - scheduled report distribution is out of scope for the MVP (19.0). The prototype itself labels this panel "Demo placeholder". |
| Cadence label | "Cadence: Weekly · Mondays 08:00" | Prototype only - scheduled report distribution is out of scope for the MVP (19.0). |

---

## 29. Appendix B - Recommended Dashboard List

| Dashboard | Primary Audience | Required Components |
|---|---|---|
| Leads Workspace | RMs, Sales Ops, Sales Head | Leads list, lead detail with subordinate quotes, intake form, workflow action dialogs (Sections 12.4-12.8). |
| Parties Workspace | RMs, Sales Ops, Sales Head | Parties list, party detail with the party's leads, party add/edit (Section 12.9). |
| Settings | Tenant Admin, Internal users, authorized administrators | Brokers, reference data, business rules, business assignments, and API access, in vertical tabs (Section 12.10). |
| Executive Overview | MD, Head of Sales, ExCo | KPI cards, pipeline by stage, aging, won/lost trend, high-value opportunities, requires-attention panel. |
| Pipeline and Conversion | Sales Head, RMs, Sales Ops | Stage conversion funnel, product-line pipeline, quote source mix, lead source mix, aging heatmap, at-risk pipeline, immediate actions. |
| Broker Performance | Sales Head, Broker Management | Broker rankings, broker matrix, broker conversion, won premium, average turnaround, top loss reasons. |
| RM Performance | Sales Head, Team Leads | RM rankings, conversion, won premium, overdue follow-ups, average turnaround, performance watchlist. |
| Loss Analysis | Sales, Product, Underwriting, Management | Lost premium by reason, loss count by reason, loss trend, product/broker/RM loss breakdown, competitor won analysis. |
| SLA and Turnaround | Sales and Underwriting | Delivered as widgets on Pipeline/RM Performance plus the SLA / Turnaround report (Section 17): SLA breach count, turnaround by stage/product/team, underwriting delay queue, aging heatmap. |
| Alerts Center | Sales Head, RMs, Sales Ops | Unassigned leads, overdue follow-ups, stalled leads/quotes, expiring quotes, SLA breaches, high-value escalations. |
| Reports | Sales Ops, Management | Exportable standard reports for weekly sales meetings and executive review. |
| Tenant Manager | Internal users, authorized platform administrators | Add, view, edit, soft-remove, and restore tenants. MVP tenant record requires tenant name, contact name, contact email, and contact phone (Section 5.1). |
| User Manager | Tenant Admin, Internal users, authorized access administrators | Add/view/edit users, roles, user groups, role assignments, permission assignments, tenant assignments, and group memberships. |

---

## 30. Appendix C - Initial Lost Reason Taxonomy

Lost reasons should be configurable by tenant, but the following defaults are recommended.

| Category | Example Use |
|---|---|
| Pricing too high | Broker/client rejected premium level. |
| Competitor won | Business placed with another insurer. |
| Incumbent retained | Existing insurer retained the business. |
| Tender exercise only | Quote requested for comparison or tender participation without serious intent. |
| Coverage gap | Product did not meet required cover. |
| Terms not accepted | Client rejected terms, exclusions, conditions, or deductibles. |
| Service concern | Relationship or service issue affected decision. |
| Brand / trust concern | Client or broker lacked confidence in insurer. |
| Underwriting declined | Insurer declined or could not support the risk. |
| No response | Broker/client did not respond after follow-up. |
| Decision postponed | Client deferred purchase or renewal decision. |
| Quote expired | Quote validity period ended before conversion. |
| Lost before quote issued | Lead was closed lost before any formal quote was provided. |
| Other | Must include comment when selected. |

---

## 31. Appendix D - Recommended RBAC Starting Point

### D.1 Core Roles and Permission Intent

| Role | Scope | Permission Intent |
|---|---|---|
| Internal | Global | All permissions related to global platform management, tenant management, global defaults, and authorized cross-tenant viewing. |
| Tenant Admin | Tenant | Full tenant administration and tenant data management. |
| Sales Head | Tenant | Full commercial visibility, assignment, escalation, reporting, and export. |
| RM | Tenant | Manage own assigned leads/quotes and follow-ups; view permitted dashboards. |
| Underwriter | Tenant | Manage assigned underwriting items and quote preparation status. |
| Sales Ops | Tenant | Create and maintain records, support reporting, and assist data quality. |
| Executive Viewer | Tenant | Read-only dashboards and reports. |
| Broker User | Tenant external | Future limited intake and status visibility only. |

### D.2 RBAC Business Rules

- Roles are collections of permissions.
- Permissions can be assigned to roles.
- Users can be assigned roles directly.
- Users can be assigned permissions directly for exceptions.
- User groups can contain users.
- User groups can be assigned roles.
- User groups can be assigned direct permissions where the business allows group-level exceptions.
- Users can belong to multiple user groups.
- A user’s effective permissions are the combination of direct permissions, direct role permissions, group role permissions, and permitted group-level direct permissions.
- Tenant-scoped roles and permissions apply only within the relevant tenant.
- Global/Internal roles and permissions apply across tenants only where explicitly granted.
- Normal users must belong to at least one tenant.
- Internal users can view any tenant and switch tenant context according to their global permissions.
- Every privileged administrative action should be auditable.

### D.3 User Manager Minimum Administration Objects

| Object | Required MVP Fields / Relationships |
|---|---|
| Tenant | Tenant name, contact name, contact email, contact phone; active/removed status; soft-deletion audit details. |
| User | First name, last name, email, tenant assignments, direct role assignments, direct permission assignments, user group memberships, active/deactivated status. |
| User Group | Group name, member users, assigned roles, assigned permissions where permitted, tenant/global scope. |
| Role | Role name, assigned permissions, tenant/global scope. |
| Permission | Permission name/key and business description. Permissions are selected when configuring roles, groups, or direct user exceptions. |