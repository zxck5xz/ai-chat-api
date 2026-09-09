import { describe, it, expect } from 'vitest';
import { QueryAnalyzer } from './query-analyzer';

describe('QueryAnalyzer (rule-based fast path)', () => {
  const analyzer = new QueryAnalyzer('fake-key');

  it('classifies greetings as skip', async () => {
    const result = await analyzer.analyze('hello');
    expect(result.needsRetrieval).toBe('skip');
    expect(result.decisionConfidence).toBeGreaterThan(0.8);
  });

  it('classifies math calculations as skip', async () => {
    const result = await analyzer.analyze('what is 5 + 3');
    expect(result.needsRetrieval).toBe('skip');
  });

  it('classifies code generation as skip', async () => {
    const result = await analyzer.analyze('write a function to sort an array');
    expect(result.needsRetrieval).toBe('skip');
  });

  it('classifies time-sensitive queries as retrieve', async () => {
    const result = await analyzer.analyze('latest news about AI this week');
    expect(result.needsRetrieval).toBe('retrieve');
    expect(result.retrievalStrategy).toBe('single');
  });

  it('classifies comparison queries as retrieve with decompose strategy', async () => {
    const result = await analyzer.analyze('compare React vs Vue vs Angular for enterprise');
    expect(result.needsRetrieval).toBe('retrieve');
    expect(result.retrievalStrategy).toBe('decompose');
    expect(result.complexity).toBeGreaterThanOrEqual(0.6);
  });

  it('classifies documentation lookup as retrieve', async () => {
    const result = await analyzer.analyze('find the API documentation for Stripe payments');
    expect(result.needsRetrieval).toBe('retrieve');
  });

  it('extracts keywords from queries', async () => {
    const result = await analyzer.analyze('how to deploy Next.js to Vercel');
    expect(result.keywords.length).toBeGreaterThan(0);
    expect(result.keywords.some((k) => k.includes('deploy') || k.includes('next') || k.includes('vercel'))).toBe(true);
  });

  it('returns decompose strategy for complex comparisons', async () => {
    const result = await analyzer.analyze('compare React vs Vue vs Angular for enterprise apps');
    expect(result.retrievalStrategy).toBe('decompose');
    expect(result.complexity).toBeGreaterThanOrEqual(0.6);
  });

  it('sets suggestedTopK based on complexity', async () => {
    const simple = await analyzer.analyze('what is React');
    const complex = await analyzer.analyze('compare React vs Vue vs Angular for enterprise apps');
    expect(complex.suggestedTopK).toBeGreaterThanOrEqual(simple.suggestedTopK);
  });

  it('returns valid intent values', async () => {
    const intents = ['hello', 'what is 5 + 3', 'latest news about AI'];
    for (const q of intents) {
      const result = await analyzer.analyze(q);
      expect(['factual', 'analytical', 'comparative', 'exploratory', 'creative', 'chitchat', 'code', 'math']).toContain(result.intent);
    }
  });

  it('handles empty-ish queries gracefully', async () => {
    const result = await analyzer.analyze('stuff');
    expect(result.originalQuery).toBe('stuff');
    expect(result.needsRetrieval).toBeDefined();
    expect(result.complexity).toBeGreaterThanOrEqual(0);
  });
});
