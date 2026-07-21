import { describe, expect, it } from 'vitest';

import {
  andThen,
  collect,
  err,
  isErr,
  isOk,
  mapErr,
  mapOk,
  ok,
  unwrapOr,
  type Result,
} from '../../lib/result.js';

describe('Result helpers (spec §14, M-04: no exceptions for expected business failures)', () => {
  it('ok() carries the value and narrows through isOk', () => {
    const result: Result<number, string> = ok(7);

    expect(result.ok).toBe(true);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    if (isOk(result)) {
      expect(result.value).toBe(7);
    }
  });

  it('err() carries the error and narrows through isErr', () => {
    const result: Result<number, string> = err('BROKER_NOT_FOUND');

    expect(result.ok).toBe(false);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBe('BROKER_NOT_FOUND');
    }
  });

  it('mapOk transforms the success value and leaves a failure untouched', () => {
    expect(mapOk(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });
    expect(mapOk(err<string>('E'), (n: number) => n * 3)).toEqual({ ok: false, error: 'E' });
  });

  it('mapOk does not invoke the mapper for a failure', () => {
    let called = 0;
    mapOk(err<string>('E'), (n: number) => {
      called += 1;
      return n;
    });

    expect(called).toBe(0);
  });

  it('mapErr transforms the failure and leaves a success untouched', () => {
    expect(mapErr(err('E'), (e) => `${e}!`)).toEqual({ ok: false, error: 'E!' });
    expect(mapErr(ok(1), (e: string) => `${e}!`)).toEqual({ ok: true, value: 1 });
  });

  it('andThen chains dependent operations and short-circuits on the first failure', () => {
    const double = (n: number): Result<number, string> => ok(n * 2);
    const fail = (): Result<number, string> => err('STOPPED');

    expect(andThen(ok(3), double)).toEqual({ ok: true, value: 6 });
    expect(andThen(andThen(ok(3), fail), double)).toEqual({ ok: false, error: 'STOPPED' });
  });

  it('andThen does not invoke the continuation after a failure', () => {
    let called = 0;
    andThen(err<string>('E'), (n: number) => {
      called += 1;
      return ok(n);
    });

    expect(called).toBe(0);
  });

  it('unwrapOr returns the value on success and the fallback on failure', () => {
    expect(unwrapOr(ok(5), 0)).toBe(5);
    expect(unwrapOr(err<string>('E'), 0)).toBe(0);
  });

  it('collect gathers all successes, or returns the first failure', () => {
    expect(collect([ok(1), ok(2), ok(3)])).toEqual({ ok: true, value: [1, 2, 3] });
    expect(collect([ok(1), err<string>('FIRST'), err<string>('SECOND')])).toEqual({
      ok: false,
      error: 'FIRST',
    });
  });

  it('produces plain serializable objects (Results cross the handler boundary)', () => {
    expect(JSON.parse(JSON.stringify(ok({ id: 1 })))).toEqual({ ok: true, value: { id: 1 } });
  });
});
