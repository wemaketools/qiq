/**
 * Structured JSON logging for Vercel runtime logs (spec §15, N-08, AC-011).
 *
 * One single-line JSON object per log call written to stdout, so Vercel's log drain and the
 * local dev server both get machine-parseable records. No logging dependency is used: the
 * surface is small and hand-rolled on purpose.
 *
 * Every value is passed through the shared redactor before serialization — callers cannot
 * accidentally log a credential.
 */
import { randomUUID } from 'node:crypto';

import { tryGetConfig, type LogLevel } from '../config/index.js';
import { redact } from './redact.js';

export { isSensitiveKey, redact, REDACTED, scrubString } from './redact.js';
export type { LogLevel } from '../config/index.js';

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogContext = Readonly<Record<string, unknown>>;

/** Destination for a rendered log line, including its trailing newline. */
export type LogSink = (line: string) => void;

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly level?: LogLevel;
  /** Environment stamp (N-08). Defaults to the configured APP_ENV. */
  readonly env?: string;
  readonly clock?: () => Date;
}

export interface Logger {
  readonly context: LogContext;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(context: LogContext): Logger;
}

const stdoutSink: LogSink = (line) => {
  process.stdout.write(line);
};

interface ResolvedOptions {
  readonly sink: LogSink;
  readonly level: LogLevel;
  readonly env: string;
  readonly clock: () => Date;
}

function resolveOptions(options: LoggerOptions): ResolvedOptions {
  const config = tryGetConfig();
  return {
    sink: options.sink ?? stdoutSink,
    level: options.level ?? config?.logLevel ?? 'info',
    // `unknown` rather than a guess: a broken environment must not masquerade as production.
    env: options.env ?? config?.appEnv ?? 'unknown',
    clock: options.clock ?? (() => new Date()),
  };
}

function stripUndefined(context: LogContext): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Creates a logger. `context` is merged into every record it and its children emit.
 * Options exist so tests (and T-009's request middleware) can inject a sink and a clock.
 */
export function createLogger(context: LogContext = {}, options: LoggerOptions = {}): Logger {
  const resolved = resolveOptions(options);
  const baseContext: LogContext = Object.freeze({ ...context });

  const emit = (level: LogLevel, message: string, callContext?: LogContext): void => {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[resolved.level]) return;

    const merged = stripUndefined({ ...baseContext, ...(callContext ?? {}) });
    const safeContext = redact(merged) as Record<string, unknown>;

    const record: Record<string, unknown> = {
      level,
      message: String(redact(message)),
      timestamp: resolved.clock().toISOString(),
      env: resolved.env,
      ...safeContext,
    };

    // JSON.stringify never emits a raw newline, so the record is guaranteed single-line.
    resolved.sink(`${JSON.stringify(record)}\n`);
  };

  return {
    context: baseContext,
    debug: (message, callContext) => emit('debug', message, callContext),
    info: (message, callContext) => emit('info', message, callContext),
    warn: (message, callContext) => emit('warn', message, callContext),
    error: (message, callContext) => emit('error', message, callContext),
    child: (childContext) => createLogger({ ...baseContext, ...childContext }, options),
  };
}

/** Root logger for call sites without request or job context. */
export const logger: Logger = createLogger();

export interface RequestLogContext {
  readonly correlationId: string;
  readonly userId?: string;
  readonly tenantId?: string;
  readonly route?: string;
}

/** Logger for an inbound API request (V-013 field set). */
export function requestLogger(context: RequestLogContext, options: LoggerOptions = {}): Logger {
  return createLogger({ ...context }, options);
}

export interface JobLogContext {
  readonly jobName: string;
  readonly correlationId: string;
  readonly trigger?: 'cron' | 'queue' | 'manual';
}

/** Logger for a cron or queue job run (V-013 field set). */
export function jobLogger(context: JobLogContext, options: LoggerOptions = {}): Logger {
  return createLogger({ ...context }, options);
}

/** Generates a fresh correlation id. */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Inbound correlation ids come from the network, so they are validated before being echoed
 * into logs: printable ASCII only, no whitespace, bounded length. Anything else is discarded
 * in favour of a fresh id, which prevents log-injection through the header.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export type HeaderSource =
  | { get(name: string): string | null }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(key: string): string | null }).get(name) ?? undefined;
  }

  const record = headers as Readonly<Record<string, string | readonly string[] | undefined>>;
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(value) ? value[0] : (value as string | undefined);
  }
  return undefined;
}

/** Propagates an inbound correlation id when it is safe, otherwise generates a new one. */
export function resolveCorrelationId(headers?: HeaderSource): string {
  if (headers !== undefined) {
    for (const header of [CORRELATION_ID_HEADER, REQUEST_ID_HEADER]) {
      const candidate = readHeader(headers, header);
      if (candidate !== undefined && SAFE_CORRELATION_ID.test(candidate)) {
        return candidate;
      }
    }
  }
  return newCorrelationId();
}
