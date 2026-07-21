/**
 * Fixed chart color palettes shared by every dashboard (spec §10.1 "single charting approach ...
 * with the fixed product-line series palette and shared quadrant palette", T-031). Every value is a
 * `--qiq-*` design-token reference (never a raw hex), per NFR-04/AC-070.
 */

/** Product-line series palette (UI Standards §3.5) keyed by product-line display name, lowercased. */
export const SERIES_PALETTE: Record<string, string> = {
  motor: 'var(--qiq-series-motor)',
  property: 'var(--qiq-series-property)',
  engineering: 'var(--qiq-series-engineering)',
  marine: 'var(--qiq-series-marine)',
  grouplife: 'var(--qiq-series-grouplife)',
  'group life': 'var(--qiq-series-grouplife)',
};

const SERIES_FALLBACK = 'var(--qiq-neutral)';

/** Resolves a product line's series color, falling back to neutral for a tenant-added product line not in the fixed palette. */
export function resolveSeriesColor(productLineName: string): string {
  return SERIES_PALETTE[productLineName.trim().toLowerCase()] ?? SERIES_FALLBACK;
}

/*
 * The Broker/RM Performance Matrix quadrant palette formerly duplicated here (QUADRANT_PALETTE +
 * MatrixQuadrant + resolveMatrixQuadrant) was consolidated into the single source of truth at
 * `features/dashboards/quadrantPalette.ts` (T-035, resolving finding F-034-4). This module now owns
 * only the product-line series palette; import quadrant colors/keys from `quadrantPalette.ts`.
 */
