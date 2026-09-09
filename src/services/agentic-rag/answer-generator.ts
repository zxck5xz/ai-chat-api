/**
 * Answer Generator
 * Generates answers from retrieved chunks with source citations.
 *
 * Part of Project 15: Agentic RAG with Self-Correction
 */

const GENERATE_PROMPT = `You are a helpful assistant that answers questions based on provided source documents.

Rules:
1. Answer ONLY based on the provided source documents. If the sources don't contain enough information, say so explicitly.
2. Cite your sources using [Source N] notation when referencing specific information.
3. Be concise but thorough. Address all parts of the question.
4. If sources conflict, acknowledge the disagreement and present both sides.
5. Do NOT make up information that isn't in the sources.

Format your answer as a clear, well-structured response with inline citations.`;

const GENERATE_WITH_HISTORY_PROMPT = `You are a helpful assistant that answers questions based on provided source documents and previous retrieval rounds.

You have already attempted to answer this question but the confidence was low. Previous retrieval may have missed relevant information.

Rules:
1. Answer ONLY based on the provided source documents.
2. Cite your sources using [Source N] notation.
3. If you notice gaps in the previous attempt, try to address them with the new sources.
4. Be explicit about what information is well-supported vs uncertain.
5. Do NOT repeat the same weak points from previous attempts.`;

export interface GeneratedAnswer {
  answer: string;
  sourcesUsed: number[];
  sourceCount: number;
  tokenEstimate: number;
}

export class AnswerGenerator {
  private geminiApiKey: string;
  private model = 'gemini-2.0-flash';

  constructor(geminiApiKey: string) {
    this.geminiApiKey = geminiApiKey;
  }

  /**
   * Generate an answer from retrieved chunks
   */
  async generate(
    query: string,
    chunks: Array<{ content: string; documentTitle: string; documentUrl: string; score: number }>,
    previousAttempts?: Array<{ query: string; answer: string; round: number }>
  ): Promise<GeneratedAnswer> {
    const prompt = previousAttempts && previousAttempts.length > 0
      ? GENERATE_WITH_HISTORY_PROMPT
      : GENERATE_PROMPT;

    const sourceText = chunks
      .map((c, i) => `[Source ${i + 1}] (${c.documentTitle})\n${c.content}`)
      .join('\n\n');

    let contextSuffix = '';
    if (previousAttempts && previousAttempts.length > 0) {
      const prevText = previousAttempts
        .map((a) => `Round ${a.round}: Query="${a.query}"\nAnswer="${a.answer.slice(0, 200)}..."`)
        .join('\n\n');
      contextSuffix = `\n\n--- Previous Attempts ---\n${prevText}`;
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text: `${prompt}\n\n--- Source Documents ---\n${sourceText}${contextSuffix}\n\n--- User Question ---\n${query}`,
                  },
                ],
              },
            ],
            generationConfig: {
              maxOutputTokens: 1024,
              temperature: 0.3,
            },
          }),
        }
      );

      if (!response.ok) {
        return this.fallbackGenerate(query, chunks);
      }

      const data = await response.json() as {
        candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      };

      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      // Track which sources were cited
      const sourcesUsed = this.extractCitedSources(answer, chunks.length);

      return {
        answer,
        sourcesUsed,
        sourceCount: chunks.length,
        tokenEstimate: this.estimateTokens(query + sourceText + answer),
      };
    } catch {
      return this.fallbackGenerate(query, chunks);
    }
  }

  /**
   * Simple fallback when LLM fails
   */
  private fallbackGenerate(
    query: string,
    chunks: Array<{ content: string; documentTitle: string }>
  ): GeneratedAnswer {
    const topChunk = chunks[0];
    const answer = topChunk
      ? `Based on the available information:\n\n${topChunk.content}\n\n[Source: ${topChunk.documentTitle}]`
      : `I don't have enough information to answer: "${query}"`;

    return {
      answer,
      sourcesUsed: topChunk ? [1] : [],
      sourceCount: chunks.length,
      tokenEstimate: this.estimateTokens(query + answer),
    };
  }

  /**
   * Extract which source numbers were cited in the answer
   */
  private extractCitedSources(answer: string, maxSources: number): number[] {
    const cited = new Set<number>();
    const regex = /\[Source\s+(\d+)\]/gi;
    let match;

    while ((match = regex.exec(answer)) !== null) {
      const num = parseInt(match[1], 10);
      if (num >= 1 && num <= maxSources) {
        cited.add(num);
      }
    }

    return Array.from(cited).sort((a, b) => a - b);
  }

  /**
   * Rough token estimate (words * 1.3)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }
}
