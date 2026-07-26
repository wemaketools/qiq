import { describe, expect, it } from 'vitest';

import {
  LOCAL_DEMO_PASSWORD,
  resolveDemoPassword,
} from '../../../../scripts/db/demo-data/catalog.js';

/**
 * The demo seed re-asserts every persona's password on EVERY run, so that a rotated local
 * credential heals. That is correct on a laptop and wrong anywhere reachable: it means a hosted
 * environment silently gets the repository's committed password back each time anyone re-seeds it,
 * undoing whatever an operator changed in the meantime.
 *
 * `resolveDemoPassword` is the branch that decides, kept pure so the dangerous case can be covered
 * exhaustively without a stack, a database or an Auth server.
 */

const NON_LOCAL = ['dev', 'preview', 'staging', 'production'] as const;

describe('resolveDemoPassword', () => {
  it('falls back to the committed password locally, which is what the e2e suite signs in with', () => {
    const decision = resolveDemoPassword('local', null);

    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.password).toBe(LOCAL_DEMO_PASSWORD);
    expect(decision.source).toBe('local-default');
  });

  it.each(NON_LOCAL)('REFUSES a %s target rather than falling back to the committed password', (appEnv) => {
    const decision = resolveDemoPassword(appEnv, null);

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error('unreachable');
    expect(decision.reason).toContain('DEMO_SEED_PASSWORD');
    // The refusal must say WHY, not merely that something is missing: the re-assertion behaviour is
    // the part an operator cannot guess from a "variable not set" message.
    expect(decision.reason).toMatch(/every run|re-assert|re-publish/i);
  });

  it.each(NON_LOCAL)('accepts a configured password for %s', (appEnv) => {
    const decision = resolveDemoPassword(appEnv, 'a-configured-demo-password');

    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.password).toBe('a-configured-demo-password');
    expect(decision.source).toBe('configured');
  });

  it('prefers the configured password over the committed one even locally', () => {
    const decision = resolveDemoPassword('local', 'a-configured-demo-password');

    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.password).toBe('a-configured-demo-password');
    expect(decision.source).toBe('configured');
  });

  it.each(['', '   ', '\t\n'])('treats blank input (%j) as unset rather than as a password', (blank) => {
    // An empty variable is a likelier mistake than a deliberate choice, and accepting it would seed
    // personas with a password nobody can sign in with — after the guard had already passed.
    expect(resolveDemoPassword('dev', blank).ok).toBe(false);
    expect(resolveDemoPassword('local', blank)).toMatchObject({ source: 'local-default' });
  });

  it('trims surrounding whitespace, which a copy-paste into a secret store commonly carries', () => {
    const decision = resolveDemoPassword('dev', '  spaced-password  ');

    expect(decision.ok).toBe(true);
    if (!decision.ok) throw new Error('unreachable');
    expect(decision.password).toBe('spaced-password');
  });

  it('keeps the committed default usable by the Auth Admin API (6-char Supabase minimum)', () => {
    expect(LOCAL_DEMO_PASSWORD.length).toBeGreaterThanOrEqual(6);
  });
});
