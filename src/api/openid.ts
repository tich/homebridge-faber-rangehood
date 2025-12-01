import { type Logging } from 'homebridge';
import { EventEmitter } from 'node:events';
import axios, { AxiosInstance } from 'axios';
import zod from 'zod';
import { OPENID_AUTH_URL, OPENID_CLIENT_ID, OPENID_TOKEN_ENDPOINT, OPENID_TOKEN_EXTRA_PARAMETERS } from './constants.js';
import { NetworkServiceError, TokenExpiredError, UnknownResponseError } from '../lib/errors.js';

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
  private readonly request: AxiosInstance;

  constructor(
        private readonly log: Logging,
  ) {
    this.request = axios.create({
      baseURL: OPENID_AUTH_URL,
      timeout: 30 * 1000,
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
   * @throws {UnknownResponseError} If we somehow failed to parse a response from the authorization service
   * @throws {NetworkServiceError} If we encounter a transient network error (e.g. a network hiccup)
   * @throws {TokenExpiredError} If all avenues for fetching a new ID token have expired
   */
  async refreshToken() {
    this.log.info('Refreshing OpenID token');
    this.id_token = '';
    if (this.refresh_token) {
      await this.getIDTokenUsingRefreshToken();
    } else {
      this.log.error('Cannot get OpenID token because the refresh token has expired or is invalid');
    }
    this.emitTokenChanged(this.id_token!, this.refresh_token!);
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

  private async getIDTokenUsingRefreshToken() {
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
    await this.request
      .post(OPENID_TOKEN_ENDPOINT, request_data, { params: OPENID_TOKEN_EXTRA_PARAMETERS })
      .then((response) => {
        const parsed_response = ResponseFormat.safeParse(response.data);
        if (parsed_response.success) {
          this.id_token = parsed_response.data.id_token;
          this.refresh_token = parsed_response.data.refresh_token;
        } else {
          this.log.error('Failed to parse the OpenID token refresh response:', parsed_response.error, 'Received:', JSON.stringify(response.data));
          this.refresh_token = '';
          throw new UnknownResponseError;
        }
      })
      .catch((error) => {
        if (error.status === 400) {
          this.refresh_token = '';
          throw new TokenExpiredError;
        } else {
          this.log.error('Failed to refresh the OpenID token:', error);
          throw new NetworkServiceError;
        }
      });
  }

  private emitTokenChanged(id_token: string, refresh_token: string) {
    this.emitter.emit('tokenChanged', id_token, refresh_token);
  }
}