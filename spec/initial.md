# QuoteIQ — Initial Spec & Interview Log

> Working document. Captures the shared understanding reached during the design interview, before any code is written. The next phase will be a mocked HTML prototype to be discussed before building.

---

## Source understanding (from brief + screenshots)

**What it is:** QuoteIQ is an *insurance quotation intelligence control tower* for The Brittany. A POC/MVP for an insurance sales pipeline and quotation control. Built for Botswana (currency **BWP**), designed to scale across the SADC region. It is positioned as a **Sales Quote Control Tower**, not a quote register.

**Why it matters:** The insurer needs a cleaner way to know what was quoted, what converted, what was lost, *why* it was lost, and where sales effort or management intervention should focus. Anchored on premium visibility, quote conversion, broker performance, follow-up discipline, and lost-business intelligence.

**Primary users / personas:**
- Head of Sales & Business Development
- Relationship Managers (RMs)
- Underwriters
- Management / ExCo viewers (read-only)
- Sales Operations / Admin

**Core workflow (MVP):** Request Received → Assigned → Quote Prepared → Quote Sent → Follow-Up / Pending → Closed Won or Lost.
**Richer lifecycle (augmented):** Awaiting Underwriting, Awaiting Client Info, Awaiting Broker Feedback, Follow-Up Due, Escalated, Quote Expired.

**Mandatory data capture:** Client/prospect, partner/broker, RM, request channel, dates (received/prepared/sent), product, cover type, quoted premium, status, decision date, lost reason (mandatory when Lost).

**Core data model categories:** Request origin · Client profile · Quote details · Process tracking · Follow-up · Outcome · Governance/audit.

**Dashboards defined in brief:** Executive Overview · Pipeline Aging · Broker Performance · RM Performance · Loss Analysis · SLA/Turnaround · Escalation Queue.

**Screens shown in screenshots (sidebar nav):** Overview · Pipeline · Brokers · RM Performance · Loss Analysis · Alerts · Reports. Visual style: dark teal sidebar, light content area, dense KPI + chart layout. (We will also add a **dark mode** option.)

**Loss reason taxonomy:** Pricing · Incumbent · Tender exercise · Brand trust · Coverage gaps · Service concerns · Other.

**Phasing (from brief):** MVP = login/roles, quote capture, lifecycle workflow, pipeline view, follow-up reminders, lost-reason capture, dashboards, exports. Phase 2 = email/WhatsApp integration, core system integration. Phase 3 = AI predictions (win probability, next action, broker clustering, pricing leakage).

**Build philosophy:** Discover → Design (clickable prototype w/ realistic data) → Build → Deploy (pilot) → Optimise. 90-day MVP path.

---

## Plan (my evolving view of the final intended plan)

*Updated as the interview progresses.*

**Deliverable:** A polished, **clickable HTML prototype** with realistic Botswana insurance sample data, used to reopen the conversation with the Head of Sales and MD. Not wired to a backend; filters/forms respond visually only.

