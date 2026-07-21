# QuoteIQ — Per-Widget Dashboard Breakdown

> Extracted tile-by-tile from the three reference screenshots (`spec/reference/initial/QuoteIQ 1–3.png`) so the prototype can match them closely. Values are the exact sample figures shown in the images — reuse them as the seed dataset's headline numbers (Q9 hybrid decision).

## Shared chrome (all screens)
- **Sidebar (deep navy-teal):** "The Brittany" emblem + "QuoteIQ" wordmark + "Quotation Intelligence" subtitle. Nav: Overview · Pipeline · Brokers · RM Performance · Loss Analysis · Alerts · Reports. Footer card: avatar + "Michael Ndlovu / Head of Sales" with a chevron. A small badge ("8") sits near the lower nav (likely an alert/notification count).
- **Page header:** Title "QuoteIQ – <Screen>" left; top-right icons: notifications bell, help/?, and an **Export ▾** button.
- **Filter bar:** Date Range (default "May 1 – May 31, 2025", calendar icon) · Product Line (All) · Broker (All) · RM (All) · Region (All) · **↺ Clear filters**.
- **Footer:** "© 2025 The Brittany. All rights reserved." · centered "All amounts in BWP" · right "Data as of May 31, 2025 08:30 SAST" + refresh icon.
- Cards: white, rounded (~12px), soft shadow, generous padding. KPI cards carry a tinted circular icon, label, big value, and a colored ↑/↓ delta "vs Apr 1–30".

---

## Screen 1 — Executive Overview

**KPI strip (6 cards):**
| Card | Value | Delta |
|---|---|---|
| Total Quotes | 1,248 | ↑14% vs Apr 1–30 |
| Open Pipeline Premium | BWP 128.6M | ↑9% |
| Won Premium MTD | BWP 42.3M | ↑21% |
| Conversion Rate | 33.9% | ↑3.6pp |
| Avg Turnaround | 2.6 days | ↓0.6 days (down = good, green) |
| Quotes at Risk | 87 | ↑15 (amber/warning) |

**Pipeline by Stage** (horizontal bar / funnel, left-mid). Stages w/ count + conversion %: New Quotes 1,248 (100%) · Information Gathering 842 (67%) · Pending Underwriting 512 (41%) · Pending Pricing 326 (26%) · Proposal Sent ~?(23%) · Negotiation 132 (11%) · Won 88 (8%). Teal bars; "View full pipeline →".

**Open Quotes Aging** (donut, center "512 / Open Quotes"). Buckets w/ counts: 0–3 days 168 · 4–7 days 142 · 8–14 days 118 · 15+ days 84. Colors teal / navy / orange / purple. "View aging report →". (⋮ menu top-right.)

**Won vs Lost Trend** (line, top-right). Toggle "Weekly". Two series: Won Premium (BWP) — solid teal; Lost Premium (BWP) — dashed purple. Y-axis 0/20M/40M/60M. X-axis weekly Mar 31 → May 19. "View trend analysis →".

**High-Value Opportunities** (table, bottom-left). Columns: Client · Broker · Product · Premium (BWP) · Stage (chip) · Next Action (+ date). Rows:
1. Botswana Mining Co. · Alpha Brokers · Commercial Combined · 8,750,000 · *Pending Pricing* · Provide revised terms — Jun 2, 2025
2. SADC Logistics (Pty) Ltd · TradeSure Brokers · Cargo Insurance · 6,420,000 · *Proposal Sent* · Client feedback call — May 28, 2025
3. Kalahari Energy (Pty) Ltd · Desert Risk Advisors · Engineering · 5,200,000 · *Negotiation* · Executive review — May 30, 2025
4. BluePeak Hospitality · Premier Brokers · Business Interruption · 4,250,000 · *Pending Underwriting* · Send UW info — May 25, 2025
5. Northern Agro (Pty) Ltd · AgriPro Brokers · Farmers All Risks · 3,850,000 · *Information Gathering* · Gather loss history — May 24, 2025
"View all opportunities →".

