import { DeadlineExceededError } from './errors.js';

interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
  deadline: number; // Timestamp (ms) at which the waiter gives up
  settled: boolean;
}

/**
 * Sends the latest requested value of one device control channel, one request at a time.
 *
 * Callers record what was requested in their own state, then call `write()`. The value to send is only
 * computed from that state when the request is actually sent, so:
 * - All the writes HomeKit sends in one request (e.g. On + Brightness) result in a single request with the right value,
 *   because the first send is deferred to the end of the current event loop turn.
 * - Requests never overlap, so they can't reach the device out of order. Writes that arrive while a request
 *   is in flight are coalesced into a single follow-up request with the latest value.
 *
 * Each write has a deadline. Once it passes, the write fails with a `DeadlineExceededError`, even if it's still queued
 * or its request is still in flight. A request is only cancelled once all the writes it carries have given up,
 * and a request whose writes have all given up while queued isn't sent at all.
 */
export class ChannelWriter<T> {
  private scheduled = false;
  private in_flight = false;
  private waiting: Waiter[] = [];

  /**
   * @param getValue Computes the value to send from the caller's latest requested state
   * @param send Sends a value to the device. It should stop when the signal aborts
   */
  constructor(
    private readonly getValue: () => T,
    private readonly send: (value: T, signal: AbortSignal) => Promise<void>,
  ) {}

  /**
   * Send the latest requested state
   * @param timeout_ms How long to wait for the request that carries this write's state
   * @returns A promise that settles with the outcome of that request, or rejects with a `DeadlineExceededError`
   */
  write(timeout_ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, deadline: Date.now() + timeout_ms, settled: false };
      const timer = setTimeout(() => this.settle(waiter, new DeadlineExceededError), timeout_ms);
      waiter.resolve = () => {
        clearTimeout(timer);
        resolve();
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      this.waiting.push(waiter);
      if (!this.in_flight && !this.scheduled) {
        // Not a delay: this runs as soon as the current event loop turn completes. HAP-NodeJS invokes the
        // handlers of all the characteristics in a HomeKit request within the same turn, so by then they've all run
        this.scheduled = true;
        setImmediate(() => this.flush());
      }
    });
  }

  /**
   * Settle a waiter, unless it already was (e.g. it gave up before its request completed)
   * @param error The error to reject it with, or `undefined` to resolve it
   */
  private settle(waiter: Waiter, error?: unknown) {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    if (error === undefined) {
      waiter.resolve();
    } else {
      waiter.reject(error);
    }
  }

  private async flush(just_sent?: { value: T }) {
    this.scheduled = false;
    // Writes that gave up while queued have already been answered
    const waiting = this.waiting.filter((waiter) => !waiter.settled);
    this.waiting = [];
    if (waiting.length === 0) {
      return;
    }
    const value = this.getValue();

    if (just_sent && just_sent.value === value) {
      // The request that just completed already carried this state
      waiting.forEach((waiter) => this.settle(waiter));
      return;
    }

    // Keep the request going for as long as any of its writes is still waiting for it
    const deadline = Math.max(...waiting.map((waiter) => waiter.deadline));
    const signal = AbortSignal.timeout(Math.max(deadline - Date.now(), 0));

    this.in_flight = true;
    let sent: { value: T } | undefined;
    try {
      await this.send(value, signal);
      sent = { value };
      waiting.forEach((waiter) => this.settle(waiter));
    } catch (error) {
      waiting.forEach((waiter) => this.settle(waiter, error));
    }
    this.in_flight = false;

    if (this.waiting.length > 0) {
      // Writes arrived while the request was in flight. Send the latest state
      void this.flush(sent);
    }
  }
}
