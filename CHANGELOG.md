# QuoteIQ Prototype — Changelog

Versions shown in the sidebar and stamped on exported feedback.

## v0.4.2
- Removed **"The Brittany"** from site branding (sidebar eyebrow + footer copyright) per review.
- Fixed **search-bar icon alignment**: the magnifying-glass was anchored to the top of the input; now vertically centred (`top:50%` + `translateY(-50%)`).

## v0.4.1
- Fixed **dark/slate-mode text contrast** in the Prototype options panel: persona names rendered in near-black because the `.persona` `<button>` didn't inherit the theme text colour. Set an explicit `color: var(--text)` so names are legible in every theme.

## v0.4.0
- Added prototype **version number** (sidebar + footer), bumped each iteration.
- Added **Comment mode**: hover any card/KPI/row, click the **+** to leave feedback linked to that page + item. Comments persist locally, show numbered pins, and export as Markdown (with version + reviewer) via **Copy all**.
- Fixed responsive layout for tablets/phones: sidebar now collapses to a drawer at ≤1080px (iPad portrait), search hides at ≤1200px, topbar labels/subtitle collapse on small screens to prevent overflow.
- Made the sidebar user/persona card flush (removed the default button bevel + inset background).

## v0.3.0
- Replaced the Top Brokers / Top RMs bar charts with HTML rank lists that include an aligned **Conversion** column (matching the reference screenshots).
- Added **mobile "Show more"** to the long Pipeline and Alerts tables (12 rows initially, +12 per click; full list on desktop).
- Stacked the sidebar persona name/role onto two lines.

## v0.2.0
- Visual QA pass via Playwright across breakpoints.
- Fixed responsive grid bug (inline `grid-template-columns` overriding media queries) so chart rows collapse on mobile.
- Fixed broker performance matrix scatter labels (overlap + right-edge spill).
- Loss "Lost Premium Trend" changed to a single-series area line.
- Tuned the seed generator: younger/realistic open pipeline; **at-risk ≈ 87** matching the screenshots.

## v0.1.0
- Initial clickable prototype: 7 dashboards + capture → pipeline → quote-detail journey, options panel (theme/persona/density), live in-memory state, CSV + print exports, responsive shell, welcome tour. Seeded ~1,248-quote Botswana dataset.
