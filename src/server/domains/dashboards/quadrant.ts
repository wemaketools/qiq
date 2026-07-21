/**
 * The PRD 15.3 performance-matrix quadrant classification (T-037; AC-078).
 *
 * Port of `src/api/QuoteIQ.Domain/Metrics/QuadrantClassifier.cs`.
 *
 * ONE CLASSIFIER, TWO DASHBOARDS, ON PURPOSE
 * ==========================================
 * Broker Performance and RM Performance both render a (quote volume x conversion rate) matrix, and
 * the SPA renders BOTH with the same `BrokerMatrixScatter` + `quadrantPalette` (rmApi.ts imports
 * `BrokerMatrixDto` from brokersApi.ts). Two implementations of "which quadrant is this" would be
 * two chances to disagree about the same broker on two screens — so the rule lives here once and
 * both services call it.
 *
 * BOTH BOUNDARIES ARE INCLUSIVE AND THAT IS THE LOAD-BEARING DETAIL
 * ================================================================
 * A subject is HIGH on an axis when its value is at or above that axis's split (`>=`, :42-43). With
 * a median split and an even population, the two middle subjects straddle the split exactly; an
 * off-by-one to `>` would demote the median subject on both axes at once and move it two quadrants.
 */

/** The stable payload keys, matching the SPA's `MatrixQuadrant` union and the shared palette. */
export const PERFORMANCE_QUADRANTS = ['high-high', 'high-low', 'low-high', 'low-low'] as const;
export type PerformanceQuadrant = (typeof PERFORMANCE_QUADRANTS)[number];

/**
 * `QuadrantClassifier.Median` (:61-74) — the axis split when no configured threshold exists.
 *
 * FLAGGED, INHERITED FROM THE REFERENCE: the PRD defines no configurable split and no tenant
 * setting holds one, so the median is the documented default. The payload carries the resolved
 * splits (`volumeSplit`/`conversionSplit`) precisely so a configured variant is a drop-in later.
 *
 * An empty population returns 0, NOT null or a throw: with no data every point must land on the
 * low side of that axis, which `>= 0` gives only if the split is 0 — and a thrown error here would
 * take down a whole dashboard because one tenant has no brokers yet.
 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;

  const ordered = [...values].sort((left, right) => left - right);
  const mid = Math.floor(ordered.length / 2);

  if (ordered.length % 2 === 1) return ordered[mid] as number;
  return ((ordered[mid - 1] as number) + (ordered[mid] as number)) / 2;
}

/**
 * `QuadrantClassifier.Classify` (:40-52).
 *
 * A NULL conversion is LOW, never high and never an error. Null means "nothing decided yet", and
 * the alternative readings are both worse: treating it as high would promote a broker with no
 * outcomes into the strategic-partner quadrant, and treating it as 0 would be a claim we lost every
 * deal — which is the same conflation `metrics/index.ts` refuses to make for the rate itself.
 */
export function classifyQuadrant(
  volume: number,
  conversion: number | null,
  volumeSplit: number,
  conversionSplit: number,
): PerformanceQuadrant {
  const highVolume = volume >= volumeSplit;
  const highConversion = conversion !== null && conversion >= conversionSplit;

  if (highVolume) return highConversion ? 'high-high' : 'high-low';
  return highConversion ? 'low-high' : 'low-low';
}
