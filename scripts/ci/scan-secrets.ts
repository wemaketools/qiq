#!/usr/bin/env tsx
/**
 * Repo-wide secret scan (T-051, AC-088 / V-114).
 *
 * WHY THIS EXISTS: `env-examples.test.ts` only guards the two `*.example` files, and the
 * built-bundle scan (`scan-bundle.ts`) only inspects `src/ui/dist`. Neither would catch a real
 * JWT, service-role key, private key, or an inline database password committed to some *other*
 * tracked file. This scan closes that gap: it walks every TRACKED file (`git ls-files`) and fails
 * the build, naming file and line, if a real-looking credential appears anywhere the allowlist
 * does not explicitly sanction.
 *
 * NOT A VACUOUS GUARD: the value-shape patterns below match real credential formats, not variable
 * names, so a clean repo passes and a planted secret fails. The allowlist is a short list of EXACT
 * paths — the two placeholder example files and the deliberate fake-secret test fixtures — never a
 * broad glob. A real secret in any other file fails. Coverage lives in
 * `src/server/tests/unit/ci-scan-secrets.test.ts`; the mutation (teeth) proof is in the task report.
 *
 * Deterministic and network-free.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export interface SecretFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
}

interface SecretRule {
  readonly name: string;
  readonly description: string;
  readonly pattern: RegExp;
}

/**
 * Value-shape rules. Each matches a credential FORMAT (not a variable name), so a placeholder such
 * as `<supabase-service-role-key>` or an env var name on its own never trips them.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    name: 'jwt',
    description: 'three-segment JWT (Supabase anon/service-role legacy keys, access tokens)',
    // eyJ… header . payload . signature — all three segments present.
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  },
  {
    name: 'supabase-secret-key',
    description: 'Supabase secret API key (sb_secret_… — the new-format service-role secret)',
    pattern: /\bsb_secret_[A-Za-z0-9]{16,}/,
  },
  {
    name: 'private-key-block',
    description: 'PEM private-key block',
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/,
  },
  {
    name: 'postgres-inline-credential',
    description: 'postgres:// connection string with an inline (non-placeholder) password',
    // user:password@ — the password class excludes < > so `<local-db-password>` placeholders miss.
    pattern: /\bpostgres(?:ql)?:\/\/[^\s:/@'"<>]+:[^\s@'"<>]+@/,
  },
  {
    name: 'high-entropy-secret-assignment',
    description: 'a secret-named variable assigned a long high-entropy literal',
    pattern:
      /\b(?:SERVICE_ROLE_KEY|[A-Z0-9]*_SECRET|SECRET_[A-Z0-9]*|PASSWORD|PEPPER|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|API_KEY|serviceRoleKey|apiKeyPepper)['"]?\s*[:=]\s*['"`]([A-Za-z0-9+/=_-]{24,})['"`]/,
  },
];

/**
 * EXACT tracked paths permitted to carry secret-shaped strings, each justified:
 *  - the two `*.example` files hold placeholders only (independently guarded by
 *    `src/server/tests/integration/env-examples.test.ts`);
 *  - `log-fixture-secrets.ts` is the documented synthetic-secret fixture proving log scrubbing;
 *  - `ci-scan-probe-secrets.ts` holds the fake secrets these scanners' own tests plant;
 *  - the two CI scanner test files reference planted-secret literals to prove the scanners bite;
 *  - the test files in the second group below assign synthetic credentials to the very variables
 *    the patterns look for, because that IS what they test: config parsing rejects a malformed
 *    connection string, the pool splits pooled from direct, the logger scrubs a token it can see,
 *    API-key verification fails under a different pepper. None can use an opaque stand-in — a
 *    connection string must parse, a JWT must have three segments, a pepper must clear the
 *    16-character floor. Every value is visibly fake (`db.example.supabase.co`, `pooler-pass`,
 *    a JWT signed `s1gnatur3v4lue`) and none reaches a network.
 *
 * This is a specific-path list, never a glob such as `**` or `*fixture*`, so it cannot silently
 * widen into a hole. A real secret in any file NOT on this list fails the scan. Adding a path is
 * a deliberate act: prefer moving a fixture into `tests/fixtures/` over extending this list, and
 * never list a file that also contains production code.
 */
