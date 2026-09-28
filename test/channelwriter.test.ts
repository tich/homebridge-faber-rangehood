import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelWriter } from '../src/lib/channelwriter.js';
import { DeadlineExceededError } from '../src/lib/errors.js';
import { advance, flush, useFakeTime } from './helpers.js';

interface Send {
  value: number;
  signal: AbortSignal;
  resolve(): void;
  reject(error: unknown): void;
}

/**
 * A writer whose sends are controlled by the test: each one waits until it's resolved or rejected
 */
function createWriter() {
  let state = 0;
  const sends: Send[] = [];
  const writer = new ChannelWriter(() => state, (value, signal) => new Promise<void>((resolve, reject) => {
    sends.push({ value, signal, resolve, reject });
  }));
  return { writer, sends, set: (value: number) => state = value };
}

/** How a write's promise settled so far */
function track(promise: Promise<void>) {
  const outcome: { settled?: 'resolved' | 'rejected'; error?: unknown } = {};
  promise.then(() => outcome.settled = 'resolved', (error) => {
    outcome.settled = 'rejected';
    outcome.error = error;
  });
  return outcome;
}

describe('ChannelWriter', () => {
  beforeEach(() => useFakeTime());
  afterEach(() => mock.timers.reset());

  test('sends all the writes of the same event loop turn as one request, with the latest state', async () => {
    const { writer, sends, set } = createWriter();
    set(1);
    const first = track(writer.write(8000));
    set(2);
    const second = track(writer.write(8000));
    await advance(10);
    assert.deepEqual(sends.map((send) => send.value), [2]);
    sends[0].resolve();
    await flush();
    assert.equal(first.settled, 'resolved');
    assert.equal(second.settled, 'resolved');
  });

  test('never overlaps requests, and coalesces the writes made meanwhile into one follow-up request', async () => {
    const { writer, sends, set } = createWriter();
    set(1);
    track(writer.write(8000));
    await advance(10);
    for (const value of [2, 3, 4]) {
      set(value);
      track(writer.write(8000));
      await advance(10);
    }
    assert.equal(sends.length, 1);
    sends[0].resolve();
    await flush();
    assert.deepEqual(sends.map((send) => send.value), [1, 4]);
  });

  test('skips the follow-up request when the one that just completed already carried the latest state', async () => {
    const { writer, sends, set } = createWriter();
    set(1);
    track(writer.write(8000));
    await advance(10);
    const second = track(writer.write(8000)); // Same state
    sends[0].resolve();
    await flush();
    assert.equal(sends.length, 1);
    assert.equal(second.settled, 'resolved');
  });

  test('passes a failed request\'s error to every write it carried', async () => {
    const { writer, sends } = createWriter();
    const first = track(writer.write(8000));
    const second = track(writer.write(8000));
    await advance(10);
    const error = new Error('boom');
    sends[0].reject(error);
    await flush();
    assert.equal(first.error, error);
    assert.equal(second.error, error);
  });

  test('gives up on a write at its deadline, and cancels its request', async () => {
    const { writer, sends } = createWriter();
    const write = track(writer.write(8000));
    await advance(7990);
    assert.equal(write.settled, undefined);
    assert.ok(!sends[0].signal.aborted);
    await advance(10);
    assert.ok(write.error instanceof DeadlineExceededError);
    assert.ok(sends[0].signal.aborted);
  });

  test('only cancels a request once all the writes it carries have given up', async () => {
    const { writer, sends } = createWriter();
    const first = track(writer.write(8000));
    await advance(1000);
    // The first write's request is in flight, so this one is queued for a follow-up request
    const second = track(writer.write(8000));
    await advance(7000);
    assert.ok(first.error instanceof DeadlineExceededError);
    assert.ok(sends[0].signal.aborted);
    // The follow-up request carries the second write, and lasts until its deadline
    sends[0].reject(new DeadlineExceededError);
    await flush();
    assert.equal(sends.length, 2);
    assert.ok(!sends[1].signal.aborted);
    await advance(1000);
    assert.ok(second.error instanceof DeadlineExceededError);
    assert.ok(sends[1].signal.aborted);
  });

  test('doesn\'t send a write that gave up while queued', async () => {
    const { writer, sends } = createWriter();
    track(writer.write(8000));
    await advance(10);
    const queued = track(writer.write(100));
    await advance(100);
    assert.ok(queued.error instanceof DeadlineExceededError);
    sends[0].resolve();
    await flush();
    assert.equal(sends.length, 1);
  });
});
