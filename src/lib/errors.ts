/**
 * Base class for the plugin's errors. Sets `name` to the actual error class,
 * so that logs show e.g. `RequestRejectedError: …` rather than `Error: …`
 */
class PluginError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class InvalidConfigError extends PluginError {}
export class UnknownDeviceTypeError extends PluginError {}
export class NetworkServiceError extends PluginError {}
export class UnknownResponseError extends NetworkServiceError {}
export class TokenExpiredError extends NetworkServiceError {}
/** The operation was given up on, since it couldn't complete within its deadline */
export class DeadlineExceededError extends NetworkServiceError {}
/** The server refused the request (e.g. a 404, or a 403 even after refreshing the token), so retrying it won't help */
export class RequestRejectedError extends NetworkServiceError {
  constructor(public readonly status: number) {
    super(`The request was rejected with HTTP status ${status}`);
  }
}
export class StorageError extends PluginError {}
export class InvalidCacheError extends PluginError {}

/**
 * Whether an error is likely to go away by itself (e.g. a network hiccup), so the failed operation is worth retrying.
 * `TokenExpiredError`, `UnknownResponseError`, and `RequestRejectedError` are also `NetworkServiceError`s,
 * but they need the user to step in (e.g. to provide a new refresh token), so retrying won't help them.
 */
export function isTransientError(error: unknown) {
  return error instanceof NetworkServiceError
    && !(error instanceof TokenExpiredError) && !(error instanceof UnknownResponseError) && !(error instanceof RequestRejectedError);
}

/**
 * The error for a failed HTTP request, depending on whether retrying it may help: it may if there was no response at all
 * (e.g. a network error), for a server error (5xx), a request timeout (408), or rate limiting (429).
 * Other client errors (4xx) mean the server refused the request, which retrying won't change.
 *
 * @param status The response's HTTP status, or `undefined` if there was no response
 */
export function errorForHttpStatus(status: number | undefined): NetworkServiceError {
  if (status === undefined || status >= 500 || status === 408 || status === 429) {
    return new NetworkServiceError;
  }
  return new RequestRejectedError(status);
}
