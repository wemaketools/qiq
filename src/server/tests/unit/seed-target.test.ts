/**
 * Production-safety guard for the baseline seed (T-006, M-11: the seed is "never run
 * automatically in production").
 *
 * The whole point of the guard is that the DANGEROUS path is the one nobody exercises by
 * accident, so the decision is a pure function tested exhaustively here, and the integration
 * suite proves the CLI actually honours it.
 */
import { describe, expect, it } from 'vitest';

import { decideSeedTarget, nonLocalRefusalHint } from '../../../../scripts/db/seed-target.js';

const nonLocalEnvs = ['dev', 'preview', 'staging', 'production'] as const;

describe('decideSeedTarget', () => {
  it('allows a local target with no confirmation flag', () => {
    const decision = decideSeedTarget('local', null);

    expect(decision.allowed).toBe(true);
  });

  it('allows a local target when the confirmation flag matches', () => {
    expect(decideSeedTarget('local', 'local').allowed).toBe(true);
  });

  it.each(nonLocalEnvs)('refuses a %s target when no confirmation flag is given', (appEnv) => {
    const decision = decideSeedTarget(appEnv, null);

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toContain(appEnv);
    expect(decision.reason).toContain(`--env=${appEnv}`);
  });

  it.each(nonLocalEnvs)('allows a %s target when explicitly confirmed', (appEnv) => {
    expect(decideSeedTarget(appEnv, appEnv).allowed).toBe(true);
  });

  it('refuses when the confirmation names a different environment than the target', () => {
    const decision = decideSeedTarget('production', 'staging');

    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('unreachable');
    expect(decision.reason).toContain('staging');
    expect(decision.reason).toContain('production');
  });

  it('refuses a local-confirmation attempt against a production target', () => {
    // The realistic accident: a developer keeps `--env=local` in their shell history and later
    // runs it with deployed credentials loaded.
    expect(decideSeedTarget('production', 'local').allowed).toBe(false);
  });

  it('refuses when the confirmation flag is not a known environment name', () => {
    const decision = decideSeedTarget('staging', 'prod');

    expect(decision.allowed).toBe(false);
  });

  it('refuses a non-local target confirmed with an empty flag value', () => {
    expect(decideSeedTarget('production', '').allowed).toBe(false);
  });

  it('names the offending environment in the operator hint', () => {
    expect(nonLocalRefusalHint('production')).toContain('--env=production');
  });
});
