#!/usr/bin/env node
/**
 * Ensures the local Supabase Auth stack has an asymmetric JWT signing key (A-10).
 *
 * `supabase/config.toml` points [auth].signing_keys_path at supabase/signing_keys.json. When
 * that file exists, local GoTrue signs access tokens with ES256 and publishes the public key
 * at /auth/v1/.well-known/jwks.json, which is what lets the backend verify tokens offline via
 * auth.getClaims() (T-011). Without it the stack silently falls back to the legacy shared
 * HS256 secret and the production verification path would go untested locally.
 *
 * The key is generated per machine and git-ignored rather than committed: it is a private
 * signing key, and a committed one would be a real (if local-only) secret in the repository.
 * Regenerating it is free — delete the file and re-run `npm run supabase:start`.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const keysPath = resolve(repoRoot, 'supabase', 'signing_keys.json');

// Invoke the pinned CLI through its JS entrypoint with the current node binary. Node 22+ on
// Windows refuses to spawn `npx.cmd` without a shell (EINVAL), and shelling out would mean
// quoting rules differ per platform.
const supabaseCli = require.resolve('supabase/dist/supabase.js');

if (existsSync(keysPath)) {
  process.exit(0);
}

process.stderr.write(`Generating local-only ES256 JWT signing key at ${keysPath}\n`);

// CLI 2.109.1 quirk: because config.toml declares signing_keys_path, `gen signing-key` reads
// that file before writing and aborts with LegacyGenSigningKeyReadError if it is missing.
// Seed an empty key set first, then let `--append` write the generated key into it.
mkdirSync(dirname(keysPath), { recursive: true });
writeFileSync(keysPath, '[]', { encoding: 'utf8' });

// The exit code is NOT the success signal; the file on disk is.
//
// The CLI emits anonymous telemetry and exits non-zero when it cannot reach its analytics
// endpoint ("Timeout while shutting down PostHog"), even after the key has been written and
// logged. On a developer laptop that is invisible; on a CI runner with restricted egress it is
// routine, and treating it as failure deleted a perfectly good key — then broke `supabase stop`
// afterwards with "failed to read signing keys: no such file or directory".
//
// So capture any error, VALIDATE THE ARTEFACT, and only then decide. The validation below is the
// check that actually matters anyway: a truncated or empty key set makes `supabase start` fail
// later with a far less obvious error, or worse, silently fall back to HS256.
let execError;
try {
  execFileSync(process.execPath, [supabaseCli, 'gen', 'signing-key', '--algorithm', 'ES256', '--append'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
} catch (error) {
  execError = error;
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(keysPath, 'utf8'));
} catch {
  parsed = undefined;
}

const usable = Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.alg === 'ES256';

if (!usable) {
  rmSync(keysPath, { force: true });
  if (execError !== undefined) {
    process.stderr.write(
      `Failed to generate a JWT signing key: ${execError instanceof Error ? execError.message : execError}\n`,
    );
  } else {
    process.stderr.write('Generated signing key file is not a non-empty ES256 key set. Aborting.\n');
  }
  process.exit(1);
}

if (execError !== undefined) {
  // Worth one line in the log: the key is good, but the CLI is unhappy about something unrelated
  // and a future failure may well point back here.
  process.stderr.write(
    'Note: the Supabase CLI exited non-zero but wrote a valid ES256 key set; continuing.\n',
  );
}