**Requires Attention** (panel, bottom-right). "View all alerts →". Rows (icon · title · subtitle · count · ›):
- Stalled Quotes — "Quotes with no activity in 7+ days" — **34** (red)
- Overdue Follow-ups — "Follow-ups past next action date" — **28** (amber)
- Expiring Quotes — "Quotes expiring in 7 days or less" — **25** (amber)
"Go to alerts center →".

---

## Screen 2 — Pipeline & Conversion

**KPI strip (6):** New Quotes This Month 1,248 (↑14%) · Open Pipeline Value BWP 128.6M (↑9%) · Quote-to-Proposal Rate 34.7% (↑3.6pp) · Proposal-to-Win Rate 28.9% (↑2.4pp) · Avg Quote Age 6.1 days (↓0.8 days) · SLA Breaches 37 (↑12, amber).

**Pipeline Stage Conversion** (funnel, left). Count + conversion %: New Quote 1,248 (100%) · Under Review 842 (67%) · Pricing 512 (41%) · Proposal Sent 326 (26%) · Negotiation 198 (16%) · Won 132 (11%) · Lost 88 (8%). Teal-gradient funnel. "View full conversion report →".

**Pipeline by Product Line (Open Pipeline Value)** (stacked vertical bars, center). Series: Motor (navy) · Property (teal) · Engineering (green) · Marine (purple) · Group Life (orange). Months w/ totals: Jan 25 BWP 98.4M · Feb 25 103.7M · Mar 25 112.1M · Apr 25 121.3M · May 25 128.6M. Y-axis BWP 0–100M. "View product line breakdown →". (⋮ menu.)

**Quote Volume by Source (This Month)** (donut, right; center "1,248 / Total Quotes"). Legend w/ count + %: TradeSure Brokers 412 (33%) · Alpha Brokers 298 (24%) · Premier Brokers 264 (~21%) · AgriPro Brokers 88 (8%) · Northern Agri 76 (6%) · Other Brokers 150 (12%). "View source performance →".

**Aging by Stage (Number of Quotes)** (heatmap matrix, bottom-left). Columns: Stage · 0–3 days · 4–7 days · 8–14 days · 15–30 days · 31–60 days · 60+ days · Total. Rows (approx): New Quote 842/328/156/78/28/16 → 1,248 · Under Review 126/226/144/78/36/22 → 842 · Pricing 188/138/92/54/26/13 → 512 · Proposal Sent 108/96/64/32/16/8 → … · Negotiation 64/42/28/18/9/6 → … · Won 72/36/16/6/2/1 → 132 · Lost 48/24/8/4/2/1 → 88. Cells color-graded green→yellow→red by concentration. "View aging analysis →".

**At-Risk Pipeline** (table, bottom-mid). Columns: Client · Broker · Premium (BWP) · Stage (chip) · Age (red/amber) · Owner · Risk Reason. Rows:
1. Botswana Milling Co. · Alpha Brokers · 4,750,000 · *Pricing* · 21 days · L. Dlamini · Pricing approval delayed
2. SADC Logistics (Pty) Ltd · TradeSure Brokers · 6,200,000 · *Proposal Sent* · 18 days · M. Ndlovu · Client feedback pending
3. Kalahari Energy (Pty) Ltd · Premier Brokers · 5,680,000 · *Negotiation* · 17 days · T. Mokoena · Terms under review
4. BluePeak Hospitality · AgriPro Brokers · 4,250,000 · *Under Review* · 14 days · S. Phiri · Additional info requested
5. Northern Agri (Pty) Ltd · Northern Agri · 3,850,000 · *Pricing* · 13 days · P. Kgosi · Awaiting underwriter
"View full at-risk pipeline →".

**Immediate Actions** (panel, bottom-right). Rows: Overdue Quotes — "Quotes past initial SLA (> 2 days)" — **34** (red) · Pending Pricing Approvals — "Awaiting pricing approval" — **19** (amber) · Exec Escalations — "Requires executive attention" — **8** (purple) · SLA Breaches — "Breached SLA commitments" — **37** (orange). "Go to alerts center →".

---

## Screen 3 — RM & Broker Performance

**KPI strip (6):** Active RMs 56 · Active Brokers 342 · Won Premium YTD BWP 128.6M (↑8%) · RM Conversion Rate 33.9% (↑21%) · Broker Conversion Rate 28.7% (↑11%) · Follow-up Compliance 72% (↑…).

