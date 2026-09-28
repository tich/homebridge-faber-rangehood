import type { Logging } from 'homebridge';
import axios, { AxiosInstance } from 'axios';
import { createHash } from 'node:crypto';
import zod from 'zod';
import { err, ok, Result, ResultAsync } from 'neverthrow';
import { OpenIDSession } from './openid.js';
import { ObjectStore } from '../lib/objectstore.js';
import {
  DeadlineExceededError, errorForHttpStatus, NetworkServiceError, NoHoodsError, StorageError, UnknownResponseError,
} from '../lib/errors.js';
import type { PluginConfig } from '../config.js';
import { toRedactedJSON, untilAborted } from '../lib/utils.js';
import {
  ASTARTE_API_ENDPOINT,
  ASTARTE_API_URL,
  ASTARTE_AUTH_URL,
  ASTARTE_REALM,
  ASTARTE_TOKEN_ENDPOINT,
  ASTARTE_USER_INFO_ENDPOINT,
  REQUEST_TIMEOUT_MS }
  from './constants.js';

export enum AstarteRequestMethod {
  GET = 'get',
  POST = 'post'
}

/**
 * A class that's in charge of interfacing with the Astarte Auth and API endpoints
 */
export class Astarte {
  private readonly openid_session: OpenIDSession;
  private readonly auth_request: AxiosInstance;
  private readonly api_request: AxiosInstance;
  private user_id?: string;
  private devices?: string[];
  private id_token?: string;
  private refresh_in_flight?: Promise<Result<void, NetworkServiceError>>;

