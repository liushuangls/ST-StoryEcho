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

export interface VectorRequestConfig {
  source: string;
  model?: string;
  sourceSettings?: Record<string, unknown>;
}

export interface VectorStoreAdapter {
  insert(collectionId: string, items: VectorItem[], config: VectorRequestConfig): Promise<void>;
  query(
    collectionId: string,
    searchText: string,
    topK: number,
    threshold: number,
    config: VectorRequestConfig,
  ): Promise<VectorQueryResult[]>;
  list(collectionId: string, config: VectorRequestConfig): Promise<number[]>;
  delete(collectionId: string, hashes: number[], config: VectorRequestConfig): Promise<void>;
  purge(collectionId: string): Promise<void>;
}
