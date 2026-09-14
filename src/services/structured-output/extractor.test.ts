import { describe, expect, it } from 'vitest';
import { extractJson } from './extractor';

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    const result = extractJson('{"name":"Van","age":30}');
    expect(result.strategy).toBe('direct');
    expect(result.value).toEqual({ name: 'Van', age: 30 });
  });

  it('parses a bare JSON array', () => {
    const result = extractJson('[1, 2, 3]');
    expect(result.strategy).toBe('direct');
    expect(result.value).toEqual([1, 2, 3]);
  });

  it('unwraps a fenced json block', () => {
    const text = 'Here is the result:\n```json\n{"ok":true}\n```\nHope that helps!';
    const result = extractJson(text);
    expect(result.strategy).toBe('fenced');
    expect(result.value).toEqual({ ok: true });
  });

  it('unwraps a fence with no language tag', () => {
    const result = extractJson('```\n{"ok":true}\n```');
    expect(result.strategy).toBe('fenced');
    expect(result.value).toEqual({ ok: true });
  });

  it('finds JSON embedded in prose', () => {
    const result = extractJson('Sure! The answer is {"score": 0.9} — let me know.');
    expect(result.strategy).toBe('balanced');
    expect(result.value).toEqual({ score: 0.9 });
  });

  it('does not stop at a brace inside a string literal', () => {
    const result = extractJson('Result: {"note": "use } carefully", "ok": true}');
    expect(result.value).toEqual({ note: 'use } carefully', ok: true });
  });

  it('repairs trailing commas', () => {
    const result = extractJson('{"a": 1, "b": 2,}');
    expect(result.strategy).toBe('repaired');
    expect(result.value).toEqual({ a: 1, b: 2 });
    expect(result.repairs).toContain('removed trailing commas');
  });

  it('repairs unquoted keys', () => {
    const result = extractJson('{name: "Van", age: 30}');
    expect(result.value).toEqual({ name: 'Van', age: 30 });
    expect(result.repairs).toContain('quoted bare object keys');
  });

  it('repairs Python-style literals', () => {
    const result = extractJson('{"a": None, "b": True, "c": False}');
    expect(result.value).toEqual({ a: null, b: true, c: false });
    expect(result.repairs).toContain('normalized non-JSON literals');
  });

  it('strips comments', () => {
    const result = extractJson('{\n  // the name\n  "name": "Van"\n}');
    expect(result.value).toEqual({ name: 'Van' });
    expect(result.repairs).toContain('removed comments');
  });

  it('does not strip a // sequence inside a string', () => {
    const result = extractJson('{"url": "https://example.com"}');
    expect(result.value).toEqual({ url: 'https://example.com' });
  });

  it('prefers the last fenced block when a model explains then emits', () => {
    const text = '```json\n{"draft":true}\n```\nActually, corrected:\n```json\n{"draft":false}\n```';
    const result = extractJson(text);
    expect(result.value).toEqual({ draft: false });
  });

  it('returns none for text with no JSON', () => {
    const result = extractJson('I cannot help with that request.');
    expect(result.value).toBeNull();
    expect(result.strategy).toBe('none');
  });

  it('returns none for empty input', () => {
    expect(extractJson('').value).toBeNull();
    expect(extractJson('   ').value).toBeNull();
  });
});
