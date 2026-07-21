/**
 * Structural redaction for log payloads (spec §15, AC-011, V-014).
 *
 * Redaction is applied by the logger to every value it serializes, so callers never have to
 * remember to scrub anything. Two independent mechanisms are used:
 *
 * 1. Key deny-list — any property whose name looks like a credential or a piece of sensitive
 *    personal/attachment data is replaced wholesale, whatever its type.
 * 2. Value scrubbing — every surviving string is rewritten to strip credential-shaped
 *    substrings (bearer/basic credentials, JWTs, Supabase keys, URL-embedded passwords), which
 *    catches secrets that arrive under innocent key names or inside free-text messages.
 */

export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 8;

/** Key fragments that mark a property as sensitive (matched on the normalized key). */
const DENY_SUBSTRINGS: readonly string[] = [
  'authorization',
  'password',
  'passphrase',
  'passwd',
  'secret',
  'token',
  'credential',
  'cookie',
  'apikey',
  'anonkey',
  'servicerolekey',
  'privatekey',
  'signingkey',
  'pepper',
  'socialsecurity',
  'nationalid',
  'taxid',
  'dateofbirth',
  'cardnumber',
  'creditcard',
  'accountnumber',
  'attachmentcontent',
  'filecontent',
  'filedata',
  'filebytes',
  'rawbody',
  'base64',
];

/** Short key names that are only sensitive as an exact match. */
const DENY_EXACT: ReadonlySet<string> = new Set([
  'auth',
  'key',
  'keys',
  'pin',
  'otp',
  'dob',
  'salt',
  'hash',
  'sig',
  'signature',
  'pwd',
  'jwt',
  'cvv',
  'ssn',
  'iban',
]);

type Replacement = readonly [RegExp, (...args: string[]) => string];

/**
 * Credential-shaped value patterns. Each regex is recreated per call site via a fresh
 * `RegExp` in `scrubString` to avoid `lastIndex` state leaking between invocations.
 */
const VALUE_PATTERNS: readonly Replacement[] = [
  // `Bearer <credential>` / `Basic <credential>` / `Digest <credential>` in any string.
  [/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{4,}/gi, (_m, scheme: string) => `${scheme} ${REDACTED}`],
  // JSON Web Tokens and legacy Supabase anon/service keys.
  [/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g, () => REDACTED],
  // Current-generation Supabase API keys.
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{6,}/g, () => REDACTED],
  // Credentials embedded in any URL, e.g. DATABASE_URL. The host stays readable.
  [
    /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/g,
    (_m, prefix: string) => `${prefix}:${REDACTED}@`,
  ],
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a property name marks its value as sensitive. */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === '') return false;
  if (DENY_EXACT.has(normalized)) return true;
  return DENY_SUBSTRINGS.some((fragment) => normalized.includes(fragment));
}

/** Removes credential-shaped substrings from a string value. */
export function scrubString(value: string): string {
  let scrubbed = value;
  for (const [pattern, replacer] of VALUE_PATTERNS) {
    scrubbed = scrubbed.replace(
      new RegExp(pattern.source, pattern.flags),
      replacer as (substring: string, ...args: unknown[]) => string,
    );
  }
  return scrubbed;
}

function isPlainish(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function redactError(error: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: scrubString(error.name),
    message: scrubString(error.message),
  };

  if (typeof error.stack === 'string') {
    result.stack = scrubString(error.stack);
  }

  for (const [key, value] of Object.entries(error)) {
    if (key === 'name' || key === 'message' || key === 'stack') continue;
    result[isSensitiveKey(key) ? scrubString(key) : key] = isSensitiveKey(key)
      ? REDACTED
      : redactValue(value, depth + 1, seen);
  }

  const cause: unknown = (error as { cause?: unknown }).cause;
  if (cause !== undefined) {
    result.cause = redactValue(cause, depth + 1, seen);
  }

  return result;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return scrubString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return `${value.toString()}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return '[Function]';
    default:
      break;
  }

  const object = value as object;

  if (depth >= MAX_DEPTH) return '[MaxDepth]';
  if (seen.has(object)) return '[Circular]';
  seen.add(object);

  try {
    if (object instanceof Error) return redactError(object, depth, seen);
    if (object instanceof Date) return object.toISOString();
    if (object instanceof RegExp) return object.toString();
    if (ArrayBuffer.isView(object)) return `[Buffer ${(object as ArrayBufferView).byteLength} bytes]`;
    if (object instanceof ArrayBuffer) return `[Buffer ${object.byteLength} bytes]`;

    if (Array.isArray(object)) {
      return object.map((item) => redactValue(item, depth + 1, seen));
    }

    if (object instanceof Map) {
      return redactEntries([...object.entries()].map(([k, v]) => [String(k), v]), depth, seen);
    }

    if (object instanceof Set) {
      return [...object.values()].map((item) => redactValue(item, depth + 1, seen));
    }

    if (isPlainish(object)) {
      return redactEntries(Object.entries(object as Record<string, unknown>), depth, seen);
    }

    // Class instances and other exotic objects: serialize own enumerable properties only.
    return redactEntries(Object.entries(object as Record<string, unknown>), depth, seen);
  } finally {
    seen.delete(object);
  }
}

function redactEntries(
  entries: readonly (readonly [string, unknown])[],
  depth: number,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of entries) {
    // The key itself can carry a secret (e.g. a token used as a map key).
    const safeKey = scrubString(key);
    result[safeKey] = isSensitiveKey(key) ? REDACTED : redactValue(entryValue, depth + 1, seen);
  }
  return result;
}

/** Returns a JSON-safe copy of `value` with every sensitive element removed. */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}
