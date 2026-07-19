import { describe, expect, it } from 'vitest';
import { parseExtractionResponse } from '../src/extraction/parser';

describe('parseExtractionResponse', () => {
  it('parses classified extraction output and deterministically renders memory text', () => {
    const result = parseExtractionResponse(JSON.stringify({
      episodes: [{
        sourceMessageIds: [10, 11],
        kind: 'event',
        scene: { location: '煤窖', time: '深夜', participants: ['陌白', '福尔摩斯'] },
        action: '陌白与福尔摩斯取得罗盘和胶片，并离开旧砖洞',
        cause: '两人追查失踪案线索',
        consequence: '两件证物被带走',
        entities: ['陌白', '福尔摩斯', '罗盘', '胶片'],
        aliases: [],
        unresolvedThreads: ['胶片内容尚待冲洗'],
        knownBy: ['陌白', '福尔摩斯'],
        truthStatus: 'confirmed',
        importance: 0.9,
      }],
      stateFacts: [{
        sourceMessageIds: [11],
        scene: { location: '煤窖', time: '深夜', participants: ['陌白'] },
        entity: '罗盘',
        attribute: '持有者',
        before: '旧砖洞',
        after: '陌白',
        aliases: ['星纹罗盘'],
        knownBy: ['陌白', '福尔摩斯'],
        truthStatus: 'confirmed',
        importance: 0.9,
      }],
      relationships: [],
      commitments: [],
      revelations: [],
      clues: [],
    }));

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: 'event',
      event: '陌白与福尔摩斯取得罗盘和胶片，并离开旧砖洞',
      stateChanges: [],
    });
    expect(result[0]?.retrievalText).toContain('地点：煤窖');
    expect(result[1]).toMatchObject({
      type: 'state_change',
      event: '罗盘的持有者由旧砖洞变为陌白',
      stateChanges: [{ entity: '罗盘', attribute: '持有者', before: '旧砖洞', after: '陌白' }],
      injectionText: '罗盘的持有者由旧砖洞变为陌白。',
    });
  });

  it('maps relationship and commitment categories to stable state slots', () => {
    const common = {
      sourceMessageIds: [2],
      scene: { location: '', time: '', participants: [] },
      knownBy: ['陌白'],
      truthStatus: 'confirmed',
      importance: 0.8,
    };
    const result = parseExtractionResponse(JSON.stringify({
      episodes: [],
      stateFacts: [],
      relationships: [{
        ...common,
        leftEntity: '福尔摩斯',
        rightEntity: '陌白',
        relationType: '信任',
        before: '戒备',
        after: '互相信任',
      }],
      commitments: [{
        ...common,
        actor: '陌白',
        beneficiary: '福尔摩斯',
        action: '归还',
        object: '怀表',
        previousStatus: 'pending',
        status: 'completed',
      }],
      revelations: [],
      clues: [],
    }));

    expect(result.map((item) => item.type)).toEqual(['relationship_change', 'commitment']);
    expect(result[0]?.stateChanges[0]).toMatchObject({ attribute: '信任关系', after: '互相信任' });
    expect(result[1]?.stateChanges[0]).toMatchObject({ attribute: '完成状态', before: '未完成', after: '已完成' });
    expect(result[1]?.unresolvedThreads).toEqual([]);
  });

  it('accepts a complete classified response with no memories', () => {
    expect(parseExtractionResponse(JSON.stringify({
      episodes: [],
      stateFacts: [],
      relationships: [],
      commitments: [],
      revelations: [],
      clues: [],
    }))).toEqual([]);
  });

  it('rejects partial or malformed classified output so structured completion can retry', () => {
    expect(() => parseExtractionResponse(JSON.stringify({
      episodes: [],
    }))).toThrow(/stateFacts.*数组/);

    expect(() => parseExtractionResponse(JSON.stringify({
      episodes: [{
        sourceMessageIds: [],
        kind: 'event',
        scene: { location: '', time: '', participants: [] },
        action: '发生了一件事',
        cause: '',
        consequence: '',
        entities: [],
        aliases: [],
        unresolvedThreads: [],
        knownBy: [],
        truthStatus: 'confirmed',
        importance: 0.5,
      }],
      stateFacts: [],
      relationships: [],
      commitments: [],
      revelations: [],
      clues: [],
    }))).toThrow(/episodes\[0\].*结构/);
  });

  it('parses and normalizes valid candidates', () => {
    const result = parseExtractionResponse(`\`\`\`json
      {
        "memories": [{
          "sourceMessageIds": [20, 21, 21],
          "type": "commitment",
          "scene": {"location": "钟楼", "time": "午夜前", "participants": ["林雨", "林雨"]},
          "event": "林雨答应午夜前不使用钥匙",
          "cause": "用户把钥匙交给她保管",
          "consequence": "钥匙暂时由林雨持有",
          "entities": ["林雨", "银色钥匙"],
          "aliases": ["钟楼钥匙"],
          "stateChanges": [{"entity": "银色钥匙", "attribute": "持有人", "before": "用户", "after": "林雨"}],
          "unresolvedThreads": ["林雨是否遵守承诺"],
          "knownBy": ["用户", "林雨"],
          "truthStatus": "confirmed",
          "importance": 1.2,
          "retrievalText": "林雨 银色钥匙 钟楼 承诺 保管",
          "injectionText": "较早时，林雨答应午夜前不会使用银色钥匙。"
        }]
      }
    \`\`\``);

    expect(result).toHaveLength(1);
    expect(result[0]?.importance).toBe(1);
    expect(result[0]?.scene.participants).toEqual(['林雨']);
    expect(result[0]?.sourceMessageIds).toEqual([20, 21]);
  });

  it('rejects a non-empty legacy response with no valid items so completion can retry', () => {
    expect(() => parseExtractionResponse(JSON.stringify({
      memories: [{ type: 'unknown', event: 'x' }],
    }))).toThrow(/没有得到任何合法剧情记忆/);
  });

  it('accepts common schema aliases returned by the main connection', () => {
    const result = parseExtractionResponse(JSON.stringify({
      memories: [{
        type: 'event',
        confirmationLevel: 'confirmed',
        content: '刘爽与沈砚把紫铜罗盘藏进海景画后的暗格',
        knownBy: ['刘爽', '沈砚'],
        retrievalText: '紫铜罗盘 沈砚 海景画 暗格',
        injectionText: '过去，刘爽与沈砚把紫铜罗盘藏进了海景画后的暗格。',
      }],
    }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'event',
      event: '刘爽与沈砚把紫铜罗盘藏进海景画后的暗格',
      truthStatus: 'confirmed',
      scene: { location: '', time: '', participants: [] },
    });
  });

  it('maps a boolean confirmed field when truthStatus is omitted', () => {
    const result = parseExtractionResponse(JSON.stringify({
      memories: [{
        type: 'clue',
        confirmed: true,
        event: '发现旧钟楼暗格',
        retrievalText: '旧钟楼 暗格',
        injectionText: '此前发现了旧钟楼里的暗格。',
      }],
    }));

    expect(result[0]?.truthStatus).toBe('confirmed');
  });

  it('infers a confirmed multi-party event from structured aliases without admitting loose summaries', () => {
    const result = parseExtractionResponse(JSON.stringify({
      memories: [{
        entity: '刘爽',
        action: '藏匿紫铜罗盘',
        objects: ['紫铜罗盘', '海景画后暗格'],
        details: '刘爽与沈砚把紫铜罗盘藏入第四幅海景画后的暗格',
        confirmed: true,
        knownBy: ['刘爽', '沈砚'],
        retrievalText: '紫铜罗盘 沈砚 海景画 暗格',
        injectionText: '你与沈砚把紫铜罗盘藏进了海景画后的暗格。',
      }, {
        retrievalText: '普通渡轮行程',
        injectionText: '此前乘坐过渡轮。',
        knownBy: ['刘爽'],
      }],
    }));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'event',
      truthStatus: 'confirmed',
      event: '刘爽与沈砚把紫铜罗盘藏入第四幅海景画后的暗格',
      entities: ['刘爽', '紫铜罗盘', '海景画后暗格'],
    });
  });

  it('normalizes semantic type and confidence aliases from schema-drifting models', () => {
    const result = parseExtractionResponse(JSON.stringify({
      memories: [{
        type: 'secret',
        confidence: 'confirmed',
        knownBy: ['刘爽', '沈砚'],
        retrievalText: '刘爽与沈砚把北辰纹紫铜罗盘藏在第四幅海景画后的暗格。',
        injectionText: '你和沈砚把北辰纹紫铜罗盘藏在了第四幅海景画后的暗格。',
      }],
    }));

    expect(result[0]).toMatchObject({
      type: 'revelation',
      truthStatus: 'confirmed',
      event: '刘爽与沈砚把北辰纹紫铜罗盘藏在第四幅海景画后的暗格。',
    });
  });

  it('accepts root aliases, bare arrays, and a single candidate object', () => {
    const item = {
      type: 'clue',
      confirmed: true,
      event: '发现旧钟楼暗格',
      retrievalText: '旧钟楼 暗格',
      injectionText: '此前发现了旧钟楼里的暗格。',
    };

    expect(parseExtractionResponse(JSON.stringify({ items: [item] }))).toHaveLength(1);
    expect(parseExtractionResponse(JSON.stringify([item]))).toHaveLength(1);
    expect(parseExtractionResponse(JSON.stringify(item))).toHaveLength(1);
  });

  it('rejects a response without candidates or a candidate array', () => {
    expect(() => parseExtractionResponse('{"message":"none"}')).toThrow(/memories/);
  });
});
