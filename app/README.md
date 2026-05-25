# QuoteIQ — Prototype

A clickable, offline prototype of the QuoteIQ quotation-intelligence control tower for **The Brittany**, with realistic Botswana insurance sample data.

## Run it
Just open **`index.html`** in any modern browser (Chrome/Edge/Safari/Firefox). No build step, no server, no internet required — Apache ECharts is vendored locally and fonts use the system stack.

```
open index.html        # macOS
```

## What's inside
- **7 dashboards** (sidebar): Overview · Pipeline & Conversion · Brokers · RM Performance · Loss Analysis · Alerts · Reports.
- **Operational journey:** `+ New Quote` capture form → working Pipeline list (Quotes tab) → Quote detail with lifecycle stepper, follow-up log, audit trail, and **Mark Won / Mark Lost** (with mandatory loss reason).
- **Live in-memory state:** captured/advanced quotes update the pipeline *and* the dashboards; persisted to `localStorage`.
- **Options panel** (top-right gear): theme (Light / Dark / Slate), accent colour, density, **persona switcher** (Head of Sales · RM · Underwriter · ExCo read-only · Admin), and **Reset demo data**.
- **Real exports:** CSV downloads + print-ready (PDF) ExCo report views on the Reports screen.
- Fully **responsive** (sidebar collapses to a drawer; tables stack into cards on mobile).
- Welcome **tour** on first load (replay via the ? icon or options panel).

## Structure
```
index.html
assets/css/styles.css          themes, layout, components, responsive, print
assets/vendor/echarts.min.js   vendored charting library (offline)
assets/js/
  data.js      seeded sample dataset (~1,248 quotes), persistence, derivations
  charts.js    ECharts builders themed from CSS variables
  ui.js        icons, brand mark, component builders
  screens.js   the 7 dashboards + pipeline tabs
  forms.js     new-quote form, quote detail, won/lost, reports, tour
  app.js       shell, router, options panel, theming
```

## Notes
- Demo "today" is anchored to **31 May 2025** (matches the reference screenshots).
- Currency throughout is **BWP**. Figures are tuned to land near the reference headline numbers while remaining internally consistent (every chart/filter derives from the same data).
- Not wired to a backend — Phase 2/3 items (email/WhatsApp, core-system integration, AI predictions) are intentionally out of scope.
