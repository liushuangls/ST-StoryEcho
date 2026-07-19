import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideConsolidation } from '../src/consolidation/service';
import type { StoryEchoSettings } from '../src/core/types';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { candidate, memory } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('deterministic-first consolidation', () => {
  it('does not call an LLM for a stable state-slot update', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    const result = await decideConsolidation(settings, [candidate({
      type: 'state_change',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '顾青' }],
      retrievalText: '银色钥匙当前由顾青持有。',
      injectionText: '银色钥匙当前由顾青持有。',
    })], [memory()]);

    expect(result.usedLlm).toBe(false);
    expect(result.decisions[0]).toMatchObject({ operation: 'SUPERSEDE', targetMemoryId: 'mem-1' });
  });

  it('sends only ambiguous narrative candidates to the LLM and restores original indices', async () => {
    const settings = structuredClone(DEFAULT_SETTINGS) as StoryEchoSettings;
    const generateRaw = vi.fn().mockResolvedValue(JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'CREATE',
        targetMemoryId: '',
        reason: '独立的新剧情。',
      }],
    }));
    vi.stubGlobal('SillyTavern', { getContext: () => ({ generateRaw }) });
    const stateCandidate = candidate({
      type: 'state_change',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '顾青' }],
      retrievalText: '银色钥匙当前由顾青持有。',
    });
    const episode = candidate({
      type: 'event',
      event: '陌白在码头阻止了一场爆炸。',
      entities: ['陌白', '码头'],
      aliases: [],
      stateChanges: [],
      retrievalText: '陌白在码头阻止爆炸。',
      injectionText: '陌白曾在码头阻止一场爆炸。',
    });

    const result = await decideConsolidation(settings, [stateCandidate, episode], [memory()]);

    expect(result.usedLlm).toBe(true);
    expect(result.decisions.map((decision) => [decision.candidateIndex, decision.operation]))
      .toEqual([[0, 'SUPERSEDE'], [1, 'CREATE']]);
    const prompt = generateRaw.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain('陌白在码头阻止了一场爆炸');
    expect(prompt).not.toContain('银色钥匙当前由顾青持有');
  });
});
