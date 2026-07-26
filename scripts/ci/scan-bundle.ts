#!/usr/bin/env tsx
/**
 * Built-bundle secret / server-module scan (T-051, AC-002 / V-003).
 *
 * WHY THIS EXISTS — AND WHY IT BUILDS FIRST: the source-level guards
 * (`src/ui/src/auth/browserClientBoundary.test.ts`, `supabase-server-only.test.ts`) prove SPA
 * *source* never names a server secret or imports a `src/server` module. They cannot see what a
 * bundler INLINES: a secret pulled into the client bundle by a transitive or accidental import
 * would pass a source scan and still ship to the browser. This scan closes that gap by exercising
 * the ARTIFACT, not its source — it runs `npm run build:ui` and then scans the emitted
 * `src/ui/dist`, failing if any server secret name/value or `src/server` module fragment appears.
 *
 * A scan that re-reads source instead of the built dist does NOT close the gap and must be
 * rejected in review.
 *
 * Deterministic and network-free (the build reads no network; the scan reads only local files).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DIST_DIR = resolve(repoRoot, 'src/ui/dist');

export interface BundleFinding {
  readonly file: string;
  readonly rule: string;
  readonly excerpt: string;
}

interface BundleRule {
  readonly name: string;
  readonly description: string;
  readonly pattern: RegExp;
}

/**
 * Server-only variable names. The config schema (`src/server/lib/config/schema.ts`) holds every
 * one of these as a STRING LITERAL, so any accidental import of the server config into the client
 * inlines these literals into the bundle — which is exactly what this catches. Minification renames
 * identifiers but never string-literal contents, so the names survive.
 */
const SERVER_ONLY_VAR_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DATABASE_URL',
  'SUPABASE_DIRECT_DATABASE_URL',
  'CRON_SECRET',
  'INTERNAL_JOB_SECRET',
  'API_KEY_PEPPER',
] as const;

/** Only text assets can be scanned as source; binary assets carry no readable literals. */
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.svg', '.txt']);

export const BUNDLE_RULES: readonly BundleRule[] = [
  ...SERVER_ONLY_VAR_NAMES.map((name) => ({
    name: `server-var:${name}`,
    description: `server-only variable name ${name} inlined into the client bundle`,
    pattern: new RegExp(`\\b${name}\\b`),
  })),
  {
    name: 'service-role-literal',
    description: 'the string "service_role" (only ever names the RLS-bypassing key)',
    pattern: /service_role/,
  },
  {
    name: 'supabase-secret-key',
    description: 'a Supabase secret API key value (sb_secret_…)',
    pattern: /\bsb_secret_[A-Za-z0-9]{16,}/,
  },
  {
    name: 'server-module-path',
    description: 'a src/server module path fragment (server code leaked into the bundle)',
    pattern: /src\/server\//,
  },
];

function normalise(relPath: string): string {
  return relPath.split('\\').join('/');
}

function extensionOf(relPath: string): string {
  const base = normalise(relPath);
  const dot = base.lastIndexOf('.');
  const slash = base.lastIndexOf('/');
  return dot > slash ? base.slice(dot).toLowerCase() : '';
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = resolve(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/** Never echo a full candidate secret; keep enough to locate it. */
function redact(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-3)} (${value.length} chars)`;
}

/**
 * Pure scan of an already-built dist directory. Exposed so tests can exercise the matching logic
 * against a synthetic dist without running a full Vite build.
 *
 * `extraSecretValues` are concrete secret VALUES (e.g. a real service-role key present in the
 * environment at scan time) whose literal presence in any asset is also a leak. On a CI runner
 * without those variables the list is empty and the name/path rules carry the scan.
 */
export function scanBundleDir(distDir: string, extraSecretValues: readonly string[] = []): BundleFinding[] {
  const files = walk(distDir).filter((f) => SCANNED_EXTENSIONS.has(extensionOf(f)));
  const findings: BundleFinding[] = [];
  const valueRules = extraSecretValues
    .filter((value) => value.trim().length >= 12 && !value.includes('<'))
    .map((value) => ({ name: 'secret-value', value }));

  for (const full of files) {
    const relPath = normalise(relative(distDir, full));
    const content = readFileSync(full, 'latin1');
    for (const rule of BUNDLE_RULES) {
      const match = new RegExp(rule.pattern.source, rule.pattern.flags).exec(content);
      if (match) {
        findings.push({ file: relPath, rule: rule.name, excerpt: redact(match[0]) });
      }
    }
    for (const rule of valueRules) {
      if (content.includes(rule.value)) {
        findings.push({ file: relPath, rule: rule.name, excerpt: redact(rule.value) });
      }
    }
  }
  return findings;
}

function buildUi(): void {
  console.error('[scan-bundle] building the SPA (npm run build:ui)...');
  const run = spawnSync('npm run build:ui', {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    stdio: 'inherit',
  });
  if (run.status !== 0) {
    console.error(`\n[scan-bundle] FAILED: build:ui exited ${String(run.status)}.\n`);
    process.exit(1);
  }
}

function main(): void {
  buildUi();
  const assets = walk(DIST_DIR).filter((f) => SCANNED_EXTENSIONS.has(extensionOf(f)));
  if (assets.length === 0) {
    console.error(`\n[scan-bundle] FAILED: no text assets found under ${DIST_DIR}. Did the build emit anything?\n`);
    process.exit(1);
  }
  // The build runs without the server secrets in scope (the SPA reads only VITE_ variables), so
  // there are no concrete secret VALUES to cross-check here — the server variable NAME and
  // src/server module-path rules carry the scan. `scanBundleDir` still accepts explicit values so a
  // caller that DOES have a known key to hunt for (or a test) can pass it. Reading the ambient
  // process environment here is deliberately avoided: this repo confines every `process.env` read to
  // the typed config module (eslint no-restricted-properties).
  const findings = scanBundleDir(DIST_DIR);
  if (findings.length > 0) {
    console.error(`\n[scan-bundle] FAILED: ${findings.length} server secret/module leak(s) in the built SPA bundle:`);
    for (const f of findings) {
      console.error(`  - ${f.file} [${f.rule}] ${f.excerpt}`);
    }
    console.error(
      '\nServer-only code and secrets must never reach the client bundle. Trace the offending ' +
        'import back from src/ui and remove the path that pulls src/server (or a server secret) in.\n',
    );
    process.exit(1);
  }
  console.error(`[scan-bundle] OK: scanned ${assets.length} built asset(s) under src/ui/dist, 0 leaks.`);
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
