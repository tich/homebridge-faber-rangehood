import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { err, ok, Result } from 'neverthrow';
import { AstarteChannel, ChannelEvent } from '../src/api/channel.js';
import { Astarte } from '../src/api/astarte.js';
import { NetworkServiceError, TokenExpiredError } from '../src/lib/errors.js';
import { createLog, TestLog } from './helpers.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until a condition holds, or fail */
async function until(condition: () => boolean, timeout_ms = 2000) {
  const start = Date.now();
  while (!condition()) {
    assert.ok(Date.now() - start < timeout_ms, 'Timed out waiting for a condition');
    await sleep(5);
  }
}

/**
 * A fake Astarte channels server, speaking the Phoenix protocol (version 2)
 */
class FakeChannelsServer {
  private readonly server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  readonly received: { topic: string; event: string; payload: Record<string, unknown> }[] = [];
  readonly tokens: string[] = [];
  socket?: WebSocket;
  // How to reply to each event: 'ok', 'error', or 'none' (don't reply)
  replies: Record<string, 'ok' | 'error' | 'none'> = {};

  constructor() {
    this.server.on('connection', (socket, request) => {
      this.socket = socket;
      this.tokens.push(new URL(request.url!, 'ws://localhost').searchParams.get('token')!);
      socket.on('message', (data) => {
        const [join_ref, ref, topic, event, payload] = JSON.parse(String(data));
        this.received.push({ topic, event, payload });
        const reply = this.replies[event] ?? 'ok';
        if (reply !== 'none') {
          socket.send(JSON.stringify([join_ref, ref, topic, 'phx_reply', { status: reply, response: {} }]));
        }
      });
    });
  }

  async listening() {
    if (this.server.address() === null) {
      await new Promise((resolve) => this.server.once('listening', resolve));
    }
  }

  get url() {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  count(event: string) {
    return this.received.filter((message) => message.event === event).length;
  }

  push(path: string, value: unknown, device_id = 'PIN1', timestamp = '2026-01-01T00:00:01.000Z') {
    this.socket!.send(JSON.stringify([null, null, 'rooms:faber:user1', 'new_event',
      { device_id, timestamp, event: { interface: 'com.faberspa.connectedhood.HoodStatus', path, type: 'incoming_data', value } }]));
  }

  async close() {
    for (const client of this.server.clients) {
      client.terminate();
    }
    await new Promise((resolve) => this.server.close(resolve));
  }
}

/** Credentials that change with every connection, like fresh Astarte tokens */
function fakeAstarte(credentials?: () => Result<{ token: string; user_id: string }, NetworkServiceError>) {
  let count = 0;
  return {
    getChannelCredentials: async () => credentials?.() ?? ok({ token: `AT${++count}`, user_id: 'user1' }),
  } as unknown as Astarte;
}

/** A listener that records what it's told */
function recorder() {
  const events: ChannelEvent[] = [];
  const active: boolean[] = [];
  return { events, active, onEvent: (event: ChannelEvent) => events.push(event), onActiveChange: (value: boolean) => active.push(value) };
}

describe('AstarteChannel', () => {
  let server: FakeChannelsServer;
  let log: TestLog;
  let channel: AstarteChannel | undefined;
  const options = () => ({ url: server.url, heartbeat_interval_ms: 100, reconnect_min_delay_ms: 50, reconnect_max_delay_ms: 200 });

  before(async () => {
    server = new FakeChannelsServer();
    await server.listening();
  });
  after(() => server.close());
  beforeEach(() => {
    log = createLog();
    server.received.length = 0;
    server.tokens.length = 0;
    server.replies = {};
  });
  afterEach(() => channel?.stop());

  test('joins the user\'s room, watches each device, and delivers its events', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    const listener = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', listener);
    channel.start();
    await until(() => listener.active.length === 1);
    assert.deepEqual(listener.active, [true]);
    assert.deepEqual(server.received[0], { topic: 'rooms:faber:user1', event: 'phx_join', payload: {} });
    const watch = server.received.find((message) => message.event === 'watch')!;
    assert.equal(watch.payload.device_id, 'PIN1');
    assert.deepEqual(watch.payload.simple_trigger, {
      type: 'data_trigger', on: 'incoming_data', interface_name: 'com.faberspa.connectedhood.HoodStatus',
      interface_major: 1, match_path: '/*', value_match_operator: '*',
    });

    server.push('/fan/speed', 2);
    server.push('/fan/speed', 3, 'OTHER_DEVICE'); // Not watched
    await until(() => listener.events.length === 1);
    await sleep(20);
    assert.deepEqual(listener.events, [{ path: '/fan/speed', value: 2, timestamp: Date.parse('2026-01-01T00:00:01.000Z') }]);
    assert.ok(log.at('info').some((line) => line.includes('Receiving push updates')));
  });

  test('installs the watch of a device added after connecting', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    channel.start();
    await until(() => server.count('phx_join') === 1);
    const listener = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', listener);
    await until(() => listener.active.length === 1);
  });

