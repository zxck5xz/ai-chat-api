import { describe, it, expect } from 'vitest';
import { localRerank, rerank, type RerankableDocument } from './reranker';

describe('Reranker (local fallback)', () => {
  const docs: RerankableDocument[] = [
    { id: 'a', content: 'React is a JavaScript library for building user interfaces.' },
    { id: 'b', content: 'The cat sat on the mat near the door.' },
    { id: 'c', content: 'React hooks let you use state in function components.' },
  ];

  it('ranks react docs above unrelated doc for a react query', async () => {
    const results = await rerank(undefined, 'React components', docs, { provider: 'local' });
    expect(results.length).toBeGreaterThan(0);
    const topIds = results.map((r) => r.id);
    expect(topIds[0]).not.toBe('b');
    expect(results.every((r) => r.provider === 'local')).toBe(true);
  });

  it('respects topN cap', () => {
    const results = localRerank('react', docs, 2);
    expect(results.length).toBe(2);
  });

  it('produces scores in (0, 1]', () => {
    const results = localRerank('react', docs, 3);
    for (const r of results) {
      expect(r.relevanceScore).toBeGreaterThan(0);
      expect(r.relevanceScore).toBeLessThanOrEqual(1);
    }
  });

  it('falls back to local when provider=bge has no endpoint', async () => {
    const results = await rerank(undefined, 'react', docs, { provider: 'bge' });
    expect(results.every((r) => r.provider === 'local')).toBe(true);
  });
});
