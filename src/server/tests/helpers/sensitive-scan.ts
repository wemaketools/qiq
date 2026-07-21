/**
 * Shared sensitive-data scanner (V-014).
 *
 * Any test that captures log output reuses this helper so that new log sites inherit the
 * check. It is deliberately independent of the production redactor: it must be able to fail
 * when the redactor is wrong, so it never imports from src/server/lib/logging.
 */

export interface SensitivePattern {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Structural patterns that must never appear in captured output regardless of which secret
 * produced them.
 */
export const sensitivePatterns: readonly SensitivePattern[] = [
  { label: 'JWT / Supabase legacy key (eyJ...)', pattern: /eyJ[A-Za-z0-9_-]{8,}/ },
  { label: 'Supabase secret/publishable key (sb_...)', pattern: /sb_(?:secret|publishable)_[A-Za-z0-9_-]{6,}/ },
  {
    label: 'Authorization header value (Bearer/Basic + credential)',
    pattern: /\b(?:Bearer|Basic|Digest)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{4,}/i,
  },
  {
    label: 'URL embedded credentials (scheme://user:password@host)',
    pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:(?!\[REDACTED\])[^\s/@]+@/,
  },
];

export interface SensitiveMatch {
  readonly label: string;
  readonly excerpt: string;
}

/**
 * Scans `text` for structural secret patterns plus every literal secret in `literals`.
 * Returns every violation found (empty array means clean).
 */
export function findSensitiveData(text: string, literals: readonly string[] = []): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  for (const { label, pattern } of sensitivePatterns) {
    const found = pattern.exec(text);
    if (found) {
      matches.push({ label, excerpt: found[0].slice(0, 60) });
    }
  }

  for (const literal of literals) {
    if (literal.length > 0 && text.includes(literal)) {
      matches.push({ label: `literal secret "${literal.slice(0, 12)}..."`, excerpt: literal.slice(0, 60) });
    }
  }

  return matches;
}

/** Renders violations as a readable assertion message. */
export function describeSensitiveMatches(matches: readonly SensitiveMatch[]): string {
  return matches.map((m) => `${m.label} -> ${m.excerpt}`).join('; ');
}
