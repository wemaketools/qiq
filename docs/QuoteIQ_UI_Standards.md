# QuoteIQ UI Standards

**Product:** QuoteIQ - Insurance Leads and Quotation Intelligence Platform
**Document type:** Shared visual, control, validation, and messaging standards
**Companion document:** `QuoteIQ_PRD.md` - the PRD states *what* each screen captures and *which control* is used; this document states *how* controls, colors, formatting, validation, and messages behave everywhere.

## How to read this document

The PRD is the authority on screen content and field-level requirements. This document is the authority on cross-cutting presentation and behavior, so those rules are defined once here instead of being repeated per screen. Where the PRD says "per UI standards", "per `QuoteIQ_UI_Standards.md`", or "shared palette", this is the referenced source.

Rules use **must** for required behavior and **should** for the strong default that may be varied only with a documented reason.

> **Proposed values.** Exact hex values, the font family, and spacing constants below are a concrete proposed system consistent with the prototype description in the PRD (deep teal-navy shell, teal accent, BWP formatting). Treat the specific tokens as the starting design system to confirm during discovery; the *rules* around them are binding regardless of final values.

---

## 1. Design Principles

1. **One visual language.** Every screen - dashboards, lists, detail, forms, dialogs - draws from the same tokens defined here. No screen invents its own colors, chip styles, or button variants.
2. **Action-oriented.** Color, chips, and emphasis exist to direct attention to what needs action (overdue, stalled, expiring, at risk), not for decoration.
3. **Lead vs quote clarity.** Wherever a count, chip, or value could be read as either a lead or a quote, the label must say which (PRD Section 7.4). The UI never uses "quote" generically to mean "lead".
4. **Legible density.** Business users scan large tables; prefer clear rows, right-aligned numerics, and restrained color over dense decoration.
5. **Accessible by default.** Meets WCAG 2.1 AA; color is never the only signal (Section 12).

---

## 2. Theming

The application supports **light and dark themes**, toggled from the user-card menu in the sidebar (PRD Section 12.2). All colors below are defined as design tokens with a value per theme. Components must reference tokens, never raw hex values, so both themes and future tenant theming stay consistent.

Token naming convention: `--qiq-{category}-{role}` (e.g., `--qiq-surface-sidebar`, `--qiq-status-won-bg`).

---

## 3. Color System

### 3.1 Surfaces and shell

| Token | Role | Light | Dark |
|---|---|---|---|
| `--qiq-surface-sidebar` | Fixed left sidebar (deep teal-navy) | `#0F2A3F` | `#0B1E2E` |
| `--qiq-surface-app` | App background behind content | `#F4F6F8` | `#0E1621` |
| `--qiq-surface-card` | Cards, tables, panels | `#FFFFFF` | `#16232F` |
| `--qiq-surface-raised` | Modals, popovers, dropdown menus | `#FFFFFF` | `#1C2B39` |
| `--qiq-border-subtle` | Card borders, dividers | `#E3E8EE` | `#263644` |
| `--qiq-text-primary` | Primary text | `#1B2733` | `#EAF0F5` |
| `--qiq-text-secondary` | Labels, secondary text | `#5B6B7A` | `#9DB0BF` |
| `--qiq-text-on-sidebar` | Text on the teal-navy sidebar | `#D7E3EC` | `#D7E3EC` |

### 3.2 Brand and accent

| Token | Role | Light | Dark |
|---|---|---|---|
| `--qiq-accent` | Primary action, active nav pill, focus, key data lines | `#159AA6` | `#2FB6C2` |
| `--qiq-accent-contrast` | Text/icon on accent fill | `#FFFFFF` | `#08202A` |
| `--qiq-accent-soft` | Tinted backgrounds (KPI icon halos, selected rows) | `#E3F4F5` | `#123B41` |

Active navigation items render as an accent **pill** behind the item; the wordmark ("QuoteIQ / Quotation Intelligence") and tenant brand ("The Brittany") sit at the top of the sidebar per PRD Section 12.2.

### 3.3 Semantic colors

Used for validation, alerts, deltas, and status families. Each has a base, a soft background (for chips/banners), and text-on-base.