  constructor(
    private readonly log: Logging,
    private readonly object_store: ObjectStore,
    // The services' base URLs. Only meant to be overridden by tests
    base_urls: { auth?: string, api?: string, openid?: string } = {},
  ) {
    this.openid_session = new OpenIDSession(log, base_urls.openid);
    this.openid_session.onTokenChanged((id_token: string, refresh_token: string) => {
      void this.persistTokens(id_token, refresh_token);
    });

    this.auth_request = axios.create({
      baseURL: base_urls.auth ?? ASTARTE_AUTH_URL,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this.api_request  = axios.create({
      baseURL: base_urls.api ?? ASTARTE_API_URL,
      timeout: REQUEST_TIMEOUT_MS,
    });
    this.api_request.defaults.headers.post['Content-Type'] = 'application/json';
  }

  /**
   * Persist refreshed tokens, so they survive a restart. The refresh token is rotated on every use,
   * so the one from the plugin config may not be valid anymore.
   * A failure is only logged, since the tokens in memory remain valid.
   */
  private async persistTokens(id_token: string, refresh_token: string) {
    const result = await this.object_store.getTokenData()
      .andThen((token_data) => this.object_store.setTokenData({ hashed_auth_cfg: token_data?.hashed_auth_cfg ?? '', id_token, refresh_token }));
    if (result.isErr()) {
      this.log.warn('Failed to store the refreshed tokens. After a restart, you may need to provide a new refresh token', result.error.cause);
    }
  }

  private getAuthConfigHash(config: PluginConfig) {
    return createHash('md5').update(config.auth_mode + config.refresh_token).digest('hex');
  }

  /**
   * Make sure we have an OpenID ID token, fetching a new one with the refresh token if needed.
   * The ID token can be missing if a previous refresh attempt failed (e.g. a network hiccup).
   */
  private async ensureOpenIdToken(): Promise<Result<void, NetworkServiceError>> {
    if (this.openid_session.isValid()) {
      return ok();
    }
    return await this.openid_session.refreshToken();
  }

  private async fetchUserId(is_retry: boolean = false): Promise<Result<void, NetworkServiceError>> {
    if (this.user_id !== undefined) {
      // Already done.
      return ok();
    }

    const openid_token = await this.ensureOpenIdToken();
    if (openid_token.isErr()) {
      return openid_token;
    }

    const ResponseFormat = zod.object({
      data: zod.object({
        user_id: zod.string(),
      }),
    });

    const response = await ResultAsync.fromPromise(
      this.auth_request.get(`${ASTARTE_USER_INFO_ENDPOINT}/${ASTARTE_REALM}`, { headers: { 'sso-token': this.openid_session.getIdToken() } }),
      (error) => error);
    if (response.isErr()) {
      const error = response.error;
      const status = axios.isAxiosError(error) ? error.status : undefined;
      if (!is_retry && status === 403) {
        // This error code is returned if the ID token is expired
        // Refresh the ID token, then retry the call
        const refreshed = await this.openid_session.refreshToken();
        return refreshed.isErr() ? refreshed : await this.fetchUserId(true);
      }
      this.log.error('Failed to query Astarte user info:', status, (error as Error).message);
      return err(errorForHttpStatus(status));
    }

    const parsed_response = ResponseFormat.safeParse(response.value.data);
    if (!parsed_response.success) {
      this.log.error('Failed to parse the Astarte user info response:', parsed_response.error, 'Received:', toRedactedJSON(response.value.data));
      return err(new UnknownResponseError);
    }
    this.user_id = parsed_response.data.data.user_id;
    return ok();
  }

  private refreshToken(): ResultAsync<void, NetworkServiceError> {
    // Concurrent callers (e.g. several requests that all got a 403) share a single in-flight refresh
    if (!this.refresh_in_flight) {
      this.refresh_in_flight = this._refreshToken().finally(() => {
        this.refresh_in_flight = undefined;
      });
    }
    return new ResultAsync(this.refresh_in_flight);
  }

  private async _refreshToken(is_retry: boolean = false): Promise<Result<void, NetworkServiceError>> {
    const user_id = await this.ensureOpenIdToken().then((result) => result.isOk() ? this.fetchUserId() : result);
    if (user_id.isErr()) {
      return user_id;
    }

    // The account's devices are grouped by type, each with its own token. Only range hoods are supported,
    // and an account without any (e.g. with only other Faber devices) may not have a group for them at all
    const ResponseFormat = zod.object({
      data: zod.object({
        hoods: zod.object({
          devices: zod.array(zod.object({
            id: zod.string(),
          })),
          token: zod.string(),
        }).optional(),
      }),
    });

    const response = await ResultAsync.fromPromise(
      this.auth_request.get(`${ASTARTE_TOKEN_ENDPOINT}/${ASTARTE_REALM}/users/${this.user_id!}/devices`,
        { headers: { 'sso-token': this.openid_session.getIdToken() } }),
      (error) => error);
    if (response.isErr()) {
      const error = response.error;
      const status = axios.isAxiosError(error) ? error.status : undefined;
      if (!is_retry && status === 403) {
        // This error code is returned if the ID token is expired
        // Refresh the ID token, then retry the call
        const refreshed = await this.openid_session.refreshToken();
        return refreshed.isErr() ? refreshed : await this._refreshToken(true);
      }
      this.log.error('Failed to query Astarte token:', status, (error as Error).message);
      this.id_token = undefined;
      return err(errorForHttpStatus(status));
    }

    const parsed_response = ResponseFormat.safeParse(response.value.data);
    if (!parsed_response.success) {
      this.log.error('Failed to parse the Astarte token response:', parsed_response.error, 'Received:', toRedactedJSON(response.value.data));
      return err(new UnknownResponseError);
    }
    const hoods = parsed_response.data.data.hoods;
    if (hoods === undefined || hoods.devices.length === 0) {
      this.log.error('Your Faber account has no range hoods. Please add yours in the Faber Cloud App, and restart Homebridge');
      this.id_token = undefined;
      return err(new NoHoodsError);
    }
    if (this.devices === undefined) {
      this.devices = hoods.devices.map((device) => device.id);
    }
    this.id_token = hoods.token;
    return ok();
  }

  private async _doRequest(
    device_id: string, api_interface: string, method: string, value: Record<string, unknown>, signal: AbortSignal | undefined, is_retry: boolean,
  ): Promise<Result<unknown, NetworkServiceError>> {
    const token = this.id_token;
    const headers: Record<string,string> = { 'Authorization': `Bearer ${token!}` };
    const response = await ResultAsync.fromPromise(
      this.api_request({
        url: `${ASTARTE_API_ENDPOINT}/${ASTARTE_REALM}/devices/${device_id}/interfaces/${api_interface}`,
        method: method,
        headers: headers,
        data: value,
        signal: signal }),
      (error) => error);
    if (response.isErr()) {
      const error = response.error;
      if (axios.isCancel(error)) {
        this.log.debug('Cancelled the Astarte request', api_interface, 'since its deadline passed');
        return err(new DeadlineExceededError);
      }
      const status = axios.isAxiosError(error) ? error.status : undefined;
      if (!is_retry && status === 403) {
        // This error is returned if the Astarte ID token is expired
        // Refresh the ID token, then retry the call. The refresh isn't cancelled if the deadline passes, since it's shared
        // with other requests, and the next request will benefit from it. Only waiting for it is.
        // If the token was already refreshed since this request was sent (e.g. by a concurrent request), just retry
        const refreshed = this.id_token !== token ? ok() : await untilAborted(this.refreshToken(), signal);
        return refreshed.isErr() ? refreshed : await this._doRequest(device_id, api_interface, method, value, signal, true);
      }
      this.log.error('Failed to query Astarte', api_interface, status, (error as Error).message);
      return err(errorForHttpStatus(status));
    }
    return ok(response.value.data);
  }

  /**
   * Perform an Astarte API request
   *
   * @param device_id The device ID, as returned from `getDevices()`
   * @param api_interface The actual API path for the request
   * @param method GET/POST/etc.
   * @param value Optional. Can be an empty record if no data accompanies this request
   * @param signal Optional. Cancels the request when it aborts (e.g. when a deadline passes)
   * @returns The response's data, or an error:
   * - `TokenExpiredError` if all avenues for fetching a new ID token have expired
   * - `UnknownResponseError` if we somehow failed to parse a response from the Astarte service
   * - `DeadlineExceededError` if the signal aborted before the request completed
   * - `NetworkServiceError` if a temporary network issue prevented us from reaching the Astarte service
   */
  public doRequest(device_id: string, api_interface: string, method: AstarteRequestMethod, value: Record<string, unknown>, signal?: AbortSignal)
    : ResultAsync<unknown, NetworkServiceError> {
    return new ResultAsync(this._doRequest(device_id, api_interface, method, value, signal, false));
  }

  /**
   * Get what's needed to connect to Astarte's channels: a fresh Astarte token (so it lasts the connection as long as
   * possible), and the user's ID, which is the name of the user's room
   */
  public async getChannelCredentials(): Promise<Result<{ token: string; user_id: string }, NetworkServiceError>> {
    const refreshed = await this.refreshToken();
    if (refreshed.isErr()) {
      return err(refreshed.error);
    }
    return ok({ token: this.id_token!, user_id: this.user_id! });
  }

  /**
   * Retrieve the list of devices that the current user's account has access to
   * @returns {string[]} A list of device ID strings
   */
  public getDevices() {
    return this.devices!;
  }

  /**
   * Initialize the connection to the Astarte service
   *
   * @returns An error if that failed:
   * - `StorageError` if the persisted tokens couldn't be read or written
   * - `TokenExpiredError` if all avenues for fetching a new ID token have expired
   * - `NoHoodsError` if the account has no range hoods
   * - `UnknownResponseError` if we somehow failed to parse a response from the Astarte service
   * - `NetworkServiceError` if a temporary network issue prevented us from reaching the Astarte service
   */
  public async init(config: PluginConfig): Promise<Result<void, StorageError | NetworkServiceError>> {
    const auth_cfg_hash = this.getAuthConfigHash(config);

    let persisted_auth_data = await this.object_store.getTokenData();
    if (persisted_auth_data.isOk() && persisted_auth_data.value?.hashed_auth_cfg !== auth_cfg_hash) {
      // The user changed the auth config (or there's nothing persisted yet), so clear out our cached refresh and ID tokens
      persisted_auth_data = await this.object_store.setTokenData({ hashed_auth_cfg: auth_cfg_hash, id_token: '', refresh_token: '' })
        .andThen(() => this.object_store.getTokenData());
    }
    if (persisted_auth_data.isErr()) {
      return err(persisted_auth_data.error);
    }

    if (persisted_auth_data.value?.id_token) {
      this.openid_session.setIdToken(persisted_auth_data.value.id_token);
      this.openid_session.setRefreshToken(persisted_auth_data.value.refresh_token);
    } else {
      this.openid_session.setRefreshToken(config.refresh_token);
      const refreshed = await this.openid_session.refreshToken();
      if (refreshed.isErr()) {
        return refreshed;
      }
    }
    return await this.refreshToken();
  }
}
