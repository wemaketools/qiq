/**
 * Exact money arithmetic for the dashboard metrics (T-035; A-12; the T-008 money-pin obligation
 * recorded on this task).
 *
 * WHY THIS FILE EXISTS AT ALL
 * ===========================
 * Every money column in this schema is `numeric(18,2)`, and node-postgres hands `numeric` back as a
 * STRING on purpose so the value never passes through a double. The T-008 pins guarantee that
 * typing all the way through the Kysely schema, but they cannot see a `Number(...)` written in
 * consumer code — which is precisely where this task sits. `0.10 + 0.20 !== 0.30` in IEEE-754, and
 * a dashboard is nothing but sums and comparisons of money, so summing premium as doubles produces
 * a Won Premium figure that is wrong in the last cents and is nonetheless believed.
 *
 * So money stays a decimal STRING at every boundary, and arithmetic happens on `bigint` minor
 * units (cents). Scale is fixed at 2 because the schema fixes it at 2; an input with more precision
 * is a bug in the caller, not something to silently round, so it throws.
 *
 * WHAT THIS IS NOT: a general decimal library. It does exactly what dashboard aggregation needs —
 * add, sum, compare, negate — and deliberately has no multiply/divide, because dividing money by
 * money yields a RATE, not money, and rates are `number` (see `metrics/index.ts`). Adding division
 * here would invite someone to compute a rate in cents and lose the fraction.
 */

/** A decimal amount as it arrives from `numeric(18,2)`: an optionally-signed 2dp decimal string. */
export type Money = string;

/** `numeric(18,2)` after a `select`: always signed-optional digits with exactly two decimals. */
const MONEY_PATTERN = /^-?\d+(\.\d{1,2})?$/;

export const ZERO_MONEY: Money = '0.00';

/**
 * Parses an amount into `bigint` cents.
 *
 * THROWS rather than coercing. A silent `Number(NaN) -> 0` here would turn an unparseable premium
 * into a free lead in every total, which is the single most expensive way this module could fail.
 */
export function parseMoney(value: Money): bigint {
  const trimmed = value.trim();
  if (!MONEY_PATTERN.test(trimmed)) {
    throw new TypeError(
      `Expected a numeric(18,2) decimal string, received ${JSON.stringify(value)}. ` +
        'Money must never be widened to a JavaScript number before reaching this module.',
    );
  }

  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = trimmed.replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -cents : cents;
}

/** Renders `bigint` cents back as a 2dp decimal string, sign and leading zero included. */
export function formatMoney(cents: bigint): Money {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = absolute % 100n;
  return `${negative ? '-' : ''}${String(whole)}.${String(fraction).padStart(2, '0')}`;
}

export function addMoney(left: Money, right: Money): Money {
  return formatMoney(parseMoney(left) + parseMoney(right));
}

export function subtractMoney(left: Money, right: Money): Money {
  return formatMoney(parseMoney(left) - parseMoney(right));
}

/** Exact total. Folding over `bigint` means a thousand one-cent rows total exactly ten dollars. */
export function sumMoney(values: readonly Money[]): Money {
  return formatMoney(values.reduce<bigint>((total, value) => total + parseMoney(value), 0n));
}

/** Negative / zero / positive, by VALUE — string comparison would order '9.00' above '10.00'. */
export function compareMoney(left: Money, right: Money): number {
  const a = parseMoney(left);
  const b = parseMoney(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isZeroMoney(value: Money): boolean {
  return parseMoney(value) === 0n;
}
