import { err, Result } from 'neverthrow';
import { DeadlineExceededError } from './errors.js';

export function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  // Calculate the proportion of the value within the input range (between 0 and 1)
  const proportion = (value - inMin) / (inMax - inMin);

  // Apply that same proportion to the output range
  const result = proportion * (outMax - outMin) + outMin;

  return result;
}

/**
 * Serialize a value to JSON for logging, redacting anything whose key looks like a token
 * (e.g. `id_token`, `refresh_token`, `token`), so credentials never end up in the Homebridge logs.
 */
export function toRedactedJSON(value: unknown) {
  return JSON.stringify(value, (key, val) => /token/i.test(key) ? '<redacted>' : val);
}

/**
 * Wait for an operation's Result, but give up once the signal aborts (e.g. when a deadline passes).
 * The operation itself carries on, which is useful when it's shared with other callers (e.g. a token refresh).
 */
export async function untilAborted<T, E>(result: PromiseLike<Result<T, E>>, signal?: AbortSignal)
  : Promise<Result<T, E | DeadlineExceededError>> {
  if (!signal) {
    return await result;
  }
  if (signal.aborted) {
    return err(new DeadlineExceededError);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<Result<T, DeadlineExceededError>>((resolve) => {
    onAbort = () => resolve(err(new DeadlineExceededError));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([result, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort!);
  }
}
