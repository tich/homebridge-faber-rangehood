import { afterEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok, Result } from 'neverthrow';
import { mapRange, timeoutSignal, toRedactedJSON, untilAborted } from '../src/lib/utils.js';
import { DeadlineExceededError } from '../src/lib/errors.js';
import { advance, useFakeTime } from './helpers.js';

describe('mapRange', () => {
  test('maps linearly between ranges', () => {
    assert.equal(mapRange(1, 0, 2, 0, 100), 50);
    assert.equal(mapRange(4, 0, 4, 154, 370), 370);
    assert.equal(mapRange(154, 154, 370, 0, 4), 0);
  });
});

describe('toRedactedJSON', () => {
  test('redacts anything whose key looks like a token, at any depth', () => {
    const json = toRedactedJSON({ id_token: 'A', refresh_token: 'B', data: { hoods: { token: 'C', devices: [{ id: 'D' }] } } });
    assert.ok(!/"[ABC]"/.test(json));
    assert.match(json, /"id":"D"/);
    assert.equal((json.match(/<redacted>/g) ?? []).length, 3);
  });
});

describe('timeoutSignal', () => {
  afterEach(() => mock.timers.reset());

  test('aborts after the delay, on the same clock as the plugin\'s timers', async () => {
    useFakeTime();
    const signal = timeoutSignal(1000);
    await advance(990);
    assert.ok(!signal.aborted);
    await advance(10);
    assert.ok(signal.aborted);
    assert.ok(signal.reason instanceof DeadlineExceededError);
  });
});

describe('untilAborted', () => {
  test('passes the result through without a signal, or when it arrives first', async () => {
    assert.deepEqual(await untilAborted(Promise.resolve(ok(1))), ok(1));
    assert.deepEqual(await untilAborted(Promise.resolve(ok(1)), new AbortController().signal), ok(1));
  });

  test('stops waiting when the signal aborts, without cancelling the operation', async () => {
    const controller = new AbortController();
    let resolve!: (value: Result<number, Error>) => void;
    const operation = new Promise<Result<number, Error>>((r) => resolve = r);
    const waiting = untilAborted(operation, controller.signal);
    controller.abort();
    const result = await waiting;
    assert.ok(result.isErr() && result.error instanceof DeadlineExceededError);
    // The operation itself carries on, and can still complete for others
    resolve(ok(2));
    assert.deepEqual(await operation, ok(2));
  });

  test('gives up straight away on an already aborted signal', async () => {
    const result = await untilAborted(new Promise<Result<number, Error>>(() => {}), AbortSignal.abort());
    assert.ok(result.isErr() && result.error instanceof DeadlineExceededError);
  });

  test('passes errors through', async () => {
    const error = new Error('boom');
    assert.deepEqual(await untilAborted(Promise.resolve(err(error)), new AbortController().signal), err(error));
  });
});
