import { describe, expect, it } from 'vitest';
import {
  isInternalGeneration,
  isInternalGenerationRequest,
  markInternalGenerationRequest,
  withInternalGeneration,
} from '../src/llm/internal-generation';

describe('internal generation request identity', () => {
  it('recognizes the marked raw request without hiding a concurrent real user request', async () => {
    const marked = markInternalGenerationRequest('extract system', 'extract prompt');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = withInternalGeneration(marked, async () => gate);

    expect(isInternalGeneration()).toBe(true);
    expect(isInternalGenerationRequest([
      { is_user: false, is_system: true, mes: marked.systemPrompt },
      { is_user: true, mes: marked.prompt },
    ])).toBe(true);
    expect(isInternalGenerationRequest([
      { is_user: false, mes: '角色回复' },
      { is_user: true, mes: '真实的新用户输入' },
    ])).toBe(false);

    release();
    await operation;
    expect(isInternalGeneration()).toBe(false);
  });
});
