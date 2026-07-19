import { describe, expect, it } from 'vitest';
import { parseExtractionResponse } from '../src/extraction/parser';

describe('parseExtractionResponse', () => {
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

  it('drops invalid memory items while keeping the response usable', () => {
    const result = parseExtractionResponse(JSON.stringify({
      memories: [{ type: 'unknown', event: 'x' }],
    }));
    expect(result).toEqual([]);
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
