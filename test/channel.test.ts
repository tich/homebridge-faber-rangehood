import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net, { AddressInfo } from 'node:net';
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
  // How to reply to each event: 'ok', 'error', 'already existing' (an error, as for a watch whose name is taken), or 'none' (don't reply)
  replies: Record<string, 'ok' | 'error' | 'already existing' | 'none'> = {};

  constructor() {
    this.server.on('connection', (socket, request) => {
      this.socket = socket;
      this.tokens.push(new URL(request.url!, 'ws://localhost').searchParams.get('token')!);
      socket.on('message', (data) => {
        const [join_ref, ref, topic, event, payload] = JSON.parse(String(data));
        this.received.push({ topic, event, payload });
        const reply = this.replies[event] ?? 'ok';
        if (reply === 'already existing') {
          socket.send(JSON.stringify([join_ref, ref, topic, 'phx_reply', { status: 'error', response: { reason: 'already existing' } }]));
        } else if (reply !== 'none') {
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
  // Short, to keep the tests quick. The heartbeat interval is long enough that a busy machine answering a heartbeat late
  // doesn't cause reconnects of its own, except where a test shortens it
  const options = () => ({ url: server.url, heartbeat_interval_ms: 1000, reconnect_min_delay_ms: 50, reconnect_max_delay_ms: 200 });

  // A server per test, so that a connection a previous test left behind can't interfere
  beforeEach(async () => {
    log = createLog();
    server = new FakeChannelsServer();
    await server.listening();
  });
  afterEach(async () => {
    channel?.stop();
    channel = undefined;
    await server.close();
  });

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
    await until(() => listener.active.length >= 3);
    assert.deepEqual(listener.active.slice(0, 3), [true, false, true]);
    assert.deepEqual(server.tokens.slice(0, 2), ['AT1', 'AT2']);
    assert.ok(server.count('watch') >= 2);
    assert.ok(log.at('warn').some((line) => line.includes('Lost the push updates connection')));
  });

  test('reconnects when a heartbeat goes unanswered', async () => {
    server.replies.heartbeat = 'none';
    channel = new AstarteChannel(log.log, fakeAstarte(), { ...options(), heartbeat_interval_ms: 100 });
    channel.start();
    await until(() => server.tokens.length >= 2, 1000);
  });

  test('stays connected while heartbeats are answered', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), { ...options(), heartbeat_interval_ms: 100 });
    channel.start();
    await until(() => server.count('heartbeat') >= 4, 1000);
    assert.equal(server.tokens.length, 1);
  });

  test('reconnects when the server closes the room', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    channel.start();
    await until(() => server.count('phx_join') === 1);
    server.socket!.send(JSON.stringify([null, null, 'rooms:faber:user1', 'phx_error', {}]));
    await until(() => server.count('phx_join') >= 2);
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
    const working = recorder();
    const failing = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', working);
    channel.start();
    await until(() => working.active.length === 1);
    server.replies.watch = 'error';
    channel.watch('PIN2', 'com.faberspa.connectedhood.HoodStatus', failing);
    await sleep(50);
    assert.deepEqual(failing.active, []);
    assert.deepEqual(working.active, [true]);
    assert.ok(log.at('warn').some((line) => line.includes('PIN2')));
  });

  // The user's room is shared by all their clients, and so are its watches: e.g. another instance of the plugin already
  // installed it, or this one did before reconnecting, and the server hasn't noticed the old connection is gone yet
  test('uses a watch that already exists in the room', async () => {
    server.replies.watch = 'already existing';
    channel = new AstarteChannel(log.log, fakeAstarte(), options());
    const listener = recorder();
    channel.watch('PIN1', 'com.faberspa.connectedhood.HoodStatus', listener);
    channel.start();
    await until(() => listener.active.length === 1);
    assert.deepEqual(listener.active, [true]);
    assert.deepEqual(log.at('warn'), []);
    server.push('/fan/speed', 2);
    await until(() => listener.events.length === 1);
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

  test('stops cleanly while still connecting', async () => {
    // Accepts connections, but never answers the WebSocket handshake
    const connections: net.Socket[] = [];
    const silent = net.createServer((connection) => connections.push(connection));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    try {
      channel = new AstarteChannel(log.log, fakeAstarte(),
        { ...options(), url: `ws://127.0.0.1:${(silent.address() as AddressInfo).port}` });
      channel.start();
      await until(() => connections.length === 1);
      // Closing a socket that's still connecting emits an error, which would crash Homebridge if nothing handled it
      channel.stop();
      await sleep(100);
      assert.equal(connections.length, 1);
    } finally {
      connections.forEach((connection) => connection.destroy());
      await new Promise((resolve) => silent.close(resolve));
    }
  });

  test('never logs the token', async () => {
    channel = new AstarteChannel(log.log, fakeAstarte(), { ...options(), url: 'ws://127.0.0.1:9' });
    channel.start();
    await sleep(150);
    assert.ok(log.lines.length > 0);
    assert.ok(!log.lines.some((line) => /AT\d/.test(line)));
  });
});
