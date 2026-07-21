#!/usr/bin/env node
/**
 * Placeholder for a root package script whose target does not exist yet.
 * Always exits non-zero so CI wiring (T-010) cannot silently pass on a stub.
 */
const [scriptName = '<unknown>', owningTask = 'a later task'] = process.argv.slice(2);

process.stderr.write(
  `NOT IMPLEMENTED: "npm run ${scriptName}" is a scaffold stub created by T-001.\n` +
    `It is implemented by ${owningTask}. Failing with a non-zero exit code on purpose.\n`,
);

process.exit(1);
