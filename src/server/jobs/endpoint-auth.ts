/**
 * Shared-secret authentication for the job endpoints (T-031, M-14, AC-062, spec §9.5/§16).
 *
 * ============================================================================================
 * /api/cron/* AND /api/queue/drain ARE PUBLIC INTERNET ENDPOINTS THAT MUTATE TENANT DATA.
 * ============================================================================================
 * They have to be: pg_cron reaches them over HTTPS via pg_net, from outside the deployment. There
 * is no VPC, no allow-list and no user session in front of them. The shared secret in the
 * Authorization header is the ONLY thing between an anonymous caller and "expire every quote in
 * every tenant". Treat this file accordingly.
 *
 * Two properties, both deliberate:
 *
 * 1. CONSTANT-TIME COMPARISON. `a === b` on strings returns as soon as two bytes differ, and that
 *    timing difference is measurable across a network given enough samples — it turns a 256-bit
 *    secret into a few hundred guesses per character. Both values are SHA-256'd to a fixed 32 bytes
 *    and compared with `timingSafeEqual`, which also sidesteps that function's requirement that its
 *    arguments be the same length (feeding it mismatched lengths throws, and the throw itself would
 *    leak the length of the real secret).
 *
 * 2. THE SECRET IS NEVER LOGGED, NOT EVEN AT DEBUG. The rejection log records a reason
 *    ('missing' | 'mismatch'), never the presented value: an attacker's near-miss guess sitting in
 *    a log drain is a credential in a place nobody is auditing. The 401 body is equally silent —
 *    it does not distinguish "no header" from "wrong secret", so probing tells the caller nothing.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { UnauthorizedError } from '../lib/errors/index.js';
import { problemResponse } from '../lib/errors/problem.js';
import { logger, resolveCorrelationId } from '../lib/logging/index.js';

/** Constant-time string equality. Safe for values of differing length. */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Pulls the credential out of an Authorization header, accepting `Bearer <secret>` (what pg_net
 * sends) and a bare `<secret>`. Returns null when there is nothing to check.
 */
export function extractPresentedSecret(headerValue: string | null | undefined): string | null {
  if (headerValue === null || headerValue === undefined) return null;
  const trimmed = headerValue.trim();
  if (trimmed === '') return null;

  // `Bearer` with nothing after it is an EMPTY credential, not a bare secret that happens to spell
  // "Bearer" — without this branch the literal string "Bearer" would be compared against the real
  // secret, which is a nonsense comparison masquerading as a check.
  const scheme = /^Bearer\b\s*(.*)$/iu.exec(trimmed);
  const value = (scheme === null ? trimmed : (scheme[1] ?? '')).trim();
  return value === '' ? null : value;
}

export type JobAuthOutcome =
  | { readonly authorized: true }
  | { readonly authorized: false; readonly reason: 'missing' | 'mismatch' };

/** Pure decision function, so the rule can be unit-tested without constructing a Response. */
export function checkJobSecret(
  headerValue: string | null | undefined,
  expected: string,
): JobAuthOutcome {
  const presented = extractPresentedSecret(headerValue);
  if (presented === null) return { authorized: false, reason: 'missing' };
  if (!secretsMatch(presented, expected)) return { authorized: false, reason: 'mismatch' };
  return { authorized: true };
}

/**
 * Authorizes a job request. Returns null when the caller may proceed, or the 401 response to
 * return otherwise — so a handler cannot forget to stop: `const denied = ...; if (denied) return denied;`
 */
export function authorizeJobRequest(
  request: Request,
  expected: string,
  endpoint: string,
): Response | null {
  const outcome = checkJobSecret(request.headers.get('authorization'), expected);
  if (outcome.authorized) return null;

  const correlationId = resolveCorrelationId(request.headers);
  logger.warn('rejected unauthenticated job endpoint request', {
    endpoint,
    reason: outcome.reason,
    correlationId,
  });

  // Identical body for both reasons: probing must not reveal whether a secret was even presented.
  return problemResponse(new UnauthorizedError('Unauthorized'), correlationId);
}