**Top Relationship Managers (By Won Premium)** (horizontal bars + Conversion column, left). Kabelo Moroke BWP 18.7M · Neo Dlamini 14.3M · Michael Ndlovu 12.9M · Thato Mokoena 10.8M · Lesedi Phiri 9.6M (each with a conversion % on the right). "View all RMs →".

**Top Brokers / Partners (By Quote Volume)** (bars + Conversion column, center). Alpha Brokers 1,248 — 31.4% · TradeSure Brokers 1,052 — 29.8% · Botswana Marine Co. 842 — 33.1% · Premier Brokers 726 — 28.3% · SADC Logistics (Pty) Ltd 618 — 27.7%. "View all brokers →".

**Broker Performance Matrix** (scatter/bubble, right). X = Quote Volume (Low→High); Y = Conversion Rate. Quadrant legend (4 colors): High Volume/High Conversion · High Volume/Low Conversion · Low Volume/High Conversion · Low Volume/Low Conversion. Plotted: Botswana Marine Co., Premier Brokers (mid-left high conv); Alpha Brokers, TradeSure Brokers (top-right); SADC Logistics, BluePeak Hospitality (mid); Northern Agro (Pty) Ltd, Desert Risk Advisors (bottom-left, at-risk colors).

**Turnaround (SLA) by RM / Team** (horizontal bars, bottom-left). Dropdown "Avg Turnaround (Days)". Corporate & Commercial 2.4 · Property & Engineering 2.9 · Retail & SME 3.6 · Specialty Risks 4.3 · Agriculture 5.1. X-axis 0–6 with dashed "SLA Target: 3 Days" line (bars beyond target flagged).

**Performance Watchlist** (table, bottom-mid). Columns: Broker/RM · Quotes · Won Premium · Conversion · Avg Turnaround · Overdue Follow-ups · Suggested Action (chip). Rows:
- Alpha Brokers · 1,248 · BWP 32.4M · 31.4% · 2.1 days · — · *Maintain momentum* (green)
- Kabelo Moroke · 412 · BWP 18.7M · 41.2% · 2.0 days · 5 · *Recognize & retain* (green)
- TradeSure Brokers · 1,052 · BWP 24.8M · 29.8% · 2.5 days · — · *Deepen engagement* (teal)
- Thato Mokoena · … · … · 32.1% · … · 21 · *Coaching & support* (amber)
- Desert Risk Advisors · 156 · BWP 2.1M · 13.5% · 4.7 days · — · *Evaluate & intervene* (red)
"View full watchlist →".

**Leadership Insights** (panel, bottom-right). Icon + title + description:
- Top performing broker — "Alpha Brokers leads with BWP 32.4M won premium (+18% vs Apr 1–30)"
- Underperforming RM — "Thato Mokoena has the lowest conversion at 32.1% and 21 overdue follow-ups"
- Turnaround at risk — "Agriculture team averaging 5.1 days vs 3-day SLA"
- Follow-up compliance — "72% overall compliance. 26 brokers below 50%"
- Largest premium opportunity — "BWP 42.3M in active quotes > 15 days"
"View all insights →".

---

## Cross-screen notes for the build
- **Stage chips** appear throughout with consistent colors per stage (Pending Pricing, Proposal Sent, Negotiation, Pending Underwriting, Information Gathering/Under Review, Won, Lost). Define one shared chip palette.
- **Two stage vocabularies** appear: Overview uses "Information Gathering / Pending Underwriting / Pending Pricing / Proposal Sent / Negotiation"; Pipeline uses "Under Review / Pricing / Proposal Sent / Negotiation". Reconcile to one canonical set (map Information Gathering↔Under Review, Pending Pricing↔Pricing) per the Q8 6-stage spine + flags.
- **Deltas** are always "vs Apr 1–30"; green for good-direction, amber/red for bad-direction (note turnaround ↓ is good).
- **"View … →" links** on every card → navigate to the relevant full screen/tab.
- Headline seed totals to reuse: 1,248 quotes · BWP 128.6M open pipeline · BWP 42.3M won MTD · 33.9% conversion · 2.6-day avg turnaround · 512 open · 87 at risk · 37 SLA breaches.
