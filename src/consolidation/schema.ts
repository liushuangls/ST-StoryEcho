export const CONSOLIDATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['actions'],
  properties: {
    actions: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidateIndex', 'operation', 'targetMemoryId', 'reason'],
        properties: {
          candidateIndex: { type: 'integer', minimum: 0, maximum: 19 },
          operation: {
            type: 'string',
            enum: ['CREATE', 'MERGE', 'UPDATE', 'RESOLVE', 'SUPERSEDE', 'IGNORE'],
          },
          targetMemoryId: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
  },
};
