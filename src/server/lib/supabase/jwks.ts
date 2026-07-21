/**
 * Cached JWKS for offline access-token verification (T-011, AC-016, V-020, A-10).
 *
 * WHY THIS EXISTS AT ALL — `auth.getClaims()` already has an internal JWKS cache, but it falls
 * back to a network `getUser()` round-trip whenever it cannot resolve the token's `kid` locally
 * (GoTrueClient.fetchJwk returns null -> getClaims calls getUser). That fallback would make the
 * verification result depend on the Auth server being reachable and on an attacker-supplied
 * header. By owning the key set here and passing it into `getClaims({ jwks })`, key resolution
 * always succeeds locally or the token is rejected before any crypto runs — there is no network
 * path left in the verification of a well-formed token.
 *
 * Caching model (serverless): keys live in module scope for the life of the instance, so the cost
 * is one fetch per cold start, not one per request. A cold instance that has never fetched will
 * fetch once; that is unavoidable and is the "cold-start-tolerant" behaviour the task asks for.
 *
 * Unknown-kid handling: a `kid` we have never seen triggers at most one refresh per
 * `minRefreshIntervalMs`. Without that floor, a flood of tokens carrying random kids would turn
 * into a fetch amplifier against the Auth service.
 */
import type { JWK } from '@supabase/supabase-js';

export interface JwksCacheOptions {
  readonly supabaseUrl: string;
  /** How long a successfully fetched key set is trusted without re-fetching. */
  readonly ttlMs?: number;
  /** Floor between refreshes triggered by an unrecognised `kid`. */
  readonly minRefreshIntervalMs?: number;
  /** Injected by tests to count outbound requests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
}

/** 10 minutes, matching GoTrue's own JWKS TTL. */
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export interface JwksDocument {
  readonly keys: JWK[];
}

/**
 * The only thing the verifier needs from a key set. Declared as an interface so a test can supply
 * a locally generated key pair (wrong-issuer / foreign-key cases) without a network endpoint.
 */
export interface JwksKeySource {
  findKey(kid: string): Promise<JWK | null>;
}

export class JwksFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JwksFetchError';
  }
}

export class JwksCache implements JwksKeySource {
  readonly #url: string;
  readonly #ttlMs: number;
  readonly #minRefreshIntervalMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  #keys: JWK[] = [];
  #fetchedAt = Number.NEGATIVE_INFINITY;
  #lastAttemptAt = Number.NEGATIVE_INFINITY;
  #fetchCount = 0;
  /** De-duplicates concurrent refreshes so a burst of cold requests makes one request. */
  #inFlight: Promise<void> | null = null;

  constructor(options: JwksCacheOptions) {
    this.#url = `${options.supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#minRefreshIntervalMs = options.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.clock ?? Date.now;
  }

  /** Number of outbound JWKS requests made. The evidence behind the "no per-request call" claim. */
  get fetchCount(): number {
    return this.#fetchCount;
  }

  get url(): string {
    return this.#url;
  }

  #isFresh(): boolean {
    return this.#keys.length > 0 && this.#now() < this.#fetchedAt + this.#ttlMs;
  }

  async #refresh(): Promise<void> {
    this.#inFlight ??= this.#doRefresh().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #doRefresh(): Promise<void> {
    this.#lastAttemptAt = this.#now();
    this.#fetchCount += 1;

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      throw new JwksFetchError(`Could not reach the JWKS endpoint at ${this.#url}.`, {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new JwksFetchError(
        `JWKS endpoint at ${this.#url} responded with HTTP ${response.status}.`,
      );
    }

    const document = (await response.json()) as Partial<JwksDocument>;
    if (!Array.isArray(document.keys) || document.keys.length === 0) {
      throw new JwksFetchError(
        `JWKS endpoint at ${this.#url} returned no keys. Supabase asymmetric signing keys ` +
          'appear to be disabled, which would force symmetric (HS256) tokens this API refuses.',
      );
    }

    this.#keys = document.keys;
    this.#fetchedAt = this.#now();
  }

  /** Returns the cached key set, fetching once if it is empty or stale. */
  async getDocument(): Promise<JwksDocument> {
    if (!this.#isFresh()) {
      await this.#refresh();
    }
    return { keys: this.#keys };
  }

  /**
   * Resolves a `kid` locally, refreshing at most once per cooldown when it is unknown (key
   * rotation). Returns null when the key is genuinely not ours — the caller rejects the token
   * WITHOUT falling back to any network verification.
   */
  async findKey(kid: string): Promise<JWK | null> {
    const document = await this.getDocument();
    const found = document.keys.find((key) => key.kid === kid);
    if (found !== undefined) return found;

    if (this.#now() < this.#lastAttemptAt + this.#minRefreshIntervalMs) {
      return null;
    }

    await this.#refresh();
    return this.#keys.find((key) => key.kid === kid) ?? null;
  }
}

const cacheByUrl = new Map<string, JwksCache>();

/** Process-wide cache keyed by Supabase URL, so warm invocations share the fetched key set. */
export function getJwksCache(supabaseUrl: string): JwksCache {
  const existing = cacheByUrl.get(supabaseUrl);
  if (existing !== undefined) return existing;

  const created = new JwksCache({ supabaseUrl });
  cacheByUrl.set(supabaseUrl, created);
  return created;
}

/** Test-only. */
export function resetJwksCaches(): void {
  cacheByUrl.clear();
}
