import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ObjectStore } from '../src/lib/objectstore.js';
import { StorageError } from '../src/lib/errors.js';
import { advance, useFakeTime } from './helpers.js';

describe('ObjectStore', () => {
  let directory: string;
  beforeEach(() => directory = mkdtempSync(path.join(os.tmpdir(), 'faber-test-')));
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test('stores and reads back the token data', async () => {
    const store = new ObjectStore(path.join(directory, 'persist'));
    assert.ok((await store.init()).isOk());
    assert.equal((await store.getTokenData())._unsafeUnwrap(), undefined);
    const tokens = { hashed_auth_cfg: 'hash', id_token: 'ID', refresh_token: 'RT' };
    assert.ok((await store.setTokenData(tokens)).isOk());
    assert.deepEqual((await new ObjectStore(path.join(directory, 'persist')).init().andThen(() => store.getTokenData()))._unsafeUnwrap(), tokens);
  });

  test('reports a storage it can\'t use', async () => {
    const result = await new ObjectStore('/dev/null/persist').init();
    assert.ok(result.isErr() && result.error instanceof StorageError);
  });

  // node-persist scans for expired items every 2 minutes by default. Its errors (e.g. once the directory is gone) would be
  // unhandled promise rejections, which make Homebridge shut down
  test('doesn\'t scan the storage directory in the background', async () => {
    useFakeTime();
    try {
      const store = new ObjectStore(path.join(directory, 'persist'));
      assert.ok((await store.init()).isOk());
      const reads = mock.method(fs, 'readdir');
      await advance(5 * 60 * 1000, 1000);
      assert.equal(reads.mock.callCount(), 0);
    } finally {
      mock.restoreAll();
      mock.timers.reset();
    }
  });
});
