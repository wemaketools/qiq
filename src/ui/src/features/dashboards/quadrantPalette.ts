/**
 * The single source of truth for the PRD 15.3 Broker/RM Performance Matrix quadrant palette (spec
 * FR-57/FR-58, T-034). This one constant is consumed by BOTH the matrix scatter's quadrant background
 * shading AND its legend, and is imported unchanged by the RM Performance matrix (T-035) — the labels
 * here are the generic PRD 15.3 volume/conversion categories, never broker- or RM-specific, so both
 * dashboards render identical quadrant semantics.
 *
 * Every color is a `--qiq-*` design-token reference (never a raw hex), per NFR-04/AC-070/V-070; the
 * actual theme-aware color values live in `theme/tokens.css` (`--qiq-quadrant-*`). This resolves the
 * T-031 quadrant-palette stopgap by giving the label↔key↔token mapping exactly one home.
 */

/** The four PRD 15.3 quadrants, keyed to match the server payload (`QuadrantClassifier.ToPayloadKey`). */
export type MatrixQuadrant = 'high-high' | 'high-low' | 'low-high' | 'low-low';

export interface QuadrantMeta {
  /** Payload key (matches the backend classifier and the `--qiq-quadrant-{key}` token suffix). */
  key: MatrixQuadrant;
  /** Generic PRD 15.3 category label (volume/conversion), reused verbatim across both matrices. */
  label: string;
  /** The `--qiq-*` token reference this quadrant renders in (points, shading, legend swatch). */
  color: string;
}

/** Ordered PRD 15.3 quadrant metadata — the single constant both the shading and the legend map over. */
export const QUADRANTS: readonly QuadrantMeta[] = [
  { key: 'high-high', label: 'High Volume / High Conversion', color: 'var(--qiq-quadrant-high-high)' },
  { key: 'high-low', label: 'High Volume / Low Conversion', color: 'var(--qiq-quadrant-high-low)' },
  { key: 'low-high', label: 'Low Volume / High Conversion', color: 'var(--qiq-quadrant-low-high)' },
  { key: 'low-low', label: 'Low Volume / Low Conversion', color: 'var(--qiq-quadrant-low-low)' },
];

const QUADRANT_COLOR_BY_KEY: Record<MatrixQuadrant, string> = Object.fromEntries(
  QUADRANTS.map((quadrant) => [quadrant.key, quadrant.color]),
) as Record<MatrixQuadrant, string>;

/** The token color for a server-classified quadrant key (falls back to the low/low neutral for any unknown key). */
export function quadrantColor(key: string): string {
  return QUADRANT_COLOR_BY_KEY[key as MatrixQuadrant] ?? 'var(--qiq-quadrant-low-low)';
}