**Tech:** Vanilla SPA, no build step — single `index.html` shell + vanilla JS hash-routing + shared CSS. Apache ECharts and fonts vendored locally → runs fully offline. Persistent dark-mode toggle. **Fully responsive** (mobile-friendly, Claude's choice of breakpoints).

**Screen set:**
- *Operational:* `+ New Quote` capture form · Pipeline → "Quotes" tab (filterable list) · Quote detail / lifecycle view.
- *Analytical (7-item sidebar, matching screenshots):* Overview · Pipeline (→ "Conversion" tab) · Brokers · RM Performance · Loss Analysis · Alerts · Reports.

**Demo journey:** capture a quote → move it through the lifecycle (assigned → prepared → sent → follow-up → won/lost w/ mandatory lost-reason) → reveal the control-tower dashboards.

**Pending decisions:** visual palette & dark-mode treatment, typography, persona/role handling, lifecycle stage depth, sample-data assumptions (products, brokers, RMs, SLAs, thresholds, time window), Alerts & Reports screen behavior. See interview log.

---

## Interview log

*Each question, my recommendation, and the agreed answer is recorded here as we go.*

### Q1 — Purpose & fidelity of this build
**Recommendation:** Clickable demo — high visual fidelity matching the screenshots, fully navigable, light + dark mode, realistic Botswana sample data, not wired to a backend.
**Answer:** ✅ Clickable demo. The deliverable is a polished, navigable visual prototype for walking the MD & Head of Sales through the workflow and dashboards. Filters/forms respond visually but no real backend.

### Q2 — Technical approach
**Recommendation:** Vanilla SPA with no build step — one HTML shell, vanilla JS hash-routing, shared CSS, charting lib + fonts vendored locally so it runs offline.
**Answer:** ✅ Vanilla SPA, no build. Runs by opening index.html; fully offline-capable; persistent dark-mode toggle; no npm/build tooling.

### Q3 — Charting library
**Recommendation:** Apache ECharts (vendored) — natively covers funnel, heatmap/matrix, gauge, stacked bars, donuts, lines, with clean light + dark themes.
**Answer:** ✅ Apache ECharts, vendored locally.

### Q4 — Screen scope (operational vs dashboards)
**Recommendation:** Full demo journey — dashboards + quote-capture form + filterable pipeline list + quote-detail/lifecycle view.
**Answer:** ✅ Full demo journey. Supports the brief's capture → workflow → control tower POC narrative.

### Q5 — Navigation model
**Recommendation:** Keep the 7 sidebar items as shown; 'Pipeline' page gets 'Quotes' (operational list) + 'Conversion' (analytics) tabs; global '+ New Quote' button; quote rows open detail view.
**Answer:** ✅ Option 1 (tabs within Pipeline + global New Quote).
**Added requirement:** 📱 Everything must be **responsive** and work well on mobile — Claude to pick sensible breakpoints (sidebar → drawer/bottom nav on small screens; dashboard grids → single-column stacks; tables → card/stacked layout).

### Q6 — Dark mode / theming
**Recommendation:** True dark / charcoal canvas with retained teal accent.
**Answer:** ✅ Build a **prototype options panel** (slide-in drawer via a gear icon) that lets the presenter switch theme live, plus other demo-useful toggles at Claude's discretion. Planned panel contents:
- **Theme:** Light (screenshot-matched default) · True Dark (charcoal) · Slate.
- **Persona/role switcher** (see Q7).
- **Density:** Comfortable / Compact.
- **Accent color:** Teal default + brand-safe alternates.
- **Reset demo data.**

Light theme = sampled directly from the screenshots (deep-teal sidebar, near-white canvas, teal primary, semantic green/amber/red/blue).

### Q7 — Role differentiation depth
**Recommendation:** Light, meaningful differentiation — same screens adapted per role.
**Answer:** ✅ Light, meaningful differentiation. Switching persona changes: identity/role badge, default landing screen, read-only vs editable affordances (ExCo = read-only, no New Quote/edit), and light data-scoping (RM → "my quotes & follow-ups"; Underwriter → underwriting SLA queue). All 5 roles selectable from the options panel.

### Q8 — Lifecycle stage model
**Recommendation:** Linear spine + status flags.
**Answer:** ✅ Six ordered stages drive the funnel (Request Received → Assigned → Quote Prepared → Quote Sent → Follow-Up → Won/Lost). Richer states (Awaiting Underwriting, Awaiting Client Info, Awaiting Broker Feedback, Follow-Up Due, Escalated, Expired) ride on top as status chips/flags, powering the Requires-Attention / Escalation views.

### Q9 — Data realism vs screenshot parity
**Recommendation:** Hybrid — one internally-consistent dataset tuned to land near the screenshot headline totals.
**Answer:** ✅ Hybrid. Generate ~300–500 quotes over ~12 months; all charts/filters/drill-downs derive from it truthfully; tune totals toward the screenshots' headline figures (~1,248 quotes, ~P128M quoted, ~33% conversion, ~2.6-day turnaround).

**Sample-data world (decided — Claude's judgment, flag to change):**
- Composite short-term + life insurer in Gaborone; currency BWP (P); Head of Sales persona = *Michael Ndlovu*.
- Product lines: Motor (Commercial Fleet/Private), Property (Fire & Allied/Householders), Liability (Public/PI), Engineering (CAR/Machinery Breakdown), Marine (Cargo), Group Life, Health/Medical, Funeral → grouped Short-term vs Life & Health.
- Request channels: Broker, Direct, Email, WhatsApp, Tender/RFQ, Walk-in.
- Brokers: ~8–10 tiered/branched (Aon, Marsh, Minet, Alexander Forbes, FNB Insurance Brokers, Stanbic + local; Gaborone/Francistown/Maun).
- RMs: Botswana names reporting to Michael Ndlovu.
- Segments/industries: Mining, Construction, Retail, Logistics, Government/Parastatal, Agriculture, Financial Services, Hospitality, SME.
- Regions: Gaborone, Francistown, Maun, Lobatse, Selebi-Phikwe, Palapye, Kasane.
- SLA defaults: request→quote 3 business days (1–5 by product); underwriting SLA 2 days; quote validity 30 days; follow-up overdue after 5 idle days.
- Escalation defaults: high-value ≥ **P250,000**; stalled if open >14 days; expired if past valid-until.
- Loss reasons: Pricing · Incumbent retained · Tender outcome · Brand trust · Coverage gaps · Service concerns · Other (+ competitor name/premium where known).
- Demo time anchor: fixed "today" = 31 May 2025 (matches screenshot date range), ~12 months of history behind it.

**Build-phase note:** May use the **playground skill** to accelerate the prototype (esp. the live options panel), falling back to a hand-built shell for the multi-screen app.

### Q10 — Interactivity of the core journey
**Recommendation:** Live in-memory state.
**Answer:** ✅ Live in-memory state. New Quote adds a real row; stage advance, follow-up logging, and Won/Lost (mandatory lost-reason) mutate the in-session data and reflect live across pipeline + dashboards. Persisted to localStorage; "Reset demo data" restores the seed.

### Q11 — Export / Reports behavior
**Recommendation:** Real client-side exports.
**Answer:** ✅ Real client-side CSV/Excel downloads from live data + a formatted print-ready (print → PDF) ExCo report view on the Reports screen.

### Q12 — Branding & logo
**Recommendation:** Recreate the "The Brittany / QuoteIQ" mark from the screenshots as inline SVG/CSS.
**Answer:** ✅ Recreate from screenshots — themeable for light/dark, no asset dependency, one-line swap if official files arrive later.

---

## Consolidated build blueprint (to discuss before building the prototype)

### Global shell
- **Sidebar** (deep-teal; collapses to a drawer on mobile): The Brittany + QuoteIQ mark; nav = Overview · Pipeline · Brokers · RM Performance · Loss Analysis · Alerts · Reports; persona card at the foot (Michael Ndlovu, Head of Sales).
- **Top bar:** page title, global date-range picker (default "May 2025"), search, **+ New Quote**, notifications bell (Alerts count), **gear → options panel**.
- **Options panel** (right drawer): Theme (Light / Dark / Slate) · Persona/role switcher (Head of Sales / RM / Underwriter / ExCo / Admin) · Density (Comfortable/Compact) · Accent · Reset demo data.
- **Demo tour:** brief optional welcome/coach-mark overlay for presenters (Claude's discretion).

### Screens
1. **Overview (Executive)** — KPI strip (Total Quotes, Quoted Premium, Won Premium MTD, Conversion/Hit Ratio, Avg Turnaround, Quotes at Risk) · Pipeline by Stage · Open-Quotes Aging (0–3/4–7/8–14/15+) · Win-rate Trend · High-Value Opportunities table · Requires Attention.
2. **Pipeline** — *Quotes* tab: filterable/sortable operational table (RM, broker, product, status, aging, premium, channel, segment) with status chips, premium-at-risk, next-follow-up, row → detail. *Conversion* tab (screenshot 2): KPI strip · Stage Conversion funnel · Pipeline by Product Line (stacked) · Quote Volume by Source (donut) · Aging · At-risk pipeline · Immediate Actions.
3. **Brokers** — volume, conversion, won premium, avg turnaround, top loss reason by broker; tier/branch breakdown; performance matrix/heatmap; productive-partner vs market-shopper insight.
4. **RM Performance** (screenshot 3) — Top RMs, conversion, overdue follow-ups, avg turnaround, won premium; performance matrix; turnaround by RM/team; performance watchlist; leadership-insights panel.
5. **Loss Analysis** — lost premium by reason; loss trend; loss by product/broker/segment; competitor analysis (who won, price gap); loss-commentary feed.
6. **Alerts (Escalation Queue)** — high-value stalled, overdue follow-ups, expiring/expired quotes, awaiting-underwriting beyond SLA, SLA breaches; actionable list with owner + premium at risk.
7. **Reports** — report catalogue (Executive weekly, Pipeline, Broker, RM, Loss, SLA/Turnaround), CSV/Excel export, print-ready ExCo report view.
- **+ New Quote form** — mandatory + value/segmentation fields, dropdowns/validation; adds a live row.
- **Quote detail / lifecycle** — header, lifecycle stepper w/ timestamps + turnaround, follow-up log + add, documents/version, audit trail, actions (advance / log follow-up / mark Won-Lost w/ loss intelligence).
- **Login / role landing** (light) — optional; persona also switchable from the options panel.

### Design system
- Light theme sampled from screenshots; Dark = charcoal; Slate = dimmed. Themeable ECharts (light/dark). Semantic green/amber/red/blue. Clean sans typography (Inter/system) vendored. Card-based dense layout. Fully responsive (sidebar→drawer, grids→single column, tables→stacked cards).

### Data layer (in-memory, localStorage-persisted)
- ~300–500 generated Quote records over ~12 months, tuned to screenshot headline totals. Reference lists (brokers, RMs, products, segments, regions, channels, loss reasons). All KPIs/charts computed live from the dataset. "Reset demo data" restores seed.

### Out of scope (prototype)
- Real backend/auth, email/WhatsApp/core-system integration, AI predictions (all Phase 2/3 per brief).

---

### Per-widget dashboard breakdown
A tile-by-tile annotation of the three reference screenshots (exact KPI tiles, chart types, table columns, and the sample figures to reuse as seed data) lives in **[`dashboard-breakdown.md`](./dashboard-breakdown.md)**.

---

## Status
✅ Interview complete (12 questions). ✅ Per-widget dashboard breakdown captured. ✅ **Prototype built** — see [`../app/`](../app/) (open `app/index.html`). Vanilla no-build SPA, vendored ECharts, ~1,248-quote seeded dataset, all 7 dashboards + capture/pipeline/detail journey, options panel (theme/persona/density), live state, CSV + print exports, responsive, welcome tour. Passes headless render/mount tests; headline figures land near the screenshots (1,248 quotes · ~33% conversion · ~P148M pipeline).

**Next:** review the prototype in-browser and gather feedback for refinement.
