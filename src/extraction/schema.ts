const SOURCE_MESSAGE_IDS = {
  type: 'array',
  minItems: 1,
  items: { type: 'integer', minimum: 0 },
};

const STRING_ARRAY = {
  type: 'array',
  items: { type: 'string' },
};

const SCENE = {
  type: 'object',
  additionalProperties: false,
  required: ['location', 'time', 'participants'],
  properties: {
    location: { type: 'string' },
    time: { type: 'string' },
    participants: STRING_ARRAY,
  },
};

const TRUTH_STATUS = {
  type: 'string',
  enum: ['confirmed', 'claimed', 'inferred', 'uncertain'],
};

const IMPORTANCE = { type: 'number', minimum: 0, maximum: 1 };

const COMMON_PROPERTIES = {
  sourceMessageIds: SOURCE_MESSAGE_IDS,
  scene: SCENE,
  knownBy: STRING_ARRAY,
  truthStatus: TRUTH_STATUS,
  importance: IMPORTANCE,
};

const COMMON_REQUIRED = [
  'sourceMessageIds',
  'scene',
  'knownBy',
  'truthStatus',
  'importance',
];

const EPISODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...COMMON_REQUIRED,
    'kind',
    'action',
    'cause',
    'consequence',
    'entities',
    'aliases',
    'unresolvedThreads',
  ],
  properties: {
    ...COMMON_PROPERTIES,
    kind: { type: 'string', enum: ['event', 'conflict'] },
    action: { type: 'string' },
    cause: { type: 'string' },
    consequence: { type: 'string' },
    entities: STRING_ARRAY,
    aliases: STRING_ARRAY,
    unresolvedThreads: STRING_ARRAY,
  },
};

const STATE_FACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...COMMON_REQUIRED,
    'entity',
    'attribute',
    'before',
    'after',
    'aliases',
  ],
  properties: {
    ...COMMON_PROPERTIES,
    entity: { type: 'string' },
    attribute: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
    aliases: STRING_ARRAY,
  },
};

const RELATIONSHIP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...COMMON_REQUIRED,
    'leftEntity',
    'rightEntity',
    'relationType',
    'before',
    'after',
  ],
  properties: {
    ...COMMON_PROPERTIES,
    leftEntity: { type: 'string' },
    rightEntity: { type: 'string' },
    relationType: { type: 'string' },
    before: { type: 'string' },
    after: { type: 'string' },
  },
};

const COMMITMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...COMMON_REQUIRED,
    'actor',
    'beneficiary',
    'action',
    'object',
    'previousStatus',
    'status',
  ],
  properties: {
    ...COMMON_PROPERTIES,
    actor: { type: 'string' },
    beneficiary: { type: 'string' },
    action: { type: 'string' },
    object: { type: 'string' },
    previousStatus: { type: 'string' },
    status: {
      type: 'string',
      enum: ['pending', 'completed', 'cancelled', 'failed'],
    },
  },
};

const REVELATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...COMMON_REQUIRED,
    'proposition',
    'entities',
    'aliases',
  ],
  properties: {
    ...COMMON_PROPERTIES,
    proposition: { type: 'string' },
    entities: STRING_ARRAY,
    aliases: STRING_ARRAY,
  },
};

const CLUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    ...COMMON_REQUIRED,
    'evidence',
    'observation',
    'implication',
    'entities',
    'aliases',
    'unresolvedThreads',
  ],
  properties: {
    ...COMMON_PROPERTIES,
    evidence: { type: 'string' },
    observation: { type: 'string' },
    implication: { type: 'string' },
    entities: STRING_ARRAY,
    aliases: STRING_ARRAY,
    unresolvedThreads: STRING_ARRAY,
  },
};

export const EXTRACTION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'episodes',
    'stateFacts',
    'relationships',
    'commitments',
    'revelations',
    'clues',
  ],
  properties: {
    episodes: { type: 'array', maxItems: 12, items: EPISODE_SCHEMA },
    stateFacts: { type: 'array', maxItems: 12, items: STATE_FACT_SCHEMA },
    relationships: { type: 'array', maxItems: 12, items: RELATIONSHIP_SCHEMA },
    commitments: { type: 'array', maxItems: 12, items: COMMITMENT_SCHEMA },
    revelations: { type: 'array', maxItems: 12, items: REVELATION_SCHEMA },
    clues: { type: 'array', maxItems: 12, items: CLUE_SCHEMA },
  },
};
