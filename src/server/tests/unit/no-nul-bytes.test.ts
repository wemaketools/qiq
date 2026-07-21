import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T-047. A raw `0x00` byte in a source file makes that file invisible to every grep/ripgrep-based
 * tool (they classify it as binary and skip it, or report only "Binary file matches"). Three files
 * had accidentally embedded one as a composite-key delimiter or test input; `grep -rlP '\x00'`
 * across the tree returned NOTHING because the scanner was itself blind to the very files it was
 * meant to catch.
 *
 * This guard reads bytes directly through `readFileSync` and checks for `0x00` with `indexOf`. It is
 * byte-level ON PURPOSE: a grep-based guard would be blind to precisely the files it must catch.
 * The runtime-identical fix is to write the delimiter as the `\u0000` escape sequence, which this
 * guard tolerates (the escape is ASCII source text; only the raw byte trips it).
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Roots that must never carry a raw NUL byte in source. */
const SCANNED_ROOTS: readonly string[] = ['src/server', 'api', 'scripts'];

/** Source extensions only; anything legitimately binary is excluded by omission. */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sql'];

const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.tmp']);

const NUL = 0x00;

function collectSourceFiles(root: string): string[] {
  const collected: string[] = [];
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
    if (SOURCE_EXTENSIONS.some((extension) => absolute.endsWith(extension))) {
      collected.push(absolute);
    }
  };
  walk(resolve(repoRoot, root));
  return collected;
}

/** Every scanned source file whose raw bytes contain a `0x00`, reported repo-relative. */
function filesWithRawNul(): string[] {
  const offenders: string[] = [];
  for (const root of SCANNED_ROOTS) {
    for (const file of collectSourceFiles(root)) {
      // Buffer, not utf8 string: a raw NUL survives the read and is detectable byte-for-byte.
      if (readFileSync(file).indexOf(NUL) !== -1) {
        offenders.push(relative(repoRoot, file).split('\\').join('/'));
      }
    }
  }
  return offenders;
}

describe('source files carry no raw NUL byte', () => {
  it('finds zero files containing a raw 0x00 across src/server, api and scripts', () => {
    expect(
      filesWithRawNul(),
      'a raw 0x00 byte makes a file binary-invisible to grep/ripgrep; write the delimiter as the ' +
        '\\u0000 escape (runtime-identical) instead of embedding the literal byte',
    ).toEqual([]);
  });
});
