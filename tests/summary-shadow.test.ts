import { describe, expect, it } from 'vitest';
import { isMemoryInvalidatedByStageSummaries } from '../src/retrieval/summary-shadow';
import { memory } from './fixtures';

function summary(options: { confirmed?: string; current?: string; invalid?: string }): string {
  return [
    '【已确认剧情】',
    options.confirmed ?? '无',
    '【当前状态】',
    options.current ?? '无',
    '【未解决线索】',
    '无',
    '【角色主张与推测】',
    '无',
    '【已失效或否定事实】',
    options.invalid ?? '无',
  ].join('\n');
}

describe('stage-summary state shadow', () => {
  it('invalidates an older structured state explicitly denied by a later summary', () => {
    const stale = memory({
      source: { startMessageId: 10, endMessageId: 11, sourceHash: 'stale' },
      stateChanges: [{ entity: '欧文', attribute: '状态', after: '被收监' }],
    });

    expect(isMemoryInvalidatedByStageSummaries(stale, [{
      text: summary({
        confirmed: '欧文仅被捕。',
        invalid: '欧文被收监的说法未经确认，已经作废。',
      }),
      sourceStartMessageId: 20,
      sourceEndMessageId: 29,
      sourceHash: 'correction',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }])).toBe(true);
  });

  it('allows a still-later confirmed section to re-establish the same state', () => {
    const stale = memory({
      source: { startMessageId: 10, endMessageId: 11, sourceHash: 'stale' },
      stateChanges: [{ entity: '欧文', attribute: '状态', after: '被收监' }],
    });
    const entries = [
      {
        text: summary({ invalid: '欧文被收监的旧说法已经作废。' }),
        sourceStartMessageId: 20,
        sourceEndMessageId: 29,
        sourceHash: 'invalid',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        text: summary({ current: '法院后来正式裁定欧文被收监。' }),
        sourceStartMessageId: 30,
        sourceEndMessageId: 39,
        sourceHash: 'confirmed',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ];

    expect(isMemoryInvalidatedByStageSummaries(stale, entries)).toBe(false);
  });

  it('does not let a second confirmed field clear invalidation of another field in a composite legacy memory', () => {
    const composite = memory({
      source: { startMessageId: 10, endMessageId: 11, sourceHash: 'legacy' },
      stateChanges: [
        { entity: '欧文', attribute: '状态', after: '被收监' },
        { entity: '银钥匙', attribute: '持有者', after: '林雨' },
      ],
    });

    expect(isMemoryInvalidatedByStageSummaries(composite, [{
      text: summary({
        current: '银钥匙仍由林雨持有。',
        invalid: '欧文被收监的说法已经作废。',
      }),
      sourceStartMessageId: 20,
      sourceEndMessageId: 29,
      sourceHash: 'mixed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }])).toBe(true);
  });
});
