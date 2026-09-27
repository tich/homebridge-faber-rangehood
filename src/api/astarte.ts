import type { Logging, PlatformConfig } from 'homebridge';
import axios, { AxiosInstance } from 'axios';
import MD5 from 'md5';
import zod from 'zod';
import { OpenIDSession } from './openid.js';
import { ObjectStore } from '../lib/objectstore.js';
import { InvalidConfigError, NetworkServiceError, UnknownResponseError } from '../lib/errors.js';
import { toRedactedJSON } from '../lib/utils.js';
import { ASTARTE_API_ENDPOINT, ASTARTE_API_URL, ASTARTE_AUTH_URL, ASTARTE_REALM, ASTARTE_TOKEN_ENDPOINT, ASTARTE_USER_INFO_ENDPOINT } from './constants.js';

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
  private refresh_in_flight?: Promise<void>;

  constructor(
    private readonly log: Logging,
    private readonly config: PlatformConfig,
    private readonly object_store: ObjectStore,
  ) {
    this.openid_session = new OpenIDSession(log);
    this.openid_session.onTokenChanged(async (id_token: string, refresh_token: string) => {
      const persisted_auth_data = await this.object_store.getTokenData();
      persisted_auth_data.id_token = id_token;
      persisted_auth_data.refresh_token = refresh_token;
      await this.object_store.setTokenData(persisted_auth_data);
    });

    this.auth_request = axios.create({
      baseURL: ASTARTE_AUTH_URL,
      timeout: 30 * 1000,
    });
    this.api_request  = axios.create({
      baseURL: ASTARTE_API_URL,
      timeout: 30 * 1000,
    });
    this.api_request.defaults.headers.post['Content-Type'] = 'application/json';
  }

  private getAuthConfigHash() {
    let auth_cfg_str = this.config.auth_mode;
    if (this.config.auth_mode === 'token') {
      auth_cfg_str += this.config.refresh_token;
    } else {
      throw new InvalidConfigError(`Unhandled auth mode: ${this.config.auth_mode}`);
    }
    return MD5(auth_cfg_str);
  }

  /**
   * Make sure we have an OpenID ID token, fetching a new one with the refresh token if needed.
   * The ID token can be missing if a previous refresh attempt failed (e.g. a network hiccup).
   *
   * @throws {TokenExpiredError} If all avenues for fetching a new ID token have expired
   */
  private async ensureOpenIdToken() {
    if (!this.openid_session.isValid()) {
      await this.openid_session.refreshToken();
    }
  }

  private async fetchUserId(is_retry: boolean = false): Promise<void> {
    if (this.user_id !== undefined) {
      // Already done.
      return;
    }

    await this.ensureOpenIdToken();

    const ResponseFormat = zod.object({
      data: zod.object({
        user_id: zod.string(),
      }),
    });

    let response;
    try {
      response = await this.auth_request.get(`${ASTARTE_USER_INFO_ENDPOINT}/${ASTARTE_REALM}`,
        { headers: { 'sso-token': this.openid_session.getIdToken() } });
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.status : undefined;
      if (!is_retry && status === 403) {
        // This error code is returned if the ID token is expired
        // Refresh the ID token
        await this.openid_session.refreshToken();
        // Retry the call
        return await this.fetchUserId(true);
      }
      this.log.error('Failed to query Astarte user info:', status, (error as Error).message);
      throw new NetworkServiceError;
    }

    const parsed_response = ResponseFormat.safeParse(response.data);
    if (!parsed_response.success) {
      this.log.error('Failed to parse the Astarte user info response:', parsed_response.error, 'Received:', toRedactedJSON(response.data));
      throw new UnknownResponseError;
    }
    this.user_id = parsed_response.data.data.user_id;
  }

  private async refreshToken() {
    // Concurrent callers (e.g. several requests that all got a 403) share a single in-flight refresh
    if (!this.refresh_in_flight) {
      this.refresh_in_flight = this._refreshToken().finally(() => {
        this.refresh_in_flight = undefined;
      });
    }
    await this.refresh_in_flight;
  }

  private async _refreshToken(is_retry: boolean = false): Promise<void> {
    await this.ensureOpenIdToken();

    await this.fetchUserId();

    const ResponseFormat = zod.object({
      data: zod.object({
        hoods: zod.object({ // TODO do we have a different token for each device type?
          devices: zod.array(zod.object({
            id: zod.string(),
          })),
          token: zod.string(),
        }),
      }),
    });

    let response;
    try {
      response = await this.auth_request.get(`${ASTARTE_TOKEN_ENDPOINT}/${ASTARTE_REALM}/users/${this.user_id!}/devices`,
        { headers: { 'sso-token': this.openid_session.getIdToken() } });
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.status : undefined;
      if (!is_retry && status === 403) {
        // This error code is returned if the ID token is expired
        // Refresh the ID token
        await this.openid_session.refreshToken();
        // Retry the call
        return await this._refreshToken(true);
      }
      this.log.error('Failed to query Astarte token:', status, (error as Error).message);
      this.id_token = undefined;
      throw new NetworkServiceError;
    }

    const parsed_response = ResponseFormat.safeParse(response.data);
    if (!parsed_response.success) {
      this.log.error('Failed to parse the Astarte token response:', parsed_response.error, 'Received:', toRedactedJSON(response.data));
      throw new UnknownResponseError;
    }
    if (this.devices === undefined) {
      this.devices = [];
      for (const device of parsed_response.data.data.hoods.devices) {
        this.devices.push(device.id);
      }
    }
    this.id_token = parsed_response.data.data.hoods.token;
  }

  private async _doRequest(
    device_id: string, api_interface: string, method: string, value: Record<string, unknown>, is_retry: boolean = false): Promise<unknown> {
    const headers: Record<string,string> = { 'Authorization': `Bearer ${this.id_token!}` };
    try {
      const response = await this.api_request({
        url: `${ASTARTE_API_ENDPOINT}/${ASTARTE_REALM}/devices/${device_id}/interfaces/${api_interface}`,
        method: method,
        headers: headers,
        data: value });
      return response.data;
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.status : undefined;
      if (!is_retry && status === 403) {
        // This error is returned if the Astarte ID token is expired
        // Refresh the ID token
        await this.refreshToken();
        // Retry the call
        return await this._doRequest(device_id, api_interface, method, value, true);
      }
      this.log.error('Failed to query Astarte', api_interface, status, (error as Error).message);
      throw new NetworkServiceError;
    }
  }

  /**
   * Perform an Astarte API request
   * 
   * @param device_id The device ID, as returned from `getDevices()`
   * @param api_interface The actual API path for the request
   * @param method GET/POST/etc.
   * @param value Optional. Can be an empty record if no data accompanies this request
   * @returns 
   * 
   * @throws {UnknownResponseError} If we somehow failed to parse a response from the Astarte service
   * @throws {TokenExpiredError} If all avenues for fetching a new ID token have expired
   * @throws {NetworkServiceError} If a temporary network issue prevented us from reaching the Astarte service
   */
  public async doRequest(device_id: string, api_interface: string, method: AstarteRequestMethod, value: Record<string, unknown>) {
    return await this._doRequest(device_id, api_interface, method, value, false);
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
   * @throws {UnknownResponseError} If we somehow failed to parse a response from the Astarte service
   * @throws {TokenExpiredError} If all avenues for fetching a new ID token have expired
   * @throws {NetworkServiceError} If a temporary network issue prevented us from reaching the Astarte service
   */
  public async init() {
    let persisted_auth_data = await this.object_store.getTokenData();
    const auth_cfg_hash = this.getAuthConfigHash();
    if (!persisted_auth_data || (persisted_auth_data && (auth_cfg_hash !== persisted_auth_data.hashed_auth_cfg))) {
      // The user changed the auth config, so clear out our cached refresh and ID tokens
      await this.object_store.setTokenData({ hashed_auth_cfg: auth_cfg_hash, id_token: '', refresh_token: '' });
      persisted_auth_data = await this.object_store.getTokenData();
    }
    if (persisted_auth_data.id_token) {
      this.openid_session.setIdToken(persisted_auth_data.id_token);
      this.openid_session.setRefreshToken(persisted_auth_data.refresh_token);
    } else {
      if (this.config.auth_mode === 'token') {
        this.openid_session.setRefreshToken(this.config.refresh_token);
      } else {
        throw new InvalidConfigError(`Unhandled auth mode: ${this.config.auth_mode}`);
      }
      await this.openid_session.refreshToken();
    }
    await this.refreshToken();
  }
}