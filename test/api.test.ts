import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenIDSession } from '../src/api/openid.js';
import { Astarte, AstarteRequestMethod } from '../src/api/astarte.js';
import { ObjectStore } from '../src/lib/objectstore.js';
import {
  DeadlineExceededError,
  NetworkServiceError,
  RequestRejectedError,
  TokenExpiredError,
  UnknownResponseError,
} from '../src/lib/errors.js';
import { PluginConfig } from '../src/config.js';
import { createLog, TestLog } from './helpers.js';

interface Request {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type Reply = { status: number; body?: unknown } | 'hang';

/**
 * A fake Faber cloud: the OpenID token endpoint, the Astarte auth ("associator") service, and the Astarte API.
 * By default it behaves like the real one; tests override `reply` to change that.
 */
class FakeCloud {
  readonly requests: Request[] = [];
  private readonly server = http.createServer((req, res) => this.handle(req, res));
  // What the services consider valid
  refresh_token = 'RT1';
  id_token = 'ID1';
  astarte_token = 'AT1';
  next_token = 2;
  reply?: (request: Request) => Reply | undefined | Promise<Reply | undefined>;
  url = '';

  async start() {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  count(path_prefix: string) {
    return this.requests.filter((request) => request.path.startsWith(path_prefix)).length;
  }

  get base_urls() {
    return { auth: this.url, api: this.url, openid: `${this.url}/openid` };
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', async () => {
      const request = { method: req.method!, path: req.url!, headers: req.headers, body };
      this.requests.push(request);
      const reply = (await this.reply?.(request)) ?? this.default(request);
      if (reply === 'hang') {
        return;
      }
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body ?? {}));
    });
  }

  private default(request: Request): Reply {
    if (request.path.startsWith('/openid/token')) {
      if (new URLSearchParams(request.body).get('refresh_token') !== this.refresh_token) {
        return { status: 400, body: { error: 'invalid_grant' } };
      }
      // Rotate both tokens, like Azure B2C does
      this.id_token = `ID${this.next_token}`;
      this.refresh_token = `RT${this.next_token++}`;
      return { status: 200, body: { id_token: this.id_token, refresh_token: this.refresh_token } };
    }
    if (request.path.startsWith('/astarte-associator/')) {
      if (request.headers['sso-token'] !== this.id_token) {
        return { status: 403 };
      }
      if (request.path === '/astarte-associator/user_info/faber') {
        return { status: 200, body: { data: { user_id: 'user1' } } };
      }
      if (request.path === '/astarte-associator/tokens/faber/users/user1/devices') {
        return { status: 200, body: { data: { hoods: { devices: [{ id: 'PIN1' }], token: this.astarte_token } } } };
      }
    }
    if (request.path.startsWith('/appengine/v1/faber/devices/PIN1/interfaces/')) {
      if (request.headers.authorization !== `Bearer ${this.astarte_token}`) {
        return { status: 403 };
      }
      return { status: 200, body: { data: { ok: true } } };
    }
    return { status: 404 };
  }
}

/** None of the tokens may ever appear in the logs */
function assertNoTokensLogged(log: TestLog, cloud: FakeCloud) {
  for (const line of log.lines) {
    assert.ok(!/\b(RT|ID|AT)\d+\b/.test(line), `A token was logged: ${line}`);
  }
  assert.ok(cloud.requests.length > 0);
}

const cloud = new FakeCloud();
before(() => cloud.start());
after(() => cloud.stop());
beforeEach(() => {
  cloud.requests.length = 0;
  cloud.reply = undefined;
  cloud.refresh_token = 'RT1';
  cloud.id_token = 'ID1';
  cloud.astarte_token = 'AT1';
  cloud.next_token = 2;
});

