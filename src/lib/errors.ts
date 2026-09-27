export class InvalidConfigError extends Error {}
export class UnknownDeviceTypeError extends Error {}
export class NetworkServiceError extends Error {}
export class UnknownResponseError extends NetworkServiceError {}
export class TokenExpiredError extends NetworkServiceError {}
/**
 * Whether an error is likely to go away by itself (e.g. a network hiccup), so the failed operation is worth retrying.
 * `TokenExpiredError` and `UnknownResponseError` are also `NetworkServiceError`s, but they need the user to step in
 * (e.g. to provide a new refresh token), so retrying won't help them.
 */
export function isTransientError(error: unknown) {
  return error instanceof NetworkServiceError && !(error instanceof TokenExpiredError) && !(error instanceof UnknownResponseError);
}
