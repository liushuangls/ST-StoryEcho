import { describe, expect, it } from 'vitest';
import { applyConsolidationDecisions } from '../src/consolidation/apply';
import {
  fallbackConsolidationDecisions,
  parseConsolidationResponse,
} from '../src/consolidation/parser';
import { shortlistMemories } from '../src/consolidation/shortlist';
import { candidate, chatState, memory } from './fixtures';

describe('event consolidation', () => {
  it('shortlists memories sharing the same state slot without vector search', () => {
    const oldMemory = memory();
    const result = shortlistMemories([
      candidate({
        stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '用户' }],
      }),
    ], [oldMemory], new Set());

    expect(result.map((item) => item.id)).toEqual(['mem-1']);
  });

  it('falls back to SUPERSEDE when a state slot receives a different value', () => {
    const decisions = fallbackConsolidationDecisions([
      candidate({
        event: '林雨把银色钥匙交给用户',
        stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '用户' }],
        retrievalText: '银色钥匙现在由用户持有。',
        injectionText: '后来，林雨把银色钥匙交给了用户。',
      }),
    ], [memory()]);

    expect(decisions[0]).toMatchObject({ operation: 'SUPERSEDE', targetMemoryId: 'mem-1' });
  });

  it('does not let a bare Assistant-only contradiction supersede an explicit User fact', () => {
    const explicit = memory({ evidenceRole: 'user' });
    const hallucination = candidate({
      evidenceRole: 'assistant',
      sourceMessageIds: [10],
      event: '银色钥匙当前在陌生人手中。',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '', after: '陌生人' }],
      retrievalText: '银色钥匙当前由陌生人持有。',
      injectionText: '银色钥匙现在由陌生人持有。',
    });

    expect(fallbackConsolidationDecisions([hallucination], [explicit])[0]).toMatchObject({
      operation: 'IGNORE',
      targetMemoryId: 'mem-1',
    });
  });

  it('lets a later Assistant-authored transition advance an explicit User state', () => {
    const explicit = memory({ evidenceRole: 'user' });
    const transition = candidate({
      evidenceRole: 'assistant',
      sourceMessageIds: [10],
      event: '陌生人从林雨手中偷走了银色钥匙。',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '陌生人' }],
      retrievalText: '陌生人后来从林雨手中偷走银色钥匙。',
      injectionText: '银色钥匙已被陌生人偷走。',
    });

    expect(fallbackConsolidationDecisions([transition], [explicit])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it('enforces User authority again when applying a model-provided decision', async () => {
    const state = chatState([memory({ evidenceRole: 'user' })]);
    const hallucination = candidate({
      evidenceRole: 'assistant',
      sourceMessageIds: [10],
      event: '银色钥匙当前在陌生人手中。',
      cause: '',
      consequence: '',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '', after: '陌生人' }],
      retrievalText: '银色钥匙当前由陌生人持有。',
      injectionText: '银色钥匙现在由陌生人持有。',
    });
    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
      reason: '模型误判。',
      result: hallucination,
    }], { startMessageId: 10, endMessageId: 11, sourceHash: 'assistant-output' });

    expect(result.decisions[0]?.operation).toBe('IGNORE');
    expect(state.memories).toHaveLength(1);
    expect(state.memories[0]?.status).toBe('active');
  });

  it('does not re-block an explicit later Assistant transition while applying it', async () => {
    const state = chatState([memory({ evidenceRole: 'user' })]);
    const transition = candidate({
      evidenceRole: 'assistant',
      sourceMessageIds: [10],
      event: '陌生人从林雨手中夺走银色钥匙。',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '陌生人' }],
      retrievalText: '陌生人后来夺走银色钥匙。',
    });
    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
      reason: '明确发生了后续转移。',
      result: transition,
    }], { startMessageId: 10, endMessageId: 10, sourceHash: 'assistant-transition' });

    expect(result.decisions[0]?.operation).toBe('SUPERSEDE');
    expect(state.memories.find((item) => item.id === 'mem-1')?.status).toBe('superseded');
    expect(state.memories.find((item) => item.status === 'active')?.stateChanges[0]?.after)
      .toBe('陌生人');
  });

  it('lets a later explicit User fact supersede an Assistant-authored state', () => {
    const narration = memory({ evidenceRole: 'assistant' });
    const correction = candidate({
      evidenceRole: 'user',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '用户' }],
      retrievalText: '银色钥匙实际由用户持有。',
      injectionText: '用户确认银色钥匙由自己持有。',
    });

    expect(fallbackConsolidationDecisions([correction], [narration])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it('does not freeze a legacy fact whose evidence role is unknown', () => {
    const legacy = memory({ evidenceRole: 'unknown' });
    const narration = candidate({
      evidenceRole: 'assistant',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '顾青' }],
      retrievalText: '银色钥匙现在由顾青持有。',
    });

    expect(fallbackConsolidationDecisions([narration], [legacy])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it.each([
    ['位置', '存放地点'],
    ['持有者', '保管人'],
    ['持有者', '保管状态'],
    ['知情者', '知情范围'],
    ['传言状态', '核验结果'],
  ])('normalizes %s and %s into the same state category', (oldAttribute, newAttribute) => {
    const old = memory({
      stateChanges: [{ entity: '同一完整实体', attribute: oldAttribute, after: '旧值' }],
    });
    const next = candidate({
      event: '同一完整实体发生了新的状态变化。',
      stateChanges: [{
        entity: '同一完整实体',
        attribute: newAttribute,
        before: '旧值',
        after: '新值',
      }],
      retrievalText: `同一完整实体的${newAttribute}现在是新值。`,
      injectionText: '同一完整实体的状态已经变成新值。',
    });

    expect(fallbackConsolidationDecisions([next], [old])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it('accepts a valid LLM merge decision', () => {
    const next = candidate({ consequence: '她答应暂时不用它。' });
    const raw = JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'MERGE',
        targetMemoryId: 'mem-1',
        reason: '同一把钥匙的互补事实。',
      }],
    });

    expect(parseConsolidationResponse(raw, [next], [memory()])[0]).toMatchObject({
      operation: 'MERGE',
      targetMemoryId: 'mem-1',
      reason: '同一把钥匙的互补事实。',
    });
  });

  it('normalizes a descriptive name and its stable code into the same state subject', () => {
    const old = memory({
      stateChanges: [{ entity: '真月桂铜印R-1', attribute: '保管人', after: '苏格兰场S9证物柜' }],
    });
    const next = candidate({
      event: 'R-1已经移交给哈丽雅特·莫斯保管。',
      stateChanges: [{
        entity: 'R-1',
        attribute: '持有者',
        before: '苏格兰场S9证物柜',
        after: '哈丽雅特·莫斯',
      }],
      retrievalText: 'R-1当前由哈丽雅特·莫斯保管。',
    });

    expect(fallbackConsolidationDecisions([next], [old])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it('keeps stable-code identity when an ordinary object name contains a connective character', () => {
    const old = memory({
      stateChanges: [{ entity: '和氏璧R-1', attribute: '持有者', after: '雷斯垂德' }],
    });
    const next = candidate({
      stateChanges: [{ entity: 'R-1', attribute: '保管人', before: '雷斯垂德', after: '哈丽雅特·莫斯' }],
      retrievalText: 'R-1当前由哈丽雅特·莫斯保管。',
    });

    expect(fallbackConsolidationDecisions([next], [old])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it('does not collapse different relationship pairs merely because both mention the same code', () => {
    const old = memory({
      type: 'relationship_change',
      entities: ['陌白', '真月桂铜印R-1'],
      stateChanges: [{
        entity: '陌白与真月桂铜印R-1',
        attribute: '信任关系',
        after: '陌白信任R-1的鉴定结果',
      }],
    });
    const next = candidate({
      type: 'relationship_change',
      event: '福尔摩斯仍怀疑R-1的鉴定结果。',
      entities: ['福尔摩斯', 'R-1'],
      stateChanges: [{
        entity: '福尔摩斯与R-1',
        attribute: '信任关系',
        before: '',
        after: '福尔摩斯怀疑R-1的鉴定结果',
      }],
      retrievalText: '福尔摩斯仍怀疑R-1的鉴定结果。',
    });

    expect(fallbackConsolidationDecisions([next], [old])[0]?.operation).toBe('CREATE');
  });

  it('rejects an LLM merge across independent plot episodes that deterministic matching keeps separate', () => {
    const old = memory({
      type: 'event',
      event: '陌白和福尔摩斯在泰晤士河下水渠追捕灰帽男人。',
      scene: { location: '泰晤士河下水渠', time: '', participants: ['陌白', '福尔摩斯', '华生'] },
      entities: ['陌白', '福尔摩斯', '华生', '灰帽男人', '泰晤士河下水渠'],
      aliases: [],
      stateChanges: [],
      retrievalText: '陌白和福尔摩斯在下水渠追捕灰帽男人。',
      injectionText: '两人在泰晤士河下水渠追捕灰帽男人。',
    });
    const separate = candidate({
      type: 'event',
      event: '陌白和福尔摩斯在博物馆核验真月桂铜印R-1。',
      scene: { location: '大英博物馆', time: '', participants: ['陌白', '福尔摩斯', '华生'] },
      entities: ['陌白', '福尔摩斯', '华生', '真月桂铜印R-1', '大英博物馆'],
      aliases: ['R-1'],
      stateChanges: [],
      retrievalText: '陌白和福尔摩斯在博物馆确认R-1为真品。',
      injectionText: '两人在大英博物馆确认R-1为真品。',
    });
    const raw = JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'MERGE',
        targetMemoryId: 'mem-1',
        reason: '参与者相同，合并为一条主线。',
      }],
    });

    expect(fallbackConsolidationDecisions([separate], [old])[0]?.operation).toBe('CREATE');
    expect(parseConsolidationResponse(raw, [separate], [old])[0]).toMatchObject({
      operation: 'CREATE',
      reason: '没有可确定关联的旧记忆。',
    });
  });

  it('keeps different-location episodes separate even when a model omits participant metadata', () => {
    const old = memory({
      type: 'event',
      scene: { location: '泰晤士河下水渠', time: '', participants: [] },
      event: '陌白和福尔摩斯在泰晤士河下水渠追捕灰帽男人。',
      entities: ['陌白', '福尔摩斯', '灰帽男人', '泰晤士河下水渠'],
      aliases: [],
      stateChanges: [],
      retrievalText: '陌白和福尔摩斯在下水渠追捕灰帽男人。',
    });
    const next = candidate({
      type: 'event',
      scene: { location: '大英博物馆', time: '', participants: [] },
      event: '陌白和福尔摩斯在大英博物馆核验一枚古币。',
      entities: ['陌白', '福尔摩斯', '古币', '大英博物馆'],
      aliases: [],
      stateChanges: [],
      retrievalText: '陌白和福尔摩斯在博物馆核验古币。',
    });

    expect(fallbackConsolidationDecisions([next], [old])[0]?.operation).toBe('CREATE');
  });

  it('does not let consolidation silently discard an accepted independent candidate', () => {
    const independent = candidate({
      type: 'clue',
      event: '陌白发现G17证物袋封口有一道新划痕。',
      entities: ['陌白', 'G17证物袋'],
      aliases: ['G17'],
      stateChanges: [],
      retrievalText: 'G17证物袋封口存在一道新划痕。',
      injectionText: '陌白发现G17证物袋封口有一道新划痕。',
    });
    const raw = JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'IGNORE',
        targetMemoryId: '',
        reason: '模型误判为不重要。',
      }],
    });

    expect(fallbackConsolidationDecisions([independent], [memory()])[0]?.operation).toBe('CREATE');
    expect(parseConsolidationResponse(raw, [independent], [memory()])[0]?.operation).toBe('CREATE');
  });

  it('rejects incomplete or malformed LLM actions so the structured layer can retry', () => {
    const next = candidate();
    expect(() => parseConsolidationResponse(
      JSON.stringify({ actions: [] }),
      [next],
      [memory()],
    )).toThrow(/各返回一次动作/);
    expect(() => parseConsolidationResponse(JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'MERGE',
        targetMemoryId: 'missing-memory',
        reason: '错误目标',
      }],
    }), [next], [memory()])).toThrow(/无效目标/);
  });

  it('ignores a model-supplied rewritten result and derives merged facts locally', () => {
    const next = candidate({ consequence: '林雨答应暂时保管银色钥匙。' });
    const raw = JSON.stringify({
      actions: [{
        candidateIndex: 0,
        operation: 'MERGE',
        targetMemoryId: 'mem-1',
        reason: '同一把钥匙的互补事实。',
        result: candidate({
          event: '不存在的人把钥匙扔进了海里',
          consequence: '银色钥匙已经沉入海底。',
          retrievalText: '银色钥匙在海底。',
          injectionText: '银色钥匙已经沉入海底。',
        }),
      }],
    });

    const decision = parseConsolidationResponse(raw, [next], [memory()])[0];
    expect(decision?.result.event).toBe('林雨获得银色钥匙');
    expect(decision?.result.consequence).toBe('林雨答应暂时保管银色钥匙。');
    expect(decision?.result.retrievalText).not.toContain('海底');
  });

  it('supersedes a moved secret location even when the model omitted stateChanges', () => {
    const old = memory({
      type: 'event',
      event: '刘爽和顾青把银钥匙藏在暮钟旅店肖像后的暗格。',
      entities: ['刘爽', '顾青', '银钥匙', '暮钟旅店'],
      aliases: [],
      stateChanges: [],
      retrievalText: '银钥匙藏在暮钟旅店肖像后的暗格，顾青知情。',
      injectionText: '银钥匙原本藏在暮钟旅店肖像后的暗格。',
    });
    const moved = candidate({
      type: 'event',
      event: '刘爽和顾青把银钥匙从暮钟旅店取出，转移到钟表铺地下室的红色铁盒。',
      entities: ['刘爽', '顾青', '银钥匙', '暮钟旅店', '红色铁盒'],
      aliases: [],
      stateChanges: [],
      retrievalText: '银钥匙已从暮钟旅店暗格转移到红色铁盒，旧暗格已为空。',
      injectionText: '银钥匙现在位于红色铁盒，暮钟旅店旧暗格已为空。',
    });

    expect(fallbackConsolidationDecisions([moved], [old])[0]).toMatchObject({
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
    });
  });

  it('merges a complementary confirmation into an existing moved-location fact', () => {
    const moved = memory({
      type: 'event',
      event: '银钥匙从暮钟旅店转移到红色铁盒。',
      entities: ['顾青', '银钥匙', '暮钟旅店', '红色铁盒'],
      aliases: [],
      stateChanges: [],
      retrievalText: '银钥匙已转移到红色铁盒，暮钟旅店旧暗格已为空。',
      injectionText: '银钥匙现在位于红色铁盒，旧暗格已为空。',
      consequence: '银钥匙当前位于青石镇钟表铺地下室的红色铁盒。',
    });
    const confirmation = candidate({
      type: 'state_change',
      event: '顾青锁好红色铁盒，并确认暮钟旅店旧暗格已经没有钥匙。',
      entities: ['顾青', '银钥匙', '暮钟旅店', '红色铁盒'],
      aliases: [],
      stateChanges: [],
      retrievalText: '顾青锁好红色铁盒，暮钟旅店旧暗格已经没有银钥匙。',
      injectionText: '顾青锁好红色铁盒，旧暗格已经没有银钥匙。',
      consequence: '红色铁盒已锁好，暮钟旅店旧暗格已经没有银钥匙。',
    });

    const decision = fallbackConsolidationDecisions([confirmation], [moved])[0];
    expect(decision).toMatchObject({
      operation: 'MERGE',
      targetMemoryId: 'mem-1',
    });
    expect(decision?.result.consequence).toContain('青石镇钟表铺地下室');
    expect(decision?.result.consequence).toContain('旧暗格已经没有银钥匙');
  });

  it('accepts common schema aliases but overrides a duplicate CREATE with deterministic MERGE', () => {
    const old = memory({
      stateChanges: [],
      entities: ['顾青', '银钥匙', '暮钟旅店'],
      aliases: [],
      event: '顾青把银钥匙藏在暮钟旅店暗格。',
      retrievalText: '顾青把银钥匙藏在暮钟旅店暗格。',
      injectionText: '银钥匙藏在暮钟旅店暗格。',
    });
    const repeated = candidate({
      stateChanges: [],
      entities: ['顾青', '银钥匙', '暮钟旅店'],
      aliases: [],
      event: '顾青确认银钥匙仍藏在暮钟旅店暗格。',
      retrievalText: '顾青确认银钥匙仍藏在暮钟旅店暗格。',
      injectionText: '顾青确认银钥匙仍在暮钟旅店暗格。',
    });
    const raw = JSON.stringify({
      decisions: [{
        candidate_index: 0,
        action: 'create',
        target_memory_id: '',
        rationale: '模型误判为新事件。',
      }],
    });

    expect(parseConsolidationResponse(raw, [repeated], [old])[0]).toMatchObject({
      operation: 'MERGE',
      targetMemoryId: 'mem-1',
    });
  });

  it('supersedes the old memory and queues vector replacement', async () => {
    const state = chatState([memory()]);
    const next = candidate({
      event: '林雨把银色钥匙交给用户',
      stateChanges: [{ entity: '银色钥匙', attribute: '持有者', before: '林雨', after: '用户' }],
      retrievalText: '银色钥匙现在由用户持有。',
      injectionText: '后来，用户从林雨手中接过银色钥匙。',
    });

    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
      reason: '持有者发生变化。',
      result: next,
    }], { startMessageId: 10, endMessageId: 11, sourceHash: 'source-2' });

    expect(state.memories[0]?.status).toBe('superseded');
    expect(state.memories[0]?.replacedByMemoryId).toBe(result.created[0]?.id);
    expect(result.created[0]?.supersedesMemoryIds).toContain('mem-1');
    expect(result.created[0]?.status).toBe('active');
    expect(state.pendingVectorDeleteHashes).toEqual([123]);
    expect(state.pendingVectorHashes).toEqual([result.created[0]?.vectorHash]);
    expect(state.metrics.actions.SUPERSEDE).toBe(1);
  });

  it('re-derives a replacement logical key instead of inheriting an unrelated commitment key', async () => {
    const old = memory({
      logicalKey: 'commitment:刘爽虞汐玄纹玉简保密承诺',
      type: 'commitment',
      stateChanges: [
        { entity: '刘爽虞汐玄纹玉简保密承诺', attribute: '完成状态', after: '未完成' },
        { entity: '玄纹玉简', attribute: '保管者', after: '虞汐' },
      ],
    });
    const state = chatState([old]);
    const replacement = candidate({
      entities: ['玄纹玉简', '刘爽'],
      aliases: [],
      stateChanges: [{ entity: '玄纹玉简', attribute: '持有者', before: '虞汐', after: '刘爽' }],
      retrievalText: '玄纹玉简当前由刘爽持有。',
    });

    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
      reason: '持有者变化。',
      result: replacement,
    }], { startMessageId: 10, endMessageId: 11, sourceHash: 'replacement' });

    expect(result.created[0]?.logicalKey).toBe('holder:玄纹玉简');
  });

  it('preserves an unrelated fact from a legacy composite memory during partial supersede', async () => {
    const composite = memory({
      type: 'revelation',
      event: '琥珀戒指和银铃的位置都已确认。',
      entities: ['琥珀戒指', '白塔药铺', '银铃', '北境白塔'],
      aliases: [],
      stateChanges: [],
      retrievalText: '琥珀戒指位于白塔药铺前厅掌柜抽屉；银铃位于北境白塔顶层悬挂。',
      injectionText: '白塔药铺的琥珀戒指在抽屉，北境白塔的银铃在顶层。',
    });
    const state = chatState([composite]);
    const movedRing = candidate({
      type: 'state_change',
      scene: { location: '白塔药铺后院保险柜', time: '', participants: [] },
      event: '琥珀戒指移到白塔药铺后院保险柜。',
      entities: ['琥珀戒指', '白塔药铺'],
      aliases: [],
      stateChanges: [{
        entity: '琥珀戒指',
        attribute: '位置',
        before: '白塔药铺前厅掌柜抽屉',
        after: '白塔药铺后院保险柜',
      }],
      retrievalText: '琥珀戒指现在位于白塔药铺后院保险柜。',
      injectionText: '琥珀戒指已移到白塔药铺后院保险柜。',
    });

    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'SUPERSEDE',
      targetMemoryId: 'mem-1',
      reason: '戒指位置变化。',
      result: movedRing,
    }], { startMessageId: 10, endMessageId: 11, sourceHash: 'source-ring-move' });

    expect(composite.status).toBe('superseded');
    expect(result.created).toHaveLength(2);
    const activeTexts = state.memories
      .filter((item) => item.status === 'active')
      .map((item) => item.retrievalText);
    expect(activeTexts).toContain('琥珀戒指现在位于白塔药铺后院保险柜。');
    expect(activeTexts).toContain('银铃位于北境白塔顶层悬挂');
    expect(state.pendingVectorDeleteHashes).toEqual([123]);
    expect(state.pendingVectorHashes).toHaveLength(2);
  });

  it.each([
    ['MERGE', 'active'],
    ['UPDATE', 'active'],
    ['RESOLVE', 'resolved'],
  ] as const)('applies %s in place and reindexes changed retrieval text', async (operation, status) => {
    const state = chatState([memory()]);
    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation,
      targetMemoryId: 'mem-1',
      reason: '同一事件的后续信息。',
      result: candidate({
        event: '钥匙事件有了后续',
        retrievalText: `钥匙事件${operation}后的完整检索事实。`,
        injectionText: `钥匙事件已经${operation}。`,
      }),
    }], { startMessageId: 8, endMessageId: 9, sourceHash: `source-${operation}` });

    expect(state.memories).toHaveLength(1);
    expect(state.memories[0]).toMatchObject({ id: 'mem-1', status, lastOperation: operation });
    expect(state.memories[0]?.sourceHistory).toHaveLength(2);
    expect(state.pendingVectorDeleteHashes).toEqual([123]);
    expect(state.pendingVectorHashes).toEqual([state.memories[0]?.vectorHash]);
    expect(state.metrics.actions[operation]).toBe(1);
    expect(result.changed).toHaveLength(1);
  });

  it('does not carry a completed thread back into a resolved memory', async () => {
    const state = chatState([memory({
      type: 'commitment',
      unresolvedThreads: ['林雨是否会归还银色钥匙？'],
    })]);

    await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'RESOLVE',
      targetMemoryId: 'mem-1',
      reason: '钥匙已经归还。',
      result: candidate({
        type: 'commitment',
        event: '林雨已经归还银色钥匙。',
        unresolvedThreads: [],
      }),
    }], { startMessageId: 10, endMessageId: 11, sourceHash: 'source-resolved' });

    expect(state.memories[0]).toMatchObject({ status: 'resolved', unresolvedThreads: [] });
  });

  it('applies IGNORE without changing memory or vector queues', async () => {
    const oldMemory = memory();
    const state = chatState([oldMemory]);
    await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'IGNORE',
      targetMemoryId: 'mem-1',
      reason: '完全重复。',
      result: candidate(),
    }], { startMessageId: 8, endMessageId: 9, sourceHash: 'source-ignore' });

    expect(state.memories).toEqual([oldMemory]);
    expect(state.pendingVectorDeleteHashes).toEqual([]);
    expect(state.pendingVectorHashes).toEqual([]);
    expect(state.metrics.actions.IGNORE).toBe(1);
  });

  it('protects manually edited memories by conservatively creating a new one', async () => {
    const state = chatState([memory({ manuallyEdited: true })]);
    const next = candidate({ retrievalText: '更新后的钥匙事实。' });
    const result = await applyConsolidationDecisions(state, [{
      candidateIndex: 0,
      operation: 'UPDATE',
      targetMemoryId: 'mem-1',
      reason: '模型尝试更新。',
      result: next,
    }], { startMessageId: 12, endMessageId: 13, sourceHash: 'source-3' });

    expect(state.memories).toHaveLength(2);
    expect(state.memories[0]?.manuallyEdited).toBe(true);
    expect(result.decisions[0]?.operation).toBe('CREATE');
    expect(state.metrics.actions.CREATE).toBe(1);
  });

  it('can ignore an exact duplicate of a manually edited memory without modifying it', () => {
    const manual = memory({ manuallyEdited: true });
    const candidates = [candidate()];
    const shortlist = shortlistMemories(candidates, [manual], new Set());
    const decisions = fallbackConsolidationDecisions(candidates, shortlist);

    expect(shortlist).toEqual([manual]);
    expect(decisions[0]?.operation).toBe('IGNORE');
  });

  it('supersedes every stale memory in the same canonical state slot without crossing same-name entities', async () => {
    const olderRing = memory({
      id: 'ring-old-a',
      logicalKey: 'location:琥珀戒指',
      vectorHash: 201,
      type: 'state_change',
      event: '琥珀戒指位于白塔药铺前厅抽屉。',
      entities: ['琥珀戒指', '白塔药铺'],
      aliases: [],
      stateChanges: [{ entity: '琥珀戒指', attribute: '位置', after: '白塔药铺前厅抽屉' }],
      retrievalText: '琥珀戒指位于白塔药铺前厅抽屉。',
      injectionText: '琥珀戒指位于白塔药铺前厅抽屉。',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const newerDuplicate = memory({
      id: 'ring-old-b',
      logicalKey: 'location:琥珀戒指',
      vectorHash: 202,
      type: 'state_change',
      event: '琥珀戒指后来仍存放在白塔药铺前厅抽屉。',
      entities: ['琥珀戒指', '白塔药铺'],
      aliases: [],
      stateChanges: [{ entity: '琥珀戒指的存放地点', attribute: '存放地点', after: '白塔药铺前厅抽屉' }],
      retrievalText: '琥珀戒指当前仍在白塔药铺前厅抽屉。',
      injectionText: '琥珀戒指仍在白塔药铺前厅抽屉。',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const otherWhiteTower = memory({
      id: 'bell-north-tower',
      logicalKey: 'location:银铃',
      vectorHash: 203,
      type: 'state_change',
      event: '银铃位于北境白塔顶层。',
      entities: ['银铃', '北境白塔'],
      aliases: [],
      stateChanges: [{ entity: '银铃', attribute: '位置', after: '北境白塔顶层' }],
      retrievalText: '银铃位于北境白塔顶层。',
      injectionText: '银铃位于北境白塔顶层。',
    });
    const moved = candidate({
      type: 'state_change',
      event: '琥珀戒指移到白塔药铺后院保险柜。',
      entities: ['琥珀戒指', '白塔药铺'],
      aliases: [],
      stateChanges: [{
        entity: '琥珀戒指',
        attribute: '当前位置',
        before: '白塔药铺前厅抽屉',
        after: '白塔药铺后院保险柜',
      }],
      retrievalText: '琥珀戒指当前位于白塔药铺后院保险柜。',
      injectionText: '琥珀戒指已移到白塔药铺后院保险柜。',
    });
    const state = chatState([olderRing, newerDuplicate, otherWhiteTower]);
    const decisions = fallbackConsolidationDecisions(
      [moved],
      [olderRing, newerDuplicate, otherWhiteTower],
    );

    const result = await applyConsolidationDecisions(state, decisions, {
      startMessageId: 20,
      endMessageId: 21,
      sourceHash: 'ring-new-source',
    });

    expect(olderRing.status).toBe('superseded');
    expect(newerDuplicate.status).toBe('superseded');
    expect(otherWhiteTower.status).toBe('active');
    expect(result.decisions[0]?.additionalTargetMemoryIds).toEqual(['ring-old-a']);
    expect(state.memories.filter((item) => (
      item.status === 'active' && item.logicalKey === 'location:琥珀戒指'
    ))).toHaveLength(1);
    expect(state.pendingVectorDeleteHashes).toEqual(expect.arrayContaining([201, 202]));
  });

  it('uses one stable commitment key, resolves it once, and supersedes active duplicates', async () => {
    const promiseEntity = '苏棠向顾青递送青色密函的承诺';
    const first = memory({
      id: 'promise-a',
      logicalKey: `commitment:${promiseEntity}`,
      vectorHash: 301,
      type: 'commitment',
      event: '苏棠承诺把青色密函送给顾青。',
      entities: ['苏棠', '顾青', '青色密函'],
      aliases: [],
      stateChanges: [{ entity: promiseEntity, attribute: '完成状态', after: '未完成' }],
      unresolvedThreads: ['苏棠是否会把青色密函送给顾青？'],
      retrievalText: '苏棠向顾青递送青色密函的承诺尚未完成。',
      injectionText: '苏棠承诺把青色密函送给顾青，该承诺尚未完成。',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const duplicate = memory({
      id: 'promise-b',
      logicalKey: `commitment:${promiseEntity}`,
      vectorHash: 302,
      type: 'commitment',
      event: '苏棠再次确认会递送青色密函。',
      entities: ['苏棠', '顾青', '青色密函'],
      aliases: [],
      stateChanges: [{ entity: promiseEntity, attribute: '承诺状态', after: '待履行' }],
      unresolvedThreads: ['青色密函仍待递送。'],
      retrievalText: '苏棠向顾青递送青色密函的承诺仍待履行。',
      injectionText: '苏棠递送青色密函的承诺仍待履行。',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const completed = candidate({
      type: 'commitment',
      event: '苏棠已按约把青色密函交给顾青。',
      entities: ['苏棠', '顾青', '青色密函'],
      aliases: [],
      stateChanges: [{
        entity: promiseEntity,
        attribute: '履行状态',
        before: '待履行',
        after: '已完成',
      }],
      unresolvedThreads: [],
      retrievalText: '苏棠向顾青递送青色密函的承诺已经完成。',
      injectionText: '苏棠已按约把青色密函交给顾青，承诺已经完成。',
    });
    const state = chatState([first, duplicate]);
    const decisions = fallbackConsolidationDecisions([completed], [first, duplicate]);

    expect(decisions[0]).toMatchObject({
      operation: 'RESOLVE',
      targetMemoryId: 'promise-b',
    });
    const result = await applyConsolidationDecisions(state, decisions, {
      startMessageId: 30,
      endMessageId: 31,
      sourceHash: 'promise-completed-source',
    });

    const resolved = state.memories.filter((item) => item.status === 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({
      id: 'promise-b',
      logicalKey: `commitment:${promiseEntity}`,
      unresolvedThreads: [],
    });
    expect(first.status).toBe('superseded');
    expect(first.replacedByMemoryId).toBe('promise-b');
    expect(result.decisions[0]?.additionalTargetMemoryIds).toEqual(['promise-a']);
    expect(state.pendingVectorDeleteHashes).toEqual(expect.arrayContaining([301, 302]));
  });
});