| Meaning | Token base | Light | Dark | Used for |
|---|---|---|---|---|
| Success / good / won | `--qiq-success` | `#1E8E5A` | `#3FBF86` | Won, positive deltas, success toasts |
| Warning / attention | `--qiq-warning` | `#C9820A` | `#E3A93C` | Aging, expiring, SLA-at-risk, warning banners |
| Danger / bad / lost | `--qiq-danger` | `#C0392B` | `#E56B5D` | Lost, overdue, destructive actions, errors |
| Info / open | `--qiq-info` | `#2A6FB0` | `#5AA0DD` | Open/in-progress states, info banners |
| Neutral / inactive | `--qiq-neutral` | `#6B7A88` | `#8497A5` | Expired, withdrawn, disabled, "All" filters |

Each has a paired soft background token (`--qiq-success-soft`, etc.) at roughly 12-16% tint of the base for the current theme, used for chip and banner fills.

### 3.4 Direction-aware delta colors

KPI deltas are colored by **whether the movement is good**, not by its sign (PRD Section 12.3). A drop in turnaround is good and renders green; a rise in SLA breaches is bad and renders red/amber.

- Good movement → `--qiq-success`, up-arrow or down-arrow as appropriate to the metric.
- Bad movement → `--qiq-danger` (or `--qiq-warning` for soft-bad metrics like at-risk counts).
- Flat / no meaningful change → `--qiq-text-secondary`.

Each KPI must declare its "good direction" so this is deterministic.

### 3.5 Product-line series palette

Charts that break down by product line must use one fixed color per line so the same product reads the same color across every dashboard (PRD Sections 14.2, A.2):

| Product line | Token | Light |
|---|---|---|
| Motor | `--qiq-series-motor` | `#1F3A5F` (navy) |
| Property | `--qiq-series-property` | `#159AA6` (teal) |
| Engineering | `--qiq-series-engineering` | `#3E8E3F` (green) |
| Marine | `--qiq-series-marine` | `#7A4FB0` (purple) |
| Group Life | `--qiq-series-grouplife` | `#D98324` (orange) |

Additional product lines extend this palette; assignments must be stable per tenant so colors do not shift between sessions. Categorical chart palettes must remain distinguishable in both themes and for common color-vision deficiencies (Section 12).

---

## 4. Status and Flag Chips

Statuses and flags render as **chips**: a small rounded label (`border-radius: 999px`, `padding: 2px 10px`, 12px medium weight, soft background + darker text of the same family). This is the single shared chip palette referenced throughout the PRD (Sections 12.3, 12.4).

### 4.1 Status chips by reporting category

Individual lead and quote statuses are configurable per tenant, but every status maps to a standard reporting category (PRD Section 6.2). **Chip color is driven by the reporting category, not the display name**, so a renamed status keeps a consistent color:

| Reporting category | Chip family | Applies to (examples) |
|---|---|---|
| Open | `--qiq-info` soft | New, Assigned, Information Gathering, Underwriting, Pricing |
| Quoted | `--qiq-accent` soft | Quote Sent, Negotiation; quote statuses Draft, Sent, Revised |
| Won | `--qiq-success` soft | Closed Won; quote Won |
| Lost | `--qiq-danger` soft | Closed Lost; quote Lost |
| Expired | `--qiq-neutral` soft | Expired (lead and quote) |
| Withdrawn | `--qiq-neutral` soft (outlined) | Withdrawn (lead and quote) |

Withdrawn uses an outlined neutral chip to distinguish it from Expired at a glance. Chips must include the status text (never color alone) so meaning survives for color-blind users and in exports.

### 4.2 Flag chips

Risk flags appear as small chips in list "Flags" columns and on detail headers (PRD Sections 12.4, 12.5):

| Flag | Chip color | Meaning |
|---|---|---|
| Escalated | `--qiq-danger` | Raised for management intervention. |
| SLA | `--qiq-warning` (→ `--qiq-danger` once breached) | Approaching or past an SLA target. |
| Expiring | `--qiq-warning` | Quote inside the tenant expiry-alert window. |
| High value | `--qiq-accent` | Above the tenant high-value threshold. |

Multiple flags stack horizontally with a small gap; order by severity (Escalated, SLA, Expiring, High value).

---

## 5. Typography

