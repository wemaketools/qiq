/**
 * The reference-data list-type registry (T-019, AC-035; test_plan.unit).
 *
 * Pure rule checks, no database: the three per-type predicates the create/update handlers branch on,
 * and the parser the routes reject unknown list types with.
 */
import { describe, expect, it } from 'vitest';

import { REFERENCE_LIST_TYPES } from '../../domains/reference-data/canonical-statuses.js';
import {
  INTERMEDIATE_REPORTING_CATEGORIES,
  carriesBrokerChannelFlag,
  isIntermediateReportingCategory,
  isStatusListType,
  parseReferenceListType,
  requiresProductLine,
} from '../../domains/reference-data/list-types.js';

describe('parseReferenceListType', () => {
  it.each(REFERENCE_LIST_TYPES)('accepts the seeded list type %s', (listType) => {
    expect(parseReferenceListType(listType)).toBe(listType);
  });

  it('accepts exactly the eleven list types the reference enum declares', () => {
    // ReferenceListType.cs:9-22. A twelfth would need a matching migration CHECK constraint.
    expect(REFERENCE_LIST_TYPES).toHaveLength(11);
  });

  it('rejects an unrecognized list type', () => {
    expect(parseReferenceListType('not_a_list')).toBeNull();
    expect(parseReferenceListType('')).toBeNull();
    expect(parseReferenceListType(undefined)).toBeNull();
  });

  it('rejects a case variant, matching the reference StringComparer.Ordinal lookup', () => {
    expect(parseReferenceListType('Region')).toBeNull();
    expect(parseReferenceListType('REGION')).toBeNull();
    expect(parseReferenceListType('leadStatus')).toBeNull();
  });
});

describe('per-list-type rules', () => {
  it('treats only lead_status and quote_status as guarded status lists', () => {
    const statusLists = REFERENCE_LIST_TYPES.filter(isStatusListType);
    expect(statusLists).toEqual(['lead_status', 'quote_status']);
  });

  it('gives the broker flag to request channels alone', () => {
    expect(REFERENCE_LIST_TYPES.filter(carriesBrokerChannelFlag)).toEqual(['request_channel']);
  });

  it('requires a parent product line for cover types alone', () => {
    expect(REFERENCE_LIST_TYPES.filter(requiresProductLine)).toEqual(['cover_type']);
  });
});

describe('intermediate reporting categories', () => {
  it('allows only open and quoted for tenant-added statuses', () => {
    expect(INTERMEDIATE_REPORTING_CATEGORIES).toEqual(['open', 'quoted']);
    expect(isIntermediateReportingCategory('open')).toBe(true);
    expect(isIntermediateReportingCategory('quoted')).toBe(true);
  });

  it('rejects every terminal category, which only the seeded canonical statuses may hold', () => {
    for (const terminal of ['won', 'lost', 'expired', 'withdrawn']) {
      expect(isIntermediateReportingCategory(terminal)).toBe(false);
    }
  });

  it('rejects null and unrecognized strings', () => {
    expect(isIntermediateReportingCategory(null)).toBe(false);
    expect(isIntermediateReportingCategory('not-a-category')).toBe(false);
    expect(isIntermediateReportingCategory('Open')).toBe(false);
  });
});
