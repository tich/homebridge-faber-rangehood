import type { Logging } from 'homebridge';
import WebSocket from 'ws';
import zod from 'zod';
import { Result } from 'neverthrow';
import { Astarte } from './astarte.js';
import { ASTARTE_CHANNELS_URL, ASTARTE_REALM } from './constants.js';
import { isTransientError } from '../lib/errors.js';

export interface ChannelOptions {
  url: string;
  // Backoff for reconnecting after the connection failed or dropped
  reconnect_min_delay_ms: number;
  reconnect_max_delay_ms: number;
  // The server closes idle connections, so send a heartbeat regularly. A heartbeat that isn't answered by the time the next
  // one is due means the connection is dead (e.g. a network change), even if the socket hasn't noticed yet
  heartbeat_interval_ms: number;
}

const DEFAULT_OPTIONS: ChannelOptions = {
  url: ASTARTE_CHANNELS_URL,
  reconnect_min_delay_ms: 10 * 1000,
  reconnect_max_delay_ms: 5 * 60 * 1000,
  heartbeat_interval_ms: 25 * 1000,
};

/**
 * A change a device reported on one of its interfaces
 */
export interface ChannelEvent {
  path: string; // e.g. "/fan/speed"
  value: unknown;
  timestamp: number; // When the cloud received it (ms since epoch)
}

export interface ChannelListener {
  /** Called for every change the device reports on the watched interface */
  onEvent(event: ChannelEvent): void;
  /** Called when the watch becomes active (events will be delivered), or inactive (events may be missed) */
  onActiveChange(active: boolean): void;
}

interface Watch {
  device_id: string;
  interface_name: string;
  listener: ChannelListener;
  active: boolean;
}

// Phoenix (the channels' protocol, version 2) frames: [join_ref, ref, topic, event, payload]
const FrameFormat = zod.tuple([zod.string().nullable(), zod.string().nullable(), zod.string(), zod.string(), zod.unknown()]);

const ReplyFormat = zod.object({
  status: zod.string(),
  response: zod.unknown(),
});

const NewEventFormat = zod.object({
  device_id: zod.string(),
  timestamp: zod.string(),
  event: zod.object({
    interface: zod.string(),
    path: zod.string(),
    value: zod.unknown(),
  }),
});

/**
 * Receives the changes that devices report, as they happen, through Astarte's real-time channels.
 *
 * It joins the user's room, and installs a volatile trigger for each watched device and interface. Volatile triggers
 * only live as long as the connection, so they're installed again whenever it reconnects. The connection is kept
 * alive with heartbeats, and re-established with a fresh token (they expire after an hour) and an exponential backoff.
 * Listeners are told when their watch becomes inactive, since events may be missed until it's active again.
 */
export class AstarteChannel {
  private readonly watches = new Map<string, Watch>(); // By trigger name
  private socket?: WebSocket;
  private topic?: string;
  private joined = false;
  private next_ref = 0;
  private readonly pending_replies = new Map<string, (reply: zod.infer<typeof ReplyFormat>) => void>();
  private heartbeat_timer?: ReturnType<typeof setInterval>;
  private awaiting_heartbeat_ref?: string;
  private reconnect_timer?: ReturnType<typeof setTimeout>;
  private readonly options: ChannelOptions;
  private reconnect_delay_ms: number;
  private started = false;
  private failed_attempts = 0;

  constructor(
    private readonly log: Logging,
    private readonly astarte: Astarte,
    // Only meant to be overridden by tests
    options: Partial<ChannelOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.reconnect_delay_ms = this.options.reconnect_min_delay_ms;
  }

  /**
   * Watch the changes a device reports on an interface. Can be called before or after `start()`
   */
  watch(device_id: string, interface_name: string, listener: ChannelListener) {
    const watch: Watch = { device_id, interface_name, listener, active: false };
    this.watches.set(`homebridge_${interface_name}_${device_id}`, watch);
    if (this.joined) {
      this.installWatch(`homebridge_${interface_name}_${device_id}`, watch);
    }
  }

  start() {
    if (this.started) {
      return;
    }
    this.started = true;
    void this.connect();
  }

  stop() {
    this.started = false;
    clearTimeout(this.reconnect_timer);
    this.disconnect();
  }

  private async connect() {
    const credentials = await this.astarte.getChannelCredentials();
    if (!this.started) {
      return;
    }
    if (credentials.isErr()) {
      if (!isTransientError(credentials.error)) {
        // Retrying won't help (e.g. the refresh token expired), and the reason was logged already. Polling carries on
        this.log.error('Stopped receiving push updates. Restart Homebridge once the problem above is fixed');
        this.started = false;
        return;
      }
      this.onFailedAttempt();
      this.scheduleReconnect();
      return;
    }

    const { token, user_id } = credentials.value;
    this.topic = `rooms:${ASTARTE_REALM}:${user_id}`;
    const socket = new WebSocket(`${this.options.url}?vsn=2.0.0&realm=${ASTARTE_REALM}&token=${encodeURIComponent(token)}`);
    this.socket = socket;
    socket.on('open', () => {
      // Started before joining, so that a connection that never answers is detected too
      this.startHeartbeat();
      this.join();
    });
    socket.on('message', (data) => this.onFrame(String(data)));
    // An 'error' is always followed by a 'close', which handles reconnecting. Don't log the error itself: it can hold the URL,
    // which holds the token
    socket.on('error', () => this.log.debug('The push updates connection failed'));
    socket.on('close', () => {
      if (this.socket === socket) {
        this.onDisconnected();
      }
    });
  }

