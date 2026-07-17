import { getRequestHeaders } from '../platform/sillytavern';
import type {
  VectorItem,
  VectorQueryResult,
  VectorRequestConfig,
  VectorStoreAdapter,
} from './adapter';

interface VectorMetadata {
  hash?: number | string;
  text?: string;
  index?: number | string;
}

function requestBody(
  collectionId: string,
  config: VectorRequestConfig,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    collectionId,
    source: config.source,
    ...(config.model ? { model: config.model } : {}),
    ...(config.sourceSettings ?? {}),
    ...extra,
  };
}

export class SillyTavernVectorStore implements VectorStoreAdapter {
  async insert(collectionId: string, items: VectorItem[], config: VectorRequestConfig): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.post('/api/vector/insert', requestBody(collectionId, config, { items }));
  }

  async query(
    collectionId: string,
    searchText: string,
    topK: number,
    threshold: number,
    config: VectorRequestConfig,
  ): Promise<VectorQueryResult[]> {
    const response = await this.post('/api/vector/query',
      requestBody(collectionId, config, { searchText, topK, threshold }));
    const responseRecord = Array.isArray(response) ? {} : response;
    const metadata = Array.isArray(responseRecord['metadata'])
      ? (responseRecord['metadata'] as VectorMetadata[])
      : [];

    return metadata.flatMap((item, rank) => {
      const hash = Number(item.hash);
      const index = Number(item.index);
      if (!Number.isFinite(hash)) {
        return [];
      }
      return [{
        hash,
        text: typeof item.text === 'string' ? item.text : '',
        index: Number.isFinite(index) ? index : -1,
        rank,
      }];
    });
  }

  async list(collectionId: string, config: VectorRequestConfig): Promise<number[]> {
    const response = await this.post('/api/vector/list', requestBody(collectionId, config));
    if (!Array.isArray(response)) {
      return [];
    }
    return response.map(Number).filter(Number.isFinite);
  }

  async delete(collectionId: string, hashes: number[], config: VectorRequestConfig): Promise<void> {
    if (hashes.length === 0) {
      return;
    }
    await this.post('/api/vector/delete', requestBody(collectionId, config, { hashes }));
  }

  async purge(collectionId: string): Promise<void> {
    await this.post('/api/vector/purge', { collectionId });
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown> | unknown[]> {
    const headers = await getRequestHeaders();
    const response = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Vector Storage请求失败：${path}（HTTP ${response.status}）`);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {};
    }

    const text = await response.text();
    return text ? (JSON.parse(text) as Record<string, unknown> | unknown[]) : {};
  }
}
