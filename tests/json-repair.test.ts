import { describe, expect, it } from 'vitest';
import { parseJsonWithLocalRepair } from '../src/llm/json-repair';

describe('local JSON syntax repair', () => {
  it('extracts a fenced value and removes trailing commas without changing fields', () => {
    expect(parseJsonWithLocalRepair('说明：\n```json\n{"query":"银钥匙",}\n```'))
      .toEqual({ query: '银钥匙' });
  });

  it('closes only missing final structural delimiters after complete values', () => {
    expect(parseJsonWithLocalRepair('{"items":[{"id":1}]'))
      .toEqual({ items: [{ id: 1 }] });
  });

  it('escapes literal controls inside a complete JSON string', () => {
    expect(parseJsonWithLocalRepair('{"text":"第一行\n第二行"}'))
      .toEqual({ text: '第一行\n第二行' });
  });

  it('refuses to invent the end of a truncated string value', () => {
    expect(() => parseJsonWithLocalRepair('{"query":"未完成'))
      .toThrow(/无法通过本地语法修复/);
  });
});