  test('reconnects with a fresh token after the connection drops, and watches again', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    const listener = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', listener);
    channel.start();
    await until(() => listener.active.length === 1);
    server.socket!.terminate();
    await until(() => listener.active.length === 3);
    assert.deepEqual(listener.active, [true, false, true]);
    assert.deepEqual(server.tokens, ['AT1', 'AT2']);
    assert.equal(server.count('watch'), 2);
    assert.ok(log.at('warn').some((line) => line.includes('Lost the push updates connection')));
  });

  test('reconnects when a heartbeat goes unanswered', async () => {
    server.replies.heartbeat = 'none';
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    channel.start();
    await until(() => server.tokens.length === 2, 1000);
  });

  test('reconnects when the server closes the room', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    channel.start();
    await until(() => server.count('phx_join') === 1);
    server.socket!.send(JSON.stringify([null, null, 'rooms:faber:user1', 'phx_error', {}]));
    await until(() => server.count('phx_join') === 2);
  });

  test('retries when joining fails, warning only once', async () => {
    server.replies.phx_join = 'error';
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    channel.start();
    await until(() => server.count('phx_join') >= 3);
    assert.equal(log.at('warn').filter((line) => line.includes('Failed to connect for push updates')).length, 1);
  });

  test('keeps other watches going when one fails', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    const failing = recorder();
    const working = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', failing);
    channel.start();
    await until(() => failing.active.length === 1);
    server.replies.watch = 'error';
    channel.watch('PIN2', 'com.faberspa.connectedhood.HoodStatus', working);
    await sleep(50);
    assert.deepEqual(working.active, []);
    assert.ok(log.at('warn').some((line) => line.includes('PIN2')));
  });

  test('stops for good when the credentials can\'t be fixed by retrying', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(() => err(new TokenExpiredError)), options());
    channel.start();
    await sleep(150);
    assert.equal(server.tokens.length, 0);
    assert.ok(log.at('error').some((line) => line.includes('Stopped receiving push updates')));
  });

  test('retries when the credentials fail transiently', async () => {
    let attempts = 0;
    channel = new AstarteChannel(log.log, fakeAstarte(() => ++attempts < 3 ? err(new NetworkServiceError) : ok({ token: 'AT', user_id: 'user1' })),
      options());
    channel.start();
    await until(() => server.tokens.length === 1);
    assert.equal(attempts, 3);
  });

  test('ignores malformed messages', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    const listener = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', listener);
    channel.start();
    await until(() => listener.active.length === 1);
    server.socket!.send('not json');
    server.socket!.send(JSON.stringify({ not: 'a frame' }));
    server.socket!.send(JSON.stringify([null, null, 'rooms:faber:user1', 'new_event', { unexpected: true }]));
    server.push('/fan/speed', 1);
    await until(() => listener.events.length === 1);
    assert.deepEqual(listener.active, [true]);
  });

  test('disconnects on stop, and doesn\'t reconnect', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    const listener = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', listener);
    channel.start();
    await until(() => listener.active.length === 1);
    const socket = server.socket!;
    channel.stop();
    await until(() => socket.readyState === WebSocket.CLOSED);
    await sleep(150);
    assert.equal(server.tokens.length, 1);
    assert.deepEqual(listener.active, [true, false]);
  });

  test('never logs the token', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), { ...options(), url: 'ws://127.0.0.1:9' });
    channel.start();
    await sleep(150);
    assert.ok(log.lines.length > 0);
    assert.ok(!log.lines.some((line) => /AT\d/.test(line)));
  });
});
