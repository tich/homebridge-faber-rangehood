import type { Logging, PlatformConfig } from 'homebridge';
import axios, { AxiosInstance } from 'axios';
import MD5 from 'md5';
import zod from 'zod';
import { OpenIDSession } from './openid.js';
import { ObjectStore } from '../lib/objectstore.js';
import { InvalidConfigError, NetworkServiceError, TokenExpiredError, UnknownResponseError } from '../lib/errors.js';
import { ASTARTE_API_ENDPOINT, ASTARTE_API_URL, ASTARTE_AUTH_URL, ASTARTE_REALM, ASTARTE_TOKEN_ENDPOINT, ASTARTE_USER_INFO_ENDPOINT } from './constants.js';

export enum AstarteRequestMethod {
  GET = 'get',
  POST = 'post'
}

export class Astarte {
  private readonly openid_session: OpenIDSession;
  private readonly auth_request: AxiosInstance;
  private readonly api_request: AxiosInstance;
  private user_id?: string;
  private devices?: string[];
  private id_token?: string;

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

  private async fetchUserId(is_retry: boolean = false) {
    if (this.user_id !== undefined) {
      // Already done.
      return;
    }

    if (!this.openid_session.isValid()) {
      throw new TokenExpiredError;
    }

    const ResponseFormat = zod.object({
      data: zod.object({
        user_id: zod.string(),
      }),
    });

    await this.auth_request
      .get(`${ASTARTE_USER_INFO_ENDPOINT}/${ASTARTE_REALM}`,
        { headers: { 'sso-token': this.openid_session.getIdToken() } })
      .then((response) => {
        const parsed_response = ResponseFormat.safeParse(response.data);
        if (parsed_response.success) {
          this.user_id = parsed_response.data.data.user_id;
        } else {
          this.log.error('Failed to parse the Astarte user info response:', parsed_response.error, 'Received:', JSON.stringify(response.data));
          throw new UnknownResponseError;
        }
      }).catch(async (error) => {
        if (!is_retry && error.status === 403) {
          // This error code is returned if the ID token is expired
          // Refresh the ID token
          await this.openid_session.refreshToken();
          // Retry the call
          await this.fetchUserId(true);
        } else {
          this.log.error('Failed to query Astarte user info:', error.status, error.message);
          throw new NetworkServiceError;
        }
      });
  }

  private async refreshToken(is_retry: boolean = false) {
    if (!this.openid_session.isValid()) {
      throw new TokenExpiredError;
    }

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

    await this.auth_request
      .get(`${ASTARTE_TOKEN_ENDPOINT}/${ASTARTE_REALM}/users/${this.user_id!}/devices`,
        { headers: { 'sso-token': this.openid_session.getIdToken() } })
      .then((response) => {
        const parsed_response = ResponseFormat.safeParse(response.data);
        if (!parsed_response.success) {
          this.log.error('Failed to parse the Astarte token response:', parsed_response.error, 'Received:', JSON.stringify(response.data));
          throw new UnknownResponseError;
        }
        if (this.devices === undefined) {
          this.devices = [];
          for (const device of parsed_response.data.data.hoods.devices) {
            this.devices.push(device.id);
          }
        }
        this.id_token = parsed_response.data.data.hoods.token;
      }).catch(async (error) => {
        if (!is_retry && error.status === 403) {
          // This error code is returned if the ID token is expired
          // Refresh the ID token
          await this.openid_session.refreshToken();
          // Retry the call
          await this.refreshToken(true);
        } else {
          this.log.error('Failed to query Astarte token:', error.status, error.message);
          this.id_token = undefined;
          throw new NetworkServiceError;
        }
      });
  }

  private async _doRequest(device_id: string, api_interface: string, method: string, value: Record<string, unknown>, is_retry: boolean = false) {
    const headers: Record<string,string> = { 'Authorization': `Bearer ${this.id_token!}` };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let returned_data: any = {};
    await this.api_request({
      url: `${ASTARTE_API_ENDPOINT}/${ASTARTE_REALM}/devices/${device_id}/interfaces/${api_interface}`,
      method: method,
      headers: headers,
      data: value })
      .then((response) => {
        returned_data = response.data;
      })
      .catch(async (error) => {
        if (!is_retry && error.status === 403) {
          // This error is returned if the the Astarte ID token is expired
          // Refresh the ID token
          await this.refreshToken();
          // Retry the call
          returned_data = await this._doRequest(device_id, api_interface, method, value, true);
        } else {
          this.log.error('Failed to query Astarte', api_interface, error.status, error.message);
          throw new NetworkServiceError;
        }
      });

    return returned_data;
  }

  public async doRequest(device_id: string, api_interface: string, method: AstarteRequestMethod, value: Record<string, unknown>) {
    return await this._doRequest(device_id, api_interface, method, value, false);
  }

  public getDevices() {
    return this.devices!;
  }

  async init() {
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