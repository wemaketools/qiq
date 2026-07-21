#!/usr/bin/env node
/**
 * `npm run dev` (T-018): runs the two local processes the app needs, together.
 *
 *   - the API function runner  (`npm run dev:api`  -> http://127.0.0.1:3001/api/v1)
 *   - the SPA dev server       (`npm run dev -w src/ui` -> http://localhost:5173)
 *
 * The SPA's Vite dev server proxies `/api/v1` and `/api/cron` to the runner (src/ui/vite.config.ts),
 * so the browser only ever talks to one origin and the SPA needs no absolute API base URL.
 *
 * Deliberately hand-rolled rather than pulling in a process-runner dependency: two `child_process`
 * spawns and a shared shutdown path is the whole requirement, and the approved dependency set does
 * not include one.
 *
 * The Supabase stack itself is not started here — it is a Docker stack with its own lifecycle
 * (`npm run supabase:start`), and restarting it on every `npm run dev` would be both slow and
 * surprising.
 */
import { spawn } from 'node:child_process';

const TASKS = [
  { name: 'api', args: ['run', 'dev:api'] },
  { name: 'ui', args: ['run', 'dev', '-w', 'src/ui'] },
];

/** `npm` is a shell script on POSIX and a .cmd shim on Windows, so both need `shell: true`. */
function start({ name, args }) {
  const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    stream.setEncoding('utf8');
    let buffered = '';
    stream.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        target.write(`${prefix}${line}\n`);
      }
    });
    stream.on('end', () => {
      if (buffered !== '') {
        target.write(`${prefix}${buffered}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  return child;
}

const children = TASKS.map(start);
let shuttingDown = false;

/** One process dying takes the other down: a half-running dev environment is worse than none. */
function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }
  process.exitCode = code;
}

for (const [index, child] of children.entries()) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(
        `[dev] ${TASKS[index].name} exited (${signal ?? code}); stopping the other process.\n`,
      );
    }
    shutdown(code ?? 1);
  });
  child.on('error', (error) => {
    process.stderr.write(`[dev] failed to start ${TASKS[index].name}: ${error.message}\n`);
    shutdown(1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
