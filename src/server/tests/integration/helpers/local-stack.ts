/**
 * Discovery helper for the local Supabase stack (T-002).
 *
 * Integration tests must not hang or fail spuriously on a machine without Docker, and must
 * not quietly pass either. Everything here either returns a fully-resolved stack descriptor
 * or an explicit reason string that the calling suite turns into a visible skip.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Run the pinned CLI via its JS entrypoint and the current node binary: Node 22+ on Windows
// refuses to spawn `npx.cmd` without a shell (EINVAL).
const supabaseCli = createRequire(import.meta.url).resolve('supabase/dist/supabase.js');

export interface LocalStack {
  apiUrl: string;
  dbUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  jwksUrl: string;
}

export type StackProbe = { available: true; stack: LocalStack } | { available: false; reason: string };

/**
 * Builds the suite title so that a skipped run states WHY in the reporter output.
 *
 * A silently skipped integration suite is indistinguishable from a passing one, which is how
 * infrastructure regressions slip through CI. `console.warn` is swallowed by Vitest during
 * collection, so the reason is written straight to stderr and folded into the suite name.
 * CI (T-010) additionally asserts the stack is up, so skipping there is a hard failure.
 */
export function suiteTitle(name: string, probe: StackProbe): string {
  if (probe.available) return name;
  process.stderr.write(`\n[SKIPPED] ${name}: ${probe.reason}\n\n`);
  return `${name} [SKIPPED: ${probe.reason}]`;
}

const STATUS_TIMEOUT_MS = 60_000;

interface SupabaseStatusJson {
  API_URL?: string;
  DB_URL?: string;
  ANON_KEY?: string;
  SERVICE_ROLE_KEY?: string;
}

/**
 * Reads connection details from the running stack via `supabase status -o json`.
 *
 * `supabase status` exits non-zero when the stack is stopped and errors out when Docker is
 * unreachable, so a single call distinguishes "no stack" from "stack is up" without us
 * hard-coding ports that config.toml owns.
 */
export async function probeLocalStack(): Promise<StackProbe> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      process.execPath,
      [supabaseCli, 'status', '-o', 'json'],
      { timeout: STATUS_TIMEOUT_MS, encoding: 'utf8', windowsHide: true },
    );
    stdout = result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      reason:
        'Local Supabase stack is not reachable (`supabase status` failed). ' +
        'Start Docker Desktop and run `npm run supabase:start`. Underlying error: ' +
        message.split('\n')[0],
    };
  }

  // `supabase status` prints human-readable preamble lines before the JSON payload in some
  // CLI versions; take the JSON object only.
  const jsonStart = stdout.indexOf('{');
  if (jsonStart === -1) {
    return { available: false, reason: `Could not find JSON in \`supabase status\` output: ${stdout.slice(0, 200)}` };
  }

  let parsed: SupabaseStatusJson;
  try {
    parsed = JSON.parse(stdout.slice(jsonStart)) as SupabaseStatusJson;
  } catch {
    return { available: false, reason: `Could not parse \`supabase status\` JSON output: ${stdout.slice(0, 200)}` };
  }

  const { API_URL: apiUrl, DB_URL: dbUrl, ANON_KEY: anonKey, SERVICE_ROLE_KEY: serviceRoleKey } = parsed;
  if (!apiUrl || !dbUrl || !anonKey || !serviceRoleKey) {
    return {
      available: false,
      reason:
        'Local Supabase stack reported an incomplete status payload ' +
        `(API_URL/DB_URL/ANON_KEY/SERVICE_ROLE_KEY). Got keys: ${Object.keys(parsed).join(', ')}`,
    };
  }

  return {
    available: true,
    stack: {
      apiUrl,
      dbUrl,
      anonKey,
      serviceRoleKey,
      jwksUrl: `${apiUrl.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`,
    },
  };
}
