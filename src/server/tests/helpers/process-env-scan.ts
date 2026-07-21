import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/**
 * Grep-based guard for AC-010 / V-012: environment variables may only be read inside the typed
 * config module.
 *
 * The pattern is composed at runtime so that this scanner (and the test that uses it) does not
 * match itself, which keeps the allow-list honest — only real consumers are exempt.
 */
const FORBIDDEN = new RegExp(['process', '\\s*\\.\\s*', 'env'].join(''));

/** The only file permitted to touch the process environment directly. */
export const allowedFiles: readonly string[] = ['src/server/lib/config/index.ts'];

/** Roots scanned by the repository-wide check. */
export const scannedRoots: readonly string[] = ['src/server', 'api', 'scripts'];

/**
 * The test tree is excluded from the textual scan because test names and violation fixtures
 * legitimately contain the forbidden text as a string literal, which a grep cannot distinguish
 * from a real read. The AST-aware ESLint rule (`no-restricted-properties`) does cover the test
 * tree and is the authoritative gate there.
 */
export const excludedPrefixes: readonly string[] = ['src/server/tests/'];

const SCANNED_EXTENSIONS = ['.ts', '.mts', '.cts', '.mjs', '.js'];
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.turbo']);

export interface SourceEntry {
  /** Repository-relative path with forward slashes. */
  readonly path: string;
  readonly contents: string;
}

export interface EnvViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Recursively collects scannable source files under `roots`, relative to `repoRoot`. */
export function collectSourceFiles(repoRoot: string, roots: readonly string[]): SourceEntry[] {
  const entries: SourceEntry[] = [];

  const walk = (absolute: string): void => {
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      return;
    }

    if (stats.isDirectory()) {
      for (const name of readdirSync(absolute)) {
        if (SKIPPED_DIRECTORIES.has(name)) continue;
        walk(resolve(absolute, name));
      }
      return;
    }

    if (!SCANNED_EXTENSIONS.some((extension) => absolute.endsWith(extension))) return;

    const path = relative(repoRoot, absolute).split('\\').join('/');
    if (excludedPrefixes.some((prefix) => path.startsWith(prefix))) return;

    entries.push({ path, contents: readFileSync(absolute, 'utf8') });
  };

  for (const root of roots) {
    walk(resolve(repoRoot, root));
  }

  return entries;
}

/**
 * True for lines that are ENTIRELY comment, and therefore cannot perform a read.
 *
 * A grep cannot tell `process.env` in prose from a real access, so documenting that a module is
 * free of direct environment reads used to TRIP this guard — penalising exactly the security
 * documentation the project wants (it fired on two JSDoc lines in `domains/api-access`).
 *
 * Deliberately narrow. Only `//` and JSDoc-continuation `*` prefixes are skipped: neither can
 * carry executable code. A line opening with `/*` is NOT skipped, because `_/* note *_/
 * process.env.X` is real code on a comment-opening line. Trailing comments are likewise not
 * skipped — the code before them is still scanned. The AST-aware ESLint `no-restricted-properties`
 * rule remains the authoritative gate; this scan is defense in depth.
 */
function isCommentOnlyLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*');
}

/** Returns every direct environment access outside the allow-listed config module. */
export function findProcessEnvViolations(
  entries: readonly SourceEntry[],
  allowList: readonly string[] = allowedFiles,
): EnvViolation[] {
  const violations: EnvViolation[] = [];

  for (const entry of entries) {
    if (allowList.includes(entry.path)) continue;

    entry.contents.split(/\r?\n/).forEach((text, index) => {
      if (isCommentOnlyLine(text)) return;
      if (FORBIDDEN.test(text)) {
        violations.push({ path: entry.path, line: index + 1, text: text.trim() });
      }
    });
  }

  return violations;
}