  private join() {
    this.send(this.topic!, 'phx_join', {}, (reply) => {
      if (reply.status !== 'ok') {
        this.log.warn('Failed to join the push updates room:', JSON.stringify(reply.response));
        this.socket?.terminate();
        return;
      }
      this.log.info('Receiving push updates');
      this.joined = true;
      this.reconnect_delay_ms = this.options.reconnect_min_delay_ms;
      this.failed_attempts = 0;
      for (const [name, watch] of this.watches) {
        this.installWatch(name, watch);
      }
    });
  }

  private installWatch(name: string, watch: Watch) {
    const simple_trigger = {
      type: 'data_trigger',
      on: 'incoming_data',
      interface_name: watch.interface_name,
      interface_major: 1,
      match_path: '/*',
      value_match_operator: '*',
    };
    this.send(this.topic!, 'watch', { name, device_id: watch.device_id, simple_trigger }, (reply) => {
      if (reply.status !== 'ok') {
        // The device keeps being polled frequently
        this.log.warn('Failed to receive push updates for device ID', watch.device_id + ':', JSON.stringify(reply.response));
        return;
      }
      this.setActive(watch, true);
    });
  }

  private setActive(watch: Watch, active: boolean) {
    if (watch.active !== active) {
      watch.active = active;
      watch.listener.onActiveChange(active);
    }
  }

  private startHeartbeat() {
    clearInterval(this.heartbeat_timer);
    this.awaiting_heartbeat_ref = undefined;
    this.heartbeat_timer = setInterval(() => {
      if (this.awaiting_heartbeat_ref !== undefined) {
        this.log.debug('The push updates connection stopped responding');
        this.socket?.terminate();
        return;
      }
      this.awaiting_heartbeat_ref = this.send('phoenix', 'heartbeat', {}, () => {
        this.awaiting_heartbeat_ref = undefined;
      });
    }, this.options.heartbeat_interval_ms);
  }

  /**
   * Send a message on the socket
   * @returns The message's reference
   */
  private send(topic: string, event: string, payload: unknown, onReply?: (reply: zod.infer<typeof ReplyFormat>) => void) {
    const ref = String(++this.next_ref);
    if (onReply) {
      this.pending_replies.set(ref, onReply);
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(['1', ref, topic, event, payload]));
    }
    return ref;
  }

  private onFrame(data: string) {
    const frame = Result.fromThrowable(() => JSON.parse(data), () => undefined)()
      .map((json) => FrameFormat.safeParse(json))
      .unwrapOr(undefined);
    if (!frame?.success) {
      this.log.debug('Ignoring an unexpected push updates message');
      return;
    }
    const [, ref, topic, event, payload] = frame.data;

    if (event === 'phx_reply' && ref !== null) {
      const reply = ReplyFormat.safeParse(payload);
      const onReply = this.pending_replies.get(ref);
      this.pending_replies.delete(ref);
      if (reply.success && onReply) {
        onReply(reply.data);
      }
    } else if (event === 'new_event') {
      this.onNewEvent(payload);
    } else if ((event === 'phx_error' || event === 'phx_close') && topic === this.topic) {
      // The server closed the room (e.g. the token expired). Reconnect, with a fresh token
      this.log.debug('The push updates room was closed:', event);
      this.socket?.terminate();
    }
  }

  private onNewEvent(payload: unknown) {
    const parsed = NewEventFormat.safeParse(payload);
    if (!parsed.success) {
      this.log.debug('Ignoring an unexpected push update:', JSON.stringify(payload));
      return;
    }
    const { device_id, timestamp, event } = parsed.data;
    const watch = this.watches.get(`homebridge_${event.interface}_${device_id}`);
    const time = Date.parse(timestamp);
    if (watch && !Number.isNaN(time)) {
      watch.listener.onEvent({ path: event.path, value: event.value, timestamp: time });
    }
  }

  private disconnect() {
    clearInterval(this.heartbeat_timer);
    this.pending_replies.clear();
    this.joined = false;
    const socket = this.socket;
    this.socket = undefined;
    socket?.removeAllListeners();
    socket?.on('error', () => {}); // Closing a socket that's still connecting emits an error
    socket?.terminate();
    for (const watch of this.watches.values()) {
      this.setActive(watch, false);
    }
  }

  private onDisconnected() {
    const was_joined = this.joined;
    this.disconnect();
    if (!this.started) {
      return;
    }
    if (was_joined) {
      this.log.warn('Lost the push updates connection. Reconnecting, and polling more often in the meantime');
    } else {
      this.onFailedAttempt();
    }
    this.scheduleReconnect();
  }

  /**
   * Note an attempt to connect that failed, warning about the first one only, rather than on every retry
   */
  private onFailedAttempt() {
    this.failed_attempts++;
    if (this.failed_attempts === 1) {
      this.log.warn('Failed to connect for push updates. Retrying, and polling more often in the meantime');
    }
  }

  private scheduleReconnect() {
    clearTimeout(this.reconnect_timer);
    this.reconnect_timer = setTimeout(() => void this.connect(), this.reconnect_delay_ms);
    this.reconnect_delay_ms = Math.min(this.reconnect_delay_ms * 2, this.options.reconnect_max_delay_ms);
  }
}
