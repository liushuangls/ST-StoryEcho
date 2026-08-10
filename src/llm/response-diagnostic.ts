import type {
  LlmResponseDiagnostic,
  LlmResponseValueType,
} from '../core/types';

const MAX_FIELDS_PER_LEVEL = 24;
const MAX_FIELD_NAME_CHARACTERS = 80;
const REASONING_FIELD_PATTERN = /(?:reason|thinking|thought|analysis)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueType(value: unknown, present = true): LlmResponseValueType {
  if (!present) {
    return 'missing';
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value as 'string' | 'number' | 'boolean';
  }
  return 'other';
}

function sanitizeFieldName(key: string, secrets: readonly string[] = []): string {
  return secrets.reduce(
      (sanitized, secret) => secret ? sanitized.split(secret).join('[REDACTED]') : sanitized,
      key.replace(/[\p{Cc}\p{Cf}]/gu, ''),
    ).slice(0, MAX_FIELD_NAME_CHARACTERS);
}

function normalizedFieldNames(value: unknown, secrets: readonly string[] = []): string[] {
  const fields = isRecord(value)
    ? Object.keys(value)
    : Array.isArray(value)
      ? value.filter((field): field is string => typeof field === 'string')
      : [];
  return fields
    .slice(0, MAX_FIELDS_PER_LEVEL)
    .map((key) => sanitizeFieldName(key, secrets))
    .filter(Boolean)
    .sort();
}

function hasReasoningField(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  for (let visited = 0; pending.length > 0 && visited < 500; visited += 1) {
    const current = pending.pop()!;
    if (current.depth > 4 || current.value === null || typeof current.value !== 'object') {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, 50)) {
        if (
          isRecord(item) &&
          typeof item['type'] === 'string' &&
          REASONING_FIELD_PATTERN.test(item['type'])
        ) {
          return true;
        }
        pending.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    for (const [key, child] of Object.entries(current.value).slice(0, 100)) {
      if (REASONING_FIELD_PATTERN.test(key)) {
        return true;
      }
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return false;
}

function propertyType(
  value: Record<string, unknown> | null,
  key: string,
): LlmResponseValueType {
  return value
    ? valueType(value[key], Object.prototype.hasOwnProperty.call(value, key))
    : 'missing';
}

export function responseDiagnosticFromPayload(
  payload: unknown,
  secrets: readonly string[] = [],
): LlmResponseDiagnostic {
  const root = isRecord(payload) ? payload : null;
  const choices = root?.['choices'];
  const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : null;
  const message = choice && isRecord(choice['message']) ? choice['message'] : null;
  return {
    responseType: valueType(payload),
    rootFields: normalizedFieldNames(root, secrets),
    choiceFields: normalizedFieldNames(choice, secrets),
    messageFields: normalizedFieldNames(message, secrets),
    messageContentType: propertyType(message, 'content'),
    choiceTextType: propertyType(choice, 'text'),
    rootContentType: propertyType(root, 'content'),
    hasReasoning: hasReasoningField(payload),
  };
}

function normalizedValueType(value: unknown): LlmResponseValueType {
  return [
    'missing',
    'null',
    'string',
    'array',
    'object',
    'number',
    'boolean',
    'other',
  ].includes(String(value))
    ? value as LlmResponseValueType
    : 'other';
}

export function normalizeLlmResponseDiagnostic(value: unknown): LlmResponseDiagnostic | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    responseType: normalizedValueType(value['responseType']),
    rootFields: normalizedFieldNames(value['rootFields']),
    choiceFields: normalizedFieldNames(value['choiceFields']),
    messageFields: normalizedFieldNames(value['messageFields']),
    messageContentType: normalizedValueType(value['messageContentType']),
    choiceTextType: normalizedValueType(value['choiceTextType']),
    rootContentType: normalizedValueType(value['rootContentType']),
    hasReasoning: value['hasReasoning'] === true,
  };
}
