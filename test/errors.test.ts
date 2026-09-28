import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';
import {
  DeadlineExceededError,
  errorForHttpStatus,
  InvalidConfigError,
  isTransientError,
  NetworkServiceError,
  RequestRejectedError,
  StorageError,
  TokenExpiredError,
  UnknownResponseError,
} from '../src/lib/errors.js';

describe('errorForHttpStatus', () => {
  for (const status of [undefined, 500, 502, 503, 408, 429]) {
    test(`treats ${status ?? 'no response'} as transient`, () => {
      const error = errorForHttpStatus(status);
      assert.equal(error.constructor, NetworkServiceError);
      assert.ok(isTransientError(error));
    });
  }

  for (const status of [400, 401, 403, 404, 410, 422]) {
    test(`treats ${status} as a rejected request`, () => {
      const error = errorForHttpStatus(status);
      assert.ok(error instanceof RequestRejectedError);
      assert.equal((error as RequestRejectedError).status, status);
      assert.ok(!isTransientError(error));
    });
  }
});

describe('isTransientError', () => {
  test('only network errors that may go away by themselves are transient', () => {
    assert.ok(isTransientError(new NetworkServiceError));
    assert.ok(isTransientError(new DeadlineExceededError));
    assert.ok(!isTransientError(new TokenExpiredError));
    assert.ok(!isTransientError(new UnknownResponseError));
    assert.ok(!isTransientError(new RequestRejectedError(404)));
    assert.ok(!isTransientError(new StorageError));
    assert.ok(!isTransientError(new Error));
    assert.ok(!isTransientError(undefined));
  });
});

describe('error names', () => {
  test('logs show the actual error class', () => {
    assert.match(format(new RequestRejectedError(404)), /^RequestRejectedError: The request was rejected with HTTP status 404/);
    assert.match(format(new TokenExpiredError), /^TokenExpiredError/);
    assert.match(format(new InvalidConfigError('bad')), /^InvalidConfigError: bad/);
  });

  test('keeps the cause', () => {
    const cause = new Error('EACCES');
    assert.equal(new StorageError('Failed', { cause }).cause, cause);
  });
});
