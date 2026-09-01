import { describe, it, expect } from 'vitest';
import { normalizeScores } from './parallel-retrieval';

describe('normalizeScores', () => {
  it('returns empty for empty input', () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it('maps min→0 and max→1', () => {
    expect(normalizeScores([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it('returns all zeros when all scores are equal (range collapses)', () => {
    expect(normalizeScores([7, 7, 7])).toEqual([0, 0, 0]);
  });

  it('handles negative scores', () => {
    const result = normalizeScores([-10, 0, 10]);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(0.5);
    expect(result[2]).toBe(1);
  });

  it('preserves order', () => {
    const input = [3, 1, 4, 1, 5, 9, 2, 6];
    const result = normalizeScores(input);
    expect(result.length).toBe(input.length);
    // Same ordering: lowest input → lowest output, highest → highest
    const minIdx = input.indexOf(Math.min(...input));
    const maxIdx = input.indexOf(Math.max(...input));
    expect(result[minIdx]).toBe(0);
    expect(result[maxIdx]).toBe(1);
  });
});