| Role | Spec |
|---|---|
| Font family | A clean humanist sans-serif system stack: `Inter, "Segoe UI", system-ui, -apple-system, sans-serif`. One family across the product. |
| Page title (top bar) | 20px / 600 |
| Section heading | 16px / 600 |
| Card KPI value | 28-32px / 700, tabular figures |
| KPI label | 12px / 600, `--qiq-text-secondary`, uppercase optional |
| Body / table text | 14px / 400 |
| Secondary / helper text | 12px / 400, `--qiq-text-secondary` |
| Monospace | `"JetBrains Mono", "SFMono-Regular", Consolas, monospace` for **identifiers only**: Lead IDs (`L-2026-0421`) and Quote references (`Q-2026-1503`). |

Numeric columns and all currency use **tabular (monospaced) figures** so digits align vertically in tables and cards.

---

## 6. Layout and Spacing

- **Spacing scale (4px base):** 4, 8, 12, 16, 24, 32, 48. Use tokens `--qiq-space-1..7`; do not use arbitrary pixel gaps.
- **Cards:** `--qiq-surface-card`, `--qiq-border-subtle` 1px, `border-radius: 10px`, internal padding 16-24px.
- **Forms:** two-column grid on desktop (PRD Section 12.6); full-width textareas span both columns; collapse to one column below the tablet breakpoint (Section 13).
- **Sticky footer bar** on full-page forms holds the primary/secondary actions and remains visible while scrolling.
- **Dashboards:** filter bar directly under the top bar; KPI row; then chart/table rows per each dashboard's PRD layout.

---

## 7. Iconography

- One icon set, single stroke weight, 20px default (16px inline, 24px nav).
- Icons reinforce meaning but never replace a text label on actions, chips, or KPIs.
- KPI cards use a tinted circular icon halo (`--qiq-accent-soft` or the relevant semantic soft token) per PRD Section 12.3.

---

## 8. Controls

Standard behavior for every control referenced by field specs in the PRD (e.g., Section 9.3). Field specs choose the control; this section defines how it behaves.

| Control | Standard behavior |
|---|---|
| Text input | Single line; trims leading/trailing whitespace on blur; shows `maxlength` where the field defines one; character counter only when a limit is defined. |
| Textarea | Multiline, vertically resizable, spans both form columns; same trim and counter rules. |
| Dropdown (select) | Loads **only the active tenant's** reference values; placeholder `Select…`; supports a disabled state; never shows values from other tenants. |
| Searchable dropdown | Type-ahead filtering; keyboard navigable; may include an inline creation option (e.g., **+ New party**) where the field allows; shows "No matches" when empty. |
| Dependent dropdown | Disabled until its parent is chosen; resets when the parent changes (e.g., Cover type resets when Product line changes, PRD Section 9.3). |
| Currency input | `BWP` prefix, thousands separators as typed, up to 2 decimals; stored as a precise decimal; enforces `> 0` where the field requires it (Section 11). |
| Date picker | Calendar popover; honors min/max rules from the field (e.g., "cannot be in the future", "must be after sent date"); displays in the standard date format (Section 11). |
| Toggle | Binary on/off with a visible label; default state per field spec. |
| Radio group | 2-4 mutually exclusive options shown inline; one always selected when the field is required. |
| Buttons | See Section 9. |

**Required-field marking:** required fields show a required indicator on the label; optional fields are left unmarked (do not label every optional field "optional" except where the PRD calls a field conditionally visible/required).

**Disabled vs hidden:** illegal actions are **hidden**, not disabled (PRD Section 12.5); controls that are temporarily unavailable due to a dependency are **disabled** with a hint.

---

## 9. Buttons

| Variant | Use | Style |
|---|---|---|
| Primary | The main action of a screen or dialog (one per context): **Create lead**, **Save changes**, **Save as draft**. | Accent fill, `--qiq-accent-contrast` text. |
| Secondary | Supporting action: **Cancel**, **Clear filters**. | Outlined / subtle surface, primary text. |
| Danger | Destructive or irreversible workflow actions: **Mark lost**, **Withdraw**, **Reopen** (PRD Sections 10.4, 12.8). | `--qiq-danger` fill; dialog restates the consequence. |
| Ghost / icon | Low-emphasis and `⋮` row/card menus. | No fill; hover surface. |

Rules: exactly one primary button per screen or dialog; the primary button names the verb (**Mark lost**, not **OK**); buttons show a busy/spinner state while a submit is in flight and disable to prevent double submission.

---

## 10. Validation and Error Handling

This is the single definition of validation behavior for all forms and dialogs (PRD Sections 9.3, 12.6, 12.7, 12.8).

