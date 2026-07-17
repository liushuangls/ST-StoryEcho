import { describe, expect, it } from 'vitest';
import { parseExtractionResponse } from '../src/extraction/parser';

describe('parseExtractionResponse', () => {
  it('parses and normalizes valid candidates', () => {
    const result = parseExtractionResponse(`\`\`\`json
      {
        "memories": [{
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
  });

  it('drops invalid memory items while keeping the response usable', () => {
    const result = parseExtractionResponse(JSON.stringify({
      memories: [{ type: 'unknown', event: 'x' }],
    }));
    expect(result).toEqual([]);
  });

  it('rejects a response without a memories array', () => {
    expect(() => parseExtractionResponse('{"items":[]}')).toThrow(/memories/);
  });
});
