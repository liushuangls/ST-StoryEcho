import { describe, expect, it } from 'vitest';
import {
  currentStoryPhaseStart,
  firstStoryPhaseBoundary,
  scopeMemoriesToCurrentStoryPhase,
} from '../src/retrieval/story-phase';
import { memory } from './fixtures';

const chat = [
  { is_user: true, mes: '雾港篇章里发现了蓝蜡封印。' },
  { is_user: false, mes: '蓝蜡封印已收进雾港保管室。' },
  { is_user: true, mes: '雾港篇章已经结束，接下来进入全新的雪原篇章。' },
  { is_user: false, mes: '雪原篇章里发现一双蓝手套。' },
  { is_user: true, mes: '核对蓝手套和M-7的当前事实。' },
];

describe('story-phase-aware recall scope', () => {
  it('isolates an earlier story phase and prevents a reused entity code from bridging', () => {
    const oldWax = memory({
      id: 'old-wax',
      source: { startMessageId: 0, endMessageId: 1, sourceHash: 'old-wax' },
      entities: ['蓝蜡封印'],
      aliases: [],
      stateChanges: [],
    });
    const oldM7 = memory({
      id: 'old-m7',
      source: { startMessageId: 0, endMessageId: 1, sourceHash: 'old-m7' },
      entities: ['雾港篇章文件M-7'],
      aliases: ['M-7'],
      stateChanges: [],
    });
    const currentM7 = memory({
      id: 'current-m7',
      source: { startMessageId: 2, endMessageId: 3, sourceHash: 'current-m7' },
      entities: ['雪原篇章样本M-7'],
      aliases: ['M-7'],
      stateChanges: [],
    });

    const scoped = scopeMemoriesToCurrentStoryPhase(
      [oldWax, oldM7, currentM7],
      chat,
      4,
    );

    expect(scoped.boundaryMessageId).toBe(2);
    expect(scoped.memories.map((item) => item.id)).toEqual(['current-m7']);
    expect(scoped.excludedMemoryIds.sort()).toEqual(['old-m7', 'old-wax']);
  });

  it('keeps a specifically named older entity when the current phase has no same entity', () => {
    const older = memory({
      id: 'old-watch',
      source: { startMessageId: 0, endMessageId: 1, sourceHash: 'old-watch' },
      entities: ['银壳怀表Q-2'],
      aliases: ['Q-2'],
      stateChanges: [],
    });
    const messages = [
      ...chat.slice(0, 4),
      { is_user: true, mes: '顺便回忆Q-2交给了谁。' },
    ];

    expect(scopeMemoriesToCurrentStoryPhase([older], messages, 4).memories).toEqual([older]);
  });

  it('keeps pinned/manual global facts and bypasses isolation for an earlier-phase query', () => {
    const pinned = memory({
      id: 'pinned',
      pinned: true,
      source: { startMessageId: 0, endMessageId: 1, sourceHash: 'pinned' },
    });
    const ordinary = memory({
      id: 'ordinary',
      source: { startMessageId: 0, endMessageId: 1, sourceHash: 'ordinary' },
    });
    const manual = memory({
      id: 'manual',
      manuallyEdited: true,
      source: { startMessageId: 0, endMessageId: 1, sourceHash: 'manual' },
    });
    const earlierQuery = [
      ...chat.slice(0, 4),
      { is_user: true, mes: '回顾上一段剧情的关键线索和结论。' },
    ];

    expect(scopeMemoriesToCurrentStoryPhase([pinned, manual, ordinary], chat, 4).memories)
      .toEqual([pinned, manual]);
    expect(scopeMemoriesToCurrentStoryPhase([pinned, manual, ordinary], earlierQuery, 4).memories)
      .toEqual([pinned, manual, ordinary]);
  });

  it.each([
    '第一章到此结束，第二章现在开始。',
    '旧任务已经完成，现在开始一个全新的独立任务。',
    '这段冒险告一段落，接下来开启新的旅程。',
    '上一段故事线已经收尾，随后转入另一段主线。',
    '我们现在开始一个全新的雪原篇章。',
    '全新的雪原篇章正式开始。',
    '我们开始一个全新的独立任务。',
    '当前委托完成了，随后承接一项新的委托。',
    '上一案已经结束，接下来接手一宗新案。',
  ])('recognizes an explicit transition across genres: %s', (message) => {
    expect(currentStoryPhaseStart([
      { is_user: true, mes: message },
      { is_user: false, mes: '新的阶段继续推进。' },
    ], 1)).toBe(0);
  });

  it.each([
    '我们在旧街发现了一条新线索。',
    '第二天一早，众人离开旅店前往车站。',
    '主线暂时没有进展，于是先处理一项支线活动。',
    '我们开始一个新的支线任务，但原本的主线仍在继续。',
    '这是一个新的支线任务，原本的主线仍在继续。',
  ])('does not treat ordinary narrative progress as a boundary: %s', (message) => {
    expect(currentStoryPhaseStart([
      { is_user: true, mes: message },
      { is_user: false, mes: '继续。' },
    ], 1)).toBeNull();
  });

  it('does not treat a hypothetical future transition as already happened', () => {
    expect(currentStoryPhaseStart([
      { is_user: true, mes: '如果这段旅程结束，我们再进入新的篇章。' },
      { is_user: false, mes: '先处理眼前的事情。' },
    ], 1)).toBeNull();
  });

  it('does not treat a negated transition as an already completed boundary', () => {
    expect(currentStoryPhaseStart([
      { is_user: true, mes: '上一段剧情还没有结束，不要开始新的篇章。' },
      { is_user: false, mes: '继续当前阶段。' },
    ], 1)).toBeNull();
  });

  it('only accepts a User-authored phase boundary', () => {
    expect(currentStoryPhaseStart([
      { is_user: false, mes: '上一段剧情已经结束，现在进入全新的篇章。' },
      { is_user: true, mes: '继续当前内容。' },
    ], 1)).toBeNull();
  });

  it('finds the first explicit boundary inside a planned batch', () => {
    expect(firstStoryPhaseBoundary([
      { is_user: true, mes: '上一段剧情已经结束，现在开始新的篇章。' },
      { is_user: false, mes: '新篇章开始。' },
      { is_user: true, mes: '第一章结束，第二章现在开始。' },
      { is_user: false, mes: '第二章开始。' },
    ], 0, 3)).toBe(0);
    expect(firstStoryPhaseBoundary([
      { is_user: false, mes: '普通回复。' },
      { is_user: true, mes: '普通推进。' },
      { is_user: true, mes: '第一章结束，第二章现在开始。' },
    ], 1, 2)).toBe(2);
    expect(firstStoryPhaseBoundary([
      { is_user: true, mes: '第一章结束，第二章现在开始。' },
    ], 1, 0)).toBeNull();
  });
});