### 10.1 When validation runs

1. **On blur** - validate a field when the user leaves it, showing inline errors immediately.
2. **On submit** - validate all fields; block submission if any fail; move focus to the first invalid field.
3. **On the server** - the backend re-validates **everything** on submit regardless of client checks. Client validation is a UX convenience only and is never trusted (PRD Section 9.3; project security stance). Server-returned field errors render in the same inline style as client errors.

### 10.2 How errors display

- **Inline field error:** red border (`--qiq-danger`) on the control plus a message directly beneath it (e.g., "Select a lost reason", "Date received cannot be in the future"). The message is associated to the control via `aria-describedby`, and `aria-invalid="true"` is set.
- **Form-level error summary:** when **three or more** fields fail on a submit, show a summary banner at the top of the form listing each error as a link that focuses its field. (For one or two errors, inline messages alone suffice.)
- **Dialog validation:** the same inline pattern inside workflow dialogs; the dialog does not close and the primary button stays enabled to allow correction and retry.

### 10.3 Warnings vs errors

- **Errors** block submission (missing required field, invalid format, business-rule violation).
- **Warnings** are non-blocking and advisory: duplicate-name, duplicate-lead, and uniqueness warnings (PRD Section 9.3). They appear as a dismissible inline notice or a confirm dialog offering **Create anyway** / **Review existing**, and never prevent a deliberate save.

### 10.4 Unsaved changes

Navigating away from a dirty form or dialog prompts an **unsaved-changes** confirmation (PRD Section 12.6) before discarding input.

---

## 11. Data Formatting

Consistent formatting everywhere data appears (PRD Sections 12.2, 12.3).

| Data | Standard |
|---|---|
| Currency | Prefixed `BWP`. **Tables and inputs** show full amounts with thousands separators and no forced decimals unless present (`BWP 8,750,000`). **Cards and chart axes** may use compact notation (`BWP 128.6M`, `BWP 42.3K`). One reporting currency per tenant; BWP for Botswana pilots. |
| Whole numbers | Thousands separators (`1,248`). Tabular figures. |
| Percentages | One decimal where precision matters (`33.9%`); percentage-point deltas suffixed `pp` (`↑3.6pp`). |
| Dates | `MMM D, YYYY` (`Jun 2, 2025`). Date ranges as `MMM D - MMM D, YYYY` (`May 1 - May 31, 2025`). |
| Date + time | `MMM D, YYYY HH:mm` with timezone label where shown (`May 31, 2025 08:30 SAST`). Footer "Data as of…" uses this form. |
| Relative age | Whole days (`8 days`). Coloring: neutral below the amber threshold, `--qiq-warning` at/above the amber threshold, `--qiq-danger` at/above the red threshold. Default thresholds amber ≥ 8 days, red ≥ 15 days; both are **tenant-configurable** (PRD Section 12.4). |
| Overdue follow-up | Next-follow-up date renders `--qiq-danger` with an "Overdue" chip when past due (PRD Sections 12.4, 12.5). |
| Identifiers | Lead IDs and Quote references in monospace, rendered as links to their record. |
| Empty / unknown | An em dash (`—`), never blank, `0`, or `null`. |

A persistent footer states "All amounts in BWP" and the data-currency timestamp with a refresh control (PRD Section 12.2).

---

## 12. Accessibility

- **Contrast:** text and meaningful UI meet WCAG 2.1 AA (4.5:1 body text, 3:1 large text and UI components) in both themes.
- **Color independence:** status and risk are always conveyed by text/label/icon in addition to color; chips carry their text; charts include a legend and are distinguishable for common color-vision deficiencies.
- **Keyboard:** every interactive element is reachable and operable by keyboard; visible focus ring uses `--qiq-accent`; modals trap focus and restore it to the trigger on close; Esc cancels a dialog.
- **Screen readers:** form controls have programmatic labels; errors use `aria-invalid` + `aria-describedby`; toasts and async results announce via an `aria-live` region; icon-only buttons have accessible names.
- **Targets:** interactive targets at least 32x32px effective hit area.
- **Motion:** honor `prefers-reduced-motion` by suppressing non-essential animation.

---

## 13. Responsive Behavior

