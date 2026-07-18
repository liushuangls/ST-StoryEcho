import type { PrecomputedEmbeddingProvider } from './adapter';
import type { EmbeddingClient } from './embedding-client';
import { openAiCompatibleEmbeddingClient } from './openai-compatible-embedding';
import { volcengineMultimodalEmbeddingClient } from './volcengine-multimodal-embedding';

export type EmbeddingClientResolver = (provider: PrecomputedEmbeddingProvider) => EmbeddingClient;

export const resolveEmbeddingClient: EmbeddingClientResolver = (provider) => {
  switch (provider) {
    case 'openai-compatible':
      return openAiCompatibleEmbeddingClient;
    case 'volcengine-multimodal':
      return volcengineMultimodalEmbeddingClient;
  }
};
