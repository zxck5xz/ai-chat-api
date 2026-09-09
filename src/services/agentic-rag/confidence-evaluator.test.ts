import { describe, it, expect } from 'vitest';
import { ConfidenceEvaluator } from './confidence-evaluator';

describe('ConfidenceEvaluator (heuristic fallback)', () => {
  const evaluator = new ConfidenceEvaluator('fake-key', 0.7);

  it('returns low confidence when no sources provided', async () => {
    const result = await evaluator.evaluate('What is React?', 'React is a library', []);
    expect(result.score).toBeLessThan(0.5);
    expect(result.needsMoreRetrieval).toBe(true);
  });

  it('returns higher confidence when answer overlaps with sources', async () => {
    const result = await evaluator.evaluate(
      'What is React?',
      'React is a JavaScript library for building user interfaces',
      [
        { content: 'React is a JavaScript library for building user interfaces and components', documentTitle: 'React Docs', score: 0.9 },
      ]
    );
    expect(result.score).toBeGreaterThan(0.3);
    expect(result.citationCoverage).toBeGreaterThan(0);
  });

  it('detects potential hallucination when answer has no source overlap', async () => {
    const result = await evaluator.evaluate(
      'What is the capital of France?',
      'Quantum entanglement is a phenomenon in physics where particles become correlated',
      [
        { content: 'Paris is the capital of France and a major European city', documentTitle: 'Geo Docs', score: 0.95 },
      ]
    );
    expect(result.hasHallucination).toBe(true);
  });

  it('marks needsRegeneration when hallucination detected', async () => {
    const result = await evaluator.evaluate(
      'What database does this project use?',
      'Blockchain consensus mechanisms rely on proof of work',
      [
        { content: 'This project uses PostgreSQL with pgvector for vector storage', documentTitle: 'Tech Docs', score: 0.9 },
      ]
    );
    expect(result.needsRegeneration).toBe(true);
  });

  it('returns configurable threshold', () => {
    const custom = new ConfidenceEvaluator('key', 0.9);
    expect(custom.getThreshold()).toBe(0.9);
  });

  it('scores are between 0 and 1', async () => {
    const result = await evaluator.evaluate(
      'test query',
      'test answer with some words',
      [{ content: 'test answer with some words and more', documentTitle: 'Doc', score: 0.8 }]
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
