import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

/**
 * T-046. `lib/validation` pins a per-rule error code by writing the message as `"CODE|human text"`.
 * The runtime parser now rejects a non-conforming prefix loudly, but that only fires when the rule
 * actually trips. This sweep is the at-rest gate: it fails the build the moment a malformed prefix
 * is *written*, without needing a request to exercise it.
 *
 * It reads files through `fs` rather than shelling out to grep on purpose. `grep -r` classifies
 * global-template.schemas.ts as binary (it embeds a literal NUL as a composite-key delimiter) and
 * silently skips it — a repo-wide grep would therefore miss six real prefixes in that very file.
 */
const CONFORMING_CODE = /^[A-Z][A-Za-z0-9_]*$/;

/** A quoted literal whose leading run of non-whitespace is followed by `|`. */
const PREFIXED_LITERAL = /(['"`])([^'"`\n]*?)\|/g;

const serverRoot = resolve(repoRoot, 'src/server');

function collectTypeScriptFiles(directory: string): string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'tests') {
        continue;
      }
      collected.push(...collectTypeScriptFiles(path));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.tmp.ts')) {
      collected.push(path);
    }
  }
  return collected;
}

interface FoundPrefix {
  readonly file: string;
  readonly code: string;
}

function collectPrefixes(): FoundPrefix[] {
  const found: FoundPrefix[] = [];
  for (const file of collectTypeScriptFiles(serverRoot)) {
    const contents = readFileSync(file, 'utf8');
    for (const match of contents.matchAll(PREFIXED_LITERAL)) {
      const candidate = match[2]!;
      // Prose uses spaced pipes (`'Allowed: New | Assigned'`); only an unbroken leading token is
      // prefix-shaped, which is exactly the runtime parser's own rule.
      if (candidate === '' || /\s/.test(candidate)) {
        continue;
      }
      found.push({ file: relative(repoRoot, file).replaceAll('\\', '/'), code: candidate });
    }
  }
  return found;
}

describe('explicit validation rule-code prefixes across src/server', () => {
  it('finds prefixes in files that grep skips as binary, proving the sweep has real reach', () => {
    const inGlobalTemplate = collectPrefixes().filter((entry) =>
      entry.file.endsWith('reference-data/global-template.schemas.ts'),
    );

    expect(inGlobalTemplate.length).toBeGreaterThan(0);
  });

  it('covers the domains that use the PascalCase FluentValidation form', () => {
    const files = new Set(collectPrefixes().map((entry) => entry.file));

    expect(files).toContain('src/server/domains/assignments/schemas.ts');
    expect(files).toContain('src/server/domains/brokers/schemas.ts');
    expect(files).toContain('src/server/domains/api-access/schemas.ts');
    expect(files).toContain('src/server/domains/business-rules/schemas.ts');
  });

  it('accepts only conforming rule codes', () => {
    const offenders = collectPrefixes().filter((entry) => !CONFORMING_CODE.test(entry.code));

    expect(
      offenders,
      'an explicit rule code must match [A-Z][A-Za-z0-9_]* so lib/validation parses it instead of ' +
        'silently deriving a different code and leaking the prefix into the user-visible message',
    ).toEqual([]);
  });
});