export const ALLOWLIST: readonly string[] = [
  '.env.example',
  '.env.local.example',
  'src/server/tests/fixtures/log-fixture-secrets.ts',
  'src/server/tests/fixtures/ci-scan-probe-secrets.ts',
  'src/server/tests/unit/ci-scan-secrets.test.ts',
  'src/server/tests/unit/ci-scan-bundle.test.ts',

  // Tests whose subject matter is credential handling (see the fourth bullet above).
  'src/server/tests/integration/api-access.test.ts',
  'src/server/tests/integration/http.skeleton.test.ts',
  'src/server/tests/integration/intake.test.ts',
  'src/server/tests/integration/job-endpoints.test.ts',
  'src/server/tests/types/db-tenant.type-test.ts',
  'src/server/tests/unit/api-keys.test.ts',
  'src/server/tests/unit/config.test.ts',
  'src/server/tests/unit/db-pool.test.ts',
  'src/server/tests/unit/db-tenant.test.ts',
  'src/server/tests/unit/logging.test.ts',
];

/** Extensions treated as binary and skipped (byte noise cannot be read as source text). */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.mp4',
  '.webm',
  '.mp3',
  '.wav',
  '.bin',
]);

export function isAllowlisted(relPath: string): boolean {
  return ALLOWLIST.includes(normalise(relPath));
}

function normalise(relPath: string): string {
  return relPath.split('\\').join('/');
}

function extensionOf(relPath: string): string {
  const base = normalise(relPath);
  const dot = base.lastIndexOf('.');
  const slash = base.lastIndexOf('/');
  return dot > slash ? base.slice(dot).toLowerCase() : '';
}

/**
 * Pure scan of a single file's content. Exposed so tests can exercise every rule against synthetic
 * inputs without shelling out to git, and so callers can reuse the exact matching logic.
 */
export function scanContent(relPath: string, content: string): SecretFinding[] {
  if (isAllowlisted(relPath)) return [];
  const findings: SecretFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    for (const rule of SECRET_RULES) {
      const match = new RegExp(rule.pattern.source, rule.pattern.flags).exec(line);
      if (match) {
        findings.push({
          file: normalise(relPath),
          line: i + 1,
          rule: rule.name,
          excerpt: redact(match[0]),
        });
      }
    }
  }
  return findings;
}

/** Never echo a full candidate secret into logs; keep enough to locate it. */
function redact(value: string): string {
  if (value.length <= 12) return `${value.slice(0, 3)}...`;
  return `${value.slice(0, 6)}...${value.slice(-3)} (${value.length} chars)`;
}

function listTrackedFiles(): string[] {
  const run = spawnSync('git ls-files -z', {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) {
    throw new Error(`git ls-files failed (exit ${String(run.status)}): ${run.stderr}`);
  }
  return run.stdout.split('\0').filter((name) => name.length > 0);
}

export function scanRepo(): { findings: SecretFinding[]; scanned: number; skipped: number } {
  const files = listTrackedFiles();
  const findings: SecretFinding[] = [];
  let scanned = 0;
  let skipped = 0;
  for (const relPath of files) {
    if (BINARY_EXTENSIONS.has(extensionOf(relPath))) {
      skipped += 1;
      continue;
    }
    let content: string;
    try {
      content = readFileSync(resolve(repoRoot, relPath), 'latin1');
    } catch {
      skipped += 1;
      continue;
    }
    // A NUL byte means the file is binary despite its extension — skip rather than emit noise.
    if (content.includes('\0')) {
      skipped += 1;
      continue;
    }
    scanned += 1;
    findings.push(...scanContent(relPath, content));
  }
  return { findings, scanned, skipped };
}

function main(): void {
  const { findings, scanned, skipped } = scanRepo();
  if (findings.length > 0) {
    console.error(`\n[scan-secrets] FAILED: ${findings.length} candidate secret(s) in tracked files:`);
    for (const f of findings) {
      console.error(`  - ${f.file}:${f.line} [${f.rule}] ${f.excerpt}`);
    }
    console.error(
      '\nA real credential must never be committed. If this is a deliberate fixture, add its EXACT ' +
        'path to ALLOWLIST in scripts/ci/scan-secrets.ts (never a broad glob).\n',
    );
    process.exit(1);
  }
  console.error(
    `[scan-secrets] OK: scanned ${scanned} tracked file(s) ` +
      `(${skipped} binary/unreadable skipped), 0 secrets.`,
  );
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
