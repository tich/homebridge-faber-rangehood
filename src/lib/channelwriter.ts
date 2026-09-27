interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
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
 */
export class ChannelWriter<T> {
  private scheduled = false;
  private in_flight = false;
  private waiting: Waiter[] = [];

  /**
   * @param getValue Computes the value to send from the caller's latest requested state
   * @param send Sends a value to the device
   */
  constructor(
    private readonly getValue: () => T,
    private readonly send: (value: T) => Promise<void>,
  ) {}

  /**
   * Send the latest requested state
   * @returns A promise that settles with the outcome of the request that carried this write's state
   */
  write(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      if (!this.in_flight && !this.scheduled) {
        // Not a delay: this runs as soon as the current event loop turn completes. HAP-NodeJS invokes the
        // handlers of all the characteristics in a HomeKit request within the same turn, so by then they've all run
        this.scheduled = true;
        setImmediate(() => this.flush());
      }
    });
  }

  private async flush(just_sent?: { value: T }) {
    this.scheduled = false;
    const waiting = this.waiting;
    this.waiting = [];
    const value = this.getValue();

    if (just_sent && just_sent.value === value) {
      // The request that just completed already carried this state
      waiting.forEach((waiter) => waiter.resolve());
      return;
    }

    this.in_flight = true;
    let sent: { value: T } | undefined;
    try {
      await this.send(value);
      sent = { value };
      waiting.forEach((waiter) => waiter.resolve());
    } catch (error) {
      waiting.forEach((waiter) => waiter.reject(error));
    }
    this.in_flight = false;

    if (this.waiting.length > 0) {
      // Writes arrived while the request was in flight. Send the latest state
      void this.flush(sent);
    }
  }
}
