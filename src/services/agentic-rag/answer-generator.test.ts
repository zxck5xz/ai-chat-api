import { describe, it, expect } from 'vitest';
import { AnswerGenerator } from './answer-generator';

describe('AnswerGenerator (fallback path)', () => {
  const generator = new AnswerGenerator('fake-key');

  it('generates fallback answer from top chunk when LLM fails', async () => {
    const result = await generator.generate('What is React?', [
      { content: 'React is a JavaScript library for building UIs', documentTitle: 'React Docs', documentUrl: '', score: 0.9 },
      { content: 'Vue is a progressive framework', documentTitle: 'Vue Docs', documentUrl: '', score: 0.7 },
    ]);

    expect(result.answer).toContain('React');
    expect(result.sourceCount).toBe(2);
    expect(result.tokenEstimate).toBeGreaterThan(0);
  });

  it('returns helpful message when no chunks provided', async () => {
    const result = await generator.generate('What is React?', []);
    expect(result.answer).toContain('enough information');
    expect(result.sourceCount).toBe(0);
  });

  it('tracks token estimate roughly', async () => {
    const result = await generator.generate(
      'What is the meaning of life?',
      [{ content: 'The meaning of life is 42', documentTitle: 'Hitchhiker', documentUrl: '', score: 0.95 }]
    );
    // Token estimate should be roughly words * 1.3
    expect(result.tokenEstimate).toBeGreaterThan(5);
    expect(result.tokenEstimate).toBeLessThan(500);
  });
});