- Breakpoints: desktop ≥ 1200px (primary target), tablet 768-1199px, narrow < 768px.
- Two-column forms collapse to one column on tablet and below.
- Wide tables and heatmaps scroll horizontally within their own container; the page body never scrolls horizontally.
- The sidebar collapses to an icon rail or drawer on narrow widths; the active tenant remains visible.

---

## 14. Messaging and Feedback

The product speaks in plain business language: specific, calm, and actionable. It never exposes stack traces or raw error codes to users.

### 14.1 Toasts

- Transient confirmation of an action; auto-dismiss ~4s; dismissible; stack top-right; announced to assistive tech.
- Success example: `Lead L-2026-0421 created`. Include the identifier so the user can confirm the result.
- Use for success and low-severity info; do **not** use toasts for validation errors (those are inline) or for anything requiring a decision.

### 14.2 Inline banners

Persistent, in-context messages within a page or card:

| Type | Color | Use |
|---|---|---|
| Error | `--qiq-danger` soft | Form-level error summary; a failed load or save. |
| Warning | `--qiq-warning` soft | Non-blocking advisories (duplicate warnings, approaching SLA). |
| Info | `--qiq-info` soft | Contextual guidance or state notices. |
| Success | `--qiq-success` soft | Confirmation that persists in context when a toast is insufficient. |

### 14.3 Confirmation and workflow dialogs

All workflow operations (PRD Section 10.4) share one dialog pattern, defined here and referenced by PRD Section 12.8:

- **Title** names the action and target: `Mark lost - L-2026-0421 · Botswana Mining Co.`
- **One-line description** of the consequence beneath the title.
- **Only the inputs that operation needs** (from PRD Section 10.4), validated per Section 10.
- **Footer:** secondary **Cancel** + one primary button naming the verb. Destructive/irreversible actions (Mark lost, Withdraw, Reopen) use the **danger** style and restate the consequence.
- **On success:** toast confirmation, the status chip updates in place, and a timeline entry is added - no full-page reload.

### 14.4 Empty states

Every list, table, and panel defines an empty state: an icon, a plain-language line (e.g., "No leads match the current filters", "No quotes yet - create one when formal terms are ready"), and the relevant primary action(s) (e.g., **Clear filters**, **+ New Lead**).

### 14.5 Loading and errors

- **Loading:** skeleton placeholders for cards/tables and inline spinners for in-place updates; avoid layout shift when content arrives.
- **Load failure:** an inline error state within the affected card/panel with a **Retry** action, not a blank area and not a full-page crash.

---

## 15. Tables

Shared behavior for the Leads list and dashboard tables (PRD Sections 12.3, 12.4, 13.3, 14.3):

- Numeric and currency columns are **right-aligned** with tabular figures; text columns left-aligned.
- Column headers are sortable where the screen allows; the active sort shows a direction indicator.
- Status renders as a chip (Section 4); identifiers as monospace links; ages and overdue dates colored per Section 11.
- **Row click** opens the record's detail; there is no inline editing in lists (PRD Section 12.4).
- **Pagination** defaults to 25 rows per page with a count summary (`1-25 of 312`).
- **Export** of the current filtered view to CSV/Excel is available where the PRD specifies it (Section 19.2); exported values use the full (non-compact) formats and include chip text, not color.

---

## 16. KPI Cards

Per PRD Section 12.3: a tinted circular icon halo, a small uppercase-optional label, a large value (tabular figures, compact currency allowed), and a direction-aware delta versus the prior comparable period (`↑ 14% vs Apr 1-30`). Cards that count leads, quotes, or premium must say which in the label (PRD Section 7.4). At-risk cards use `--qiq-warning` styling. Each card exposes a contextual drill-through link and a `⋮` menu (export, view details) per PRD Section 12.3.

---

## 17. Consistency Checklist (for reviewers)

A screen conforms to these standards when:

- [ ] All colors, spacing, and typography come from tokens - no ad-hoc values.
- [ ] Statuses and flags use the shared chip palette (Section 4), colored by reporting category.
- [ ] Currency, dates, percentages, and ages follow Section 11; identifiers are monospace links.
- [ ] Validation runs on blur, on submit, and on the server; errors display inline with a summary at 3+ (Section 10).
- [ ] Destructive actions use the danger button and restate consequences; one primary action per screen/dialog.
- [ ] Lead vs quote counts are explicitly labeled.
- [ ] Empty, loading, and error states are defined.
- [ ] Keyboard, focus, contrast, and color-independence requirements are met (Section 12).
