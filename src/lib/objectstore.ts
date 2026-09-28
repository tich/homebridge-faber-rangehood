import NodePersist from 'node-persist';
import { ResultAsync } from 'neverthrow';
import { StorageError } from './errors.js';

export interface TokenData {
  hashed_auth_cfg: string;
  id_token: string;
  refresh_token: string;
}

export class ObjectStore {
  protected node_persist: NodePersist.LocalStorage;

  constructor(public readonly storage_path: string) {
    // No expiring items are stored, so turn off the periodic scan for them (every 2 minutes by default). Besides being useless,
    // its errors (e.g. if the directory became unreadable) are unhandled promise rejections, which make Homebridge shut down
    this.node_persist = NodePersist.create({ dir: storage_path, writeQueue: false, expiredInterval: 0 });
  }

  init(): ResultAsync<void, StorageError> {
    return ResultAsync.fromPromise(this.node_persist.init(), (error) => new StorageError('Failed to initialize the storage', { cause: error }))
      .map(() => undefined);
  }

  setTokenData(token_data: TokenData): ResultAsync<void, StorageError> {
    return ResultAsync.fromPromise(this.node_persist.setItem('tokens', token_data),
      (error) => new StorageError('Failed to store the tokens', { cause: error }))
      .map(() => undefined);
  }

  /**
   * @returns The stored token data, or `undefined` if none was stored yet
   */
  getTokenData(): ResultAsync<TokenData | undefined, StorageError> {
    return ResultAsync.fromPromise(this.node_persist.getItem('tokens') as Promise<TokenData | undefined>,
      (error) => new StorageError('Failed to read the tokens', { cause: error }));
  }
}
