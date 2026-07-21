import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers/repo.js';

const files = ['.env.example', '.env.local.example'];

describe('environment example files', () => {
  it.each(files)('%s contains placeholders only, never a real credential', (relative) => {
    const contents = readFileSync(resolve(repoRoot, relative), 'utf8');

    expect(contents).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(contents).not.toMatch(/postgres(ql)?:\/\/[^\s:]+:[^\s@<]+@/);

    for (const line of contents.split(/\r?\n/)) {
      if (!line.includes('=') || line.trimStart().startsWith('#')) continue;
      const value = line.slice(line.indexOf('=') + 1).trim();
      if (value === '') continue;
      expect(
        value.includes('<') || value.includes('localhost') || value.includes('127.0.0.1'),
        `"${line}" must use a placeholder or local-only value`,
      ).toBe(true);
    }
  });
});
