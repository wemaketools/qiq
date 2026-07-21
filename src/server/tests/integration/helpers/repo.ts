import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

export interface CommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
}

function toResult(run: SpawnSyncReturns<string>): CommandResult {
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  return { status: run.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

export function runNpmScript(script: string, timeoutMs = 120_000): CommandResult {
  // A single command string (rather than an args array) keeps `shell: true` free of the
  // Node DEP0190 argument-escaping warning. `script` always comes from package.json.
  return toResult(
    spawnSync(`npm run ${script}`, {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: true,
      timeout: timeoutMs,
    }),
  );
}

export function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readFileSync(resolve(repoRoot, relativePath), 'utf8')) as T;
}
