import { type Logging } from 'homebridge';
import { EventEmitter } from 'node:events';
import axios, { AxiosInstance } from 'axios';
import zod from 'zod';
import { err, ok, Result, ResultAsync } from 'neverthrow';
import { OPENID_AUTH_URL, OPENID_CLIENT_ID, OPENID_TOKEN_ENDPOINT, OPENID_TOKEN_EXTRA_PARAMETERS, REQUEST_TIMEOUT_MS } from './constants.js';
import { errorForHttpStatus, NetworkServiceError, TokenExpiredError, UnknownResponseError } from '../lib/errors.js';
import { toRedactedJSON } from '../lib/utils.js';

const REFRESH_TOKEN_EXPIRED_MESSAGE =
  'The refresh token has expired or is invalid. Please get a new one, update the plugin config, and restart Homebridge';

/**
 * A class that's in charge of maintaining a valid OAuth/OpenID ID token
 *
 * Note that this class doesn't actively monitor the validity of the ID token.
 * It relies on the owner to notice that the ID token isn't working anymore.
 * The owner would then invoke `refreshToken` to tell this class to fetch a new one.
 */
export class OpenIDSession {
  private emitter: EventEmitter = new EventEmitter();

  private refresh_token?: string;
  private id_token?: string;
  private refresh_in_flight?: Promise<Result<void, NetworkServiceError>>;
  private readonly request: AxiosInstance;

  constructor(
    private readonly log: Logging,
    // Only meant to be overridden by tests
    base_url: string = OPENID_AUTH_URL,
  ) {
    this.request = axios.create({
      baseURL: base_url,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this.request.defaults.headers.post['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  /**
   * Force-set the ID token (if known)
   * @param token An OAuth/OpenID ID token (A JWT token)
   */
  setIdToken(token: string) {
    this.id_token = token;
  }

  /**
   * Set the refresh token
   * @param token An OAuth/OpenID refresh token (A JWT token)
   */
  setRefreshToken(token: string) {
    this.refresh_token = token;
  }

  /**
   * Mark the ID token as invalid, and attempt to fetch a new one
   *
   * @returns An error if that failed:
   * - `TokenExpiredError` if all avenues for fetching a new ID token have expired
   * - `UnknownResponseError` if we somehow failed to parse a response from the authorization service
   * - `NetworkServiceError` if we encounter a transient network error (e.g. a network hiccup)
   */
  refreshToken(): ResultAsync<void, NetworkServiceError> {
    // Concurrent callers share a single in-flight refresh. The refresh token is rotated on every use,
    // so parallel refreshes would race to redeem (and persist) the same refresh token.
    if (!this.refresh_in_flight) {
      this.refresh_in_flight = this._refreshToken().finally(() => {
        this.refresh_in_flight = undefined;
      });
    }
    return new ResultAsync(this.refresh_in_flight);
  }

  private async _refreshToken(): Promise<Result<void, NetworkServiceError>> {
    this.log.info('Refreshing OpenID token');
    this.id_token = '';
    if (!this.refresh_token) {
      this.log.error(REFRESH_TOKEN_EXPIRED_MESSAGE);
      return err(new TokenExpiredError);
    }
    const result = await this.getIDTokenUsingRefreshToken();
    if (result.isOk()) {
      this.emitTokenChanged(this.id_token!, this.refresh_token!);
    }
    return result;
  }

  /**
   * Get the ID token
   * @returns The OAuth/OpenID ID token (in JWT format)
   */
  getIdToken() {
    return this.id_token!;
  }

  /**
   * Check the validity of the ID token.
   * Note that this does not check the expiration status of the ID token,
   * so this function is mostly checking if the ID token is known.
   * @returns True if the ID token is valid
   */
  isValid() {
    return !!this.id_token;
  }

  /**
   * Register a callback for when the ID and/or refresh token changed
   * @param handler A callback function
   */
  onTokenChanged(handler: (id_token: string, refresh_token: string) => void) {
    this.emitter.on('tokenChanged', handler);
  }

  private async getIDTokenUsingRefreshToken(): Promise<Result<void, NetworkServiceError>> {
    this.log.info('Refreshing OpenID token using refresh token');
    const request_data = {
      grant_type: 'refresh_token',
      client_id: OPENID_CLIENT_ID,
      refresh_token: this.refresh_token!,
    };
    const ResponseFormat = zod.object({
      id_token: zod.string(),
      refresh_token: zod.string(),
    });
    const response = await ResultAsync.fromPromise(
      this.request.post(OPENID_TOKEN_ENDPOINT, request_data, { params: OPENID_TOKEN_EXTRA_PARAMETERS }),
      (error) => error);
    if (response.isErr()) {
      const error = response.error;
      if (axios.isAxiosError(error) && error.status === 400) {
        this.log.error(REFRESH_TOKEN_EXPIRED_MESSAGE);
        this.refresh_token = '';
        return err(new TokenExpiredError);
      }
      // Don't log the whole error: an AxiosError carries the request config, whose body holds the refresh token
      const status = axios.isAxiosError(error) ? error.status : undefined;
      this.log.error('Failed to refresh the OpenID token:', status, (error as Error).message);
      return err(errorForHttpStatus(status));
    }

    const parsed_response = ResponseFormat.safeParse(response.value.data);
    if (!parsed_response.success) {
      this.log.error('Failed to parse the OpenID token refresh response:', parsed_response.error, 'Received:', toRedactedJSON(response.value.data));
      this.refresh_token = '';
      return err(new UnknownResponseError);
    }
    this.id_token = parsed_response.data.id_token;
    this.refresh_token = parsed_response.data.refresh_token;
    return ok();
  }

  private emitTokenChanged(id_token: string, refresh_token: string) {
    this.emitter.emit('tokenChanged', id_token, refresh_token);
  }
}