describe('OpenIDSession', () => {
  let log: TestLog;
  let session: OpenIDSession;
  beforeEach(() => {
    log = createLog();
    session = new OpenIDSession(log.log, `${cloud.url}/openid`);
    session.setRefreshToken('RT1');
  });

  test('redeems the refresh token, and reports the rotated tokens', async () => {
    const changes: string[] = [];
    session.onTokenChanged((id_token, refresh_token) => changes.push(`${id_token}/${refresh_token}`));
    const result = await session.refreshToken();
    assert.ok(result.isOk());
    assert.equal(session.getIdToken(), 'ID2');
    assert.deepEqual(changes, ['ID2/RT2']);
    const request = cloud.requests[0];
    assert.match(request.path, /^\/openid\/token\?p=B2C_1A_signup_signin_localonly_Faber$/);
    assert.equal(request.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(new URLSearchParams(request.body).get('grant_type'), 'refresh_token');
    assertNoTokensLogged(log, cloud);
  });

  test('shares one refresh between concurrent callers', async () => {
    const results = await Promise.all([session.refreshToken(), session.refreshToken(), session.refreshToken()]);
    assert.ok(results.every((result) => result.isOk()));
    assert.equal(cloud.count('/openid/token'), 1);
    // A later refresh is a new one
    await session.refreshToken();
    assert.equal(cloud.count('/openid/token'), 2);
  });

  test('reports an expired refresh token, telling the user what to do', async () => {
    session.setRefreshToken('RT_OLD');
    const result = await session.refreshToken();
    assert.ok(result.isErr() && result.error instanceof TokenExpiredError);
    assert.match(log.at('error').join(), /Please get a new one, update the plugin config, and restart Homebridge/);
    // No request is made anymore, since there's no refresh token left to try
    const again = await session.refreshToken();
    assert.ok(again.isErr() && again.error instanceof TokenExpiredError);
    assert.equal(cloud.count('/openid/token'), 1);
    assertNoTokensLogged(log, cloud);
  });

  test('classifies other failures', async () => {
    cloud.reply = () => ({ status: 503 });
    let result = await session.refreshToken();
    assert.ok(result.isErr() && result.error.constructor === NetworkServiceError);

    cloud.reply = () => ({ status: 401 });
    result = await session.refreshToken();
    assert.ok(result.isErr() && result.error instanceof RequestRejectedError);

    cloud.reply = () => ({ status: 200, body: { id_token: 'ID9' } }); // No refresh token
    result = await session.refreshToken();
    assert.ok(result.isErr() && result.error instanceof UnknownResponseError);
    assertNoTokensLogged(log, cloud);
  });

  test('doesn\'t log the refresh token when the network fails', async () => {
    const offline = new OpenIDSession(log.log, 'http://127.0.0.1:9');
    offline.setRefreshToken('RT1');
    const result = await offline.refreshToken();
    assert.ok(result.isErr() && result.error.constructor === NetworkServiceError);
    assert.ok(!log.lines.some((line) => line.includes('RT1')));
  });
});

describe('Astarte', () => {
  let log: TestLog;
  let store_dir: string;
  let store: ObjectStore;
  const config = { auth_mode: 'token', refresh_token: 'RT1', devices: [], fallback_poll_interval: 300 } as PluginConfig;

  beforeEach(async () => {
    log = createLog();
    store_dir = mkdtempSync(path.join(os.tmpdir(), 'faber-test-'));
    store = new ObjectStore(store_dir);
    assert.ok((await store.init()).isOk());
  });
  afterEach(() => rmSync(store_dir, { recursive: true, force: true }));

  async function initAstarte() {
    const astarte = new Astarte(log.log, store, cloud.base_urls);
    const result = await astarte.init(config);
    assert.ok(result.isOk(), result.isErr() ? String(result.error) : '');
    return astarte;
  }

  test('logs in with the configured refresh token, and persists the rotated tokens', async () => {
    const astarte = await initAstarte();
    assert.deepEqual(astarte.getDevices(), ['PIN1']);
    await new Promise((resolve) => setTimeout(resolve, 20)); // Persisting happens in the background
    const tokens = (await store.getTokenData())._unsafeUnwrap();
    assert.equal(tokens?.refresh_token, 'RT2');
    assert.equal(tokens?.id_token, 'ID2');
    assertNoTokensLogged(log, cloud);
  });

  test('uses the persisted tokens after a restart, since the configured refresh token has been rotated', async () => {
    await initAstarte();
    await new Promise((resolve) => setTimeout(resolve, 20));
    cloud.requests.length = 0;
    await initAstarte(); // Same config, same store
    assert.equal(cloud.count('/openid/token'), 0);
  });

  test('forgets the persisted tokens when the configured refresh token changes', async () => {
    await initAstarte();
    await new Promise((resolve) => setTimeout(resolve, 20));
    cloud.refresh_token = 'RT_NEW';
    cloud.requests.length = 0;
    const astarte = new Astarte(log.log, store, cloud.base_urls);
    assert.ok((await astarte.init({ ...config, refresh_token: 'RT_NEW' })).isOk());
    assert.equal(new URLSearchParams(cloud.requests.find((r) => r.path.startsWith('/openid/token'))!.body).get('refresh_token'), 'RT_NEW');
  });

  test('refreshes an expired Astarte token and retries, sharing one refresh between concurrent requests', async () => {
    const astarte = await initAstarte();
    cloud.requests.length = 0;
    cloud.astarte_token = 'AT2'; // The current one expired
    const results = await Promise.all([1, 2, 3].map(() =>
      astarte.doRequest('PIN1', 'com.faberspa.connectedhood.HoodStatus', AstarteRequestMethod.GET, {})));
    assert.ok(results.every((result) => result.isOk()));
    assert.equal(cloud.count('/astarte-associator/tokens/'), 1);
  });

  test('classifies failed requests by their HTTP status', async () => {
    const astarte = await initAstarte();
    const request = () => astarte.doRequest('PIN1', 'com.faberspa.connectedhood.HoodStatus', AstarteRequestMethod.GET, {});

    cloud.reply = (r) => r.path.startsWith('/appengine/') ? { status: 404 } : undefined;
    let result = await request();
    assert.ok(result.isErr() && result.error instanceof RequestRejectedError && result.error.status === 404);

    cloud.reply = (r) => r.path.startsWith('/appengine/') ? { status: 503 } : undefined;
    result = await request();
    assert.ok(result.isErr() && result.error.constructor === NetworkServiceError);

    // Still forbidden after refreshing the token: the account doesn't have access to the device
    cloud.reply = (r) => r.path.startsWith('/appengine/') ? { status: 403 } : undefined;
    result = await request();
    assert.ok(result.isErr() && result.error instanceof RequestRejectedError && result.error.status === 403);
  });

  test('cancels a request whose deadline passed', async () => {
    const astarte = await initAstarte();
    cloud.reply = (r) => r.path.startsWith('/appengine/') ? 'hang' : undefined;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const result = await astarte.doRequest('PIN1', 'com.faberspa.connectedhood.Control/fan/speed', AstarteRequestMethod.POST, { data: 1 },
      controller.signal);
    assert.ok(result.isErr() && result.error instanceof DeadlineExceededError);
  });

  test('stops waiting for a slow token refresh at the deadline, but lets it complete for the next requests', async () => {
    const astarte = await initAstarte();
    cloud.astarte_token = 'AT2';
    let refreshes = 0;
    cloud.reply = async (r) => {
      if (r.path.startsWith('/astarte-associator/tokens/')) {
        refreshes++;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return undefined;
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const first = await astarte.doRequest('PIN1', 'com.faberspa.connectedhood.Control/fan/speed', AstarteRequestMethod.POST, { data: 1 },
      controller.signal);
    assert.ok(first.isErr() && first.error instanceof DeadlineExceededError);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await astarte.doRequest('PIN1', 'com.faberspa.connectedhood.Control/fan/speed', AstarteRequestMethod.POST, { data: 2 });
    assert.ok(second.isOk());
    assert.equal(refreshes, 1);
  });

  test('provides fresh credentials for the channels', async () => {
    const astarte = await initAstarte();
    cloud.astarte_token = 'AT5';
    const credentials = (await astarte.getChannelCredentials())._unsafeUnwrap();
    assert.deepEqual(credentials, { token: 'AT5', user_id: 'user1' });
  });

  test('never logs a token', async () => {
    const astarte = await initAstarte();
    cloud.reply = () => ({ status: 200, body: { unexpected: { token: 'AT9', refresh_token: 'RT9' } } });
    await astarte.getChannelCredentials();
    assertNoTokensLogged(log, cloud);
  });
});
