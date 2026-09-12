import { isGemini3Model } from './model-family';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keep background summarization from inheriting an expensive role-play preset. */
export function tuneInternalGenerationSettings(value: unknown, model = ''): void {
  if (!isRecord(value)) {
    return;
  }
  if ('reasoning_effort' in value) {
    value['reasoning_effort'] = 'low';
  }
  if ('include_reasoning' in value) {
    value['include_reasoning'] = false;
  }
  if (isRecord(value['thinking']) && 'type' in value['thinking']) {
    value['thinking'] = { ...value['thinking'], type: 'disabled' };
  }
  if ('enable_thinking' in value) {
    value['enable_thinking'] = false;
  }
  const selectedModel = model || (typeof value['model'] === 'string' ? value['model'] : '');
  if (isGemini3Model(selectedModel)) {
    // Gemini 3.x is optimized for its defaults. Let the backend omit these
    // fields instead of forcing the deterministic settings used by other models.
    delete value['temperature'];
    delete value['top_p'];
    delete value['top_k'];
    return;
  }
  if ('temperature' in value) {
    value['temperature'] = 0;
  }
  if ('top_p' in value) {
    value['top_p'] = 1;
  }
}
