/** `LeadPolicyTerm` canonical codes (`src/api/QuoteIQ.Domain/Leads/LeadConstants.cs`), spec Q-11.
 * Kept out of `CoverageSection.tsx` (which exports only the component) so that file stays
 * fast-refresh-clean. */
export const POLICY_TERM_OPTIONS: { value: string; label: string }[] = [
  { value: 'm6', label: '6 months' },
  { value: 'm12', label: '12 months' },
  { value: 'm24', label: '24 months' },
  { value: 'm36', label: '36 months' },
  { value: 'other', label: 'Other' },
];

export const DEFAULT_POLICY_TERM = 'm12';
export const POLICY_TERM_OTHER = 'other';

/** `LeadPriority` canonical codes. */
export const PRIORITY_NORMAL = 'normal';
export const PRIORITY_HIGH = 'high';
