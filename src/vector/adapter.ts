export interface VectorItem {
  hash: number;
  text: string;
  index: number;
}

export interface VectorQueryResult {
  hash: number;
  text: string;
  index: number;
  rank: number;
}

export type PrecomputedEmbeddingProvider = 'openai-compatible' | 'volcengine-multimodal';

export interface VectorRequestConfig {
  source: string;
  model?: string;
  sourceSettings?: Record<string, unknown>;
  precomputed?: {
    provider: PrecomputedEmbeddingProvider;
    endpoint: string;
    model: string;
    apiKey: string;
    timeoutMs: number;
  };
}

export interface VectorRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface VectorStoreAdapter {
  insert(
    collectionId: string,
    items: VectorItem[],
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<void>;
  query(
    collectionId: string,
    searchText: string,
    topK: number,
    threshold: number,
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<VectorQueryResult[]>;
  list(
    collectionId: string,
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<number[]>;
  delete(
    collectionId: string,
    hashes: number[],
    config: VectorRequestConfig,
    options?: VectorRequestOptions,
  ): Promise<void>;
  purge(collectionId: string, options?: VectorRequestOptions): Promise<void>;
}
