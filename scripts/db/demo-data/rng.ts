/**
 * Deterministic RNG for the demo seed (T-041, N-06 "deterministic seed (fixed RNG seed)").
 *
 * The demo dataset must be REPRODUCIBLE: reset twice and the second run has to reproduce the same
 * logical state (AC-085/AC-086). A `Math.random()` anywhere in the generator would break that, so
 * every random choice below flows through one seeded `mulberry32` stream. The seed is fixed, so the
 * whole plan is a pure function of (seed, now).
 *
 * mulberry32 is a tiny, well-distributed 32-bit generator — good enough for demo distributions and,
 * unlike `Math.random`, portable and seedable. It is NOT cryptographic and must never be used for
 * anything security-bearing; demo passwords come from a fixed table, not from here.
 */
export class Rng {
  #state: number;

  constructor(seed: number) {
    // Force a non-zero uint32 state so a `0` seed still advances.
    this.#state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) | 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Integer in [minInclusive, maxInclusive]. */
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly picks one element; throws on an empty array so a bad table fails loudly. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty array');
    return items[this.int(0, items.length - 1)] as T;
  }

  /**
   * Picks one element by integer weight. Weights need not sum to anything in particular.
   * Throws when every weight is zero, which is always a generator bug rather than a data case.
   */
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    const total = entries.reduce((sum, [, weight]) => sum + Math.max(0, weight), 0);
    if (total <= 0) throw new Error('Rng.weighted called with no positive weight');
    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= Math.max(0, weight);
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]?.[0] as T;
  }
}
