export class InvalidConfigError extends Error {}
export class UnknownDeviceTypeError extends Error {}
export class NetworkServiceError extends Error {}
export class UnknownResponseError extends NetworkServiceError {}
export class TokenExpiredError extends NetworkServiceError {}