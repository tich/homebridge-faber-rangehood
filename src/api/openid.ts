import { type Logging } from 'homebridge';
import { EventEmitter } from 'node:events';
import axios, { AxiosInstance } from 'axios';
import zod from 'zod';
import { OPENID_AUTH_URL, OPENID_CLIENT_ID, OPENID_TOKEN_ENDPOINT, OPENID_TOKEN_EXTRA_PARAMETERS } from './constants.js';
import { TokenExpiredError, UnknownResponseError } from '../lib/errors.js';

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

  setIdToken(token: string) {
    this.id_token = token;
  }

  setRefreshToken(token: string) {
    this.refresh_token = token;
  }

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

  getIdToken() {
    return this.id_token!;
  }

  isValid() {
    return !!this.id_token;
  }

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
        this.log.error('Failed to refresh the OpenID token:', error);
        this.refresh_token = '';
        throw new TokenExpiredError;
      });
  }

  private emitTokenChanged(id_token: string, refresh_token: string) {
    this.emitter.emit('tokenChanged', id_token, refresh_token);
  }
}