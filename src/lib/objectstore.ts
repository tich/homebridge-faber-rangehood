import NodePersist from 'node-persist';

export class ObjectStore {
  protected node_persist: NodePersist.LocalStorage;

  constructor(storage_path: string) {
    this.node_persist = NodePersist.create({ dir: storage_path, writeQueue: false });
  }

  async init() {
    await this.node_persist.init();
  }

  async setTokenData(token_data: Record<string, unknown>) {
    await this.node_persist.setItem('tokens', token_data);
  }

  async getTokenData() {
    return await this.node_persist.getItem('tokens');
  }
}